import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CredentialPaths } from '../src/opencode/credentials/paths.js';
import { resetCredentialStoreForTests, writeCredentialStoreState } from '../src/opencode/credentials/factory.js';
import { ensureReconciled } from '../src/opencode/credentials/reconcile.js';
import { DbOpener } from '../src/opencode/credentials/opencode-v2-store.js';

/**
 * GET /api/admin/credential-store — the P2 badge data source and the fix for
 * touchpoint gap #1 (boot excluded[] served over API, not just logged).
 * Masked-only contract asserted with a real-looking key in the fixture db.
 * Harness follows admin-logs-clear.test.ts: real server, webAuth off, the
 * isolated runner's sandboxed OCR_HOME; the credential layer itself is fully
 * hermetic via resetCredentialStoreForTests (injected paths/versionProbe/
 * openDatabase/fetch — the real CLI is never spawned).
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

function fakeDb(rows: unknown[] = [], throwOnOpen?: string): DbOpener {
  return async () => {
    if (throwOnOpen) throw new Error(throwOnOpen);
    return {
      query(sql: string) {
        return {
          all: () => (sql.includes('table_info') ? ALL_COLS.map((c) => ({ name: c })) : rows),
        };
      },
      close() {
        // no-op
      },
    };
  };
}

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cred-endpoint-'));
  const paths: CredentialPaths = {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  };
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  return paths;
}

const okFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ data: [{ id: 'anthropic' }] }), { status: 200 });

const KEY_ROW = {
  id: 'c-secret',
  integration_id: 'anthropic',
  label: 'work',
  value: JSON.stringify({ type: 'key', key: 'sk-SUPER-SECRET-000111222' }),
  active: 1,
  time_created: 1,
  time_updated: 1,
};
const OAUTH_ROW = {
  id: 'c-oauth',
  integration_id: 'zen',
  label: null,
  value: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 0, methodID: 'm', metadata: {} }),
  active: 0,
  time_created: 1,
  time_updated: 1,
};

describe('GET /api/admin/credential-store', () => {
  it('serves the opencode v2 StoreStatus verbatim, masked-only, with per-provider account detail', async () => {
    const paths = sandboxPaths();
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', okFetch, {
      env: {},
      now: () => 1234,
      openDatabase: fakeDb([KEY_ROW, OAUTH_ROW]),
    });

    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.store.kind).toBe('opencode-v2');
    expect(body.store.capabilities).toEqual({
      multiAccount: true,
      activate: true,
      rename: true,
      oauth: false,
      envVisible: true,
      integrationScoped: true,
    });
    expect(body.store.evidence.used).toBe('cli');
    expect(body.store.probeResult.state).toBe('ready');
    expect(body.store.credentialFile).toBe(paths.opencodeDbPath);
    expect(body.reconcile).toBeNull(); // no marker yet

    // per-provider detail: masked metadata only
    const anthropic = body.store.accounts.find((a: { providerId: string }) => a.providerId === 'anthropic');
    expect(anthropic.routable).toBe(1);
    expect(anthropic.accounts[0]).toMatchObject({ id: 'c-secret', type: 'api', active: true, routable: true });
    expect(anthropic.accounts[0].maskedKey).toContain('••••');
    const zen = body.store.accounts.find((a: { providerId: string }) => a.providerId === 'zen');
    expect(zen.accounts[0]).toMatchObject({ type: 'oauth', routable: false });

    // gap #1: exclusions are SERVED, not just logged (zen has no routable row)
    expect(body.store.excluded.some((e: { provider: string }) => e.provider === 'zen')).toBe(true);

    // THE masking assertion — no raw key anywhere in the wire payload
    expect(res.body).not.toContain('sk-SUPER-SECRET-000111222');
  });

  it('serves degraded opencode v2→OcrStore landing with db_unreadable badge + excluded snapshot providers', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-snap' } }));
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', okFetch, {
      env: {},
      now: () => 1,
      openDatabase: fakeDb([], 'SQLITE_CANTOPEN: unable to open database file'),
    });

    const body = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' })).json();
    expect(body.store.kind).toBe('ocr');
    expect(body.store.degradedCode).toBe('db_unreadable');
    expect(body.store.excluded).toEqual([
      { provider: 'anthropic', reasonCode: 'db_unreadable', detail: expect.any(String) },
    ]);
  });

  it('serves an opencode v1 machine as the badged unsupported_version landing', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-v1-1234567890' } }));
    resetCredentialStoreForTests(paths, async () => 'v1.4.6', okFetch, { env: {}, now: () => 1 });

    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    const body = res.json();
    // auth.json is not a sink: the machine lands on the OCR store, loudly badged,
    // and the snapshot is imported so the key still shows up (masked).
    expect(body.store.kind).toBe('ocr');
    expect(body.store.degradedCode).toBe('unsupported_version');
    expect(body.store.credentialFile).not.toBe(paths.authJsonPath);
    expect(body.store.accounts[0].accounts[0].maskedKey).toContain('••••');
    expect(res.body).not.toContain('sk-v1-1234567890');
    // …and the import never wrote auth.json back.
    expect(JSON.parse(fs.readFileSync(paths.authJsonPath, 'utf8')).anthropic.key).toBe('sk-v1-1234567890');
  });

  it('serves the unbadged standalone ocr landing', async () => {
    const paths = sandboxPaths();
    resetCredentialStoreForTests(paths, async () => null, okFetch, { env: {}, now: () => 1 });

    const body = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' })).json();
    expect(body.store.kind).toBe('ocr');
    expect(body.store.degradedCode).toBeNull();
    expect(body.store.evidence.used).toBe('none');
    expect(body.reconcile).toBeNull();
  });

  it('includes the reconcile summary after the gate ran', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-reconciled-me' } }));
    const posts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(init?.method ?? 'GET') === 'POST') posts.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: 'anthropic' }], credential: { id: 'c-pushed' } }), {
        status: 200,
      });
    };
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', fetchImpl, {
      env: {},
      now: () => 1,
      openDatabase: fakeDb([]), // empty db → the snapshot key is auth-only → push
    });

    // lazy-bind through the seam, then run the gate
    const { getCredentialStore, getCredentialStoreStatus } = await import('../src/opencode/credentials/factory.js');
    const store = await getCredentialStore();
    const status = await getCredentialStoreStatus();
    const rec = await ensureReconciled(store, status, {
      paths,
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(rec.ran).toBe(true);
    expect(posts.some((u) => u.includes('/api/integration/anthropic/connect/key'))).toBe(true);

    const body = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' })).json();
    expect(body.reconcile).toMatchObject({ authWriteDisabled: true });
    expect(body.reconcile.entries).toEqual([{ provider: 'anthropic', action: 'pushed' }]);
    expect(typeof body.reconcile.doneAt).toBe('number');
    expect(body.store.kind).toBe('opencode-v2');
  });

  it('P2-5: after boot-1 push failures, a boot-2 already-done rebind SERVES the stranded key in store.excluded', async () => {
    const paths = sandboxPaths();
    // persisted audit trail from an earlier boot: one key FAILED to push
    writeCredentialStoreState(paths, {
      bound: 'opencode-v2',
      version: 'v2.0.15',
      evidence: { cli: 'v2.0.15', file: null, used: 'cli', lastKnownGood: null },
      degradedCode: null,
      updatedAt: 1,
      reconcile: {
        doneAt: 1,
        authWriteDisabled: true,
        entries: [{ provider: 'failing', action: 'failed', reason: 'connectKey failed against the opencode v2 service: HTTP 500' }],
      },
    });
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', okFetch, { env: {}, now: () => 2, openDatabase: fakeDb([KEY_ROW]) });

    // boot 2 runs the gate: already-done → re-append persisted failures
    const { getCredentialStore, getCredentialStoreStatus } = await import('../src/opencode/credentials/factory.js');
    const store = await getCredentialStore();
    const status = await getCredentialStoreStatus();
    const res = await ensureReconciled(store, status, { paths, log: { info: () => undefined, warn: () => undefined } });
    expect(res).toMatchObject({ ran: false, skipped: 'already-done' });

    const body = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' })).json();
    const stranded = body.store.excluded.find((e: { provider: string }) => e.provider === 'failing');
    expect(stranded).toBeDefined();
    expect(stranded.reasonCode).toBe('reconcile_push_failed');
    expect(stranded.detail).toContain('persisted reconcile failure');
    // redacted-by-construction: the persisted reason never carries key material
    expect(body.reconcile.entries[0].reason).not.toContain('sk-');
  });
});
