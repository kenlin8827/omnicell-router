import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialPaths,
  credentialStoreStateFile,
  ocrCredentialsFile,
} from '../src/opencode/credentials/paths.js';
import {
  BindOverrides,
  StoreStatus,
  atomicWriteWithRetry,
  bindCredentialStore,
  getCredentialStore,
  getCredentialStoreStatus,
  readCredentialStoreState,
  resetCredentialStoreForTests,
} from '../src/opencode/credentials/factory.js';
import { PROVIDER_DEFS_IMPORT_VERSION } from '../src/opencode/provider-defs.js';

/**
 * The factory binds ONE store per boot — ALWAYS the OcrStore. The opencode
 * v2 db/CLI are the credential-sync client's territory and select nothing,
 * so every evidence combination lands on the same unbadged store.
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cred-fac-'));
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

function readLkg(paths: CredentialPaths): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(credentialStoreStateFile(paths), 'utf8'));
  } catch {
    return null;
  }
}

const OCR_CAPS = {
  multiCredential: true,
  activate: true,
  reorder: true,
  weight: true,
  rename: true,
  oauth: false,
  envVisible: false,
  integrationScoped: false,
};

describe('credential store factory', () => {
  it('binds the OcrStore unbadged regardless of opencode evidence (the sync client selects nothing)', async () => {
    // A "v2 machine" shape: CLI version file, db file, auth.json — all ignored
    // by the bind; the store is the OCR file either way.
    const paths = sandboxPaths();
    fs.writeFileSync(paths.installedVersionPath, '2.0.0');
    fs.writeFileSync(paths.opencodeDbPath, 'fake-db-bytes');
    const binding = await bindCredentialStore(base({ paths }));
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.degradedCode).toBeNull();
    expect(binding.status.evidence).toMatchObject({ cli: null, file: '2.0.0', used: 'installed.version', lastKnownGood: null });
    expect(binding.status.capabilities).toEqual(OCR_CAPS);
    expect(binding.status.credentialFile).toBe(ocrCredentialsFile(paths));
    expect(binding.status.probeResult?.state).toBe('empty');
    // last-known-good record persists the (only) landing
    expect(readLkg(paths)).toMatchObject({ bound: 'ocr', version: '2.0.0', degradedCode: null });
  });

  it('re-arms the client→OCR provider import when the recorded marker predates the importer version', async () => {
    const paths = sandboxPaths();
    await bindCredentialStore(base({ paths })); // first boot writes the CURRENT marker
    const marker = (readLkg(paths) as any).providerDefsImport;
    expect(marker.version).toBe(PROVIDER_DEFS_IMPORT_VERSION);

    // Simulate an install whose import already fired under an older version,
    // then a hand-written provider appears in the client config.
    const stale = { ...readLkg(paths)! };
    delete (stale.providerDefsImport as any).version;
    fs.writeFileSync(credentialStoreStateFile(paths), JSON.stringify(stale));
    fs.writeFileSync(
      path.join(paths.configDir, 'opencode.jsonc'),
      '{"providers": { "relay": { "package": "@opencode/ai/providers/openai-compatible", "settings": { "baseURL": "https://r.example/v1" } } }}'
    );

    resetCredentialStoreForTests();
    await bindCredentialStore(base({ paths }));
    const defs = JSON.parse(fs.readFileSync(path.join(paths.ocrHome, 'providers.json'), 'utf8'));
    expect(defs.providers.relay.package).toBe('@opencode/ai/providers/openai-compatible');
    expect(defs.providers.relay.settings.baseURL).toBe('https://r.example/v1');
    expect((readLkg(paths) as any).providerDefsImport.version).toBe(PROVIDER_DEFS_IMPORT_VERSION);
  });

  it('records used:"none" when no opencode trace exists', async () => {
    const paths = sandboxPaths();
    const binding = await bindCredentialStore(base({ paths }));
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.degradedCode).toBeNull();
    expect(binding.status.evidence.used).toBe('none');
    expect(binding.status.probeResult?.state).toBe('empty');
  });

  it('garbage installed.version content is not evidence', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.installedVersionPath, 'banana');
    const binding = await bindCredentialStore(base({ paths }));
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.evidence.used).toBe('none');
  });

  it('auth.json one-shot import: api keys land in the OCR file, oauth rows are excluded loudly, auth.json untouched', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(
      paths.authJsonPath,
      JSON.stringify({
        anthropic: { type: 'api', key: 'sk-1' },
        zen: { type: 'oauth', access: 'a' },
      })
    );
    const binding = await bindCredentialStore(base({ paths }));
    expect(binding.status.kind).toBe('ocr');
    expect(fs.existsSync(ocrCredentialsFile(paths))).toBe(true);
    expect(fs.readFileSync(ocrCredentialsFile(paths), 'utf8')).toContain('anthropic');
    // auth.json is never written back (byte-identical content preserved)
    expect(JSON.parse(fs.readFileSync(paths.authJsonPath, 'utf8')).zen.access).toBe('a');
    // oauth rows are listed-and-badged, never imported as keys
    expect(binding.excludedWithReason).toEqual([
      { provider: 'zen', reasonCode: 'no_routable_credential', detail: expect.any(String) },
    ]);
    // the marker records the one-shot
    expect(readLkg(paths)).toMatchObject({ bound: 'ocr' });
    expect((readLkg(paths)!.standaloneImport as { doneAt: number }).doneAt).toBe(555_000);
  });

  it('the import marker makes the import one-shot (second bind does not re-import)', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-1' } }));
    await bindCredentialStore(base({ paths }));
    // operator disconnects the imported key, then the process re-binds
    fs.writeFileSync(ocrCredentialsFile(paths), JSON.stringify({ version: 1, providers: {} }));
    await bindCredentialStore(base({ paths }));
    expect(fs.readFileSync(ocrCredentialsFile(paths), 'utf8')).not.toContain('anthropic');
  });

  it('broken auth.json: import defers (no marker), the bind stands', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, '{ broken');
    const binding = await bindCredentialStore(base({ paths }));
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.degradedCode).toBeNull();
    expect(binding.excludedWithReason).toEqual([]);
    expect(readLkg(paths)).toMatchObject({ bound: 'ocr' });
    expect((readLkg(paths) as { standaloneImport?: unknown }).standaloneImport).toBeUndefined();
  });

  it('binding is sticky for the process lifetime; reset is the test seam', async () => {
    const paths = sandboxPaths();
    resetCredentialStoreForTests(paths, undefined, undefined, { env: {}, now: () => 1 });

    const [s1, s2] = await Promise.all([getCredentialStore(), getCredentialStore()]);
    expect(s1).toBe(s2); // concurrent callers share one binding

    const status: StoreStatus = await getCredentialStoreStatus();
    expect(status.kind).toBe('ocr');
    expect(status.credentialFile).toBe(ocrCredentialsFile(paths));

    // a reset re-binds (still the OcrStore — there is no other landing)
    resetCredentialStoreForTests(paths, undefined, undefined, { env: {}, now: () => 2 });
    const s3 = await getCredentialStore();
    expect(s3.kind).toBe('ocr');
  });
});

describe('bind totality + sticky rejection reset (reviewer P1-2)', () => {
  it('unexpected bind throw lands OcrStore badged bind_failed — bindCredentialStore never rejects', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-1' } }));
    // The clock ALWAYS explodes: per-entry import failures swallow the first
    // throws (loud, excluded), and the bind's own boundAt read escapes —
    // the total wrapper must land on the badged OcrStore, never reject.
    const now = (): number => {
      throw new Error('clock exploded');
    };
    const binding = await bindCredentialStore(base({ paths, now }));
    expect(binding.store.kind).toBe('ocr');
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.degradedCode).toBe('bind_failed');
    expect(binding.status.detail).toContain('clock exploded');
    expect(binding.excludedWithReason).toEqual([
      { provider: '*', reasonCode: 'bind_failed', detail: expect.stringContaining('clock exploded') },
    ]);
    // the failed bind persists a degraded record
    const persisted = readLkg(paths)!;
    expect(persisted).toMatchObject({ bound: 'ocr', degradedCode: 'bind_failed' });
    expect(persisted.evidence).toMatchObject({ used: 'none' });
  });

  it('a bind that STILL rejects (hostile home) is never cached — the next call re-binds', async () => {
    const paths = sandboxPaths();
    const realHome = paths.ocrHome;
    let hostileMode = true;
    const hostile: CredentialPaths = {
      ...paths,
      get ocrHome() {
        if (hostileMode) throw new Error('home unreadable');
        return realHome;
      },
    };
    resetCredentialStoreForTests(hostile, undefined, undefined, { env: {}, now: () => 1 });
    let firstErr: unknown;
    try {
      await getCredentialStore();
    } catch (e) {
      firstErr = e;
    }
    expect(String(firstErr)).toContain('home unreadable');
    // the rejection must NOT stick: next call retries the bind for real
    hostileMode = false; // "the machine healed"
    const store = await getCredentialStore();
    expect(store.kind).toBe('ocr');
  });
});

describe('atomicWriteWithRetry backoff (reviewer P2-21)', () => {
  it('transient EPERM renames are retried with a blocking sleep, file lands, no tmp debris', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-atomic-'));
    const target = path.join(dir, 'state.json');
    const actual = fs.renameSync;
    let failures = 2;
    const started = Date.now();
    try {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((from: string, to: string) => {
        if (failures-- > 0) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return actual(from, to);
      }) as typeof fs.renameSync;
      atomicWriteWithRetry(target, '{"ok":true}');
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = actual;
    }
    const elapsed = Date.now() - started;
    expect(fs.readFileSync(target, 'utf8')).toBe('{"ok":true}');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
    // 10ms + 20ms blocking sleeps before the third attempt succeeds
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });
});

function base(overrides: BindOverrides): BindOverrides {
  return { env: {}, now: () => 555_000, ...overrides };
}
