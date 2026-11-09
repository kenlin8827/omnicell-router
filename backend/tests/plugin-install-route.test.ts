import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { applyPluginConfig, getPluginConfig, listInstalledPlugins, loadInstalledPlugins, pluginsRoot } from '../src/plugins/host.js';

/**
 * The console INSTALL route (ADR-0017 §6) — the one entry point an operator
 * actually uses, and the contract this suite holds it to:
 *   upload → package written → RELOAD in-process (no gateway restart) →
 *   plugin listed as loaded → presets registered → settings artifact untouched.
 * A package that cannot load is discarded and reported, so it never re-fails
 * every boot.
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

const ID = 'route-install';

/** A loadable package; `marker` is what the entry reports, so a stale module
 *  cache would be visible as the OLD marker after an upgrade. */
function packageZip(version: string, marker: string): Uint8Array {
  return zipSync({
    'plugin.json': strToU8(
      JSON.stringify({
        id: ID,
        name: 'Route Install',
        version,
        apiVersion: 1,
        type: 'model-service',
        wires: [ID],
        configSchema: [{ key: 'greeting', type: 'string', label: 'Greeting', default: 'hi' }],
      })
    ),
    'index.js': strToU8(
      `export function createPlugin() { return { createProvider() { return { name: ${JSON.stringify(marker)} }; } }; }`
    ),
    'package.json': strToU8(JSON.stringify({ type: 'module' })),
  });
}

/** Same manifest, but the entry cannot load (no createPlugin export). */
function brokenPackage(version: string): Uint8Array {
  const files = unzipSync(packageZip(version, 'never'));
  delete files['index.js'];
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [name, [data, { mtime: new Date('2000-01-01T00:00:00Z') }]])
    )
  );
}

type InjectResult = { statusCode: number; body: string };

async function install(bytes: Uint8Array): Promise<InjectResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/plugins/install',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(bytes),
  });
  return { statusCode: res.statusCode, body: res.body };
}

const rows = () => listInstalledPlugins().filter((v) => v.id === ID);

let tmpHome = '';
let oldHome: string | undefined;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-plugin-route-'));
  oldHome = process.env.OCR_HOME;
  process.env.OCR_HOME = tmpHome;
  // The host keeps the loaded set in memory: point it at the fresh sandbox
  // BEFORE any assertion, or a previous case's rows leak into this one.
  await loadInstalledPlugins();
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('console plugin install route', () => {
  it('installs, reloads in-process and lists the plugin as loaded', async () => {
    const res = await install(packageZip('1.0.0', 'V1'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; id: string; plugins: unknown[] };
    expect(body.status).toBe('ok');
    expect(body.id).toBe(ID);
    // the response already carries the reloaded list — the console renders it
    expect((body.plugins as Array<{ id: string; loaded: boolean }>).find((p) => p.id === ID)?.loaded).toBe(true);
    expect(rows()[0].version).toBe('1.0.0');
  });

  it('upgrades in place: new code is live, settings and package state survive', async () => {
    await install(packageZip('1.0.0', 'V1'));
    await loadInstalledPlugins();
    await applyPluginConfig(ID, { greeting: 'kept-on-upgrade' });

    const res = await install(packageZip('2.0.0', 'V2'));
    expect(res.statusCode).toBe(200);
    const row = rows()[0];
    expect(row.version).toBe('2.0.0');
    expect(row.loaded).toBe(true);
    // the module cache was busted (a restart would hide this regression)
    const { getModelServicePlugin } = await import('../src/plugins/host.js');
    const plugin = getModelServicePlugin(ID) as unknown as { createProvider: () => { name?: string } };
    expect(plugin.createProvider()?.name).toBe('V2');
    expect(getPluginConfig(ID).values).toMatchObject({ greeting: 'kept-on-upgrade' });
  });

  it('re-enables a disabled plugin, because installing expresses intent to use', async () => {
    await install(packageZip('1.0.0', 'V1'));
    const { setPluginDisabled } = await import('../src/plugins/host.js');
    await setPluginDisabled(ID, true);
    await loadInstalledPlugins();
    expect(rows()[0].loaded).toBe(false);

    const res = await install(packageZip('1.1.0', 'V1b'));
    expect(res.statusCode).toBe(200);
    expect(rows()[0].loaded).toBe(true);
    expect(rows()[0].disabled).toBeUndefined();
  });

  it('discards a package that cannot load, so it does not re-fail on every boot', async () => {
    const res = await install(brokenPackage('9.9.9'));
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('failed to load');
    // discarded: no zip on disk, no row that would fail again next boot
    expect(fs.existsSync(path.join(pluginsRoot(), `${ID}.zip`))).toBe(false);
    expect(listInstalledPlugins().some((v) => v.id === ID && !v.loaded)).toBe(false);
  });

  it('rolls back a failed UPGRADE instead of deleting the working version', async () => {
    // Upgrading is install-over-the-top, so a broken upload must not cost the
    // operator the version that was running: 422 + the previous package back.
    await install(packageZip('1.0.0', 'V1'));
    const before = rows();
    expect(before[0].version).toBe('1.0.0');

    const res = await install(brokenPackage('2.0.0'));
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('rolled back');

    const row = rows()[0];
    expect(row.version).toBe('1.0.0');
    expect(row.loaded).toBe(true);
    const { getModelServicePlugin } = await import('../src/plugins/host.js');
    const plugin = getModelServicePlugin(ID) as unknown as { createProvider: () => { name?: string } };
    expect(plugin.createProvider()?.name).toBe('V1');
    expect(fs.existsSync(path.join(pluginsRoot(), `${ID}.zip`))).toBe(true);
  });

  it('rejects a non-zip body without touching the plugins root', async () => {
    const res = await install(new Uint8Array([1, 2, 3, 4]));
    expect(res.statusCode).toBe(400);
    expect(listInstalledPlugins().some((v) => v.id === ID)).toBe(false);
  });
});
