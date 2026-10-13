import { describe, it, expect, mock, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ADR-0019 B3 — boot-direct consumes the BOUND CredentialStore.
 *
 * The provider-def side is stubbed in memory (user-config mocked with the
 * real module spread, so the stores' own readJsonc/patchJsonc/maskSecret
 * imports keep working); the CREDENTIAL side runs against REAL stores bound
 * via resetCredentialStoreForTests with injected sandbox CredentialPaths —
 * no global env mutation, no operator home (ADR-0018 spirit).
 *
 * Coverage:
 *  (a) OpencodeV2Store over a fake sqlite db — multi-account rows bake the
 *      ACTIVE-first key; P3 step 1 attaches the ordered resolveKeyChain to
 *      the instance payload (head === baked key); oauth-only rows excluded
 *      with the OAuth reason (and the factory's generic
 *      no_routable_credential entry deduped); oauth+api mix routes (opencode v2
 *      multi-account reality); unknown rows are never routed.
 *  (b) V1-bound path byte-identical to the auth.json era — same key source
 *      (api entry), same exclusion strings, wellknown never routable (B1).
 *  (c) inline options.apiKey stays ABOVE the store (Decision 1) — and an
 *      oauth account still excludes the provider even when inline wins
 *      (today's :107/:114 order preserved).
 *  (e) degraded-binding exclusions from the factory merge into
 *      DirectBootResult.excluded with reasonCode, replacing the generic
 *      无凭证 entry for the same provider.
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
// fixtures (credentials-v2-reads.test.ts precedent: real bun:sqlite in tmp)
// ---------------------------------------------------------------------------

const COLUMNS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

interface CredRow {
  id: string;
  integration_id: string;
  label: string | null;
  value: string;
  active: number;
  time_created: number;
  time_updated: number;
}

const keyRow = (
  id: string,
  integration: string,
  key: string,
  opts: { active?: number; updated?: number } = {}
): CredRow => ({
  id,
  integration_id: integration,
  label: null,
  value: JSON.stringify({ type: 'key', key }),
  active: opts.active ?? 0,
  time_created: 1,
  time_updated: opts.updated ?? 1,
});

const oauthRow = (id: string, integration: string): CredRow => ({
  id,
  integration_id: integration,
  label: null,
  value: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 0, methodID: 'm', metadata: {} }),
  active: 1,
  time_created: 1,
  time_updated: 9,
});

async function makeDb(file: string, rows: CredRow[]): Promise<void> {
  const { Database } = await import('bun:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.run(
    `CREATE TABLE credential (${COLUMNS.map((c) =>
      c === 'active' || c.startsWith('time_') ? `${c} INTEGER` : `${c} TEXT`
    ).join(', ')})`
  );
  const stmt = db.query(
    `INSERT INTO credential (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`
  );
  for (const r of rows) stmt.run(COLUMNS.map((c) => (r as Record<string, unknown>)[c]));
  db.close();
}

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

describe('(a) V2-bound boot: multi-account rows over fake db', () => {
  async function bindV2(rows: CredRow[]) {
    const paths = sandboxPaths();
    await makeDb(paths.opencodeDbPath, rows);
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', undefined, { env: {}, now: () => 1 });
    return paths;
  }

  it('bakes the ACTIVE-first key; oauth-only excluded (deduped), oauth+api mixed routes; unknown never routes', async () => {
    await bindV2([
      keyRow('c-stale', 'p-active', 'sk-stale-newer', { active: 0, updated: 100 }),
      keyRow('c-act', 'p-active', 'sk-active', { active: 1, updated: 1 }), // active beats newer-inactive
      keyRow('c-mix', 'p-mixed', 'sk-mixed', { active: 1 }),
      oauthRow('c-mix-oauth', 'p-mixed'),
      oauthRow('c-oauth', 'p-oauth'),
      { ...keyRow('c-unk', 'p-unknown', 'x'), value: '{ not json' },
    ]);
    for (const id of ['p-active', 'p-mixed', 'p-oauth', 'p-unknown']) {
      defFixtures[id] = defFor(id);
      modelFixtures[id] = { m1: {} };
    }
    catalogRecs = ['p-active', 'p-mixed', 'p-oauth', 'p-unknown'].map((id) => recFor(id));

    const res = await buildDirectPool();
    const byName = new Map(res.instances.map((i) => [i.name, i]));

    // active-first key baked into the dispatch config (boot bakes exactly one key)
    expect(byName.get('p-active')?.config.apiKey).toBe('sk-active');
    // oauth row alongside a routable key does NOT kill the provider (opencode v2 multi-account)
    expect(byName.get('p-mixed')?.config.apiKey).toBe('sk-mixed');
    expect(res.excluded.some((e) => e.provider === 'p-mixed')).toBe(false);

    // oauth-only: excluded with the OAuth reason, and the factory's generic
    // no_routable_credential entry deduped away (exactly one provider-level entry)
    const oauthEntries = res.excluded.filter((e) => e.provider === 'p-oauth' && !e.model);
    expect(oauthEntries).toHaveLength(1);
    expect(oauthEntries[0]!.reason).toBe('OAuth 凭证（网关自持刷新前显式排除）');
    expect(byName.has('p-oauth')).toBe(false);

    // unknown value shape: listed via factory but never routed → the
    // provider-level no-credential entry (def present) wins over no_routable (1 entry)
    const unknownEntries = res.excluded.filter((e) => e.provider === 'p-unknown' && !e.model);
    expect(unknownEntries).toHaveLength(1);
    expect(unknownEntries[0]!.reason).toContain('无凭证');
    expect(byName.has('p-unknown')).toBe(false);
  });

  it('P3 step 1: one instance per provider with MULTIPLE credentials — chain head baked, full chain attached', async () => {
    await bindV2([
      keyRow('c1', 'p-active', 'sk-active', { active: 1 }),
      keyRow('c2', 'p-active', 'sk-backup', { active: 0, updated: 99 }),
    ]);
    defFixtures['p-active'] = defFor('p-active');
    modelFixtures['p-active'] = { m1: {} };
    catalogRecs = [recFor('p-active')];
    const res = await buildDirectPool();
    const inst = res.instances.filter((i) => i.name === 'p-active');
    expect(inst).toHaveLength(1);
    expect(inst[0]!.config.apiKey).toBe('sk-active'); // the ACTIVE-first chain head is what gets baked
    // Per-call selection chain (in-memory, registry-only payload): ordered
    // active-first, identity prefixes, accountId fallback labels.
    expect(inst[0]!.credentialChain.map((c) => c.key)).toEqual(['sk-active', 'sk-backup']);
    expect(inst[0]!.credentialChain[0]!.keyHashPrefix).toBe(keyHashPrefix('sk-active'));
    expect(inst[0]!.credentialChain[0]!.label).toBe('c1');
    // The invariant registry attribution relies on: head === the boot-baked key.
    expect(inst[0]!.credentialChain[0]!.key).toBe(inst[0]!.config.apiKey);
  });
});

describe('(b)+(c) opencode v1 machine boot: lands on the OCR store after the one-shot import', () => {
  function bindV1Machine(auth: Record<string, unknown>) {
    const paths = sandboxPaths();
    fs.mkdirSync(path.dirname(paths.authJsonPath), { recursive: true });
    fs.writeFileSync(paths.authJsonPath, JSON.stringify(auth, null, 2), 'utf8');
    resetCredentialStoreForTests(paths, async () => 'v1.4.6', undefined, { env: {}, now: () => 1 });
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

    // Single-account degeneracy: length-1 chain, head === baked key.
    const v1Chain = byName.get('v1-api')?.credentialChain;
    expect(v1Chain).toHaveLength(1);
    expect(v1Chain?.[0]?.key).toBe('sk-v1');
    expect(v1Chain?.[0]?.key).toBe(byName.get('v1-api')?.config.apiKey);

    // An OCR store holds raw api keys only, so an auth.json oauth/wellknown entry
    // cannot be imported: both surface as NO CREDENTIAL (ADR-0011 — never silent),
    // which is a different reason string from the OAuth-account exclusion the v1
    // store produced. Neither routes.
    expect(res.excluded).toContainEqual({ provider: 'v1-oauth', reasonCode: 'no_credential', reason: '无凭证（内联或凭证库均缺失）' });
    expect(res.excluded).toContainEqual({ provider: 'v1-wk', reasonCode: 'no_credential', reason: '无凭证（内联或凭证库均缺失）' });
    expect(byName.has('v1-oauth')).toBe(false);
    expect(byName.has('v1-wk')).toBe(false);

    // structural noise rule unchanged: no def + no credential → silent skip
    expect(res.excluded.some((e) => e.provider === 'v1-bare')).toBe(false);
    expect(byName.has('v1-bare')).toBe(false);
  });

  it('inline options.apiKey stays ABOVE the store; an inline key simply routes (no oauth account exists to exclude)', async () => {
    bindV1Machine({
      'v1-api': { type: 'api', key: 'sk-store' },
      'v1-oauth': { type: 'oauth', access: 'tok-abc' },
    });
    defFixtures['v1-api'] = defFor('v1-api', { apiKey: 'sk-inline' });
    defFixtures['v1-oauth'] = defFor('v1-oauth', { apiKey: 'sk-inline-oauth' });
    modelFixtures['v1-api'] = { m1: {} };
    modelFixtures['v1-oauth'] = { m1: {} };
    catalogRecs = [recFor('v1-api'), recFor('v1-oauth')];

    const res = await buildDirectPool();
    const byName = new Map(res.instances.map((i) => [i.name, i]));
    expect(byName.get('v1-api')?.config.apiKey).toBe('sk-inline'); // Decision 1: inline above store
    // Inline precedence also owns the chain HEAD (invariant head === baked key);
    // the store account stays selectable below it.
    expect(byName.get('v1-api')?.credentialChain?.map((c) => c.key)).toEqual(['sk-inline', 'sk-store']);
    expect(byName.get('v1-api')?.credentialChain?.[0]?.label).toBe('inline');
    // The OCR store holds raw api keys only, so an auth.json oauth entry is never
    // imported: there is no oauth ACCOUNT to exclude anymore. With an inline key the
    // provider simply routes on it; without one it would exclude as 无凭证 (test above).
    expect(byName.get('v1-oauth')?.config.apiKey).toBe('sk-inline-oauth');
    expect(res.excluded.some((e) => e.provider === 'v1-oauth')).toBe(false);
  });
});

describe('(e) degraded-binding merge: factory excludedWithReason surfaces in excluded[]', () => {
  it('db_unreadable landing replaces the generic 无凭证 entry and carries reasonCode', async () => {
    const paths = sandboxPaths();
    fs.mkdirSync(path.dirname(paths.authJsonPath), { recursive: true });
    fs.writeFileSync(
      paths.authJsonPath,
      JSON.stringify({ stranded: { type: 'api', key: 'sk-stranded' } }),
      'utf8'
    );
    // opencode v2 evidence but NO opencode.db file → loud OcrStore landing + snapshot exclusions
    resetCredentialStoreForTests(paths, async () => 'v2.0.15', undefined, { env: {}, now: () => 1 });
    defFixtures['stranded'] = defFor('stranded');
    modelFixtures['stranded'] = { m1: {} };
    catalogRecs = [recFor('stranded')];

    const res = await buildDirectPool();
    const entries = res.excluded.filter((e) => e.provider === 'stranded' && !e.model);
    expect(entries).toHaveLength(1); // loop's no-credential entry was REPLACED, not duplicated
    expect(entries[0]!.reasonCode).toBe('db_unreadable');
    expect(entries[0]!.reason).toContain('db_unreadable');
    expect(entries[0]!.reason).toContain('auth.json snapshot');
    expect(res.instances.some((i) => i.name === 'stranded')).toBe(false);
  });
});
