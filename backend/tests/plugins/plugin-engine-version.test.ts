import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SUPPORTED_PLUGIN_API,
  PLUGIN_ENGINE_VERSION,
  SUPPORTED_PLUGIN_API,
  pluginEngineCompatibility,
  pluginEngineRefusal,
  validatePluginManifest,
} from '../../src/plugins/manifest.js';

/**
 * The engine declaration (ADR-0036 Amendment 1). ONE integer, compared: a
 * package names the engine it was developed against in `apiVersion`, and the
 * host compares that with the engine it runs. There is no window — every case
 * below is written against the exported constants so an engine bump proves the
 * rule still behaves instead of failing on a stale literal.
 */

const manifest = (extra: Record<string, unknown> = {}) =>
  ({
    id: 'p',
    name: 'P',
    version: '1.0.0',
    apiVersion: SUPPORTED_PLUGIN_API,
    type: 'model-service',
    wires: ['w'],
    ...extra,
  }) as Parameters<typeof pluginEngineCompatibility>[0];

describe('plugin engine: one integer, two names', () => {
  it('keeps the engine version and the contract version the SAME number', () => {
    // The whole point of the amendment: `apiVersion` is the engine
    // declaration, so a second number would be a second truth for one fact.
    assert.equal(PLUGIN_ENGINE_VERSION, SUPPORTED_PLUGIN_API);
    assert.equal(MIN_SUPPORTED_PLUGIN_API, SUPPORTED_PLUGIN_API);
    assert.equal(Number.isInteger(PLUGIN_ENGINE_VERSION), true);
  });

  it('lets a package on this engine through, and says nothing about it', () => {
    const verdict = pluginEngineCompatibility(manifest());
    assert.equal(verdict.compatible, true);
    assert.equal(pluginEngineRefusal(manifest()), undefined);
  });

  it('refuses a contract NEWER than this engine, and points at the gateway', () => {
    const newer = manifest({ apiVersion: SUPPORTED_PLUGIN_API + 1 });
    const verdict = pluginEngineCompatibility(newer);
    assert.equal(verdict.compatible ? undefined : verdict.reason, 'contract-too-new');
    const refusal = pluginEngineRefusal(newer) ?? '';
    assert.match(refusal, /targets plugin contract \d+, newer than this gateway's/);
    // The remedy names the GATEWAY: reinstalling the same file moves nothing.
    assert.match(refusal, /update OmniCellRouter to use this plugin/);
  });

  it('refuses a RETIRED contract, and points at the PLUGIN', () => {
    // Distinct sentence on purpose: the operator's action is the opposite one.
    const retired = MIN_SUPPORTED_PLUGIN_API - 1;
    assert.ok(retired >= 0);
    const old = manifest({ apiVersion: retired });
    const verdict = pluginEngineCompatibility(old);
    assert.equal(verdict.compatible ? undefined : verdict.reason, 'contract-too-old');
    const refusal = pluginEngineRefusal(old) ?? '';
    assert.match(refusal, /no longer supports/);
    assert.match(refusal, /update the plugin to a newer release/);
  });

  it('judges by the DECLARATION, never by the package version', () => {
    // `version` is the package's own release and has no say in compatibility:
    // a brand-new package on a foreign contract is still refused.
    const v = pluginEngineCompatibility(manifest({ version: '99.0.0' }));
    assert.equal(v.compatible, true);
    assert.equal(pluginEngineCompatibility(manifest({ apiVersion: SUPPORTED_PLUGIN_API + 1, version: '0.0.1' })).compatible, false);
  });
});

describe('plugin engine: `engines` is retired', () => {
  it('ignores a legacy `engines` declaration instead of reading it', () => {
    // Old packages still carry the field. Reading it would resurrect the
    // second vocabulary; rejecting it would fail packages for a field that
    // used to be required. It is simply not read.
    const withLegacy = manifest({ engines: { plugin: '^99' } });
    assert.equal(pluginEngineCompatibility(withLegacy).compatible, true);
    assert.doesNotThrow(() => validatePluginManifest(withLegacy, 'plugin'));
  });

  it('no longer validates the old window grammar', () => {
    // `1.x` used to be a packaging failure; with the field retired it is just
    // an unread key, and refusing it would be validating a contract that no
    // longer exists.
    assert.doesNotThrow(() => validatePluginManifest(manifest({ engines: { plugin: '1.x' } }), 'plugin'));
  });

  it('still requires a POSITIVE INTEGER apiVersion', () => {
    for (const bad of [0, -1, 1.5, '1', null, undefined]) {
      assert.throws(
        () => validatePluginManifest(manifest({ apiVersion: bad }), 'plugin'),
        /apiVersion must be a positive integer/,
        String(bad)
      );
    }
  });
});