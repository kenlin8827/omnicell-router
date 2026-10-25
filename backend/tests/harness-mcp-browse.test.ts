import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { browseMcpOfficial, browseSource, resetBrowseCache } from '../src/harness/browse.js';
import type { HarnessSourceView } from '../src/harness/types.js';

/**
 * The official MCP registry is a CURSOR-paged market source (ADR-0015 §D6), so the contract under test
 * is paging, dedupe and the install handle — not markup:
 *  - `version=latest` narrows the registry's one-row-per-version listing; a record the registry still
 *    flags `isLatest: false` is dropped rather than shown twice.
 *  - Page N is reached by walking the recorded cursors, and every walked page is cached for the same
 *    60 s window as the rows. A page past the registry's end answers EMPTY with no successor.
 *  - A row's `key` is `mcp-official:<registry name>`, which is exactly what the resolve adapter reads
 *    back, so the market's install button is honest by construction.
 */

const realFetch = globalThis.fetch;
let calls: URL[] = [];

interface RowOptions {
  title?: string;
  description?: string;
  isLatest?: boolean;
  repo?: string;
  websiteUrl?: string;
  remote?: string;
  npm?: string;
}

/** One registry record, shaped like a measured `GET /v0/servers` row (2026-10-25). */
function row(name: string, opts: RowOptions = {}) {
  return {
    server: {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name,
      ...(opts.title === undefined ? {} : { title: opts.title }),
      ...(opts.description === undefined ? {} : { description: opts.description }),
      version: '1.0.0',
      ...(opts.websiteUrl === undefined ? {} : { websiteUrl: opts.websiteUrl }),
      ...(opts.repo === undefined ? {} : { repository: { url: opts.repo, source: 'github' } }),
      ...(opts.npm === undefined
        ? {}
        : { packages: [{ registryType: 'npm', identifier: opts.npm, runtimeHint: 'npx', runtimeArguments: [] }] }),
      ...(opts.remote === undefined ? {} : { remotes: [{ type: 'streamable-http', url: opts.remote }] }),
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: 'active',
        statusChangedAt: '2026-10-01T00:00:00Z',
        isLatest: opts.isLatest ?? true,
        updatedAt: '2026-10-01T00:00:00Z',
      },
    },
  };
}

/** Serve one page per cursor (`''` = the first page); every other cursor answers 400. */
function stubChain(byCursor: Record<string, { servers: unknown[]; next?: string }>): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const cursor = url.searchParams.get('cursor') ?? '';
    const page = byCursor[cursor];
    if (!page) return new Response(JSON.stringify({ detail: 'invalid cursor' }), { status: 400 });
    return new Response(
      JSON.stringify({
        servers: page.servers,
        metadata: { count: page.servers.length, ...(page.next === undefined ? {} : { nextCursor: page.next }) },
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
}

function sourceView(overrides: Partial<HarnessSourceView> = {}): HarnessSourceView {
  return {
    id: 'mcp-official',
    label: 'MCP official registry',
    kinds: ['mcp'],
    trust: 'official',
    auth: 'none',
    enabled: true,
    browsable: true,
    ...overrides,
  };
}

beforeEach(() => {
  resetBrowseCache();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('browseMcpOfficial', () => {
  it('normalizes a record to the shared market shape with an mcp install handle', async () => {
    stubChain({
      '': {
        servers: [
          row('ac.inference.sh/mcp', {
            title: 'inference.sh',
            description: 'Run 150+ AI apps',
            repo: 'https://github.com/inference-sh/sdk',
            websiteUrl: 'https://inference.sh',
            remote: 'https://api.inference.sh/mcp',
          }),
        ],
      },
    });
    const result = await browseMcpOfficial('');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasMore).toBe(false);
    expect(result.noteCode).toBe('mcp-registry');
    const item = result.items[0]!;
    expect(item).toMatchObject({
      id: 'mcp-official:ac.inference.sh/mcp',
      sourceId: 'mcp-official',
      key: 'mcp-official:ac.inference.sh/mcp',
      // The writer that serves this row is the MCP config merge, not a copy tree or a package.
      installKind: 'mcp',
      // `title` is the display string; the reverse-DNS name stays in `key`.
      name: 'inference.sh',
      repo: 'inference-sh/sdk',
      description: 'Run 150+ AI apps',
      url: 'https://inference.sh',
      // The registry publishes no popularity signal, and `null` keeps "never stated" apart from zero.
      stars: null,
      updatedAt: '2026-10-01T00:00:00Z',
      topics: [],
    });
  });

  it('asks for the latest version only, forwards the query as `search`, and drops isLatest:false rows', async () => {
    stubChain({
      '': {
        servers: [row('ac.example/latest'), row('ac.example/stale', { isLatest: false })],
      },
    });
    const result = await browseMcpOfficial('filesystem', 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.key)).toEqual(['mcp-official:ac.example/latest']);
    expect(result.noteCode).toBeUndefined();
    const url = calls[0]!;
    expect(url.searchParams.get('version')).toBe('latest');
    expect(url.searchParams.get('search')).toBe('filesystem');
    expect(url.searchParams.get('limit')).toBe('10');
    // The first page carries no cursor at all — an empty `cursor=` would be a different request.
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('reaches page 2 through the recorded cursor and caches the walked pages', async () => {
    stubChain({
      '': { servers: [row('ac.example/one')], next: 'c1' },
      c1: { servers: [row('ac.example/two')], next: 'c2' },
      c2: { servers: [row('ac.example/three')] },
    });
    const second = await browseMcpOfficial('', 1, 2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.items.map((i) => i.key)).toEqual(['mcp-official:ac.example/two']);
    expect(second.hasMore).toBe(true);
    expect(calls.map((u) => u.searchParams.get('cursor'))).toEqual([null, 'c1']);

    // Re-asking is a cache hit for both the chain and the row page: no new upstream read.
    const again = await browseMcpOfficial('', 1, 2);
    expect(again.ok).toBe(true);
    expect(calls).toHaveLength(2);

    // Walking FORWARD reuses the chain it already paid for, so page 3 costs exactly one read.
    const third = await browseMcpOfficial('', 1, 3);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.hasMore).toBe(false);
    expect(calls.map((u) => u.searchParams.get('cursor'))).toEqual([null, 'c1', 'c2']);
  });

  it('answers an empty page with no successor past the registry end instead of repeating rows', async () => {
    stubChain({
      '': { servers: [row('ac.example/one')], next: 'c1' },
      c1: { servers: [row('ac.example/two')] },
    });
    const result = await browseMcpOfficial('', 1, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('refuses absurd depth as a typed answer, never a silent clamp', async () => {
    stubChain({ '': { servers: [] } });
    const result = await browseMcpOfficial('', 24, 41);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unavailable');
    // The refusal happens before any network work.
    expect(calls).toHaveLength(0);
  });

  it('drops the cached window for an explicit refresh', async () => {
    stubChain({ '': { servers: [row('ac.example/one')] } });
    await browseSource(sourceView(), '', 24);
    expect(calls).toHaveLength(1);
    await browseSource(sourceView(), '', 24);
    expect(calls).toHaveLength(1);
    await browseSource(sourceView(), '', 24, { refresh: true });
    expect(calls).toHaveLength(2);
  });

  it('maps upstream failures to the console vocabulary instead of an empty market', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    const unavailable = await browseMcpOfficial('');
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.code).toBe('unavailable');
      expect(unavailable.reason).toBe('unavailable');
    }

    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const upstream = await browseMcpOfficial('');
    expect(upstream.ok).toBe(false);
    if (!upstream.ok) {
      expect(upstream.code).toBe('upstream');
      expect(upstream.reason).toBe('http');
      expect(upstream.reasonParams).toEqual({ status: '404' });
    }
  }, 30_000);

  it('reports a network failure as `upstream` with the transport reason', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const result = await browseMcpOfficial('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('upstream');
      expect(result.reason).toBe('network');
    }
  }, 30_000);
});
