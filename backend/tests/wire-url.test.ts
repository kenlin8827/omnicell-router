import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicMessagesUrl, baseForWire, wireFor } from '../src/providers/wire.js';

// Regression pin for the outbound Anthropic wire URL construction. A bulk
// find/replace once turned the `/v1` literals into `/opencode v1`, making
// every anthropic probe AND routed request 404 (e.g. minimax
// /anthropic/v1 → /anthropic/v1/opencode v1/messages). These asserts fail
// loudly if any URL literal ever grows a space again.

describe('anthropicMessagesUrl', () => {
  it('appends /messages to a /v1-suffixed base without doubling', () => {
    assert.strictEqual(
      anthropicMessagesUrl('https://api.minimax.cn/anthropic/v1'),
      'https://api.minimax.cn/anthropic/v1/messages'
    );
  });

  it('adds the missing /v1 for a bare base', () => {
    assert.strictEqual(
      anthropicMessagesUrl('https://api.anthropic.com'),
      'https://api.anthropic.com/v1/messages'
    );
  });

  it('tolerates trailing slashes', () => {
    assert.strictEqual(
      anthropicMessagesUrl('https://api.minimax.cn/anthropic/v1///'),
      'https://api.minimax.cn/anthropic/v1/messages'
    );
  });

  it('never emits a space in the constructed URL', () => {
    for (const base of ['https://a.example/anthropic/v1', 'https://b.example', 'https://c.example/v1/']) {
      assert.ok(!anthropicMessagesUrl(base).includes(' '), base);
    }
  });
});

describe('baseForWire', () => {
  it('translates the Zen OpenAI-compatible mount to the Anthropic mount', () => {
    assert.strictEqual(
      baseForWire('anthropic', 'https://zen.example/zen/v1'),
      'https://zen.example/inference/anthropic/v1'
    );
  });

  it('rewrites an /openai mount to /anthropic only on the anthropic wire', () => {
    assert.strictEqual(
      baseForWire('anthropic', 'https://gw.example/openai/v1'),
      'https://gw.example/anthropic/v1'
    );
    assert.strictEqual(
      baseForWire('openai', 'https://gw.example/openai/v1'),
      'https://gw.example/openai/v1'
    );
  });
});

describe('wireFor base hint', () => {
  it('detects the anthropic wire from a baseURL containing /anthropic', () => {
    assert.strictEqual(wireFor(undefined, 'https://api.minimax.cn/anthropic/v1'), 'anthropic');
  });
});
