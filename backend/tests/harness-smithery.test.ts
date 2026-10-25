import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browseSmithery, browseSource, resetBrowseCache } from '../src/harness/browse.js';
import { fetchSmitheryServer, fetchSmitheryServers } from '../src/harness/smithery.js';
import { smitheryAdapter } from '../src/harness/sources/smithery.js';
import { installArtifact } from '../src/harness/install.js';
import type { HarnessSourceView } from '../src/harness/types.js';

/**
 * Smithery is the one HOSTING aggregator in the market (ADR-0015 §D6): it serves its own deployments,
 * so its launch spec is the authoritative one for them. The contract under test is therefore:
 *  - the listing's REACHABLE window (500 rows) stays apart from the count it claims (~20 765);
 *  - a hosted deployment becomes an `http` launch with an `Authorization` env KEY (never a value);
 *  - a server that declares required CONFIG is refused by name, because the writer can reference env
 *    key names but cannot carry a per-connection config object.
 */

const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Serve one payload per URL; anything else answers 404, like the registry does for a missing name. */
function stubFetch(routes: Record<string, unknown>): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const key = Object.keys(routes).find((candidate) => url.startsWith(candidate));
    return key === undefined ? new Response('nf', { status: 404 }) : json(routes[key]);
  }) as unknown as typeof fetch;
  return { urls };
}

function listing(opts: { servers: unknown[]; page?: number; pageSize?: number; totalPages?: number; totalCount?: number }) {
  return {
    servers: opts.servers,
    pagination: {
      currentPage: opts.page ?? 1,
      pageSize: opts.pageSize ?? 24,
      totalPages: opts.totalPages ?? 1,
      totalCount: opts.totalCount ?? opts.servers.length,
    },
  };
}

function row(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-1',
    qualifiedName: name,
    namespace: name.split('/')[0],
    slug: name.includes('/') ? name.split('/')[1] : '',
    displayName: `Display ${name}`,
    description: `About ${name}`,
    verified: true,
    useCount: 4242,
    remote: true,
    isDeployed: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    owner: 'org_secret_owner_id',
    ...overrides,
  };
}

function detail(
  name: string,
  opts: { url?: string | null; connType?: string; required?: string[]; remote?: boolean; description?: string } = {}
) {
  const url = opts.url === undefined ? 'https://brave.run.tools' : opts.url;
  return {
    qualifiedName: name,
    displayName: 'Brave Search',
    description: opts.description ?? 'Search the web',
    remote: opts.remote ?? true,
    ...(url ? { deploymentUrl: url } : {}),
    connections:
      url === null
        ? []
        : [
            {
              type: opts.connType ?? 'http',
              deploymentUrl: url,
              configSchema: { type: 'object', required: opts.required ?? [], properties: {} },
            },
          ],
    tools: [],
    prompts: [],
    resources: [],
    security: null,
  };
}

function sourceView(overrides: Partial<HarnessSourceView> = {}): HarnessSourceView {
  return {
    id: 'smithery',
    label: 'Smithery',
    kinds: ['mcp'],
    trust: 'aggregator',
    auth: 'none',
    enabled: true,
    browsable: true,
    ...overrides,
  };
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-smithery-'));
}

beforeEach(() => {
  resetBrowseCache();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('fetchSmitheryServers', () => {
  it('narrows rows to the fields this build reads — the owner id never leaves the reader', async () => {
    const { urls } = stubFetch({ 'https://registry.smithery.ai/servers?': listing({ servers: [row('brave')] }) });
    const read = await fetchSmitheryServers({ page: 2, pageSize: 10, q: 'brave' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.page.servers[0]).toEqual({
      qualifiedName: 'brave',
      displayName: 'Display brave',
      description: 'About brave',
      verified: true,
      useCount: 4242,
      remote: true,
      isDeployed: true,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    const url = new URL(urls[0]!);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('10');
    expect(url.searchParams.get('q')).toBe('brave');
  });

  it('keeps "the registry claims" and "the API serves" apart', async () => {
    stubFetch({
      'https://registry.smithery.ai/servers?': listing({
        servers: [row('brave')],
        pageSize: 20,
        totalPages: 25,
        totalCount: 20765,
      }),
    });
    const read = await fetchSmitheryServers({ pageSize: 20 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.page.totalPages).toBe(25);
    expect(read.page.totalCount).toBe(20765);
  });

  it('maps an outage and a bad payload to the console vocabulary', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    const down = await fetchSmitheryServers();
    expect(down.ok).toBe(false);
    if (!down.ok) {
      expect(down.code).toBe('unavailable');
      expect(down.reason).toBe('unavailable');
    }

    stubFetch({ 'https://registry.smithery.ai/servers?': { nope: true } });
    const odd = await fetchSmitheryServers();
    expect(odd.ok).toBe(false);
    if (!odd.ok) {
      expect(odd.code).toBe('upstream');
      expect(odd.reason).toBe('badPayload');
    }
  }, 30_000);
});

describe('fetchSmitheryServer', () => {
  it('reads the hosted connection and its required config KEY NAMES', async () => {
    stubFetch({ 'https://registry.smithery.ai/servers/brave': detail('brave', { required: ['braveApiKey', 'braveApiKey'] }) });
    const read = await fetchSmitheryServer('brave');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.detail).toEqual({
      qualifiedName: 'brave',
      description: 'Search the web',
      remote: true,
      connections: [{ type: 'http', deploymentUrl: 'https://brave.run.tools', requiredKeys: ['braveApiKey'] }],
    });
  });

  it('reports a missing record as an http 404 (the adapter turns that into no_artifact)', async () => {
    stubFetch({});
    const read = await fetchSmitheryServer('nope/nope');
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.code).toBe('upstream');
      expect(read.reasonParams).toEqual({ status: '404' });
    }
  }, 30_000);
});

describe('browseSmithery', () => {
  it('normalizes a listing row to the shared market shape with an mcp install handle', async () => {
    stubFetch({
      'https://registry.smithery.ai/servers?': listing({
        servers: [row('upstash/context7-mcp', { homepage: 'https://upstash.com/docs/context7' })],
        pageSize: 24,
        totalPages: 1,
        totalCount: 1,
      }),
    });
    const result = await browseSmithery('');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasMore).toBe(false);
    expect(result.items[0]).toMatchObject({
      id: 'smithery:upstash/context7-mcp',
      sourceId: 'smithery',
      key: 'smithery:upstash/context7-mcp',
      installKind: 'mcp',
      name: 'Display upstash/context7-mcp',
      url: 'https://upstash.com/docs/context7',
      // `useCount` is a usage counter, not a star count — the market reports "unknown", never a total.
      stars: null,
      updatedAt: '2026-09-01T00:00:00.000Z',
      topics: [],
    });
    expect(result.noteCode).toBe('smithery-window');
    expect(result.noteParams).toEqual({ total: '1', reachable: '1' });
  });

  it('falls back to the listing page when the row publishes no homepage', async () => {
    stubFetch({ 'https://registry.smithery.ai/servers?': listing({ servers: [row('exa')] }) });
    const result = await browseSmithery('');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items[0]!.url).toBe('https://smithery.ai/servers/exa');
  });

  it('reports the reachable total, not the claimed one, and says so', async () => {
    stubFetch({
      'https://registry.smithery.ai/servers?': listing({
        servers: [row('brave')],
        pageSize: 20,
        totalPages: 25,
        totalCount: 20765,
      }),
    });
    const result = await browseSmithery('', 20, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(500);
    expect(result.hasMore).toBe(true);
    expect(result.noteParams).toEqual({ total: '20765', reachable: '500' });
  });

  it('pages against the registry and keeps its page numbers', async () => {
    const { urls } = stubFetch({
      'https://registry.smithery.ai/servers?': listing({
        servers: [row('brave')],
        page: 3,
        pageSize: 5,
        totalPages: 9,
        totalCount: 45,
      }),
    });
    const result = await browseSmithery('', 5, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(45);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('pageSize')).toBe('5');
  });

  it('is reachable through browseSource and shares the 60 s window', async () => {
    const { urls } = stubFetch({ 'https://registry.smithery.ai/servers?': listing({ servers: [row('brave')] }) });
    await browseSource(sourceView(), '', 24);
    await browseSource(sourceView(), '', 24);
    expect(urls).toHaveLength(1);
    // An explicit refresh drops this source's window and nothing else.
    await browseSource(sourceView(), '', 24, { refresh: true });
    expect(urls).toHaveLength(2);
  });
});

describe('smithery adapter resolve', () => {
  const routesFor = (name: string, body: unknown) => ({ [`https://registry.smithery.ai/servers/${encodeURIComponent(name)}`]: body });

  it('turns a hosted deployment into an http launch with an Authorization env KEY only', async () => {
    stubFetch(routesFor('brave', detail('brave')));
    const outcome = await smitheryAdapter.resolve('brave', 'mcp');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.payload.kind !== 'mcp') return expect.unreachable();
    expect(outcome.canonicalKey).toBe('smithery:brave');
    // The WHOLE qualified name: `github`/`gmail`/`news` are last segments many publishers share.
    expect(outcome.name).toBe('brave');
    expect(outcome.payload.launch).toEqual({
      url: 'https://brave.run.tools',
      transport: 'http',
      headerKeys: ['Authorization'],
    });
    expect(outcome.description).toBe('Search the web');
  });

  it('keeps a scoped qualified name intact in the config key', async () => {
    stubFetch(routesFor('upstash/context7-mcp', detail('upstash/context7-mcp', { url: 'https://context7-mcp--upstash.run.tools' })));
    const outcome = await smitheryAdapter.resolve('upstash/context7-mcp', 'mcp');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.name).toBe('upstash-context7-mcp');
  });

  it('honors an sse connection', async () => {
    stubFetch(routesFor('acme/sse', detail('acme/sse', { url: 'https://acme.run.tools/sse', connType: 'sse' })));
    const outcome = await smitheryAdapter.resolve('acme/sse', 'mcp');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.payload.kind !== 'mcp') return expect.unreachable();
    expect(outcome.payload.launch).toMatchObject({ transport: 'sse' });
  });

  it('refuses a server that declares required configuration, naming the keys', async () => {
    stubFetch(routesFor('brave', detail('brave', { required: ['braveApiKey'] })));
    const outcome = await smitheryAdapter.resolve('brave', 'mcp');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('no_artifact');
    expect(outcome.message).toContain('braveApiKey');
    expect(outcome.message).toContain('https://smithery.ai/servers/brave');
  });

  it('falls back to the gateway path for a hosted server with no connection URL', async () => {
    stubFetch(routesFor('exa', { qualifiedName: 'exa', remote: true, connections: [], description: 'x' }));
    const outcome = await smitheryAdapter.resolve('exa', 'mcp');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.payload.kind !== 'mcp') return expect.unreachable();
    expect(outcome.payload.launch).toMatchObject({ url: 'https://server.smithery.ai/exa/mcp' });
  });

  it('refuses a server Smithery knows but does not host', async () => {
    stubFetch(routesFor('local/only', { qualifiedName: 'local/only', remote: false, connections: [] }));
    const outcome = await smitheryAdapter.resolve('local/only', 'mcp');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('no_artifact');
  });

  it('turns a missing record into no_artifact, never "the registry is down"', async () => {
    stubFetch({});
    const outcome = await smitheryAdapter.resolve('ghost/ghost', 'mcp');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('no_artifact');
    stubFetch({});
    const down = await smitheryAdapter.resolve('ghost/ghost', 'mcp');
    expect(down.ok).toBe(false);
  }, 30_000);

  it('refuses other kinds and an unusable reference without any network work', async () => {
    const { urls } = stubFetch({});
    const wrongKind = await smitheryAdapter.resolve('brave', 'extension');
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.code).toBe('unsupported_kind');
    const badRef = await smitheryAdapter.resolve('brave; rm -rf /', 'mcp');
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.code).toBe('no_artifact');
    expect(urls).toHaveLength(0);
  });
});

describe('installArtifact through the smithery adapter', () => {
  it('merges a hosted server into the host config with an env reference, never a token', async () => {
    const root = tmpProject();
    stubFetch({ 'https://registry.smithery.ai/servers/brave': detail('brave') });
    const result = await installArtifact({
      sourceId: 'smithery',
      key: 'smithery:brave',
      kind: 'mcp',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactId).toBe('mcp:smithery:brave');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8')) as any;
    expect(config.mcp.brave).toEqual({
      type: 'remote',
      url: 'https://brave.run.tools',
      enabled: true,
      headers: { Authorization: '{env:Authorization}' },
    });
    // Gate 4: the written file names the variable, never a value.
    expect(JSON.stringify(config)).not.toContain('Bearer');
  });

  it('lands the same server on two clients from one record', async () => {
    const root = tmpProject();
    stubFetch({ 'https://registry.smithery.ai/servers/exa': detail('exa', { url: 'https://exa.run.tools' }) });
    const result = await installArtifact({
      sourceId: 'smithery',
      key: 'smithery:exa',
      kind: 'mcp',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.copies.map((c) => c.host)).toEqual(['opencode']);
  });
});
