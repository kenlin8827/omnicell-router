import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import {
  addMarketplaceEntry,
  browseMarketplace,
  getMarketplaceEntry,
  listMarketplaceEntries,
  githubRepoFromInput,
  marketplaceSourceId,
  normalizeExtensionDir,
  probeMarketplace,
  readFrontmatter,
  removeMarketplaceEntry,
  resolveSlug,
  rowsForScope,
  updateMarketplaceEntry,
  validateSlug,
} from '../src/harness/common/market.js';
import { getAdapter } from '../src/harness/host/registry.js';
import { createPluginAdapter, probeOptionsFor } from '../src/harness/plugin/adapters/index.js';
import { CLAUDE_CATALOG, parseClaudeMarketplace } from '../src/harness/plugin/adapters/claude.js';
import { CODEX_PROBE_OPTIONS } from '../src/harness/plugin/adapters/codex.js';
import { GEMINI_PROBE_OPTIONS } from '../src/harness/plugin/adapters/gemini.js';
import { GROK_PROBE_OPTIONS } from '../src/harness/plugin/adapters/grok.js';
import { COPILOT_PROBE_OPTIONS } from '../src/harness/plugin/adapters/copilot.js';
import { UNIVERSAL_PROBE_OPTIONS } from '../src/harness/plugin/adapters/universal.js';
import { PI_PROBE_OPTIONS } from '../src/harness/plugin/adapters/pi-github.js';
import { harvestIndex, readIndex } from '../src/harness/plugin/catalog.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * Operator git-marketplace sources (ADR-0015 §D6 git-repo type): probe recognition (manifest
 * family, bare SKILL.md scan, duplicate mirrors), the `mp-<slug>` adapter's provenance and repo
 * containment, the per-harness plugin-market source routes (§D10/§D11 — plugin maintenance verbs
 * live under /plugins/:harness/sources; the skill axis has its own GLOBAL /skills/sources surface)
 * and the browse-rows view.
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

function fakeFetch(opts: { tree?: { path: string; type: string }[]; manifest?: string; packageJson?: string; pluginJson?: string; geminiJson?: string; skillMd?: string; star?: number } = {}): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith('/repos/owner/repo')) {
      return json({ default_branch: 'main', stargazers_count: opts.star ?? 0, pushed_at: '2026-01-01T00:00:00Z' });
    }
    if (url.endsWith('/repos/owner/repo/commits/main')) return json({ sha: SHA });
    if (url.includes('/git/trees/')) return json({ tree: opts.tree ?? entryTree() });
    if (url.includes('marketplace.json')) return new Response(opts.manifest ?? MANIFEST, { status: 200 });
    if (url.includes('gemini-extension.json') && opts.geminiJson) return new Response(opts.geminiJson, { status: 200 });
    if (url.includes('plugin.json') && !url.includes('marketplace.json') && opts.pluginJson) return new Response(opts.pluginJson, { status: 200 });
    if (url.includes('package.json') && opts.packageJson) return new Response(opts.packageJson, { status: 200 });
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
    const parsed = parseClaudeMarketplace(
      JSON.stringify({
        plugins: [
          { source: './skills' },
          { source: 'https://github.com/x/y.git' },
          { source: { source: 'git-subdir', url: 'https://x', path: 'p' } },
          { source: './../escape' },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { dirs } = parsed;
    expect(dirs).toEqual(['skills']);
  });

  it('recognizes the manifest layer, dedupes mirror copies and flags adapters', async () => {
    sandboxHome();
    const entry = { slug: 'ponytail', repo: 'owner/repo', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    const probe = await probeMarketplace(entry, fakeFetch(), { catalog: CLAUDE_CATALOG });
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
    const probe = await probeMarketplace(entry, fakeFetch({ manifest: 'not json', tree: entryTree() }), { catalog: CLAUDE_CATALOG });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    const dirs = probe.snapshot.rows.map((r) => r.dir);
    // `skills/ponytail` beats the deeper `.openclaw/skills/ponytail` mirror; both ponytail-* rows exist once.
    expect(dirs.filter((d) => d.endsWith('/ponytail'))).toEqual(['skills/ponytail']);
    expect(probe.snapshot.manifest).toBeNull();
  });

  it('scopes the probe to the operator-pinned extension layer', async () => {
    sandboxHome();
    const tree = [
      { path: 'pi-extension/package.json', type: 'blob' },
      { path: 'pi-extension/index.js', type: 'blob' },
      // The claude form exists but must not be harvested by a pi-scoped source.
      { path: '.claude-plugin/marketplace.json', type: 'blob' },
    ];
    const entry = {
      slug: 'pony-pi',
      repo: 'owner/repo',
      enabled: true,
      addedAt: 0,
      rescan: { enabled: false, intervalMs: 86_400_000 },
      extensionDir: 'pi-extension',
    };
    const probe = await probeMarketplace(
      entry,
      fakeFetch({ tree, packageJson: JSON.stringify({ name: 'ponytail-pi-extension', description: 'pi form' }) }),
      PI_PROBE_OPTIONS,
    );
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.snapshot.extensionDir).toBe('pi-extension');
    expect(probe.snapshot.manifest).toBeNull();
    expect(probe.snapshot.plugins).toEqual([
      { name: 'ponytail-pi-extension', source: 'pi-extension', description: 'pi form' },
    ]);
    expect(probe.snapshot.rows).toEqual([]);
  });

  it('refuses a pinned layer the repository does not publish', async () => {
    sandboxHome();
    const entry = {
      slug: 'pony-pi',
      repo: 'owner/repo',
      enabled: true,
      addedAt: 0,
      rescan: { enabled: false, intervalMs: 86_400_000 },
      extensionDir: 'pi-extension',
    };
    const probe = await probeMarketplace(entry, fakeFetch());
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.code).toBe('missing_dir');
    expect(probe.message).toMatch(/pi-extension/);
  });

  it('finds the marketplace manifest INSIDE the pinned layer', async () => {
    sandboxHome();
    const entry = {
      slug: 'pony-claude',
      repo: 'owner/repo',
      enabled: true,
      addedAt: 0,
      rescan: { enabled: false, intervalMs: 86_400_000 },
      extensionDir: '.claude-plugin',
    };
    const probe = await probeMarketplace(entry, fakeFetch(), { catalog: CLAUDE_CATALOG });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.snapshot.manifest?.path).toBe('.claude-plugin/marketplace.json');
    expect(probe.snapshot.rows.map((r) => r.dir).sort()).toEqual(['skills/ponytail', 'skills/ponytail-audit']);
  });

  it("reads Codex's .codex-plugin directory as one repo-sourced plugin", async () => {
    sandboxHome();
    const tree = [
      { path: '.codex-plugin/plugin.json', type: 'blob' },
      { path: 'skills/ponytail/SKILL.md', type: 'blob' },
      { path: 'skills/ponytail-audit/SKILL.md', type: 'blob' },
      // A claude catalog in the same repo must NOT be read by a codex-scoped source.
      { path: '.claude-plugin/marketplace.json', type: 'blob' },
    ];
    const entry = {
      slug: 'pony-codex',
      repo: 'owner/repo',
      enabled: true,
      addedAt: 0,
      rescan: { enabled: false, intervalMs: 86_400_000 },
      extensionDir: '.codex-plugin',
    };
    const probe = await probeMarketplace(entry, fakeFetch({ tree }), CODEX_PROBE_OPTIONS);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.snapshot.manifest).toBeNull();
    expect(probe.snapshot.plugins).toEqual([{ name: 'repo', source: '', description: null }]);
    expect(probe.snapshot.authorAdapters).toContain('codex');
    expect(probe.snapshot.rows.map((r) => r.dir).sort()).toEqual(['skills/ponytail', 'skills/ponytail-audit']);
  });

  it("reads Gemini's root gemini-extension.json without any extension layer", async () => {
    sandboxHome();
    const tree = [
      { path: 'gemini-extension.json', type: 'blob' },
      { path: 'skills/ponytail/SKILL.md', type: 'blob' },
      { path: 'skills/ponytail-audit/SKILL.md', type: 'blob' },
    ];
    const entry = { slug: 'pony-gemini', repo: 'owner/repo', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    const probe = await probeMarketplace(
      entry,
      fakeFetch({ tree, geminiJson: JSON.stringify({ name: 'ponytail', description: 'gemini form', contextFileName: 'AGENTS.md' }) }),
      GEMINI_PROBE_OPTIONS,
    );
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.snapshot.plugins).toEqual([{ name: 'ponytail', source: '', description: 'gemini form' }]);
    expect(probe.snapshot.authorAdapters).toContain('gemini-cli');
    expect(probe.snapshot.rows.map((r) => r.dir).sort()).toEqual(['skills/ponytail', 'skills/ponytail-audit']);
  });
  it('treats a harness form directory as the plugin, never its vendor JSON', async () => {
    const cases = [
      ['claude', '.claude-plugin', true],
      ['github-copilot', '.github/plugin', true],
      ['factory', '.factory-plugin', true],
      ['codex', '.codex-plugin', false],
      ['cursor', '.cursor-plugin', false],
      ['kimi', '.kimi-plugin', false],
      ['antigravity', '.antigravity-plugin', false],
    ] as const;
    for (const [harness, dir, hasCatalog] of cases) {
      sandboxHome();
      const tree = [
        { path: `${dir}/plugin.json`, type: 'blob' },
        ...(hasCatalog ? [{ path: `${dir}/marketplace.json`, type: 'blob' }] : []),
        { path: 'skills/ponytail/SKILL.md', type: 'blob' },
      ];
      const entry = { slug: `pony-${harness}`, repo: 'owner/repo', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
      const probe = await probeMarketplace(entry, fakeFetch({ tree }), probeOptionsFor(harness));
      expect(probe.ok).toBe(true);
      if (!probe.ok) return;
      expect(probe.snapshot.extensionDir).toBe(dir);
      if (hasCatalog) {
        // The converged `marketplace.json` is the standard catalog; it names the plugin.
        expect(probe.snapshot.manifest?.name).toBe('ponytail');
        expect(probe.snapshot.plugins.map((p) => p.name)).toEqual(['ponytail']);
      } else {
        // No standard manifest: the directory itself is the plugin and the vendor JSON inside it
        // is deliberately not parsed.
        expect(probe.snapshot.manifest).toBeNull();
        expect(probe.snapshot.plugins).toEqual([{ name: 'repo', source: '', description: null }]);
      }
      expect(probe.snapshot.rows.map((r) => r.dir)).toEqual(['skills/ponytail']);
    }
  });


  it("applies Codex's own layer when the source pins none", async () => {
    sandboxHome();
    const tree = [
      { path: '.codex-plugin/plugin.json', type: 'blob' },
      { path: 'skills/ponytail/SKILL.md', type: 'blob' },
    ];
    const entry = { slug: 'pony-bare', repo: 'owner/repo', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    const probe = await probeMarketplace(entry, fakeFetch({ tree }), probeOptionsFor('codex'));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.snapshot.extensionDir).toBe('.codex-plugin');
    expect(probe.snapshot.plugins).toEqual([{ name: 'repo', source: '', description: null }]);
    expect(probe.snapshot.rows.map((r) => r.dir)).toEqual(['skills/ponytail']);
  });

  it('falls back to the SKILL.md tree when the default layer is not published', async () => {
    sandboxHome();
    const tree = [{ path: 'skills/ponytail/SKILL.md', type: 'blob' }];
    const entry = { slug: 'pony-plain', repo: 'owner/repo', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } };
    const probe = await probeMarketplace(entry, fakeFetch({ tree }), probeOptionsFor('codex'));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.snapshot.extensionDir).toBeNull();
    expect(probe.snapshot.plugins).toEqual([]);
    expect(probe.snapshot.rows.map((r) => r.dir)).toEqual(['skills/ponytail']);
  });
});

describe('extension-dir grammar + slug derivation', () => {
  it('normalizes repo-relative layers and refuses escapes', () => {
    expect(normalizeExtensionDir('./pi-extension/')).toBe('pi-extension');
    expect(normalizeExtensionDir('')).toBeNull();
    expect(normalizeExtensionDir('../x')).toMatchObject({ error: expect.stringContaining('invalid') });
    expect(normalizeExtensionDir('/abs')).toMatchObject({ error: expect.stringContaining('repository-relative') });
  });

  it('accepts every operator spelling of a GitHub repository, and only those', () => {
    for (const input of [
      'acme/plugins',
      'acme/plugins.git',
      'github.com/acme/plugins',
      'https://github.com/acme/plugins',
      'https://github.com/acme/plugins.git',
      'https://github.com/acme/plugins/',
      'https://www.github.com/acme/plugins?tab=readme-ov-file',
      'git@github.com:acme/plugins.git',
      'github:acme/plugins',
    ]) {
      expect(githubRepoFromInput(input)).toBe('acme/plugins');
    }
    // A path below the repo is a layer, not a repo: refused instead of silently widened.
    for (const input of ['https://github.com/acme/plugins/tree/main/x', 'acme/plugins/x', 'https://gitlab.com/acme/plugins', '', 'plugins']) {
      expect(githubRepoFromInput(input)).toBeNull();
    }
  });

  it('lets one repository register two harness layers under distinct slugs', async () => {
    sandboxHome();
    const fetchImpl = fakeFetch({
      tree: [
        { path: 'pi-extension/package.json', type: 'blob' },
        { path: '.claude-plugin/marketplace.json', type: 'blob' },
        { path: 'skills/ponytail/SKILL.md', type: 'blob' },
      ],
      packageJson: JSON.stringify({ name: 'repo-pi-extension' }),
    });
    const pi = createPluginAdapter('pi', fetchImpl, { custom: true });
    const claude = createPluginAdapter('claude', fetchImpl, { custom: true });
    expect((await pi.registerSource('https://github.com/owner/repo', { extensionDir: 'pi-extension' })).ok).toBe(true);
    // The pi-pinned source landed in pi's index ONLY.
    expect(readIndex('pi').map((r) => r.key)).toEqual(['mp-repo:owner/repo#pi-extension']);
    expect(readIndex('claude')).toEqual([]);
    const other = await claude.registerSource('https://github.com/owner/repo', { extensionDir: '.claude-plugin' });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.message).toContain('mp-repo-claude-plugin');
    expect(listMarketplaceEntries().map((e) => e.slug).sort()).toEqual(['repo', 'repo-claude-plugin']);
    // Re-registering the SAME layer is a conflict, never a twin.
    expect((await claude.registerSource('https://github.com/owner/repo', { extensionDir: '.claude-plugin' })).ok).toBe(false);
    // Each catalog carries only its own layer.
    expect(readIndex('claude').map((r) => r.key)).toEqual(['mp-repo-claude-plugin:owner/repo#skills']);
  });
  it('each harness claims only its own marketplace directory', async () => {
    sandboxHome();
    const treeOf = (dir: string) => [
      { path: `${dir}/marketplace.json`, type: 'blob' },
      { path: 'skills/ponytail/SKILL.md', type: 'blob' },
    ];
    const entryFor = (slug: string) => ({ slug, repo: 'owner/repo', enabled: true, addedAt: 0, rescan: { enabled: false, intervalMs: 86_400_000 } });

    const grokTree = fakeFetch({ tree: treeOf('.grok-plugin') });
    // Claude does NOT read grok's directory...
    const claude = await probeMarketplace(entryFor('c'), grokTree, { catalog: CLAUDE_CATALOG });
    expect(claude.ok).toBe(true);
    if (!claude.ok) return;
    expect(claude.snapshot.manifest).toBeNull();
    expect(claude.snapshot.plugins).toEqual([]);
    // ...grok does.
    const grok = await probeMarketplace(entryFor('g'), grokTree, GROK_PROBE_OPTIONS);
    expect(grok.ok).toBe(true);
    if (!grok.ok) return;
    expect(grok.snapshot.manifest?.path).toBe('.grok-plugin/marketplace.json');
    expect(grok.snapshot.plugins).toHaveLength(1);

    const copilot = await probeMarketplace(entryFor('cp'), fakeFetch({ tree: treeOf('.github/plugin') }), COPILOT_PROBE_OPTIONS);
    expect(copilot.ok && copilot.snapshot.manifest?.path).toBe('.github/plugin/marketplace.json');
    const universal = await probeMarketplace(entryFor('u'), fakeFetch({ tree: treeOf('.agents/plugins') }), UNIVERSAL_PROBE_OPTIONS);
    expect(universal.ok && universal.snapshot.manifest?.path).toBe('.agents/plugins/marketplace.json');
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
    updateMarketplaceEntry('off', { enabled: false });
    expect(getAdapter('mp-off')).toBeUndefined();
  });
});

describe('marketplace browse over snapshots', () => {
  it('answers rows from the latest snapshot with local filter and paging', async () => {
    sandboxHome();
    addMarketplaceEntry({ slug: 'pony', repo: 'owner/repo' });
    const entry = getMarketplaceEntry('pony')!;
    await probeMarketplace(entry, fakeFetch(), { catalog: CLAUDE_CATALOG });
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
      url: '/api/admin/harness/plugins/claude/sources',
      payload: { url: 'https://github.com/owner/repo' },
    });
    expect(added.statusCode).toBe(200);

    // Duplicate slug conflicts.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/claude/sources',
      payload: { url: 'https://github.com/owner/repo' },
    });
    expect(dup.statusCode).toBe(409);

    // Bad target refused.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/claude/sources',
      payload: { url: 'https://gitlab.com/x/y' },
    });
    expect(bad.statusCode).toBe(400);

    // Kind isolation: the plugin-kind query only lists sources whose snapshot carries plugins.
    const pluginView = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources?kind=plugin' })).body,
    ) as { sources: { id: string }[]; operator: { slug: string; kinds: string[] }[] };
    expect(pluginView.sources.some((s) => s.id === 'pi-dev')).toBe(false); // pi-dev belongs to pi, not claude
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
    expect(sources.sources.some((s) => s.id === 'pi-dev')).toBe(false);
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
    const patchOff = await app.inject({ method: 'PATCH', url: '/api/admin/harness/plugins/claude/sources/repo', payload: { enabled: false } });
    expect(patchOff.statusCode).toBe(200);
    const sourcesOff = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources' })).body,
    ) as { operator: { slug: string; enabled: boolean }[] };
    expect(sourcesOff.operator.every((e) => !(e.slug === 'repo' && e.enabled))).toBe(true);

    // Manual rescan: no change since the add-time probe — empty diff, rows reported.
    const rescan = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/admin/harness/plugins/claude/sources/repo/rescan' })).body,
    ) as { status: string; diff: { added: string[]; removed: string[] }; rows: number };
    expect(rescan.diff.added).toEqual([]);
    expect(rescan.diff.removed).toEqual([]);
    expect(rescan.rows).toBe(2);

    // Snapshot history is summarized, never a raw dump.
    const snaps = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources/repo/snapshots' })).body,
    ) as { snapshots: { rows: number; sha: string }[] };
    expect(snaps.snapshots.length).toBeGreaterThanOrEqual(1);

    // Re-enable restores the view.
    const patchOn = await app.inject({ method: 'PATCH', url: '/api/admin/harness/plugins/claude/sources/repo', payload: { enabled: true } });
    expect(patchOn.statusCode).toBe(200);
    const sourcesOn = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources' })).body,
    ) as { operator: { slug: string; enabled: boolean }[] };
    expect(sourcesOn.operator.some((e) => e.slug === 'repo' && e.enabled)).toBe(true);

    // Remove cleans the shared store.
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/harness/plugins/claude/sources/repo' });
    expect(del.statusCode).toBe(200);
    expect(listMarketplaceEntries()).toEqual([]);
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

  it('advertises the harness layer and stores a per-source extension dir', async () => {
    sandboxHome();
    const app = fastify();
    const fetchImpl = fakeFetch({
      tree: [{ path: 'pi-extension/package.json', type: 'blob' }],
      packageJson: JSON.stringify({ name: 'owner-pi-extension' }),
    });
    registerHarnessRoutes(app, { marketplaceFetch: fetchImpl });

    const claude = JSON.parse((await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources' })).body) as { extensionDir: string | null };
    expect(claude.extensionDir).toBe('.claude-plugin');
    const pi = JSON.parse((await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/pi/sources' })).body) as { extensionDir: string | null };
    expect(pi.extensionDir).toBe('pi-extension');

    const missing = JSON.parse(
      (await app.inject({
        method: 'POST',
        url: '/api/admin/harness/plugins/pi/sources/check',
        payload: { url: 'https://github.com/owner/repo', extensionDir: 'nope' },
      })).body,
    ) as { ok: boolean; message: string };
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/no 'nope' directory/);

    const added = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/plugins/pi/sources',
      payload: { url: 'https://github.com/owner/repo', extensionDir: 'pi-extension' },
    });
    expect(added.statusCode).toBe(200);
    const view = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/pi/sources?kind=plugin' })).body,
    ) as { operator: { slug: string; extensionDir: string | null; harness?: string | null }[] };
    const entry = view.operator.find((e) => e.slug === 'repo');
    expect(entry?.extensionDir).toBe('pi-extension');
    expect(entry?.harness).toBe('pi');
  });
});

describe('global skill source routes', () => {
  it('registers a skills-only repository WITHOUT a harness and keeps it off the plugin axis', async () => {
    sandboxHome();
    const app = fastify();
    registerHarnessRoutes(app, {
      marketplaceFetch: fakeFetch({ tree: [{ path: 'skills/pony/SKILL.md', type: 'blob' }] }),
    });

    const check = JSON.parse(
      (await app.inject({
        method: 'POST',
        url: '/api/admin/harness/skills/sources/check',
        payload: { url: 'https://github.com/owner/repo' },
      })).body,
    ) as { ok: boolean; skills: number };
    expect(check.ok).toBe(true);
    expect(check.skills).toBeGreaterThan(0);

    const added = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/skills/sources',
      payload: { url: 'https://github.com/owner/repo' },
    });
    expect(added.statusCode).toBe(200);
    // GLOBAL means no harness scope on the stored entry — every harness page sees it.
    expect(getMarketplaceEntry('repo')?.harness).toBeUndefined();

    const view = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/skills/sources' })).body,
    ) as { sources: { id: string }[]; operator: { slug: string; kinds: string[] }[] };
    expect(view.sources.some((s) => s.id === 'clawhub')).toBe(true);
    expect(view.operator.some((e) => e.slug === 'repo' && e.kinds.includes('skill'))).toBe(true);

    // The plugin axis never lists it: the repository publishes no plugin row.
    const pluginView = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/admin/harness/plugins/claude/sources?kind=plugin' })).body,
    ) as { operator: { slug: string }[] };
    expect(pluginView.operator.some((e) => e.slug === 'repo')).toBe(false);

    // A second registration of the same repository is a conflict, not a second identity.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/skills/sources',
      payload: { url: 'https://github.com/owner/repo' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('takes the bare owner/repo form the operator pasted, not only an https URL', async () => {
    sandboxHome();
    const app = fastify();
    registerHarnessRoutes(app, {
      marketplaceFetch: fakeFetch({ tree: [{ path: 'skills/pony/SKILL.md', type: 'blob' }] }),
    });

    const check = JSON.parse(
      (await app.inject({
        method: 'POST',
        url: '/api/admin/harness/skills/sources/check',
        payload: { url: 'owner/repo' },
      })).body,
    ) as { ok: boolean; skills: number };
    expect(check.ok).toBe(true);
    expect(check.skills).toBeGreaterThan(0);

    const added = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/skills/sources',
      payload: { url: 'github.com/owner/repo.git' },
    });
    expect(added.statusCode).toBe(200);
    expect(getMarketplaceEntry('repo')?.repo).toBe('owner/repo');
  });
});

describe('removeMarketplaceEntry keeps foreign entries', () => {
  it('removes only the named slug', () => {
    sandboxHome();
    addMarketplaceEntry({ slug: 'a', repo: 'o/a' });
    addMarketplaceEntry({ slug: 'b', repo: 'o/b' });
    expect(removeMarketplaceEntry('a')).toBe(true);
    expect(listMarketplaceEntries().map((e) => e.slug)).toEqual(['b']);
    expect(removeMarketplaceEntry('a')).toBe(false);
  });
});

describe('rowsForScope', () => {
  it('narrows to the scope and dedupes by basename, shortest path first', async () => {
    const rows = await rowsForScope('owner/repo', SHA, ['skills'], entryTree() as import('../src/harness/tree.js').TreeEntry[], fakeFetch());
    expect(rows.map((r) => r.dir).sort()).toEqual(['skills/ponytail', 'skills/ponytail-audit']);
  });
});

describe("harness isolation: pi and claude maintain sources independently", () => {
  it("keeps pi and claude plugin sources isolated in list, catalog harvest and delete", async () => {
    sandboxHome();
    const app = fastify();
    registerHarnessRoutes(app, { marketplaceFetch: fakeFetch({ tree: [...entryTree(), { path: 'pi-extension/package.json', type: 'blob' }], packageJson: JSON.stringify({ name: 'owner-pi-extension' }) }) });

    // Register a source for claude
    const addClaude = await app.inject({
      method: "POST",
      url: "/api/admin/harness/plugins/claude/sources",
      payload: { url: "https://github.com/owner/repo" },
    });
    expect(addClaude.statusCode).toBe(200);

    // Register an npm source for pi
    const addPi = await app.inject({
      method: "POST",
      url: "/api/admin/harness/plugins/pi/sources",
      payload: { url: "https://github.com/owner/repo", extensionDir: "pi-extension" },
    });
    expect(addPi.statusCode).toBe(200);

    // Claude sources list only includes claude entry
    const claudeView = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/admin/harness/plugins/claude/sources?kind=plugin" })).body,
    ) as { operator: { slug: string; harness?: string }[] };
    expect(claudeView.operator.some((e) => e.slug === "repo")).toBe(true);
    expect(claudeView.operator.every((e) => !e.harness || e.harness === "claude")).toBe(true);

    // Pi sources list only includes pi entry
    const piView = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/admin/harness/plugins/pi/sources?kind=plugin" })).body,
    ) as { operator: { slug: string; harness?: string }[] };
    expect(piView.operator.some((e) => e.slug === "repo-pi-extension")).toBe(true);
    expect(piView.operator.every((e) => !e.harness || e.harness === "pi")).toBe(true);

    // Delete pi source does not delete claude source
    const delPi = await app.inject({
      method: "DELETE",
      url: "/api/admin/harness/plugins/pi/sources/repo-pi-extension",
    });
    expect(delPi.statusCode).toBe(200);

    const claudeAfter = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/admin/harness/plugins/claude/sources?kind=plugin" })).body,
    ) as { operator: { slug: string }[] };
    expect(claudeAfter.operator.some((e) => e.slug === "repo")).toBe(true);
  });
});
