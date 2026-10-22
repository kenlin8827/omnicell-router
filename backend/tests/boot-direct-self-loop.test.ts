import { describe, expect, it, mock } from 'bun:test';

/**
 * Self-reference guard, by URL — never by id (ADR-0010):
 *   - a provider whose baseURL points at THIS gateway's own port is excluded
 *     from the pool loudly (reasonCode self_loop) — pooling it would recurse
 *     every routed request into the gateway. The guard runs on the RESOLVED
 *     baseURL (after env-template expansion), so the self-reference here
 *     arrives via a `{env:SELF_URL}` def — the exact escape a raw-record
 *     check would miss;
 *   - a provider with the SAME id pointing at a DIFFERENT instance (another
 *     port) is a legitimate federation upstream and pools normally.
 * The catalog is stubbed: this file locks the pool-plane verdict only.
 */

const actualCredentials = await import('../src/opencode/credentials/index.js');
const actualUserConfig = await import('../src/opencode/user-config.js');

const OWN_PORT = 41022;
const OTHER_PORT = 41999;

const keyStore = {
  kind: 'opencode-v1' as const,
  capabilities: { multiCredential: false, activate: false, rename: false, oauth: false, envVisible: true },
  resolveKey: (id: string) =>
    ['p-good', 'self-loop', 'fed-relay'].includes(id)
      ? { key: 'sk-test', credential: { id: 'c1', providerId: id, type: 'api' as const, active: true, routable: true } }
      : null,
  listCredentials: (id: string) =>
    ['p-good', 'self-loop', 'fed-relay'].includes(id)
      ? [{ id: 'c1', providerId: id, type: 'api' as const, active: true, routable: true }]
      : [],
  resolveKeyChain: () => [],
};

mock.module('../src/opencode/credentials/index.js', () => ({
  ...actualCredentials,
  getCredentialStore: async () => keyStore,
  getCredentialStoreStatus: async () => ({
    kind: 'opencode-v1' as const,
    capabilities: keyStore.capabilities,
    degradedCode: null,
    evidence: { cli: null, file: 'credentials.json', used: 'file' as const, lastKnownGood: null },
    excluded: [],
    credentials: [],
    probeResult: { ok: true, kind: 'opencode-v1' as const, state: 'ready' as const, credentialCount: 3 },
    credentialFile: 'credentials.json',
    boundAt: 1,
  }),
}));

mock.module('../src/opencode/user-config.js', () => ({
  ...actualUserConfig,
  // The def's baseURL wins over the catalog record (pool bakes the resolved
  // value), so the self-loop and federation URLs ride env templates here.
  getProviderNodeById: (id: string) => ({
    options: {
      baseURL:
        id === 'self-loop' ? '{env:SELF_URL}' : id === 'fed-relay' ? '{env:FED_URL}' : `https://${id}.test/v1`,
    },
  }),
  getProviderModelDefs: () => ({ m1: {} }),
  legacyShapedSlotEntries: () => [],
  expandEnvTemplate: (v: unknown) =>
    v === '{env:SELF_URL}'
      ? `http://127.0.0.1:${OWN_PORT}/v1`
      : v === '{env:FED_URL}'
        ? `http://127.0.0.1:${OTHER_PORT}/v1`
        : typeof v === 'string'
          ? v
          : '',
}));

mock.module('../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => [
      { id: 'p-good', name: 'p-good', custom: true, connected: true, baseURL: 'https://p-good.test/v1', models: [{ id: 'm1' }] },
      // loopback host + the gateway's OWN port → self_loop
      { id: 'self-loop', name: 'self-loop', custom: true, connected: true, baseURL: `http://127.0.0.1:${OWN_PORT}/v1`, models: [{ id: 'm1' }] },
      // SAME id family, DIFFERENT instance port → normal federation upstream
      { id: 'fed-relay', name: 'fed-relay', custom: true, connected: true, baseURL: `http://127.0.0.1:${OTHER_PORT}/v1`, models: [{ id: 'm1' }] },
    ],
    lastSyncOrigin: 'test',
    ensureOcrStore: async () => {},
  },
}));

mock.module('../src/config/index.js', () => ({
  loadConfig: () => ({ tiers: {}, exclude: [], port: OWN_PORT }),
  saveConfig: () => ({ success: true }),
  getConfigPath: () => '<memory>/config.yaml',
}));

const { buildDirectPool } = await import('../src/providers/boot-direct.js');

describe('boot-direct self-reference guard (by URL, never by id)', () => {
  it('a baseURL pointing at the gateway itself is excluded loudly as self_loop', async () => {
    const res = await buildDirectPool();
    const hit = res.excluded.find((e) => e.provider === 'self-loop');
    expect(hit?.reasonCode).toBe('self_loop');
    expect(res.instances.some((i) => i.name === 'self-loop')).toBe(false);
  });

  it('the same id pointing at ANOTHER instance pools normally (federation)', async () => {
    const res = await buildDirectPool();
    expect(res.excluded.find((e) => e.provider === 'fed-relay')).toBeUndefined();
    expect(res.instances.some((i) => i.name === 'fed-relay')).toBe(true);
    expect(res.instances.some((i) => i.name === 'p-good')).toBe(true);
  });
});
