import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { CatalogModel } from '../src/opencode/catalog/types.js';
import type { TiersConfig } from '../src/config/types.js';
import type { TierLevel } from '../src/types/router.js';

/**
 * Lock for "no runtime seeding — boot claims against member lists as loaded".
 *
 * boot-direct never generates or persists member lists: it claims models
 * against `tiers.*.members` as loaded. Defaults ship NO members (four empty
 * tier shells in DEFAULT_CONFIG.tiers, pinned in config-tiers-template.test.ts).
 * Here the stub config carries operator-written member lists (the globs once
 * shipped as the first-boot template) to exercise the claiming path.
 *
 *   a) the member globs claim the matching models into the right tiers
 *      (list index 0 = leader = primary); non-matching siblings come out
 *      `unclassified` (still callable by full id — direct path, not pooled);
 *   b) zero claims → the all-empty warning fires once, every model is
 *      unclassified, boot does not crash;
 *   and on BOTH: saveConfig is never called (nothing persists at boot) and a
 *      populated boot stays silent.
 *
 * Stubbed like boot-direct-disabled.test.ts: no disk, no network.
 */

const PROVIDER = 'acme';
const TEXT = { input: ['text'], output: ['text'] };

/** Operator-written member lists (defaults ship none; shape pinned in config-tiers-template.test.ts). */
const TEMPLATE_TIERS: TiersConfig = {
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
const savedPatches: unknown[] = [];

mock.module('../src/opencode/user-config.js', () => ({
  ROUTER_PROVIDER_ID: 'onecast-router',
  getProviderNodeById: () => node,
  getProviderModelDefs: () => ({}),
  // boot-direct asks the reader which native-slot nodes it refused (Decision 11);
  // these fixtures hand it normalized nodes directly, so nothing is refused.
  legacyShapedSlotEntries: () => [],
  expandEnvTemplate: (v: unknown) => v,
  getOpenCodeConfigPath: () => '<memory>/opencode.jsonc',
}));

/**
 * Boot-direct resolves credentials through the bound
 * CredentialStore (NOT readAuthEntries anymore). In-memory single-credential store
 * double: one key per provider, no activate/rename, which is what the OCR file
 * store also gives a one-key provider.
 */
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
mock.module('../src/opencode/credentials/index.js', () => ({
  getCredentialStore: async () => fakeStore,
  getCredentialStoreStatus: async () => ({ excluded: [] }),
}));

mock.module('../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => [
      { id: PROVIDER, name: 'Acme', custom: true, connected: true, models: catalogModels },
    ],
    lastSyncOrigin: 'test',
    ensureOcrStore: async () => {},
  },
}));

mock.module('../src/config/index.js', () => ({
  loadConfig: () => ({ tiers: TEMPLATE_TIERS }),
  saveConfig: (patch: unknown) => {
    savedPatches.push(patch);
    return { success: true };
  },
  getConfigPath: () => '<memory>/config.yaml',
}));

const { buildDirectPool } = await import('../src/providers/boot-direct.js');

const fam = (id: string): CatalogModel => ({ id, modalities: TEXT });

/** Boot once with console.warn captured; always restores the real one. */
async function boot() {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  };
  try {
    const res = await buildDirectPool();
    return { res, warns };
  } finally {
    console.warn = orig;
  }
}

describe('boot-direct — member globs claim, nothing seeds or persists', () => {
  beforeEach(() => {
    savedPatches.length = 0;
    catalogModels = [];
  });

  it('(a) the member globs claim matching models; siblings stay unclassified; silent + no writes', async () => {
    catalogModels = [
      fam('claude-haiku-1'),
      fam('claude-sonnet-x'),
      fam('claude-opus-y'),
      fam('claude-fable-z'),
      fam('gpt-5'), // matches no member glob
      fam('gemini-3'), // …ditto
    ];
    const { res, warns } = await boot();
    const byId = new Map(res.models.map((m) => [m.id, m]));

    const claims: [string, TierLevel][] = [
      [`${PROVIDER}/claude-haiku-1`, 'lite'],
      [`${PROVIDER}/claude-sonnet-x`, 'plus'],
      [`${PROVIDER}/claude-opus-y`, 'pro'],
      [`${PROVIDER}/claude-fable-z`, 'ultra'],
    ];
    for (const [id, tier] of claims) {
      const m = byId.get(id);
      expect(m).toBeDefined();
      expect(m!.tier).toBe(tier);
      expect(m!.priority).toBe(1); // sole glob = rule index 0
      expect(m!.isDefaultInTier).toBe(true); // index 0 leads the chain
      expect(m!.unclassified).toBeUndefined();
    }
    for (const id of [`${PROVIDER}/gpt-5`, `${PROVIDER}/gemini-3`]) {
      expect(byId.get(id)!.unclassified).toBe(true); // no pool; still callable by full id
    }
    expect(savedPatches).toHaveLength(0); // NO boot-time persistence anymore
    expect(warns.filter((w) => w.includes('routing pools')).length).toBe(0); // at least one tier has members → silent
  });

  it('(b) zero claims → all-empty warning fires once, pools empty, no crash, no writes', async () => {
    catalogModels = [fam('gpt-5'), fam('llama-4')];
    const { res, warns } = await boot();
    expect(res.models).toHaveLength(2); // models registered…
    expect(res.models.every((m) => m.unclassified === true)).toBe(true); // …but none pooled
    expect(res.instances).toHaveLength(1); // provider still mounts (direct-by-id works)
    const poolWarns = warns.filter((w) => w.includes('routing pools'));
    expect(poolWarns).toHaveLength(1);
    expect(poolWarns[0]).toContain('auto'); // names what cannot route
    expect(poolWarns[0]).toContain('/tiers'); // points at the fix
    expect(savedPatches).toHaveLength(0); // the warning is a warning, not a write
  });
});
