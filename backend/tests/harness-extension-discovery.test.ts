import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import {
  discoverExtensions,
  extensionSources,
  parseExtensionSpec,
  trackedKey,
  type DiscoveryDeps,
  type ExtSource,
} from '../src/harness/discover.js';
import { scanInventory } from '../src/harness/inventory.js';
import { HOST_ADAPTERS } from '../src/harness/adapters/index.js';
import { opencodeAdapter } from '../src/harness/adapters/opencode.js';
import { HOSTS } from '../src/harness/hosts.js';

/**
 * Extension discovery (ADR-0015 §D8.10) — the read-only observation layer.
 *
 * The rules under test are the ones that keep observation from becoming ownership: a row is
 * `untracked` + `external` (identity token, never a path we stat), a manifest-tracked
 * `(harness, canonicalKey)` is excluded, a broken store answers "no rows" instead of throwing, and
 * the landing a config-array source reads is the SAME file the writer merges into.
 *
 * All IO is injected, so these cases assert the scanner's decisions without a fake HOME: the host
 * catalog resolves absolute paths at import time, which a test cannot re-point.
 */

function deps(overrides: Partial<DiscoveryDeps> & { files?: Record<string, unknown>; dirs?: Record<string, string[]> }): DiscoveryDeps {
  const files = overrides.files ?? {};
  const dirs = overrides.dirs ?? {};
  return {
    exists: overrides.exists ?? ((p: string) => p in files || p in dirs),
    readJson: overrides.readJson ?? ((p: string) => files[p]),
    readDir: overrides.readDir ?? ((p: string) => dirs[p] ?? []),
    isDir: overrides.isDir ?? ((p: string) => p in dirs),
    // The `files` map doubles as file CONTENT: a string value is text a local row reads its header from.
    readTextHead: overrides.readTextHead ?? ((p: string) => (typeof files[p] === 'string' ? (files[p] as string) : null)),
  };
}

const PI_SETTINGS = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
const PI_LOCK = path.join(os.homedir(), '.pi', 'agent', 'npm', 'package-lock.json');
const PI_EXT_DIR = path.join(os.homedir(), '.pi', 'agent', 'extensions');

const piDeclaredSource: ExtSource = {
  host: 'pi',
  scope: 'global',
  origin: 'runtime-store',
  kind: 'declared',
  path: PI_SETTINGS,
  key: 'packages',
  lockPath: PI_LOCK,
};

describe('parseExtensionSpec — the spec grammars a runtime store actually carries', () => {
  it('reads `npm:` specs with and without a version', () => {
    expect(parseExtensionSpec('npm:pi-adaptive-thinking')).toEqual({
      canonicalKey: 'npm:pi-adaptive-thinking',
      name: 'pi-adaptive-thinking',
    });
    expect(parseExtensionSpec('npm:@juicesharp/rpiv-todo@2.13.9')).toEqual({
      canonicalKey: 'npm:@juicesharp/rpiv-todo',
      name: '@juicesharp/rpiv-todo',
      version: '2.13.9',
    });
  });

  it('reads `git:` specs — a package with no npm identity at all', () => {
    expect(parseExtensionSpec('git:github.com/NVlabs/SoL-Pi')).toEqual({
      canonicalKey: 'git:github.com/NVlabs/SoL-Pi',
      name: 'SoL-Pi',
    });
  });

  it('treats a bare name as an npm package (opencode accepts `plugin[]` entries unprefixed)', () => {
    expect(parseExtensionSpec('@opencode-ai/plugin-example')).toEqual({
      canonicalKey: 'npm:@opencode-ai/plugin-example',
      name: '@opencode-ai/plugin-example',
    });
  });

  it('keeps a path-shaped entry as a real location, not a package identity', () => {
    const parsed = parseExtensionSpec('./local/plugin.ts');
    expect(parsed?.canonicalKey).toBe(`file:${path.resolve('./local/plugin.ts')}`);
    expect(parsed?.local).toBe(path.resolve('./local/plugin.ts'));
    expect(parsed?.name).toBe('plugin');
  });

  it('refuses empty and shell-shaped specs', () => {
    expect(parseExtensionSpec('   ')).toBeNull();
    expect(parseExtensionSpec('pkg; rm -rf /')).toBeNull();
    expect(parseExtensionSpec('npm:')).toBeNull();
  });
});

describe('discoverExtensions — declared store (pi)', () => {
  const settings = {
    packages: ['npm:pi-powerline-footer', 'npm:@juicesharp/rpiv-todo', 'git:github.com/NVlabs/SoL-Pi'],
  };
  const lock = {
    packages: {
      '': { name: 'pi-extensions' },
      'node_modules/pi-powerline-footer': { version: '0.20.2' },
      'node_modules/@juicesharp/rpiv-todo': { version: '2.13.9' },
      'node_modules/rpiv-todo/node_modules/some-dep': { version: '9.9.9' },
    },
  };

  it('answers one row per declared package, with the version its lock file pins', () => {
    const rows = discoverExtensions([piDeclaredSource], {
      deps: deps({ files: { [PI_SETTINGS]: settings, [PI_LOCK]: lock } }),
    });
    // Sorted by name: SoL-Pi, @juicesharp/rpiv-todo sorts by localeCompare on the full name.
    expect(rows).toHaveLength(3);
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get('pi-powerline-footer')?.version).toBe('0.20.2');
    expect(byName.get('@juicesharp/rpiv-todo')?.version).toBe('2.13.9');
    // A git-sourced package has no lock entry — a missing version is absent, never invented.
    expect(byName.get('SoL-Pi')?.version).toBeUndefined();
    // A transitive install is not a declared package.
    expect(byName.has('some-dep')).toBe(false);
  });

  it('marks every package row untracked + external, with an identity token instead of a path', () => {
    const rows = discoverExtensions([piDeclaredSource], {
      deps: deps({ files: { [PI_SETTINGS]: settings, [PI_LOCK]: lock } }),
    });
    const row = rows.find((r) => r.name === 'pi-powerline-footer')!;
    expect(row.kind).toBe('extension');
    expect(row.harness).toBe('pi');
    expect(row.origin).toBe('runtime-store');
    expect(row.observedFrom).toBe(PI_SETTINGS);
    expect(row.canonicalKey).toBe('npm:pi-powerline-footer');
    const copy = row.copies[0]!;
    expect(copy.state).toBe('untracked');
    expect(copy.external).toBe(true);
    // The token is not a filesystem path: stat-ing it would report a phantom `missing` copy.
    expect(copy.path).toBe('npm:pi-powerline-footer#pi');
    // Removable through the runtime's OWN record: the descriptor names the exact file and container
    // the scan read, so the console never has to guess (or invent a package-manager command).
    expect(row.removal).toEqual({ op: 'drop-entry', file: PI_SETTINGS, container: 'packages', entry: 'npm:pi-powerline-footer' });
  });

  it('excludes a package the manifest already tracks for the same harness', () => {
    const rows = discoverExtensions([piDeclaredSource], {
      tracked: [trackedKey('pi', 'npm:pi-powerline-footer')],
      deps: deps({ files: { [PI_SETTINGS]: settings, [PI_LOCK]: lock } }),
    });
    expect(rows.map((r) => r.name)).not.toContain('pi-powerline-footer');
    expect(rows).toHaveLength(2);
  });

  it('does not exclude the same package tracked for a DIFFERENT harness', () => {
    const rows = discoverExtensions([piDeclaredSource], {
      tracked: [trackedKey('opencode', 'npm:pi-powerline-footer')],
      deps: deps({ files: { [PI_SETTINGS]: settings, [PI_LOCK]: lock } }),
    });
    expect(rows.map((r) => r.name)).toContain('pi-powerline-footer');
  });

  it('answers no rows for a half-written or hand-broken store, and never throws', () => {
    const rows = discoverExtensions([piDeclaredSource], {
      deps: deps({
        exists: () => true,
        readJson: () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }),
    });
    expect(rows).toEqual([]);
  });

  it('answers no rows when the store file is absent', () => {
    expect(discoverExtensions([piDeclaredSource], { deps: deps({}) })).toEqual([]);
  });

  it('ignores a declaration that is not an array of strings', () => {
    const rows = discoverExtensions([piDeclaredSource], {
      deps: deps({ files: { [PI_SETTINGS]: { packages: { 'npm:x': true } } } }),
    });
    expect(rows).toEqual([]);
  });
});

describe('discoverExtensions — loose extension files (pi extensions/)', () => {
  const source: ExtSource = {
    host: 'pi',
    scope: 'global',
    origin: 'local-file',
    kind: 'loose-dir',
    path: PI_EXT_DIR,
  };

  it('lists loadable files only, as real paths, and keeps the version absent', () => {
    const rows = discoverExtensions([source], {
      deps: deps({ dirs: { [PI_EXT_DIR]: ['orca-prefill.ts', 'context-monitor.ts', 'README.md', '.hidden.ts'] } }),
    });
    expect(rows.map((r) => r.name).sort()).toEqual(['context-monitor', 'orca-prefill']);
    const row = rows.find((r) => r.name === 'orca-prefill')!;
    expect(row.origin).toBe('local-file');
    expect(row.version).toBeUndefined();
    const copy = row.copies[0]!;
    // A loose file IS a location: it is materialized content this runtime loads directly.
    expect(copy.external).toBeUndefined();
    expect(copy.path).toBe(path.join(PI_EXT_DIR, 'orca-prefill.ts'));
    expect(copy.placement).toBe('materialized');
  });

  it('answers no rows when the directory is absent', () => {
    expect(discoverExtensions([source], { deps: deps({}) })).toEqual([]);
  });
});

describe('discoverExtensions — a LOCAL row describes itself from disk', () => {
  const dir = path.join(os.tmpdir(), 'ocr-ext-local');
  const looseDir: ExtSource = {
    host: 'opencode',
    scope: 'global',
    origin: 'local-file',
    kind: 'loose-dir',
    path: dir,
  };

  it('reads a loose file header comment, first paragraph only', () => {
    const file = path.join(dir, 'tool-compress.ts');
    const rows = discoverExtensions([looseDir], {
      deps: deps({
        dirs: { [dir]: ['tool-compress.ts'] },
        files: {
          [file]: [
            '/**',
            ' * tool-compress (v2) — compress native tool descriptions.',
            ' *',
            ' * opencode ships ~6k tokens of prose; this paragraph is not the card line.',
            ' */',
            'import type { Plugin } from "@opencode/plugin"',
          ].join('\n'),
        },
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe('tool-compress (v2) — compress native tool descriptions.');
  });

  it('answers null when the file carries no header comment — nothing is invented', () => {
    const file = path.join(dir, 'plain.ts');
    const rows = discoverExtensions([looseDir], {
      deps: deps({ dirs: { [dir]: ['plain.ts'] }, files: { [file]: 'export default {}\n' } }),
    });
    expect(rows[0]!.description).toBeNull();
  });

  it('reads a package.json description when the entry names a plugin DIRECTORY', () => {
    const abs = path.resolve('./local-plugin-dir');
    const configFile = path.join(os.tmpdir(), 'ocr-test-opencode-local.json');
    const source: ExtSource = {
      host: 'opencode',
      scope: 'global',
      origin: 'config-array',
      kind: 'config-array',
      path: configFile,
      key: 'plugin',
    };
    const rows = discoverExtensions([source], {
      deps: deps({
        files: {
          [configFile]: { plugin: [abs] },
          [path.join(abs, 'package.json')]: { description: 'Local plugin bundle' },
        },
        dirs: { [abs]: [] },
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe('Local plugin bundle');
  });
});

describe('discoverExtensions — config array (opencode plugin[])', () => {
  const file = path.join(os.tmpdir(), 'ocr-test-opencode.json');
  const source: ExtSource = {
    host: 'opencode',
    scope: 'global',
    origin: 'config-array',
    kind: 'config-array',
    path: file,
    key: 'plugin',
  };

  it('reads plugin[] entries: bare names are packages, paths are locations', () => {
    const rows = discoverExtensions([source], {
      deps: deps({
        files: { [file]: { plugin: ['@opencode-ai/plugin-example', 'npm:opencode-plugin-x@1.2.3', './plugin.ts'], model: 'kimi' } },
      }),
    });
    expect(rows).toHaveLength(3);
    const pkg = rows.find((r) => r.name === '@opencode-ai/plugin-example')!;
    expect(pkg.canonicalKey).toBe('npm:@opencode-ai/plugin-example');
    expect(pkg.copies[0]!.external).toBe(true);
    expect(rows.find((r) => r.name === 'opencode-plugin-x')?.version).toBe('1.2.3');
    const local = rows.find((r) => r.name === 'plugin')!;
    expect(local.copies[0]!.path).toBe(path.resolve('./plugin.ts'));
    expect(local.copies[0]!.external).toBeUndefined();
  });

  it('tolerates a config with no plugin[] container at all', () => {
    const rows = discoverExtensions([source], { deps: deps({ files: { [file]: { model: 'kimi' } } }) });
    expect(rows).toEqual([]);
  });
});

describe('discoverExtensions — real filesystem (no injected IO)', () => {
  it('reads a config array and a loose directory from disk, tolerating a broken file', async () => {
    const fs = await import('node:fs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-discover-'));
    const configFile = path.join(root, 'opencode.json');
    const extDir = path.join(root, 'extensions');
    fs.mkdirSync(extDir);
    fs.writeFileSync(configFile, JSON.stringify({ plugin: ['some-plugin@2.0.0'] }), 'utf8');
    fs.writeFileSync(path.join(extDir, 'local-thing.ts'), 'export default {}', 'utf8');
    fs.writeFileSync(path.join(extDir, 'broken-HALF'), 'x', 'utf8');
    const broken = path.join(root, 'settings.json');
    fs.writeFileSync(broken, '{ "packages": [', 'utf8');

    const sources: ExtSource[] = [
      { host: 'opencode', scope: 'global', origin: 'config-array', kind: 'config-array', path: configFile, key: 'plugin' },
      { host: 'pi', scope: 'global', origin: 'local-file', kind: 'loose-dir', path: extDir },
      { host: 'pi', scope: 'global', origin: 'runtime-store', kind: 'declared', path: broken, key: 'packages' },
    ];
    const rows = discoverExtensions(sources);
    expect(rows.map((r) => r.name).sort()).toEqual(['local-thing', 'some-plugin']);
    expect(rows.find((r) => r.name === 'some-plugin')?.version).toBe('2.0.0');
  });
});

describe('extensionSources — the host adapters are the only landing table', () => {
  const sources = extensionSources(process.cwd());

  it('registers exactly one adapter per catalog host, in catalog order', () => {
    expect(HOST_ADAPTERS.map((a) => a.id)).toEqual(HOSTS.map((h) => h.id));
  });

  it('reads pi through its own declaration file, lock file and loose directory', () => {
    const pi = sources.filter((s) => s.host === 'pi');
    expect(pi.map((s) => s.kind).sort()).toEqual(['declared', 'loose-dir']);
    const declared = pi.find((s) => s.kind === 'declared')!;
    expect(declared.key).toBe('packages');
    expect(declared.path).toBe(PI_SETTINGS);
    expect(declared.lockPath).toBe(PI_LOCK);
    expect(pi.find((s) => s.kind === 'loose-dir')!.path).toBe(PI_EXT_DIR);
  });

  it('reads opencode through BOTH major-version spellings, in both scopes', () => {
    const opencode = sources.filter((s) => s.host === 'opencode');
    const configs = opencode.filter((s) => s.kind === 'config-array');
    const loose = opencode.filter((s) => s.kind === 'loose-dir');

    // v2 `opencode.jsonc` and v1 `opencode.json` are both read — a machine that migrated mid-major
    // still reports what it actually loads.
    const files = configs.map((s) => s.path);
    expect(files.some((p) => p.endsWith('opencode.jsonc'))).toBe(true);
    expect(files.some((p) => p.endsWith('opencode.json'))).toBe(true);
    expect(configs.some((s) => s.scope === 'global')).toBe(true);
    expect(configs.some((s) => s.scope === 'project')).toBe(true);
    // Both container spellings travel on every config source (v1 `plugin`, v2 `plugins`).
    for (const source of configs) expect(source.key).toEqual(['plugin', 'plugins']);

    // Loose plugin directories: v2 `plugins/`, v1 `plugin/`, plus the project-scope `.opencode/` pair.
    const dirs = loose.map((s) => s.path);
    expect(dirs.some((p) => p.endsWith(`${path.sep}plugins`))).toBe(true);
    expect(dirs.some((p) => p.endsWith(`${path.sep}plugin`))).toBe(true);
    expect(loose.some((s) => s.scope === 'project')).toBe(true);
  });

  it('never emits a source for a host with no verified extension landing', () => {
    const landed = new Set(['pi', 'opencode']);
    for (const source of sources) expect(landed.has(source.host)).toBe(true);
  });
});

describe('opencode adapter — the v1/v2 write landing rule', () => {
  it('writes into an existing plain-JSON file even when a jsonc twin exists', async () => {
    const fs = await import('node:fs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-opencode-landing-'));
    fs.writeFileSync(path.join(root, 'opencode.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(root, 'opencode.jsonc'), '{ /* v2 */ }', 'utf8');
    const target = opencodeAdapter.writeTarget({ projectRoot: root }, 'project');
    expect(target.ok && target.op === 'config' ? target.path : '').toBe(path.join(root, 'opencode.json'));
  });

  it('creates the plain-JSON file when neither exists (a v1-safe default)', async () => {
    const fs = await import('node:fs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-opencode-fresh-'));
    const target = opencodeAdapter.writeTarget({ projectRoot: root }, 'project');
    expect(target.ok && target.op === 'config' ? target.path : '').toBe(path.join(root, 'opencode.json'));
  });
});

describe('discoverExtensions — JSONC and renamed containers', () => {
  it('reads a commented JSONC config instead of reporting it as empty', async () => {
    const fs = await import('node:fs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-jsonc-'));
    const file = path.join(root, 'opencode.jsonc');
    fs.writeFileSync(
      file,
      '{\n  // v2 spelling\n  "plugins": ["some-plugin@2.0.0", "./local.ts"],\n  "model": "kimi",\n}\n',
      'utf8'
    );
    const rows = discoverExtensions([
      { host: 'opencode', scope: 'global', origin: 'config-array', kind: 'config-array', path: file, key: ['plugin', 'plugins'] },
    ]);
    expect(rows.map((r) => r.name).sort()).toEqual(['local', 'some-plugin']);
    // The removal descriptor names the container the entry was ACTUALLY read from.
    expect(rows.find((r) => r.name === 'some-plugin')?.removal).toEqual({
      op: 'drop-entry',
      file,
      container: 'plugins',
      entry: 'some-plugin@2.0.0',
    });
  });

  it('answers no rows for a genuinely broken file, never throws', async () => {
    const fs = await import('node:fs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-jsonc-broken-'));
    const file = path.join(root, 'opencode.jsonc');
    fs.writeFileSync(file, '{ "plugins": [', 'utf8');
    const rows = discoverExtensions([
      { host: 'opencode', scope: 'global', origin: 'config-array', kind: 'config-array', path: file, key: ['plugin', 'plugins'] },
    ]);
    expect(rows).toEqual([]);
  });
});

describe('scanInventory — one discovery channel, tagged by kind', () => {
  it('tags every discovered row with a kind, and extension rows with their harness', () => {
    const inventory = scanInventory();
    for (const row of inventory.discovered) {
      expect(['skill', 'mcp', 'extension']).toContain(row.kind);
      if (row.kind === 'extension') expect(typeof row.harness).toBe('string');
    }
  });
});
