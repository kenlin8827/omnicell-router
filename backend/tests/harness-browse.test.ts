import { describe, expect, it } from 'bun:test';
import fastify from 'fastify';
import { browseSource, resetBrowseCache } from '../src/harness/common/market.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';
import type { HarnessSourceView } from '../src/harness/types.js';
const CLAWHUB_SKILLS = JSON.stringify({ items: [], nextCursor: null });
const CLAWHUB_SEARCH = JSON.stringify({ results: [] });
/** Minimal server-rendered catalog page: no cards, but the count marker present — `ok: true`. */
const PI_DEV_HTML = '<span class="packages-count">1-50 / 100</span>';

function stubFetch(): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    const body = url.includes('pi.dev')
      ? PI_DEV_HTML
      : url.includes('/api/v1/search')
        ? CLAWHUB_SEARCH
        : CLAWHUB_SKILLS;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }) as unknown as typeof fetch;
  return seen;
}
describe('browseSource routing', () => {
  it('still refuses a disabled source with its measured reason', async () => {
    const result = await browseSource(
      {
        id: 'retired-source',
        label: 'retired',
        kinds: ['plugin'],
        trust: 'community',
        auth: 'none',
        enabled: false,
        browsable: true,
        unavailableReason: 'API returns 401 without a key',
      },
      '',
      24
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(result.message).toBe('API returns 401 without a key');
  });

  it('routes pi.dev and clawhub to their adapters and refuses anything else', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const piDev = await browseSource(piDevSource(), 'x', 10);
      expect(piDev.ok).toBe(true);
      expect(seen.at(-1)).toContain('https://pi.dev/packages?');

      const clawhub = await browseSource(clawhubSource(), 'x', 10);
      expect(clawhub.ok).toBe(true);
      expect(seen.at(-1)).toContain('clawhub.ai/api/v1/search');

      const retired = await browseSource(
        { ...piDevSource(), id: 'npm' },
        'x',
        10
      );
      expect(retired.ok).toBe(false);
      if (!retired.ok) expect(retired.code).toBe('unsupported_source');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const originalFetch = globalThis.fetch;

function sourceView(overrides: Partial<HarnessSourceView> = {}): HarnessSourceView {
  return {
    id: 'pi-dev',
    label: 'pi.dev (official)',
    kinds: ['plugin'],
    trust: 'official',
    auth: 'none',
    enabled: true,
    browsable: true,
    ...overrides,
  };
}

function piDevSource(): HarnessSourceView {
  return sourceView({ sorts: ['downloads', 'recent', 'name'] });
}

function clawhubSource(): HarnessSourceView {
  return sourceView({ id: 'clawhub', label: 'ClawHub', kinds: ['skill'], trust: 'community', sorts: ['downloads'] });
}

/**
 * Market ordering follows the SOURCE's published contract (ADR-0015 §D6): only an order the source
 * DECLARES travels upstream; anything else falls back to the source's own default. The console
 * renders exactly the declared keys.
 */
describe('market ordering', () => {
  it('maps a declared order onto the catalog sort parameter', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(piDevSource(), 'x', 10, { sort: 'recent' });
      expect(result.ok).toBe(true);
      expect(seen.at(-1)).toContain('sort=recent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('drops an order the source never declared and keeps its default', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(piDevSource(), 'x', 10, { sort: 'stars' });
      expect(result.ok).toBe(true);
      // `sorts[0]` is the default — the console cannot invent an ordering upstream.
      expect(seen.at(-1)).toContain('sort=downloads');
      expect(seen.at(-1)).not.toContain('sort=stars');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The 60 s browse cache is a quota shield, so a second read of the same query answers from memory —
 * and that is exactly what an operator's refresh must NOT do. `refresh: true` drops the REQUESTED
 * source's family only: refreshing one catalog never costs another catalog its warm window.
 */
describe('browse refresh', () => {
  it('reads the same query from upstream again instead of answering the cached window', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      await browseSource(piDevSource(), 'mcp', 10);
      const cached = seen.length;
      await browseSource(piDevSource(), 'mcp', 10);
      // The window is warm: the identical read is served from memory, spending nothing.
      expect(seen.length).toBe(cached);

      await browseSource(piDevSource(), 'mcp', 10, { refresh: true });
      expect(seen.length).toBe(cached + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('evicts only the source being refreshed', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      await browseSource(clawhubSource(), 'probe', 10);
      const clawhubReads = seen.length;

      // A pi.dev refresh must leave ClawHub's warm window alone.
      await browseSource(piDevSource(), 'refresh-scope', 10, { refresh: true });
      const afterPiDev = seen.length;
      await browseSource(clawhubSource(), 'probe', 10);
      expect(seen.length).toBe(afterPiDev);
      expect(seen.length).toBeGreaterThan(clawhubReads);

      // The eviction is real for the refreshed source itself.
      await browseSource(piDevSource(), 'refresh-scope', 10);
      await browseSource(piDevSource(), 'refresh-scope', 10, { refresh: true });
      expect(seen.length).toBe(afterPiDev + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('carries `refresh=1` through the route, so a cached page is re-read on request', async () => {
    const seen = stubFetch();
    const app = fastify({ logger: false });
    registerHarnessRoutes(app);
    try {
      resetBrowseCache();
      const url = '/api/admin/harness/browse?source=pi-dev&q=mcp&limit=10';
      await app.inject({ method: 'GET', url });
      const cached = seen.length;
      const warm = await app.inject({ method: 'GET', url });
      expect(warm.statusCode).toBe(200);
      // Same axis, warm window: the second read costs nothing.
      expect(seen.length).toBe(cached);

      const fresh = await app.inject({ method: 'GET', url: `${url}&refresh=1` });
      expect(fresh.statusCode).toBe(200);
      expect(seen.length).toBe(cached + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
