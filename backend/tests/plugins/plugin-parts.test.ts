import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePluginParts, validatePluginManifest } from '../../src/plugins/manifest.js';

/**
 * Multi-part manifests (ADR-0028).
 *
 * The manifest is the ONE place a package says which extension axes it
 * occupies. Two spellings are accepted — `type` for one axis, `parts` for any
 * subset — and they are mutually exclusive, because a manifest that states its
 * axes twice has two truths to drift apart. These cases pin that contract and
 * the per-part field rules the loader relies on.
 */

const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: 'demo',
  name: 'Demo',
  version: '0.0.1',
  apiVersion: 1,
  ...extra,
});

const check = (extra: Record<string, unknown>): void => validatePluginManifest(base(extra), 'demo/plugin.json');

describe('plugin parts: one axis, two spellings', () => {
  it('normalizes a single-part `type` manifest into one part', () => {
    const parts = normalizePluginParts(
      base({ type: 'client-gateway', hosts: ['api.example.com'] }) as never
    );
    assert.deepEqual(parts, [{ type: 'client-gateway', hosts: ['api.example.com'], wires: undefined }]);
  });

  it('normalizes `parts` in declaration order', () => {
    const manifest = base({
      parts: [{ type: 'client-adapter' }, { type: 'client-gateway', hosts: ['api.example.com'] }],
    });
    check(manifest);
    assert.deepEqual(
      normalizePluginParts(manifest as never).map((p) => p.type),
      ['client-adapter', 'client-gateway']
    );
  });

  it('rejects a manifest that names its axes twice', () => {
    assert.throws(
      () => check({ type: 'client-gateway', hosts: ['a.example.com'], parts: [{ type: 'client-gateway', hosts: ['a.example.com'] }] }),
      /declares both `type` and `parts`/
    );
  });

  it('rejects a manifest with no axis at all', () => {
    assert.throws(() => check({}), /needs `type` .* or `parts`/);
  });
});

describe('plugin parts: per-part field rules', () => {
  it('rejects the same axis twice (one instance per axis)', () => {
    assert.throws(
      () => check({ parts: [{ type: 'client-adapter' }, { type: 'client-adapter' }] }),
      /declares 'client-adapter' twice/
    );
  });

  it('requires hosts on a client-gateway part', () => {
    assert.throws(() => check({ parts: [{ type: 'client-gateway' }] }), /client-gateway part and needs a non-empty hosts array/);
    assert.throws(() => check({ parts: [{ type: 'client-gateway', hosts: [] }] }), /non-empty hosts array/);
  });

  it('requires wires on a model-service part', () => {
    assert.throws(() => check({ parts: [{ type: 'model-service' }] }), /model-service part and needs a non-empty wires array/);
  });

  it('refuses wires/hosts on a client-adapter part', () => {
    assert.throws(
      () => check({ parts: [{ type: 'client-adapter', hosts: ['a.example.com'] }] }),
      /client-adapter part — it contributes a Client Hub hook/
    );
  });

  it('rejects a blank string inside a claim list', () => {
    assert.throws(
      () => check({ parts: [{ type: 'client-gateway', hosts: ['api.example.com', '  '] }] }),
      /hosts must be a non-empty-string array/
    );
  });

  it('rejects top-level wires/hosts once parts are declared', () => {
    assert.throws(
      () => check({ hosts: ['api.example.com'], parts: [{ type: 'client-gateway', hosts: ['api.example.com'] }] }),
      /declares `hosts` on its client-gateway part/
    );
  });

  it('rejects an unknown part type', () => {
    assert.throws(() => check({ parts: [{ type: 'sidecar' }] }), /is not a plugin type/);
  });
});
