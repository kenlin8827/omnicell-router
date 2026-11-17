import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

import {
  installPluginPackage,
  listInstalledPlugins,
  loadInstalledPlugins,
  pluginsRoot,
  setPluginDisabled,
  bundledPluginsDir,
  uninstallPlugin,
} from '../src/plugins/host.js';
import { pluginConfigPath, mergedPluginConfig, writePluginConfig } from '../src/plugins/config.js';
import { seedBundledPlugins } from '../src/plugins/seed.js';
import { registerPluginClientAdapter } from '../src/cli/clients/plugin-adapters.js';
import type { PluginConfigField } from '../src/plugins/types.js';
import type { ClientAdapter } from '../src/cli/clients/base.js';

/**
 * Plugin package LIFECYCLE: upgrade, downgrade refusal, rollback, the app-owned
 * seeding tier, and the one thing an upgrade must never do quietly — replace a
 * working install with something the operator did not mean.
 *
 * Every case runs against a throwaway OCR_HOME: these paths WRITE (packages,
 * config artifacts, the disabled ledger), and a test that touches a real
 * install would be a test that breaks somebody's gateway.
 */

const HOME = mkdtempSync(join(tmpdir(), 'ocr-plugin-upgrade-'));
const ARTIFACTS = mkdtempSync(join(tmpdir(), 'ocr-plugin-artifacts-'));
process.env.OCR_HOME = HOME;
delete process.env.OCR_PLUGIN_SRC_DIR; // no dev tree: seeding must be exercised for real

/** The artifact source the runner pinned (a path that does not exist, so
 *  seeding is inert by default — see scripts/test-isolated.ts). Seeding cases
 *  point it at their own ARTIFACTS dir and RESTORE this value afterwards: no
 *  default source exists (ADR-0032), but restoring it (rather than deleting)
 *  keeps a case that forgets to restore from silently staging another case's
 *  artifacts. */
const PINNED_BUNDLED_SRC = process.env.OCR_BUNDLED_PLUGIN_SRC;
function restoreBundledSrc(): void {
  if (PINNED_BUNDLED_SRC === undefined) delete process.env.OCR_BUNDLED_PLUGIN_SRC;
  else process.env.OCR_BUNDLED_PLUGIN_SRC = PINNED_BUNDLED_SRC;
}

const ID = 'upgrade-probe';

const schema1: PluginConfigField[] = [
  { key: 'targetModel', type: 'string', default: 'auto' },
  { key: 'legacyFlag', type: 'boolean', default: false },
];
const schema2: PluginConfigField[] = [
  { key: 'targetModel', type: 'string', default: 'auto' },
  { key: 'forceModel', type: 'boolean', default: false },
];

function packageZip(id: string, version: string, extra: Record<string, unknown> = {}): Uint8Array {
  return zipSync({
    'plugin.json': strToU8(
      JSON.stringify({ id, name: id, version, apiVersion: 1, type: 'model-service', wires: [id], ...extra })
    ),
    'index.js': strToU8('export function createPlugin() { return { createProvider() {} }; }'),
  });
}

function cleanup(): void {
  rmSync(pluginsRoot(), { recursive: true, force: true });
}

beforeEach(() => {
  cleanup();
  for (const name of existsSync(ARTIFACTS) ? [] : []) void name;
});

after(() => {
  cleanup();
  rmSync(ARTIFACTS, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

describe('plugin upgrade: same id, higher version', () => {
  it('replaces the package, keeps the settings artifact, re-reports the version', async () => {
    const first = installPluginPackage(packageZip(ID, '1.0.0'));
    assert.deepEqual(first, { id: ID, version: '1.0.0', replacedVersion: undefined });
    await loadInstalledPlugins();
    assert.equal(listInstalledPlugins().find((p) => p.id === ID)?.version, '1.0.0');

    writePluginConfig(ID, schema1, { targetModel: 'plus', legacyFlag: true } as never);

    const second = installPluginPackage(packageZip(ID, '2.0.0'));
    assert.equal(second.version, '2.0.0');
    assert.equal(second.replacedVersion, '1.0.0');
    await loadInstalledPlugins();
    assert.equal(listInstalledPlugins().find((p) => p.id === ID)?.version, '2.0.0');

    // The operator's settings are NOT plugin code: they survive the upgrade.
    // They are then read through the NEW schema, which is why a removed key
    // stops applying while the new one defaults in.
    assert.ok(existsSync(pluginConfigPath(ID)));
    assert.deepEqual(mergedPluginConfig(ID, schema2), { targetModel: 'plus', forceModel: false });
  });

  it('accepts a same-version upload as a rebuild', async () => {
    installPluginPackage(packageZip(ID, '1.0.0'));
    const again = installPluginPackage(packageZip(ID, '1.0.0'));
    assert.equal(again.version, '1.0.0');
    assert.equal(again.replacedVersion, '1.0.0');
  });
});

describe('plugin downgrade: refused, and only a rollback may do it', () => {
  it('refuses an older version and leaves the installed one untouched', async () => {
    installPluginPackage(packageZip(ID, '2.0.0'));
    await loadInstalledPlugins();
    const before = readFileSync(join(pluginsRoot(), `${ID}.zip`));

    assert.throws(() => installPluginPackage(packageZip(ID, '1.0.0')), /OLDER than the installed 2\.0\.0/);
    // A refused install must not have written a byte: the refusal exists so a
    // stale download cannot silently roll a fixed install back.
    assert.deepEqual(readFileSync(join(pluginsRoot(), `${ID}.zip`)), before);
    assert.equal(listInstalledPlugins().find((p) => p.id === ID)?.version, '2.0.0');
  });

  it('allows the loader-owned rollback path explicitly', async () => {
    installPluginPackage(packageZip(ID, '2.0.0'));
    const rolled = installPluginPackage(packageZip(ID, '1.0.0'), { allowDowngrade: true });
    assert.equal(rolled.version, '1.0.0');
    await loadInstalledPlugins();
    assert.equal(listInstalledPlugins().find((p) => p.id === ID)?.version, '1.0.0');
  });

  it('an unparseable version never manufactures a downgrade refusal', () => {
    installPluginPackage(packageZip(ID, '2.0.0'));
    // compareVersions fails OPEN (0 = equal): a package with a non-semver
    // version is odd, not "older", and blocking it would be a false positive.
    const odd = installPluginPackage(packageZip(ID, 'nightly'));
    assert.equal(odd.version, 'nightly');
  });
});

describe('app-owned tier: seeding from the build artifacts', () => {
  it('copies app-owned packages into `<pluginsRoot>/bundled` and loads them', async () => {
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, 'shipped-one.zip'), packageZip('seed-one', '1.0.0'));
    process.env.OCR_BUNDLED_PLUGIN_SRC = ARTIFACTS;
    try {
      const views = await loadInstalledPlugins();
      const seeded = views.find((v) => v.id === 'seed-one');
      assert.ok(seeded, 'the app-owned package must be visible on the first boot');
      assert.equal(seeded.loaded, true);
      assert.equal(seeded.source, 'packaged');
      assert.ok(existsSync(join(bundledPluginsDir(), 'shipped-one.zip')));
    } finally {
      restoreBundledSrc();
    }
  });

  it('leaves a byte-identical package alone so its mtime (and unpack stamp) holds', async () => {
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(ARTIFACTS, { recursive: true });
    const bytes = packageZip('seed-stable', '1.0.0');
    writeFileSync(join(ARTIFACTS, 'seed-stable.zip'), bytes);
    process.env.OCR_BUNDLED_PLUGIN_SRC = ARTIFACTS;
    try {
      const first = seedBundledPlugins(bundledPluginsDir());
      assert.deepEqual(first.seeded, ['seed-stable']);
      const dest = join(bundledPluginsDir(), 'seed-stable.zip');
      const mtime = statSync(dest).mtimeMs;
      // A re-extract on every boot is the cost of a careless seed: the stamp
      // compares mtimes, so rewriting equal bytes would invalidate it.
      const second = seedBundledPlugins(bundledPluginsDir());
      assert.deepEqual(second.seeded, []);
      assert.equal(second.unchanged, 1);
      assert.equal(statSync(dest).mtimeMs, mtime);
    } finally {
      restoreBundledSrc();
    }
  });

  it('replaces a app-owned package in place on an app upgrade, keeping one copy per id', async () => {
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, 'shipped.zip'), packageZip('seed-move', '1.0.0'));
    process.env.OCR_BUNDLED_PLUGIN_SRC = ARTIFACTS;
    try {
      seedBundledPlugins(bundledPluginsDir());
      // Next release renames the artifact file; discovery sorts by file name,
      // so the PREVIOUS copy must not survive to win by accident.
      rmSync(join(ARTIFACTS, 'shipped.zip'));
      writeFileSync(join(ARTIFACTS, 'a-shipped.zip'), packageZip('seed-move', '2.0.0'));
      const result = seedBundledPlugins(bundledPluginsDir());
      assert.deepEqual(result.seeded, ['seed-move']);
      assert.ok(existsSync(join(bundledPluginsDir(), 'a-shipped.zip')));
      assert.equal(existsSync(join(bundledPluginsDir(), 'shipped.zip')), false);
    } finally {
      restoreBundledSrc();
    }
  });

  it('never resurrects a tombstoned app-owned package', async () => {
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, 'seed-tomb.zip'), packageZip('seed-tomb', '1.0.0'));
    process.env.OCR_BUNDLED_PLUGIN_SRC = ARTIFACTS;
    try {
      await setPluginDisabled('seed-tomb', true);
      await loadInstalledPlugins();
      // `loadInstalledPlugins()` returns the rows it LOADED; a disabled package
      // is listed (so the operator can re-enable it) by the console listing.
      const row = listInstalledPlugins().find((v) => v.id === 'seed-tomb');
      assert.ok(row);
      assert.equal(row.loaded, false);
      assert.equal(row.disabled, true);
    } finally {
      restoreBundledSrc();
      await setPluginDisabled('seed-tomb', false);
    }
  });

  it('ignores an artifact whose manifest does not validate', () => {
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, 'broken.zip'), strToU8('not a zip'));
    process.env.OCR_BUNDLED_PLUGIN_SRC = ARTIFACTS;
    try {
      const result = seedBundledPlugins(bundledPluginsDir());
      assert.deepEqual(result.seeded, []);
      assert.equal(existsSync(join(bundledPluginsDir(), 'broken.zip')), false);
    } finally {
      restoreBundledSrc();
    }
  });
});

describe('uninstall: a row whose package vanished is not an error', () => {
  it('succeeds for a row the host still shows, and the reload drops it', async () => {
    installPluginPackage(packageZip('ghost-probe', '1.0.0'));
    await loadInstalledPlugins();
    assert.ok(listInstalledPlugins().some((p) => p.id === 'ghost-probe'), 'row must be live first');
    // The package disappears behind the host's back — an operator cleanup of
    // `plugins/`, or a package the install route already discarded.
    rmSync(join(pluginsRoot(), 'ghost-probe.zip'), { force: true });
    rmSync(join(pluginsRoot(), 'unpacked', 'ghost-probe'), { recursive: true, force: true });

    // DELETE stays idempotent: nothing to remove, and the caller's reload is
    // what makes the row go away. Refusing here would tell an operator staring
    // at the row that the id does not exist.
    const result = await uninstallPlugin('ghost-probe');
    assert.deepEqual(result.removed, []);
    await loadInstalledPlugins();
    assert.equal(listInstalledPlugins().some((p) => p.id === 'ghost-probe'), false);
  });

  it('still refuses an id the host has never seen', async () => {
    await loadInstalledPlugins();
    await assert.rejects(() => uninstallPlugin('never-installed'), /no installed package/);
  });
});

describe('retired client ids: refused, not aliased', () => {
  it('refuses a package that still registers a renamed id', () => {
    const adapter = {
      name: 'opencode-proxy',
      getStatus: async () => ({ hooked: false }),
      setup: async () => ({ success: true, message: '' }),
      teardown: async () => ({ success: true, message: '' }),
    } as unknown as ClientAdapter;
    // The replacement already hooks this client. Registering both would put two
    // rows on one client, each with its own sidecar, fighting over the same
    // settings — so the OLD package surfaces as a load error instead.
    assert.throws(() => registerPluginClientAdapter('stale-package', adapter), /moved into 'opencode-gateway'/);
  });
});
