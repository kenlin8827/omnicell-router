import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CredentialPaths } from '../src/opencode/credentials/paths.js';
import { keyHashPrefix } from '../src/opencode/credentials/index.js';
import {
  resetCredentialStoreForTests,
  writeCredentialStoreState,
} from '../src/opencode/credentials/factory.js';
import { DbOpener } from '../src/opencode/credentials/opencode-v2-store.js';

/**
 * Console credential routes through the BOUND store.
 * Each route switched gets a test per bound-store shape that matters:
 *  opencode v2: happy HTTP write + WriteFailedError 5xx with NO OcrStore fallback,
 *      readonly refusal, integration-unmatched refusal, invalidate-on-
 *      mutation (db load counter), purgeAuth account loop w/ partial failure,
 *      store-resolved reads (test probe + models-pull live branch).
 *  per-account write surface (P2 tail): activate/rename/disconnect routes —
 *      capability gate, label contract, account cross-check guard, suspect
 *      clear on disconnect, write-failure passthrough (502/409, no fallback).
 *  opencode v1: legacy auth.json write/purge byte-identical (same file, same message).
 *  ocr: local credentials.json write; inline priority untouched.
 * Hermetic: XDG_* point at a per-test tmpdir (config/jsonc/auth.json live
 * there), the credential layer runs on injected sandbox CredentialPaths, and
 * fetch/sqlite/catalog/probe are mocked — the operator's home is never read.
 */

// ---------------------------------------------------------------------------
// in-memory seams for the module collaborators the routes import dynamically
// ---------------------------------------------------------------------------

let catalogRecs: any[] = [];
let integrationIds: string[] = ['anthropic', 'openai', 'myprov'];
// POST/PATCH sink handler. The method and body ride along so a test can make the
// fake persist what the sink would persist (rename writes the label, activate
// flips exactly one row) — a fixture that ignores its own writes proves nothing.
let postHandler: (
  url: string,
  info?: { method: string; body?: any }
) => { status: number; json?: unknown } = () => ({
  status: 200,
  json: { credential: { id: 'c-new' } },
});
let deleteHandler: (url: string) => number = () => 200;

const actualRepository = await import('../src/opencode/catalog/repository.js');
mock.module('../src/opencode/catalog/repository.js', () => ({
  ...actualRepository,
  catalogRepository: {
    list: async () => catalogRecs,
    getProvider: async (id: string) => catalogRecs.find((p) => p.id === id),
    lastSyncOrigin: 'test',
    minInputPrice: () => undefined,
    ensureOcrStore: async () => {},
  },
}));

const actualProbe = await import('../src/opencode/probe.js');
let probeCalls: any[] = [];
// Programmable probe seam — default keeps the historic always-green behavior;
// rotation tests replace it per-case (opts.model decides which candidate answers).
let probeImpl: (opts: any) => Promise<any> = async () => ({ ok: true, kind: 'openai', latencyMs: 5 });
mock.module('../src/opencode/probe.js', () => ({
  ...actualProbe,
  probeProvider: async (opts: any) => {
    probeCalls.push(opts);
    return probeImpl(opts);
  },
}));

const actualAutoPull = await import('../src/opencode/catalog/auto-pull.js');
let pullMode: 'live' | 'catalog' | null = null;
mock.module('../src/opencode/catalog/auto-pull.js', () => ({
  ...actualAutoPull,
  pullLiveModels: async () => {
    pullMode = 'live';
    return { httpStatus: 200, body: { success: true, pulled: 0 } };
  },
  pullCatalogModels: async () => {
    pullMode = 'catalog';
    return { httpStatus: 200, body: { success: true, pulled: 0 } };
  },
}));

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
// registry too: P3 step 3 tests drive pair breakers / SUSPECT flags through it.
const { app, registry } = createServer(baseConfig, true);

// ---------------------------------------------------------------------------
// sandbox: per-test tmpdir wired into BOTH the env-resolved opencode paths
// (XDG_*) and the injected CredentialPaths (same directories)
// ---------------------------------------------------------------------------

const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-console-routes-'));
  oldCfg = process.env.XDG_CONFIG_HOME;
  oldData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  const p = credPaths();
  fs.mkdirSync(p.configDir, { recursive: true });
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.writeFileSync(p.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  catalogRecs = [];
  integrationIds = ['anthropic', 'openai', 'myprov'];
  postHandler = () => ({ status: 200, json: { credential: { id: 'c-new' } } });
  deleteHandler = () => 200;
  probeCalls = [];
  probeImpl = async () => ({ ok: true, kind: 'openai', latencyMs: 5 });
  pullMode = null;
});

afterEach(() => {
  if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldCfg;
  if (oldData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldData;
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function fakeDb(rows: unknown[] = [], loads?: { loads: number }): DbOpener {
  return async () => ({
    query(sql: string) {
      return {
        all: () => {
          if (sql.includes('table_info')) return ALL_COLS.map((c) => ({ name: c }));
          if (loads) loads.loads += 1;
          return rows;
        },
      };
    },
    close() {
      // no-op
    },
  });
}

interface FetchCall {
  url: string;
  method: string;
  body?: any;
}
const fetchCalls: FetchCall[] = [];

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = String(init?.method ?? 'GET');
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  fetchCalls.push({ url, method, body });
  if (method === 'GET') {
    return new Response(JSON.stringify({ data: integrationIds.map((id) => ({ id, connections: [] })) }), {
      status: 200,
    });
  }
  if (method === 'DELETE') {
    const status = deleteHandler(url);
    return new Response(status === 200 ? '' : 'delete refused', { status });
  }
  const res = postHandler(url, { method, body });
  return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
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

function bindV2(paths: CredentialPaths, rows: unknown[] = [], loads?: { loads: number }) {
  fetchCalls.length = 0;
  resetCredentialStoreForTests(paths, async () => 'v2.0.15', fetchImpl, { env: {}, now: () => 1, sleep: async () => {}, openDatabase: fakeDb(rows, loads) });
}

function bindV2Readonly(paths: CredentialPaths, rows: unknown[] = []) {
  fetchCalls.length = 0;
  fs.writeFileSync(paths.opencodeDbPath, 'fake-db-bytes'); // db file IS the evidence (CLI absent)
  resetCredentialStoreForTests(paths, async () => null, fetchImpl, { env: {}, now: () => 1, openDatabase: fakeDb(rows) });
}

function bindV1Machine(paths: CredentialPaths) {
  fetchCalls.length = 0;
  resetCredentialStoreForTests(paths, async () => 'v1.4.6', fetchImpl, { env: {}, now: () => 1 });
}

function bindOcrStandalone(paths: CredentialPaths) {
  fetchCalls.length = 0;
  resetCredentialStoreForTests(paths, async () => null, fetchImpl, { env: {}, now: () => 1 });
}

function writeJsonc(p: CredentialPaths, body: unknown) {
  fs.writeFileSync(path.join(p.configDir, 'opencode.jsonc'), JSON.stringify(body, null, 2));
}

function readAuth(p: CredentialPaths): Record<string, any> {
  if (!fs.existsSync(p.authJsonPath)) return {};
  return JSON.parse(fs.readFileSync(p.authJsonPath, 'utf8'));
}

function readOcrFile(p: CredentialPaths): any {
  const file = path.join(p.ocrHome, 'credentials.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------

describe('POST /opencode/providers/:id/connect — bound-store routing', () => {
  it('opencode v2: writes go to the HTTP sink; NO credentials.json fallback, no auth.json write', async () => {
    const p = credPaths();
    bindV2(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-http-sink-123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    const posts = fetchCalls.filter((c) => c.method === 'POST');
    expect(posts.some((c) => c.url.includes('/api/integration/anthropic/connect/key') && c.body?.key === 'sk-http-sink-123456')).toBe(true);
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false);
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
  });

  it('opencode v2: WriteFailedError → 502 with reasonCode, retried once, NEVER falling back to OcrStore', async () => {
    const p = credPaths();
    postHandler = () => ({ status: 500, json: { error: 'boom' } });
    bindV2(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-failover-me' },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.reasonCode).toBe('write_failed');
    expect(body.success).toBe(false);
    // callService: initial + one re-read-service retry, both failed
    expect(fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('connect/key'))).toHaveLength(2);
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false); // Decision 3: write never proliferates
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
  });

  it('opencode v2: integration unmatched → 409 integration_unmatched (not a transport failure)', async () => {
    const p = credPaths();
    integrationIds = ['openai'];
    bindV2(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/nowhere/connect',
      payload: { apiKey: 'sk-x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reasonCode).toBe('integration_unmatched');
  });

  it('opencode v2-readonly (CLI absent, db present): every write refused 409 store_readonly', async () => {
    const p = credPaths();
    bindV2Readonly(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reasonCode).toBe('store_readonly');
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false);
  });


  it('ocr standalone: write lands on credentials.json (B3 regression closed)', async () => {
    const p = credPaths();
    bindOcrStandalone(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-ocr-local' },
    });
    expect(res.statusCode).toBe(200);
    const file = readOcrFile(p);
    expect(file.providers.anthropic[0].key).toBe('sk-ocr-local');
    expect(fs.existsSync(p.authJsonPath)).toBe(false); // auth.json no longer the standalone sink
  });

  it('opencode v2: successful mutation invalidates the cached view (Decision 3, load counter)', async () => {
    const p = credPaths();
    const loads = { loads: 0 };
    bindV2(p, [], loads);
    // lazy bind: the first route call runs create()+probe() — baseline after.
    await app.inject({ method: 'GET', url: '/api/admin/opencode/providers' });
    const afterBind = loads.loads;
    expect(afterBind).toBeGreaterThan(0);
    await app.inject({ method: 'GET', url: '/api/admin/opencode/providers' }); // within TTL: cached
    expect(loads.loads).toBe(afterBind);
    await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-invalidate-me' },
    });
    await app.inject({ method: 'GET', url: '/api/admin/opencode/providers' }); // post-invalidate: re-query
    // +2, not +1: a label-less connect now re-reads the created row to detect (and
    // clear) a name the sink invented — an extra query on a management action, never
    // on the request path. Both loads are post-invalidate, so the Decision 3
    // guarantee (the cache never survives a mutation) is unchanged.
    expect(loads.loads).toBe(afterBind + 2);
  });
});

describe('POST /opencode/providers/:id/key — same store routing', () => {
  it('key sink per binding: opencode v2 → HTTP; ocr standalone → local file; v1 machine → local file (auth.json stays untouched)', async () => {
    const p = credPaths();
    bindV2(p);
    let res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/key', payload: { apiKey: 'sk-k1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe(`Credential updated for 'anthropic'`);
    expect(fetchCalls.some((c) => c.method === 'POST' && c.body?.key === 'sk-k1')).toBe(true);
    expect(fs.existsSync(p.authJsonPath)).toBe(false);

    const p2 = credPaths();
    bindOcrStandalone(p2);
    res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/key', payload: { apiKey: 'sk-k2' } });
    expect(res.statusCode).toBe(200);
    expect(readOcrFile(p2).providers.anthropic[0].key).toBe('sk-k2');

    // v2 → the opencode service; ocr standalone → the local file. A detected opencode
    // v1 machine lands on that same local file (its own binding test covers it) —
    // auth.json is never a sink on any binding.
    const p3 = credPaths();
    fs.writeFileSync(p3.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-legacy-untouched' } }));
    bindV1Machine(p3);
    res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/openai/key', payload: { apiKey: 'sk-k3' } });
    expect(res.statusCode).toBe(200);
    expect(readOcrFile(p3).providers.openai[0].key).toBe('sk-k3');
    // auth.json still holds what the machine wrote there — OCR left it alone.
    expect(readAuth(p3).anthropic.key).toBe('sk-legacy-untouched');
  });

  it('missing apiKey keeps the legacy 400 shape', async () => {
    const p = credPaths();
    bindV2(p);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/key', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('apiKey is required');
  });
});

// ---------------------------------------------------------------------------
// Idempotent connect (identity at the write seam): handing
// a store a key it already holds for that provider must NOT create a second
// account — the chain is counted by member, so a duplicated row would double the
// key's weight in the new-session spread and render two indistinguishable rows.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Two live-reported defects: (1) opencode v2's /connect/key INVENTS a label from
// the integration display name, so "add a key without naming it" still produced
// `OpenCode Console` / `DeepSeek`; (2) the connected grid reordered itself when a
// credential was added, because provider order followed the credential table's
// `active DESC, time_updated DESC` view.
// ---------------------------------------------------------------------------

describe('connect — an unrequested label is not kept', () => {
  it('fresh connect with no caller label clears the name the sink invented', async () => {
    const p = credPaths();
    const rows: Record<string, unknown>[] = [];
    bindV2(p, rows);
    postHandler = (url) => {
      if (url.includes('connect/key')) {
        // what opencode itself writes for a label-less connect (verified live 2.0.15)
        rows.push({ ...keyRow('c-fresh', 'anthropic', 'sk-autolabel-1'), label: 'OpenCode Console' });
      }
      return { status: 200, json: { credential: { id: 'c-fresh' } } };
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-autolabel-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deduped).toBe(false);
    expect(res.json().account.label).toBeUndefined();
    expect(
      fetchCalls.some((c) => c.method === 'PATCH' && c.url.includes('/api/credential/c-fresh') && c.body?.label === '')
    ).toBe(true);
  });

  it('a caller-supplied label is left alone (no clear round-trip)', async () => {
    const p = credPaths();
    const rows: Record<string, unknown>[] = [];
    bindV2(p, rows);
    postHandler = (url) => {
      if (url.includes('connect/key')) rows.push({ ...keyRow('c-named', 'anthropic', 'sk-named-1'), label: 'Team B' });
      return { status: 200, json: { credential: { id: 'c-named' } } };
    };
    // Only the internal seam takes a label (no console route does today).
    const store = await (await import('../src/opencode/credentials/index.js')).getCredentialStore();
    await store.connectKey('anthropic', 'sk-named-1', 'Team B');
    expect(fetchCalls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});

describe('GET /opencode/providers — grid order is stable', () => {
  it('a NEWER credential on one provider does not move that provider in the grid', async () => {
    const p = credPaths();
    const rows: Record<string, unknown>[] = [
      { ...keyRow('c1', 'zhipu', 'sk-z-1'), label: 'API key', time_updated: 5 },
      { ...keyRow('c2', 'anthropic', 'sk-a-1'), label: 'API key', time_updated: 9 },
    ];
    bindV2(p, rows);
    const ids = async () =>
      (await app.inject({ method: 'GET', url: '/api/admin/opencode/providers' }))
        .json()
        .providers.map((x: { id: string }) => x.id);

    expect(await ids()).toEqual(['anthropic', 'zhipu']);

    // Simulate what the v2 view does after a connect to zhipu: its row now leads
    // the `ORDER BY active DESC, time_updated DESC` result set.
    rows.unshift({ ...keyRow('c3', 'zhipu', 'sk-z-2', 1), label: 'Zhipu', time_updated: 999 });
    expect(await ids()).toEqual(['anthropic', 'zhipu']);
  });
});

// ---------------------------------------------------------------------------
// Integration-scoped write gate: a stale credential row keeps ROUTING while the
// sink refuses every write for it (the integration was retired upstream). The
// status endpoint must hand the console the same registry the write consults, so
// the refusal is visible before the operator types a key — and an unreachable
// registry must NEVER read as "nothing is writable".
// ---------------------------------------------------------------------------

describe('GET /api/admin/credential-store — integration write gate', () => {
  it('opencode v2: reports the ids the sink accepts, including unmatched-but-stored providers', async () => {
    const p = credPaths();
    integrationIds = ['anthropic', 'openai'];
    bindV2(p, [keyRow('c1', 'codex-router', 'sk-stale-row')]);
    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    const st = res.json().store;
    expect(st.capabilities.integrationScoped).toBe(true);
    expect(st.integrations).toEqual(['anthropic', 'openai']);
    // The stale row is still listed (it routes) even though it cannot be written.
    expect(st.accounts.map((a: { providerId: string }) => a.providerId)).toContain('codex-router');
  });

  it('unreachable integration registry: the field is ABSENT (unknown), never an empty list', async () => {
    const p = credPaths();
    postHandler = () => ({ status: 500, json: { error: 'down' } });
    bindV2(p, [keyRow('c1', 'anthropic', 'sk-gate-down')]);
    // GET /api/integration is served by the fixture's GET branch; force a failure.
    const actualFetch = fetchImpl;
    resetCredentialStoreForTests(p, async () => 'v2.0.15', (async (input: any, init: any) => {
      if (String(init?.method ?? 'GET') === 'GET') return new Response('service down', { status: 503 });
      return actualFetch(input, init);
    }) as typeof fetch, { env: {}, now: () => 1, openDatabase: fakeDb([{ ...keyRow('c1', 'anthropic', 'sk-gate-down') }]) });
    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    expect(res.json().store.integrations).toBeUndefined();
  });

  it('v1 machine (unsupported_version -> OCR store) and OCR standalone: no gate at all (the field is never emitted)', async () => {
    const p1 = credPaths();
    bindV1Machine(p1);
    let res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    expect(res.json().store.capabilities.integrationScoped).toBe(false);
    expect(res.json().store.integrations).toBeUndefined();

    const p2 = credPaths();
    bindOcrStandalone(p2);
    res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    expect(res.json().store.capabilities.integrationScoped).toBe(false);
    expect(res.json().store.integrations).toBeUndefined();
  });
});

describe('connect/key idempotency — same key material never adds a second account', () => {
  it('opencode v2: existing key → deduped:true, existing account returned, ZERO HTTP writes', async () => {
    const p = credPaths();
    const key = 'sk-dedup-v2-existing';
    bindV2(p, [keyRow('c-existing', 'anthropic', key)]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: key },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.deduped).toBe(true);
    expect(body.account.id).toBe('c-existing');
    expect(body.account.keyHashPrefix).toBe(keyHashPrefix(key));
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // masked-only contract holds on the deduped reply too
    expect(res.body).not.toContain(key);
  });

  it('opencode v2: a DIFFERENT key still appends (multi-account is the point)', async () => {
    const p = credPaths();
    bindV2(p, [keyRow('c-existing', 'anthropic', 'sk-dedup-v2-held')]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-dedup-v2-brand-new' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deduped).toBe(false);
    expect(fetchCalls.some((c) => c.method === 'POST' && c.body?.key === 'sk-dedup-v2-brand-new')).toBe(true);
  });

  it('ocr standalone: two identical connects leave exactly ONE row in credentials.json', async () => {
    const p = credPaths();
    bindOcrStandalone(p);
    const key = 'sk-dedup-ocr-once';
    const first = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: key },
    });
    expect(first.json().deduped).toBe(false);
    const second = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: key },
    });
    expect(second.json().deduped).toBe(true);
    expect(second.json().account.id).toBe(first.json().account.id);
    expect(readOcrFile(p).providers.anthropic).toHaveLength(1);
  });

});

describe('GET /api/admin/credential-store — account list ordering', () => {
  it('active account is listed FIRST even when the store returns it last', async () => {
    const p = credPaths();
    // rows deliberately seeded standby-first: OcrStore-style file order must not
    // bury the active row under a capped drill-down view.
    bindV2(p, [keyRow('c-standby', 'anthropic', 'sk-order-standby', 0), keyRow('c-active', 'anthropic', 'sk-order-active', 1)]);
    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    const anthropic = res
      .json()
      .store.accounts.find((a: { providerId: string }) => a.providerId === 'anthropic');
    expect(anthropic.accounts.map((a: { id: string }) => a.id)).toEqual(['c-active', 'c-standby']);
    expect(anthropic.activeAccountId).toBe('c-active');
  });
});

describe('POST/PATCH /opencode/providers — implicit auth.json side-write suppression', () => {
  it('create with key on opencode v2 + authWriteDisabled: key → HTTP sink, auth.json untouched, config node written', async () => {
    const p = credPaths();
    writeCredentialStoreState(p, {
      bound: 'opencode-v2',
      version: 'v2.0.15',
      evidence: { cli: 'v2.0.15', file: null, used: 'cli', lastKnownGood: null },
      degradedCode: null,
      updatedAt: 1,
      reconcile: { doneAt: 1, authWriteDisabled: true, entries: [] },
    });
    bindV2(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'myprov', name: 'My', baseURL: 'https://x.test/v1', apiKey: 'sk-created-key', apiKeyInline: false },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchCalls.some((c) => c.method === 'POST' && c.url.includes('/api/integration/myprov/connect/key'))).toBe(true);
    const jsonc = JSON.parse(fs.readFileSync(path.join(p.configDir, 'opencode.jsonc'), 'utf8'));
    // on an opencode v2-bound machine the console writes the opencode v2 SHAPED node
    // (settings/baseURL, no npm/options) — the credential suppression rules
    // below are unchanged, only the def shape follows the bound store version.
    expect(jsonc.providers.myprov.settings.baseURL).toBe('https://x.test/v1');
    expect(jsonc.providers.myprov.npm).toBeUndefined();
    expect(jsonc.providers.myprov.options).toBeUndefined();
    // THE suppression assertions: no auth.json side-write, no ocr fallback file
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false);
  });

  it('create inline mode on opencode v2 — {env:VAR} translates to the opencode v2 env declaration, never a POST', async () => {
    const p = credPaths();
    bindV2(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'myprov', baseURL: 'https://x.test/v1', apiKey: '{env:MY_KEY}', apiKeyInline: true },
    });
    expect(res.statusCode).toBe(200);
    const jsonc = JSON.parse(fs.readFileSync(path.join(p.configDir, 'opencode.jsonc'), 'utf8'));
    // P4: a literal `{env:X}` string is not an opencode v2 concept — the writer
    // translates it to env:["X"] and drops the fake inline key (opencode v1 machines
    // still get options.apiKey verbatim; pinned in user-config.test.ts).
    expect(jsonc.providers.myprov.env).toEqual(['MY_KEY']);
    expect(jsonc.providers.myprov.settings?.apiKey).toBeUndefined();
    expect(jsonc.providers.myprov.options).toBeUndefined();
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });


  it('update with key on ocr standalone routes to the local store, auth.json stays absent', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://x.test/v1' } } } });
    bindOcrStandalone(p);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/opencode/providers/myprov',
      payload: { apiKey: 'sk-updated-ocr' },
    });
    expect(res.statusCode).toBe(200);
    expect(readOcrFile(p).providers.myprov[0].key).toBe('sk-updated-ocr');
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
  });
});

describe('DELETE /opencode/providers/:id?purgeAuth=1 — account loop through the store', () => {
  it('opencode v2 credential-only provider: loops listAccounts→disconnect, partial failure reported per account', async () => {
    const p = credPaths();
    bindV2(p, [keyRow('c1', 'anthropic', 'sk-loop-one'), keyRow('c2', 'anthropic', 'sk-loop-two')]);
    deleteHandler = (url) => (url.includes('/api/credential/c2') ? 500 : 200);
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/opencode/providers/anthropic?purgeAuth=1' });
    expect(res.statusCode).toBe(200); // HTTP 200 — the flip is additive, not a status code
    const body = res.json();
    const purge = body.purge;
    expect(purge.attempted).toBe(2);
    expect(purge.removed).toBe(1);
    expect(purge.failed).toHaveLength(1);
    // P1-3 contract: failed[] is {accountId, reason, reasonCode}; success:false
    // because a partial purge is NOT a successful removal (never-silent).
    expect(purge.failed[0].accountId).toBe('c2');
    expect(purge.failed[0].reasonCode).toBe('write_failed');
    expect(purge.failed[0].reason).toContain('HTTP 500');
    expect(body.success).toBe(false);
    expect(body.message).toContain('FAILED');
    expect(body.message).toContain('1/2');
    // DELETE calls: c1 once, c2 twice (callService retry) — no auth.json edit anywhere
    expect(fetchCalls.filter((c) => c.method === 'DELETE' && c.url.includes('/c1'))).toHaveLength(1);
    expect(fetchCalls.filter((c) => c.method === 'DELETE' && c.url.includes('/c2'))).toHaveLength(2);
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
    // Decision 8: no "backup into OcrStore" mitigation — disconnect deletes
    // the only copy through opencode v2, never proliferating a local fork as safety.
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false);
  });

  it('P1-3 total failure: every disconnect throws → success:false, nothing claimed removed', async () => {
    const p = credPaths();
    bindV2(p, [keyRow('c1', 'anthropic', 'sk-loop-one'), keyRow('c2', 'anthropic', 'sk-loop-two')]);
    deleteHandler = () => 500;
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/opencode/providers/anthropic?purgeAuth=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.purge).toMatchObject({ attempted: 2, removed: 0 });
    expect(body.purge.failed.map((f: { accountId: string }) => f.accountId)).toEqual(['c1', 'c2']);
    expect(body.message).toContain('FAILED');
  });

  it('P1-3 opencode v2-readonly: disconnect attempts fail loudly through failed[] (store_readonly), never silent removed=0', async () => {
    const p = credPaths();
    // CLI absent + db present → OpencodeV2Store-readonly; two stored rows so the loop
    // ATTEMPTS two disconnects, every one throwing CapabilityUnsupportedError.
    bindV2Readonly(p, [keyRow('c1', 'anthropic', 'sk-ro-one'), keyRow('c2', 'anthropic', 'sk-ro-two')]);
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/opencode/providers/anthropic?purgeAuth=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.purge.attempted).toBe(2);
    expect(body.purge.removed).toBe(0);
    expect(body.purge.failed.every((f: { reasonCode: string }) => f.reasonCode === 'store_readonly')).toBe(true);
    expect(fetchCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0); // refused before HTTP
  });


  it('config node + purgeAuth: node removed from jsonc, store accounts looped, deleteCustomProvider never fed purgeAuth', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible' } } });
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ myprov: { type: 'api', key: 'sk-side' } }));
    bindV2(p, [keyRow('c9', 'myprov', 'sk-side')]);
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/opencode/providers/myprov?purgeAuth=1' });
    expect(res.statusCode).toBe(200);
    const jsonc = JSON.parse(fs.readFileSync(path.join(p.configDir, 'opencode.jsonc'), 'utf8'));
    expect(jsonc.providers.myprov).toBeUndefined();
    expect(res.json().purge.removed).toBe(1);
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('/api/credential/c9'))).toBe(true);
    // the auth.json snapshot entry SURVIVES (Decision 4: OCR never deletes upstream files)
    expect(readAuth(p).myprov).toBeDefined();
  });
});

describe('POST /opencode/providers/:id/test — store-resolved probe key', () => {
  it('opencode v2: probes with the DB key, NOT the stale auth.json snapshot (blind-read drift closed)', async () => {
    const p = credPaths();
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-STALE-snapshot' } }));
    catalogRecs = [{ id: 'anthropic', models: [{ id: 'claude-x' }], api: 'https://api.anthropic.test/v1', npm: '@ai-sdk/anthropic' }];
    bindV2(p, [keyRow('c1', 'anthropic', 'sk-db-live-key')]);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/test', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0].apiKey).toBe('sk-db-live-key');
    expect(res.json().ok).toBe(true);
  });

  it('inline {env:VAR} keeps priority ABOVE the store (Decision 1, no fork of precedence)', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1', apiKey: '{env:OCR_ROUTE_TEST_KEY}' }} } });
    catalogRecs = [{ id: 'myprov', models: [{ id: 'm1' }] }];
    process.env.OCR_ROUTE_TEST_KEY = 'sk-inline-wins';
    try {
      bindV2(p, [keyRow('c1', 'myprov', 'sk-store-loses')]);
      const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/myprov/test', payload: {} });
      expect(res.statusCode).toBe(200);
      expect(probeCalls[0].apiKey).toBe('sk-inline-wins');
    } finally {
      delete process.env.OCR_ROUTE_TEST_KEY;
    }
  });

  it('no store key: legacy 400 oauthHint shape kept (raw oauth probing retired)', async () => {
    const p = credPaths();
    catalogRecs = [{ id: 'anthropic', models: [{ id: 'claude-x' }], api: 'https://x' }];
    bindV2(p, [
      {
        id: 'co',
        integration_id: 'anthropic',
        label: null,
        value: JSON.stringify({ type: 'oauth', access: 'tok', refresh: 'r', expires: 0, methodID: 'm', metadata: {} }),
        active: 1,
        time_created: 1,
        time_updated: 1,
      },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/test', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().oauthHint).toBe(true);
    expect(probeCalls).toHaveLength(0);
  });

  it('account-addressed probe tests the EXACT row, not the chain head (multi-account)', async () => {
    const p = credPaths();
    catalogRecs = [{ id: 'anthropic', models: [{ id: 'claude-x' }], api: 'https://api.anthropic.test/v1', npm: '@ai-sdk/anthropic' }];
    bindV2(p, [keyRow('c1', 'anthropic', 'sk-head-key', 1), keyRow('c2', 'anthropic', 'sk-backup-key', 0)]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/test',
      payload: { accountId: 'c2' },
    });
    expect(res.statusCode).toBe(200);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0].apiKey).toBe('sk-backup-key');
    const json = res.json();
    expect(json.account.id).toBe('c2');
    // masked echo only — the raw key never rides back in the response
    expect(JSON.stringify(json)).not.toContain('sk-backup-key');
  });

  it('addressed accountId intentionally BYPASSES inline-key precedence (test-this-row ≠ test-what-routing-picks)', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1', apiKey: '{env:OCR_ROUTE_TEST_KEY}' }} } });
    catalogRecs = [{ id: 'myprov', models: [{ id: 'm1' }] }];
    process.env.OCR_ROUTE_TEST_KEY = 'sk-inline-head';
    try {
      bindV2(p, [keyRow('c1', 'myprov', 'sk-c1', 1), keyRow('c2', 'myprov', 'sk-c2', 0)]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/opencode/providers/myprov/test',
        payload: { accountId: 'c2' },
      });
      expect(res.statusCode).toBe(200);
      expect(probeCalls[0].apiKey).toBe('sk-c2');
    } finally {
      delete process.env.OCR_ROUTE_TEST_KEY;
    }
  });

  it('unknown or non-routable accountId: 400, no probe', async () => {
    const p = credPaths();
    catalogRecs = [{ id: 'anthropic', models: [{ id: 'claude-x' }], api: 'https://x' }];
    bindV2(p, [keyRow('c1', 'anthropic', 'sk-live')]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/test',
      payload: { accountId: 'c-nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(probeCalls).toHaveLength(0);
  });

  it('default probe model skips non-text catalog heads (token-plan "url error" bug)', async () => {
    const p = credPaths();
    // Real-world shape: models.dev catalogs token-plan with video/image heads
    // first; the text wire probe on a video model answers 400 "url error".
    catalogRecs = [
      {
        id: 'anthropic',
        api: 'https://api.anthropic.test/v1',
        npm: '@ai-sdk/anthropic',
        models: [
          { id: 'vid-1', modalities: { input: ['text'], output: ['video'] } },
          { id: 'img-1', modalities: { input: ['text'], output: ['image'] } },
          // ASR shape: text OUTPUT but audio-only INPUT — the probe sends a
          // text "ping", so this cannot answer on the chat URL either.
          { id: 'asr-1', modalities: { input: ['audio'], output: ['text'] } },
          { id: 'hidden-txt', disabled: true, modalities: { input: ['text'], output: ['text'] } },
          { id: 'txt-1', modalities: { input: ['text'], output: ['text'] } },
        ],
      },
    ];
    bindV2(p, [keyRow('c1', 'anthropic', 'sk-live')]);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/test', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(probeCalls[0].model).toBe('txt-1');

    // All-non-text provider: unfiltered head stays the last resort (probeable anyway).
    probeCalls = [];
    catalogRecs = [
      {
        id: 'anthropic',
        api: 'https://api.anthropic.test/v1',
        npm: '@ai-sdk/anthropic',
        models: [{ id: 'vid-1', modalities: { input: ['text'], output: ['video'] } }],
      },
    ];
    const res2 = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/test', payload: {} });
    expect(res2.statusCode).toBe(200);
    expect(probeCalls[0].model).toBe('vid-1');

    // No modality data anywhere (most providers): head selection unchanged.
    probeCalls = [];
    catalogRecs = [
      { id: 'anthropic', api: 'https://api.anthropic.test/v1', npm: '@ai-sdk/anthropic', models: [{ id: 'claude-x' }] },
    ];
    const res3 = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/test', payload: {} });
    expect(res3.statusCode).toBe(200);
    expect(probeCalls[0].model).toBe('claude-x');
  });

  it('config-defined models: prefer the first def not known-non-text, keep explicit modelId verbatim', async () => {
    const p = credPaths();
    writeJsonc(p, {
      providers: {
        myprov: {
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: 'https://m.test/v1' },
          models: { vid: { modelID: 'vid-1' }, txt: { modelID: 'txt-1' } },
        },
      },
    });
    catalogRecs = [
      {
        id: 'myprov',
        models: [
          { id: 'vid-1', modalities: { input: ['text'], output: ['video'] } },
          { id: 'txt-1', modalities: { input: ['text'], output: ['text'] } },
        ],
      },
    ];
    bindV2(p, [keyRow('c1', 'myprov', 'sk-live')]);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/myprov/test', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(probeCalls[0].model).toBe('txt-1');

    // Explicit operator choice is never second-guessed by the modality filter.
    probeCalls = [];
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/myprov/test',
      payload: { modelId: 'vid' },
    });
    expect(res2.statusCode).toBe(200);
    expect(probeCalls[0].model).toBe('vid-1');
  });
});

describe('POST /opencode/providers/:id/test — model-scoped candidate rotation', () => {
  const arkCatalog = {
    id: 'arkprov',
    api: 'https://ark.test/api/v3',
    npm: '@ai-sdk/openai-compatible',
    models: [
      { id: 'head-not-open', modalities: { input: ['text'], output: ['text'] } },
      { id: 'second-not-open', modalities: { input: ['text'], output: ['text'] } },
      { id: 'third-open', modalities: { input: ['text'], output: ['text'] } },
      { id: 'fourth', modalities: { input: ['text'], output: ['text'] } },
    ],
  };

  it('provider-level test rotates past model-scoped 404s and goes green on a reachable model', async () => {
    const p = credPaths();
    catalogRecs = [arkCatalog];
    bindV2(p, [keyRow('c1', 'arkprov', 'sk-live')]);
    probeImpl = async (opts: any) =>
      opts.model === 'third-open'
        ? { ok: true, kind: 'openai', model: opts.model, latencyMs: 7 }
        : { ok: false, kind: 'openai', model: opts.model, latencyMs: 5, modelScoped: true, httpStatus: 404, upstreamBody: 'ModelNotOpen' };
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/arkprov/test', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(probeCalls.map((c) => c.model)).toEqual(['head-not-open', 'second-not-open', 'third-open']);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.model).toBe('third-open'); // the UI shows WHICH model answered green
  });

  it('connection-level failure (auth) does NOT rotate — one probe only', async () => {
    const p = credPaths();
    catalogRecs = [arkCatalog];
    bindV2(p, [keyRow('c1', 'arkprov', 'sk-live')]);
    probeImpl = async (opts: any) => ({ ok: false, kind: 'openai', model: opts.model, authHint: true, httpStatus: 401, hintCode: 'authFailed' });
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/arkprov/test', payload: {} });
    expect(res.json().ok).toBe(false);
    expect(probeCalls).toHaveLength(1);
  });

  it('explicit modelId is never substituted — a model-scoped failure reports as-is', async () => {
    const p = credPaths();
    catalogRecs = [arkCatalog];
    bindV2(p, [keyRow('c1', 'arkprov', 'sk-live')]);
    probeImpl = async (opts: any) => ({ ok: false, kind: 'openai', model: opts.model, modelScoped: true, httpStatus: 404, upstreamBody: 'ModelNotOpen' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/arkprov/test',
      payload: { modelId: 'head-not-open' },
    });
    expect(res.json().ok).toBe(false);
    expect(probeCalls).toHaveLength(1);
    expect(res.json().triedModels).toBeUndefined(); // single explicit probe = no rotation evidence
  });

  it('all candidates model-scoped: capped at 3, response carries triedModels', async () => {
    const p = credPaths();
    catalogRecs = [arkCatalog];
    bindV2(p, [keyRow('c1', 'arkprov', 'sk-live')]);
    probeImpl = async (opts: any) => ({ ok: false, kind: 'openai', model: opts.model, modelScoped: true, httpStatus: 404, upstreamBody: 'UnsupportedModel' });
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/arkprov/test', payload: {} });
    expect(res.json().ok).toBe(false);
    expect(probeCalls).toHaveLength(3); // PROBE_CANDIDATE_CAP — 'fourth' never tried
    expect(res.json().triedModels).toEqual(['head-not-open', 'second-not-open', 'third-open']);
  });
});

describe('POST /opencode/providers/:id/models/pull — liveCapable keyed on the store', () => {
  it('opencode v2: baseURL config + DB key (no auth.json) → LIVE pull chosen', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1' } } } });
    bindV2(p, [keyRow('c1', 'myprov', 'sk-pull-key')]);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/myprov/models/pull', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(pullMode).toBe('live');
  });

  it('opencode v2: config key absent everywhere → catalog fallback chosen', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1' } } } });
    bindV2(p, []);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/myprov/models/pull', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(pullMode).toBe('catalog');
  });
});

describe('GET /opencode/providers — masked store views', () => {
  it('opencode v2: DB accounts merge into the view (connected + masked key), auth.json leftovers never appear', async () => {
    const p = credPaths();
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ ghostprov: { type: 'api', key: 'sk-ghost' } }));
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1' } } } });
    bindV2(p, [keyRow('c1', 'myprov', 'sk-view-key-123456789'), keyRow('c2', 'anthropic', 'sk-view-anth')]);
    const res = await app.inject({ method: 'GET', url: '/api/admin/opencode/providers' });
    const body = res.json();
    const myprov = body.providers.find((v: { id: string }) => v.id === 'myprov');
    expect(myprov.auth.connected).toBe(true);
    expect(myprov.auth.type).toBe('api');
    expect(myprov.auth.keyMasked).toContain('••••');
    // credential-only store provider shows up without a config node
    const anthropic = body.providers.find((v: { id: string }) => v.id === 'anthropic');
    expect(anthropic.auth.connected).toBe(true);
    // stale auth.json-only provider must NOT masquerade as connected anymore
    expect(body.providers.find((v: { id: string }) => v.id === 'ghostprov')).toBeUndefined();
    expect(res.body).not.toContain('sk-view-key-123456789'); // masked only
  });


  it('ocr: local store accounts appear in the view', async () => {
    const p = credPaths();
    bindOcrStandalone(p);
    await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/connect', payload: { apiKey: 'sk-ocr-view-key1' } });
    const body = (await app.inject({ method: 'GET', url: '/api/admin/opencode/providers' }));
    const json = body.json();
    const anthropic = json.providers.find((v: { id: string }) => v.id === 'anthropic');
    expect(anthropic.auth.connected).toBe(true);
    expect(anthropic.auth.keyMasked).toContain('••••');
    // the store-merged list view is a management surface: masked only
    expect(body.body).not.toContain('sk-ocr-view-key1');
  });
});

// ---------------------------------------------------------------------------
// pair-health overlay on the credential-store status and
// the SUSPECT lifecycle (reconnect / Push clear it; nothing else does).
// ---------------------------------------------------------------------------

describe('GET /api/admin/credential-store — pair-health overlay (additive)', () => {
  it('adds suspect/openPairs/cooldownUntilMs per account; old fields untouched; masked-only', async () => {
    const p = credPaths();
    const keyA = 'sk-pair-health-A';
    const keyB = 'sk-pair-health-B';
    bindV2(p, [keyRow('c-a', 'anthropic', keyA), keyRow('c-b', 'anthropic', keyB, 0)]);
    const cb = registry.getCircuitBreakerManager();
    const prefixA = keyHashPrefix(keyA);
    const prefixB = keyHashPrefix(keyB);
    // B cooling in one pair; A administratively suspect (never auto-returns).
    cb.tripPair('mock-lite', prefixB, { cooldownMs: 600000 }, 'anthropic');
    cb.getAccountStateStore().mark('anthropic', prefixA, 'confirmed-bad key (test)');
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const anthropic = body.store.accounts.find((a: { providerId: string }) => a.providerId === 'anthropic');
      const a = anthropic.accounts.find((x: { id: string }) => x.id === 'c-a');
      const b = anthropic.accounts.find((x: { id: string }) => x.id === 'c-b');

      expect(a.suspect).toBe(true);
      expect(a.openPairs).toBe(0);
      expect(a.cooldownUntilMs).toBeUndefined();
      expect(b.suspect).toBe(false);
      expect(b.openPairs).toBe(1);
      expect(typeof b.cooldownUntilMs).toBe('number');
      expect(b.cooldownUntilMs).toBeGreaterThan(Date.now() - 1000);

      // ADDITIVE: the pre-P3 AccountMeta fields are all still there.
      expect(a).toMatchObject({ id: 'c-a', providerId: 'anthropic', type: 'api', active: true, routable: true });
      expect(a.keyHashPrefix).toBe(prefixA);
      expect(a.maskedKey).toContain('••••');
      // masking contract: no raw key material anywhere on the wire
      expect(res.body).not.toContain(keyA);
      expect(res.body).not.toContain(keyB);
    } finally {
      cb.getAccountStateStore().clear('anthropic', prefixA);
      cb.resetScoped('mock-lite', prefixB);
    }
  });

  it('accounts without a keyHash (oauth rows) get suspect:false + openPairs:0', async () => {
    const p = credPaths();
    bindV2(p, [
      {
        id: 'c-oauth',
        integration_id: 'zen',
        label: null,
        value: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 0, methodID: 'm', metadata: {} }),
        active: 0,
        time_created: 1,
        time_updated: 1,
      },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    const zen = res
      .json()
      .store.accounts.find((a: { providerId: string }) => a.providerId === 'zen');
    expect(zen.accounts[0].suspect).toBe(false);
    expect(zen.accounts[0].openPairs).toBe(0);
  });
});

describe('SUSPECT lifecycle — reconnect clears', () => {
  it('opencode v2 connect of the SAME key material lifts the flag (anchor = keyHashPrefix, not id/label)', async () => {
    const p = credPaths();
    bindV2(p);
    const key = 'sk-reconnect-clears-suspect';
    const prefix = keyHashPrefix(key);
    const state = registry.getCircuitBreakerManager().getAccountStateStore();
    state.mark('anthropic', prefix, 'confirmed-bad key (test)');
    expect(state.isSuspect('anthropic', prefix)).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: key },
    });
    expect(res.statusCode).toBe(200);
    expect(state.isSuspect('anthropic', prefix)).toBe(false);
  });

  it('connect of a DIFFERENT key does not lift the old account flag', async () => {
    const p = credPaths();
    bindV2(p);
    const oldKey = 'sk-old-suspect-keepme';
    const prefixOld = keyHashPrefix(oldKey);
    const state = registry.getCircuitBreakerManager().getAccountStateStore();
    state.mark('anthropic', prefixOld, 'confirmed-bad key (test)');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/opencode/providers/anthropic/connect',
        payload: { apiKey: 'sk-a-brand-new-key' },
      });
      expect(res.statusCode).toBe(200);
      expect(state.isSuspect('anthropic', prefixOld)).toBe(true); // old account stays out
    } finally {
      state.clear('anthropic', prefixOld);
    }
  });

  it('setKey rotation clears the pushed account too', async () => {
    const p = credPaths();
    bindV2(p);
    const key = 'sk-setkey-rotation-clears';
    const prefix = keyHashPrefix(key);
    const state = registry.getCircuitBreakerManager().getAccountStateStore();
    state.mark('anthropic', prefix, 'confirmed-bad key (test)');
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/key',
      payload: { apiKey: key },
    });
    expect(res.statusCode).toBe(200);
    expect(state.isSuspect('anthropic', prefix)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-account write surface — the store methods (activate/rename/
// disconnect) that previously had NO routes. Coverage: capability gate
// (Decision 1 flags only), label contract, cross-check guard (404
// account_not_found, no blind passthrough), Decision 6 suspect clear on
// disconnect, and Decision 3 write-failure passthrough (502/409, never an
// OcrStore fallback).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Operator takedown routes — OCR-side account state, deliberately NOT a
// credential-store write: refused by neither the read-only binding nor any
// capability flag, and lifted only by the matching enable route.
// ---------------------------------------------------------------------------

describe('POST .../accounts/:accountId/{disable,enable} — operator takedown', () => {
  const disableUrl = (providerId: string, accountId: string) =>
    `/api/admin/opencode/providers/${providerId}/accounts/${accountId}/disable`;
  const enableUrl = (providerId: string, accountId: string) =>
    `/api/admin/opencode/providers/${providerId}/accounts/${accountId}/enable`;

  it('ocr store: disabled rides the overlay, sinks the row last, and enable restores it', async () => {
    const p = credPaths();
    bindOcrStandalone(p);
    await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/connect', payload: { apiKey: 'sk-tk-live' } });
    await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/connect', payload: { apiKey: 'sk-tk-parked' } });

    let list = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' }))
      .json()
      .store.accounts.find((a: { providerId: string }) => a.providerId === 'anthropic').accounts;
    expect(list.every((a: { disabled: boolean }) => a.disabled === false)).toBe(true);
    const target = list[0];

    const off = await app.inject({ method: 'POST', url: disableUrl('anthropic', target.id), payload: { reason: 'quota burned' } });
    expect(off.statusCode).toBe(200);
    expect(off.json().disabled).toBe(true);
    expect(off.json().account.disabled).toBe(true);
    expect(off.json().account.disabledReason).toBe('quota burned');
    // Order: the takedown sorts below the live row regardless of active flags.
    expect(off.json().accounts.map((a: { id: string }) => a.id)).toEqual([list[1].id, target.id]);

    // Durable: a fresh read of the same state file still reports it.
    list = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' }))
      .json()
      .store.accounts.find((a: { providerId: string }) => a.providerId === 'anthropic').accounts;
    expect(list.find((a: { id: string }) => a.id === target.id).disabled).toBe(true);

    const on = await app.inject({ method: 'POST', url: enableUrl('anthropic', target.id), payload: {} });
    expect(on.statusCode).toBe(200);
    expect(on.json().disabled).toBe(false);
    expect(on.json().accounts.find((a: { id: string }) => a.id === target.id).disabled).toBe(false);
    // The key was never touched — both rows are still in the store.
    expect(readOcrFile(p).providers.anthropic).toHaveLength(2);
  });

  it('opencode v2-readonly binding: the takedown is still allowed (it is OCR state, not a store write)', async () => {
    const p = credPaths();
    bindV2Readonly(p, [keyRow('c-ro', 'anthropic', 'sk-readonly-takedown')]);
    const res = await app.inject({ method: 'POST', url: disableUrl('anthropic', 'c-ro'), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.disabled).toBe(true);
    // No upstream POST left the process: only the local state file changed.
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a row with no key hash cannot be taken down (Decision 5 identity), and an unknown id 404s', async () => {
    const p = credPaths();
    bindV2(p, [
      { id: 'c-oauth', integration_id: 'anthropic', label: 'oauth', value: { type: 'oauth' }, active: 0, time_created: 1, time_updated: 1 },
    ]);
    const res = await app.inject({ method: 'POST', url: disableUrl('anthropic', 'c-oauth'), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().reasonCode).toBe('no_key_identity');

    const missing = await app.inject({ method: 'POST', url: disableUrl('anthropic', 'nope'), payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().reasonCode).toBe('account_not_found');
  });
});

// ---------------------------------------------------------------------------
// Adding a key must not steal the chain head. opencode v2 activates whatever it
// just connected (verified live on 2.0.15), and `active` is ALSO the credential
// opencode's own CLI uses — so a bare "add account" gesture would silently
// repoint the operator's terminal. The write seam puts the previous head back and
// reports it, unless that head was already suspect or taken down (then the new key
// taking over IS the rotation being reached for).
// ---------------------------------------------------------------------------

describe('connect — chain head is not hijacked by a new key', () => {
  /** The sink's post-connect view: new row active, the old head demoted. */
  const hijackRows = (): Record<string, unknown>[] => [
    { ...keyRow('c-old', 'anthropic', 'sk-head-old', 0), label: 'Old head' },
    { ...keyRow('c-new', 'anthropic', 'sk-head-new', 1), label: 'OpenCode Console' },
  ];

  it('restores the previous head and reports headPreserved', async () => {
    const p = credPaths();
    // Pre-write view: c-old is the active, routable head.
    const rows: Record<string, unknown>[] = [{ ...keyRow('c-old', 'anthropic', 'sk-head-old', 1), label: 'Old head' }];
    bindV2(p, rows);
    postHandler = (url, info) => {
      if (url.includes('connect/key')) {
        rows.length = 0;
        rows.push(...hijackRows()); // opencode moved `active` to the new row
      }
      // The fake persists what the real sink persists: activate() flips exactly
      // one row, rename() writes the label it was handed ('' = cleared). Without
      // this the post-write re-read would report a state the fake never applied.
      if (info?.method === 'POST' && url.includes('/activate')) {
        const targetId = url.split('/credential/')[1]?.split('/')[0];
        for (const r of rows) r.active = r.id === targetId ? 1 : 0;
      }
      if (info?.method === 'PATCH' && url.includes('/api/credential/')) {
        const targetId = url.split('/credential/')[1]?.split('/')[0];
        const row = rows.find((r) => r.id === targetId);
        if (row) row.label = info.body?.label ?? '';
      }
      return { status: 200, json: { credential: { id: 'c-new' } } };
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-head-new' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().headPreserved?.id).toBe('c-old');
    // the reply's account reflects the RESTORED state: new row is not the head
    expect(res.json().account.active).toBe(false);
    expect(fetchCalls.some((c) => c.method === 'POST' && c.url.includes('/api/credential/c-old/activate'))).toBe(true);
    // ...and the invented label was still cleared in the same gesture
    expect(res.json().account.label).toBeUndefined();
  });

  it('a prior head that is SUSPECT is NOT defended — the new key keeps the head', async () => {
    const p = credPaths();
    const rows: Record<string, unknown>[] = [{ ...keyRow('c-old', 'anthropic', 'sk-sus-head', 1), label: 'Bad head' }];
    bindV2(p, rows);
    const state = registry.getCircuitBreakerManager().getAccountStateStore();
    state.mark('anthropic', keyHashPrefix('sk-sus-head'), 'confirmed-bad (test)');
    postHandler = (url) => {
      if (url.includes('connect/key')) {
        rows.length = 0;
        rows.push(
          { ...keyRow('c-old', 'anthropic', 'sk-sus-head', 0), label: 'Bad head' },
          { ...keyRow('c-new', 'anthropic', 'sk-sus-new', 1), label: 'New' }
        );
      }
      return { status: 200, json: { credential: { id: 'c-new' } } };
    };
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/opencode/providers/anthropic/connect',
        payload: { apiKey: 'sk-sus-new' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().headPreserved).toBeUndefined();
      expect(fetchCalls.some((c) => c.method === 'POST' && c.url.includes('/api/credential/c-old/activate'))).toBe(false);
    } finally {
      state.clear('anthropic', keyHashPrefix('sk-sus-head'));
    }
  });

  it('no prior head (first key) — nothing to restore, zero extra writes', async () => {
    const p = credPaths();
    const rows: Record<string, unknown>[] = [];
    bindV2(p, rows);
    postHandler = (url) => {
      if (url.includes('connect/key')) rows.push({ ...keyRow('c-first', 'anthropic', 'sk-first-ever', 1), label: 'API key' });
      return { status: 200, json: { credential: { id: 'c-first' } } };
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-first-ever' },
    });
    expect(res.json().headPreserved).toBeUndefined();
    expect(fetchCalls.filter((c) => c.url.includes('/activate'))).toHaveLength(0);
  });
});

describe('POST .../providers/:id/accounts/:accountId/activate', () => {
  it('opencode v2: HTTP sink /api/credential/{id}/activate; refreshed masked accounts inline (overlay shape)', async () => {
    const p = credPaths();
    const keyA = 'sk-act-A-key';
    const keyB = 'sk-act-B-key';
    bindV2(p, [keyRow('c-a', 'anthropic', keyA, 0), keyRow('c-b', 'anthropic', keyB)]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a/activate',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.account.id).toBe('c-a');
    expect(body.account.active).toBe(true);
    expect(
      fetchCalls.some((c) => c.method === 'POST' && c.url.includes('/api/credential/c-a/activate'))
    ).toBe(true);
    // refreshed inline list = store-status overlay shape (P3-step3 keys present),
    // ACTIVE-FIRST (c-b is the seeded active row; the store returned it last):
    // every account list the console renders is ordered by the routing priority
    // the chain actually uses, so a capped drill-down can never hide the live one.
    expect(body.accounts.map((a: { id: string }) => a.id)).toEqual(['c-b', 'c-a']);
    expect(body.accounts[0].suspect).toBe(false);
    expect(body.accounts[0].openPairs).toBe(0);
    // masked-only wire contract (Decision 1 risk limb)
    expect(res.body).not.toContain(keyA);
    expect(res.body).not.toContain(keyB);
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false);
  });

  it('ocr standalone: capabilities.activate=true → allowed; active flag flips in credentials.json', async () => {
    const p = credPaths();
    bindOcrStandalone(p);
    await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-ocr-acc-1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-ocr-acc-2' },
    });
    const before = readOcrFile(p).providers.anthropic;
    const secondId = before[1].accountId;
    expect(before[1].active).toBe(false); // first key for a provider is active by default
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/opencode/providers/anthropic/accounts/${secondId}/activate`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    const after = readOcrFile(p).providers.anthropic;
    expect(after.find((a: { accountId: string }) => a.accountId === secondId).active).toBe(true);
    expect(after.find((a: { accountId: string }) => a.accountId !== secondId).active).toBe(false);
  });


  it('capability gate: OpencodeV2Store-readonly (activate=false) → 400 BEFORE any HTTP call', async () => {
    const p = credPaths();
    bindV2Readonly(p, [keyRow('c-a', 'anthropic', 'sk-ro-activate')]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a/activate',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reasonCode).toBe('capability_unsupported');
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('cross-check guard: unknown id → 404 account_not_found, store never asked (no passthrough)', async () => {
    const p = credPaths();
    bindV2(p, [keyRow('c-a', 'anthropic', 'sk-guard-a')]);
    const cases = [
      { method: 'POST', url: '/api/admin/opencode/providers/anthropic/accounts/c-nope/activate' },
      { method: 'PATCH', url: '/api/admin/opencode/providers/anthropic/accounts/c-nope', payload: { label: 'x' } },
      { method: 'DELETE', url: '/api/admin/opencode/providers/anthropic/accounts/c-nope' },
    ] as const;
    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        ...('payload' in c ? { payload: c.payload } : {}),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().reasonCode).toBe('account_not_found');
    }
    expect(fetchCalls.filter((x) => x.url.includes('/api/credential/c-nope'))).toHaveLength(0);
  });

  it('cross-check guard: ocr account of ANOTHER provider is refused (findAccount is global)', async () => {
    const p = credPaths();
    bindOcrStandalone(p);
    await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-ocr-cross' },
    });
    const accId = readOcrFile(p).providers.anthropic[0].accountId;
    // The ocr store's findAccount(accountId) would happily resolve this id —
    // the route-level guard against listAccounts('openai') must not let it.
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/opencode/providers/openai/accounts/${accId}/activate`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().reasonCode).toBe('account_not_found');
    expect(readOcrFile(p).providers.anthropic[0].active).toBe(true); // untouched
  });

  it('service unreachable → 502 write_failed retried once, NEVER falls back to OcrStore', async () => {
    const p = credPaths();
    postHandler = () => ({ status: 500, json: { error: 'boom' } });
    bindV2(p, [keyRow('c-a', 'anthropic', 'sk-act-unreachable')]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a/activate',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().reasonCode).toBe('write_failed');
    expect(res.json().success).toBe(false);
    expect(
      fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/api/credential/c-a/activate'))
    ).toHaveLength(2); // initial + one re-read-service retry
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false);
  });
});

describe('PATCH .../providers/:id/accounts/:accountId — rename', () => {
  it('label contract: oversized / non-string → 400 invalid_label; success sends the TRIMMED label', async () => {
    const p = credPaths();
    bindV2(p, [keyRow('c-a', 'anthropic', 'sk-rename-a')]);
    for (const label of ['x'.repeat(81), 42]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/opencode/providers/anthropic/accounts/c-a',
        payload: { label },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().reasonCode).toBe('invalid_label');
    }
    expect(fetchCalls.filter((c) => c.method === 'PATCH')).toHaveLength(0); // nothing written for bad labels
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a',
      payload: { label: '  Team A  ' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().account.label).toBe('Team A');
    const patch = fetchCalls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toContain('/api/credential/c-a');
    expect(patch?.body).toEqual({ label: 'Team A' });
  });

  it('an EMPTY label is a valid CLEAR (OCR never invents a name, so opencode’s default must be removable)', async () => {
    const p = credPaths();
    bindV2(p, [keyRow('c-a', 'anthropic', 'sk-clear-a')]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a',
      payload: { label: '   ' }, // whitespace-only trims to empty = clear
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().account.label).toBeUndefined();
    expect(fetchCalls.find((c) => c.method === 'PATCH')?.body).toEqual({ label: '' });
  });

  it('ocr store: clearing DROPS the label field from credentials.json instead of storing ""', async () => {
    const p = credPaths();
    bindOcrStandalone(p);
    await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/connect', payload: { apiKey: 'sk-ocr-named' } });
    const accountId = readOcrFile(p).providers.anthropic[0].accountId;
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/opencode/providers/anthropic/accounts/${accountId}`,
      payload: { label: ' 我的 key ' },
    });
    expect(readOcrFile(p).providers.anthropic[0].label).toBe('我的 key');

    const clear = await app.inject({
      method: 'PATCH',
      url: `/api/admin/opencode/providers/anthropic/accounts/${accountId}`,
      payload: { label: '' },
    });
    expect(clear.statusCode).toBe(200);
    expect('label' in readOcrFile(p).providers.anthropic[0]).toBe(false);
    // And the refreshed overlay carries no label either (display falls back to the handle).
    expect(clear.json().accounts[0].label).toBeUndefined();
  });

  it('capability gate: rename=false (OpencodeV2Store-readonly) → 400 capability_unsupported', async () => {
    const p2 = credPaths();
    bindV2Readonly(p2, [keyRow('c-a', 'anthropic', 'sk-ro-rename')]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a',
      payload: { label: 'Team A' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reasonCode).toBe('capability_unsupported');
    expect(fetchCalls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('service unreachable → 502 write_failed (Decision 3: loud, no OcrStore fallback)', async () => {
    const p = credPaths();
    postHandler = () => ({ status: 500, json: { error: 'boom' } });
    bindV2(p, [keyRow('c-a', 'anthropic', 'sk-rename-fail')]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a',
      payload: { label: 'Team A' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().reasonCode).toBe('write_failed');
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false);
  });
});

describe('DELETE .../providers/:id/accounts/:accountId — disconnect (Decision 8: UI confirms, server honors)', () => {
  it('opencode v2 happy: DELETE sink + SUSPECT cleared for the keyHashPrefix captured BEFORE deletion', async () => {
    const p = credPaths();
    const keyA = 'sk-disc-clears-suspect';
    bindV2(p, [keyRow('c-a', 'anthropic', keyA)]);
    const prefix = keyHashPrefix(keyA);
    const state = registry.getCircuitBreakerManager().getAccountStateStore();
    state.mark('anthropic', prefix, 'confirmed-bad key (test)');
    expect(state.isSuspect('anthropic', prefix)).toBe(true);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.disconnected).toBe('c-a');
    expect(body.accounts.map((a: { id: string }) => a.id)).toContain('c-a');
    expect(
      fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('/api/credential/c-a'))
    ).toBe(true);
    expect(state.isSuspect('anthropic', prefix)).toBe(false);
  });

  it('failed disconnect keeps the SUSPECT mark (clear is success-only)', async () => {
    const p = credPaths();
    const keyA = 'sk-disc-fail-keeps';
    let deleteAttempts = 0;
    deleteHandler = () => {
      deleteAttempts += 1;
      return 500;
    };
    bindV2(p, [keyRow('c-a', 'anthropic', keyA)]);
    const prefix = keyHashPrefix(keyA);
    const state = registry.getCircuitBreakerManager().getAccountStateStore();
    state.mark('anthropic', prefix, 'confirmed-bad key (test)');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().reasonCode).toBe('write_failed');
    expect(deleteAttempts).toBe(2); // Decision 3: initial + one service.json retry
    expect(state.isSuspect('anthropic', prefix)).toBe(true);
    state.clear('anthropic', prefix);
  });

  it('OpencodeV2Store-readonly passthrough: no capability flag for disconnect → store refusal 409 store_readonly', async () => {
    const p = credPaths();
    bindV2Readonly(p, [keyRow('c-a', 'anthropic', 'sk-ro-disc')]);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/opencode/providers/anthropic/accounts/c-a',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reasonCode).toBe('store_readonly');
    expect(fetchCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(fs.existsSync(path.join(p.ocrHome, 'credentials.json'))).toBe(false);
  });
});
