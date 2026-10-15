import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Lock for "hide from the model catalog" (`disabled`).
 *
 * boot-direct builds the routing pool; `/v1/models` lists exactly that pool
 * (server.ts → registry.getAllModels()), and the orchestrator routes a named
 * model to it. So a model is only truly hidden when boot-direct keeps it out.
 *
 * Visibility is decided ONCE, from the AGGREGATE record — which is how the
 * pool is actually built:
 *   - def values flow in via configModelsFor's `...def` spread
 *   - overrides.json is applied LAST (override wins — same as `temperature`)
 *   - boot-direct skips any model whose aggregate says `disabled === true`
 *
 * Two rules under test:
 *   A. provider model universe — config defs win when present; "all defs
 *      disabled" must NOT fall back to the catalog listing (that fallback is
 *      only for providers with no defs at all, i.e. credential-only);
 *   B. `disabled` from either plane keeps the model out of the pool, and an
 *      override `disabled: false` can re-show a def-hidden model (WYSIWYG).
 *
 * The catalog stub reproduces the real merge order (def passthrough → override)
 * so the tests exercise that contract, not a convenient fiction. Everything
 * else is stubbed: no disk, no network, no config.yaml writes.
 */

const PROVIDER = 'acme';
const MODEL_IDS = ['m-on', 'm-off'] as const;

const node = {
  options: { baseURL: 'https://api.acme.test/v1', apiKey: 'sk-test' },
  models: {},
};

/** opencode.jsonc model defs for the provider. */
let defs: Record<string, any> = {};
/** overrides.json `disabled` flags, keyed by model id. */
let overrides: Record<string, boolean> = {};

/** The aggregate record, as repository.aggregate() would hand it over. */
const aggregateModels = () =>
  MODEL_IDS.map((id) => ({
    ...(defs[id] ?? {}), // configModelsFor: `...def` spread
    ...(overrides[id] !== undefined ? { disabled: overrides[id] } : {}), // overrides applied last
    id,
    cost: { input: 1, output: 2 },
    modalities: { input: ['text'], output: ['text'] },
  }));

mock.module('../src/opencode/user-config.js', () => ({
  getProviderNodeById: () => node,
  getProviderModelDefs: () => defs,
  // boot-direct asks the reader which native-slot nodes it refused (Decision 11);
  // these fixtures hand it normalized nodes directly, so nothing is refused.
  legacyShapedSlotEntries: () => [],
  expandEnvTemplate: (v: unknown) => v,
  getOpenCodeConfigPath: () => '<memory>/opencode.jsonc',
}));

/**
 * Boot-direct resolves credentials through the bound
 * CredentialStore (NOT readAuthEntries anymore). In-memory single-account store
 * double: one key per provider, which is what the OCR file store also gives a
 * one-key provider.
 */
const fakeStore = {
  kind: 'opencode-v1' as const,
  capabilities: { multiAccount: false, activate: false, rename: false, oauth: false, envVisible: true },
  resolveKey: (id: string) =>
    id === PROVIDER
      ? { key: 'sk-test', account: { id, providerId: id, type: 'api' as const, active: true, routable: true } }
      : null,
  listAccounts: (id: string) =>
    id === PROVIDER ? [{ id, providerId: id, type: 'api' as const, active: true, routable: true }] : [],
  resolveKeyChain: () => [],
};
mock.module('../src/opencode/credentials/index.js', () => ({
  getCredentialStore: async () => fakeStore,
  getCredentialStoreStatus: async () => ({ excluded: [] }),
}));

mock.module('../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => [
      { id: PROVIDER, name: 'Acme', custom: true, connected: true, models: aggregateModels() },
    ],
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
const ids = (res: { models: { id: string }[] }) => res.models.map((m) => m.id);

describe('provider model universe (config defs vs catalog fallback)', () => {
  beforeEach(() => {
    defs = {};
    overrides = {};
  });

  it('keeps the enabled defs and drops the disabled ones', async () => {
    defs = { 'm-on': {}, 'm-off': { disabled: true } };
    expect(ids(await buildDirectPool())).toContain(`${PROVIDER}/m-on`);
    expect(ids(await buildDirectPool())).not.toContain(`${PROVIDER}/m-off`);
  });

  it('ALL defs disabled → the provider drops out entirely (no catalog fallback)', async () => {
    defs = { 'm-on': { disabled: true }, 'm-off': { disabled: true } };
    const res = await buildDirectPool();
    expect(res.models.some((m) => m.provider === PROVIDER)).toBe(false);
    expect(res.instances.some((i) => i.name === PROVIDER)).toBe(false);
    expect(res.excluded.some((e) => e.provider === PROVIDER)).toBe(true);
  });

  it('auth-only provider (no defs at all) still falls back to the catalog listing', async () => {
    defs = {};
    const pool = ids(await buildDirectPool());
    expect(pool).toContain(`${PROVIDER}/m-on`);
    expect(pool).toContain(`${PROVIDER}/m-off`);
  });
});

describe('hide from the catalog (`disabled`) — aggregate decides', () => {
  beforeEach(() => {
    defs = {};
    overrides = {};
  });

  it('a hidden model is absent from the pool — /v1/models omits it and nothing can be pinned to it', async () => {
    defs = { 'm-on': {}, 'm-off': { disabled: true } };
    const res = await buildDirectPool();
    expect(res.models.some((m) => m.id.includes('m-off'))).toBe(false);
    expect(res.excluded.some((e) => e.model === `${PROVIDER}/m-off`)).toBe(true);
  });

  it('hides a CATALOG-sourced model of an auth-only provider (no def exists)', async () => {
    defs = {};
    overrides = { 'm-off': true };
    const res = await buildDirectPool();
    // the provider stays (its sibling model is still routable) …
    expect(ids(res)).toContain(`${PROVIDER}/m-on`);
    // … but the hidden one never enters the pool
    expect(ids(res)).not.toContain(`${PROVIDER}/m-off`);
  });

  it('override `disabled: false` re-shows a def-hidden model (WYSIWYG un-hide)', async () => {
    defs = { 'm-on': { disabled: true }, 'm-off': {} };
    overrides = { 'm-on': false };
    expect(ids(await buildDirectPool())).toContain(`${PROVIDER}/m-on`);
  });

  it('hiding every model of a provider removes that provider only', async () => {
    defs = {};
    overrides = { 'm-on': true, 'm-off': true };
    const res = await buildDirectPool();
    expect(res.models.some((m) => m.provider === PROVIDER)).toBe(false);
    expect(res.excluded.some((e) => e.provider === PROVIDER)).toBe(true);
  });
});