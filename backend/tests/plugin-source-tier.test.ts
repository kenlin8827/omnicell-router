import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  installPluginPackage,
  loadInstalledPlugins,
  pluginEntrySpecifier,
  pluginPackageZip,
  pluginsRoot,
} from '../src/plugins/host.js';

/**
 * The SOURCE tree is opt-in (ADR-0017 §6): the loader must not read a checkout
 * just because one exists on disk. Binding it to `<repo>/plugins` listed
 * plugins nobody installed and left install/uninstall hidden behind phantom
 * rows, so `OCR_PLUGIN_SRC_DIR` is the only way in.
 */

const ID = 'src-tier';
const ENTRY = 'export function createPlugin() { return { createProvider() {} }; }';

function packageZip(id: string, version: string, marker = ''): Uint8Array {
  return zipSync({
    'plugin.json': strToU8(
      JSON.stringify({ id, name: id, version, apiVersion: 1, type: 'model-service', wires: [id] })
    ),
    'index.js': strToU8(
      marker
        ? `export function createPlugin() { return { createProvider() { return { name: ${JSON.stringify(marker)} }; } }; }`
        : ENTRY
    ),
  });
}

/** A plugin SOURCE directory, exactly what a developer edits in place. */
function writeSourceTree(root: string, id: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '0.0.1', apiVersion: 1, type: 'model-service', wires: [id] })
  );
  writeFileSync(join(dir, 'index.js'), ENTRY);
  return dir;
}

const savedSrc = process.env.OCR_PLUGIN_SRC_DIR;
const scratch = mkdtempSync(join(tmpdir(), 'ocr-plugin-src-'));

afterEach(() => {
  if (savedSrc === undefined) delete process.env.OCR_PLUGIN_SRC_DIR;
  else process.env.OCR_PLUGIN_SRC_DIR = savedSrc;
  rmSync(join(pluginsRoot(), `${ID}.zip`), { force: true });
  rmSync(join(pluginsRoot(), 'unpacked', ID), { recursive: true, force: true });
});

describe('plugin source tier is opt-in', () => {
  it('ignores a source tree at a known path unless OCR_PLUGIN_SRC_DIR names it', async () => {
    const dir = writeSourceTree(scratch, ID);
    delete process.env.OCR_PLUGIN_SRC_DIR;

    const views = await loadInstalledPlugins();
    expect(views.find((v) => v.id === ID)).toBeUndefined();
    expect(dir).toContain(ID); // the tree is there; it is simply not read
  });

  it('loads the named source tree as `dev`, and dev still wins over an install of the same id', async () => {
    installPluginPackage(packageZip(ID, '9.9.9'));
    process.env.OCR_PLUGIN_SRC_DIR = scratch;

    const views = await loadInstalledPlugins();
    const row = views.find((v) => v.id === ID);
    expect(row?.source).toBe('dev');
    expect(row?.loaded).toBe(true);
    expect(row?.version).toBe('0.0.1'); // the source copy, not the installed 9.9.9
  });

  it('exports a source plugin only when the source tier is named', async () => {
    writeSourceTree(scratch, ID);
    delete process.env.OCR_PLUGIN_SRC_DIR;
    expect(await pluginPackageZip(ID)).toBeUndefined();

    process.env.OCR_PLUGIN_SRC_DIR = scratch;
    const zip = await pluginPackageZip(ID);
    expect(zip).toBeInstanceOf(Uint8Array);
    const files = unzipSync(zip as Uint8Array);
    expect(files['index.js']).toBeDefined();
    expect(JSON.parse(strFromU8(files['plugin.json'] as Uint8Array))).toMatchObject({ id: ID });
  });
});

describe('in-process reload', () => {
  it('spells the import specifier per runtime: path for Bun, file URL for Node', () => {
    // Both runtimes are supported entry points, and they DISAGREE: Bun keys a
    // `file://` module on the URL alone (ignoring the query, so a reinstall
    // served the cached v1 on Windows), while Node's ESM loader rejects a bare
    // Windows path outright (`Received protocol 'c:'`).
    const entry = join(tmpdir(), 'ocr plug in', 'index.js');

    const asBun = pluginEntrySpecifier(entry, 42, true);
    expect(asBun.endsWith('?v=42')).toBe(true);
    expect(asBun.startsWith(entry.replaceAll('\\', '/'))).toBe(true);
    expect(asBun).not.toContain('file://');
    // raw, not percent-encoded: for Bun the WHOLE string is the cache key
    expect(asBun).toContain('ocr plug in');

    const asNode = pluginEntrySpecifier(entry, 42, false);
    expect(asNode).toBe(`${pathToFileURL(entry).href}?v=42`);
    expect(asNode).toContain('file://');
    expect(asNode).toContain('ocr%20plug%20in');
  });

  it('re-imports the ENTRY after an edit (cache-bust), without a restart', async () => {
    const dir = join(scratch, 'reload-tree');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({ id: 'reload-tree', name: 'reload-tree', version: '1.0.0', apiVersion: 1, type: 'model-service', wires: ['reload-tree'] })
    );
    const entry = join(dir, 'index.js');
    writeFileSync(entry, 'export function createPlugin() { return { createProvider() { return { name: "BEFORE" }; } }; }');

    process.env.OCR_PLUGIN_SRC_DIR = scratch;
    await loadInstalledPlugins();
    const { getModelServicePlugin } = await import('../src/plugins/host.js');
    const before = getModelServicePlugin('reload-tree') as unknown as { createProvider: () => { name: string } };
    expect(before.createProvider().name).toBe('BEFORE');

    // the cache-bust is the entry's mtime: an edit + a newer mtime means the
    // next import gets a fresh URL instead of the cached module. (Edits inside
    // an imported SUBMODULE are the watcher's job — Bun's module cache keys on
    // the resolved URL, so those need a process restart.)
    writeFileSync(entry, 'export function createPlugin() { return { createProvider() { return { name: "AFTER" }; } }; }');
    const future = new Date(Date.now() + 5_000);
    utimesSync(entry, future, future);

    await loadInstalledPlugins();
    const after = getModelServicePlugin('reload-tree') as unknown as { createProvider: () => { name: string } };
    expect(after.createProvider().name).toBe('AFTER');
  });

  it('serves the NEW module after a reinstall of the same id, without a restart', async () => {
    // The packaged path is reused on reinstall (`<id>.zip` -> `unpacked/<id>`),
    // so a cache key that ignored the version served the OLD module on Windows.
    installPluginPackage(packageZip('reinstall-tier', '1.0.0', 'V1'));
    await loadInstalledPlugins();
    const { getModelServicePlugin } = await import('../src/plugins/host.js');
    const first = getModelServicePlugin('reinstall-tier') as unknown as { createProvider: () => { name: string } };
    expect(first.createProvider().name).toBe('V1');

    installPluginPackage(packageZip('reinstall-tier', '2.0.0', 'V2'));
    await loadInstalledPlugins();
    const second = getModelServicePlugin('reinstall-tier') as unknown as { createProvider: () => { name: string } };
    expect(second.createProvider().name).toBe('V2');
  });
});
