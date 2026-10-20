import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';

/**
 * Collection gate toggle (POST /api/admin/flywheel/enabled) — hot-apply
 * contract: the flip travels through the process-level runtimeConfigRef into
 * the collector's section object and must take effect without a restart.
 *
 * This lives in its OWN file deliberately: a second createServer in the same
 * file re-registers runtimeConfigRef at collection time (last boot wins) and
 * would strand this server's collector on a stale section object.
 */
describe('Flywheel collection gate toggle (hot-apply)', () => {
  const tmpDir = path.resolve(process.cwd(), './data/test_fw_toggle');
  const datasetPath = path.join(tmpDir, 'flywheel.jsonl');
  const TEST_KEY = 'sk-ocr-flywheel-toggle-test';
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

  after(async () => {
    // Windows can hold the just-appended dataset file briefly (EBUSY); retry
    // with a small delay. A failed cleanup must never fail the file — the
    // next run's before() clears it anyway.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  });

  it('stats exposes the gate; off stops recording; on resumes without restart', async () => {
    const before = JSON.parse((await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' })).body);
    assert.strictEqual(before.collectionEnabled, true);

    const bad = await app.inject({ method: 'POST', url: '/api/admin/flywheel/enabled', payload: { enabled: 'yes' } });
    assert.strictEqual(bad.statusCode, 400);

    const off = await app.inject({ method: 'POST', url: '/api/admin/flywheel/enabled', payload: { enabled: false } });
    assert.strictEqual(off.statusCode, 200);
    assert.strictEqual(JSON.parse(off.body).collectionEnabled, false);

    const chatOff = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'flywheel gate-off probe' }] },
    });
    assert.strictEqual(chatOff.statusCode, 200);
    const mid = JSON.parse((await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' })).body);
    assert.strictEqual(mid.collectionEnabled, false);
    assert.strictEqual(mid.total, before.total, 'no rows recorded while the gate is off');

    const on = await app.inject({ method: 'POST', url: '/api/admin/flywheel/enabled', payload: { enabled: true } });
    assert.strictEqual(on.statusCode, 200);
    assert.strictEqual(JSON.parse(on.body).collectionEnabled, true);
    const chatOn = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'flywheel gate-on probe' }] },
    });
    assert.strictEqual(chatOn.statusCode, 200);
    const afterStats = JSON.parse((await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' })).body);
    assert.strictEqual(afterStats.collectionEnabled, true);
    assert.strictEqual(afterStats.total, before.total + 1, 'recording resumes immediately after re-enable');
  });
});
