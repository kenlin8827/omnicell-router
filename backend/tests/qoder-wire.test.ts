import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wireFor, baseForWire } from '../src/providers/wire.js';
import { protocolVocabulary } from '../src/providers/vocabulary.js';
import { claimPluginWires } from '../src/providers/plugin-wires.js';
import { currentPackageFor } from '../src/opencode/user-config.js';

// The qoder protocol implementation lives in the USER-INSTALLED plugin tree
// (untracked; each plugin is its own repository — root .gitignore). The tests
// for that implementation live beside it in plugins/qoder-models/tests/; this file
// covers only the OCR-side wire resolution surface.
describe('qoder wire resolution', () => {
  it('is unrelated to opencode package spellings', () => {
    assert.equal(wireFor('@opencode/ai/providers/qoder'), 'unroutable');
  });

  it('resolves the v1 qoder alias to the qoder wire', () => {
    assert.equal(wireFor('qoder'), 'qoder');
  });

  it('derives qoder from a qoder exchange-gateway baseURL when npm is absent', () => {
    assert.equal(wireFor(undefined, 'https://openapi.qoder.sh'), 'qoder');
    assert.equal(wireFor(undefined, 'https://openapi.qoder.com.cn'), 'qoder');
  });

  it('keeps the exchange-gateway base verbatim (no anthropic-style mount rewrite)', () => {
    assert.equal(baseForWire('qoder', 'https://openapi.qoder.sh'), 'https://openapi.qoder.sh');
  });

  it('offers the bare OCR-native protocol name in the vocabulary once the plugin claims it', () => {
    // The vocabulary derives its plugin half from the loaded plugin registry —
    // no core table names the protocol. Claiming the wire IS "the plugin is
    // installed" as far as the dropdown is concerned.
    claimPluginWires(['qoder']);
    try {
      const entry = protocolVocabulary().find((e) => e.alias === 'qoder');
      assert.ok(entry, 'qoder vocabulary entry missing');
      assert.equal(entry.wire, 'qoder');
      assert.equal(wireFor(entry.package), 'qoder');
    } finally {
      claimPluginWires([]);
    }
  });

  it('is not offered while no plugin claims the wire', () => {
    claimPluginWires([]);
    assert.equal(protocolVocabulary().find((e) => e.alias === 'qoder'), undefined);
  });

  it('migrates the fake npm alias to the bare protocol name', () => {
    assert.equal(wireFor('@ai-sdk/qoder'), 'qoder');
    assert.equal(currentPackageFor('@ai-sdk/qoder'), 'qoder');
  });

  it('does not hijack lookalike packages', () => {
    assert.equal(wireFor('@opencode/ai/providers/qoder-cn'), 'unroutable');
    assert.notEqual(wireFor('@ai-sdk/openai-compatible'), 'qoder');
  });
});
