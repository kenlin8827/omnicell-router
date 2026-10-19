import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CredentialPaths } from '../src/opencode/credentials/paths.js';
import { keyHashPrefix } from '../src/opencode/credentials/index.js';
import { resetCredentialStoreForTests } from '../src/opencode/credentials/factory.js';
import { OcrStore } from '../src/opencode/credentials/ocr-store.js';
import { DbOpener } from '../src/opencode/credentials/opencode-v2-store.js';

/**
 * POST /api/admin/credential-store/push — the write direction of credential
 * sync (OCR file → opencode v2, via its HTTP management API). The OCR file is
 * the single truth, so a push NEVER removes local entries: it converges the
 * CLIENT toward the OCR file (push accepted, or keyHash already present in
 * the db). Preconditions: an opencode v2 service reachable NOW and a readable
 * db — otherwise a 400 with a machine-readable reason code.
 * Frontend contract: {status:'ok', pushed: string[], failed:[{provider, reason}]}.
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
// registry too: P3 step 3 asserts the push route clears SUSPECT via its breaker layer.
const { app, registry } = createServer(baseConfig, true);

const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

function sandboxPaths(withServiceJson = true): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-push-'));
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
  if (withServiceJson) {
    fs.writeFileSync(paths.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  }
  return paths;
}

function fakeDb(rows: unknown[]): DbOpener {
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

const throwingOpener: DbOpener = async () => {
  throw new Error('SQLITE_CANTOPEN: unable to open database file');
};

const keyRow = (id: string, integration: string, key: string) => ({
  id,
  integration_id: integration,
  label: null,
  value: JSON.stringify({ type: 'key', key }),
  active: 1,
  time_created: 1,
  time_updated: 1,
});

interface FetchCall {
  url: string;
  method: string;
  body?: any;
}

function makeFetch(onPost: (url: string) => { status: number; json?: unknown }) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') {
      const ids = ['anthropic', 'openai', 'failing'];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id, connections: [] })) }), { status: 200 });
    }
    const res = onPost(url);
    return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
  };
  return { calls, fetchImpl };
}

/** Seed LOCAL leftovers through the real OcrStore (same file the route reads). */
async function seedLocal(paths: CredentialPaths, entries: [string, string][]): Promise<void> {
  const store = new OcrStore({ paths, now: () => 1 });
  for (const [provider, key] of entries) await store.connectKey(provider, key);
}

function readLocalFile(paths: CredentialPaths): any {
  const file = path.join(paths.ocrHome, 'credentials.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bindOcr(paths: CredentialPaths, fetchImpl: typeof fetch, openDatabase: DbOpener) {
  resetCredentialStoreForTests(paths, async () => null, fetchImpl, { env: {}, now: () => 1, openDatabase });
}

describe('POST /api/admin/credential-store/push', () => {
  it('happy + dedup + failure: client converges, local entries are ALWAYS kept', async () => {
    const paths = sandboxPaths();
    await seedLocal(paths, [
      ['anthropic', 'sk-push-brand-new'],
      ['openai', 'sk-dup-in-opencode-v2-db'], // already in the db → dedup, still converged
      ['failing', 'sk-push-fails'], // service 500 → keep local
    ]);
    const v2Rows = [keyRow('d1', 'openai', 'sk-dup-in-opencode-v2-db')];
    const { calls, fetchImpl } = makeFetch((url) =>
      url.includes('/api/integration/failing/connect/key') ? { status: 500, json: { error: 'nope' } } : { status: 200, json: { credential: { id: 'c1' } } }
    );
    bindOcr(paths, fetchImpl, fakeDb(v2Rows));

    const res = await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.pushed.sort()).toEqual(['anthropic', 'openai']);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].provider).toBe('failing');
    expect(typeof body.failed[0].reason).toBe('string');

    // HTTP: anthropic pushed once (success first try), openai NOT pushed (dedup), failing attempted twice (retry)
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.filter((c) => c.url.includes('/api/integration/anthropic/connect/key'))).toHaveLength(1);
    expect(posts.some((c) => c.url.includes('/api/integration/openai'))).toBe(false);
    expect(posts.filter((c) => c.url.includes('/api/integration/failing/connect/key'))).toHaveLength(2);
    expect(posts.find((c) => c.url.includes('anthropic'))?.body?.key).toBe('sk-push-brand-new');

    // The OCR file is the truth: every local entry SURVIVES the push —
    // converged or failed, nothing is ever blind-deleted from it.
    const local = readLocalFile(paths);
    expect(local.providers.anthropic).toHaveLength(1);
    expect(local.providers.openai).toHaveLength(1);
    expect(local.providers.failing).toHaveLength(1);
    expect(res.body).not.toContain('sk-push-brand-new'); // no raw key material in the response
  });

  it('provider filter: only the named provider converges', async () => {
    const paths = sandboxPaths();
    await seedLocal(paths, [
      ['anthropic', 'sk-filter-one'],
      ['openai', 'sk-filter-two'],
    ]);
    // id-bearing 201 → connectKey fast path; the no-id landing path is covered
    // by credentials-opencode-v2-writes (with the instant `sleep` seam).
    const { calls, fetchImpl } = makeFetch(() => ({ status: 200, json: { credential: { id: 'c1' } } }));
    bindOcr(paths, fetchImpl, fakeDb([]));
    const res = await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: { provider: 'anthropic' } });
    expect(res.json().pushed).toEqual(['anthropic']);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const local = readLocalFile(paths);
    expect(local.providers.anthropic).toHaveLength(1); // kept — OCR is the truth
    expect(local.providers.openai).toHaveLength(1); // untouched by a filtered push
  });

  it('re-push after convergence is a no-op (the db gained the row, dedup stops the re-POST)', async () => {
    const paths = sandboxPaths();
    await seedLocal(paths, [['anthropic', 'sk-once-only']]);
    // A db that GAINS the row on a successful POST — the real convergence shape.
    const v2Rows: unknown[] = [];
    let seq = 0;
    let posts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (String(init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ data: [{ id: 'anthropic', connections: [] }] }), { status: 200 });
      }
      posts += 1;
      const body = JSON.parse(String(init?.body ?? '{}'));
      v2Rows.push(keyRow(`c${++seq}`, 'anthropic', body.key));
      return new Response(JSON.stringify({ credential: { id: `c${seq}` } }), { status: 200 });
    };
    bindOcr(paths, fetchImpl, fakeDb(v2Rows));
    await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: {} });
    const postsBefore = posts;
    const res = await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', pushed: ['anthropic'], failed: [] });
    // dedup against the now-populated db: the second run posts NOTHING new
    expect(posts).toBe(postsBefore);
  });

  it('no opencode v2 service (no service.json, no env): 400 service_unreachable, locals untouched', async () => {
    const paths = sandboxPaths(false);
    await seedLocal(paths, [['anthropic', 'sk-orphan-key']]);
    const { calls, fetchImpl } = makeFetch(() => ({ status: 200 }));
    bindOcr(paths, fetchImpl, fakeDb([]));
    const res = await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.reasonCode).toBe('service_unreachable');
    expect(body.status).toBe('error');
    expect(body.pushed).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(readLocalFile(paths).providers.anthropic).toHaveLength(1);
  });

  it('opencode v2 db unreadable (service up, db down): 400 client_unreadable before any push', async () => {
    const paths = sandboxPaths();
    await seedLocal(paths, [['anthropic', 'sk-not-yet']]);
    const { calls, fetchImpl } = makeFetch(() => ({ status: 200 }));
    bindOcr(paths, fetchImpl, throwingOpener);
    const res = await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().reasonCode).toBe('client_unreadable');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(readLocalFile(paths).providers.anthropic).toHaveLength(1);
  });

  it('empty local store: plain 200 ok with nothing pushed', async () => {
    const paths = sandboxPaths(false); // not even a service needed — no work
    bindOcr(paths, async () => new Response('{}', { status: 200 }), fakeDb([]));
    const res = await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', pushed: [], failed: [] });
  });
});

describe('SUSPECT lifecycle — Push clears converged credentials', () => {
  it('pushed (and deduped) credentials get their flag lifted, anchored on the key hash', async () => {
    const paths = sandboxPaths();
    const freshKey = 'sk-push-clears-suspect';
    const dupKey = 'sk-dup-in-opencode-v2-db';
    await seedLocal(paths, [
      ['anthropic', freshKey],
      ['openai', dupKey], // deduped against the db — still a converged Push gesture
    ]);
    const v2Rows = [keyRow('d1', 'openai', dupKey)];
    const { fetchImpl } = makeFetch(() => ({ status: 200, json: { credential: { id: 'c1' } } }));
    bindOcr(paths, fetchImpl, fakeDb(v2Rows));

    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
    state.mark('anthropic', keyHashPrefix(freshKey), 'confirmed-bad key (test)');
    state.mark('openai', keyHashPrefix(dupKey), 'confirmed-bad key (test)');

    const res = await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().pushed.sort()).toEqual(['anthropic', 'openai']);

    // Decision 6: SUSPECT is cleared ONLY by manual reconnect or Push — both
    // converged credentials lift here; the clear keys on (provider, keyHashPrefix).
    expect(state.isSuspect('anthropic', keyHashPrefix(freshKey))).toBe(false);
    expect(state.isSuspect('openai', keyHashPrefix(dupKey))).toBe(false);
  });

  it('a FAILED push keeps the flag (no convergence, no clear)', async () => {
    const paths = sandboxPaths();
    const failingKey = 'sk-push-fails-keeps';
    await seedLocal(paths, [['failing', failingKey]]);
    const { fetchImpl } = makeFetch((url) =>
      url.includes('/api/integration/failing/connect/key') ? { status: 500, json: { error: 'nope' } } : { status: 200, json: {} }
    );
    bindOcr(paths, fetchImpl, fakeDb([]));
    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
    state.mark('failing', keyHashPrefix(failingKey), 'confirmed-bad key (test)');
    try {
      const res = await app.inject({ method: 'POST', url: '/api/admin/credential-store/push', payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json().failed[0].provider).toBe('failing');
      expect(state.isSuspect('failing', keyHashPrefix(failingKey))).toBe(true);
    } finally {
      state.clear('failing', keyHashPrefix(failingKey));
    }
  });
});
