import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import {
  addMarketplaceEntry,
  browseMarketplace,
  getMarketplaceEntry,
  listMarketplaces,
  manifestSourceDirs,
  marketplaceSourceId,
  probeMarketplace,
  readFrontmatter,
  removeMarketplace,
  rowsForScope,
  updateMarketplace,
  validateSlug,
} from '../src/harness/market/marketplaces.js';
import { getAdapter } from '../src/harness/host/registry.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * Operator git-marketplace sources (ADR-0015 §D6 git-repo type): probe recognition (manifest
 * family, bare SKILL.md scan, duplicate mirrors), the `mp-<slug>` adapter's provenance and repo
 * containment, the PER-HARNESS plugin-market source routes (§D10/§D11 — maintenance verbs live
 * under /plugins/:harness/sources, never on a global surface) and the browse-rows view.
 */

const SHA = 'b'.repeat(40);

function entryTree(): { path: string; type: string }[] {
  return [
    // The author's canonical layer.
    { path: 'skills/ponytail/SKILL.md', type: 'blob' },
    { path: 'skills/ponytail-audit/SKILL.md', type: 'blob' },
    // A manifest whose source is in-repo.
    { path: '.claude-plugin/marketplace.json', type: 'blob' },
    // Per-harness adapter litter — detected, never rows.
    { path: '.openclaw/skills/ponytail/SKILL.md', type: 'blob' },
    { path: '.grok-plugin/marketplace.json', type: 'blob' },
    { path: 'hooks/ponytail-activate.js', type: 'blob' },
    { path: '.opencode/plugins/index.js', type: 'blob' },
  ];
}

const MANIFEST = JSON.stringify({
  name: 'ponytail',
  description: 'Lazy senior dev mode.',
  plugins: [{ name: 'ponytail', source: './skills' }],
});

function fakeFetch(opts: { tree?: { path: string; type: string }[]; manifest?: string; skillMd?: string; star?: number } = {}): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith('/repos/owner/repo')) {
      return json({ default_branch: 'main', stargazers_count: opts.star ?? 0, pushed_at: '2026-01-01T00:00:00Z' });
    }
    if (url.endsWith('/repos/owner/repo/commits/main')) return json({ sha: SHA });
    if (url.includes('/git/trees/')) return json({ tree: opts.tree ?? entryTree() });
    if (url.includes('.claude-plugin/marketplace.json')) return new Response(opts.manifest ?? MANIFEST, { status: 200 });
    if (url.includes('/SKILL.md')) {
      // Distinct frontmatter per directory, so browse filters have something real to match.
      const dir = url.split(`/${SHA}/`)[1]?.replace(/\/SKILL\.md$/, '') ?? 'x';
      const name = dir.split('/').pop() ?? 'x';
      const body = opts.skillMd ?? `---\nname: ${name}\ndescription: >\n  folded line\n  two\n---\n# body`;
      return new Response(body, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function sandboxHome(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mp-'));
  process.env.OCR_HOME = dir;
}

describe('git-marketplace probe', () => {
  it('reads frontmatter name and folds the description block', () => {
    const fm = readFrontmatter('---\nname: ponytail\ndescription: >\n  one\n  two\n---\nbody');
    expect(fm.name).toBe('ponytail');
    expect(fm.description).toBe('one two');
    expect(readFrontmatter('no frontmatter').name).toBeNull();
  });

  it('extracts only in-repo relative sources from a manifest and refuses .. escapes', () => {
    const { dirs } = manifestSourceDirs(
      JSON.stringify({
        plugins: [
          { source: './skills' },
          { source: 'https://github.com/x/y.git' },
          { source: { source: 'git-subdir', url: 'https://x', path: 'p' } },
          { source: './../escape' },
        ],
      }),
    );
    expect(dirs).toEqual(['skills']);
  });

  it('recognizes the manifest layer, dedupes mirror copies and flags adapters', async () => {
    sandboxHome();
    const entry = { slug: 'ponytail', repo: 'owner/repo', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    const probe = await probeMarketplace(entry, fakeFetch());
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    // Only the manifest-declared scope (`skills/`) — the .openclaw mirror is NOT a row.
    expect(probe.snapshot.rows.map((r) => r.dir).sort()).toEqual(['skills/ponytail', 'skills/ponytail-audit']);
    expect(probe.snapshot.manifest?.name).toBe('ponytail');
    // Frontmatter survived the probe (folded description, per-row title).
    expect(probe.snapshot.rows.find((r) => r.name === 'ponytail')?.description).toBe('folded line two');
    expect(probe.snapshot.authorAdapters).toContain('grok');
    expect(probe.snapshot.authorAdapters).toContain('openclaw');
    expect(probe.snapshot.unsupported.some((u) => u.shape === 'hooks')).toBe(true);
  });

  it('falls back to a whole-tree scan (shortest path wins) with no manifest', async () => {
    sandboxHome();
    const entry = { slug: 'bare', repo: 'owner/repo', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    const probe = await probeMarketplace(entry, fakeFetch({ manifest: 'not json', tree: entryTree() }));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    const dirs = probe.snapshot.rows.map((r) => r.dir);
    // `skills/ponytail` beats the deeper `.openclaw/skills/ponytail` mirror; both ponytail-* rows exist once.
    expect(dirs.filter((d) => d.endsWith('/ponytail'))).toEqual(['skills/ponytail']);
    expect(probe.snapshot.manifest).toBeNull();
  });
});

describe('git-marketplace store + adapter', () => {
  it('rejects duplicate and malformed slugs', () => {
    sandboxHome();
    expect(validateSlug('ok-slug')).toBeNull();
    expect(validateSlug('Bad_Slug')).toMatch(/invalid slug/);
    addMarketplaceEntry({ slug: 'taken', repo: 'o/r' });
    expect(validateSlug('taken')).toMatch(/already configured/);
  });

  it('containment: the adapter resolves only its configured repo and demands a #dir pin', async () => {
    sandboxHome();
    addMarketplaceEntry({ slug: 'pony', repo: 'owner/repo' });
    const adapter = getAdapter('mp-pony');
    expect(adapter).toBeDefined();
    if (!adapter) return;
    const foreign = await adapter.resolve('other/repo#skills/ponytail', 'skill', { fetchImpl: fakeFetch() });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.message).toMatch(/configured repository/);
    const unpinned = await adapter.resolve('owner/repo', 'skill', { fetchImpl: fakeFetch() });
    expect(unpinned.ok).toBe(false);
    if (!unpinned.ok) expect(unpinned.message).toMatch(/#<skill-dir>/);
    const wrongKind = await adapter.resolve('owner/repo#x', 'mcp', { fetchImpl: fakeFetch() });
    expect(wrongKind.ok).toBe(false);
  });

  it('rewrites provenance: canonicalKey keeps the mp- prefix, not github:', async () => {
    sandboxHome();
    addMarketplaceEntry({ slug: 'prov', repo: 'owner/repo' });
    const adapter = getAdapter('mp-prov');
    if (!adapter) throw new Error('adapter missing');
    // The delegated github resolve needs a tarball; without one it answers `upstream` — the
    // success-path canonicalKey rewrite is asserted by the route test's browse key shape.
    const resolved = await adapter.resolve('owner/repo#skills/ponytail', 'skill', { fetchImpl: fakeFetch() });
    if (resolved.ok) {
      expect(resolved.canonicalKey.startsWith('mp-prov:')).toBe(true);
    } else {
      expect(resolved.code).toBe('upstream');
    }
  });

  it('disabled entries resolve to nothing', () => {
    sandboxHome();
    addMarketplaceEntry({ slug: 'off', repo: 'o/r' });
    expect(getAdapter('mp-off')).toBeDefined();
    updateMarketplace('off', { enabled: false });
    expect(getAdapter('mp-off')).toBeUndefined();
  });
});

describe('marketplace browse over snapshots', () => {
  it('answers rows from the latest snapshot with local filter and paging', async () => {
    sandboxHome();
    addMarketplaceEntry({ slug: 'pony', repo: 'owner/repo' });
    const entry = getMarketplaceEntry('pony')!;
    await probeMarketplace(entry, fakeFetch());
    const all = browseMarketplace('pony');
    expect(all.ok && all.total).toBe(2);
    const filtered = browseMarketplace('pony', { query: 'audit' });
    expect(filtered.ok && filtered.items.length).toBe(1);
    if (filtered.ok) {
      expect(filtered.items[0]!.key).toBe('mp-pony:owner/repo#skills/ponytail-audit');
    }
    expect(browseMarketplace('nope').ok).toBe(false);
  });
});

describe('per-harness plugin source routes', () => {
  it('add probes at add-time, lists the custom source, remove cleans config', async () => {
    sandboxHome();
    const app = fastify();
    registerHarnessRoutes(app, { marketplaceFetch: fakeFetch() });

    const added = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/pi/sources',
      payload: { url: 'https://github.com/owner/repo' },
    });
    expect(added.statusCode).toBe(200);

    // Duplicate slug conflicts.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/pi/sources',
      payload: { url: 'https://github.com/owner/repo' },
    });
    expect(dup.statusCode).toBe(409);

    // Bad target refused.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/pi/sources',
      payload: { url: 'https://gitlab.com/x/y' },
    });
    expect(bad.statusCode).toBe(400);

    // Kind isolation: the plugin-kind query only lists sources whose snapshot carries plugins.
    const pluginView = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources?kind=plugin' })).body,
    ) as { sources: { id: string }[]; operator: { slug: string; kinds: string[] }[] };
    expect(pluginView.sources.some((s) => s.id === 'pi-dev')).toBe(true);
    expect(pluginView.sources.some((s) => s.id === 'skills-sh')).toBe(false);
    expect(pluginView.operator.some((e) => e.slug === 'repo')).toBe(true);
    const skillView = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources?kind=skill' })).body,
    ) as { sources: { id: string }[]; operator: { slug: string; kinds: string[] }[] };
    expect(skillView.sources.some((s) => s.id === 'pi-dev')).toBe(false);
    expect(skillView.operator.some((e) => e.slug === 'repo' && e.kinds.includes('skill'))).toBe(true);

    // The unfiltered view answers both lists: built-in chips + the operator entry.
    const sources = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources' })).body,
    ) as { sources: { id: string }[]; operator: { slug: string; kinds: string[] }[] };
    expect(sources.sources.some((s) => s.id === 'pi-dev')).toBe(true);
    expect(sources.operator.some((e) => e.slug === 'repo' && e.kinds.includes('plugin'))).toBe(true);

    // Browse answers rows with keys the install route accepts.
    const browse = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/browse?source=mp-repo' })).body,
    ) as { items: { key: string; installKind: string }[] };
    expect(browse.items.length).toBe(2);
    expect(browse.items[0]!.installKind).toBe('skill');

    // Unknown harness answers 404.
    const ghost = await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/nope/sources' });
    expect(ghost.statusCode).toBe(404);

    // Full CRUD: disable removes the index rows from the view (harvest skips disabled entries).
    const patchOff = await app.inject({ method: 'PATCH', url: '/api/admin/harness/plugins/pi/sources/repo', payload: { enabled: false } });
    expect(patchOff.statusCode).toBe(200);
    const sourcesOff = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources' })).body,
    ) as { operator: { slug: string; enabled: boolean }[] };
    expect(sourcesOff.operator.every((e) => !(e.slug === 'repo' && e.enabled))).toBe(true);

    // Manual rescan: no change since the add-time probe — empty diff, rows reported.
    const rescan = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/admin/harness/plugins/pi/sources/repo/rescan' })).body,
    ) as { status: string; diff: { added: string[]; removed: string[] }; rows: number };
    expect(rescan.diff.added).toEqual([]);
    expect(rescan.diff.removed).toEqual([]);
    expect(rescan.rows).toBe(2);

    // Snapshot history is summarized, never a raw dump.
    const snaps = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/pi/sources/repo/snapshots' })).body,
    ) as { snapshots: { rows: number; sha: string }[] };
    expect(snaps.snapshots.length).toBeGreaterThanOrEqual(1);

    // Re-enable restores the view.
    const patchOn = await app.inject({ method: 'PATCH', url: '/api/admin/harness/plugins/pi/sources/repo', payload: { enabled: true } });
    expect(patchOn.statusCode).toBe(200);
    const sourcesOn = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources' })).body,
    ) as { operator: { slug: string; enabled: boolean }[] };
    expect(sourcesOn.operator.some((e) => e.slug === 'repo' && e.enabled)).toBe(true);

    // Remove cleans the shared store.
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/harness/plugins/pi/sources/repo' });
    expect(del.statusCode).toBe(200);
    expect(listMarketplaces()).toEqual([]);
    expect(getMarketplaceEntry('repo')).toBeUndefined();
    expect(marketplaceSourceId('repo')).toBe('mp-repo');
  });

  it('unknown slugs and unknown harness answer 404, not silent success', async () => {
    sandboxHome();
    const app = fastify();
    registerHarnessRoutes(app, { marketplaceFetch: fakeFetch() });
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/harness/plugins/pi/sources/ghost' });
    expect(del.statusCode).toBe(404);
    const patchGhost = await app.inject({ method: 'PATCH', url: '/api/admin/harness/plugins/pi/sources/ghost', payload: { enabled: false } });
    expect(patchGhost.statusCode).toBe(404);
    const rescanGhost = await app.inject({ method: 'POST', url: '/api/admin/harness/plugins/pi/sources/ghost/rescan' });
    expect(rescanGhost.statusCode).toBe(404);
    const snapsGhost = await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/pi/sources/ghost/snapshots' });
    expect(snapsGhost.statusCode).toBe(404);
    const ghostHarness = await app.inject({ method: 'PATCH', url: '/api/admin/harness/plugins/nope/sources/ghost', payload: {} });
    expect(ghostHarness.statusCode).toBe(404);
  });
});

describe('removeMarketplace keeps foreign entries', () => {
  it('removes only the named slug', () => {
    sandboxHome();
    addMarketplaceEntry({ slug: 'a', repo: 'o/a' });
    addMarketplaceEntry({ slug: 'b', repo: 'o/b' });
    expect(removeMarketplace('a')).toBe(true);
    expect(listMarketplaces().map((e) => e.slug)).toEqual(['b']);
    expect(removeMarketplace('a')).toBe(false);
  });
});

describe('rowsForScope', () => {
  it('narrows to the scope and dedupes by basename, shortest path first', async () => {
    const rows = await rowsForScope('owner/repo', SHA, ['skills'], entryTree() as import('../src/harness/tree.js').TreeEntry[], fakeFetch());
    expect(rows.map((r) => r.dir).sort()).toEqual(['skills/ponytail', 'skills/ponytail-audit']);
  });
});
