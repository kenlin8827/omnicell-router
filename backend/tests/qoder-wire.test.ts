import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wireFor, baseForWire } from '../src/providers/wire.js';
import { NPM_VOCABULARY, vocabularyAliasFor } from '../src/providers/vocabulary.js';

// The qoder protocol implementation lives in the USER-INSTALLED plugin tree
// (untracked; each plugin is its own repository — root .gitignore). The tests
// for that implementation live beside it in plugins/qoder/tests/; this file
// covers only the OCR-side wire resolution surface.
describe('qoder wire resolution', () => {
  it('resolves the opencode v2 qoder segment to the qoder wire', () => {
    assert.equal(wireFor('@opencode/ai/providers/qoder'), 'qoder');
  });

  it('resolves the v1 qoder alias to the qoder wire', () => {
    assert.equal(wireFor('@ai-sdk/qoder'), 'qoder');
  });

  it('derives qoder from a qoder exchange-gateway baseURL when npm is absent', () => {
    assert.equal(wireFor(undefined, 'https://openapi.qoder.sh'), 'qoder');
    assert.equal(wireFor(undefined, 'https://openapi.qoder.com.cn'), 'qoder');
  });

  it('keeps the exchange-gateway base verbatim (no anthropic-style mount rewrite)', () => {
    assert.equal(baseForWire('qoder', 'https://openapi.qoder.sh'), 'https://openapi.qoder.sh');
  });

  it('offers the alias in the npm vocabulary with the qoder wire on both spellings', () => {
    const entry = NPM_VOCABULARY.find((e) => e.alias === '@ai-sdk/qoder');
    assert.ok(entry, 'qoder vocabulary entry missing');
    assert.equal(entry.wire, 'qoder');
    assert.equal(wireFor(entry.package), 'qoder');
    assert.equal(vocabularyAliasFor(entry.package), '@ai-sdk/qoder');
  });

  it('matches opencode v2 segments EXACTLY — unknown segments stay unroutable', () => {
    assert.equal(wireFor('@opencode/ai/providers/qoder-cn'), 'unroutable');
    assert.notEqual(wireFor('@ai-sdk/openai-compatible'), 'qoder');
  });
});
