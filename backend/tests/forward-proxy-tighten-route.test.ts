import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, saveConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { lintRules } from '../src/forward-proxy/rules.js';

/**
 * POST /api/admin/forward-proxy/tighten (ADR-0018 Revision 4).
 *
 * The one-click migration exists because an install that predates the claims
 * posture still carries the old `* → intercept` catch-all. Its contract is
 * narrow: rewrite the CATCH-ALL's ingress to a blind tunnel, keep its egress,
 * pin the posture to `claims` — and leave every other row byte-identical.
 * Tightening must never be a way to lose rules the operator typed, and a second
 * click must be a no-op rather than a rewrite.
 */
describe('POST /api/admin/forward-proxy/tighten', () => {
  const SEEDED = [
    { match: '*', ingress: 'intercept' as const, egress: 'proxy' as const },
    { match: 'api.corp.test', ingress: 'intercept' as const, egress: 'proxy' as const },
    { match: '*.video.test', ingress: 'passthrough' as const, egress: 'direct' as const },
  ];

  before(() => {
    const seeded = saveConfig({ forwardProxy: { intercept: 'all', rules: SEEDED } });
    assert.equal(seeded.success, true);
    // The route reads the LIVE config when one exists, else the loaded file.
    // Seeding through saveConfig covers both paths.
  });

  it('rewrites the catch-all only, keeps every other row, pins the posture', async () => {
    const cfg = loadConfig();
    cfg.host = '127.0.0.1';
    cfg.webAuth = { enabled: false };
    const { app } = createServer(cfg);

    const res = await app.inject({ method: 'POST', url: '/api/admin/forward-proxy/tighten' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.status, 'ok');
    assert.equal(body.intercept, 'claims');
    assert.deepEqual(body.rules, [
      // Only the ingress of the catch-all moved; its egress rode along.
      { match: '*', ingress: 'passthrough', egress: 'proxy' },
      // An operator's explicit intercept row keeps decrypting under `claims`.
      { match: 'api.corp.test', ingress: 'intercept', egress: 'proxy' },
      { match: '*.video.test', ingress: 'passthrough', egress: 'direct' },
    ]);
    // The finding it exists to clear is gone.
    assert.equal(body.warnings.some((w: { code: string }) => w.code === 'catch-all-intercepts'), false);
    assert.deepEqual(body.warnings, lintRules(body.rules, cfg.proxy?.enabled === true, 'claims'));

    // Persisted, not just echoed: the file must agree with the response.
    const onDisk = loadConfig().forwardProxy;
    assert.equal(onDisk?.intercept, 'claims');
    assert.deepEqual(onDisk?.rules, body.rules);

    await app.close();
  });

  it('is idempotent — a second click writes the same table back', async () => {
    const cfg = loadConfig();
    cfg.host = '127.0.0.1';
    cfg.webAuth = { enabled: false };
    const { app } = createServer(cfg);

    const res = await app.inject({ method: 'POST', url: '/api/admin/forward-proxy/tighten' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().rules, [
      { match: '*', ingress: 'passthrough', egress: 'proxy' },
      { match: 'api.corp.test', ingress: 'intercept', egress: 'proxy' },
      { match: '*.video.test', ingress: 'passthrough', egress: 'direct' },
    ]);

    await app.close();
  });
});
