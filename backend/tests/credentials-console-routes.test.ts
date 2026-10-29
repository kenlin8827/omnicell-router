import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CredentialPaths, ocrCredentialsFile } from '../src/opencode/credentials/paths.js';
import { keyHashPrefix } from '../src/opencode/credentials/index.js';
import {
  resetCredentialStoreForTests,
  writeCredentialStoreState,
} from '../src/opencode/credentials/factory.js';

/**
 * Console credential routes through the BOUND store.
 * The bind is ALWAYS the OCR file (credentials.json) — opencode v2 is a sync
 * client, not an alternative store — so every route lands on the local file:
 *  connect/key: local write + idempotent dedup (same keyHash never adds a row),
 *      no auth.json side-write on ANY binding.
 *  per-credential write surface: reorder/rename/disconnect routes — label
 *      contract, credential cross-check guard, suspect clear on disconnect.
 *  store-resolved reads: test probe key resolution + models-pull live branch.
 *  operator takedown: OCR-side state, not a store write.
 * Hermetic: XDG_* point at a per-test tmpdir (config/jsonc/auth.json live
 * there), the credential layer runs on injected sandbox CredentialPaths, and
 * fetch/catalog/probe are mocked — the operator's home is never read.
 */

// ---------------------------------------------------------------------------
// in-memory seams for the module collaborators the routes import dynamically
// ---------------------------------------------------------------------------

let catalogRecs: any[] = [];
// POST/PATCH sink handler (the opencode v2 service mock — only the credential-sync
// endpoints still talk HTTP; console routes never do).
let postHandler: (
  url: string,
  info?: { method: string; body?: any }
) => { status: number; json?: unknown } = () => ({
  status: 200,
  json: { credential: { id: 'c-new' } },
});

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

let oldOcrHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-console-routes-'));
  oldCfg = process.env.XDG_CONFIG_HOME;
  oldData = process.env.XDG_DATA_HOME;
  oldOcrHome = process.env.OCR_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  // The defs funnel resolves through OCR_HOME — align it with credPaths().ocrHome
  // so route writes and test assertions address the same providers.json.
  process.env.OCR_HOME = path.join(tmpDir, 'ocr-home');
  const p = credPaths();
  fs.mkdirSync(p.configDir, { recursive: true });
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.writeFileSync(p.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  catalogRecs = [];
  postHandler = () => ({ status: 200, json: { credential: { id: 'c-new' } } });
  probeCalls = [];
  probeImpl = async () => ({ ok: true, kind: 'openai', latencyMs: 5 });
  pullMode = null;
});

afterEach(() => {
  if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldCfg;
  if (oldData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldData;
  if (oldOcrHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = oldOcrHome;
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const fetchCalls: { url: string; method: string; body?: any }[] = [];

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = String(init?.method ?? 'GET');
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  fetchCalls.push({ url, method, body });
  if (method === 'GET') {
    return new Response(JSON.stringify({ data: ['anthropic', 'openai', 'myprov'].map((id) => ({ id, connections: [] })) }), {
      status: 200,
    });
  }
  const res = postHandler(url, { method, body });
  return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
};

/** The ONE binding: the OCR file. Evidence seams are inert — nothing selects a store. */
function bindStore(paths: CredentialPaths) {
  fetchCalls.length = 0;
  resetCredentialStoreForTests(paths, undefined, fetchImpl, { env: {}, now: () => 1 });
}

import { readProviderDefsFile, writeProviderDefs } from '../src/opencode/provider-defs.js';

/** Seed the OCR file directly — the bound store reads it per call. */
function seedOcr(
  p: CredentialPaths,
  providers: Record<string, Array<{ id: string; key: string; label?: string; active?: boolean }>>
): void {
  fs.mkdirSync(p.ocrHome, { recursive: true });
  fs.writeFileSync(
    ocrCredentialsFile(p),
    JSON.stringify({
      version: 1,
      providers: Object.fromEntries(
        Object.entries(providers).map(([prov, rows]) => [
          prov,
          rows.map((r) => ({
            credentialId: r.id,
            ...(r.label !== undefined ? { label: r.label } : {}),
            key: r.key,
            timeCreated: 1,
            timeUpdated: 1,
            active: r.active ?? true,
          })),
        ])
      ),
    })
  );
}

function writeJsonc(p: CredentialPaths, body: any) {
  writeProviderDefs((body?.providers ?? {}) as Record<string, any>, p);
}

function readJsoncProviders(p: CredentialPaths): any {
  return readProviderDefsFile(p)?.providers ?? {};
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

describe('POST /opencode/providers/:id/connect — the local store is the sink', () => {
  it('write lands on credentials.json; auth.json is never a sink', async () => {
    const p = credPaths();
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-ocr-local' },
    });
    expect(res.statusCode).toBe(200);
    const file = readOcrFile(p);
    expect(file.providers.anthropic[0].key).toBe('sk-ocr-local');
    expect(fs.existsSync(p.authJsonPath)).toBe(false); // auth.json no longer a sink on any binding
  });

  it('a pre-existing auth.json survives a connect untouched', async () => {
    const p = credPaths();
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-legacy-untouched' } }));
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/openai/connect',
      payload: { apiKey: 'sk-new-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(readOcrFile(p).providers.openai[0].key).toBe('sk-new-key');
    expect(readAuth(p).anthropic.key).toBe('sk-legacy-untouched');
  });

  it('adding a second key does not move the active head (first key stays active)', async () => {
    const p = credPaths();
    bindStore(p);
    const first = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-head-one' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-head-two' },
    });
    expect(second.json().headPreserved).toBeUndefined(); // nothing was hijacked — nothing to restore
    const rows = readOcrFile(p).providers.anthropic;
    expect(rows.find((r: { key: string }) => r.key === 'sk-head-one').active).toBe(true);
    expect(rows.find((r: { key: string }) => r.key === 'sk-head-two').active).toBe(false);
    expect(first.json().credential.active).toBe(true);
    expect(second.json().credential.active).toBe(false);
  });
});

describe('hot credential-chain refresh — the runtime chain tracks the store without a restart', () => {
  const HOT = 'hot-chain-provider'; // unique id — the module-level registry outlives each test

  it('connect adds the new key to the live chain; reorder moves the head; disconnect removes it', async () => {
    const p = credPaths();
    bindStore(p);

    // Boot degeneracy: pretend the process started with ONE key (key A).
    await app.inject({
      method: 'POST',
      url: `/api/admin/opencode/providers/${HOT}/connect`,
      payload: { apiKey: 'sk-hot-a' },
    });
    const chain1 = registry.getCredentialChain(HOT) ?? [];
    expect(chain1.map((c: { keyHashPrefix: string }) => c.keyHashPrefix)).toEqual([keyHashPrefix('sk-hot-a')]);

    // Second key lands in the store AND in the live chain (head unchanged —
    // connectKeyIdempotent preserved the active row).
    await app.inject({
      method: 'POST',
      url: `/api/admin/opencode/providers/${HOT}/connect`,
      payload: { apiKey: 'sk-hot-b' },
    });
    const chain2 = registry.getCredentialChain(HOT) ?? [];
    expect(chain2.map((c: { keyHashPrefix: string }) => c.keyHashPrefix)).toEqual([
      keyHashPrefix('sk-hot-a'),
      keyHashPrefix('sk-hot-b'),
    ]);
    // Reorder — key B becomes the chain head, hot.
    const rows = readOcrFile(p).providers[HOT];
    const bRow = rows.find((r: { key: string }) => r.key === 'sk-hot-b');
    const aRow = rows.find((r: { key: string }) => r.key === 'sk-hot-a');
    const act = await app.inject({
      method: 'POST',
      url: `/api/admin/opencode/providers/${HOT}/credentials/reorder`,
      payload: { ids: [bRow.credentialId, aRow.credentialId] },
    });
    expect(act.statusCode).toBe(200);
    expect((registry.getCredentialChain(HOT) ?? [])[0].keyHashPrefix).toBe(keyHashPrefix('sk-hot-b'));

    // Disconnect key B — it leaves the live chain immediately.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/opencode/providers/${HOT}/credentials/${bRow.credentialId}?clientRevoke=0`,
    });
    expect(del.statusCode).toBe(200);
    const chain3 = registry.getCredentialChain(HOT) ?? [];
    expect(chain3.map((c: { keyHashPrefix: string }) => c.keyHashPrefix)).toEqual([keyHashPrefix('sk-hot-a')]);
  });
});

describe('POST /opencode/providers/:id/key — same store routing', () => {
  it('key route → the local file; a legacy auth.json stays untouched', async () => {
    const p = credPaths();
    // A DIFFERENT provider in auth.json (the bind-time one-shot import will
    // fold it in) — the key route's own target must not collide with it.
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ legacyprov: { type: 'api', key: 'sk-legacy-untouched' } }));
    bindStore(p);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/key', payload: { apiKey: 'sk-k1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe(`Credential updated for 'anthropic'`);
    expect(readOcrFile(p).providers.anthropic[0].key).toBe('sk-k1');
    // auth.json still holds what the machine wrote there — OCR left it alone.
    expect(readAuth(p).legacyprov.key).toBe('sk-legacy-untouched');
  });

  it('missing apiKey keeps the legacy 400 shape', async () => {
    const p = credPaths();
    bindStore(p);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/key', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('apiKey is required');
  });
});

describe('GET /opencode/providers — grid order is stable', () => {
  it('a NEWER credential on one provider does not move that provider in the grid', async () => {
    const p = credPaths();
    seedOcr(p, {
      anthropic: [{ id: 'c2', key: 'sk-a-1' }],
      zhipu: [{ id: 'c1', key: 'sk-z-1' }],
    });
    bindStore(p);
    const ids = async () =>
      (await app.inject({ method: 'GET', url: '/api/admin/opencode/providers' }))
        .json()
        .providers.map((x: { id: string }) => x.id);

    expect(await ids()).toEqual(['anthropic', 'zhipu']);

    // A connect to the SECOND provider must not reorder the grid.
    await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/zhipu/connect',
      payload: { apiKey: 'sk-z-2' },
    });
    expect(await ids()).toEqual(['anthropic', 'zhipu']);
  });
});

describe('GET /api/admin/credential-store — no integration gate on the OCR binding', () => {
  it('integrationScoped false; the ids field is never emitted', async () => {
    const p = credPaths();
    seedOcr(p, { anthropic: [{ id: 'c1', key: 'sk-gate-free' }] });
    bindStore(p);
    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    const st = res.json().store;
    expect(st.capabilities.integrationScoped).toBe(false);
    expect(st.integrations).toBeUndefined();
  });
});

describe('connect/key idempotency — same key material never adds a second credential', () => {
  it('existing key → deduped:true, existing credential returned, ZERO HTTP writes', async () => {
    const p = credPaths();
    const key = 'sk-dedup-existing';
    seedOcr(p, { anthropic: [{ id: 'c-existing', key }] });
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: key },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.deduped).toBe(true);
    expect(body.credential.id).toBe('c-existing');
    expect(body.credential.keyHashPrefix).toBe(keyHashPrefix(key));
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0); // the store is local — no HTTP at all
    // masked-only contract holds on the deduped reply too
    expect(res.body).not.toContain(key);
    expect(readOcrFile(p).providers.anthropic).toHaveLength(1);
  });

  it('a DIFFERENT key still appends (multi-credential is the point)', async () => {
    const p = credPaths();
    seedOcr(p, { anthropic: [{ id: 'c-existing', key: 'sk-dedup-held' }] });
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-dedup-brand-new' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deduped).toBe(false);
    expect(readOcrFile(p).providers.anthropic).toHaveLength(2);
  });

  it('ocr standalone: two identical connects leave exactly ONE row in credentials.json', async () => {
    const p = credPaths();
    bindStore(p);
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
    expect(second.json().credential.id).toBe(first.json().credential.id);
    expect(readOcrFile(p).providers.anthropic).toHaveLength(1);
  });
});

describe('GET /api/admin/credential-store — credential list ordering', () => {
  it('active credential is listed FIRST even when the file lists it last', async () => {
    const p = credPaths();
    // rows deliberately seeded standby-first: file order must not bury the
    // active row under a capped drill-down view.
    seedOcr(p, {
      anthropic: [
        { id: 'c-standby', key: 'sk-order-standby', active: false },
        { id: 'c-active', key: 'sk-order-active', active: true },
      ],
    });
    bindStore(p);
    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    const anthropic = res
      .json()
      .store.credentials.find((a: { providerId: string }) => a.providerId === 'anthropic');
    expect(anthropic.credentials.map((a: { id: string }) => a.id)).toEqual(['c-active', 'c-standby']);
    expect(anthropic.activeCredentialId).toBe('c-active');
  });
});

describe('POST/PATCH /opencode/providers — implicit auth.json side-write suppression', () => {
  it('create with key: key → the local store, auth.json untouched, config node written', async () => {
    const p = credPaths();
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'myprov', name: 'My', baseURL: 'https://x.test/v1', apiKey: 'sk-created-key', apiKeyInline: false },
    });
    expect(res.statusCode).toBe(200);
    const jsonc: any = readJsoncProviders(p);
    expect(jsonc.myprov).toBeDefined();
    // THE suppression assertions: no auth.json side-write — the key went to the store
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
    expect(readOcrFile(p).providers.myprov[0].key).toBe('sk-created-key');
  });

  it('create inline mode — {env:VAR} translates to the env declaration, never a store key', async () => {
    const p = credPaths();
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'myprov', baseURL: 'https://x.test/v1', apiKey: '{env:MY_KEY}', apiKeyInline: true },
    });
    expect(res.statusCode).toBe(200);
    const jsonc: any = readJsoncProviders(p);
    // P4: a literal `{env:X}` string is not a store key — the writer translates
    // it to env:["X"] and drops the fake inline key.
    expect(jsonc.myprov.env).toEqual(['MY_KEY']);
    expect(jsonc.myprov.settings?.apiKey).toBeUndefined();
    // nothing landed in the credential store for an inline key
    expect(readOcrFile(p)?.providers?.myprov ?? []).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('update with key routes to the local store, auth.json stays absent', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://x.test/v1' } } } });
    bindStore(p);
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

describe('DELETE /opencode/providers/:id?purgeAuth=1 — credential loop through the store', () => {
  it('config node + purgeAuth: node removed from jsonc, store credentials looped, auth.json survives', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible' } } });
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ myprov: { type: 'api', key: 'sk-side' } }));
    seedOcr(p, { myprov: [{ id: 'c9', key: 'sk-side' }] });
    bindStore(p);
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/opencode/providers/myprov?purgeAuth=1' });
    expect(res.statusCode).toBe(200);
    const jsonc: any = readJsoncProviders(p);
    expect(jsonc.myprov).toBeUndefined();
    expect(res.json().purge).toMatchObject({ attempted: 1, removed: 1 });
    // the auth.json snapshot entry SURVIVES (OCR never deletes upstream files)
    expect(readAuth(p).myprov).toBeDefined();
  });
});

describe('POST /opencode/providers/:id/test — store-resolved probe key', () => {
  it('probes with the STORE key, NOT the stale auth.json snapshot (blind-read drift closed)', async () => {
    const p = credPaths();
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-STALE-snapshot' } }));
    catalogRecs = [{ id: 'anthropic', models: [{ id: 'claude-x' }], api: 'https://api.anthropic.test/v1', npm: '@ai-sdk/anthropic' }];
    seedOcr(p, { anthropic: [{ id: 'c1', key: 'sk-store-live-key' }] });
    bindStore(p);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/test', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0].apiKey).toBe('sk-store-live-key');
    expect(res.json().ok).toBe(true);
  });

  it('inline {env:VAR} keeps priority ABOVE the store (Decision 1, no fork of precedence)', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1', apiKey: '{env:OCR_ROUTE_TEST_KEY}' }} } });
    catalogRecs = [{ id: 'myprov', models: [{ id: 'm1' }] }];
    process.env.OCR_ROUTE_TEST_KEY = 'sk-inline-wins';
    try {
      seedOcr(p, { myprov: [{ id: 'c1', key: 'sk-store-loses' }] });
      bindStore(p);
      const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/myprov/test', payload: {} });
      expect(res.statusCode).toBe(200);
      expect(probeCalls[0].apiKey).toBe('sk-inline-wins');
    } finally {
      delete process.env.OCR_ROUTE_TEST_KEY;
    }
  });

  it('credential-addressed probe tests the EXACT row, not the chain head (multi-credential)', async () => {
    const p = credPaths();
    catalogRecs = [{ id: 'anthropic', models: [{ id: 'claude-x' }], api: 'https://api.anthropic.test/v1', npm: '@ai-sdk/anthropic' }];
    seedOcr(p, {
      anthropic: [
        { id: 'c1', key: 'sk-head-key', active: true },
        { id: 'c2', key: 'sk-backup-key', active: false },
      ],
    });
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/test',
      payload: { credentialId: 'c2' },
    });
    expect(res.statusCode).toBe(200);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0].apiKey).toBe('sk-backup-key');
    const json = res.json();
    expect(json.credential.id).toBe('c2');
    // masked echo only — the raw key never rides back in the response
    expect(JSON.stringify(json)).not.toContain('sk-backup-key');
  });

  it('addressed credentialId intentionally BYPASSES inline-key precedence (test-this-row ≠ test-what-routing-picks)', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1', apiKey: '{env:OCR_ROUTE_TEST_KEY}' }} } });
    catalogRecs = [{ id: 'myprov', models: [{ id: 'm1' }] }];
    process.env.OCR_ROUTE_TEST_KEY = 'sk-inline-head';
    try {
      seedOcr(p, {
        myprov: [
          { id: 'c1', key: 'sk-c1', active: true },
          { id: 'c2', key: 'sk-c2', active: false },
        ],
      });
      bindStore(p);
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/opencode/providers/myprov/test',
        payload: { credentialId: 'c2' },
      });
      expect(res.statusCode).toBe(200);
      expect(probeCalls[0].apiKey).toBe('sk-c2');
    } finally {
      delete process.env.OCR_ROUTE_TEST_KEY;
    }
  });

  it('unknown or non-routable credentialId: 400, no probe', async () => {
    const p = credPaths();
    catalogRecs = [{ id: 'anthropic', models: [{ id: 'claude-x' }], api: 'https://x' }];
    seedOcr(p, { anthropic: [{ id: 'c1', key: 'sk-live' }] });
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/test',
      payload: { credentialId: 'c-nope' },
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
    seedOcr(p, { anthropic: [{ id: 'c1', key: 'sk-live' }] });
    bindStore(p);
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
    seedOcr(p, { myprov: [{ id: 'c1', key: 'sk-live' }] });
    bindStore(p);
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
    seedOcr(p, { arkprov: [{ id: 'c1', key: 'sk-live' }] });
    bindStore(p);
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
    seedOcr(p, { arkprov: [{ id: 'c1', key: 'sk-live' }] });
    bindStore(p);
    probeImpl = async (opts: any) => ({ ok: false, kind: 'openai', model: opts.model, authHint: true, httpStatus: 401, hintCode: 'authFailed' });
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/arkprov/test', payload: {} });
    expect(res.json().ok).toBe(false);
    expect(probeCalls).toHaveLength(1);
  });

  it('explicit modelId is never substituted — a model-scoped failure reports as-is', async () => {
    const p = credPaths();
    catalogRecs = [arkCatalog];
    seedOcr(p, { arkprov: [{ id: 'c1', key: 'sk-live' }] });
    bindStore(p);
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
    seedOcr(p, { arkprov: [{ id: 'c1', key: 'sk-live' }] });
    bindStore(p);
    probeImpl = async (opts: any) => ({ ok: false, kind: 'openai', model: opts.model, modelScoped: true, httpStatus: 404, upstreamBody: 'UnsupportedModel' });
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/arkprov/test', payload: {} });
    expect(res.json().ok).toBe(false);
    expect(probeCalls).toHaveLength(3); // PROBE_CANDIDATE_CAP — 'fourth' never tried
    expect(res.json().triedModels).toEqual(['head-not-open', 'second-not-open', 'third-open']);
  });
});

describe('POST /opencode/providers/:id/models/pull — liveCapable keyed on the store', () => {
  it('baseURL config + store key (no auth.json) → LIVE pull chosen', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1' } } } });
    seedOcr(p, { myprov: [{ id: 'c1', key: 'sk-pull-key' }] });
    bindStore(p);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/myprov/models/pull', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(pullMode).toBe('live');
  });

  it('config key absent everywhere → catalog fallback chosen', async () => {
    const p = credPaths();
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1' } } } });
    bindStore(p);
    const res = await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/myprov/models/pull', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(pullMode).toBe('catalog');
  });
});

describe('every connected provider is model-manageable — the defs node is the single landing spot', () => {
  it('GET models on a never-connected provider → 404 (no credential, no node)', async () => {
    bindStore(credPaths()); // empty store — no credential rows at all
    const res = await app.inject({ method: 'GET', url: '/api/admin/opencode/providers/zedprov/models' });
    expect(res.statusCode).toBe(404);
  });

  it('GET models on a connected provider with an empty node → 200 empty manageable universe', async () => {
    const p = credPaths();
    seedOcr(p, { zedprov: [{ id: 'c1', key: 'sk-managed-key' }] });
    writeJsonc(p, { providers: { zedprov: { package: '@opencode-ai/provider/openai-compatible' } } });
    bindStore(p);
    const res = await app.inject({ method: 'GET', url: '/api/admin/opencode/providers/zedprov/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', id: 'zedprov', models: {} });
  });

  it('add on a connected provider lands in providers.json and reads back', async () => {
    const p = credPaths();
    seedOcr(p, { zedprov: [{ id: 'c1', key: 'sk-managed-key' }] });
    writeJsonc(p, { providers: { zedprov: { package: '@opencode-ai/provider/openai-compatible' } } });
    bindStore(p);
    const add = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/zedprov/models',
      payload: { id: 'glm-manual', name: 'Manual Model', cost: { input: 1, output: 4 } },
    });
    expect(add.statusCode).toBe(200);
    const node = readJsoncProviders(p).zedprov;
    expect(Object.keys(node.models)).toEqual(['glm-manual']);

    const list = await app.inject({ method: 'GET', url: '/api/admin/opencode/providers/zedprov/models' });
    expect(list.statusCode).toBe(200);
    expect(Object.keys(list.json().models)).toEqual(['glm-manual']);
  });

  it('connect auto-fills: node created with the catalog baseURL, live pull fired (best-effort)', async () => {
    const p = credPaths();
    bindStore(p);
    catalogRecs = [
      {
        id: 'zedprov',
        name: 'Zed',
        npm: '@opencode-ai/provider/openai-compatible',
        baseURL: 'https://zed.test/v1',
        custom: false,
        connected: false,
        sources: ['builtin'],
        models: [],
      },
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/zedprov/connect',
      payload: { apiKey: 'sk-connect-fill' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodeCreated).toBe(true);
    expect(res.json().modelsFilled).toBe(0); // mocked pull succeeds with 0
    const node = readJsoncProviders(p).zedprov;
    expect(node.settings.baseURL).toBe('https://zed.test/v1');
    expect(pullMode).toBe('live'); // baseURL + store key → live path chosen
  });
  it('connect seeds the catalog baseURL onto an EXISTING bare node (the bind-sweep shape)', async () => {
    // The hard cutover leaves store-backed providers with a BARE node (the boot
    // bind must not wait on the network). Re-connect is the documented recovery
    // gesture — if it does not seed the baseURL, live pull stays unreachable for
    // every self-declared relay and the ADR's upgrade path is broken.
    const p = credPaths();
    seedOcr(p, { zedprov: [{ id: 'c1', key: 'sk-bare-node' }] });
    writeJsonc(p, { providers: { zedprov: { package: '@opencode-ai/provider/openai-compatible' } } });
    bindStore(p);
    catalogRecs = [
      {
        id: 'zedprov',
        name: 'Zed',
        npm: '@opencode-ai/provider/openai-compatible',
        baseURL: 'https://zed.test/v1',
        custom: false,
        connected: false,
        sources: ['builtin'],
        models: [],
      },
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/zedprov/connect',
      payload: { apiKey: 'sk-bare-node-2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodeCreated).toBe(false); // the node existed — only seeded
    const node = readJsoncProviders(p).zedprov;
    expect(node.settings.baseURL).toBe('https://zed.test/v1');
    expect(pullMode).toBe('live'); // baseURL now resolvable → live path
  });
});

describe('GET /opencode/providers — masked store views', () => {
  it('store credentials merge into the view (connected + masked key); auth.json leftovers are IMPORTED at bind', async () => {
    const p = credPaths();
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ ghostprov: { type: 'api', key: 'sk-ghost-imported' } }));
    writeJsonc(p, { providers: { myprov: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://m.test/v1' } } } });
    seedOcr(p, {
      myprov: [{ id: 'c1', key: 'sk-view-key-123456789' }],
      anthropic: [{ id: 'c2', key: 'sk-view-anth' }],
    });
    bindStore(p);
    const res = await app.inject({ method: 'GET', url: '/api/admin/opencode/providers' });
    const body = res.json();
    const myprov = body.providers.find((v: { id: string }) => v.id === 'myprov');
    expect(myprov.auth.connected).toBe(true);
    expect(myprov.auth.type).toBe('api');
    expect(myprov.auth.keyMasked).toContain('••••');
    const anthropic = body.providers.find((v: { id: string }) => v.id === 'anthropic');
    expect(anthropic.auth.connected).toBe(true);
    // The auth.json one-shot import folded the snapshot key into the OCR file,
    // so that provider is a REAL store member now (not a masquerading ghost).
    const ghost = body.providers.find((v: { id: string }) => v.id === 'ghostprov');
    expect(ghost.auth.connected).toBe(true);
    expect(readOcrFile(p).providers.ghostprov).toBeDefined();
    expect(res.body).not.toContain('sk-view-key-123456789'); // masked only
    expect(res.body).not.toContain('sk-ghost-imported');
  });

  it('ocr: local store credentials appear in the view', async () => {
    const p = credPaths();
    bindStore(p);
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
  it('adds suspect/openPairs/cooldownUntilMs per credential; old fields untouched; masked-only', async () => {
    const p = credPaths();
    const keyA = 'sk-pair-health-A';
    const keyB = 'sk-pair-health-B';
    seedOcr(p, {
      anthropic: [
        { id: 'c-a', key: keyA, active: true },
        { id: 'c-b', key: keyB, active: false },
      ],
    });
    bindStore(p);
    const cb = registry.getCircuitBreakerManager();
    const prefixA = keyHashPrefix(keyA);
    const prefixB = keyHashPrefix(keyB);
    // B cooling in one pair; A administratively suspect (never auto-returns).
    cb.tripPair('mock-lite', prefixB, { cooldownMs: 600000 }, 'anthropic');
    cb.getCredentialStateStore().mark('anthropic', prefixA, 'confirmed-bad key (test)');
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const anthropic = body.store.credentials.find((a: { providerId: string }) => a.providerId === 'anthropic');
      const a = anthropic.credentials.find((x: { id: string }) => x.id === 'c-a');
      const b = anthropic.credentials.find((x: { id: string }) => x.id === 'c-b');

      expect(a.suspect).toBe(true);
      expect(a.openPairs).toBe(0);
      expect(a.cooldownUntilMs).toBeUndefined();
      expect(b.suspect).toBe(false);
      expect(b.openPairs).toBe(1);
      expect(typeof b.cooldownUntilMs).toBe('number');
      expect(b.cooldownUntilMs).toBeGreaterThan(Date.now() - 1000);

      // ADDITIVE: the pre-P3 CredentialMeta fields are all still there.
      expect(a).toMatchObject({ id: 'c-a', providerId: 'anthropic', type: 'api', active: true, routable: true });
      expect(a.keyHashPrefix).toBe(prefixA);
      expect(a.maskedKey).toContain('••••');
      // masking contract: no raw key material anywhere on the wire
      expect(res.body).not.toContain(keyA);
      expect(res.body).not.toContain(keyB);
    } finally {
      cb.getCredentialStateStore().clear('anthropic', prefixA);
      cb.resetScoped('mock-lite', prefixB);
    }
  });

  it('credentials without a keyHash (keyless rows) get suspect:false + openPairs:0', async () => {
    const p = credPaths();
    seedOcr(p, { zen: [{ id: 'c-keyless', key: '' }] });
    bindStore(p);
    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    const zen = res
      .json()
      .store.credentials.find((a: { providerId: string }) => a.providerId === 'zen');
    expect(zen.credentials[0].suspect).toBe(false);
    expect(zen.credentials[0].openPairs).toBe(0);
  });
});

describe('SUSPECT lifecycle — reconnect clears', () => {
  it('connect of the SAME key material lifts the flag (anchor = keyHashPrefix, not id/label)', async () => {
    const p = credPaths();
    bindStore(p);
    const key = 'sk-reconnect-clears-suspect';
    const prefix = keyHashPrefix(key);
    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
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

  it('connect of a DIFFERENT key does not lift the old credential flag', async () => {
    const p = credPaths();
    bindStore(p);
    const oldKey = 'sk-old-suspect-keepme';
    const prefixOld = keyHashPrefix(oldKey);
    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
    state.mark('anthropic', prefixOld, 'confirmed-bad key (test)');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/opencode/providers/anthropic/connect',
        payload: { apiKey: 'sk-a-brand-new-key' },
      });
      expect(res.statusCode).toBe(200);
      expect(state.isSuspect('anthropic', prefixOld)).toBe(true); // old credential stays out
    } finally {
      state.clear('anthropic', prefixOld);
    }
  });

  it('setKey rotation clears the pushed credential too', async () => {
    const p = credPaths();
    bindStore(p);
    const key = 'sk-setkey-rotation-clears';
    const prefix = keyHashPrefix(key);
    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
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
// Operator takedown routes — OCR-side credential state, deliberately NOT a
// credential-store write: refused by neither the read-only binding nor any
// capability flag, and lifted only by the matching enable route.
// ---------------------------------------------------------------------------

describe('POST .../credentials/:credentialId/{disable,enable} — operator takedown', () => {
  const disableUrl = (providerId: string, credentialId: string) =>
    `/api/admin/opencode/providers/${providerId}/credentials/${credentialId}/disable`;
  const enableUrl = (providerId: string, credentialId: string) =>
    `/api/admin/opencode/providers/${providerId}/credentials/${credentialId}/enable`;

  it('ocr store: disabled rides the overlay, sinks the row last, and enable restores it', async () => {
    const p = credPaths();
    bindStore(p);
    await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/connect', payload: { apiKey: 'sk-tk-live' } });
    await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/connect', payload: { apiKey: 'sk-tk-parked' } });

    let list = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' }))
      .json()
      .store.credentials.find((a: { providerId: string }) => a.providerId === 'anthropic').credentials;
    expect(list.every((a: { disabled: boolean }) => a.disabled === false)).toBe(true);
    const target = list[0];

    const off = await app.inject({ method: 'POST', url: disableUrl('anthropic', target.id), payload: { reason: 'quota burned' } });
    expect(off.statusCode).toBe(200);
    expect(off.json().disabled).toBe(true);
    expect(off.json().credential.disabled).toBe(true);
    expect(off.json().credential.disabledReason).toBe('quota burned');
    // Order: the takedown sorts below the live row regardless of active flags.
    expect(off.json().credentials.map((a: { id: string }) => a.id)).toEqual([list[1].id, target.id]);

    // Durable: a fresh read of the same state file still reports it.
    list = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' }))
      .json()
      .store.credentials.find((a: { providerId: string }) => a.providerId === 'anthropic').credentials;
    expect(list.find((a: { id: string }) => a.id === target.id).disabled).toBe(true);

    const on = await app.inject({ method: 'POST', url: enableUrl('anthropic', target.id), payload: {} });
    expect(on.statusCode).toBe(200);
    expect(on.json().disabled).toBe(false);
    expect(on.json().credentials.find((a: { id: string }) => a.id === target.id).disabled).toBe(false);
    // The key was never touched — both rows are still in the store.
    expect(readOcrFile(p).providers.anthropic).toHaveLength(2);
  });

  it('an unknown credential id 404s (the OCR row always carries a keyHash — even a keyless one)', async () => {
    const p = credPaths();
    seedOcr(p, { anthropic: [{ id: 'c-keyless', key: '' }] });
    bindStore(p);
    const missing = await app.inject({ method: 'POST', url: disableUrl('anthropic', 'nope'), payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().reasonCode).toBe('credential_not_found');
  });
});

describe('POST .../providers/:id/credentials/reorder', () => {
  it('200: reorders the chain, flips the head to ids[0], refreshes the inline list', async () => {
    const p = credPaths();
    const keyA = 'sk-act-A-key';
    const keyB = 'sk-act-B-key';
    seedOcr(p, {
      anthropic: [
        { id: 'c-a', key: keyA, active: true },
        { id: 'c-b', key: keyB, active: false },
      ],
    });
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/credentials/reorder',
      payload: { ids: ['c-b', 'c-a'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // the head is ids[0]
    expect(body.credential.id).toBe('c-b');
    expect(body.credential.active).toBe(true);
    const rows = readOcrFile(p).providers.anthropic;
    // array order is authoritative and active follows position 0
    expect(rows.map((r: { credentialId: string }) => r.credentialId)).toEqual(['c-b', 'c-a']);
    expect(rows[0].active).toBe(true);
    expect(rows[1].active).toBe(false);
    // refreshed inline list = store-status overlay shape (P3-step3 keys present)
    expect(body.credentials.map((a: { id: string }) => a.id)).toEqual(['c-b', 'c-a']);
    expect(body.credentials[0].suspect).toBe(false);
    expect(body.credentials[0].openPairs).toBe(0);
    // masked-only wire contract (Decision 1 risk limb)
    expect(res.body).not.toContain(keyA);
    expect(res.body).not.toContain(keyB);
  });

  it('400: invalid ids body shapes (missing / empty / non-string entries) never reach the store', async () => {
    const p = credPaths();
    seedOcr(p, { anthropic: [{ id: 'c-a', key: 'sk-ord-a' }] });
    bindStore(p);
    for (const payload of [undefined, {}, { ids: [] }, { ids: ['c-a', 7] }, { ids: 'c-a' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/opencode/providers/anthropic/credentials/reorder',
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().reasonCode).toBe('invalid_ids');
    }
    // the row is untouched
    expect(readOcrFile(p).providers.anthropic[0].credentialId).toBe('c-a');
  });

  it('unknown id in the permutation → 404 credential_not_found, no partial write', async () => {
    const p = credPaths();
    seedOcr(p, {
      anthropic: [
        { id: 'c-a', key: 'sk-guard-a', active: true },
        { id: 'c-b', key: 'sk-guard-b', active: false },
      ],
    });
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/credentials/reorder',
      payload: { ids: ['c-b', 'c-nope'] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().reasonCode).toBe('credential_not_found');
    // order + active flags untouched
    const rows = readOcrFile(p).providers.anthropic;
    expect(rows.map((r: { credentialId: string }) => r.credentialId)).toEqual(['c-a', 'c-b']);
    expect(rows[0].active).toBe(true);
  });

  it('cross-check guard: ocr credential of ANOTHER provider is refused (permutation is per-provider)', async () => {
    const p = credPaths();
    bindStore(p);
    await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/connect',
      payload: { apiKey: 'sk-ocr-cross' },
    });
    const accId = readOcrFile(p).providers.anthropic[0].credentialId;
    // 'openai' has no rows, so the route 404s before the store is ever called.
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/openai/credentials/reorder',
      payload: { ids: [accId] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().reasonCode).toBe('credential_not_found');
    expect(readOcrFile(p).providers.anthropic[0].active).toBe(true); // untouched
  });
});

describe('POST .../providers/:id/credentials/:credentialId/weight', () => {
  it('200: stores the weight, answers the refreshed inline list, stays masked-only', async () => {
    const p = credPaths();
    const keyA = 'sk-wt-A-key';
    const keyB = 'sk-wt-B-key';
    seedOcr(p, {
      anthropic: [
        { id: 'c-a', key: keyA, active: true },
        { id: 'c-b', key: keyB, active: false },
      ],
    });
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/credentials/c-b/weight',
      payload: { weight: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.credential.id).toBe('c-b');
    expect(body.credential.weight).toBe(3);
    expect(readOcrFile(p).providers.anthropic.find((r: { credentialId: string }) => r.credentialId === 'c-b').weight).toBe(3);
    // refreshed inline list carries the weight for the UI editor
    const row = body.credentials.find((a: { id: string }) => a.id === 'c-b');
    expect(row.weight).toBe(3);
    expect(body.credentials.find((a: { id: string }) => a.id === 'c-a').weight).toBeUndefined();
    // masked-only wire contract
    expect(res.body).not.toContain(keyA);
    expect(res.body).not.toContain(keyB);
  });

  it('400: non-integer / out-of-range / missing weights never reach the store', async () => {
    const p = credPaths();
    seedOcr(p, { anthropic: [{ id: 'c-a', key: 'sk-wt-val' }] });
    bindStore(p);
    for (const payload of [undefined, {}, { weight: 0 }, { weight: -2 }, { weight: 1.5 }, { weight: 101 }, { weight: '3' }, { weight: null }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/opencode/providers/anthropic/credentials/c-a/weight',
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().reasonCode).toBe('invalid_weight');
    }
    expect(readOcrFile(p).providers.anthropic[0].weight).toBeUndefined();
  });

  it('unknown credential → 404 credential_not_found, no write', async () => {
    const p = credPaths();
    seedOcr(p, { anthropic: [{ id: 'c-a', key: 'sk-wt-miss' }] });
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/anthropic/credentials/c-nope/weight',
      payload: { weight: 2 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().reasonCode).toBe('credential_not_found');
  });
});

describe('PATCH .../providers/:id/credentials/:credentialId — rename', () => {
  it('label contract: oversized / non-string → 400 invalid_label; success stores the TRIMMED label', async () => {
    const p = credPaths();
    seedOcr(p, { anthropic: [{ id: 'c-a', key: 'sk-rename-a' }] });
    bindStore(p);
    for (const label of ['x'.repeat(81), 42]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/opencode/providers/anthropic/credentials/c-a',
        payload: { label },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().reasonCode).toBe('invalid_label');
    }
    expect(fetchCalls).toHaveLength(0); // nothing written for bad labels
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/admin/opencode/providers/anthropic/credentials/c-a',
      payload: { label: '  Team A  ' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().credential.label).toBe('Team A');
    expect(readOcrFile(p).providers.anthropic[0].label).toBe('Team A');
  });

  it('ocr store: clearing DROPS the label field from credentials.json instead of storing ""', async () => {
    const p = credPaths();
    bindStore(p);
    await app.inject({ method: 'POST', url: '/api/admin/opencode/providers/anthropic/connect', payload: { apiKey: 'sk-ocr-named' } });
    const credentialId = readOcrFile(p).providers.anthropic[0].credentialId;
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/opencode/providers/anthropic/credentials/${credentialId}`,
      payload: { label: ' 我的 key ' },
    });
    expect(readOcrFile(p).providers.anthropic[0].label).toBe('我的 key');

    const clear = await app.inject({
      method: 'PATCH',
      url: `/api/admin/opencode/providers/anthropic/credentials/${credentialId}`,
      payload: { label: '' },
    });
    expect(clear.statusCode).toBe(200);
    expect('label' in readOcrFile(p).providers.anthropic[0]).toBe(false);
    // And the refreshed overlay carries no label either (display falls back to the handle).
    expect(clear.json().credentials[0].label).toBeUndefined();
  });
});

describe('DELETE .../providers/:id/credentials/:credentialId — disconnect (Decision 8: UI confirms, server honors)', () => {
  it('happy: the row leaves credentials.json + SUSPECT cleared for the keyHashPrefix captured BEFORE deletion', async () => {
    const p = credPaths();
    const keyA = 'sk-disc-clears-suspect';
    seedOcr(p, { anthropic: [{ id: 'c-a', key: keyA }] });
    bindStore(p);
    const prefix = keyHashPrefix(keyA);
    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
    state.mark('anthropic', prefix, 'confirmed-bad key (test)');
    expect(state.isSuspect('anthropic', prefix)).toBe(true);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/opencode/providers/anthropic/credentials/c-a',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.disconnected).toBe('c-a');
    expect(readOcrFile(p).providers.anthropic).toBeUndefined(); // emptied providers are pruned
    expect(state.isSuspect('anthropic', prefix)).toBe(false);
    // A delete is a REVOCATION: the key MATERIAL is anchored as a takedown, so a
    // pull-back cannot return as a clean routable credential.
    expect(body.takedownAnchored).toBe(true);
    expect(state.isDisabled('anthropic', prefix)).toBe(true);
    // No v2 client in this sandbox: the client half is typed, never guessed.
    expect(body.clientRevoke).toEqual({ clientId: 'opencode-v1', result: 'absent' });
    state.enable('anthropic', prefix); // leave the ledger clean for other tests
  });

  it('?clientRevoke=0 keeps the client copy but STILL anchors the takedown', async () => {
    const p = credPaths();
    const keyA = 'sk-disc-keep-client';
    seedOcr(p, { anthropic: [{ id: 'c-a', key: keyA }] });
    bindStore(p);
    const prefix = keyHashPrefix(keyA);
    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/opencode/providers/anthropic/credentials/c-a?clientRevoke=0',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clientRevoke).toBeNull();
    expect(res.json().takedownAnchored).toBe(true);
    expect(state.isDisabled('anthropic', prefix)).toBe(true);
    state.enable('anthropic', prefix);
  });

  it('an ALREADY-parked key keeps the operator note (delete never rewrites the audit reason)', async () => {
    const p = credPaths();
    const keyA = 'sk-disc-parked-note';
    seedOcr(p, { anthropic: [{ id: 'c-a', key: keyA }] });
    bindStore(p);
    const prefix = keyHashPrefix(keyA);
    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
    state.disable('anthropic', prefix, 'quota exhausted — operator note');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/opencode/providers/anthropic/credentials/c-a?clientRevoke=0',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().takedownAnchored).toBe(true); // anchored either way
    expect(state.getDisabled('anthropic', prefix)?.reason).toBe('quota exhausted — operator note');
    state.enable('anthropic', prefix);
  });

  it('deletes the matching credential on a live v2 client (keyHash match, one row)', async () => {
    const p = credPaths();
    const keyA = 'sk-disc-client-delete';
    seedOcr(p, { anthropic: [{ id: 'c-a', key: keyA }] });
    const prefix = keyHashPrefix(keyA);
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    resetCredentialStoreForTests(p, undefined, fetchImpl, {
      env: {},
      now: () => 1,
      openDatabase: async () => ({
        query(sql: string) {
          return {
            all: () =>
              sql.includes('table_info')
                ? ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'].map((name) => ({
                    name,
                  }))
                : [
                    {
                      id: 'c-client',
                      integration_id: 'anthropic',
                      label: null,
                      value: JSON.stringify({ type: 'key', key: keyA }),
                      active: 1,
                      time_created: 1,
                      time_updated: 1,
                    },
                  ],
          };
        },
        close() {
          // no-op
        },
      }),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/opencode/providers/anthropic/credentials/c-a',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clientRevoke).toEqual({ clientId: 'opencode-v2', result: 'deleted' });
    const deletes = fetchCalls.filter((c) => c.method === 'DELETE' && c.url.includes('/api/credential/'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toContain('/api/credential/c-client');
    registry.getCircuitBreakerManager().getCredentialStateStore().enable('anthropic', prefix);
  });

  it('failed disconnect keeps the SUSPECT mark (clear is success-only)', async () => {
    const p = credPaths();
    const keyA = 'sk-disc-fail-keeps';
    seedOcr(p, { anthropic: [{ id: 'c-a', key: keyA }] });
    bindStore(p);
    const prefix = keyHashPrefix(keyA);
    const state = registry.getCircuitBreakerManager().getCredentialStateStore();
    state.mark('anthropic', prefix, 'confirmed-bad key (test)');
    try {
      // A hostile home makes the RE-BIND itself crash — the request 500s at the
      // framework level and the SUSPECT flag must survive untouched.
      const hostile: CredentialPaths = {
        ...p,
        get ocrHome() {
          throw new Error('home unreadable');
        },
      };
      resetCredentialStoreForTests(hostile, undefined, fetchImpl, { env: {}, now: () => 1 });
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/admin/opencode/providers/anthropic/credentials/c-a',
      });
      expect(res.statusCode).toBe(500);
      expect(state.isSuspect('anthropic', prefix)).toBe(true);
    } finally {
      state.clear('anthropic', prefix);
    }
  });
});

// Legacy-marker compatibility: a state file written by an OLD boot (reconcile
// era) still reads back — readers tolerate the additive blocks.
describe('legacy credential-store.json tolerance', () => {
  it('a persisted reconcile block survives a rebind (never clobbered)', async () => {
    const p = credPaths();
    writeCredentialStoreState(p, {
      bound: 'ocr',
      version: null,
      evidence: { cli: null, file: null, used: 'none', lastKnownGood: null },
      degradedCode: null,
      updatedAt: 1,
      reconcile: { doneAt: 7, authWriteDisabled: true, entries: [{ provider: 'anthropic', action: 'pushed' }] },
    });
    bindStore(p);
    await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    const { readCredentialStoreState } = await import('../src/opencode/credentials/factory.js');
    expect(readCredentialStoreState(p)?.reconcile?.doneAt).toBe(7);
  });
});
