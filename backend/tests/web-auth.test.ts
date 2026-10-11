import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { RouterConfig } from '../src/config/types.js';
import {
  checkLoginAllowed,
  createSessionToken,
  hashPassword,
  isLoopbackHost,
  isWebAuthActive,
  parseSessionCookie,
  recordLoginFailure,
  recordLoginSuccess,
  sessionSetCookie,
  SESSION_COOKIE,
  verifyPassword,
  verifySessionToken,
  validateWebAuthStartup,
  _setSessionSecretForTests,
} from '../src/auth/web-auth.js';

describe('web-auth core', () => {
  it('isLoopbackHost classifies loopback vs all-interfaces binds', () => {
    assert.strictEqual(isLoopbackHost('127.0.0.1'), true);
    assert.strictEqual(isLoopbackHost('127.9.9.9'), true);
    assert.strictEqual(isLoopbackHost('localhost'), true);
    assert.strictEqual(isLoopbackHost('::1'), true);
    assert.strictEqual(isLoopbackHost('[::1]'), true);
    assert.strictEqual(isLoopbackHost('0.0.0.0'), false);
    assert.strictEqual(isLoopbackHost('::'), false);
    assert.strictEqual(isLoopbackHost('192.168.1.10'), false);
    assert.strictEqual(isLoopbackHost(''), false);
    assert.strictEqual(isLoopbackHost(undefined), false);
  });

  it('hashPassword/verifyPassword roundtrip with scrypt format', () => {
    const stored = hashPassword('s3cret-pass');
    assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.strictEqual(verifyPassword('s3cret-pass', stored), true);
    assert.strictEqual(verifyPassword('wrong', stored), false);
    // Plaintext or garbage never verifies
    assert.strictEqual(verifyPassword('s3cret-pass', 's3cret-pass'), false);
    assert.strictEqual(verifyPassword('s3cret-pass', undefined), false);
    assert.strictEqual(verifyPassword('s3cret-pass', 'scrypt$$'), false);
  });

  it('session tokens verify, expire, and reject tampering', () => {
    const secret = Buffer.alloc(32, 7);
    _setSessionSecretForTests(secret);
    const now = 1_700_000_000_000;
    const token = createSessionToken(now, 60_000, secret);
    assert.strictEqual(verifySessionToken(token, now + 1000, secret), true);
    assert.strictEqual(verifySessionToken(token, now + 61_000, secret), false); // expired
    assert.strictEqual(verifySessionToken(token + '00', now + 1000, secret), false); // tampered
    assert.strictEqual(verifySessionToken('garbage', now + 1000, secret), false);
    assert.strictEqual(verifySessionToken(undefined, now + 1000, secret), false);
    // Wrong secret → invalid
    assert.strictEqual(verifySessionToken(token, now + 1000, Buffer.alloc(32, 8)), false);
  });

  it('parseSessionCookie extracts ocr_session from a Cookie header', () => {
    const token = '123.abc';
    assert.strictEqual(
      parseSessionCookie(`foo=bar; ${SESSION_COOKIE}=${token}; baz=qux`),
      token
    );
    assert.strictEqual(parseSessionCookie('other=x'), undefined);
    assert.strictEqual(parseSessionCookie(undefined), undefined);
    assert.ok(sessionSetCookie('t').includes('HttpOnly'));
    assert.ok(sessionSetCookie('t').includes('SameSite=Lax'));
  });

  it('login lockout engages after repeated failures and clears on success', () => {
    const ip = '10.9.9.9';
    recordLoginSuccess(ip);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(checkLoginAllowed(ip).allowed, true);
      recordLoginFailure(ip);
    }
    const locked = checkLoginAllowed(ip);
    assert.strictEqual(locked.allowed, false);
    assert.ok((locked.retryAfterSec ?? 0) > 0);
    recordLoginSuccess(ip);
    assert.strictEqual(checkLoginAllowed(ip).allowed, true);
  });

  it('validateWebAuthStartup enforces the non-loopback mandate', () => {
    // Non-loopback + disabled → throw
    assert.throws(() => validateWebAuthStartup({ host: '0.0.0.0', webAuth: { enabled: false } }));
    assert.throws(() => validateWebAuthStartup({ host: '192.168.1.5' }));
    // Non-loopback + enabled + credentials → ok
    validateWebAuthStartup({
      host: '0.0.0.0',
      webAuth: { enabled: true, username: 'admin', passwordHash: hashPassword('longenough') },
    });
    // enabled but credentials missing → throw
    assert.throws(() => validateWebAuthStartup({ host: '0.0.0.0', webAuth: { enabled: true } }));
    assert.throws(() => validateWebAuthStartup({ host: '0.0.0.0', webAuth: { enabled: true, username: 'admin' } }));
    // Loopback + disabled → ok (anonymous console stays legal)
    validateWebAuthStartup({ host: '127.0.0.1' });
    validateWebAuthStartup({ host: 'localhost', webAuth: { enabled: false } });
  });

  it('isWebAuthActive follows enabled OR forced-non-loopback', () => {
    assert.strictEqual(isWebAuthActive({ host: '127.0.0.1' }), false);
    assert.strictEqual(isWebAuthActive({ host: '127.0.0.1', webAuth: { enabled: true } }), true);
    assert.strictEqual(isWebAuthActive({ host: '0.0.0.0' }), true);
    assert.strictEqual(isWebAuthActive({ host: '0.0.0.0', webAuth: { enabled: false } }), true);
  });
});

describe('web-auth console gate (server integration)', () => {
  const baseConfig = loadConfig();
  const testConfig: RouterConfig = {
    ...baseConfig,
    host: '0.0.0.0',
    webAuth: { enabled: true, username: 'tester', passwordHash: hashPassword('test-pass-123') },
    adminApiKey: 'master-webauth-key',
    apiKeys: [],
  };
  const { app } = createServer(testConfig, true);

  it('admin API is 401 without credentials when webAuth is active', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/status' });
    assert.strictEqual(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, 'console_auth_required');
  });

  it('login rejects wrong credentials and accepts correct ones (set-cookie)', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { username: 'tester', password: 'nope' },
    });
    assert.strictEqual(bad.statusCode, 401);

    const good = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { username: 'tester', password: 'test-pass-123' },
    });
    assert.strictEqual(good.statusCode, 200);
    const setCookie = good.cookies.find((c) => c.name === SESSION_COOKIE);
    assert.ok(setCookie?.value);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/status',
      cookies: { [SESSION_COOKIE]: setCookie!.value },
    });
    assert.strictEqual(res.statusCode, 200);
  });

  it('master adminApiKey Bearer unlocks the console surface (programmatic access)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/status',
      headers: { authorization: 'Bearer master-webauth-key' },
    });
    assert.strictEqual(res.statusCode, 200);
  });

  it('session probe reports unauthenticated pre-login, auth endpoints stay open', async () => {
    const probe = await app.inject({ method: 'GET', url: '/api/admin/auth/session' });
    assert.strictEqual(probe.statusCode, 200);
    const body = JSON.parse(probe.body);
    assert.strictEqual(body.webAuth.active, true);
    assert.strictEqual(body.authenticated, false);

    const configProbe = await app.inject({ method: 'GET', url: '/api/admin/auth/config' });
    assert.strictEqual(configProbe.statusCode, 401); // gated like the rest
  });

  it('admin page shell + assets stay open (login view lives client-side)', async () => {
    const page = await app.inject({ method: 'GET', url: '/admin/' });
    assert.strictEqual(page.statusCode, 200);
  });
});
