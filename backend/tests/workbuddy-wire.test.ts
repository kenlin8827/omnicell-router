import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wireFor, baseForWire } from '../src/providers/wire.js';
import { protocolVocabulary } from '../src/providers/vocabulary.js';
import { claimPluginWires } from '../src/providers/plugin-wires.js';

// The workbuddy protocol implementation lives in the USER-INSTALLED plugin tree
// (untracked; each plugin is its own repository — root .gitignore). This file
// covers only the OCR-side wire resolution surface.
describe('workbuddy wire resolution', () => {
  it('does not resolve opencode package spellings itself (separate layer)', () => {
    assert.equal(wireFor('@opencode/ai/providers/workbuddy'), 'unroutable');
  });

  it('resolves the v1 workbuddy alias to the workbuddy wire', () => {
    assert.equal(wireFor('workbuddy'), 'workbuddy');
  });

  it('derives workbuddy from a platform-origin baseURL when npm is absent', () => {
    assert.equal(wireFor(undefined, 'https://copilot.tencent.com'), 'workbuddy');
    assert.equal(wireFor(undefined, 'https://www.workbuddy.ai'), 'workbuddy');
  });

  it('keeps the platform origin verbatim (no anthropic-style mount rewrite)', () => {
    assert.equal(baseForWire('workbuddy', 'https://www.workbuddy.ai'), 'https://www.workbuddy.ai');
  });

  it('offers the bare OCR-native protocol name in the vocabulary once the plugin claims it', () => {
    claimPluginWires(['workbuddy']);
    try {
      const entry = protocolVocabulary().find((e) => e.alias === 'workbuddy');
      assert.ok(entry, 'workbuddy vocabulary entry missing');
      assert.equal(entry.wire, 'workbuddy');
      assert.equal(wireFor(entry.package), 'workbuddy');
    } finally {
      claimPluginWires([]);
    }
  });

  it('migrates the fake npm alias to the bare protocol name', () => {
    assert.equal(wireFor('@ai-sdk/workbuddy'), 'workbuddy');
  });

  it('does not hijack lookalike packages', () => {
    assert.equal(wireFor('@opencode/ai/providers/workbuddy-cn'), 'unroutable');
    assert.notEqual(wireFor('@ai-sdk/openai-compatible'), 'workbuddy');
  });
});
