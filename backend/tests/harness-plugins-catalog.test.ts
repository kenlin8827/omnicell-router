import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  addMarketplaceEntry,
  manifestSourceDirs,
  probeMarketplace,
  removeMarketplace,
  latestSnapshot,
} from '../src/harness/market/marketplaces.js';
import { harvestIndex, queryIndex, readIndex, indexSources, sortRows } from '../src/harness/plugin/catalog.js';
import { createPluginAdapter } from '../src/harness/plugin/market.js';
import type { CatalogRow } from '../src/harness/plugin/types.js';

/**
 * The plugin catalog index tier (ADR-0015 §D10): manifest `plugins[]` extraction, the per-harness
 * index store (harvest from marketplace snapshots, cap enforcement), local query/sort/paginate,
 * and the per-harness adapter facade. All GitHub traffic is stubbed — the index tier is, by
 * design, a read over snapshots that already exist.
 */

const SHA = 'b'.repeat(40);

/** The sandbox persists across runs: stale snapshots/config would leak into assertions. */
function cleanup(): void {
  removeMarketplace('plugsrc');
}

const MANIFEST = JSON.stringify({
  name: 'ponytail',
  description: 'Lazy senior dev mode.',
  plugins: [
    { name: 'ponytail', source: './skills', description: 'The plugin.' },
    { name: 'ponytail-extra', source: './extra', description: 'Extra.' },
    { name: 'external', source: { source: 'git-subdir', url: 'https://x', path: 'p' } },
  ],
});

function pluginTree(): { path: string; type: string }[] {
  return [
    { path: 'skills/SKILL.md', type: 'blob' },
    { path: 'extra/SKILL.md', type: 'blob' },
    { path: '.claude-plugin/marketplace.json', type: 'blob' },
    { path: '.opencode/plugin.json', type: 'blob' },
  ];
}

function fakeFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith('/repos/acme/plugins')) {
      return json({ default_branch: 'main', stargazers_count: 42, pushed_at: '2026-02-02T00:00:00Z' });
    }
    if (url.endsWith('/commits/main')) return json({ sha: SHA });
    if (url.includes('/git/trees/')) return json({ tree: pluginTree() });
    if (url.includes('raw.githubusercontent.com')) {
      if (url.endsWith('marketplace.json')) return new Response(MANIFEST, { status: 200 });
      return new Response('---\nname: x\ndescription: d\n---\nbody', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('manifest plugins[] extraction', () => {
  it('extracts named plugins with relative sources; external sources stay out', () => {
    const { plugins } = manifestSourceDirs(MANIFEST);
    expect(plugins.map((p) => p.name)).toEqual(['ponytail', 'ponytail-extra']);
    expect(plugins[0]).toEqual({ name: 'ponytail', source: 'skills', description: 'The plugin.' });
  });

  it('the probe snapshot carries the plugin rows and the repo star count', async () => {
    cleanup();
    const entry = { slug: 'plugsrc', repo: 'acme/plugins', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    const outcome = await probeMarketplace(entry, fakeFetch(), { persist: false });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.snapshot.plugins.map((p) => p.name)).toEqual(['ponytail', 'ponytail-extra']);
    expect(outcome.snapshot.stars).toBe(42);
    // Dry-run probe: no snapshot persisted for an unregistered slug.
    expect(latestSnapshot('plugsrc')).toBeNull();
  });
});

describe('plugin catalog index tier', () => {
  it('harvests marketplace plugin rows into the per-harness index and queries locally', async () => {
    cleanup();
    addMarketplaceEntry({ slug: 'plugsrc', repo: 'acme/plugins' });
    const entry = { slug: 'plugsrc', repo: 'acme/plugins', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    await probeMarketplace(entry, fakeFetch());

    const harvest = harvestIndex('opencode');
    expect(harvest.rows).toBe(2);
    expect(harvest.sources).toEqual(['mp-plugsrc']);

    const rows = readIndex('opencode');
    expect(rows).toHaveLength(2);
    // claude from the claude-shaped manifest + opencode from the detected `.opencode/` adapter dir.
    expect(rows[0]!.hosts).toEqual(['claude', 'opencode']);
    expect(rows[0]!.stars).toBe(42);
    expect(rows[0]!.surfaces).toEqual(['mp-plugsrc']);

    const q = queryIndex('opencode', 'pony', { page: 1, pageSize: 24, sort: 'name' });
    expect(q.total).toBe(2);
    expect(q.rows[0]!.name).toBe('ponytail');

    // Pagination: page 2 with pageSize 1 answers the second row and hasMore via total.
    const p2 = queryIndex('opencode', '', { page: 2, pageSize: 1, sort: 'stars' });
    expect(p2.rows).toHaveLength(1);
    expect(p2.total).toBe(2);
    expect(p2.rows[0]!.stars).toBe(42);

    removeMarketplace('plugsrc');
    expect(harvestIndex('opencode').rows).toBe(0);
  });

  it('sorts stars with null last, deterministically', () => {
    const row = (over: Partial<CatalogRow>): CatalogRow => ({
      key: 'k', name: 'n', summary: null, stars: null, updatedAt: null,
      sourceId: 's', surfaces: ['s'], hosts: ['claude'], repo: null, ...over,
    });
    const rows = [
      row({ name: 'b', stars: null }),
      row({ name: 'c', stars: 5 }),
      row({ name: 'a', stars: 5 }),
    ];
    sortRows(rows, 'stars');
    expect(rows.map((r) => r.name)).toEqual(['a', 'c', 'b']);
  });

  it('the adapter facade answers merged search over its harness index', async () => {
    cleanup();
    addMarketplaceEntry({ slug: 'plugsrc', repo: 'acme/plugins' });
    const entry = { slug: 'plugsrc', repo: 'acme/plugins', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    await probeMarketplace(entry, fakeFetch());
    harvestIndex('pi');

    const pi = createPluginAdapter('pi', fakeFetch());
    expect(pi.sources().map((s) => s.id)).toEqual(['mp-plugsrc']);
    const page = await pi.search('ponytail', { sort: 'name' });

    expect(page.total).toBe(2); // 'ponytail' and 'ponytail-extra' both match the substring
    expect(page.rows[0]!.name).toBe('ponytail');
    // The federated tier degrades to notes, never fails the page: the stub answers 404. The pi
    // adapter's federated tier is pi.dev only (its one declared host); claude's is empty.
    expect(page.notes.some((n) => n.includes('pi.dev'))).toBe(true);
    expect(page.sections!.length).toBe(1);
    expect(page.sections![0]!.sourceId).toBe('pi-dev');

    const cl = createPluginAdapter('claude');
    expect((await cl.search('nothing-matches', { sort: 'stars' })).rows).toEqual([]);

    removeMarketplace('plugsrc');
    harvestIndex('pi');
  }, 30_000);

  it('registerSource probes before committing and answers checkSource without leaving state', async () => {
    cleanup();
    const pi = createPluginAdapter('pi', fakeFetch());
    const check = await pi.checkSource('https://github.com/acme/plugins');
    expect(check).toEqual({ ok: true, skills: 2, mcps: 0, plugins: 2 });
    expect(latestSnapshot('plugins')).toBeNull(); // dry-run left nothing behind

    const bad = await pi.checkSource('https://gitlab.com/acme/plugins');
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('not a GitHub repository URL');

    const reg = await pi.registerSource('https://github.com/acme/plugins');
    expect(reg.ok).toBe(true);
    expect(listSlugs()).toContain('plugins');
    expect(harvestIndex('pi').rows).toBe(2);

    expect(pi.unregisterSource('plugins')).toBe(true);
    expect(readIndex('pi')).toHaveLength(0);
  });
});

function listSlugs(): string[] {
  // Imported lazily to keep the import list honest; thin wrapper over listMarketplaces.
  const { listMarketplaces } = require('../src/harness/market/marketplaces.js') as typeof import('../src/harness/market/marketplaces.js');
  return listMarketplaces().map((e) => e.slug);
}

// Keep the fs/path imports used: the sandbox layout assertion below documents the store location.
describe('index store layout', () => {
  it('lives under <ocrHome>/harness/catalog/<harness>/index.jsonl', () => {
    const { getOcrHomeDir } = require('../src/cli/paths.js') as typeof import('../src/cli/paths.js');
    harvestIndex('claude');
    expect(fs.existsSync(path.join(getOcrHomeDir(), 'harness', 'catalog', 'claude', 'index.jsonl'))).toBe(true);
  });
});
