import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CA_CN, resolveCaDir } from '../src/forward-proxy/ca.js';

/**
 * Contract tests for GET /api/admin/proxy/ca/meta — the identity behind the
 * console's CA card (path, SHA-256 fingerprint, subject, validity).
 *
 * The card exists so an operator can check that the root they installed is the
 * root this proxy signs with, so the endpoint must (a) resolve the SAME CA dir
 * the proxy uses and (b) never leak key material. The isolated runner pins
 * OCR_CA_DIR into the sandbox, so the CA generated here is the test's own.
 */
describe('Forward-proxy CA identity (GET /api/admin/proxy/ca/meta)', () => {
  const baseConfig = loadConfig();
  baseConfig.host = '127.0.0.1';
  baseConfig.webAuth = { enabled: false };
  const { app } = createServer(baseConfig, true);

  const caDir = resolveCaDir();

  before(() => {
    // Start from an empty dir so the assertions describe a freshly minted CA.
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it('returns the persisted CA identity without key material', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy/ca/meta' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.status, 'ok');
    assert.equal(body.path, path.join(caDir, 'ca.pem'));
    assert.ok(fs.existsSync(body.path), 'the endpoint materialises the CA it describes');
    // X509Certificate.fingerprint256 — colon-separated uppercase hex.
    assert.match(body.fingerprintSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.ok(body.subject.includes(CA_CN), `subject names the CA: ${body.subject}`);
    assert.match(body.subject, /OU=CA [0-9a-f]{8}/);
    assert.ok(Date.parse(body.notAfter) > Date.parse(body.notBefore));
    assert.doesNotMatch(res.body, /PRIVATE KEY/, 'the endpoint must never ship key material');
  });

  it('is stable across calls (the CA is loaded, not re-minted)', async () => {
    const first = (await app.inject({ method: 'GET', url: '/api/admin/proxy/ca/meta' })).json();
    const second = (await app.inject({ method: 'GET', url: '/api/admin/proxy/ca/meta' })).json();
    assert.equal(second.fingerprintSha256, first.fingerprintSha256);
    assert.equal(second.notAfter, first.notAfter);
  });
});
