import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { validateApiKey, generateApiKey } from '../src/auth/api-keys.js';
import { RouterConfig } from '../src/config/types.js';

describe('API Key Authentication & Client Auth Flow', () => {
  const baseConfig = loadConfig();

  const testConfig: RouterConfig = {
    ...baseConfig,
    host: '127.0.0.1', // loopback: the webAuth forced gate stays off (see web-auth.test.ts)
    webAuth: { enabled: false }, // tests read the operator's live config.yaml via loadConfig() — never inherit its login gate
    adminApiKey: 'master-secret-key-1234',
    apiKeys: [
      {
        id: 'key-test-client',
        name: 'Cursor IDE',
        key: 'sk-ocr-test-client-valid',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'key-disabled-client',
        name: 'Disabled App',
        key: 'sk-ocr-test-disabled',
        enabled: false,
        createdAt: new Date().toISOString(),
      },
    ],
  };

  const { app } = createServer(testConfig, true);

  it('validateApiKey should correctly validate keys', () => {
    // 1. Missing
    assert.strictEqual(validateApiKey('', testConfig).valid, false);

    // 2. Master Admin Key
    const adminCheck = validateApiKey('master-secret-key-1234', testConfig);
    assert.strictEqual(adminCheck.valid, true);

    // 3. Valid Client Key
    const clientCheck = validateApiKey('sk-ocr-test-client-valid', testConfig);
    assert.strictEqual(clientCheck.valid, true);
    assert.strictEqual(clientCheck.keyConfig?.name, 'Cursor IDE');

    // 4. Disabled Key
    const disabledCheck = validateApiKey('sk-ocr-test-disabled', testConfig);
    assert.strictEqual(disabledCheck.valid, false);
    assert.strictEqual(disabledCheck.error, 'API key is disabled');

    // 5. Non-existent Key
    const invalidCheck = validateApiKey('sk-ocr-non-existent', testConfig);
    assert.strictEqual(invalidCheck.valid, false);
  });

  it('generateApiKey should produce sk-ocr prefix and unique keys', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    assert.ok(k1.startsWith('sk-ocr-'));
    assert.notStrictEqual(k1, k2);
  });

  it('Server should block requests with 401 when auth is configured and key is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.strictEqual(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, 'missing_api_key');
  });

  it('Server should block requests with 401 when key is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer sk-ocr-wrong-key',
      },
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.strictEqual(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, 'invalid_api_key');
  });

  it('Server should allow requests with valid client API Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer sk-ocr-test-client-valid',
      },
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
  });

  it('Server should allow requests with x-api-key header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-api-key': 'sk-ocr-test-client-valid',
      },
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
  });

  it('Server should whitelist health and UI API endpoints without auth header', async () => {
    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    assert.strictEqual(healthRes.statusCode, 200);

    const uiStatusRes = await app.inject({ method: 'GET', url: '/api/admin/status' });
    assert.strictEqual(uiStatusRes.statusCode, 200);
  });
});
