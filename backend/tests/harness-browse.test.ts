import { describe, expect, it } from 'bun:test';
import fastify from 'fastify';
import { browseOpenCodeEcosystem, browseSource, npmDefaultQuery, npmDefaultQueryFor, resetBrowseCache } from '../src/harness/browse.js';
import { HOSTS } from '../src/harness/hosts.js';
import { OPENCODE_ECOSYSTEM } from '../src/harness/opencode-ecosystem.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';
import type { HarnessSourceView } from '../src/harness/types.js';

/**
 * Curated OpenCode catalog is a disk-only browse source (ADR-0015 §D6): no fetch, no cache, and no
 * install adapter. Its rows must still carry the ONE handle the install endpoint understands —
 * `npm:<pkg>` — because a curated row IS a package published on npm; the install handle is not this
 * source's to invent.
 */

function sourceView(overrides: Partial<HarnessSourceView> = {}): HarnessSourceView {
  return {
    id: 'static-opencode',
    label: 'OpenCode ecosystem (curated)',
    kinds: ['extension'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    hosts: ['opencode'],
    ...overrides,
  };
}

describe('browseOpenCodeEcosystem', () => {
  it('returns the whole snapshot for an empty query', () => {
    const result = browseOpenCodeEcosystem('', 50);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.length).toBe(OPENCODE_ECOSYSTEM.length);
    expect(result.note).toBeString();
  });

  it('normalizes every row to the shared market shape', () => {
    const result = browseOpenCodeEcosystem('', 50);
    if (!result.ok) throw new Error('expected ok');
    for (const item of result.items) {
      expect(item.sourceId).toBe('static-opencode');
      expect(item.installKind).toBe('extension');
      expect(item.id.startsWith('static-opencode:')).toBe(true);
      // The table carries no popularity or timestamp; null / '' is the honest answer, not a guess.
      expect(item.stars).toBeNull();
      expect(item.updatedAt).toBe('');
      expect(item.url.startsWith('https://github.com/')).toBe(true);
    }
  });

  it('gives a published row an npm install handle and leaves an unpublished row without one', () => {
    const result = browseOpenCodeEcosystem('', 50);
    if (!result.ok) throw new Error('expected ok');
    const byName = new Map(result.items.map((i) => [i.name, i]));

    // A name that is also the package name.
    expect(byName.get('opencode-pty')?.key).toBe('npm:opencode-pty');
    // A name that is NOT the package name — the verified scoped name wins.
    expect(byName.get('opencode-notifier')?.key).toBe('npm:@mohak34/opencode-notifier');
    expect(byName.get('opencode-dynamic-context-pruning')?.key).toBe('npm:@tarquinen/opencode-dcp');

    // No package published under this repo: no install handle is invented.
    const firecrawl = byName.get('opencode-firecrawl');
    expect(firecrawl?.key).toBe('static-opencode:opencode-firecrawl');
    expect(firecrawl?.topics).toEqual([]);
  });

  it('filters on name and description, case-insensitively', () => {
    const byName = browseOpenCodeEcosystem('PTY');
    if (!byName.ok) throw new Error('expected ok');
    expect(byName.items.map((i) => i.name)).toContain('opencode-pty');

    const byDescription = browseOpenCodeEcosystem('notifications');
    if (!byDescription.ok) throw new Error('expected ok');
    expect(byDescription.items.map((i) => i.name)).toContain('opencode-notifier');

    const miss = browseOpenCodeEcosystem('zzz-no-such-plugin-zzz');
    if (!miss.ok) throw new Error('expected ok');
    expect(miss.items).toEqual([]);
  });

  it('honors the limit and clamps it', () => {
    const three = browseOpenCodeEcosystem('', 3);
    if (!three.ok) throw new Error('expected ok');
    expect(three.items.length).toBe(3);

    const clamped = browseOpenCodeEcosystem('', 0);
    if (!clamped.ok) throw new Error('expected ok');
    expect(clamped.items.length).toBe(1);
  });

  // The note is copy, not data: the adapter states WHICH sentence applies and keeps its English
  // text as the fallback, so the console can render the same fact in its own language.
  it('carries the note identity beside its English copy, and only where a note exists', () => {
    const empty = browseOpenCodeEcosystem('', 5);
    if (!empty.ok) throw new Error('expected ok');
    expect(empty.noteCode).toBe('curated');
    expect(empty.note).toBeString();

    const typed = browseOpenCodeEcosystem('pty', 5);
    if (!typed.ok) throw new Error('expected ok');
    // A typed query is a search, not the catalog's default view — nothing to explain.
    expect(typed.note).toBeUndefined();
    expect(typed.noteCode).toBeUndefined();
  });
});

describe('browseSource routing', () => {
  it('serves the curated source from disk', async () => {
    const result = await browseSource(sourceView(), 'pty', 24);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.name).toBe('opencode-pty');
  });

  it('still refuses a disabled source with its measured reason', async () => {
    const result = await browseSource(
      sourceView({ id: 'retired-source', enabled: false, unavailableReason: 'API returns 401 without a key' }),
      '',
      24
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(result.message).toBe('API returns 401 without a key');
  });
});

describe('browse paging', () => {
  it('slices a catalog into pages and reports an honest end', () => {
    const first = browseOpenCodeEcosystem('', 10, 1);
    if (!first.ok) throw new Error('expected ok');
    expect(first.items.length).toBe(10);
    expect(first.total).toBe(OPENCODE_ECOSYSTEM.length);
    expect(first.hasMore).toBe(true);

    // 31 rows at 10 per page: the fourth page is the remainder, and nothing follows it.
    const last = browseOpenCodeEcosystem('', 10, 4);
    if (!last.ok) throw new Error('expected ok');
    expect(last.items.length).toBe(OPENCODE_ECOSYSTEM.length - 30);
    expect(last.hasMore).toBe(false);

    const past = browseOpenCodeEcosystem('', 10, 9);
    if (!past.ok) throw new Error('expected ok');
    expect(past.items).toEqual([]);
    expect(past.hasMore).toBe(false);
  });
});

describe('browse route paging contract', () => {
  const app = fastify({ logger: false });
  registerHarnessRoutes(app);

  it('echoes the answered page and carries hasMore/total for the console pager', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/harness/browse?source=static-opencode&limit=10&page=2',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      page: number;
      hasMore: boolean;
      total: number;
      items: { id: string }[];
    };
    expect(body.page).toBe(2);
    expect(body.total).toBe(OPENCODE_ECOSYSTEM.length);
    expect(body.items.length).toBe(10);
    expect(body.hasMore).toBe(true);

    // Page 2 continues page 1: no row appears on both, which is what a broken offset looks like.
    const firstRes = await app.inject({
      method: 'GET',
      url: '/api/admin/harness/browse?source=static-opencode&limit=10&page=1',
    });
    const firstIds = new Set((firstRes.json() as { items: { id: string }[] }).items.map((i) => i.id));
    expect(body.items.some((item) => firstIds.has(item.id))).toBe(false);
  });

  it('clamps a nonsense page to the first one instead of answering empty', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/harness/browse?source=static-opencode&limit=5&page=0',
    });
    const body = res.json() as { page: number; items: unknown[] };
    expect(body.page).toBe(1);
    expect(body.items.length).toBe(5);
  });
});

describe('snapshot invariants', () => {
  it('has unique names and a github repo for every row', () => {
    const names = OPENCODE_ECOSYSTEM.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of OPENCODE_ECOSYSTEM) {
      expect(entry.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('never claims an npm name that is not a legal package reference', () => {
    // The writer inserts the spec verbatim into a shell command: no whitespace, no shell characters.
    for (const entry of OPENCODE_ECOSYSTEM) {
      if (entry.npm === undefined) continue;
      expect(entry.npm).toMatch(/^(@[\w.-]+\/)?[\w.-]+$/);
    }
  });
});

/**
 * The npm source's empty query is a PER-HARNESS default (ADR-0015 §D6): a page pinned to one runtime
 * must open on THAT runtime's own npm tag, and a runtime that publishes no tag convention must not
 * inherit another runtime's — which is what a single global fallback silently did.
 */
describe('npm empty-query default', () => {
  const npmSource: HarnessSourceView = {
    id: 'npm',
    label: 'npm registry',
    kinds: ['extension'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
  };
  const originalFetch = globalThis.fetch;

  /** Answer every registry call with an empty page and record the URL it asked for. */
  function stubFetch(): string[] {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ objects: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    return seen;
  }

  it('opens each runtime on its own measured tag', () => {
    expect(npmDefaultQuery('pi')).toBe('keywords:pi-package');
    expect(npmDefaultQuery('opencode')).toBe('keywords:opencode-plugin');
    expect(npmDefaultQuery('dsh')).toBe('keywords:dsh-plugin');
    expect(npmDefaultQuery('claude')).toBe('keywords:claude-code-plugin');
    expect(npmDefaultQuery('codex')).toBe('keywords:codex-plugin');
    expect(npmDefaultQuery('gemini-cli')).toBe('keywords:gemini-cli-extension');
  });

  it('never opens a runtime without a tag convention on another runtime\'s tag', () => {
    const tagged = ['pi', 'opencode', 'dsh', 'claude', 'codex', 'gemini-cli'];
    for (const host of HOSTS) {
      const expr = npmDefaultQuery(host.id);
      expect(expr.length).toBeGreaterThan(0);
      if (tagged.includes(host.id)) continue;
      expect(expr.startsWith('keywords:')).toBe(false);
    }
  });

  it('sends the pinned runtime\'s tag upstream and words the note as a tag', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(npmSource, '', 24, { harness: 'dsh' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(seen.at(-1)).toContain('/-/v1/search?text=keywords%3Adsh-plugin');
      expect(result.noteCode).toBe('npm-keyword');
      expect(result.noteParams).toEqual({ keyword: 'dsh-plugin' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to a phrase — and says so — where the runtime publishes no tag', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(npmSource, '', 24, { harness: 'cursor' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(seen.at(-1)).toContain('text=coding%20agent%20plugin');
      expect(result.noteCode).toBe('npm-default');
      expect(result.noteParams).toEqual({ query: 'coding agent plugin' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes a typed query through verbatim and attaches no note', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(npmSource, 'keywords:mcp', 24, { harness: 'pi' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The operator's own expression wins: no runtime tag is appended to it.
      expect(seen.at(-1)).toContain('text=keywords%3Amcp&');
      expect(result.noteCode).toBeUndefined();
      expect(result.note).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('opens the MCP axis on the author mcp-server tag, never on a runtime plugin tag', async () => {
    expect(npmDefaultQueryFor('mcp', 'pi')).toBe('keywords:mcp-server');
    expect(npmDefaultQueryFor('mcp', '')).toBe('keywords:mcp-server');
    // The other axes keep the per-harness mapping untouched.
    expect(npmDefaultQueryFor('extension', 'pi')).toBe('keywords:pi-package');
    expect(npmDefaultQueryFor(undefined, 'pi')).toBe('keywords:pi-package');
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(npmSource, '', 24, { harness: 'pi', kind: 'mcp' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(seen.at(-1)).toContain('/-/v1/search?text=keywords%3Amcp-server');
      expect(result.noteCode).toBe('npm-keyword');
      expect(result.noteParams).toEqual({ keyword: 'mcp-server' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stamps the axis install kind on rows and never shares one cache window across axes', async () => {
    const pkg = { name: 'x-mcp', description: 'd', date: '2026-10-25', keywords: ['mcp-server'], links: {} };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ objects: [{ package: pkg }], total: 1 }), { status: 200 })) as unknown as typeof fetch;
    try {
      resetBrowseCache();
      // Same TYPED query asked from two axes: the text is identical, only the kind fork differs.
      const mcp = await browseSource(npmSource, 'x-mcp', 24, { harness: 'pi', kind: 'mcp' });
      const ext = await browseSource(npmSource, 'x-mcp', 24, { harness: 'pi' });
      expect(mcp.ok && ext.ok).toBe(true);
      if (!mcp.ok || !ext.ok) return;
      expect(mcp.items[0]!.installKind).toBe('mcp');
      expect(ext.items[0]!.installKind).toBe('extension');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Market ordering follows the SOURCE's published contract (ADR-0015 §D6): GitHub search takes
 * `sort=stars|forks|updated`, "best match" is what you get by OMITTING the parameter, and an order a
 * source does not declare is never forwarded. The console renders exactly these keys.
 */
describe('market ordering', () => {
  const githubSource: HarnessSourceView = {
    id: 'github',
    label: 'GitHub',
    kinds: ['skill'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    sorts: ['stars', 'best-match', 'forks', 'updated'],
  };
  const originalFetch = globalThis.fetch;

  function stubFetch(): string[] {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ items: [], total_count: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    return seen;
  }

  it('maps a declared order onto GitHub\'s own sort parameter', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(githubSource, 'mcp', 10, { sort: 'forks' });
      expect(result.ok).toBe(true);
      expect(seen.at(-1)).toContain('sort=forks&order=desc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('asks for best match by omitting `sort` entirely', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(githubSource, 'mcp', 10, { sort: 'best-match' });
      expect(result.ok).toBe(true);
      // Not `sort=best-match`: GitHub's relevance ranking IS the absence of the parameter.
      expect(seen.at(-1)).not.toContain('sort=');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('drops an order the source never declared and keeps its default', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      const result = await browseSource(githubSource, 'mcp', 10, { sort: 'name' });
      expect(result.ok).toBe(true);
      // `sorts[0]` is the default — the console cannot invent an ordering upstream.
      expect(seen.at(-1)).toContain('sort=stars&order=desc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * A catalog the backend reads WHOLE (curated snapshot, community registries) can be ordered
   * server-side over every row — unlike a paged upstream, where only the remote ranking is real.
   * The assertion is that page 1 starts at the alphabetically FIRST row of the entire catalog.
   */
  /**
   * npm has no `sort` and its ranking weights are inert (measured), so the BACKEND fetches one
   * maximum window in the registry's own order and orders that window server-side. The page still
   * renders what the server decided — nothing is re-sorted in the console — and the note names the
   * window so the claim stays honest.
   */
  it('orders an npm window server-side and says which window it ordered', async () => {
    const npmSorted: HarnessSourceView = {
      id: 'npm',
      label: 'npm registry',
      kinds: ['extension'],
      trust: 'community',
      auth: 'none',
      enabled: true,
      browsable: true,
      sorts: ['relevance', 'updated', 'name'],
    };
    const rows = [
      { name: 'zzz-pkg', date: '2024-01-01T00:00:00.000Z' },
      { name: 'aaa-pkg', date: '2026-01-01T00:00:00.000Z' },
      { name: 'mmm-pkg', date: '2025-01-01T00:00:00.000Z' },
    ];
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({ objects: rows.map((r) => ({ package: { name: r.name, date: r.date } })), total: 9000 }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    try {
      resetBrowseCache();
      const byName = await browseSource(npmSorted, 'keywords:opencode-plugin', 2, { sort: 'name' });
      expect(byName.ok).toBe(true);
      if (!byName.ok) return;
      expect(byName.items.map((i) => i.name)).toEqual(['aaa-pkg', 'mmm-pkg']);
      // The window's size, not the registry's 9000: paging past it would answer empty.
      expect(byName.total).toBe(3);
      expect(byName.hasMore).toBe(true);
      expect(byName.noteCode).toBe('window-sorted');
      // One request for the whole window, from the top — never page-local slicing.
      expect(seen.at(-1)).toContain('size=250&from=0');

      resetBrowseCache();
      const byDate = await browseSource(npmSorted, 'keywords:opencode-plugin', 3, { sort: 'updated' });
      if (!byDate.ok) throw new Error('expected ok');
      expect(byDate.items.map((i) => i.name)).toEqual(['aaa-pkg', 'mmm-pkg', 'zzz-pkg']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('orders a full-catalog source over the whole list, not just the shown page', async () => {
    const curated = sourceView({ sorts: ['catalog', 'name'] });
    const expected = [...OPENCODE_ECOSYSTEM.map((e) => e.name)].sort((a, b) => a.localeCompare(b));
    const result = await browseSource(curated, '', 5, { sort: 'name' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.name)).toEqual(expected.slice(0, 5));
    if (result.total === undefined) throw new Error('expected a total');
    expect(result.total).toBe(OPENCODE_ECOSYSTEM.length);
  });
});

/**
 * The 60 s browse cache is a quota shield, so a second read of the same query answers from memory —
 * and that is exactly what an operator's refresh must NOT do. `refresh: true` drops the REQUESTED
 * source's family only: refreshing one catalog never costs another catalog its warm window.
 */
describe('browse refresh', () => {
  const githubSource = sourceView({ id: 'github', label: 'GitHub', kinds: ['skill'], sorts: ['stars'] });
  const npmSource = sourceView({
    id: 'npm',
    label: 'npm registry',
    kinds: ['extension'],
    sorts: ['relevance'],
  });
  const originalFetch = globalThis.fetch;

  function stubFetch(): string[] {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      // Both endpoints answer an empty, well-formed body: this test measures CALLS, not rows.
      return new Response(JSON.stringify({ items: [], total_count: 0, objects: [], total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return seen;
  }

  it('reads the same query from upstream again instead of answering the cached window', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      await browseSource(githubSource, 'mcp', 10);
      const cached = seen.length;
      await browseSource(githubSource, 'mcp', 10);
      // The window is warm: the identical read is served from memory, spending nothing.
      expect(seen.length).toBe(cached);

      await browseSource(githubSource, 'mcp', 10, { refresh: true });
      expect(seen.length).toBe(cached + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('evicts only the source being refreshed', async () => {
    const seen = stubFetch();
    try {
      resetBrowseCache();
      await browseSource(npmSource, 'keywords:mcp', 10);
      const npmReads = seen.length;

      // A GitHub refresh must leave npm's warm window alone.
      await browseSource(githubSource, 'github-refresh-scope', 10, { refresh: true });
      const afterGithub = seen.length;
      await browseSource(npmSource, 'keywords:mcp', 10);
      expect(seen.length).toBe(afterGithub);
      expect(seen.length).toBeGreaterThan(npmReads);

      // The eviction is real for the refreshed source itself.
      await browseSource(githubSource, 'github-refresh-scope', 10);
      await browseSource(githubSource, 'github-refresh-scope', 10, { refresh: true });
      expect(seen.length).toBe(afterGithub + 1);
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
      const url = '/api/admin/harness/browse?source=github&q=mcp&limit=10';
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
