import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';

/**
 * HTTP-level contract tests for the flywheel console endpoints, driven through
 * the REAL server (mock inference upstream): a live chat completion flows down
 * the actual orchestrator into the collector, then every endpoint is exercised
 * against what it recorded — status codes, error envelopes and the
 * relabel→query round-trip included.
 */
describe('Flywheel console API (server integration)', () => {
  const tmpDir = path.resolve(process.cwd(), './data/test_fw_http');
  const datasetPath = path.join(tmpDir, 'flywheel.jsonl');
  const TEST_KEY = 'sk-ocr-flywheel-http-test';
  const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${TEST_KEY}` });

  const config = loadConfig();
  config.host = '127.0.0.1';
  config.webAuth = { enabled: false };
  config.flywheel = { enabled: true, datasetPath, logUserPrompt: true };
  const { app } = createServer(config, true);

  before(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let recordedId: string | null = null;

  it('chat completion through the orchestrator lands in the dataset (stats endpoint)', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'flywheel integration probe' }] },
    });
    assert.strictEqual(res.statusCode, 200);

    const stats = await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' });
    assert.strictEqual(stats.statusCode, 200);
    const body = JSON.parse(stats.body);
    assert.ok(body.total >= 1, `expected at least one recorded row, got ${body.total}`);
    assert.ok(Array.isArray(body.tiers) && body.tiers.length === 4);
    // mock-mode upstreams carry mock-* ids — the collector must flag them.
    assert.strictEqual(body.synthetic, body.total);

    const samples = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?includeSynthetic=true&limit=5' });
    assert.strictEqual(samples.statusCode, 200);
    const sb = JSON.parse(samples.body);
    assert.ok(sb.rows.length >= 1);
    assert.ok(sb.rows[0].id, 'row carries an id');
    assert.ok(sb.rows[0].input ?? sb.rows[0].userPrompt !== undefined, 'row is materialized');
    recordedId = sb.rows[0].id;
  });

  it('relabelling: valid tier persists, unknown id 404s, bad tier 400s', async () => {
    assert.ok(recordedId, 'previous test must have recorded a row');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/admin/flywheel/samples/${encodeURIComponent(recordedId!)}`,
      payload: { tier: 'pro' },
    });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(JSON.parse(ok.body).label.tier, 'pro');
    assert.strictEqual(JSON.parse(ok.body).label.source, 'human');

    // Mock-mode rows are flagged synthetic and hidden by default — human
    // filtering must therefore include them explicitly.
    const filtered = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?source=human&includeSynthetic=true' });
    assert.strictEqual(JSON.parse(filtered.body).total, 1);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/admin/flywheel/samples/does-not-exist',
      payload: { tier: 'lite' },
    });
    assert.strictEqual(missing.statusCode, 404);

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/admin/flywheel/samples/${encodeURIComponent(recordedId!)}`,
      payload: { tier: 'turbo' },
    });
    assert.strictEqual(bad.statusCode, 400);
  });

  it('training endpoints: state shape, empty-pool 400, rollback 404, labels reset', async () => {
    const state = await app.inject({ method: 'GET', url: '/api/admin/flywheel/training' });
    assert.strictEqual(state.statusCode, 200);
    const st = JSON.parse(state.body);
    assert.ok(['idle', 'training', 'success', 'failed'].includes(st.status));
    assert.strictEqual(typeof st.model.routingConsumesModel, 'boolean');
    assert.strictEqual(typeof st.model.featureDimensions, 'number');

    // Mock rows are synthetic and (being mock fixtures) excluded from training;
    // the pool is empty, so the run must fail with a 400 and a clear reason.
    const train = await app.inject({
      method: 'POST',
      url: '/api/admin/flywheel/training',
      payload: {},
    });
    assert.strictEqual(train.statusCode, 400);
    assert.match(JSON.parse(train.body).error, /No trainable samples/);

    const rb = await app.inject({ method: 'POST', url: '/api/admin/flywheel/model/rollback' });
    assert.strictEqual(rb.statusCode, 404);

    const cleared = await app.inject({ method: 'DELETE', url: '/api/admin/flywheel/labels' });
    assert.strictEqual(cleared.statusCode, 200);
    assert.strictEqual(JSON.parse(cleared.body).cleared, 1);

    const afterClear = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?source=human&includeSynthetic=true' });
    assert.strictEqual(JSON.parse(afterClear.body).total, 0);
  });
});
