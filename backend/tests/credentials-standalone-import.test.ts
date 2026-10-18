import { describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialPaths } from '../src/opencode/credentials/paths.js';
import {
  bindCredentialStore,
  readCredentialStoreState,
} from '../src/opencode/credentials/factory.js';
import {
  isAuthJsonWriteDisabled,
  isStandaloneAuthImported,
} from '../src/opencode/credentials/reconcile.js';

/**
 * Standalone one-shot import (fixes the previously flagged standalone
 * regression: the console wrote auth.json while the store-backed boot read
 * credentials.json). At bind time on the 'no opencode at all' landing with
 * auth.json entries present: type:'api' keys import into credentials.json
 * (keyHash dedup), oauth/wellknown are listed-and-badged NEVER imported,
 * auth.json stays byte-identical on disk, and the marker persists in
 * credential-store.json. Idempotent across rebinds.
 */

const actualUserConfig = await import('../src/opencode/user-config.js');
const defFixtures: Record<string, any> = {
  anthropic: { npm: '@ai-sdk/anthropic', options: { baseURL: 'https://api.anthropic.test/v1' } },
};
mock.module('../src/opencode/user-config.js', () => ({
  ...actualUserConfig,
  getProviderNodeById: (id: string) => defFixtures[id],
  getProviderModelDefs: (id: string) => (id in defFixtures ? {} : undefined),
  expandEnvTemplate: (v: unknown) => (typeof v === 'string' ? v : ''),
}));
mock.module('../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => [
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-x' }], npm: '@ai-sdk/anthropic', api: 'https://api.anthropic.test/v1' },
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

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-sai-'));
  const paths: CredentialPaths = {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  };
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  return paths;
}

const noOpencode = { versionProbe: async () => null as string | null, env: {}, now: () => 7000, sleep: async () => {} };

function readCredentialsFile(paths: CredentialPaths): any {
  const file = path.join(paths.ocrHome, 'credentials.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('B4 standalone one-shot import', () => {
  it('imports api entries, badges oauth/wellknown, leaves auth.json bytes untouched, persists the marker', async () => {
    const paths = sandboxPaths();
    const authBytes = JSON.stringify(
      {
        anthropic: { type: 'api', key: 'sk-standalone-import-me' },
        zen: { type: 'oauth', access: 'tok', refresh: 'ref', expires: 99 },
        wky: { type: 'wellknown', account_id: 'acct-1' },
      },
      null,
      2
    );
    fs.writeFileSync(paths.authJsonPath, authBytes);

    const binding = await bindCredentialStore({ paths, ...noOpencode });
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.degradedCode).toBeNull(); // unbadged standalone landing unchanged

    // imported key is live in the store
    expect(binding.store.resolveKey('anthropic')?.key).toBe('sk-standalone-import-me');
    expect(readCredentialsFile(paths).providers.anthropic).toHaveLength(1);
    // oauth/wellknown NEVER imported as keys, but LISTED AND BADGED
    expect(readCredentialsFile(paths).providers.zen).toBeUndefined();
    expect(binding.status.excluded.map((e) => e.provider)).toEqual(['zen', 'wky']);
    expect(binding.status.excluded[0]!.reasonCode).toBe('no_routable_credential');

    // auth.json: the upstream artifact survives byte-identical (never rewritten, never deleted)
    expect(fs.readFileSync(paths.authJsonPath, 'utf8')).toBe(authBytes);

    // persisted marker (additive schema)
    const state = readCredentialStoreState(paths)!;
    expect(state.bound).toBe('ocr');
    expect(state.standaloneImport?.doneAt).toBe(7000);
    const actions = Object.fromEntries(state.standaloneImport!.entries.map((e) => [e.provider, e.action]));
    expect(actions).toEqual({ anthropic: 'imported', zen: 'skipped_oauth', wky: 'skipped_wellknown' });

    // the two one-shot flags stand on their own (auth.json is never a sink, so no
    // combined "superseded" query is needed anymore)
    expect(isStandaloneAuthImported(paths)).toBe(true);
    expect(isAuthJsonWriteDisabled(paths)).toBe(false);
  });

  it('idempotent across rebinds: no duplicate accounts, marker preserved', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-idempotent' } }));
    await bindCredentialStore({ paths, ...noOpencode });
    const first = readCredentialStoreState(paths)!;
    const accounts1 = readCredentialsFile(paths).providers.anthropic as unknown[];
    expect(accounts1).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 5)); // doneAt clock moves (marker must NOT rerun)
    const second = await bindCredentialStore({ paths, ...noOpencode, now: () => 9000 });
    expect(second.store.resolveKey('anthropic')?.key).toBe('sk-idempotent'); // still routable (boot path)
    expect(readCredentialsFile(paths).providers.anthropic).toHaveLength(1); // zero duplicate writes
    const state2 = readCredentialStoreState(paths)!;
    expect(state2.standaloneImport?.doneAt).toBe(first.standaloneImport!.doneAt); // original marker preserved
  });

  it('keyHash dedup against existing local accounts', async () => {
    const paths = sandboxPaths();
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    fs.writeFileSync(
      path.join(paths.ocrHome, 'credentials.json'),
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: [{ accountId: 'pre-existing', key: 'sk-already-local', timeCreated: 1, timeUpdated: 1, active: true }],
        },
      })
    );
    fs.writeFileSync(
      paths.authJsonPath,
      JSON.stringify({ anthropic: { type: 'api', key: 'sk-already-local' }, openai: { type: 'api', key: 'sk-new-side' } })
    );
    await bindCredentialStore({ paths, ...noOpencode });
    const file = readCredentialsFile(paths);
    expect(file.providers.anthropic).toHaveLength(1); // deduped — no second copy
    expect(file.providers.openai).toHaveLength(1);
    const actions = Object.fromEntries(readCredentialStoreState(paths)!.standaloneImport!.entries.map((e) => [e.provider, e.action]));
    expect(actions).toEqual({ anthropic: 'deduped', openai: 'imported' });
  });

  it('corrupt auth.json: no crash, NO marker (next boot retries); oauth-only auth.json: marker with zero keys', async () => {
    const bad = sandboxPaths();
    fs.writeFileSync(bad.authJsonPath, '{ broken');
    const binding = await bindCredentialStore({ paths: bad, ...noOpencode });
    expect(binding.status.kind).toBe('ocr');
    expect(binding.store.resolveKey('anthropic')).toBeNull(); // nothing imported from the corrupt file
    expect(readCredentialStoreState(bad)?.standaloneImport).toBeUndefined();
    // retried at next boot once readable
    fs.writeFileSync(bad.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-retry-works' } }));
    const fresh = await bindCredentialStore({ paths: bad, ...noOpencode });
    expect(readCredentialStoreState(bad)?.standaloneImport?.doneAt).toBe(7000);
    expect(fresh.store.resolveKey('anthropic')?.key).toBe('sk-retry-works');

    const oauthOnly = sandboxPaths();
    fs.writeFileSync(oauthOnly.authJsonPath, JSON.stringify({ zen: { type: 'oauth', access: 'tok' } }));
    await bindCredentialStore({ paths: oauthOnly, ...noOpencode });
    expect(readCredentialStoreState(oauthOnly)?.standaloneImport?.doneAt).toBe(7000);
    expect(readCredentialsFile(oauthOnly)).toBeNull(); // nothing imported
  });

  it('auth.json absent/empty: nothing imported, NO marker (no auth.json machine stays untouched)', async () => {
    const paths = sandboxPaths();
    await bindCredentialStore({ paths, ...noOpencode });
    expect(readCredentialStoreState(paths)?.standaloneImport).toBeUndefined();
    expect(fs.existsSync(path.join(paths.ocrHome, 'credentials.json'))).toBe(false);
  });

  it('P2-10: malformed entries are recorded failed + badged, marker WITHHELD; next boot reruns (good keys dedup)', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(
      paths.authJsonPath,
      JSON.stringify({
        anthropic: { type: 'api', key: 'sk-good-importable' },
        broken: { type: 'api' }, // no key string
        weird: { type: 42 }, // not api/oauth/wellknown — unclassifiable
      })
    );
    const binding = await bindCredentialStore({ paths, ...noOpencode });

    // the good key imports anyway (no silent whole-file abandonment)…
    expect(binding.store.resolveKey('anthropic')?.key).toBe('sk-good-importable');
    // …while the malformed ones are LOUD: excluded entries + no marker
    const malformed = binding.status.excluded.filter((e) => e.reasonCode === 'no_routable_credential');
    expect(malformed.map((e) => e.provider).sort()).toEqual(['broken', 'weird']);
    expect(readCredentialStoreState(paths)?.standaloneImport).toBeUndefined(); // marker withheld

    // next boot: rerun — anthropic dedups (no duplicate account), still no
    // marker while the malformed entries remain in auth.json
    const { resetCredentialStoreForTests, getCredentialStore } = await import('../src/opencode/credentials/factory.js');
    resetCredentialStoreForTests(paths, async () => null, undefined, { env: {}, now: () => 8000 });
    const store2 = await getCredentialStore();
    const file = readCredentialsFile(paths);
    expect(file.providers.anthropic).toHaveLength(1); // dedup prevented double-import
    expect(store2.resolveKey('anthropic')?.key).toBe('sk-good-importable');

    // operator fixes auth.json (drops the malformed rows) -> boot completes
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-good-importable' } }));
    resetCredentialStoreForTests(paths, async () => null, undefined, { env: {}, now: () => 9000 });
    await getCredentialStore();
    const state = readCredentialStoreState(paths)!;
    expect(state.standaloneImport?.doneAt).toBe(9000);
    const actions = Object.fromEntries(state.standaloneImport!.entries.map((e) => [e.provider, e.action]));
    expect(actions).toEqual({ anthropic: 'deduped' });
  });

  it('P2-10b: unreadable local credentials.json mid-import lands failed + no marker (bind survives, retried next boot)', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(
      paths.authJsonPath,
      JSON.stringify({ anthropic: { type: 'api', key: 'sk-needs-local-write' } })
    );
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    fs.writeFileSync(path.join(paths.ocrHome, 'credentials.json'), '{ corrupt');

    const binding = await bindCredentialStore({ paths, ...noOpencode });
    expect(binding.status.kind).toBe('ocr'); // the bind itself stands
    const failed = binding.status.excluded.find((e) => e.provider === 'anthropic');
    expect(failed).toBeDefined();
    expect(failed!.reasonCode).toBe('reconcile_push_failed');
    expect(failed!.detail).toContain('local store');
    expect(readCredentialStoreState(paths)?.standaloneImport).toBeUndefined(); // marker withheld

    // fix the local file -> next boot completes the import + persists marker
    fs.rmSync(path.join(paths.ocrHome, 'credentials.json'));
    const { resetCredentialStoreForTests, getCredentialStore } = await import('../src/opencode/credentials/factory.js');
    resetCredentialStoreForTests(paths, async () => null, undefined, { env: {}, now: () => 9000 });
    const store2 = await getCredentialStore();
    expect(store2.resolveKey('anthropic')?.key).toBe('sk-needs-local-write');
    expect(readCredentialStoreState(paths)?.standaloneImport?.doneAt).toBe(9000);
  });

  it('subsequent boot: buildDirectPool bakes the imported key (B3 regression closed end-to-end)', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-boot-visible' } }));
    await bindCredentialStore({ paths, ...noOpencode });

    // Fresh process semantics: clear the sticky binding, rebind (boot 2 reads the
    // now-imported credentials.json via the store — exactly what buildDirectPool consumes).
    const { resetCredentialStoreForTests, getCredentialStore } = await import('../src/opencode/credentials/factory.js');
    resetCredentialStoreForTests(paths, async () => null, undefined, { env: {}, now: () => 8000 });
    const store = await getCredentialStore();
    expect(store.resolveKey('anthropic')?.key).toBe('sk-boot-visible');

    const { buildDirectPool } = await import('../src/providers/boot-direct.js');
    const boot = await buildDirectPool();
    const inst = boot.instances.find((i) => i.name === 'anthropic');
    expect(inst?.config.apiKey).toBe('sk-boot-visible');
  });
});
