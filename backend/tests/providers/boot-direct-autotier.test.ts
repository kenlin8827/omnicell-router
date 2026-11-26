import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { CatalogModel } from '../../src/opencode/catalog/types.js';
import type { TiersConfig } from '../../src/config/types.js';

/**
 * Lock for the `autoTier` provenance stamp on direct-pool registrations.
 *
 * Every reader in the registry keys live reclassification, multi-tier
 * membership, per-pool effortMap translation and the console `tiersOf` view
 * off `model.autoTier` being PRESENT (`if (!m.autoTier) continue` /
 * hand-configured branches in registry.ts). A hand-configured model carries no
 * stamp; a member-list-claimed direct-pool model MUST carry it, or every one of
 * those readers silently treats it as immutable and the 2s live hand-YAML
 * replay never moves it.
 *
 * The stamp carries NO payload: membership is derived from the tier member
 * lists at every commit, and nothing about price, name pattern or capability
 * feeds it any more. An explicit `tier` in the defs file is the one thing that
 * suppresses the stamp (the operator pin the member lists may never move).
 *
 * Stubbed like boot-direct-template-members.test.ts: no disk, no network.
 */

const PROVIDER = 'acme';
const TEXT = { input: ['text'], output: ['text'] };

const TIERS: TiersConfig = {
  lite: { members: [{ pattern: '*haiku*' }] },
  plus: { members: [{ pattern: '*sonnet*' }] },
  pro: { members: [{ pattern: '*opus*' }] },
  ultra: { members: [{ pattern: '*fable*' }] },
};

const node = {
  options: { baseURL: 'https://api.acme.test/v1', apiKey: 'sk-test' },
  models: {},
};

let catalogModels: CatalogModel[] = [];
/** Per-model defs-file overrides (the operator's explicit `tier` pin, cost, …). */
let defs: Record<string, Record<string, unknown>> = {};

mock.module('../../src/opencode/user-config.js', () => ({
  ROUTER_PROVIDER_ID: 'omnicell-router',
  getProviderNodeById: () => node,
  // The defs node is the model universe: every fixture model is maintained.
  getProviderModelDefs: () => Object.fromEntries(catalogModels.map((m) => [m.id, defs[m.id] ?? {}])),
  legacyShapedSlotEntries: () => [],
  expandEnvTemplate: (v: unknown) => v,
  getOpenCodeConfigPath: () => '<memory>/opencode.jsonc',
}));

const fakeStore = {
  kind: 'ocr' as const,
  capabilities: { multiCredential: false, activate: false, rename: false, oauth: false, envVisible: true },
  resolveKey: (id: string) =>
    id === PROVIDER
      ? { key: 'sk-test', credential: { id, providerId: id, type: 'api' as const, active: true, routable: true } }
      : null,
  listCredentials: (id: string) =>
    id === PROVIDER ? [{ id, providerId: id, type: 'api' as const, active: true, routable: true }] : [],
  resolveKeyChain: () => [],
};
mock.module('../../src/opencode/credentials/index.js', () => ({
  getCredentialStore: async () => fakeStore,
  getCredentialStoreStatus: async () => ({ excluded: [] }),
}));

mock.module('../../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => [
      { id: PROVIDER, name: 'Acme', custom: true, connected: true, models: catalogModels },
    ],
    lastSyncOrigin: 'test',
    ensureOcrStore: async () => {},
  },
}));

mock.module('../../src/config/index.js', () => ({
  loadConfig: () => ({ tiers: TIERS }),
  saveConfig: () => ({ success: true }),
  getConfigPath: () => '<memory>/config.yaml',
}));

const { buildDirectPool } = await import('../../src/providers/boot-direct.js');

const fam = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, modalities: TEXT, ...extra });

describe('boot-direct — the autoTier stamp marks member-list-claimed models as replayable', () => {
  beforeEach(() => {
    catalogModels = [];
    defs = {};
  });

  it('stamps every model it builds, claimed AND unclaimed, so the registry may replay them', async () => {
    catalogModels = [
      fam('claude-haiku-1'),
      fam('claude-opus-y'),
      fam('gpt-5'), // matches no member glob → no home tier, but still replayable
    ];
    const res = await buildDirectPool();
    const byId = new Map(res.models.map((m) => [m.id, m]));

    for (const id of [`${PROVIDER}/claude-haiku-1`, `${PROVIDER}/claude-opus-y`, `${PROVIDER}/gpt-5`]) {
      const m = byId.get(id);
      expect(m).toBeDefined();
      // The stamp's PRESENCE is the contract: its absence made every
      // direct-pool model read as hand-configured / reclassification-immune.
      expect(m!.autoTier).toBe(true);
      expect(m!.configTier).toBeUndefined(); // no operator pin
    }
    // Claimed models hold their member-list home tier…
    expect(byId.get(`${PROVIDER}/claude-haiku-1`)!.tier).toBe('lite');
    expect(byId.get(`${PROVIDER}/claude-opus-y`)!.tier).toBe('pro');
    // …and a model no member list claims starts with NO home tier: the fourth
    // state is `tier === undefined`, not a placeholder tier.
    expect(byId.get(`${PROVIDER}/gpt-5`)!.tier).toBeUndefined();
  });

  it('carries no payload: nothing about price or capability is persisted any more', async () => {
    catalogModels = [fam('claude-opus-y', { cost: { input: 3, output: 15 } })];
    const res = await buildDirectPool();
    const m = res.models.find((x) => x.id === `${PROVIDER}/claude-opus-y`)!;
    expect(m.autoTier).toBe(true);
    // The retired `tierMatch` payload must not come back under another name.
    expect(Object.keys(m).some((k) => k.toLowerCase().includes('tiermatch'))).toBe(false);
    // Pricing still flows from the catalog (its own field, not the stamp).
    expect(m.pricing?.input).toBe(3);
  });

  it('an explicit defs-file tier suppresses the stamp and pins the home tier', async () => {
    catalogModels = [fam('claude-sonnet-1')];
    // The member glob would claim this for `plus`; the operator pin wins.
    defs = { 'claude-sonnet-1': { tier: 'ultra' } };
    const res = await buildDirectPool();
    const m = res.models.find((x) => x.id === `${PROVIDER}/claude-sonnet-1`)!;
    expect(m.autoTier).toBeUndefined(); // hand-configured: member lists never move it
    expect(m.configTier).toBe('ultra');
    expect(m.tier).toBe('ultra');
  });
});

describe('boot-direct — no fabricated price (the one cost→pricing rule)', () => {
  beforeEach(() => {
    catalogModels = [];
    defs = {};
  });

  it('a model with no catalog cost keeps pricing undefined, never a synthesized 0', async () => {
    catalogModels = [fam('claude-haiku-1')];
    const res = await buildDirectPool();
    const m = res.models.find((x) => x.id === `${PROVIDER}/claude-haiku-1`)!;
    expect(m.pricing).toBeUndefined();
  });

  it('a partial cost (input without output) is not a price → undefined', async () => {
    catalogModels = [fam('claude-haiku-1', { cost: { input: 1 } })];
    const res = await buildDirectPool();
    const m = res.models.find((x) => x.id === `${PROVIDER}/claude-haiku-1`)!;
    expect(m.pricing).toBeUndefined();
  });

  it('an absent cached-READ rate derives from input (billed as input), not zero', async () => {
    catalogModels = [fam('claude-opus-y', { cost: { input: 3, output: 15 } })];
    const res = await buildDirectPool();
    const m = res.models.find((x) => x.id === `${PROVIDER}/claude-opus-y`)!;
    expect(m.pricing).toEqual({ input: 3, output: 15, cacheRead: 3 });
  });

  it('an absent cached-WRITE rate is OMITTED, not fabricated as 0', async () => {
    catalogModels = [fam('claude-opus-y', { cost: { input: 3, output: 15, cache_read: 0.3 } })];
    const res = await buildDirectPool();
    const m = res.models.find((x) => x.id === `${PROVIDER}/claude-opus-y`)!;
    expect(m.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3 });
    expect(m.pricing?.cacheWrite).toBeUndefined();
  });

  it('a declared cached-WRITE rate is carried verbatim', async () => {
    catalogModels = [fam('claude-opus-y', { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } })];
    const res = await buildDirectPool();
    const m = res.models.find((x) => x.id === `${PROVIDER}/claude-opus-y`)!;
    expect(m.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });
});