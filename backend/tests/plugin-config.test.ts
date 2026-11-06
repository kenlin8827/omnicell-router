import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writePluginConfig, mergedPluginConfig, validatePluginConfig, invalidatePluginConfigCache, pluginConfigPath, readStoredConfig } from '../src/plugins/config.js';
import type { PluginConfigField } from '../src/plugins/types.js';

/**
 * Plugin-level configuration (ADR-0017 §6): schema validation, artifact store,
 * merge precedence (defaults ← stored), and the host-side read/apply API
 * against the real dev-tree cursor-gateway manifest.
 */

const schema: PluginConfigField[] = [
  { key: 'enabled', type: 'boolean', default: true },
  { key: 'count', type: 'number', default: 3, min: 1, max: 10 },
  { key: 'label', type: 'string', default: 'x' },
  { key: 'tags', type: 'string[]', default: ['a'] },
  { key: 'mode', type: 'enum', values: ['fast', 'slow'], default: 'fast' },
];

describe('plugin config: validation', () => {
  it('fills defaults when nothing is stored', () => {
    const { values, warnings } = validatePluginConfig(schema, {});
    assert.deepEqual(values, { enabled: true, count: 3, label: 'x', tags: ['a'], mode: 'fast' });
    assert.deepEqual(warnings, []);
  });

  it('accepts valid stored values', () => {
    const { values } = validatePluginConfig(schema, { enabled: false, count: 7, label: 'y', tags: ['b', 'c'], mode: 'slow' });
    assert.deepEqual(values, { enabled: false, count: 7, label: 'y', tags: ['b', 'c'], mode: 'slow' });
  });

  it('falls back to the default on a wrong-typed or out-of-range value', () => {
    const { values, warnings } = validatePluginConfig(schema, { enabled: 'yes', count: 99, tags: 'nope', mode: 'warp' });
    assert.deepEqual(values, { enabled: true, count: 3, label: 'x', tags: ['a'], mode: 'fast' });
    assert.equal(warnings.length, 4);
  });

  it('drops unknown keys with a warning', () => {
    const { values, warnings } = validatePluginConfig(schema, { bogus: 1 });
    assert.equal(values.bogus, undefined);
    assert.ok(warnings.some((w) => w.includes('bogus')));
  });

  it('exposes nothing for a plugin without a schema', () => {
    const { values, warnings } = validatePluginConfig(undefined, { sneaky: 1 });
    assert.deepEqual(values, {});
    assert.ok(warnings.length > 0);
  });
});

describe('plugin config: artifact store', () => {
  it('persists only non-default values and merges them back', () => {
    const id = 'test-plugin-artifact';
    const written = writePluginConfig(id, schema, { count: 5 });
    assert.equal(written.values.count, 5);
    assert.equal(written.values.label, 'x', 'defaults survive the merge');

    const stored = JSON.parse(fs.readFileSync(pluginConfigPath(id), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(stored, { count: 5 }, 'defaults are never duplicated into the artifact');
    assert.deepEqual(mergedPluginConfig(id, schema), written.values);
  });

  it('a corrupt artifact degrades to defaults, never throws', () => {
    const id = 'test-plugin-corrupt';
    fs.mkdirSync(pluginConfigPath(id).replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    fs.writeFileSync(pluginConfigPath(id), '{not json');
    invalidatePluginConfigCache(id);
    assert.deepEqual(readStoredConfig(id), {});
    assert.equal(mergedPluginConfig(id, schema).count, 3);
  });

  it('invalidation re-reads a hand-edited artifact', () => {
    const id = 'test-plugin-reload';
    writePluginConfig(id, schema, { count: 4 });
    assert.equal(mergedPluginConfig(id, schema).count, 4);
    fs.writeFileSync(pluginConfigPath(id), JSON.stringify({ count: 9 }));
    invalidatePluginConfigCache(id);
    assert.equal(mergedPluginConfig(id, schema).count, 9);
  });
});

// cursor-gateway lives in the gitignored dev tree (/plugins/ is in
// .gitignore) and is absent on a fresh clone / CI. Bun's node:test compat
// layer ignores the `skip` option, so registration stays conditional and the
// whole describe is only registered when the dev tree exists.
const cursorPluginJson = path.resolve(import.meta.dirname, '../../plugins/cursor-gateway/plugin.json');
if (fs.existsSync(cursorPluginJson)) {
  describe('plugin config: host read/apply against the dev tree', () => {
    it('cursor-gateway declares its schema and answers merged values', async () => {
      const { loadInstalledPlugins, getPluginConfig, applyPluginConfig } = await import('../src/plugins/host.js');
      await loadInstalledPlugins();
      const cfg = getPluginConfig('cursor-gateway');
      assert.ok(cfg, 'cursor-gateway must be loaded from the dev tree');
      const keys = cfg!.schema.map((f) => f.key);
      assert.ok(keys.includes('toolTimeoutMs'));
      assert.ok(keys.includes('relayUnknownPaths'));
      assert.ok(keys.includes('debugFrames'));
      assert.equal(cfg!.values.toolTimeoutMs, 0);
      assert.equal(cfg!.values.relayUnknownPaths, true);

      const applied = await applyPluginConfig('cursor-gateway', { toolTimeoutMs: 5000, relayUnknownPaths: false });
      assert.equal(applied.values.toolTimeoutMs, 5000);
      assert.equal(applied.values.relayUnknownPaths, false);
      const artifact = JSON.parse(fs.readFileSync(pluginConfigPath('cursor-gateway'), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(artifact, { toolTimeoutMs: 5000, relayUnknownPaths: false });
    });

    it('rejects unknown plugins and schema-less plugins', async () => {
      const { loadInstalledPlugins, applyPluginConfig } = await import('../src/plugins/host.js');
      await loadInstalledPlugins();
      await assert.rejects(() => applyPluginConfig('no-such-plugin', {}), /unknown or unloaded/);
      // qoder ships no configSchema → nothing to configure, writes rejected.
      await assert.rejects(() => applyPluginConfig('qoder', { x: 1 }), /no configurable fields/);
    });
  });
}
