import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer, canonicalPath } from '../src/server.js';
import { createSessionToken, SESSION_COOKIE } from '../src/auth/web-auth.js';

// Isolation: both loadConfig() and the request-time disk key gate read the
// ACTIVE environment's config.yaml from OCR_HOME. Sandbox the home and seed a
// known CURRENT-schema (v1 grouped) config with NO client keys — the "no key
// gate" environment every OFF-app assertion below is written against (on a
// workstation whose live config carries keys, the OFF app would 401 before
// the CSRF gate ever runs).
const csrfSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-admin-csrf-'));
process.env.OCR_HOME = path.join(csrfSandbox, 'home');
process.env.OCR_ENV = 'default';
const csrfEnvDir = path.join(process.env.OCR_HOME, 'envs', 'default');
fs.mkdirSync(csrfEnvDir, { recursive: true });
fs.writeFileSync(path.join(csrfEnvDir, 'config.yaml'), 'schemaVersion: 1\nclient:\n  host: 127.0.0.1\n');
fs.writeFileSync(path.join(csrfEnvDir, 'env.json'), JSON.stringify({ name: 'default', type: 'regular', schemaVersion: 1 }));

/**
 * Security P2-3 — drive-by CSRF narrowing on state-changing /api/admin/*
 * while webAuth is INACTIVE (cors origin:true + no session gate): a request
 * carrying an Origin/Referer must be loopback- or same-host originated.
 * Requests WITHOUT Origin (CLI, curl, local processes) pass untouched;
 * GETs are never gated; the webAuth-active path keeps its own 401 gate.
 *
 * Fix-round-2 gate-bypass regressions (L3 gate findings):
 *  F1: the loopback Origin test must be EXACT — web-auth's isLoopbackHost()
 *      startsWith('127.') matched attacker-registered '127.0.0.1.evil.test'.
 *  F2: every gate tests the ROUTER-CANONICAL path (single decodeURI, like
 *      find-my-way) — raw req.url prefix checks were bypassed by '/%61pi/…'
 *      (both the new CSRF gate and the PRE-EXISTING webAuth session gate).
 */

// OFF app: webAuth inactive, no client keys on disk (sandbox above), so the
// CSRF gate is the first line of defense — every 403/200 verdict below is
// the gate's own, never a key-auth 401.
const inactiveConfig = loadConfig();
inactiveConfig.host = '127.0.0.1';
inactiveConfig.webAuth = { enabled: false };
inactiveConfig.adminKey = undefined;
const { app } = createServer(inactiveConfig, true);

const activeConfig = loadConfig();
activeConfig.host = '127.0.0.1';
activeConfig.webAuth = { enabled: true };
activeConfig.adminKey = 'test-admin-key';
const { app: authedApp } = createServer(activeConfig, true);

// Boot before injecting: an inject that lands mid-avvio-boot on an UNMATCHED
// percent-encoded path makes fastify's basic404 double-send (status is still
// correct, but the trailing ERR_HTTP_HEADERS_SENT fails the test). Real
// traffic cannot arrive pre-listen; only inject can.
let offPort = 0;
let onPort = 0;
beforeAll(async () => {
  await Promise.all([app.ready(), authedApp.ready()]);
  offPort = Number(new URL(await app.listen({ port: 0, host: '127.0.0.1' })).port);
  onPort = Number(new URL(await authedApp.listen({ port: 0, host: '127.0.0.1' })).port);
});
afterAll(() => {
  try {
    fs.rmSync(csrfSandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  return Promise.all([app.close(), authedApp.close()]);
});

/**
 * Raw-socket POST (node:http, never proxied): light-my-request has a
 * double-send quirk on unmatched percent-encoded targets — it reuses the mock
 * Response across injects and the trailing ERR_HTTP_HEADERS_SENT fails the
 * test even though the status is correct. Verified clean over a real socket,
 * and a real socket is the exact production/attacker path for these vectors.
 */
function rawPost(port: number, path: string, origin?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers: origin ? { origin } : {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const WRITE = '/api/admin/metrics/reset';

describe('cross-origin admin write gate (webAuth inactive)', () => {
  it('POST with a hostile Origin → 403 cross_origin_admin_request (handler never runs)', async () => {
    const res = await app.inject({ method: 'POST', url: WRITE, headers: { origin: 'http://evil.test' } });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe('cross_origin_admin_request');
    expect(body.reasonCode).toBe('cross_origin_admin_request');
  });

  it('POST with a hostile Referer → 403 (no Origin fallback)', async () => {
    const res = await app.inject({ method: 'POST', url: WRITE, headers: { referer: 'http://evil.test/page.html' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reasonCode).toBe('cross_origin_admin_request');
  });

  it('unparsable Origin → 403 with the malformed_origin reason (fail closed)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/sessions/none', headers: { origin: 'not a url' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reasonCode).toBe('malformed_origin');
  });

  it('POST with a loopback Origin → untouched (200)', async () => {
    const res = await app.inject({ method: 'POST', url: WRITE, headers: { origin: 'http://127.0.0.1:4000' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');

    const lo = await app.inject({ method: 'POST', url: WRITE, headers: { origin: 'http://localhost:5173' } });
    expect(lo.statusCode).toBe(200);
  });

  it('POST with NO Origin (CLI/curl/local) → untouched (200)', async () => {
    const res = await app.inject({ method: 'POST', url: WRITE });
    expect(res.statusCode).toBe(200);
  });

  it('same-host non-loopback Origin → allowed (LAN-served console keeps working)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: WRITE,
      headers: { host: '192.168.1.5:8080', origin: 'http://192.168.1.5:8080' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET with a hostile Origin is NOT gated (reads unaffected)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/metrics', headers: { origin: 'http://evil.test' } });
    expect(res.statusCode).toBe(200);
  });

  it('non-admin surfaces are out of scope (/v1 keeps its own auth contract)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { origin: 'http://evil.test' },
      payload: { model: 'auto', messages: [] },
    });
    expect(res.statusCode).not.toBe(403); // 4xx from the gateway itself, never the CSRF verdict
    expect(String(res.body)).not.toContain('cross_origin_admin_request');
  });

  it('webAuth-ACTIVE path unchanged: hostile Origin POST hits the session gate (401), not the CSRF 403', async () => {
    const res = await authedApp.inject({ method: 'POST', url: WRITE, headers: { origin: 'http://evil.test' } });
    expect(res.statusCode).toBe(401);
    expect(String(res.body)).toContain('console_auth_required');
  });
});

describe('F1: exact-loopback Origin test (no 127.x prefix match)', () => {
  it('Origin http://127.0.0.1.evil.test → 403 (attacker-registered subdomain, was 200)', async () => {
    const res = await app.inject({ method: 'POST', url: WRITE, headers: { origin: 'http://127.0.0.1.evil.test' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reasonCode).toBe('cross_origin_admin_request');
  });

  it('Origin http://127.1.2.3.evil.test → 403 (DNS name, not a canonicalized IPv4 literal)', async () => {
    const res = await app.inject({ method: 'POST', url: WRITE, headers: { origin: 'http://127.1.2.3.evil.test' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reasonCode).toBe('cross_origin_admin_request');
  });

  it('genuine loopback Origins still pass: 127.0.0.1:PORT, localhost, [::1], 127.0.99.88, 127.1 shorthand', async () => {
    for (const origin of [
      'http://127.0.0.1:3000',
      'http://localhost:5173',
      'http://[::1]:4000',
      'http://127.0.99.88:8080', // full dotted quad inside 127/8
      'http://127.1',            // WHATWG-canonicalized to 127.0.0.1 by new URL()
    ]) {
      const res = await app.inject({ method: 'POST', url: WRITE, headers: { origin } });
      expect(res.statusCode).toBe(200);
    }
    const noOrigin = await app.inject({ method: 'POST', url: WRITE });
    expect(noOrigin.statusCode).toBe(200);
  });

  it('Octal-style 127/8 shorthand still canonicalizes (0x7f.1 → 127.0.0.1 → pass)', async () => {
    const res = await app.inject({ method: 'POST', url: WRITE, headers: { origin: 'http://0x7f.1' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('F2: gates test the router-canonical path, not raw req.url', () => {
  // '/%61pi' decodes to '/api' (decodeURI of non-reserved 'a') — find-my-way
  // routes it to the REAL admin handlers. Raw-string gates missed it (200).
  const ENCODED_WRITE = '/%61pi/admin/metrics/reset';

  it('webAuth OFF: %61pi + hostile Origin → 403 (was 200 — CSRF gate bypass)', async () => {
    const res = await app.inject({ method: 'POST', url: ENCODED_WRITE, headers: { origin: 'http://evil.test' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reasonCode).toBe('cross_origin_admin_request');
  });

  it('webAuth OFF: %61pi + no Origin reaches the real handler (gate follows routing, not spellings)', async () => {
    const res = await app.inject({ method: 'POST', url: ENCODED_WRITE });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('webAuth ON: %61pi + no cookie → 401 console_auth_required (was 200 — PRE-EXISTING session bypass)', async () => {
    const res = await authedApp.inject({ method: 'POST', url: ENCODED_WRITE });
    expect(res.statusCode).toBe(401);
    expect(String(res.body)).toContain('console_auth_required');
  });

  it('webAuth ON: %61pi + valid session cookie → 200 (legitimate access unaffected)', async () => {
    const token = createSessionToken();
    const res = await authedApp.inject({
      method: 'POST',
      url: ENCODED_WRITE,
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('webAuth ON: %61pi + master key Bearer → 200 (programmatic path unaffected)', async () => {
    const res = await authedApp.inject({
      method: 'POST',
      url: ENCODED_WRITE,
      headers: { authorization: 'Bearer test-admin-key' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('query-string tricks do not dodge: %61pi?x=1 and /api/admin/x?y=%61 both 403 (hostile Origin)', async () => {
    const a = await app.inject({ method: 'POST', url: `${ENCODED_WRITE}?x=1`, headers: { origin: 'http://evil.test' } });
    expect(a.statusCode).toBe(403);
    const b = await app.inject({ method: 'POST', url: '/api/admin/metrics/reset?y=%61', headers: { origin: 'http://evil.test' } });
    expect(b.statusCode).toBe(403);
  });

  it('trailing-slash admin shape /api/admin/ is gated (403), never routed to', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/', headers: { origin: 'http://evil.test' } });
    expect(res.statusCode).toBe(403);
  });

  it('malformed encoding %ZZ: rejected before the gate even runs — 400 FST_ERR_BAD_URL, never 200', async () => {
    // Fastify's router hard-rejects URIError targets at route resolution, so
    // the gate is never reached; canonicalPath still maps URIError → null →
    // ADMIN (fail-closed) as defense-in-depth — pinned in the helper suite.
    for (const inst of [app, authedApp]) {
      const res = await inst.inject({ method: 'POST', url: '/%ZZpi/admin/metrics/reset', headers: { origin: 'http://evil.test' } });
      expect(res.statusCode).toBe(400);
      expect(String(res.body)).toContain('FST_ERR_BAD_URL');
    }
  });

  it('double-encoded %2561: ONE decode pass matches the router — passes gates and routes to nothing (404/401, never 200)', async () => {
    // decodeURI('%2561pi…') === '%61pi…' (non-reserved), same as find-my-way,
    // which then matches no admin route. webAuth OFF → 404 from the router
    // (or 401 from the disk-backed key gate when the workstation config
    // carries client keys); webAuth ON → non-admin path still needs an API
    // key → 401. Every verdict means the ADMIN handler never runs.
    const off = await rawPost(offPort, '/%2561pi/admin/metrics/reset', 'http://evil.test');
    expect([404, 401]).toContain(off.status);
    const on = await rawPost(onPort, '/%2561pi/admin/metrics/reset', 'http://evil.test');
    expect(on.status).toBe(401);
    expect(on.body).not.toContain('console_auth_required'); // key-auth 401, not the admin gate
  });

  it('%41pi → /Api…: find-my-way is case-sensitive — no route match, no admin-handler 200', async () => {
    // webAuth OFF: decoded '/Api/admin/metrics/reset' fails the (case-sensitive)
    // lowercase prefix on both sides; router 404s (auth disabled, no key gate)
    // or the disk-backed key gate 401s first — either way no admin handler.
    // webAuth ON: same non-admin verdict → falls through to key auth → 401.
    expect([404, 401]).toContain((await rawPost(offPort, '/%41pi/admin/metrics/reset', 'http://evil.test')).status);
    expect((await rawPost(onPort, '/%41pi/admin/metrics/reset', 'http://evil.test')).status).toBe(401);
  });

  // Headline finding-2 reproduction — the EXACT runtime evidence the L3 gate
  // presented, over the real socket an attacker's drive-by uses:
  // OFF + evil Origin + %61pi was 200 (CSRF bypass); ON + %61pi + no cookie
  // was 200 (pre-existing webAuth session-gate bypass). Both must now deny.
  it('SOCKET: webAuth OFF %61pi + evil Origin → 403 (proven 200 pre-fix)', async () => {
    const r = await rawPost(offPort, '/%61pi/admin/metrics/reset', 'http://evil.test');
    expect(r.status).toBe(403);
    expect(r.body).toContain('cross_origin_admin_request');
  });

  it('SOCKET: webAuth ON %61pi no cookie → 401 console_auth_required (proven 200 pre-fix)', async () => {
    const r = await rawPost(onPort, '/%61pi/admin/metrics/reset', 'http://evil.test');
    expect(r.status).toBe(401);
    expect(r.body).toContain('console_auth_required');
  });

  it('models surface is decoded too: /v1/mod%65ls anonymous behaves exactly like /v1/models', async () => {
    // authedApp has an admin key → isAuthEnabled; /v1/models is anonymous-
    // tolerant via isModelsSurface. The encoded spelling must not 401 where
    // the plain one 200s (both route to the same handler).
    const plain = await authedApp.inject({ method: 'GET', url: '/v1/models' });
    const encoded = await authedApp.inject({ method: 'GET', url: '/v1/mod%65ls' });
    expect(plain.statusCode).toBe(200);
    expect(encoded.statusCode).toBe(plain.statusCode);
    const other = await authedApp.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'auto', messages: [] } });
    expect(other.statusCode).toBe(401); // non-models surface still requires a key
  });
});

describe('canonicalPath helper (mirrors find-my-way pre-route URL handling)', () => {
  const cases: Array<[string, string | null]> = [
    ['/api/admin/metrics/reset?x=1', '/api/admin/metrics/reset'],
    ['/%61pi/admin/metrics/reset', '/api/admin/metrics/reset'],
    ['/api/admin/metrics#frag', '/api/admin/metrics'],
    ['/%2561pi/admin/x', '/%61pi/admin/x'], // ONE pass only — matches the router
    ['/v1/chat/%2fcompletions', '/v1/chat/%2fcompletions'], // reserved sequences survive decodeURI
    ['/a%2f%61pi', '/a%2fapi'],
    ['http://evil.example/api/admin/x', '/api/admin/x'], // proxy-form target routes (find-my-way getPathFromAbsoluteUrl)
    ['https://evil.example', '/'],
    ['HTTP://evil.example/api/admin/x?y=1', '/api/admin/x'],
    ['http:///api/admin', null], // empty authority — find-my-way bad-URLs it; fail closed
    ['*', null],
    ['/%ZZbad', null], // URIError → null → caller treats as ADMIN (fail closed)
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${JSON.stringify(expected)}`, () => {
      expect(canonicalPath(input)).toBe(expected);
    });
  }
});
