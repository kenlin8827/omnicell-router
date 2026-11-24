import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

import {
  installPluginPackage,
  listInstalledPlugins,
  loadInstalledPlugins,
  pluginsRoot,
  setPluginDisabled,
} from '../../src/plugins/host.js';
import { SUPPORTED_PLUGIN_API } from '../../src/plugins/manifest.js';

/**
 * A package refused on ENGINE compatibility (ADR-0036 §4–5). Three properties
 * are the whole contract and each of them used to be a silent loss:
 *
 *  - it is VISIBLE (a console row) and unmistakably not operator-disabled;
 *  - it answers NO traffic and registers nothing;
 *  - its bytes stay on disk, so the fix is an upgrade on either side — not a
 *    second upload of the same file.
 */

const HOME = mkdtempSync(join(tmpdir(), 'ocr-plugin-engine-'));
process.env.OCR_HOME = HOME;
delete process.env.OCR_PLUGIN_SRC_DIR;

const ID = 'engine-probe';
/** A contract no CURRENT engine implements: the package was built against a
 *  surface newer than this gateway has. Written relative to the shipped
 *  constant so an engine bump moves the fixture instead of rotting it. */
const FUTURE_API = SUPPORTED_PLUGIN_API + 1;
/** The contract this engine implements — what a package wants to declare. */
const OK_API = SUPPORTED_PLUGIN_API;

function packageZip(version: string, extra: Record<string, unknown> = {}): Uint8Array {
  return zipSync({
    'plugin.json': strToU8(
      JSON.stringify({ id: ID, name: ID, version, apiVersion: OK_API, type: 'model-service', wires: [ID], ...extra })
    ),
    // The entry would register a provider if it were ever imported: the gate
    // must stop it BEFORE the import, so a later assertion that nothing was
    // registered is meaningful.
    'index.js': strToU8(
      'export function createPlugin() { return { createProvider() { throw new Error("engine gate let this through"); } }; }'
    ),
  });
}

/** Put a package on disk WITHOUT the install gate — the state of a package
 *  that shipped with an older gateway, or one the app-owned seeder staged. The
 *  loader re-evaluates every file it finds, so this is the path that has to
 *  turn a refusal into a row (ADR-0036 §4). */
function placePackage(version: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(pluginsRoot(), { recursive: true });
  writeFileSync(join(pluginsRoot(), `${ID}.zip`), packageZip(version, extra));
}
function cleanup(): void {
  rmSync(pluginsRoot(), { recursive: true, force: true });
}

beforeEach(() => cleanup());
after(() => {
  cleanup();
  rmSync(HOME, { recursive: true, force: true });
});

describe('engine compatibility: a refused package at LOAD', () => {
  it('keeps the package on disk, lists it as incompatible, and loads nothing', async () => {
    placePackage('1.0.0', { apiVersion: FUTURE_API });

    const loaded = await loadInstalledPlugins();
    assert.deepEqual(loaded.map((p) => p.id), [], 'a refused package must not appear as loaded');

    const row = listInstalledPlugins().find((p) => p.id === ID);
    assert.ok(row, 'the console must SEE the package it refuses');
    assert.equal(row.loaded, false);
    assert.equal(row.disabled, true);
    assert.equal(row.incompatible, true);
    assert.deepEqual(row.wires, [], 'a refused package claims no wire');
    assert.match(row.error ?? '', /targets plugin contract \d+, newer than this gateway's/);
    assert.match(row.error ?? '', /update OmniCellRouter/);

    // Bytes stay: an upgrade of the gateway (or of the package) must be able to
    // adopt what is already installed.
    assert.ok(existsSync(join(pluginsRoot(), `${ID}.zip`)));
  });

  it('does not persist the refusal to the disabled ledger', async () => {
    // The ledger is operator intent and outlives the mismatch. Writing the
    // refusal there would keep a package switched OFF after it became
    // compatible again — the one bug this distinction exists to prevent.
    placePackage('1.0.0', { apiVersion: FUTURE_API });
    await loadInstalledPlugins();

    await setPluginDisabled(ID, false);
    await loadInstalledPlugins();
    const row = listInstalledPlugins().find((p) => p.id === ID);
    // Still refused (the window did not change), and still reported by the
    // LOADER rather than by the ledger.
    assert.equal(row?.incompatible, true);
    assert.equal(row?.disabled, true);
  });

  it('loads the same package the moment its window admits this engine', async () => {
    placePackage('1.0.0', { apiVersion: FUTURE_API });
    await loadInstalledPlugins();
    assert.equal(listInstalledPlugins()[0]?.incompatible, true);

    // An engine upgrade is simulated by the package going back to a window this
    // engine satisfies — the operator's other remedy, an updated plugin, and the
    // one they can do without touching the gateway.
    installPluginPackage(packageZip('2.0.0', { apiVersion: OK_API }));
    await loadInstalledPlugins();
    const row = listInstalledPlugins().find((p) => p.id === ID);
    assert.equal(row?.loaded, true);
    assert.equal(row?.incompatible, undefined);
  });

  it('leaves no unpacked tree for a refused package', async () => {
    placePackage('1.0.0', { apiVersion: FUTURE_API });
    await loadInstalledPlugins();
    const unpacked = join(pluginsRoot(), 'unpacked');
    const entries = existsSync(unpacked) ? readdirSync(unpacked) : [];
    assert.equal(entries.includes(ID), false, 'refused code must never be extracted');
  });

  it('reports INCOMPATIBILITY ahead of an operator disable — the switch cannot fix it', async () => {
    // A package that is both incompatibly old AND switched off by the operator
    // must still say WHY it cannot run: a plain "disabled" row would send the
    // operator to toggle a switch that changes nothing.
    placePackage('1.0.0', { apiVersion: FUTURE_API });
    await loadInstalledPlugins();
    await setPluginDisabled(ID, true);
    await loadInstalledPlugins();

    const rows = listInstalledPlugins().filter((p) => p.id === ID);
    assert.equal(rows.length, 1, 'one package is one row');
    assert.equal(rows[0].incompatible, true);
    assert.match(rows[0].error ?? '', /newer than this gateway's/);
  });

  it('serves the refused package\'s config schema without importing it', async () => {
    // The settings drawer reads a schema, not behaviour: 404ing here made a
    // cleanly refused row look like a broken one.
    placePackage('1.0.0', {
      apiVersion: FUTURE_API,
      configSchema: [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
    });
    await loadInstalledPlugins();
    const { getPluginConfig } = await import('../../src/plugins/host.js');
    const cfg = getPluginConfig(ID);
    assert.ok(cfg, 'a refused row still has a readable schema');
    assert.equal(cfg.schema[0].key, 'endpoint');
  });
});