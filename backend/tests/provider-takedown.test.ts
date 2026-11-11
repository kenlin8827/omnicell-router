import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProviderTakedownStore,
  setProviderTakedownStoreForTests,
} from '../src/providers/provider-takedown.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';

/**
 * Provider-level operator takedown.
 *
 * Two contracts under test:
 *   A. The ledger is a durable operator decision: disable/enable round-trips
 *      through the GLOBAL state file, re-disabling keeps the FIRST timestamp,
 *      and nothing about the lifecycle is automatic.
 *   B. Enforcement is a HARD pool exclusion: a disabled provider registers no
 *      models/instance at `buildDirectPool`, so `/v1/models` (that pool) omits
 *      it and a direct id cannot be resolved; re-enabling restores exactly.
 *
 * Everything else in the boot harness is stubbed (no disk/network/config
 * writes); the takedown store itself runs on an injected sandbox path set.
 */

const PROVIDER = 'acme';
const OTHER = 'other';

const nodeFor = (id: string) => ({
  id,
  options: { baseURL: `https://api.${id}.test/v1`, apiKey: `sk-${id}` },
  models: { 'm-on': {} },
});

const catalogRecs = [
  {
    id: PROVIDER,
    name: 'Acme',
    custom: true,
    connected: true,
    models: [{ id: 'm-on', cost: { input: 1, output: 2 }, modalities: { input: ['text'], output: ['text'] } }],
  },
  {
    id: OTHER,
    name: 'Other',
    custom: true,
    connected: true,
    models: [{ id: 'm-on', cost: { input: 1, output: 2 }, modalities: { input: ['text'], output: ['text'] } }],
  },
];

const fakeStore = {
  kind: 'opencode-v1' as const,
  capabilities: { multiCredential: false, activate: false, rename: false, oauth: false, envVisible: true },
  resolveKey: (id: string) => ({ key: `sk-${id}`, credential: { id, providerId: id, type: 'api' as const, active: true, routable: true } }),
  listCredentials: (id: string) => [{ id, providerId: id, type: 'api' as const, active: true, routable: true }],
  resolveKeyChain: () => [],
};

mock.module('../src/opencode/user-config.js', () => ({
  ROUTER_PROVIDER_ID: 'omnicell-router',
  getProviderNodeById: (id: string) => (id === PROVIDER || id === OTHER ? nodeFor(id) : undefined),
  getProviderModelDefs: () => ({ 'm-on': {} }),
  legacyShapedSlotEntries: () => [],
  expandEnvTemplate: (v: unknown) => v,
  getOpenCodeConfigPath: () => '<memory>/opencode.jsonc',
}));

mock.module('../src/opencode/credentials/index.js', () => ({
  getCredentialStore: async () => fakeStore,
  getCredentialStoreStatus: async () => ({ excluded: [] }),
}));

mock.module('../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => catalogRecs,
    lastSyncOrigin: 'test',
    ensureOcrStore: async () => {},
  },
}));

mock.module('../src/config/index.js', () => ({
  loadConfig: () => ({ tiers: {} }),
  saveConfig: () => ({ success: true }),
  getConfigPath: () => '<memory>/config.yaml',
}));

const { buildDirectPool } = await import('../src/providers/boot-direct.js');
const ids = (res: { models: { id: string }[] }) => res.models.map((m) => m.id);

function tmpPaths(tag: string): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ocr-provider-takedown-${tag}-`));
  return {
    configDir: path.join(dir, 'config'),
    dataDir: path.join(dir, 'data'),
    authJsonPath: path.join(dir, 'data', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'installed.version'),
    ocrHome: dir,
  };
}

let store: ProviderTakedownStore;

beforeEach(() => {
  store = new ProviderTakedownStore({ paths: tmpPaths('boot'), now: () => 1000 });
  setProviderTakedownStoreForTests(store);
});

afterEach(() => {
  setProviderTakedownStoreForTests(undefined);
});

describe('ProviderTakedownStore — durable operator lifecycle', () => {
  it('disable / get / enable round-trips through the state file', () => {
    const paths = tmpPaths('roundtrip');
    const s = new ProviderTakedownStore({ paths, now: () => 1000 });
    expect(s.isDisabled('acme')).toBe(false);

    expect(s.disable('acme', 'plan expired')).toBe(true);
    expect(s.isDisabled('acme')).toBe(true);
    expect(s.get('acme')?.reason).toBe('plan expired');

    const reloaded = new ProviderTakedownStore({ paths, now: () => 2000 });
    expect(reloaded.isDisabled('acme')).toBe(true);
    expect(reloaded.get('acme')?.disabledAt).toBe(1000);
    expect(reloaded.get('acme')?.reason).toBe('plan expired');

    expect(reloaded.enable('acme')).toBe(true);
    expect(reloaded.isDisabled('acme')).toBe(false);
    expect(reloaded.enable('acme')).toBe(false);
  });

  it('re-disabling keeps the FIRST disabledAt (the age is the audit signal) and refreshes the note', () => {
    let now = 1000;
    const s = new ProviderTakedownStore({ paths: tmpPaths('idempotent'), now: () => now });
    s.disable('acme', 'first');
    now = 5000;
    expect(s.disable('acme', 'second')).toBe(false);
    expect(s.get('acme')?.disabledAt).toBe(1000);
    expect(s.get('acme')?.reason).toBe('second');
  });

  it('a malformed file is treated as empty and preserved aside on the next write', () => {
    const paths = tmpPaths('corrupt');
    const file = path.join(paths.ocrHome, 'disabled-providers.json');
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    fs.writeFileSync(file, '{not json');
    const s = new ProviderTakedownStore({ paths, now: () => 7 });
    expect(s.isDisabled('acme')).toBe(false);
    s.disable('acme', '');
    const aside = fs.readdirSync(paths.ocrHome).filter((f) => f.startsWith('disabled-providers.json.corrupt.'));
    expect(aside).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).providers.acme).toBeDefined();
  });
});

describe('buildDirectPool — provider takedown is a hard pool exclusion', () => {
  beforeEach(() => {
    // fresh store per test (the outer beforeEach already installed it)
    store.enable(PROVIDER);
  });

  it('a disabled provider contributes no models/instance and is reported operator_disabled', async () => {
    store.disable(PROVIDER, 'plan expired');
    const res = await buildDirectPool();
    expect(res.models.some((m) => m.provider === PROVIDER)).toBe(false);
    expect(res.instances.some((i) => i.name === PROVIDER)).toBe(false);
    expect(res.excluded.some((e) => e.provider === PROVIDER && e.reasonCode === 'operator_disabled')).toBe(true);
    // Sibling providers are untouched.
    expect(ids(res)).toContain(`${OTHER}/m-on`);
  });

  it('re-enabling restores exactly the previous pool (no hidden-model bookkeeping)', async () => {
    store.disable(PROVIDER, '');
    expect(ids(await buildDirectPool())).not.toContain(`${PROVIDER}/m-on`);

    store.enable(PROVIDER);
    const restored = await buildDirectPool();
    expect(ids(restored)).toContain(`${PROVIDER}/m-on`);
    expect(ids(restored)).toContain(`${OTHER}/m-on`);
    expect(restored.excluded.some((e) => e.reasonCode === 'operator_disabled')).toBe(false);
  });
});
