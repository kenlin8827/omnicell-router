import { describe, expect, it, mock } from 'bun:test';

/**
 * Reviewer P2-9 — boot-direct per-provider store-read isolation:
 * a store that THROWS for exactly one provider (mid-loop db handle failure,
 * row-shape drift) must exclude THAT provider (reasonCode db_unreadable) and
 * keep building the rest of the pool. Before the fix a single throw killed
 * the whole rebuild → catch-all → standalone registry with 0 providers.
 */

const actualCredentials = await import('../src/opencode/credentials/index.js');
const actualUserConfig = await import('../src/opencode/user-config.js');

import type { CredentialMeta, CredentialStore, ResolvedCredential, StoreCapabilities } from '../src/opencode/credentials/types.js';

const caps: StoreCapabilities = { multiCredential: true, activate: true, rename: true, oauth: false, envVisible: true };

/** Throws for provider 'p-poison' on every read path; behaves otherwise. */
const poisonStore: CredentialStore = {
  kind: 'opencode-v2',
  capabilities: caps,
  probe: () => ({ ok: true, kind: 'opencode-v2', state: 'ready', credentialCount: 2 }),
  listCredentials: (providerId): CredentialMeta[] => {
    if (providerId === 'p-poison') throw new Error('SQLITE_CORRUPT: block checksum mismatch');
    return providerId === 'p-good'
      ? [{ id: 'c1', providerId, type: 'api', active: true, routable: true, keyHashPrefix: 'a'.repeat(12) }]
      : [];
  },
  resolveKey: (providerId): ResolvedCredential | null => {
    if (providerId === 'p-poison') throw new Error('SQLITE_CORRUPT: block checksum mismatch');
    return providerId === 'p-good'
      ? { key: 'sk-good-key', credential: { id: 'c1', providerId, type: 'api', active: true, routable: true } }
      : null;
  },
  resolveKeyChain: () => [],
  connectKey: async () => {
    throw new Error('unused');
  },
  activate: async () => {
    throw new Error('unused');
  },
  rename: async () => {
    throw new Error('unused');
  },
  disconnect: async () => {
    throw new Error('unused');
  },
  beginOAuth: async () => {
    throw new Error('unused');
  },
  completeOAuth: async () => {
    throw new Error('unused');
  },
  invalidate: () => undefined,
  credentialsOverview: () => [
    { providerId: 'p-good', total: 1, routable: 1, activeCredentialId: 'c1' },
    { providerId: 'p-poison', total: 1, routable: 1, activeCredentialId: null },
  ],
};

mock.module('../src/opencode/credentials/index.js', () => ({
  ...actualCredentials,
  getCredentialStore: async () => poisonStore,
  getCredentialStoreStatus: async () => ({
    kind: 'opencode-v2' as const,
    capabilities: caps,
    degradedCode: null,
    evidence: { cli: 'v2.0.15', file: null, used: 'cli' as const, lastKnownGood: null },
    excluded: [],
    credentials: [{ providerId: 'p-good', total: 1, routable: 1, activeCredentialId: 'c1' }],
    probeResult: { ok: true, kind: 'opencode-v2' as const, state: 'ready' as const, credentialCount: 2 },
    credentialFile: 'x.db',
    boundAt: 1,
  }),
}));

mock.module('../src/opencode/user-config.js', () => ({
  ...actualUserConfig,
  getProviderNodeById: (id: string) => ({ options: { baseURL: `https://${id}.test/v1` } }),
  getProviderModelDefs: () => ({ m1: {} }),
  expandEnvTemplate: (v: unknown) => (typeof v === 'string' ? v : ''),
}));

mock.module('../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => [
      { id: 'p-good', name: 'p-good', custom: true, connected: true, api: 'https://p-good.test/v1', models: [{ id: 'm1' }] },
      { id: 'p-poison', name: 'p-poison', custom: true, connected: true, api: 'https://p-poison.test/v1', models: [{ id: 'm1' }] },
      { id: 'p-quiet', name: 'p-quiet', custom: true, connected: false, api: 'https://p-quiet.test/v1', models: [{ id: 'm1' }] },
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

describe('boot-direct per-provider store-read isolation (P2-9)', () => {
  it('a store throw for provider p-poison excludes only p-poison; the pool still builds', async () => {
    const res = await buildDirectPool();

    // the healthy providers survive the poisoned sibling's throw
    expect(res.instances.some((i) => i.name === 'p-good')).toBe(true);
    expect(res.instances.find((i) => i.name === 'p-good')?.config.apiKey).toBe('sk-good-key');
    expect(res.instances.some((i) => i.name === 'p-poison')).toBe(false);

    // the poisoned provider lands LOUD with the machine-readable code
    const entry = res.excluded.find((e) => e.provider === 'p-poison' && !e.model);
    expect(entry).toBeDefined();
    expect(entry!.reasonCode).toBe('db_unreadable');
    expect(entry!.reason).toContain('SQLITE_CORRUPT');

    // unaffected provider without credentials keeps the pre-existing
    // no-credential exclusion (def node present in this mock) — NOT the
    // db_unreadable code: the isolation change adds no new verdicts
    const quiet = res.excluded.find((e) => e.provider === 'p-quiet' && !e.model);
    expect(quiet?.reason).toContain('无凭证');
    expect(quiet?.reasonCode).toBe('no_credential');
  });
});
