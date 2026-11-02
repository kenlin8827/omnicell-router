import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { parsePypiSource, probePypiSource } from '../src/harness/common/pypi-source.js';
import { pypiAdapter } from '../src/harness/host/resolvers/pypi.js';
import { getAdapter } from '../src/harness/host/registry.js';
import { createPluginAdapter } from '../src/harness/plugin/adapters/index.js';
import { latestSnapshot, listMarketplaceEntries, updateMarketplaceEntry } from '../src/harness/common/market.js';
import { readIndex } from '../src/harness/plugin/catalog.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * PyPI as an MCP source (ADR-0015 §8/§D9 amendment): the source is ONE package launched by `uvx`,
 * registered on the MCP axis — never a plugin row and never a native marketplace registration.
 */

function sandboxHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mcp-src-'));
  process.env.OCR_HOME = home;
  return home;
}

const PROJECT = {
  info: { name: 'mcp-server-fetch', version: '2025.1.1', summary: 'Fetch web pages as MCP resources' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** One-shot PyPI stub: records the URLs it was asked for. `doc: null` answers 404. */
function pypiFetch(doc: unknown | null = PROJECT): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    calls.push(String(input));
    return doc === null ? json({ message: 'Not Found' }, 404) : json(doc);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('PyPI source input', () => {
  it('keeps a bare name, a pypi: prefix and a project page on ONE identity', () => {
    expect(parsePypiSource('mcp-server-fetch')).toEqual({ ok: true, name: 'mcp-server-fetch' });
    expect(parsePypiSource('  pypi:mcp-server-fetch ')).toEqual({ ok: true, name: 'mcp-server-fetch' });
    expect(parsePypiSource('https://pypi.org/project/mcp-server-fetch/')).toEqual({ ok: true, name: 'mcp-server-fetch' });
    expect(parsePypiSource('https://pypi.org/project/mcp-server-fetch/2025.1.1/')).toEqual({
      ok: true,
      name: 'mcp-server-fetch',
    });
  });

  it('refuses a pin, an extra or a shell shape — the version is resolved at install time', () => {
    for (const raw of ['mcp-server-fetch==2025.1.1', 'mcp-server-fetch[cli]', 'mcp server', '', '-rfetch']) {
      expect(parsePypiSource(raw).ok).toBe(false);
    }
  });
});

describe('PyPI MCP resolver', () => {
  it('resolves the latest release into a pinned uvx launch', async () => {
    const { fetchImpl, calls } = pypiFetch();
    const outcome = await pypiAdapter.resolve('mcp-server-fetch', 'mcp', { fetchImpl });
    expect(calls).toEqual(['https://pypi.org/pypi/mcp-server-fetch/json']);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.canonicalKey).toBe('pypi:mcp-server-fetch');
    expect(outcome.name).toBe('mcp-server-fetch');
    expect(outcome.description).toBe('Fetch web pages as MCP resources');
    expect(outcome.payload).toEqual({
      kind: 'mcp',
      name: 'mcp-server-fetch',
      launch: { command: 'uvx', args: ['mcp-server-fetch==2025.1.1'] },
    });
    expect(outcome.pin).toEqual({ pypi: { version: '2025.1.1' } });
  });

  it('derives the entry key with the intersection grammar: a dotted PyPI name cannot reach pi raw', async () => {
    const doc = { info: { name: 'db.pal', version: '1.0.0', summary: null } };
    const outcome = await pypiAdapter.resolve('db.pal', 'mcp', { fetchImpl: pypiFetch(doc).fetchImpl });
    if (!outcome.ok) throw new Error(outcome.message);
    if (outcome.payload.kind !== 'mcp') return expect.unreachable();
    // `pi mcp add foo.bar` answers `invalid server name`: the dot is package vocabulary, not the
    // host's, so the key is derived while the launch keeps the real requirement spec.
    expect(outcome.canonicalKey).toBe('pypi:db.pal');
    expect(outcome.payload.name).toBe('db-pal');
    expect(outcome.payload.launch).toEqual({ command: 'uvx', args: ['db.pal==1.0.0'] });
  });

  it('asks the version document for an exact pin and refuses anything else', async () => {
    const { fetchImpl, calls } = pypiFetch();
    const pinned = await pypiAdapter.resolve('mcp-server-fetch==2025.1.1', 'mcp', { fetchImpl });
    expect(pinned.ok).toBe(true);
    expect(calls).toEqual(['https://pypi.org/pypi/mcp-server-fetch/2025.1.1/json']);

    const range = await pypiAdapter.resolve('mcp-server-fetch>=1', 'mcp', { fetchImpl });
    expect(range.ok).toBe(false);
    if (range.ok) return;
    expect(range.code).toBe('no_artifact');
  });

  it('refuses a kind it cannot lay down and reports a missing package honestly', async () => {
    const { fetchImpl } = pypiFetch();
    const plugin = await pypiAdapter.resolve('mcp-server-fetch', 'plugin', { fetchImpl });
    expect(plugin.ok).toBe(false);
    if (plugin.ok) return;
    expect(plugin.code).toBe('unsupported_kind');

    const missing = await pypiAdapter.resolve('no-such-package', 'mcp', { fetchImpl: pypiFetch(null).fetchImpl });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('no_artifact');
  });

  it('is the registry adapter for the pypi: channel', () => {
    expect(getAdapter('pypi')).toBe(pypiAdapter);
  });
});

describe('PyPI probe', () => {
  it('answers the registry name, description and version', async () => {
    const probed = await probePypiSource({ ok: true, name: 'mcp-server-fetch' }, pypiFetch().fetchImpl);
    expect(probed).toEqual({
      ok: true,
      pkg: { name: 'mcp-server-fetch', description: 'Fetch web pages as MCP resources', version: '2025.1.1' },
    });
  });

  it('says a 404 is a missing package, not an empty success', async () => {
    const probed = await probePypiSource({ ok: true, name: 'nope' }, pypiFetch(null).fetchImpl);
    expect(probed.ok).toBe(false);
  });
});

describe('MCP source registration', () => {
  it('registers a PyPI package on the shared MCP axis, out of the plugin catalog', async () => {
    const home = sandboxHome();
    const adapter = createPluginAdapter('opencode', pypiFetch().fetchImpl, { custom: true });
    const outcome = await adapter.registerSource('mcp-server-fetch', { type: 'pypi', kind: 'mcp' });
    expect(outcome.ok).toBe(true);

    const [entry] = listMarketplaceEntries();
    expect(entry).toBeDefined();
    expect(entry!.repo).toBe('mcp-server-fetch');
    expect(entry!.type).toBe('pypi');
    expect(entry!.axis).toBe('mcp');
    // A package source is host-neutral: it never pins the drawer that registered it.
    expect(entry!.harness).toBeUndefined();
    expect(listMarketplaceEntries('pi').map((e) => e.slug)).toEqual([entry!.slug]);
    expect(listMarketplaceEntries('omp').map((e) => e.slug)).toEqual([entry!.slug]);

    // One shared bucket in the file, and ONE global snapshot: no harness directory is written.
    const store = JSON.parse(fs.readFileSync(path.join(home, 'harness', 'mcp-market.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(store)).toEqual(['shared']);
    expect(store.shared).toHaveLength(1);
    expect(fs.existsSync(path.join(home, 'harness', 'marketplaces', 'opencode', 'mcp-server-fetch.json'))).toBe(false);

    const snapshot = latestSnapshot(entry!.slug);
    expect(snapshot?.mcps).toEqual([
      { name: 'mcp-server-fetch', description: 'Fetch web pages as MCP resources', version: '2025.1.1' },
    ]);
    // The plugin index reads snapshots, and an MCP source is not one: nothing to harvest.
    expect(readIndex('opencode')).toEqual([]);
  });

  it('answers a second add as already configured because the source is visible there', async () => {
    sandboxHome();
    const first = await createPluginAdapter('opencode', pypiFetch().fetchImpl, { custom: true }).registerSource(
      'mcp-server-fetch',
      { type: 'pypi', kind: 'mcp' },
    );
    expect(first.ok).toBe(true);
    const second = await createPluginAdapter('pi', pypiFetch().fetchImpl, { custom: true }).registerSource(
      'mcp-server-fetch',
      { type: 'pypi', kind: 'mcp' },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_configured');
    expect(listMarketplaceEntries('pi')).toHaveLength(1);
  });

  it('reads a legacy harness bucket as shared and flattens it on the next write', () => {
    const home = sandboxHome();
    fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'harness', 'mcp-market.json'),
      JSON.stringify({
        shared: [],
        opencode: [
          {
            slug: 'mcp-server-fetch',
            catalog: 'default',
            repo: 'mcp-server-fetch',
            type: 'pypi',
            enabled: true,
            addedAt: 1,
            rescan: { enabled: false, intervalMs: 86_400_000 },
            extensionDir: null,
          },
        ],
      }),
    );
    const [legacy] = listMarketplaceEntries('pi');
    expect(legacy?.slug).toBe('mcp-server-fetch');
    expect(legacy?.harness).toBeUndefined();

    expect(updateMarketplaceEntry('mcp-server-fetch', { enabled: false })).not.toBeNull();
    const store = JSON.parse(fs.readFileSync(path.join(home, 'harness', 'mcp-market.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(store)).toEqual(['shared']);
    expect(store.shared).toHaveLength(1);
  });

  it('refuses a whole npm scope as an MCP source (one package, never a namespace)', async () => {
    sandboxHome();
    const adapter = createPluginAdapter('claude', pypiFetch().fetchImpl, { custom: true });
    const outcome = await adapter.registerSource('@scope/*', { type: 'npm', kind: 'mcp' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('invalid_source');
    expect(listMarketplaceEntries()).toEqual([]);
  });

  it('refuses a git repository on the MCP axis instead of registering an invisible plugin entry', async () => {
    sandboxHome();
    const adapter = createPluginAdapter('claude', pypiFetch().fetchImpl, { custom: true });
    const outcome = await adapter.registerSource('owner/repo', { type: 'github', kind: 'mcp' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('invalid_source');
    expect(listMarketplaceEntries()).toEqual([]);
  });

  it('counts one MCP package when a PyPI source is dry-run', async () => {
    sandboxHome();
    const adapter = createPluginAdapter('claude', pypiFetch().fetchImpl, { custom: true });
    const check = await adapter.checkSource('mcp-server-fetch', { type: 'pypi', kind: 'mcp' });
    expect(check.ok).toBe(true);
    expect(check.mcps).toBe(1);
    expect(check.plugins).toBe(0);
  });
});

describe('MCP source routes', () => {
  it('checks, lists on every MCP-capable tab, rescans globally, and browses with the registry install handle', async () => {
    const home = sandboxHome();
    const app = fastify();
    registerHarnessRoutes(app, { marketplaceFetch: pypiFetch().fetchImpl });

    const check = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/opencode/sources/check',
      payload: { url: 'mcp-server-fetch', type: 'pypi', kind: 'mcp' },
    });
    expect(check.statusCode).toBe(200);
    expect(JSON.parse(check.body)).toMatchObject({ ok: true, mcps: 1, plugins: 0 });

    const add = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/opencode/sources',
      payload: { url: 'mcp-server-fetch', type: 'pypi', kind: 'mcp' },
    });
    expect(add.statusCode).toBe(200);

    const tab = async (harness: string) =>
      JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/admin/harness/plugins/${harness}/sources?kind=mcp` })).body,
      ) as { operator: { slug: string; kinds: string[]; hosts: string[] }[] };

    const opencodeTab = await tab('opencode');
    expect(opencodeTab.operator.map((e) => e.slug)).toEqual(['mcp-server-fetch']);
    expect(opencodeTab.operator[0]!.kinds).toEqual(['mcp']);
    // The SAME source lists on every landing-capable tab, not just the one that added it.
    expect((await tab('pi')).operator.map((e) => e.slug)).toEqual(['mcp-server-fetch']);
    expect((await tab('omp')).operator.map((e) => e.slug)).toEqual(['mcp-server-fetch']);
    expect((await tab('claude')).operator.map((e) => e.slug)).toEqual(['mcp-server-fetch']);
    expect((await tab('codex')).operator.map((e) => e.slug)).toEqual(['mcp-server-fetch']);
    expect((await tab('kimi')).operator.map((e) => e.slug)).toEqual(['mcp-server-fetch']);
    expect((await tab('grok')).operator.map((e) => e.slug)).toEqual(['mcp-server-fetch']);
    expect((await tab('openclaw')).operator.map((e) => e.slug)).toEqual(['mcp-server-fetch']);
    // A harness with no MCP landing is not a market for it.
    expect((await tab('cursor')).operator).toEqual([]);
    const globalSources = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/sources' })).body,
    ) as { sources: { id: string; hosts?: string[] }[] };
    expect(globalSources.sources.find((s) => s.id === 'mp-mcp-server-fetch')?.hosts).toEqual(['opencode', 'claude', 'codex', 'pi', 'omp', 'kimi', 'grok', 'openclaw']);
    // The plugin tab must not list it: the snapshot carries no plugin row.
    const pluginTab = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/opencode/sources?kind=plugin' })).body,
    ) as { operator: unknown[] };
    expect(pluginTab.operator).toEqual([]);

    // A rescan from a SIBLING tab rewrites the one global snapshot; no harness dir is created.
    const rescan = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/pi/sources/mcp-server-fetch/rescan',
    });
    expect(rescan.statusCode).toBe(200);
    expect(fs.existsSync(path.join(home, 'harness', 'marketplaces', 'pi', 'mcp-server-fetch.json'))).toBe(false);
    expect(latestSnapshot('mcp-server-fetch')?.mcps).toHaveLength(1);

    const browse = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/browse?source=mp-mcp-server-fetch&kind=mcp' })).body,
    ) as { items: { key: string; installKind: string; name: string; version: string | null }[] };
    expect(browse.items).toHaveLength(1);
    expect(browse.items[0]).toMatchObject({ key: 'pypi:mcp-server-fetch', installKind: 'mcp', name: 'mcp-server-fetch' });

    // Removal from ANY capable tab removes the shared entry and its one global snapshot.
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/admin/harness/plugins/omp/sources/mcp-server-fetch',
    });
    expect(removed.statusCode).toBe(200);
    expect(listMarketplaceEntries()).toEqual([]);
    expect(fs.existsSync(path.join(home, 'harness', 'marketplaces', 'mcp-server-fetch.json'))).toBe(false);
  });

  it('answers the derived server key on an MCP market row, so the sheet never shows a name the landing refuses', async () => {
    sandboxHome();
    const app = fastify();
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url === 'https://registry.npmjs.org/@bytebase%2Fdbhub') {
        return json({
          name: '@bytebase/dbhub',
          description: 'Database MCP server',
          'dist-tags': { latest: '1.5.0' },
          versions: { '1.5.0': {} },
        });
      }
      return json({ message: 'Not Found' }, 404);
    }) as unknown as typeof fetch;
    registerHarnessRoutes(app, { marketplaceFetch: fetchImpl });

    const add = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/opencode/sources',
      payload: { url: '@bytebase/dbhub', type: 'npm', kind: 'mcp' },
    });
    expect(add.statusCode).toBe(200);
    const slug = listMarketplaceEntries()[0]!.slug;

    const browse = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/admin/harness/browse?source=mp-${slug}&kind=mcp` })).body,
    ) as { items: { key: string; name: string; serverName?: string }[] };
    expect(browse.items).toHaveLength(1);
    // The row is browsed by its package identity; the key it will be merged under is the derived
    // one (`@bytebase/dbhub` is refused by every verified host grammar).
    expect(browse.items[0]).toMatchObject({
      key: 'npm:@bytebase/dbhub',
      name: '@bytebase/dbhub',
      serverName: 'bytebase-dbhub',
    });
  });
});
