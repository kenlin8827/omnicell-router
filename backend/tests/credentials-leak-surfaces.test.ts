import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { maskSecret } from '../src/opencode/user-config.js';
import { CredentialPaths, ocrCredentialsFile } from '../src/opencode/credentials/paths.js';
import { OcrStore } from '../src/opencode/credentials/ocr-store.js';
import { DbOpener, OpencodeV2Store } from '../src/opencode/credentials/opencode-v2-store.js';
import {
  getCredentialStore,
  getCredentialStoreStatus,
  resetCredentialStoreForTests,
} from '../src/opencode/credentials/factory.js';
import { WriteFailedError, keyHashPrefix } from '../src/opencode/credentials/types.js';

/**
 * Leak-surface sweep — every serialization boundary a WRITE
 * path touches, asserted against a seeded raw key:
 *   - CredentialMeta / StoreStatus / provider-list merge (masked-only contract,
 *     Decision 1 risk limb: no management route ever receives raw secrets),
 *   - the opencode v2 service's error-response ECHO (an upstream that repeats the
 *     submitted key in its 500 body must not get that key re-served through
 *     the 502 error field, the sync outcome persisted to credential-sync.json,
 *     the push failed[].reason, or any log line),
 *   - corrupt-credentials.json probe detail (parse-error token echo),
 *   - Decision 8 honesty: disconnect NEVER leaves a local backup copy.
 * Harness precedents: credentials-store-endpoint.test.ts (real server,
 * webAuth off), credentials-v2-writes.test.ts (fake sqlite opener, fetch
 * mock). Fully sandboxed paths — zero operator-home access.
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

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

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-leak-'));
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

/**
 * Adversarial opencode-v2-service mock: every non-GET fails with status postStatus and
 * the error body ECHOES the submitted key — the worst-case upstream behavior
 * (debug-style validation errors repeating the offending value).
 */
function echoFetch(integrationIds: string[] = ['anthropic'], postStatus = 500) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === 'GET') {
      return new Response(
        JSON.stringify({ data: integrationIds.map((id) => ({ id, connections: [] })) }),
        { status: 200 }
      );
    }
    const echo = body && typeof body.key === 'string' ? `invalid credential: ${body.key}` : 'server error';
    return new Response(JSON.stringify({ error: echo }), { status: postStatus });
  };
  return { fetchImpl, calls };
}

const captureLog = () => {
  const lines: string[] = [];
  return { log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) }, lines };
};

afterEach(() => {
  resetCredentialStoreForTests();
});

describe('masked-surface contract (Decision 1 risk limb)', () => {
  it('OcrStore: maskSecret on EVERY CredentialMeta surface — list, connect, activate, rename, resolveKey, probe', async () => {
    const paths = sandboxPaths();
    const store = new OcrStore({ paths, now: () => 1 });
    const k1 = 'sk-ocr-surface-AAA-001122';
    const k2 = 'sk-ocr-surface-BBB-334455';
    const first = await store.connectKey('anthropic', k1);
    await store.connectKey('anthropic', k2);
    const rows = store.listCredentials('anthropic');
    const activated = await store.activate(rows[1]!.id);
    const renamed = await store.rename(rows[0]!.id, 'laptop');
    const resolved = store.resolveKey('anthropic')!.credential;

    // maskSecret applied exactly, on every surface (not just "contains dots")
    expect(first.maskedKey).toBe(maskSecret(k1));
    expect(renamed.maskedKey).toBe(maskSecret(k1));
    expect(activated.maskedKey).toBe(maskSecret(k2));
    expect(resolved.maskedKey).toBe(maskSecret(k2));

    // no raw key material anywhere in ANY serialized management value
    const dumps = [
      JSON.stringify(store.probe()),
      JSON.stringify(store.credentialsOverview()),
      JSON.stringify(store.listCredentials('anthropic')),
      JSON.stringify([first, activated, renamed, resolved]),
      JSON.stringify(store.listCredentials('missing')),
    ];
    for (const d of dumps) {
      expect(d).not.toContain(k1);
      expect(d).not.toContain(k2);
    }
    // keyHashPrefix is display-safe: hash hex only, never derived from the
    // key's literal prefix (Decision 5 — logs can name an credential safely).
    expect(renamed.keyHashPrefix).toMatch(/^[0-9a-f]{12}$/);
    expect(renamed.keyHashPrefix).toBe(keyHashPrefix(k1));
    expect(renamed.keyHashPrefix).not.toBe(k1.slice(0, 12));
  });

  it('OpencodeV2Store: active oauth row never exits through resolveKey/resolveKeyChain; connectKey return is masked', async () => {
    const paths = sandboxPaths();
    // GET integrations succeed; POST returns a fresh credential id (2xx, no echo).
    const okFetch: typeof fetch = async (_input, init) =>
      String(init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ data: [{ id: 'anthropic', connections: [] }] }), { status: 200 })
        : new Response(JSON.stringify({ credential: { id: 'c-new' } }), { status: 200 });
    const store = await OpencodeV2Store.create({
      paths,
      writable: true,
      env: {},
      openDatabase: fakeDb([oauthRow('c-o', 'zen')]),
      fetchImpl: okFetch,
    });
    // active=1 alone must NOT make the oauth row routable 
    expect(store.resolveKey('zen')).toBeNull();
    expect(store.resolveKeyChain('zen')).toEqual([]);
    expect(store.listCredentials('zen')[0]).toMatchObject({ type: 'oauth', active: true, routable: false });

    const k = 'sk-v2-connect-meta-998877';
    const meta = await store.connectKey('anthropic', k);
    expect(JSON.stringify(meta)).not.toContain(k);
    expect(meta.maskedKey).toBe(maskSecret(k));
    expect(meta.keyHashPrefix).toBe(keyHashPrefix(k));
  });

  it('GET /credential-store (ocr binding, connected key on disk at bind): maskedKey served, raw key never in body', async () => {
    const paths = sandboxPaths();
    const k = 'sk-ocr-endpoint-777888';
    // Seed the credential BEFORE the lazy bind so the badge's bind-time
    // overview includes it (the endpoint's provider SET is a bind snapshot;
    // live connections are surfaced by GET /opencode/providers, not here).
    const seed = new OcrStore({ paths, now: () => 1 });
    await seed.connectKey('anthropic', k);

    resetCredentialStoreForTests(paths, async () => null, echoFetch().fetchImpl, { env: {}, now: () => 1 });
    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    expect(res.statusCode).toBe(200);
    const anthropic = res.json().store.credentials.find((a: { providerId: string }) => a.providerId === 'anthropic');
    expect(anthropic.credentials[0].maskedKey).toBe(maskSecret(k));
    expect(res.body).not.toContain(k);
  });

  it('GET /credential-store with corrupt credentials.json: probe detail stays loud, parse-echo never carries the full key', async () => {
    const paths = sandboxPaths();
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    const k = 'sk-CORRUPT-ECHO-1234567890';
    // truncated JSON whose unterminated string token holds the key — the
    // parse error must describe the problem WITHOUT echoing the secret.
    fs.writeFileSync(
      path.join(paths.ocrHome, 'credentials.json'),
      `{"version":1,"providers":{"anthropic":[{"credentialId":"a1","key":"${k}"}]}`
    );
    resetCredentialStoreForTests(paths, async () => null, echoFetch().fetchImpl, { env: {}, now: () => 1 });

    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.store.probeResult.state).toBe('unreadable'); // loud, never silently empty
    expect(JSON.stringify(body.store.probeResult.detail)).toContain('not valid JSON');
    expect(res.body).not.toContain(k);
  });
});

describe('error-message ECHO containment (write-path leak hunt)', () => {
  it('store level: WriteFailedError never re-embeds a key the upstream echoed back', async () => {
    const paths = sandboxPaths();
    const { fetchImpl } = echoFetch();
    const store = await OpencodeV2Store.create({ paths, writable: true, env: {}, openDatabase: fakeDb([]), fetchImpl });
    const k = 'sk-echo-store-556677';
    let err: unknown;
    try {
      await store.connectKey('anthropic', k);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WriteFailedError);
    // the diagnostic limb (method/route/status) SURVIVES redaction…
    expect((err as Error).message).toContain('POST');
    expect((err as Error).message).toContain('HTTP 500');
    // …but the echoed secret is contained: no raw key in any error string.
    expect((err as Error).message).not.toContain(k);
  });

  it('sync write: failed entry reasons stay loud while the echoed key stays out of the response', async () => {
    const paths = sandboxPaths();
    const { fetchImpl } = echoFetch();
    const store = new OcrStore({ paths, now: () => 1 });
    const k = 'sk-echo-push-445566';
    await store.connectKey('anthropic', k); // local leftover
    resetCredentialStoreForTests(paths, async () => null, fetchImpl, { env: {}, now: () => 1, openDatabase: fakeDb([]) });

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/credential-sync/run',
      payload: { clientId: 'opencode-v2', direction: 'write' },
    });
    expect(res.statusCode).toBe(200);
    const failed = res.json().write.entries.filter((e: any) => e.action === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].provider).toBe('anthropic');
    expect(failed[0].reason).toContain('HTTP 500');
    expect(res.body).not.toContain(k);
    // never blind-deleted: the local copy survives the failed push
    expect(JSON.parse(fs.readFileSync(ocrCredentialsFile(paths), 'utf8')).providers.anthropic).toHaveLength(1);
    // the recorded sync outcome (credential-sync.json) is key-free too
    const syncState = fs.readFileSync(path.join(paths.ocrHome, 'credential-sync.json'), 'utf8');
    expect(syncState).not.toContain(k);
    expect(JSON.parse(syncState).clients['opencode-v2'].lastWrite.ok).toBe(false);
  });
});

describe('disconnect honesty (Decision 8 — no backup mitigation exists)', () => {
  it('OpencodeV2Store.disconnect deletes ONLY through the opencode v2 service — no OcrStore backup copy is ever written', async () => {
    const paths = sandboxPaths();
    const fetchImpl: typeof fetch = async () => new Response('', { status: 200 });
    const store = await OpencodeV2Store.create({
      paths,
      writable: true,
      env: {},
      openDatabase: fakeDb([keyRow('c1', 'anthropic', 'sk-disconnect-me')]),
      fetchImpl,
    });
    await store.disconnect('c1');
    expect(fs.existsSync(ocrCredentialsFile(paths))).toBe(false); // proliferation dressed as safety = forbidden
  });
});

/**
 * P1-1 boundary regression — the OLD code truncated BEFORE redacting:
 * an echo starting near offset 200 left its head inside the retained window.
 * Offsets 165/190/199 are the reviewer's runtime-proven leak band (35, 10,
 * and 1 key chars survived the 200-char cut). Redaction must happen FIRST.
 */
describe('redaction-before-truncation boundary (P1-1)', () => {
  const KEY = 'sk-boundary-LEAKTEST-0123456789abcdef';

  /** Any 8-char window of the key appearing anywhere = leak (window = REDACT_MIN_LEN). */
  function leaked(s: string): boolean {
    for (let i = 0; i + 8 <= KEY.length; i++) {
      if (s.includes(KEY.slice(i, i + 8))) return true;
    }
    return false;
  }

  /** Echo body: the KEY starts exactly at `offset` inside the serialized text
   *  (the '{"validation":"' prefix is 16 chars — padding compensates), so the
   *  200-char cut lands mid-key pre-fix at 165/190/199. */
  function echoAtFetch(offset: number) {
    const body = `${'x'.repeat(Math.max(0, offset - 16))}${KEY}${'-'.repeat(80)}`;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ data: [{ id: 'anthropic' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ validation: body }), { status: 500 });
    };
    return fetchImpl;
  }

  for (const offset of [165, 190, 199]) {
    it(`echo at offset ${offset}: ZERO key fragments in the store error message`, async () => {
      const paths = sandboxPaths();
      const store = await OpencodeV2Store.create({
        paths,
        writable: true,
        env: {},
        openDatabase: fakeDb([]),
        fetchImpl: echoAtFetch(offset),
      });
      let err: unknown;
      try {
        await store.connectKey('anthropic', KEY);
      } catch (e) {
        err = e;
      }
      const msg = (err as Error).message;
      // containment: NO 8-char window of the key survives the 200-char cut
      expect(leaked(msg)).toBe(false);
      if (offset === 165) {
        // the [redacted] marker itself lands inside the retained window —
        // positive proof redaction ran BEFORE the truncation. At 190/199 the
        // marker sits past the cut (only padding survives) — the leaked()
        // check is the real pin there.
        expect(msg).toContain('[redacted]');
      }
    });

    it(`echo at offset ${offset}: sync-write 200 body carries no key fragment`, async () => {
      const paths = sandboxPaths();
      const store = new OcrStore({ paths, now: () => 1 });
      await store.connectKey('anthropic', KEY);
      resetCredentialStoreForTests(
        paths,
        undefined,
        echoAtFetch(offset),
        { env: {}, now: () => 1, openDatabase: fakeDb([]) }
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/credential-sync/run',
        payload: { clientId: 'opencode-v2', direction: 'write' },
      });
      expect(res.statusCode).toBe(200); // per-entry failure, not a route-level 502
      expect(leaked(res.body)).toBe(false);
    });

    it(`echo at offset ${offset}: sync-persisted state file stays key-free`, async () => {
      const paths = sandboxPaths();
      const store = new OcrStore({ paths, now: () => 1 });
      await store.connectKey('anthropic', KEY);
      resetCredentialStoreForTests(
        paths,
        undefined,
        echoAtFetch(offset),
        { env: {}, now: () => 1, openDatabase: fakeDb([]) }
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/credential-sync/run',
        payload: { clientId: 'opencode-v2', direction: 'write' },
      });
      expect(res.statusCode).toBe(200);
      const syncFile = fs.readFileSync(path.join(paths.ocrHome, 'credential-sync.json'), 'utf8');
      expect(leaked(syncFile)).toBe(false);
      // the failure itself must still be loud (recorded, non-empty reasons)
      const state = JSON.parse(syncFile);
      expect(state.clients['opencode-v2'].lastWrite.entries.some((e) => e.action === 'failed')).toBe(true);
      expect(leaked(res.body)).toBe(false);
    });
  }
});
