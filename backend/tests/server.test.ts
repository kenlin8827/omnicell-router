import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';

/**
 * Auth mirror of server.ts preHandler key resolution: when the local
 * config.yaml defines apiKeys, inference endpoints require a valid key even
 * though the test config passes none (disk keys win over the test config by
 * design). Reuse the first enabled disk key so the e2e cases run both on
 * machines with a populated config.yaml and in clean CI checkouts.
 */
/**
 * Fixed test credential — NOT read from disk config.yaml. Real disk keys may
 * carry per-key model-access policies (a deny list hides auto-ultra etc.),
 * which would make the full-catalog assertions environment-dependent. A
 * policy-less key injected into the boot config sees everything, always.
 */
const TEST_KEY = 'sk-ocr-server-test-no-policy';
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${TEST_KEY}` });

describe('Fastify Gateway Server & OpenAI Endpoints', () => {
  const config = loadConfig();
  // Tests must not inherit the operator's live config.yaml webAuth gate
  // (console endpoints would 401 for the fixture key): force it off.
  config.host = '127.0.0.1';
  config.webAuth = { enabled: false };
  config.apiKeys = [
    {
      id: 'key-server-test',
      name: 'server.test fixture',
      key: TEST_KEY,
      role: 'user',
      enabled: true,
      createdAt: new Date().toISOString(),
    },
  ];
  const { app } = createServer(config, true); // mockMode = true

  it('GET /health should return 200 and healthy status', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/health',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.modelsRegistered > 0);
  });

  it('GET /v1/models should return virtual cascading models (auto) and physical models', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/models',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'list');
    const ids = body.data.map((m: any) => m.id);
    assert.ok(ids.includes('auto'), 'Expected virtual "auto" model');
    assert.ok(ids.includes('auto-lite'));
    assert.ok(ids.includes('auto-plus'));
    assert.ok(ids.includes('auto-pro'));
    assert.ok(ids.includes('auto-ultra'));

    const physical = body.data.find((m: any) => m.metadata?.pricing);
    assert.ok(physical, 'Expected physical model with pricing metadata');
    assert.strictEqual(typeof physical.metadata.pricing.input, 'number');
    assert.strictEqual(typeof physical.metadata.pricing.output, 'number');
    assert.strictEqual(typeof physical.metadata.pricing.cacheRead, 'number');
  });

  it('GET /v1/models/:model should return single model definition', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/models/auto',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.id, 'auto');
    assert.strictEqual(body.object, 'model');
  });

  it('POST /v1/chat/completions with model="auto" should auto-route and attach FinOps headers', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'What is the speed of light?' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(['lite', 'plus'].includes(res.headers['x-ocr-tier'] as string));
    assert.ok(res.headers['x-ocr-session-id']);
    assert.ok(res.headers['x-ocr-cost-usd']);
    assert.ok(res.headers['x-ocr-saved-usd']);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'chat.completion');
    assert.ok(body.choices.length > 0);
  });

  it('POST /v1/chat/completions with reasoning_effort emits the X-OCR-Thinking-* headers', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'explain quantum entanglement' }],
        reasoning_effort: 'high',
      },
    });

    assert.strictEqual(res.statusCode, 200);
    // Requested must echo back regardless of whether the served model could
    // honor it (so the client always knows what they asked for).
    assert.strictEqual(res.headers['x-ocr-thinking-requested'], 'high');
    assert.ok(res.headers['x-ocr-thinking-actual'], 'must surface what was actually served');
    const degraded = res.headers['x-ocr-thinking-degraded'];
    assert.ok(degraded === 'true' || degraded === 'false', 'must be a boolean header');
  });

  it('omits X-OCR-Thinking-* headers when reasoning_effort is not set', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'plain prompt' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['x-ocr-thinking-requested'], undefined);
    assert.strictEqual(res.headers['x-ocr-thinking-actual'], undefined);
    assert.strictEqual(res.headers['x-ocr-thinking-degraded'], undefined);
  });

  it('POST /v1/chat/completions with stream=true should stream Server-Sent Events', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'Say hello in streaming mode' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
    assert.ok(res.body.includes('data: {"id":'));
    assert.ok(res.body.includes('chat.completion.chunk'));
    assert.ok(res.body.includes('data: [DONE]'));
  });

  it('POST /v1/messages (Anthropic protocol) should auto-route and return a message envelope', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'auto',
        max_tokens: 1024,
        system: 'You are a helpful router test assistant.',
        messages: [{ role: 'user', content: 'What is the speed of light?' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(['lite', 'plus'].includes(res.headers['x-ocr-tier'] as string));
    assert.ok(res.headers['x-ocr-session-id']);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'message');
    assert.strictEqual(body.role, 'assistant');
    assert.ok(Array.isArray(body.content) && body.content[0].type === 'text');
    assert.ok(body.content[0].text.length > 0);
    assert.ok(['end_turn', 'max_tokens', 'tool_use', 'refusal'].includes(body.stop_reason));
    assert.strictEqual(typeof body.usage.input_tokens, 'number');
    assert.strictEqual(typeof body.usage.output_tokens, 'number');
  });

  it('POST /v1/messages with stream=true should emit Anthropic SSE event sequence', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'auto',
        stream: true,
        max_tokens: 512,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello in streaming mode' }] }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
    assert.ok(res.body.includes('event: message_start'));
    assert.ok(res.body.includes('event: content_block_start'));
    assert.ok(res.body.includes('event: content_block_delta'));
    assert.ok(res.body.includes('"type":"text_delta"'));
    assert.ok(res.body.includes('event: content_block_stop'));
    assert.ok(res.body.includes('event: message_delta'));
    assert.ok(res.body.includes('event: message_stop'));
  });

  it('POST /v1/messages without messages should return an Anthropic-style 400 error', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'auto', max_tokens: 64 },
    });

    assert.strictEqual(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.type, 'error');
    assert.strictEqual(body.error.type, 'invalid_request_error');
  });

  it('GET /api/admin/metrics should expose FinOps economics summary', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/metrics',
    });

    assert.strictEqual(res.statusCode, 200);
    const metrics = JSON.parse(res.body);
    assert.ok(metrics.totalRequests >= 2);
    assert.ok(metrics.economics.totalSavingsUsd >= 0);
  });
});
