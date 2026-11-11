import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  applyPluginConfig,
  getModelServicePlugin,
  installPluginPackage,
  listInstalledPlugins,
  loadInstalledPlugins,
  pluginPackageZip,
  pluginProviderOrigins,
  pluginsRoot,
  setPluginDisabled,
  syncPluginPresets,
  uninstallPlugin,
} from '../src/plugins/host.js';
import { bundlePluginDir } from '../src/plugins/pack.js';
import { readProviderDefsFile, writeProviderDefs } from '../src/opencode/provider-defs.js';
import { deleteProviderDef } from '../src/opencode/user-config.js';

/**
 * Official (`<pluginsRoot>/bundled/*.zip`, shipped with the app) and
 * third-party packages must coexist under ONE deterministic contract
 * (ADR-0017 §6): bundled wins over an operator install, ids are namespaced,
 * package tombstones instead of deleting app-owned files, and the app-owned
 * tier is recognised by MANIFEST id (file names are free-form).
 */

const IDS = [
  'coexist-newer',
  'coexist-priority',
  'coexist-shadow',
  'coexist-survivor',
  'ocr-shadow',
  'coexist-shipped',
  'coexist-tombstone',
  'coexist-legacy',
  'coexist-broken-bundled',
  'coexist-assets',
];

function packageZip(id: string, version: string, apiVersion = 1): Uint8Array {
  const manifest = { id, name: id, version, apiVersion, type: 'model-service', wires: [id] };
  return zipSync({
    'plugin.json': strToU8(JSON.stringify(manifest)),
    'index.js': strToU8('export function createPlugin() { return { createProvider() {} }; }'),
  });
}

function bareZip(id: string, manifest: Record<string, unknown>): Uint8Array {
  return zipSync({
    'plugin.json': strToU8(JSON.stringify(manifest)),
    'index.js': strToU8('export function createPlugin() { return { createProvider() {} }; }'),
  });
}

function writeBundled(id: string, version: string, fileName = `${id}.zip`): void {
  mkdirSync(join(pluginsRoot(), 'bundled'), { recursive: true });
  writeFileSync(join(pluginsRoot(), 'bundled', fileName), packageZip(id, version));
}

function readDisabledLedger(): string[] {
  try {
    return JSON.parse(readFileSync(join(pluginsRoot(), 'disabled.json'), 'utf8')) as string[];
  } catch {
    return [];
  }
}

function removePackageFiles(id: string): void {
  rmSync(join(pluginsRoot(), 'bundled'), { recursive: true, force: true });
  rmSync(join(pluginsRoot(), `${id}.zip`), { force: true });
  rmSync(join(pluginsRoot(), 'unpacked', id), { recursive: true, force: true });
}

afterEach(async () => {
  for (const id of IDS) {
    removePackageFiles(id);
    await setPluginDisabled(id, false);
  }
});

describe('plugin coexistence: official vs third-party', () => {
  it('refuses another contract version — at install and at load', async () => {
    const id = 'coexist-newer';
    const mismatched = packageZip(id, '1.0.0', 2);
    expect(() => installPluginPackage(mismatched)).toThrow(/does not match this host's plugin contract/);
    expect(existsSync(join(pluginsRoot(), `${id}.zip`))).toBe(false);

    mkdirSync(pluginsRoot(), { recursive: true });
    writeFileSync(join(pluginsRoot(), `${id}.zip`), mismatched);
    const view = (await loadInstalledPlugins()).find((v) => v.id === id);
    expect(view?.loaded).toBe(false);
    expect(view?.error ?? '').toMatch(/does not match this host's plugin contract/);
  });

  it('lets the bundled package win over an installed copy of the same id', async () => {
    const id = 'coexist-priority';
    installPluginPackage(packageZip(id, '1.0.0'));
    writeBundled(id, '2.0.0');
    const rows = (await loadInstalledPlugins()).filter((v) => v.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe('2.0.0');
  });

  it('reserves the ocr- id namespace for shipped packages', async () => {
    const id = 'ocr-shadow';
    // Refused at install (nothing lands on disk)...
    expect(() => installPluginPackage(packageZip(id, '1.0.0'))).toThrow(/reserved for packages shipped/);
    // ...and again at load for a package that was already there.
    mkdirSync(pluginsRoot(), { recursive: true });
    writeFileSync(join(pluginsRoot(), `${id}.zip`), packageZip(id, '1.0.0'));
    const view = (await loadInstalledPlugins()).find((v) => v.id === id);
    expect(view?.loaded).toBe(false);
    expect(view?.error ?? '').toMatch(/reserved for packages shipped with the gateway/);
  });

  it('refuses an install that would shadow a shipped package', () => {
    const id = 'coexist-shipped';
    writeBundled(id, '1.0.0');
    expect(() => installPluginPackage(packageZip(id, '1.0.0'))).toThrow(/ships with the gateway/);
  });

  it('tombstones a shipped package instead of deleting app-owned files', async () => {
    const id = 'coexist-tombstone';
    writeBundled(id, '1.0.0');
    expect((await loadInstalledPlugins()).find((v) => v.id === id)?.loaded).toBe(true);

    const result = await uninstallPlugin(id);
    expect(result.removed).toEqual([]);
    expect(existsSync(join(pluginsRoot(), 'bundled', `${id}.zip`))).toBe(true);

    await loadInstalledPlugins();
    const row = listInstalledPlugins().find((v) => v.id === id);
    expect(row?.disabled).toBe(true);
    expect(row?.loaded).toBe(false);
    // Facts come from the package zip: a tombstoned shipped package is never
    // extracted, so the console must not degrade to a bare `?` row.
    expect(row?.version).toBe('1.0.0');
    expect(row?.wires).toEqual([id]);
  });

  it('an install replaces a stale package of the same id under a free-form name', async () => {
    const id = 'coexist-shadow';
    mkdirSync(pluginsRoot(), { recursive: true });
    // A hand-placed OLDER copy whose file name sorts before the canonical one:
    // discovery takes the first match, so it would shadow the fresh install.
    writeFileSync(join(pluginsRoot(), 'aaa-old.zip'), packageZip(id, '1.0.0'));

    installPluginPackage(packageZip(id, '2.0.0'));
    expect(existsSync(join(pluginsRoot(), 'aaa-old.zip'))).toBe(false);

    const rows = (await loadInstalledPlugins()).filter((v) => v.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe('2.0.0');
  });

  it('never lets an unidentifiable file name steer the unpacker', async () => {
    // Regression: the id of a package whose manifest is unreadable used to fall
    // back to the FILE-NAME STEM unchecked, so a file named `...zip` (stem `..`)
    // pointed ensureUnpacked's recursive delete at the plugins ROOT itself —
    // wiping every package the operator had installed.
    const root = pluginsRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'survivor.zip'), packageZip('coexist-survivor', '1.0.0'));
    writeFileSync(
      join(root, '...zip'),
      bareZip('broken', { id: 'broken', name: 'broken', version: '1.0.0', type: 'model-service', wires: ['broken'] })
    );
    try {
      const views = await loadInstalledPlugins();
      // Nothing was deleted, and the unidentifiable file never became a row.
      expect(existsSync(join(root, 'survivor.zip'))).toBe(true);
      expect(existsSync(join(root, '...zip'))).toBe(true);
      expect(views.find((v) => v.id === '..')).toBeUndefined();
      expect(views.find((v) => v.id === 'coexist-survivor')?.loaded).toBe(true);
    } finally {
      rmSync(join(root, '...zip'), { force: true });
      rmSync(join(root, 'survivor.zip'), { force: true });
      rmSync(join(root, 'unpacked', 'coexist-survivor'), { recursive: true, force: true });
    }
  });

  it('rejects a path-shaped manifest id without touching the filesystem', () => {
    // Regression: the id addresses `<pluginsRoot>/<id>.zip` and
    // `<pluginsRoot>/unpacked/<id>/`, so a traversing id used to WRITE (and
    // recursively DELETE) outside the plugins root. The manifest validator is
    // the single chokepoint — install refuses before any path is built.
    const id = '../../coexist-escape';
    const outsideFile = join(pluginsRoot(), '..', 'coexist-escape.zip');
    // Where the recursive delete used to point (plugins/unpacked/../../coexist-escape).
    const outsideDir = join(pluginsRoot(), '..', 'coexist-escape');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'keep.txt'), 'keep');
    try {
      expect(() => installPluginPackage(packageZip(id, '1.0.0'))).toThrow(/must be a lowercase slug/);
      expect(existsSync(outsideFile)).toBe(false);
      expect(existsSync(join(outsideDir, 'keep.txt'))).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a legacy package without apiVersion, with a single error prefix', () => {
    const id = 'coexist-legacy';
    const zip = bareZip(id, { id, name: id, version: '1.0.0', type: 'model-service', wires: [id] });
    let message = '';
    try {
      installPluginPackage(zip);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/apiVersion must be a positive integer/);
    expect(message.match(/invalid plugin\.json/g)).toHaveLength(1);
  });

  it('a refused override leaves the uninstall tombstone intact', async () => {
    const id = 'coexist-shipped';
    writeBundled(id, '1.0.0');
    await uninstallPlugin(id); // tombstone (app-owned files stay)
    expect(readDisabledLedger()).toContain(id);

    // The operator's next move is exactly the refused one: install a copy.
    // The refusal must not clear the tombstone on its way out.
    expect(() => installPluginPackage(packageZip(id, '1.0.0'))).toThrow(/ships with the gateway/);
    expect(readDisabledLedger()).toContain(id);
    await loadInstalledPlugins();
    expect(listInstalledPlugins().find((v) => v.id === id)?.disabled).toBe(true);
  });

  it('a shipped package with a free-form file name is still app-owned', async () => {
    const id = 'coexist-shipped';
    writeBundled(id, '4.2.0', `official-${id}-v4.zip`);

    // Ownership is decided by the MANIFEST id, not by the file name.
    expect(() => installPluginPackage(packageZip(id, '1.0.0'))).toThrow(/ships with the gateway/);

    // Export follows the loader's precedence, so the download is the copy the
    // host would actually run.
    const zip = await pluginPackageZip(id);
    expect(zip).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(unzipSync(zip as Uint8Array)['plugin.json'])) as {
      version: string;
    };
    expect(manifest.version).toBe('4.2.0');

    // Same id-based lookup decides that uninstall is a TOMBSTONE.
    const result = await uninstallPlugin(id);
    expect(result.removed).toEqual([]);
    expect(existsSync(join(pluginsRoot(), 'bundled', `official-${id}-v4.zip`))).toBe(true);
    expect(readDisabledLedger()).toContain(id);
  });

  it('refuses the ocr- id namespace at install, not only at load', () => {
    expect(() => installPluginPackage(packageZip('ocr-shadow', '1.0.0'))).toThrow(/reserved for packages shipped/);
    expect(existsSync(join(pluginsRoot(), 'ocr-shadow.zip'))).toBe(false);
  });

  it('does not duplicate an id when the shipped copy fails to load', async () => {
    const id = 'coexist-broken-bundled';
    // Shipped copy is unloadable (other contract version); the operator copy
    // is fine. The shipped copy still OWNS the id: one row, no silent pickup.
    mkdirSync(join(pluginsRoot(), 'bundled'), { recursive: true });
    writeFileSync(join(pluginsRoot(), 'bundled', `official-${id}.zip`), packageZip(id, '9.9.9', 2));
    // The operator copy predates the shipped one (an install would be refused),
    // so it can only get here as a file that is already on disk.
    mkdirSync(pluginsRoot(), { recursive: true });
    writeFileSync(join(pluginsRoot(), `${id}.zip`), packageZip(id, '1.0.0'));

    const rows = (await loadInstalledPlugins()).filter((v) => v.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0].loaded).toBe(false);
    expect(rows[0].error ?? '').toMatch(/does not match this host's plugin contract/);
  });

  it('lets a packaged plugin resolve its shipped assets through host.pluginDir()', async () => {
    const id = 'coexist-assets';
    // A source layout that a flattened bundle destroys: the reader lives in
    // `common/` while the data file lives at the plugin root. Only the host
    // knows that root once `common/` no longer exists in the package.
    const src = mkdtempSync(join(tmpdir(), 'ocr-asset-plugin-'));
    try {
      mkdirSync(join(src, 'common'), { recursive: true });
      mkdirSync(join(src, 'data'), { recursive: true });
      writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, type: 'model-service', wires: [id] }));
      writeFileSync(
        join(src, 'index.ts'),
        "import { readMarker } from './common/reader.js';\n" +
          'export function createPlugin(host: any) {\n' +
          '  return { marker: readMarker(host), createProvider() { return {}; } };\n' +
          '}\n'
      );
      writeFileSync(
        join(src, 'common', 'reader.ts'),
        "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n" +
          "export function readMarker(host: { pluginDir(): string }): string {\n" +
          "  return readFileSync(join(host.pluginDir(), 'data', 'marker.txt'), 'utf8').trim();\n" +
          '}\n'
      );
      writeFileSync(join(src, 'data', 'marker.txt'), 'asset-ok');

      const { id: installed } = installPluginPackage(await bundlePluginDir(src));
      expect(installed).toBe(id);
      const views = await loadInstalledPlugins();
      expect(views.find((v) => v.id === id)?.loaded).toBe(true);
      // The loader hands the unpacked package root to the plugin.
      const plugin = getModelServicePlugin(id) as unknown as { marker?: string } | undefined;
      expect(plugin?.marker).toBe('asset-ok');
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});

describe('install → uninstall lifecycle', () => {
  const ID = 'life-cycle';
  const PROVIDER = 'life-cycle-provider';

  /** A package whose manifest declares one preset provider. */
  function presetPackage(version = '1.0.0'): Uint8Array {
    return zipSync({
      'plugin.json': strToU8(
        JSON.stringify({
          id: ID,
          name: 'Life Cycle',
          version,
          apiVersion: 1,
          type: 'model-service',
          wires: [ID],
          configSchema: [{ key: 'greeting', type: 'string', label: 'Greeting', default: 'hi' }],
          presets: [
            {
              presetId: 'life-cycle-preset',
              providerId: PROVIDER,
              npm: '@ai-sdk/openai-compatible',
              baseUrl: 'https://example.invalid/v1',
              displayName: 'Life Cycle',
            },
          ],
        })
      ),
      'index.js': strToU8('export function createPlugin() { return { createProvider() {} }; }'),
      'package.json': strToU8(JSON.stringify({ type: 'module' })),
    });
  }

  /** Same manifest, but the entry REPORTS the version it was built from — the
   *  only way to prove the module cache was busted on re-install. */
  function codePackage(marker: string): Uint8Array {
    const zip = unzipSync(presetPackage(marker));
    zip['index.js'] = strToU8(
      `export function createPlugin() { return { createProvider() { return { name: ${JSON.stringify(marker)} }; } }; }`
    );
    return zipSync(Object.fromEntries(Object.entries(zip).map(([name, data]) => [name, [data, { mtime: new Date('2000-01-01T00:00:00Z') }]])));
  }

  const defOf = (pid: string) => readProviderDefsFile()?.providers?.[pid] as Record<string, unknown> | undefined;

  afterEach(async () => {
    rmSync(join(pluginsRoot(), `${ID}.zip`), { force: true });
    rmSync(join(pluginsRoot(), 'unpacked', ID), { recursive: true, force: true });
    rmSync(join(pluginsRoot(), 'config', `${ID}.json`), { force: true });
    await setPluginDisabled(ID, false);
    // the "operator edited the def" case intentionally leaves it behind, so the
    // next case must not inherit it
    for (const pid of [PROVIDER, 'life-cycle-keep', 'life-cycle-drop']) if (defOf(pid)) deleteProviderDef(pid);
  });

  it('uninstalls the preset provider it registered, not just the files', async () => {
    // Regression: the "is this def still non-empty?" heuristic counted the
    // plugin's OWN `name`/`settings` as an operator edit, so EVERY preset
    // provider survived uninstall (and kept showing up in the catalog with no
    // plugin behind it). The ledger now records what the plugin wrote and
    // deletes the def only while it still matches.
    installPluginPackage(presetPackage());
    await loadInstalledPlugins();
    expect(await syncPluginPresets()).toEqual([PROVIDER]);
    expect(defOf(PROVIDER)).toBeDefined();

    const result = await uninstallPlugin(ID);
    expect(result.providersRemoved).toEqual([PROVIDER]);
    expect(defOf(PROVIDER)).toBeUndefined();
    expect(pluginProviderOrigins()[PROVIDER]).toBeUndefined();
  });

  it('leaves a provider the operator has since edited alone', async () => {
    installPluginPackage(presetPackage());
    await loadInstalledPlugins();
    await syncPluginPresets();

    // The operator tweaks the def (own baseURL): it is theirs now.
    const defs = readProviderDefsFile()!;
    const node = defs.providers[PROVIDER] as Record<string, unknown>;
    node.settings = { ...(node.settings as Record<string, unknown> | undefined), baseURL: 'https://operator.invalid/v1' };
    writeProviderDefs(defs.providers);

    const result = await uninstallPlugin(ID);
    expect(result.providersRemoved).toEqual([]);
    expect(defOf(PROVIDER)).toMatchObject({ settings: { baseURL: 'https://operator.invalid/v1' } });
  });

  it('leaves NOTHING behind on uninstall (config included)', async () => {
    installPluginPackage(presetPackage('1.0.0'));
    await loadInstalledPlugins();
    await syncPluginPresets();
    await applyPluginConfig(ID, { greeting: 'set-before-uninstall' });
    const configFile = join(pluginsRoot(), 'config', `${ID}.json`);
    expect(existsSync(configFile)).toBe(true);

    const result = await uninstallPlugin(ID);
    await loadInstalledPlugins();

    // every artifact named in the response, plus the config, is gone
    expect(result.removed.some((f) => f.endsWith(`${ID}.zip`))).toBe(true);
    expect(result.removed.some((f) => f.endsWith(join('unpacked', ID)))).toBe(true);
    expect(result.removed.some((f) => f.endsWith(`${ID}.json`))).toBe(true);
    expect(existsSync(join(pluginsRoot(), `${ID}.zip`))).toBe(false);
    expect(existsSync(join(pluginsRoot(), 'unpacked', ID))).toBe(false);
    expect(existsSync(configFile)).toBe(false);
    // no empty `plugins/config/` dir either
    expect(existsSync(join(pluginsRoot(), 'config'))).toBe(false);
    expect(defOf(PROVIDER)).toBeUndefined();
    // nothing in the plugins root still mentions the id
    const leftovers = readdirSync(pluginsRoot()).filter((name) => name.includes(ID));
    expect(leftovers).toEqual([]);
  });

  it('UPGRADES by installing over the top — config and providers survive', async () => {
    // The upgrade path is install-over-the-top, NOT uninstall → install: that
    // is why uninstall is allowed to be a clean sweep.
    installPluginPackage(presetPackage('1.0.0'));
    await loadInstalledPlugins();
    await syncPluginPresets();
    await applyPluginConfig(ID, { greeting: 'kept-across-upgrade' });

    installPluginPackage(presetPackage('2.0.0'));
    await loadInstalledPlugins();
    await syncPluginPresets();

    expect(listInstalledPlugins().find((v) => v.id === ID)?.version).toBe('2.0.0');
    const { getPluginConfig } = await import('../src/plugins/host.js');
    expect(getPluginConfig(ID).values).toMatchObject({ greeting: 'kept-across-upgrade' });
    expect(defOf(PROVIDER)).toBeDefined();
  });

  it('a re-install AFTER uninstall starts from the manifest defaults', async () => {
    installPluginPackage(presetPackage('1.0.0'));
    await loadInstalledPlugins();
    await applyPluginConfig(ID, { greeting: 'gone-with-the-uninstall' });
    await uninstallPlugin(ID);
    await loadInstalledPlugins();

    installPluginPackage(presetPackage('1.0.0'));
    await loadInstalledPlugins();
    const { getPluginConfig } = await import('../src/plugins/host.js');
    expect(getPluginConfig(ID).values).toMatchObject({ greeting: 'hi' }); // the default
  });

  /** A package with an ARBITRARY preset set and asset set — the upgrade cases
   *  need v1 and v2 to differ in BOTH. */
  function versionedPackage(version: string, providerIds: string[], assets: Record<string, string>): Uint8Array {
    return zipSync({
      'plugin.json': strToU8(
        JSON.stringify({
          id: ID,
          name: 'Life Cycle',
          version,
          apiVersion: 1,
          type: 'model-service',
          wires: [ID],
          presets: providerIds.map((pid) => ({
            presetId: `${pid}-preset`,
            providerId: pid,
            npm: '@ai-sdk/openai-compatible',
            baseUrl: `https://${pid}.invalid/v1`,
            displayName: pid,
          })),
        })
      ),
      'index.js': strToU8('export function createPlugin() { return { createProvider() {} }; }'),
      'package.json': strToU8(JSON.stringify({ type: 'module' })),
      ...Object.fromEntries(Object.entries(assets).map(([name, body]) => [name, strToU8(body)])),
    });
  }

  it('an UPGRADE retires what the new version no longer ships', async () => {
    // The upgrade is an install OVER the same id. Nothing may survive from the
    // replaced version: not a dropped ASSET (the unpacked tree is rebuilt, never
    // merged) and not a dropped PRESET provider (its def would otherwise back a
    // provider no plugin declares any more).
    installPluginPackage(
      versionedPackage('1.0.0', ['life-cycle-keep', 'life-cycle-drop'], {
        'assets/only-in-v1.txt': 'old',
        'assets/shared.txt': 'v1',
      })
    );
    await loadInstalledPlugins();
    await syncPluginPresets();
    expect(defOf('life-cycle-drop')).toBeDefined();
    expect(existsSync(join(pluginsRoot(), 'unpacked', ID, 'assets', 'only-in-v1.txt'))).toBe(true);

    installPluginPackage(versionedPackage('2.0.0', ['life-cycle-keep'], { 'assets/shared.txt': 'v2' }));
    await loadInstalledPlugins();
    await syncPluginPresets();

    // files: rebuilt, not merged
    expect(existsSync(join(pluginsRoot(), 'unpacked', ID, 'assets', 'only-in-v1.txt'))).toBe(false);
    expect(readFileSync(join(pluginsRoot(), 'unpacked', ID, 'assets', 'shared.txt'), 'utf8')).toBe('v2');
    // presets: the dropped one is gone, the kept one stays, the ledger is trimmed
    expect(defOf('life-cycle-drop')).toBeUndefined();
    expect(defOf('life-cycle-keep')).toBeDefined();
    expect(pluginProviderOrigins()['life-cycle-drop']).toBeUndefined();
    const ledger = JSON.parse(readFileSync(join(pluginsRoot(), 'registrations.json'), 'utf8')) as Record<
      string,
      { providers: string[] }
    >;
    expect(ledger[ID].providers).toEqual(['life-cycle-keep']);
  });

  it('an UPGRADE keeps a retired preset the operator had edited', async () => {
    installPluginPackage(versionedPackage('1.0.0', ['life-cycle-keep', 'life-cycle-drop'], {}));
    await loadInstalledPlugins();
    await syncPluginPresets();

    // The operator made the dropped preset theirs before the upgrade.
    const defs = readProviderDefsFile()!;
    const node = defs.providers['life-cycle-drop'] as Record<string, unknown>;
    node.settings = { ...(node.settings as Record<string, unknown> | undefined), baseURL: 'https://mine.invalid/v1' };
    writeProviderDefs(defs.providers);

    installPluginPackage(versionedPackage('2.0.0', ['life-cycle-keep'], {}));
    await loadInstalledPlugins();
    await syncPluginPresets();

    // Retired by the plugin, but operator-owned: never destroyed by an upgrade.
    expect(defOf('life-cycle-drop')).toMatchObject({ settings: { baseURL: 'https://mine.invalid/v1' } });
    expect(pluginProviderOrigins()['life-cycle-drop']).toBeUndefined(); // ...and no longer claimed
  });

  it('reloads without a restart: fresh code, and a disabled plugin comes back enabled', async () => {
    installPluginPackage(codePackage('V1'));
    await loadInstalledPlugins();
    const v1 = getModelServicePlugin(ID) as unknown as { createProvider: () => { name?: string } };
    expect(v1.createProvider()?.name).toBe('V1');

    // (a) install over the running copy: the NEW module must be imported, not
    // the cached one (the unpacked dir is re-extracted, so its mtime changes).
    installPluginPackage(codePackage('V2'));
    await loadInstalledPlugins();
    const v2 = getModelServicePlugin(ID) as unknown as { createProvider: () => { name?: string } };
    expect(v2.createProvider()?.name).toBe('V2');

    // (b) a DISABLED plugin is enabled by an explicit install (intent to use).
    await setPluginDisabled(ID, true);
    await loadInstalledPlugins();
    expect(listInstalledPlugins().find((v) => v.id === ID)?.loaded).toBe(false);
    installPluginPackage(codePackage('V3'));
    await loadInstalledPlugins();
    const row = listInstalledPlugins().find((v) => v.id === ID);
    expect(row?.disabled).toBeUndefined();
    expect(row?.loaded).toBe(true);
    const v3 = getModelServicePlugin(ID) as unknown as { createProvider: () => { name?: string } };
    expect(v3.createProvider()?.name).toBe('V3');
  });
});