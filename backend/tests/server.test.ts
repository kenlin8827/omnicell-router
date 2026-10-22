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
 * carry per-key model-access policies (a deny list hides ultra etc.),
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

  it('GET /v1/models returns an OpenAI envelope; /v1/catalog.json the models.dev map', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/v1/models',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body && body.object === 'list' && Array.isArray(body.data), 'expected OpenAI list envelope');
    const ids = body.data.map((m: any) => m.id);
    assert.ok(ids.includes('auto'), 'Expected virtual "auto" model');
    assert.ok(ids.includes('lite'));
    assert.ok(ids.includes('plus'));
    assert.ok(ids.includes('pro'));
    assert.ok(ids.includes('ultra'));
    // Every row carries the full models.dev capability block under metadata.
    const physical = body.data.find((m: any) => m.metadata?.cost);
    assert.ok(physical, 'Expected physical model with models.dev cost metadata');
    assert.strictEqual(typeof physical.metadata.cost.input, 'number');
    assert.strictEqual(typeof physical.metadata.cost.output, 'number');
    assert.strictEqual(typeof physical.metadata.cost.cache_read, 'number');

    // Provider-grouped capability catalog: same data, models.dev shape.
    const cat = await app.inject({ headers: authHeaders(), method: 'GET', url: '/v1/catalog.json' });
    assert.strictEqual(cat.statusCode, 200);
    const providers = JSON.parse(cat.body);
    assert.ok(providers && typeof providers === 'object' && !Array.isArray(providers), 'expected provider-map body');
    const catIds = Object.values(providers).flatMap((p: any) => Object.keys(p?.models ?? {}));
    assert.ok(catIds.includes('auto'));
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

  it('POST /v1/chat/completions with model="auto" should auto-route and attach routing headers', async () => {
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
    // Cost headers were removed with the cost-reporting layer — their absence
    // is now part of the contract.
    assert.equal('x-ocr-cost-usd' in res.headers, false);
    assert.equal('x-ocr-saved-usd' in res.headers, false);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'chat.completion');
    assert.ok(body.choices.length > 0);
  });

  it('POST /v1/chat/completions with a padded " lite " model still force-tiers to lite', async () => {
    // 'P=NP?' is classifier-plus content (see router.test.ts default-baseline
    // case): landing on lite proves the routing fork trimmed the padded
    // auto-alias — the trim tolerance the pre-dispatch server.ts handler had.
    // The surface must still pass `model` into process verbatim
    // (surface-chat.test.ts pins that half of the contract).
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: ' lite ',
        messages: [{ role: 'user', content: 'P=NP?' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['x-ocr-tier'], 'lite', 'padded lite must match the force-tier alias');
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

  it('GET /api/admin/metrics should expose FinOps token counters', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/metrics',
    });

    assert.strictEqual(res.statusCode, 200);
    const metrics = JSON.parse(res.body);
    assert.ok(metrics.totalRequests >= 2);
    assert.ok(metrics.tokens.totalInputTokens >= 0);
    // The economics block was removed with the cost-reporting layer.
    assert.equal('economics' in metrics, false);
  });
});
