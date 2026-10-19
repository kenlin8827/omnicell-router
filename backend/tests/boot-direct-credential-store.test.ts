import { describe, it, expect, mock, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Boot-direct consumes the BOUND CredentialStore — ALWAYS the OCR file
 * (credentials.json); opencode v2 is a sync client and selects nothing.
 *
 * The provider-def side is stubbed in memory (user-config mocked with the
 * real module spread, so the stores' own readJsonc/patchJsonc/maskSecret
 * imports keep working); the CREDENTIAL side runs against a REAL OcrStore
 * bound via resetCredentialStoreForTests with injected sandbox
 * CredentialPaths — no global env mutation, no operator home.
 *
 * Coverage:
 *  (a) multi-credential rows in the OCR file — the ACTIVE row is the baked
 *      chain head; P3 step 1 attaches the ordered resolveKeyChain to the
 *      instance payload (head === baked key); rows that fail validation
 *      never route (无凭证 exclusion, def present).
 *  (b) the auth.json one-shot import path — api keys route, oauth/wellknown
 *      never import, no-cred + no-def stays silent.
 *  (c) inline options.apiKey stays ABOVE the store (Decision 1) and owns the
 *      chain head.
 */

// ---------------------------------------------------------------------------
// in-memory seams for the CONFIG side (defs/catalog/config)
// ---------------------------------------------------------------------------

let defFixtures: Record<string, any> = {};
let modelFixtures: Record<string, Record<string, any>> = {};
let catalogRecs: any[] = [];

const actualUserConfig = await import('../src/opencode/user-config.js');

mock.module('../src/opencode/user-config.js', () => ({
  ...actualUserConfig,
  getProviderNodeById: (id: string) => defFixtures[id],
  getProviderModelDefs: (id: string) => (id in defFixtures ? modelFixtures[id] ?? {} : undefined),
  // passthrough — inline keys are literal strings, no env mutation anywhere
  expandEnvTemplate: (v: unknown) => (typeof v === 'string' ? v : ''),
}));

mock.module('../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => catalogRecs,
    lastSyncOrigin: 'test',
    ensureOcrStore: async () => {},
  },
}));

mock.module('../src/config/index.js', () => ({
  loadConfig: () => ({ tiers: {}, exclude: [] }),
  saveConfig: () => ({ success: true }),
  getConfigPath: () => '<memory>/config.yaml',
}));

const { buildDirectPool } = await import('../src/providers/boot-direct.js');
const { resetCredentialStoreForTests } = await import('../src/opencode/credentials/factory.js');
const { keyHashPrefix } = await import('../src/opencode/credentials/index.js');

// ---------------------------------------------------------------------------
// fixtures: the OCR file IS the credential truth the pool reads
// ---------------------------------------------------------------------------

function sandboxPaths(): import('../src/opencode/credentials/paths.js').CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-boot-cred-'));
  return {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  };
}

interface OcrRow {
  credentialId: string;
  key: string;
  active?: boolean;
  timeUpdated?: number;
  /** hostiles: a raw row object that fails the store's validation */
  invalid?: boolean;
}

function seedOcr(
  paths: import('../src/opencode/credentials/paths.js').CredentialPaths,
  providers: Record<string, OcrRow[]>
): void {
  fs.mkdirSync(paths.ocrHome, { recursive: true });
  fs.writeFileSync(
    path.join(paths.ocrHome, 'credentials.json'),
    JSON.stringify({
      version: 1,
      providers: Object.fromEntries(
        Object.entries(providers).map(([prov, rows]) => [
          prov,
          rows.map((r) =>
            r.invalid
              ? { nope: true } // fails load() validation → filtered out
              : {
                  credentialId: r.credentialId,
                  key: r.key,
                  timeCreated: 1,
                  timeUpdated: r.timeUpdated ?? 1,
                  active: r.active ?? false,
                }
          ),
        ])
      ),
    })
  );
}

const defFor = (id: string, extraOptions: Record<string, unknown> = {}) => ({
  options: { baseURL: `https://${id}.test/v1`, ...extraOptions },
});
const recFor = (id: string, modelIds: string[] = ['m1']) => ({
  id,
  name: id,
  custom: true,
  connected: true,
  api: `https://${id}.test/v1`,
  models: modelIds.map((m) => ({ id: m })),
});

afterEach(() => {
  resetCredentialStoreForTests(); // clear sticky binding + test overrides
  defFixtures = {};
  modelFixtures = {};
  catalogRecs = [];
});

describe('(a) OCR-file boot: multi-credential rows', () => {
  function bindStore(rows: Record<string, OcrRow[]>) {
    const paths = sandboxPaths();
    seedOcr(paths, rows);
    resetCredentialStoreForTests(paths, undefined, undefined, { env: {}, now: () => 1 });
    return paths;
  }

  it('bakes the ACTIVE row as the head; rows that fail validation never route', async () => {
    bindStore({
      'p-active': [
        { credentialId: 'c-stale', key: 'sk-stale-newer', active: false, timeUpdated: 100 },
        { credentialId: 'c-act', key: 'sk-active', active: true, timeUpdated: 1 }, // active beats newer-inactive
      ],
      'p-broken': [{ credentialId: 'c-junk', key: '', invalid: true }],
    });
    for (const id of ['p-active', 'p-broken']) {
      defFixtures[id] = defFor(id);
      modelFixtures[id] = { m1: {} };
    }
    catalogRecs = ['p-active', 'p-broken'].map((id) => recFor(id));

    const res = await buildDirectPool();
    const byName = new Map(res.instances.map((i) => [i.name, i]));

    // active row baked into the dispatch config (boot bakes exactly one key)
    expect(byName.get('p-active')?.config.apiKey).toBe('sk-active');

    // a provider whose only rows fail store validation has no credential at
    // all: the provider-level no-credential entry (def present), never routed
    const brokenEntries = res.excluded.filter((e) => e.provider === 'p-broken' && !e.model);
    expect(brokenEntries).toHaveLength(1);
    expect(brokenEntries[0]!.reason).toContain('无凭证');
    expect(byName.has('p-broken')).toBe(false);
  });

  it('P3 step 1: one instance per provider with MULTIPLE credentials — chain head baked, full chain attached', async () => {
    bindStore({
      'p-active': [
        { credentialId: 'c1', key: 'sk-active', active: true, timeUpdated: 1 },
        { credentialId: 'c2', key: 'sk-backup', active: false, timeUpdated: 99 },
      ],
    });
    defFixtures['p-active'] = defFor('p-active');
    modelFixtures['p-active'] = { m1: {} };
    catalogRecs = [recFor('p-active')];
    const res = await buildDirectPool();
    const inst = res.instances.filter((i) => i.name === 'p-active');
    expect(inst).toHaveLength(1);
    expect(inst[0]!.config.apiKey).toBe('sk-active'); // the ACTIVE-first chain head is what gets baked
    // Per-call selection chain (in-memory, registry-only payload): ordered
    // active-first, identity prefixes, credentialId fallback labels.
    expect(inst[0]!.credentialChain.map((c) => c.key)).toEqual(['sk-active', 'sk-backup']);
    expect(inst[0]!.credentialChain[0]!.keyHashPrefix).toBe(keyHashPrefix('sk-active'));
    expect(inst[0]!.credentialChain[0]!.label).toBe('c1');
    // The invariant registry attribution relies on: head === the boot-baked key.
    expect(inst[0]!.credentialChain[0]!.key).toBe(inst[0]!.config.apiKey);
  });
});

describe('(b)+(c) auth.json one-shot import boot: lands on the OCR store', () => {
  function bindV1Machine(auth: Record<string, unknown>) {
    const paths = sandboxPaths();
    fs.mkdirSync(path.dirname(paths.authJsonPath), { recursive: true });
    fs.writeFileSync(paths.authJsonPath, JSON.stringify(auth, null, 2), 'utf8');
    resetCredentialStoreForTests(paths, undefined, undefined, { env: {}, now: () => 1 });
    return paths;
  }

  it('api key imports and routes; oauth/wellknown are not importable and exclude with a reason; no-cred + no-def stays silent', async () => {
    bindV1Machine({
      'v1-api': { type: 'api', key: 'sk-v1' },
      'v1-oauth': { type: 'oauth', access: 'tok-abc', refresh: 'r', expires: 1 },
      'v1-wk': { type: 'wellknown', key: 'wk-key' },
    });
    defFixtures['v1-api'] = defFor('v1-api', { headers: { 'X-T': '1' } });
    defFixtures['v1-oauth'] = defFor('v1-oauth');
    defFixtures['v1-wk'] = defFor('v1-wk');
    for (const id of ['v1-api', 'v1-oauth', 'v1-wk']) modelFixtures[id] = { m1: {} };
    catalogRecs = ['v1-api', 'v1-oauth', 'v1-wk', 'v1-bare'].map((id) => recFor(id));

    const res = await buildDirectPool();
    const byName = new Map(res.instances.map((i) => [i.name, i]));

    // The imported api key is the store segment — the snapshot itself is never read.
    expect(byName.get('v1-api')?.config.apiKey).toBe('sk-v1');
    expect(byName.get('v1-api')?.config.baseUrl).toBe('https://v1-api.test/v1');
    expect(byName.get('v1-api')?.config.headers).toEqual({ 'X-T': '1' });

    // Single-credential degeneracy: length-1 chain, head === baked key.
    const v1Chain = byName.get('v1-api')?.credentialChain;
    expect(v1Chain).toHaveLength(1);
    expect(v1Chain?.[0]?.key).toBe('sk-v1');
    expect(v1Chain?.[0]?.key).toBe(byName.get('v1-api')?.config.apiKey);

    // An OCR store holds raw api keys only, so an auth.json oauth/wellknown entry
    // cannot be imported: both surface as NO CREDENTIAL (never silent).
    // Neither routes.
    expect(res.excluded).toContainEqual({ provider: 'v1-oauth', reasonCode: 'no_credential', reason: '无凭证（内联或凭证库均缺失）' });
    expect(res.excluded).toContainEqual({ provider: 'v1-wk', reasonCode: 'no_credential', reason: '无凭证（内联或凭证库均缺失）' });
    expect(byName.has('v1-oauth')).toBe(false);
    expect(byName.has('v1-wk')).toBe(false);

    // structural noise rule unchanged: no def + no credential → silent skip
    expect(res.excluded.some((e) => e.provider === 'v1-bare')).toBe(false);
    expect(byName.has('v1-bare')).toBe(false);
  });

  it('inline options.apiKey stays ABOVE the store; an inline key simply routes', async () => {
    bindV1Machine({
      'v1-api': { type: 'api', key: 'sk-store' },
    });
    defFixtures['v1-api'] = defFor('v1-api', { apiKey: 'sk-inline' });
    modelFixtures['v1-api'] = { m1: {} };
    catalogRecs = [recFor('v1-api')];

    const res = await buildDirectPool();
    const byName = new Map(res.instances.map((i) => [i.name, i]));
    expect(byName.get('v1-api')?.config.apiKey).toBe('sk-inline'); // Decision 1: inline above store
    // Inline precedence also owns the chain HEAD (invariant head === baked key);
    // the store credential stays selectable below it.
    expect(byName.get('v1-api')?.credentialChain?.map((c) => c.key)).toEqual(['sk-inline', 'sk-store']);
    expect(byName.get('v1-api')?.credentialChain?.[0]?.label).toBe('inline');
  });
});
