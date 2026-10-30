import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import {
  discoverPlugins,
  pluginSources,
  parsePluginSpec,
  type DiscoveryDeps,
  type ExtSource,
} from '../src/harness/host/discover.js';
import { claudeAdapter } from '../src/harness/host/adapters/claude.js';
import { isPluginHost } from '../src/harness/host/adapters/index.js';
import { planPlugin } from '../src/harness/host/writers/plugin.js';

/**
 * The claude plugin landing (ADR-0015 §D8.11).
 *
 * Claude Code installs plugins through its own CLI (`claude plugin install <id> --scope user`),
 * which records them in `~/.claude/plugins/installed_plugins.json` as an object MAP keyed by the
 * plugin id (`"<name>@<marketplace>"`). The landing rules under test: the MAP shape is read with a
 * `claude:` spec prefix (a bare id would parse as a versioned npm spec), rows answer version and
 * description from the entry's own value, the removal inverse is a `drop-server` member drop, and
 * the install plan echoes the runtime's own argument grammar verbatim.
 */

const INSTALLED = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

const claudeSource: ExtSource = {
  host: 'claude',
  scope: 'global',
  origin: 'runtime-store',
  kind: 'declared',
  path: INSTALLED,
  key: 'plugins',
  containerShape: 'map',
  specPrefix: 'claude:',
};

function deps(files: Record<string, unknown>): DiscoveryDeps {
  return {
    exists: (p: string) => p in files,
    readJson: (p: string) => files[p],
    readDir: () => [],
    isDir: () => false,
    readTextHead: () => null,
  };
}

const STORE = {
  version: 1,
  plugins: {
    'changelog@claude-plugins-official': {
      version: '1.2.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      installPath: path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'changelog'),
    },
  },
};

const PLUGIN_MANIFEST = { description: 'Show the changelog of a project' };

describe('claude adapter — the landing capability', () => {
  it('is an PluginHost whose write target is a subprocess, never a config merge', () => {
    expect(isPluginHost(claudeAdapter)).toBe(true);
    const landing = claudeAdapter.writeTarget!({ projectRoot: '/tmp' }, 'global');
    expect(landing).toMatchObject({ ok: true, op: 'subprocess', command: 'claude' });
  });

  it('reads only the runtime store — one GLOBAL record, asked from either scope', () => {
    const sources = claudeAdapter.readSources!({ projectRoot: '/tmp' }, 'global');
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ host: 'claude', scope: 'global', kind: 'declared', containerShape: 'map', specPrefix: 'claude:' });
    // The store has no project scope (the pi rule): a project-scope ask still answers the same
    // global record, never a project-flavored path that does not exist.
    const project = claudeAdapter.readSources!({ projectRoot: '/tmp' }, 'project');
    expect(project).toHaveLength(1);
    expect(project[0]!.scope).toBe('global');
  });

  it('pluginSources carries the claude store in catalog context', () => {
    const claude = pluginSources('/tmp').filter((s) => s.host === 'claude');
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.every((s) => s.containerShape === 'map' && s.specPrefix === 'claude:')).toBe(true);
  });
});

describe('claude spec grammar — the `claude:` prefix', () => {
  it('parses a plugin id without mistaking the marketplace for an npm version', () => {
    expect(parsePluginSpec('claude:changelog@claude-plugins-official')).toEqual({
      canonicalKey: 'claude:changelog@claude-plugins-official',
      name: 'changelog',
    });
  });

  it('refuses ids that are not claude plugin ids (paths, bare names, multi-@)', () => {
    expect(parsePluginSpec('claude:just-a-name')).toBeNull();
    expect(parsePluginSpec('claude:/abs/path')).toBeNull();
    expect(parsePluginSpec('claude:a@b@c')).toBeNull();
    expect(parsePluginSpec('claude:')).toBeNull();
  });
});

describe('claude discovery — the MAP-shaped runtime store', () => {
  it('reads one row per plugin, namespaced and answered from the entry value', () => {
    const rows = discoverPlugins([claudeSource], {
      deps: deps({
        [INSTALLED]: STORE,
        [path.join(STORE.plugins['changelog@claude-plugins-official'].installPath, '.claude-plugin', 'plugin.json')]: PLUGIN_MANIFEST,
      }),
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe('changelog');
    expect(row.canonicalKey).toBe('claude:changelog@claude-plugins-official');
    expect(row.version).toBe('1.2.0');
    expect(row.description).toBe('Show the changelog of a project');
    expect(row.copies[0]).toMatchObject({ host: 'claude', external: true, state: 'untracked' });
  });

  it('the removal inverse is a drop-server member drop of the runtime key (no prefix)', () => {
    const rows = discoverPlugins([claudeSource], { deps: deps({ [INSTALLED]: STORE }) });
    expect(rows[0]!.removal).toEqual({
      op: 'drop-server',
      file: INSTALLED,
      container: 'plugins',
      entry: 'changelog@claude-plugins-official',
    });
  });

  it('answers no rows for a broken store, never throws', () => {
    expect(discoverPlugins([claudeSource], { deps: deps({ [INSTALLED]: 'not json' as unknown }) })).toEqual([]);
    expect(discoverPlugins([claudeSource], { deps: deps({}) })).toEqual([]);
  });
});

describe('claude install plan — the runtime argument grammar, echoed verbatim', () => {
  it('plans `claude plugin install <id> --scope user` for global scope', () => {
    const plan = planPlugin({
      sourceId: 'npm',
      canonicalKey: 'claude:changelog@claude-plugins-official',
      spec: 'changelog@claude-plugins-official',
      trust: 'community',
      harness: 'claude',
      scope: 'global',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const target = plan.targets[0]!;
    expect(target.op).toBe('subprocess');
    expect(target.command).toBe('claude');
    expect(target.args).toEqual(['plugin', 'install', 'changelog@claude-plugins-official', '--scope', 'user']);
    expect(target.echo).toBe('claude plugin install changelog@claude-plugins-official --scope user');
  });

  it('plans `--scope project` for project scope', () => {
    const plan = planPlugin({
      sourceId: 'npm',
      canonicalKey: 'claude:changelog@claude-plugins-official',
      spec: 'changelog@claude-plugins-official',
      trust: 'community',
      harness: 'claude',
      scope: 'project',
    });
    if (!plan.ok) return;
    expect(plan.targets[0]!.args).toEqual(['plugin', 'install', 'changelog@claude-plugins-official', '--scope', 'project']);
  });

  it('refuses a shell-shaped spec before any command is composed', () => {
    const plan = planPlugin({
      sourceId: 'npm',
      canonicalKey: 'claude:x',
      spec: '--flag; rm -rf /',
      trust: 'community',
      harness: 'claude',
      scope: 'global',
    });
    expect(plan).toMatchObject({ ok: false, code: 'bad_request' });
  });
});
