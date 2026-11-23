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
    assert.deepEqual(parts, [{ type: 'client-gateway', hosts: ['api.example.com'], wires: undefined, egress: undefined }]);
  });

  it("carries the single-part `egress` into the normalized part", () => {
    // A shorthand the normalizer drops is a declaration that silently stops
    // existing — the same one-truth failure `wires`/`hosts` already guard.
    const parts = normalizePluginParts(
      base({ type: 'client-gateway', hosts: ['api.example.com'], egress: 'proxy' }) as never
    );
    assert.equal(parts[0]?.egress, 'proxy');
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

/**
 * The claim's outbound-leg declaration (ADR-0018 step 3). The value is a LEG
 * name, not an address, so the vocabulary is closed; the refusals are what keep
 * its reach equal to the claim.
 */
describe('plugin parts: the claimed-host egress declaration', () => {
  it('accepts the three-state vocabulary on a client-gateway part', () => {
    for (const egress of ['inherit', 'proxy', 'direct']) {
      check({ parts: [{ type: 'client-gateway', hosts: ['api.example.com'], egress }] });
      check({ type: 'client-gateway', hosts: ['api.example.com'], egress });
    }
  });

  it('refuses anything else — an address is not a leg', () => {
    assert.throws(
      () => check({ parts: [{ type: 'client-gateway', hosts: ['api.example.com'], egress: 'http://127.0.0.1:7890' }] }),
      /must be 'inherit', 'proxy' or 'direct'/
    );
    assert.throws(() => check({ type: 'client-gateway', hosts: ['api.example.com'], egress: true }), /must be 'inherit', 'proxy' or 'direct'/);
  });

  it('refuses a declaration riding a wildcard claim', () => {
    // `'*'` is not a host: this combination would pin the egress of every host
    // the machine reaches, which is the whole reason a claim may not do that.
    assert.throws(
      () => check({ parts: [{ type: 'client-gateway', hosts: ['*'], egress: 'proxy' }] }),
      /cannot ride a wildcard claim/
    );
    assert.throws(() => check({ type: 'client-gateway', hosts: ['*'], egress: 'direct' }), /cannot ride a wildcard claim/);
  });

  it('refuses a declaration on a part that claims no host', () => {
    assert.throws(
      () => check({ parts: [{ type: 'client-adapter', egress: 'proxy' }] }),
      /only a client-gateway part claims hosts/
    );
    assert.throws(
      () => check({ parts: [{ type: 'model-service', wires: ['demo'], egress: 'proxy' }] }),
      /only a client-gateway part claims hosts/
    );
    assert.throws(() => check({ type: 'model-service', wires: ['demo'], egress: 'proxy' }), /only a client-gateway plugin claims hosts/);
  });
});
