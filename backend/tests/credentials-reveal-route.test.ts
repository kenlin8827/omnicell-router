import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { hashPassword, recordLoginSuccess } from '../src/auth/web-auth.js';
import { CredentialPaths } from '../src/opencode/credentials/paths.js';
import {
  AccountNotFoundError,
  CapabilityUnsupportedError,
  OcrStore,
  OpencodeV2Store,
} from '../src/opencode/credentials/index.js';
import { resetCredentialStoreForTests } from '../src/opencode/credentials/factory.js';
import { DbOpener } from '../src/opencode/credentials/opencode-v2-store.js';

/**
 * Controlled credential reveal.
 * Covers the four contract gates: webAuth-active precondition (409), login-bucket
 * throttle sharing (wrong reveal password counts as a login failure, lockout
 * answers 429), password-before-store ordering (401 carries NO account signal —
 * a bogus accountId + right password must not 404), and the row-type boundary
 * (oauth/wellknown refuse, api rows reveal) across all three stores — unit
 * (revealKey) and HTTP (route). The happy-path body is asserted to be EXACTLY
 * {status,key}: the key must never ride alongside a masked view.
 * Hermetic: XDG_* sandbox + injected CredentialPaths + fake sqlite opener —
 * the operator's home is never read.
 */

const KEY = 'sk-reveal-0123456789abcdef';
const PASSWORD = 'reveal-gate-pass-1';
const ADMIN_KEY = 'master-reveal-key';

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
// webAuth ACTIVE with credentials: reveal's precondition. The console gate then
// requires session-or-bearer on every /api/admin route — tests ride the master
// adminApiKey Bearer (the gate's sanctioned programmatic limb).
const testConfig = {
  ...baseConfig,
  adminApiKey: ADMIN_KEY,
  webAuth: { enabled: true, username: 'tester', passwordHash: hashPassword(PASSWORD) },
};
const { app } = createServer(testConfig, true);

const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

function fakeDb(rows: unknown[] = []): DbOpener {
  return async () => ({
    query(sql: string) {
      return {
        all: () => (sql.includes('table_info') ? ALL_COLS.map((c) => ({ name: c })) : rows),
      };
    },
    close() {
      // no-op
    },
  });
}

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = String(init?.method ?? 'GET');
  if (method === 'GET') {
    return new Response(JSON.stringify({ data: [{ id: 'myprov', connections: [] }] }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

const keyRow = (id: string, integration: string, key: string, active = 1) => ({
  id,
  integration_id: integration,
  label: null,
  value: JSON.stringify({ type: 'key', key }),
  active,
  time_created: 1,
  time_updated: 1,
});

const oauthRow = (id: string, integration: string) => ({
  id,
  integration_id: integration,
  label: null,
  value: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 0, methodID: 'm', metadata: {} }),
  active: 1,
  time_created: 1,
  time_updated: 1,
});

let tmpDir = '';
let oldCfg: string | undefined;
let oldData: string | undefined;

function credPaths(): CredentialPaths {
  return {
    configDir: path.join(tmpDir, 'config', 'opencode'),
    dataDir: path.join(tmpDir, 'data', 'opencode'),
    authJsonPath: path.join(tmpDir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(tmpDir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(tmpDir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(tmpDir, 'ocr-home'),
    serviceJsonCandidates: [path.join(tmpDir, 'config', 'opencode', 'service.json')],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-reveal-'));
  oldCfg = process.env.XDG_CONFIG_HOME;
  oldData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  const p = credPaths();
  fs.mkdirSync(p.configDir, { recursive: true });
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.mkdirSync(p.ocrHome, { recursive: true });
});

afterEach(() => {
  resetCredentialStoreForTests();
  if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldCfg;
  if (oldData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldData;
});

function bearer() {
  return { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' };
}

const revealUrl = (providerId: string, accountId: string) =>
  `/api/admin/opencode/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/reveal`;

describe('revealKey — store unit surface (Decision 10 row-type boundary)', () => {
  it('OcrStore: exact addressed row reveals; unknown id → AccountNotFoundError', async () => {
    const paths = credPaths();
    const store = new OcrStore({ paths, now: () => 1 });
    const meta = await store.connectKey('myprov', KEY);
    expect(store.revealKey(meta.id)).toBe(KEY);
    expect(() => store.revealKey('nope')).toThrow(AccountNotFoundError);
  });

  it('OpencodeV2Store: key row reveals; oauth row refuses; readonly binding reveals too (it is a db READ)', async () => {
    const paths = credPaths();
    const rows = [keyRow('c1', 'myprov', KEY), oauthRow('c2', 'gh')];
    const store = await OpencodeV2Store.create({ paths, fetchImpl, env: {}, now: () => 1, openDatabase: fakeDb(rows) });
    expect(store.revealKey('c1')).toBe(KEY);
    expect(() => store.revealKey('c2')).toThrow(CapabilityUnsupportedError);
    expect(() => store.revealKey('zzz')).toThrow(AccountNotFoundError);
    store.close();

    fs.writeFileSync(paths.opencodeDbPath, 'fake-db-bytes');
    const ro = await OpencodeV2Store.create({
      paths,
      writable: false,
      fetchImpl,
      env: {},
      now: () => 1,
      openDatabase: fakeDb(rows),
    });
    expect(ro.revealKey('c1')).toBe(KEY); // assertWritable is NOT on the reveal path
    ro.close();
  });
});

describe('POST …/accounts/:accountId/reveal — the four gates', () => {
  it('gate 1: webAuth inactive → 409 webauth_required, never a key', async () => {
    const prev = testConfig.webAuth;
    (testConfig as any).webAuth = { enabled: false };
    try {
      const res = await app.inject({
        method: 'POST',
        url: revealUrl('myprov', 'c1'),
        headers: bearer(),
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).reasonCode).toBe('webauth_required');
    } finally {
      testConfig.webAuth = prev;
    }
  });

  it('401 answers are constant: wrong password + BOGUS accountId must NOT 404 (no pre-auth enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', 'account-that-does-not-exist'),
      headers: bearer(),
      payload: { password: 'totally-wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('account_not_found');
    expect(res.body).not.toContain(KEY);
  });

  it('gate 2 (happy + exact shape): right password + bound v2 store → 200 {status,key}, no-store', async () => {
    const paths = credPaths();
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', fetchImpl, {
      env: {},
      now: () => 1,
      openDatabase: fakeDb([keyRow('c1', 'myprov', KEY)]),
    });
    const res = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', 'c1'),
      headers: bearer(),
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    // The success body is EXACTLY the two fields — the key never travels with
    // a masked view or account echo (Decision 10 condition 3).
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', key: KEY });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('oauth row via the route: 409 capability_unsupported after the password passes', async () => {
    const paths = credPaths();
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', fetchImpl, {
      env: {},
      now: () => 1,
      openDatabase: fakeDb([oauthRow('c2', 'myprov')]),
    });
    const res = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', 'c2'),
      headers: bearer(),
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).reasonCode).toBe('capability_unsupported');
  });

  it('cross-provider guard: a real account id under the WRONG provider → 404 (post-auth)', async () => {
    const paths = credPaths();
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', fetchImpl, {
      env: {},
      now: () => 1,
      openDatabase: fakeDb([keyRow('c1', 'myprov', KEY)]),
    });
    const res = await app.inject({
      method: 'POST',
      url: revealUrl('otherprov', 'c1'),
      headers: bearer(),
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).reasonCode).toBe('account_not_found');
  });

  it('ocr binding reveals the local credentials.json key', async () => {
    // standalone: no opencode at all → OcrStore. auth.json stays ABSENT or the
    // bind-time one-shot import (B4) would fold it in and muddy the fixture.
    const p1 = credPaths();
    resetCredentialStoreForTests(p1, async () => null, fetchImpl, { env: {}, now: () => 1 });
    const { getCredentialStore } = await import('../src/opencode/credentials/index.js');
    const ocr = await getCredentialStore();
    const meta = await ocr.connectKey('myprov', KEY);
    const resOcr = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', meta.id),
      headers: bearer(),
      payload: { password: PASSWORD },
    });
    expect(resOcr.statusCode).toBe(200);
    expect(JSON.parse(resOcr.body).key).toBe(KEY);
    // Decision 8 honesty check: the file on disk is still the only copy —
    // reveal did NOT fork a second credential anywhere.
    expect(fs.readdirSync(p1.ocrHome).sort().join(',')).toBe('credential-store.json,credentials.json');
  });

  it('gate 2 (throttle): wrong-password failures lock the bucket — 429 + retry-after after MAX_FAILURES strikes', async () => {
    const paths = credPaths();
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', fetchImpl, {
      env: {},
      now: () => 1,
      openDatabase: fakeDb([keyRow('c1', 'myprov', KEY)]),
    });
    let locked: any = null;
    // Loop-until-locked: an earlier 401 test may already have put failures in
    // this process' bucket, so counting from zero here would couple tests.
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: revealUrl('myprov', 'c1'),
        headers: bearer(),
        payload: { password: 'nope-' + i },
      });
      if (res.statusCode === 429) {
        locked = res;
        break;
      }
      expect(res.statusCode).toBe(401);
    }
    expect(locked).not.toBeNull();
    expect(JSON.parse(locked.body).reasonCode).toBe('too_many_attempts');
    expect(locked.headers['retry-after']).toBeString();
    // While locked, even the RIGHT password is refused — the gate is the bucket,
    // not the check order.
    const whileLocked = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', 'c1'),
      headers: bearer(),
      payload: { password: PASSWORD },
    });
    expect(whileLocked.statusCode).toBe(429);
  });

  it('gate 2 (reset): a successful reveal clears the failure bucket for later logins', async () => {
    // Best-effort: unlock if the previous test left the bucket locked (the
    // lock is time-based; clearing the count does NOT lift lockUntil, so a
    // locked bucket here would fail the assertion — accept 429 only as "the
    // throttle is doing its job", then verify success-then-clear directly).
    const probe = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', 'c1'),
      headers: bearer(),
      payload: { password: PASSWORD },
    });
    if (probe.statusCode === 429) {
      recordLoginSuccess('127.0.0.1'); // the inject socket address
      recordLoginSuccess('::1');
      recordLoginSuccess('::ffff:127.0.0.1');
      recordLoginSuccess('unknown'); // the handler's req.ip fallback key
    }
    const paths = credPaths();
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', fetchImpl, {
      env: {},
      now: () => 1,
      openDatabase: fakeDb([keyRow('c1', 'myprov', KEY)]),
    });
    const bad = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', 'c1'),
      headers: bearer(),
      payload: { password: 'wrong-one-shot' },
    });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', 'c1'),
      headers: bearer(),
      payload: { password: PASSWORD },
    });
    expect(good.statusCode).toBe(200);
    // One more bad then good: if success had NOT cleared the bucket, the count
    // from prior tests could surface a 429 here.
    await app.inject({ method: 'POST', url: revealUrl('myprov', 'c1'), headers: bearer(), payload: { password: 'x' } });
    const again = await app.inject({
      method: 'POST',
      url: revealUrl('myprov', 'c1'),
      headers: bearer(),
      payload: { password: PASSWORD },
    });
    expect(again.statusCode).toBe(200);
  });
});
