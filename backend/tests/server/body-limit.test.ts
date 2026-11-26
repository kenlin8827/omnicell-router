import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../../src/config/index.js';
import { createServer } from '../../src/server.js';
import { GATEWAY_MAX_BODY_BYTES } from '../../src/config/defaults.js';
import { bodyLimitFor, configureBodyLimits } from '../../src/surfaces/body-admission.js';

/**
 * Inference body admission on the NATIVE (Fastify) leg.
 *
 * WHY THIS EXISTS: Fastify's default `bodyLimit` is 1 MiB and the surface
 * routes used to inherit it, so a real agent context (Claude Code / opencode
 * post several MB as a matter of course) was rejected with
 * `413 FST_ERR_CTP_BODY_TOO_LARGE` — while the MITM leg of the SAME gateway
 * admitted 32 MB, and the capture plane is sized for 16 MB bodies untruncated.
 * A silent 1 MiB ceiling is invisible until a user hits it, so the ceiling is
 * now one constant (config/defaults.ts) asserted here on both sides: bodies
 * above the framework default must PASS, bodies above the gateway cap must
 * fail with the surface's own envelope (never Fastify's
 * {statusCode, code, error, message} shape, which clients render as an opaque
 * `413 "Payload Too Large"`).
 *
 * Real `listen` + `fetch`, not `app.inject`: the point of the suite is the
 * HTTP body limit, so it must be exercised through the transport.
 */
const TEST_KEY = 'sk-ocr-bodylimit-test';

describe('native-leg request body cap (GATEWAY_MAX_BODY_BYTES)', () => {
  const config = loadConfig();
  config.host = '127.0.0.1';
  config.webAuth = { enabled: false };
  config.apiKeys = [
    {
      id: 'key-bodylimit-test',
      name: 'body-limit.test fixture',
      key: TEST_KEY,
      role: 'user',
      enabled: true,
      createdAt: new Date().toISOString(),
    },
  ];
  const { app } = createServer(config, true); // mockMode = true
  let base = '';

  const post = async (path: string, raw: string): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' },
      body: raw,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  };

  /** Chat body whose serialized size is at least `bytes`. */
  const chatBody = (bytes: number): string =>
    JSON.stringify({
      model: 'auto',
      messages: [{ role: 'system', content: 'x'.repeat(bytes) }, { role: 'user', content: 'hi' }],
    });

  before(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await app.close();
  });

  it('admits a body above the 1 MiB framework default on the chat wire', async () => {
    const raw = chatBody(2 * 1024 * 1024);
    assert.ok(raw.length > 1024 * 1024, 'fixture must exceed the framework default');
    assert.ok(raw.length < GATEWAY_MAX_BODY_BYTES, 'fixture must stay under the gateway cap');
    const { status, json } = await post('/v1/chat/completions', raw);
    assert.notEqual(status, 413, `2 MiB body must not be rejected: ${JSON.stringify(json)}`);
    assert.equal(status, 200, JSON.stringify(json));
  });

  it('admits a body above the 1 MiB framework default on the anthropic wire', async () => {
    const raw = JSON.stringify({
      model: 'auto',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] }],
    });
    const { status, json } = await post('/v1/messages', raw);
    assert.notEqual(status, 413, `2 MiB body must not be rejected: ${JSON.stringify(json)}`);
  });

  it('rejects past the cap with the SURFACE envelope, naming the limit', async () => {
    const raw = chatBody(GATEWAY_MAX_BODY_BYTES + 4 * 1024 * 1024);
    const { status, json } = await post('/v1/chat/completions', raw);
    assert.equal(status, 413);
    // OpenAI chat envelope: { error: { message, type, code } } — never the
    // Fastify default whose `error` is the reason-phrase STRING.
    assert.equal(typeof json?.error, 'object', JSON.stringify(json));
    assert.match(String(json.error.message), /32 MiB/);
    assert.equal(json.error.code, 'payload_too_large');
  });

  it('answers a malformed body in the surface envelope too', async () => {
    const { status, json } = await post('/v1/chat/completions', '{"model":"auto","messages":[');
    assert.equal(status, 400);
    assert.equal(typeof json?.error, 'object', JSON.stringify(json));
    assert.match(String(json.error.message), /JSON/i);
  });
});

describe('configured cap (client.bodyLimits, ADR-0008)', () => {
  // THE KNOB MUST NOT BE DECORATIVE. `client.bodyLimits` is read once at boot
  // (`configureBodyLimits` in `createServer`) and every consumer asks
  // `bodyLimitFor(plane)` afterwards, so a server booted with a small cap has to
  // refuse at THAT number and name it -- otherwise the operator edited a field
  // that nothing reads, which is the exact failure mode a schema bump hides.
  const config = loadConfig();
  config.host = '127.0.0.1';
  config.webAuth = { enabled: false };
  config.bodyLimits = { maxBytes: 128 * 1024, adminMaxBytes: 64 * 1024 };
  config.apiKeys = [
    {
      id: 'key-configured-cap',
      name: 'body-limit configured-cap fixture',
      key: TEST_KEY,
      role: 'user',
      enabled: true,
      createdAt: new Date().toISOString(),
    },
  ];
  const { app } = createServer(config, true);
  let base = '';

  before(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await app.close();
    // Module state is process-global: restore the shipped defaults so a later
    // suite in this process is not silently judged by this fixture's cap.
    configureBodyLimits(undefined);
  });

  it('installs the configured numbers as the effective caps', () => {
    assert.equal(bodyLimitFor('gateway'), 128 * 1024);
    assert.equal(bodyLimitFor('admin'), 64 * 1024);
  });

  it('refuses above the CONFIGURED cap and names it, not the shipped default', async () => {
    const raw = JSON.stringify({
      model: 'auto',
      messages: [{ role: 'system', content: 'x'.repeat(200 * 1024) }, { role: 'user', content: 'hi' }],
    });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' },
      body: raw,
    });
    const json = await res.json().catch(() => null);
    assert.equal(res.status, 413, JSON.stringify(json));
    // "128 KiB" is the configured value; "32 MiB" would mean the constant won.
    assert.match(String(json?.error?.message), /128 KiB/, JSON.stringify(json));
    assert.equal(json?.error?.code, 'payload_too_large');
  });

  it('still admits a body under the configured cap', async () => {
    const raw = JSON.stringify({
      model: 'auto',
      messages: [{ role: 'system', content: 'x'.repeat(64 * 1024) }, { role: 'user', content: 'hi' }],
    });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' },
      body: raw,
    });
    assert.notEqual(res.status, 413);
    await res.text();
  });

  it('falls back to the shipped constants when the section is absent', () => {
    configureBodyLimits(undefined);
    assert.equal(bodyLimitFor('gateway'), GATEWAY_MAX_BODY_BYTES);
    assert.equal(bodyLimitFor('admin'), 8 * 1024 * 1024);
    // Re-install this fixture's values for any later case in this describe.
    configureBodyLimits({ maxBytes: 128 * 1024, adminMaxBytes: 64 * 1024 });
  });
});
