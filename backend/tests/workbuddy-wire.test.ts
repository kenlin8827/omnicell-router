import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wireFor, baseForWire } from '../src/providers/wire.js';
import { NPM_VOCABULARY, vocabularyAliasFor } from '../src/providers/vocabulary.js';

// The workbuddy protocol implementation lives in the USER-INSTALLED plugin tree
// (untracked; each plugin is its own repository — root .gitignore). This file
// covers only the OCR-side wire resolution surface.
describe('workbuddy wire resolution', () => {
  it('resolves the opencode v2 workbuddy segment to the workbuddy wire', () => {
    assert.equal(wireFor('@opencode/ai/providers/workbuddy'), 'workbuddy');
  });

  it('resolves the v1 workbuddy alias to the workbuddy wire', () => {
    assert.equal(wireFor('@ai-sdk/workbuddy'), 'workbuddy');
  });

  it('derives workbuddy from a platform-origin baseURL when npm is absent', () => {
    assert.equal(wireFor(undefined, 'https://copilot.tencent.com'), 'workbuddy');
    assert.equal(wireFor(undefined, 'https://www.workbuddy.ai'), 'workbuddy');
  });

  it('keeps the platform origin verbatim (no anthropic-style mount rewrite)', () => {
    assert.equal(baseForWire('workbuddy', 'https://www.workbuddy.ai'), 'https://www.workbuddy.ai');
  });

  it('offers the alias in the npm vocabulary with the workbuddy wire on both spellings', () => {
    const entry = NPM_VOCABULARY.find((e) => e.alias === '@ai-sdk/workbuddy');
    assert.ok(entry, 'workbuddy vocabulary entry missing');
    assert.equal(entry.wire, 'workbuddy');
    assert.equal(wireFor(entry.package), 'workbuddy');
    assert.equal(vocabularyAliasFor(entry.package), '@ai-sdk/workbuddy');
  });

  it('does not hijack lookalike segments or unrelated packages', () => {
    assert.equal(wireFor('@opencode/ai/providers/workbuddy-cn'), 'unroutable');
    assert.notEqual(wireFor('@ai-sdk/openai-compatible'), 'workbuddy');
  });
});
