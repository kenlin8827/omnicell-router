import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { installPluginPackage, loadInstalledPlugins, pluginsRoot } from '../src/plugins/host.js';

// Zip-slip guard: a packaged plugin whose entries escape the unpack
// destination (`../../x`, absolute paths) must never write outside
// `<ocrHome>/plugins/unpacked/<id>/`. The isolated runner points OCR_HOME at
// a sandbox, so we only ever touch the sandbox plugins root.
describe('plugin package zip-slip guard', () => {
  it('rejects a package whose entries escape the unpack root', async () => {
    const manifest = {
      id: 'slippery',
      name: 'Slippery',
      version: '1.0.0',
      apiVersion: 1,
      type: 'model-service',
      wires: ['slippery'],
    };
    const zip = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest)),
      'index.ts': strToU8('export function createPlugin() { return { createProvider() {} }; }'),
      '../../evil.txt': strToU8('pwned'),
    });
    const scratch = mkdtempSync(join(tmpdir(), 'ocr-zip-slip-'));
    try {
      installPluginPackage(zip);
      const views = await loadInstalledPlugins();
      const view = views.find((v) => v.id === 'slippery');
      assert.ok(view, 'slippery package should surface a (failed) view');
      assert.equal(view.loaded, false);
      assert.match(view.error ?? '', /zip entry escapes package root/);
      // nothing escaped the unpack destination
      assert.equal(existsSync(join(pluginsRoot(), 'unpacked', '..', 'evil.txt')), false);
      assert.equal(existsSync(join(pluginsRoot(), 'evil.txt')), false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('accepts nested-but-contained entries (subdirectory stays inside)', async () => {
    const manifest = {
      id: 'nested-ok',
      name: 'NestedOk',
      version: '1.0.0',
      apiVersion: 1,
      type: 'model-service',
      wires: ['nested-ok'],
    };
    const zip = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest)),
      'assets/logo.svg': strToU8('<svg/>'),
    });
    try {
      installPluginPackage(zip);
      const views = await loadInstalledPlugins();
      const view = views.find((v) => v.id === 'nested-ok');
      assert.ok(view, 'nested-ok package should surface a view');
      // unpack itself succeeds — failure (if any) comes from the missing
      // runnable entry, never from the path guard
      assert.doesNotMatch(view.error ?? '', /zip entry escapes package root/);
      assert.equal(existsSync(join(pluginsRoot(), 'unpacked', 'nested-ok', 'assets', 'logo.svg')), true);
    } finally {
      rmSync(join(pluginsRoot(), 'nested-ok.zip'), { force: true });
      rmSync(join(pluginsRoot(), 'unpacked', 'nested-ok'), { recursive: true, force: true });
    }
  });
});
