import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { CredentialPaths } from '../src/opencode/credentials/paths.js';
import { resetCredentialStoreForTests } from '../src/opencode/credentials/factory.js';

/**
 * Provider-definition WRITES at the route + boot level.
 *
 * Layer 1 (routes): console provider create/update/connect write the
 *  opencode.jsonc def and route the KEY to the bound store — always the OCR
 *  file (the v2 service is a sync client and is never written by these routes).
 * Layer 2 (boot): an opencode-v2 shaped def written by upsertProviderDef
 *  resolves the SAME baseURL/headers/wire through boot-direct as the equivalent
 *  opencode-v1 shaped def. boot-direct is NOT edited here — this file only
 *  asserts against it (concurrent P3 edits must keep this contract).
 *
 * Hermetic: XDG_* per-test tmpdir + injected CredentialPaths (same dirs),
 * mocked catalog/fetch — the operator's home is never read (fixtures per
 * credentials-console-routes.test.ts).
 */

let catalogRecs: any[] = [];

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

const actualAutoPull = await import('../src/opencode/catalog/auto-pull.js');
// Post-create opportunistic pull stubbed here — the real engine is covered by
// catalog.test.ts; these tests pin the CREATE ROUTE's contract only: it fires
// when no explicit models were sent, and its outcome NEVER fails a creation.
let pullOutcome: 'ok' | 'refused' | 'throw' = 'ok';
let pullFired: string[] = [];
mock.module('../src/opencode/catalog/auto-pull.js', () => ({
  ...actualAutoPull,
  autoPullProvider: async (id: string) => {
    pullFired.push(id);
    if (pullOutcome === 'throw') throw new Error('pull boom');
    if (pullOutcome === 'refused') return { httpStatus: 400, body: { success: false, error: 'no catalog entry' } };
    return { httpStatus: 200, body: { status: 'ok', success: true, pulled: 3 } };
  },
}));

const { createServer } = await import('../src/server.js');
const { buildDirectPool } = await import('../src/providers/boot-direct.js');
const { upsertProviderDef } = await import(
  '../src/opencode/user-config.js'
);
const { readProviderDefsFile, writeProviderDefs, getProviderDefsPath } = await import(
  '../src/opencode/provider-defs.js'
);

// Hermetic defs file: the funnel writes through env-resolved OCR_HOME (shared
// runner sandbox) — clear leftovers before every test.
beforeEach(() => {
  fs.rmSync(getProviderDefsPath(), { force: true });
});

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-v2write-routes-'));
  oldCfg = process.env.XDG_CONFIG_HOME;
  oldData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  const p = credPaths();
  fs.mkdirSync(p.configDir, { recursive: true });
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.writeFileSync(p.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  catalogRecs = [];
  pullOutcome = 'ok';
  pullFired = [];
  fetchCalls.length = 0;
  postHandler = () => ({ status: 200, json: { credential: { id: 'c-new' } } });
});

afterEach(() => {
  if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldCfg;
  if (oldData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldData;
  resetCredentialStoreForTests();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// store-binding + fetch fixtures (credentials-console-routes.test.ts pattern)
// ---------------------------------------------------------------------------

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
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }
  const res = postHandler(url);
  return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
};

let postHandler: (url: string) => { status: number; json?: unknown } = () => ({
  status: 200,
  json: { credential: { id: 'c-new' } },
});

function bindStore(paths: CredentialPaths) {
  resetCredentialStoreForTests(paths, undefined, fetchImpl, { env: {}, now: () => 1 });
}

function rawJsonc(): any {
  return { providers: readProviderDefsFile()?.providers ?? {} };
}

function writeJsoncFile(text: string): void {
  writeProviderDefs(JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')).providers ?? {});
}

const rec = (id: string, modelIds: string[]) => ({
  id,
  name: id,
  custom: true,
  connected: true,
  api: `https://${id}.test/v1`,
  models: modelIds.map((m) => ({ id: m })),
});

// ---------------------------------------------------------------------------
// 1. route-level shape selection by bound store kind
// ---------------------------------------------------------------------------

describe('POST /opencode/providers — the OCR store is the credential sink', () => {
  it('ocr binding: v2 shape in the native slot, key via store.connectKey (credentials.json)', async () => {
    const p = credPaths();
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'acme', baseURL: 'https://acme.test/v1', apiKey: 'sk-ocr-123456' },
    });
    expect(res.statusCode).toBe(200);
    const node = rawJsonc().providers.acme;
    expect(node.package).toBe('@opencode/ai/providers/openai-compatible');
    expect(node.npm).toBeUndefined();
    const credFile = path.join(p.ocrHome, 'credentials.json');
    expect(fs.existsSync(credFile)).toBe(true);
    expect(fs.readFileSync(credFile, 'utf8')).toContain('acme');
    expect(fs.readFileSync(credFile, 'utf8')).toContain('sk-ocr-123456');
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
  });

  it('self-referencing baseURL is rejected — the gateway cannot be its own upstream', async () => {
    const p = credPaths();
    bindStore(p);
    const { loadConfig } = await import('../src/config/index.js');
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'my-gateway', baseURL: `http://127.0.0.1:${loadConfig().port}/v1`, apiKey: 'sk-ocr-123456' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('cannot be its own upstream');
    expect(rawJsonc().providers['my-gateway']).toBeUndefined();
  });

  it('create fires the model pull in the background — the response never waits on it', async () => {
    const p = credPaths();
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      // pullPattern opts the provider into the auto-pull whitelist
      // (catalog.autoPullPatterns) — without it the post-create pull is skipped.
      payload: { id: 'pullme', baseURL: 'https://pullme.test/v1', apiKey: 'sk-pull-123456', pullPattern: '*' },
    });
    expect(res.statusCode).toBe(200);
    // fire-and-forget: the response carries no pull outcome (slow /models must not
    // stall creation); the floating pull runs and records itself next tick
    expect(res.json().modelsPulled).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(pullFired).toContain('pullme');
  });

  it('create without a pullPattern is NOT auto-pulled (opt-in whitelist)', async () => {
    const p = credPaths();
    bindStore(p);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'unpulled', baseURL: 'https://unpulled.test/v1', apiKey: 'sk-unpull-123456' },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(pullFired).not.toContain('unpulled');
  });

  it('a failed model pull is swallowed — the completed creation stands', async () => {
    const p = credPaths();
    bindStore(p);
    pullOutcome = 'throw';
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'pullboom', baseURL: 'https://pullboom.test/v1', apiKey: 'sk-boom-123456', pullPattern: '*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().modelsPulled).toBeUndefined();
    expect(rawJsonc().providers.pullboom.package).toBeDefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(pullFired).toContain('pullboom'); // fired AND its throw was caught (no crash)
    // refused (non-200) is swallowed the same way — no modelsPulled, no failure
    pullOutcome = 'refused';
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: { id: 'pullnope', baseURL: 'https://pullnope.test/v1', apiKey: 'sk-nope-123456', pullPattern: '*' },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().modelsPulled).toBeUndefined();
  });

  it('models.dev-file-shaped model content is WRITTEN, not refused (guard scope)', async () => {
    const p = credPaths();
    bindStore(p);
    // Regression for the 'refused: legacy-shaped model def (models.<id>.cost)' breakage:
    // keyed-Record `variants` and flat snake_case cost cache keys are opencode v2's
    // FILE spelling (verified against the v2.0.15 embedded config decoder) — the write
    // guard refuses RETIRED NODE shapes (npm/options) only.
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers',
      payload: {
        id: 'fileshape',
        baseURL: 'https://fileshape.test/v1',
        apiKeyInline: true,
        apiKey: 'sk-fileshape-inline',
        models: {
          'glm-4.5': { variants: { fast: { reasoningEffort: 'low' } }, cost: { input: 0.6, output: 1.8, cache_read: 0.13 } },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const node = rawJsonc().providers.fileshape;
    expect(node.package).toBeDefined();
    expect(node.npm).toBeUndefined();
    expect(node.models['glm-4.5'].variants).toEqual({ fast: { reasoningEffort: 'low' } });
    expect(node.models['glm-4.5'].cost).toEqual({ input: 0.6, output: 1.8, cache_read: 0.13 });
  });
});

describe('PATCH /opencode/providers/:id — opencode v2 update preserves the opencode v2 shape', () => {
  it('name edit on an opencode v2 node keeps package/settings/canonical/env/body (P1 reader fields survive the writer)', async () => {
    const p = credPaths();
    bindStore(p);
    writeJsoncFile(
      JSON.stringify(
        {
          providers: {
            acme: {
              name: 'Acme',
              canonical: 'openai',
              env: ['ACME_TOKEN'],
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: 'https://acme.test/v1' },
              headers: { 'X-T': '1' },
              body: { extra: true },
            },
          },
        },
        null,
        2
      )
    );
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/opencode/providers/acme',
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    const node = rawJsonc().providers.acme;
    expect(node.name).toBe('Renamed');
    expect(node.package).toBe('@opencode/ai/providers/openai-compatible');
    expect(node.npm).toBeUndefined();
    expect(node.settings.baseURL).toBe('https://acme.test/v1');
    expect(node.canonical).toBe('openai');
    expect(node.env).toEqual(['ACME_TOKEN']);
    expect(node.body).toEqual({ extra: true });
    expect(node.headers).toEqual({ 'X-T': '1' });
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
  });
});

describe('POST /opencode/providers/:id/connect — baseURL merge keeps node shape on opencode v2', () => {
  it('opencode-v2 shaped node stays opencode-v2 shaped after a connect with baseURL', async () => {
    const p = credPaths();
    bindStore(p);
    writeJsoncFile(
      JSON.stringify(
        {
          providers: {
            acme: {
              canonical: 'openai',
              package: '@opencode/ai/providers/anthropic',
              settings: { baseURL: 'https://old.test/v1' },
            },
          },
        },
        null,
        2
      )
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/opencode/providers/acme/connect',
      payload: { apiKey: 'sk-connect-123456', baseURL: 'https://new.test/v1' },
    });
    expect(res.statusCode).toBe(200);
    const node = rawJsonc().providers.acme;
    expect(node.package).toBe('@opencode/ai/providers/anthropic');
    expect(node.settings.baseURL).toBe('https://new.test/v1');
    expect(node.canonical).toBe('openai');
    expect(node.npm).toBeUndefined();
    expect(JSON.stringify(node)).not.toContain('sk-connect-123456');
    expect(fs.existsSync(p.authJsonPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. boot-direct equivalence (task test d) — REAL parser + REAL boot path,
//    opencode-v2 shaped def written through upsertProviderDef(generation:'opencode-v2')
// ---------------------------------------------------------------------------

describe('boot-direct — opencode v2-written def routes identically to the opencode v1 equivalent', () => {
  it('same baseURL, headers and wire set for opencode v1 and P4-written opencode v2 nodes', async () => {
    const p = credPaths();
    // The two defs share everything except the file shape.
    const common = {
      name: 'Eq',
      baseURL: 'https://eq.test/v1',
      headers: { 'X-T': '1' },
      models: { m1: {}, m2: { provider: { npm: '@ai-sdk/anthropic' } } },
    };
    expect(upsertProviderDef({ id: 'eq1', ...common, npm: '@ai-sdk/openai-compatible', generation: 'opencode-v1' }).success).toBe(
      true
    );
    expect(
      upsertProviderDef({ id: 'eq2', ...common, npm: '@ai-sdk/openai-compatible', generation: 'opencode-v2' }).success
    ).toBe(true);
    fs.writeFileSync(
      p.authJsonPath,
      JSON.stringify({ eq1: { type: 'api', key: 'sk-eq' }, eq2: { type: 'api', key: 'sk-eq' } })
    );
    // V1-bound store (auth.json is the sink): boot resolves keys from the store
    // segment identically for both shapes.
    bindStore(p);
    catalogRecs = [rec('eq1', ['m1', 'm2']), rec('eq2', ['m1', 'm2'])];

    const pool = await buildDirectPool();
    const byName = new Map(pool.instances.map((i) => [i.name, i]));
    const i1 = byName.get('eq1')!;
    const i2 = byName.get('eq2')!;
    expect(i1).toBeDefined();
    expect(i2).toBeDefined();
    expect(i2.config.baseUrl).toBe(i1.config.baseUrl);
    expect(i2.config.baseUrl).toBe('https://eq.test/v1');
    expect(i2.config.headers).toEqual(i1.config.headers);
    expect(i2.config.apiKey).toBe(i1.config.apiKey);
    expect(i2.wires.sort()).toEqual(i1.wires.sort());
    expect(i2.wires.sort()).toEqual(['anthropic', 'openai']); // model-level provider.npm → package → same wire
    // Boot-baked credential invariant (read-only check against boot-direct):
    // the chain head is the config.apiKey the executors default to — holds for
    // the opencode v1 and the P4-written opencode v2 shape alike (single store credential each).
    for (const inst of [i1, i2]) {
      expect(inst.credentialChain.length).toBe(1);
      expect(inst.credentialChain[0].key).toBe(inst.config.apiKey);
    }
    const ids = pool.models.map((m) => m.id);
    for (const id of ['eq1/m1', 'eq1/m2', 'eq2/m1', 'eq2/m2']) expect(ids).toContain(id);
    // wire per model identical across the two shapes
    const wireOf = (mid: string) => pool.models.find((m) => m.id === mid)!.wire;
    expect(wireOf('eq2/m2')).toBe(wireOf('eq1/m2'));
    expect(wireOf('eq2/m1')).toBe(wireOf('eq1/m1'));
  });
});
