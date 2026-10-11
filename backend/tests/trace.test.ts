import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';

/**
 * Auth mirror of server.ts preHandler key resolution: when the local
 * config.yaml defines apiKeys, inference endpoints require a valid key even
 * though the test config passes none (disk keys win over the test config by
 * design). Reuse the first enabled disk key so the e2e cases run both on
 * machines with a populated config.yaml and in clean CI checkouts.
 */
const authHeaders = (): Record<string, string> => {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
};

describe('Session Details & Trajectory Trace Observability Endpoints', () => {
  let app: FastifyInstance;

  before(async () => {
    const config = loadConfig();
    const serverBundle = createServer(config, true);
    app = serverBundle.app;
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('POST /v1/chat/completions should attach X-OCR-Trace-ID and record execution trajectory', async () => {
    const res = await app.inject({
      headers: { ...authHeaders(), 'x-session-id': 'sess_unit_test_trace_1' },
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello, what is 2 + 2?' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const traceId = res.headers['x-ocr-trace-id'] as string;
    const sessionId = res.headers['x-ocr-session-id'] as string;

    assert.ok(traceId, 'Response header must contain X-OCR-Trace-ID');
    // The trace id is the OpenTelemetry traceId shared with the capture
    // event stream: a 32-hex string when minted locally (no inbound
    // traceparent / x-request-id headers in this request).
    assert.match(traceId, /^[0-9a-f]{32}$/, 'Trace ID should be a 32-hex OTel traceId');
    assert.strictEqual(sessionId, 'sess_unit_test_trace_1');
  });

  it('GET /api/admin/sessions should list active sessions with traceCount', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'list');
    assert.ok(body.total >= 1);

    const found = body.data.find((s: any) => s.id === 'sess_unit_test_trace_1');
    assert.ok(found, 'Session sess_unit_test_trace_1 should be listed');
    assert.ok(found.traceCount >= 1, 'Session should have traceCount >= 1');
    assert.ok(found.maxTier);
    assert.ok(typeof found.switchCount === 'number', 'switchCount must be reported');
    assert.ok(typeof found.cacheHits === 'number', 'cacheHits must be reported');
    assert.ok(typeof found.savedCostUsd === 'number', 'savedCostUsd must be reported');

    // q filter: substring match over session id, applied before pagination
    const filtered = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions?q=sess_unit_test',
    });
    assert.strictEqual(filtered.statusCode, 200);
    const fb = JSON.parse(filtered.body);
    assert.ok(fb.total >= 1, 'q filter should match the test session');
    assert.ok(fb.data.every((s: any) => String(s.id).includes('sess_unit_test')));

    const noMatch = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions?q=zzz_no_such_session_zzz',
    });
    assert.strictEqual(JSON.parse(noMatch.body).total, 0, 'q filter with no hit must return empty');
  });

  it('GET /api/admin/sessions/:id should return single session details with recent traces', async () => {
    // 1. Success case
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions/sess_unit_test_trace_1',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'session');
    assert.strictEqual(body.id, 'sess_unit_test_trace_1');
    assert.ok(body.traceCount >= 1);
    assert.ok(Array.isArray(body.recentTraces));
    assert.ok(body.recentTraces.length >= 1);

    // 2. 404 Not Found case
    const notFoundRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions/non_existent_session_id',
    });
    assert.strictEqual(notFoundRes.statusCode, 404);
  });

  it('GET /api/admin/sessions/:id/traces should return chronological trajectory for the session', async () => {
    // Make a 2nd turn on the same session
    await app.inject({
      headers: { ...authHeaders(), 'x-session-id': 'sess_unit_test_trace_1' },
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Hello, what is 2 + 2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'Now multiply that by 10' },
        ],
      },
    });

    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions/sess_unit_test_trace_1/traces',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'list');
    assert.strictEqual(body.sessionId, 'sess_unit_test_trace_1');
    assert.strictEqual(body.total, 2, 'Session should have exactly 2 trajectory steps');
    assert.strictEqual(body.data.length, 2);

    // Check trajectory step structure
    const firstTurn = body.data[0];
    assert.ok(firstTurn.traceId);
    assert.strictEqual(firstTurn.turnNumber, 1);
    assert.ok(firstTurn.request);
    assert.ok(firstTurn.routing);
    assert.ok(firstTurn.execution);
    assert.ok(firstTurn.finops);

    const secondTurn = body.data[1];
    assert.strictEqual(secondTurn.turnNumber, 2);
    assert.ok(secondTurn.timestamp >= firstTurn.timestamp);
  });

  it('GET /api/admin/traces should list global traces and support filtering by session_id', async () => {
    // 1. Global list
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/traces?limit=10',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'list');
    assert.ok(body.total >= 2);
    assert.ok(body.data.length >= 2);

    // 2. Filtered by session_id
    const filterRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/traces?session_id=sess_unit_test_trace_1',
    });
    assert.strictEqual(filterRes.statusCode, 200);
    const filterBody = JSON.parse(filterRes.body);
    assert.strictEqual(filterBody.total, 2);
    assert.ok(filterBody.data.every((t: any) => t.sessionId === 'sess_unit_test_trace_1'));
  });

  it('GET /api/admin/traces/:id should return single trace or 404', async () => {
    // Get existing trace ID from session traces
    const listRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions/sess_unit_test_trace_1/traces',
    });
    const listBody = JSON.parse(listRes.body);
    const sampleTraceId = listBody.data[0].traceId;

    // 1. Success query
    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: `/api/admin/traces/${sampleTraceId}`,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.object, 'trace');
    assert.strictEqual(body.traceId, sampleTraceId);
    assert.strictEqual(body.sessionId, 'sess_unit_test_trace_1');

    // 2. 404 query
    const notFoundRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/traces/trace_non_existent_12345',
    });
    assert.strictEqual(notFoundRes.statusCode, 404);
  });

  it('DELETE /api/admin/sessions/:id should delete the session and its traces', async () => {
    const delRes = await app.inject({
      headers: authHeaders(),
      method: 'DELETE',
      url: '/api/admin/sessions/sess_unit_test_trace_1',
    });
    assert.strictEqual(delRes.statusCode, 200);
    const delBody = JSON.parse(delRes.body);
    assert.strictEqual(delBody.status, 'ok');

    // Verify session is gone
    const checkRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions/sess_unit_test_trace_1',
    });
    assert.strictEqual(checkRes.statusCode, 404);

    // Verify traces for this session are cleared
    const traceRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions/sess_unit_test_trace_1/traces',
    });
    const traceBody = JSON.parse(traceRes.body);
    assert.strictEqual(traceBody.total, 0);
  });

  it('GET /api/admin/traces should support ?since=<epoch-ms> time-window filter', async () => {
    // Inject one more turn under a fresh session so we have a known trace
    // set that survives the DELETE above.
    const sessId = 'sess_unit_test_since_filter';
    await app.inject({
      headers: { ...authHeaders(), 'x-session-id': sessId },
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'ping' }] },
    });

    const now = Date.now();

    // (1) Future cutoff — must drop everything for this session.
    const futureRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: `/api/admin/traces?session_id=${sessId}&since=${now + 60_000}`,
    });
    assert.strictEqual(futureRes.statusCode, 200);
    const futureBody = JSON.parse(futureRes.body);
    assert.strictEqual(futureBody.total, 0, 'since=future must filter out all traces');
    assert.strictEqual(futureBody.data.length, 0);
    assert.strictEqual(futureBody.since, now + 60_000, 'since should round-trip in the response');

    // (2) Past cutoff — must include the trace we just recorded.
    const pastRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: `/api/admin/traces?session_id=${sessId}&since=${now - 60_000}`,
    });
    assert.strictEqual(pastRes.statusCode, 200);
    const pastBody = JSON.parse(pastRes.body);
    assert.ok(pastBody.total >= 1, 'since=past must include the freshly recorded trace');
    assert.ok(pastBody.data.every((t: any) => t.timestamp >= now - 60_000), 'every returned trace must respect since');

    // (3) Garbage value — must NOT 4xx; must NOT echo `since`; must fall
    // back to the no-window behavior (entire ring).
    const garbageRes = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/traces?since=not-a-number',
    });
    assert.strictEqual(garbageRes.statusCode, 200);
    const garbageBody = JSON.parse(garbageRes.body);
    assert.strictEqual(garbageBody.since, undefined, 'garbage since must be dropped silently');
    assert.ok(garbageBody.total >= 1, 'no-window default must still return everything');
  });
});
