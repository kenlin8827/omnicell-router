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
  writeCredentialStoreState,
} from '../src/opencode/credentials/factory.js';
import { DbOpener } from '../src/opencode/credentials/opencode-v2-store.js';
import { VersionEvidence } from '../src/opencode/credentials/types.js';

const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

function fakeDb(rows: unknown[] = [], counter?: { opens: number }): DbOpener {
  return async () => {
    if (counter) counter.opens += 1;
    return {
      query(sql: string) {
        return {
          all: () => (sql.includes('table_info') ? ALL_COLS.map((c) => ({ name: c })) : rows),
        };
      },
      close() {
        // no-op
      },
    };
  };
}

const throwingOpener =
  (message = 'SQLITE_CANTOPEN: unable to open database file', counter?: { opens: number }): DbOpener =>
  async () => {
    if (counter) counter.opens += 1;
    throw new Error(message);
  };

const OAUTH_ROW = {
  id: 'c1',
  integration_id: 'zen',
  label: null,
  value: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 0, methodID: 'm', metadata: {} }),
  active: 1,
  time_created: 1,
  time_updated: 1,
};

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

const probeVersion = (v: string | null) => async () => v;

function base(overrides: BindOverrides): BindOverrides {
  // Default no-op sleep: the bind-time probe retry must not cost real wall
  // time in tests; the retry test below injects a recording sleep instead.
  return { env: {}, now: () => 555_000, sleep: async () => {}, ...overrides };
}

describe('credential store factory', () => {
  it('opencode v2  with readable db -> OpencodeV2Store; providers with no routable row are excluded', async () => {
    const paths = sandboxPaths();
    const binding = await bindCredentialStore(
      base({ paths, versionProbe: probeVersion('v2.0.15'), openDatabase: fakeDb([OAUTH_ROW]) })
    );
    expect(binding.status.kind).toBe('opencode-v2');
    expect(binding.status.degradedCode).toBeNull();
    expect(binding.status.evidence.used).toBe('cli');
    expect(binding.status.capabilities).toEqual({
      multiAccount: true,
      activate: true,
      rename: true,
      oauth: false,
      envVisible: true,
      integrationScoped: true,
    });
    expect(binding.excludedWithReason).toEqual([
      { provider: 'zen', reasonCode: 'no_routable_credential', detail: expect.any(String) },
    ]);
    // last-known-good persisted (write-through)
    expect(readLkg(paths)).toMatchObject({ bound: 'opencode-v2', version: 'v2.0.15', degradedCode: null });
  });

  it('opencode v2 + unreadable db -> OcrStore + db_unreadable badge + snapshot-excluded providers; opencode v2->opencode v1 fallback stays FORBIDDEN', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(
      paths.authJsonPath,
      JSON.stringify({
        anthropic: { type: 'api', key: 'sk-snapshot' }, // stranded: readable only via the unreadable db
        beta: { type: 'api', key: 'sk-beta' }, // covered by OcrStore already
        zen: { type: 'oauth', access: 'a' }, // never routed anyway — not "key-only-in-db"
      })
    );
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    fs.writeFileSync(
      path.join(paths.ocrHome, 'credentials.json'),
      JSON.stringify({ version: 1, providers: { beta: [{ accountId: 'b1', key: 'sk-beta', timeCreated: 1, timeUpdated: 1, active: true }] } })
    );
    const opens = { opens: 0 };
    const binding = await bindCredentialStore(
      base({
        paths,
        versionProbe: probeVersion('v2.0.15'),
        openDatabase: throwingOpener(undefined, opens),
        // file absent + generic open error = cannot_open, not contention
        busyAttempts: 5,
      })
    );
    expect(opens.opens).toBe(1); // no retry spin on a genuinely missing db
    expect(binding.status.kind).toBe('ocr'); // NOT 'opencode-v1' — stale snapshot never binds on an opencode v2 
    expect(binding.status.degradedCode).toBe('db_unreadable');
    expect(binding.excludedWithReason.map((e) => e.provider)).toEqual(['anthropic']);
    expect(binding.excludedWithReason[0]!.reasonCode).toBe('db_unreadable');
    expect(binding.status.detail).toContain('unreadable');
  });

  it('opencode v1 machine: NOT supported — OcrStore badged unsupported_version, snapshot imported once', async () => {
    const ok = sandboxPaths();
    fs.writeFileSync(ok.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-1' } }));
    const b1 = await bindCredentialStore(base({ paths: ok, versionProbe: probeVersion('v1.4.6') }));
    expect(b1.status.kind).toBe('ocr');
    expect(b1.status.degradedCode).toBe('unsupported_version');
    expect(b1.status.credentialFile).toBe(ocrCredentialsFile(ok));
    // Nothing that routed before goes silent: the snapshot is imported into the OCR store.
    expect(fs.existsSync(ocrCredentialsFile(ok))).toBe(true);
    expect(fs.readFileSync(ocrCredentialsFile(ok), 'utf8')).toContain('anthropic');
    // …and auth.json is never written back.
    expect(JSON.parse(fs.readFileSync(ok.authJsonPath, 'utf8')).anthropic.key).toBe('sk-1');

    const bad = sandboxPaths();
    fs.writeFileSync(bad.authJsonPath, '{ broken');
    const b2 = await bindCredentialStore(base({ paths: bad, versionProbe: probeVersion('v1.4.6') }));
    expect(b2.status.kind).toBe('ocr');
    expect(b2.status.degradedCode).toBe('unsupported_version');
  });

  it('CLI absent + installed.version opencode v2 + db present -> OpencodeV2Store-readonly with cli_absent_db_present', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.installedVersionPath, '2.0.0');
    const binding = await bindCredentialStore(
      base({ paths, versionProbe: probeVersion(null), openDatabase: fakeDb([]) })
    );
    expect(binding.status.kind).toBe('opencode-v2-readonly');
    expect(binding.status.degradedCode).toBe('cli_absent_db_present');
    expect(binding.status.evidence.used).toBe('installed.version');
    expect(binding.status.probeResult?.state).toBe('empty'); // EmptyCredentialTableError surfaces as a state, not a badge
    expect(binding.store.capabilities.activate).toBe(false);
  });

  it('installed.version FILE EXISTENCE never selects a store alone (garbage content = no evidence)', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.installedVersionPath, 'banana');
    const binding = await bindCredentialStore(base({ paths, versionProbe: probeVersion(null) }));
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.degradedCode).toBeNull(); // unbadged standalone landing
  });

  it('CLI absent + no version file + db file present -> OpencodeV2Store-readonly (db is the evidence)', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.opencodeDbPath, 'fake-db-bytes'); // existence only; reads are mocked
    const binding = await bindCredentialStore(
      base({ paths, versionProbe: probeVersion(null), openDatabase: fakeDb([]) })
    );
    expect(binding.status.kind).toBe('opencode-v2-readonly');
    expect(binding.status.evidence.used).toBe('db-present');
  });

  it('no opencode at all -> OcrStore unbadged (normal standalone)', async () => {
    const paths = sandboxPaths();
    const binding = await bindCredentialStore(base({ paths, versionProbe: probeVersion(null) }));
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.degradedCode).toBeNull();
    expect(binding.status.evidence.used).toBe('none');
    expect(binding.status.probeResult?.state).toBe('empty');
  });

  it('a null first probe retries once — boot-contention guard promotes CLI evidence when the retry hits', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.installedVersionPath, '2.0.0'); // fallback evidence would win without the retry
    let calls = 0;
    const sleeps: number[] = [];
    const binding = await bindCredentialStore(
      base({
        paths,
        versionProbe: async () => (++calls === 1 ? null : 'v2.0.15'),
        openDatabase: fakeDb([OAUTH_ROW]),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      })
    );
    expect(binding.status.kind).toBe('opencode-v2');
    expect(binding.status.degradedCode).toBeNull();
    expect(binding.status.evidence.used).toBe('cli');
    expect(calls).toBe(2); // exactly one retry
    expect(sleeps).toEqual([2500]);
  });

  it('a CRASHING versionProbe is evidence-free (same landing as CLI-absent), never a bind failure', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.opencodeDbPath, 'fake-db-bytes'); // db-present evidence
    const binding = await bindCredentialStore(
      base({ paths, versionProbe: async () => { throw new Error('spawn exploded'); }, openDatabase: fakeDb([]) })
    );
    expect(binding.status.evidence).toMatchObject({ cli: null, used: 'db-present' });
    expect(binding.status.kind).toBe('opencode-v2-readonly');
    expect(binding.status.degradedCode).toBe('cli_absent_db_present');
  });

  it('hysteresis: persisted opencode v2 binding survives PATH jitter (no ping-pong to unbadged standalone)', async () => {
    const paths = sandboxPaths();
    const good = fakeDb([]);
    await bindCredentialStore(base({ paths, versionProbe: probeVersion('v2.0.15'), openDatabase: good }));
    // boot 2: CLI vanished from PATH, no installed.version, db still readable
    const b2 = await bindCredentialStore(base({ paths, versionProbe: probeVersion(null), openDatabase: good }));
    expect(b2.status.kind).toBe('opencode-v2-readonly');
    expect(b2.status.evidence.used).toBe('last-known-good');
    expect(b2.status.degradedCode).toBe('cli_absent_db_present');
    // boot 3: CLI vanished AND db unreadable -> degraded landing stays badged, never plain standalone
    const b3 = await bindCredentialStore(
      base({ paths, versionProbe: probeVersion(null), openDatabase: throwingOpener() })
    );
    expect(b3.status.kind).toBe('ocr');
    expect(b3.status.degradedCode).toBe('db_unreadable');
  });

  it('last-known-good record roundtrips the bind decision', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, '{ broken');
    await bindCredentialStore(base({ paths, versionProbe: probeVersion('v1.4.6') }));
    const rec = readLkg(paths)!;
    expect(rec).toMatchObject({
      bound: 'ocr',
      version: 'v1.4.6',
      degradedCode: 'unsupported_version',
      updatedAt: 555_000,
    });
    const ev = rec.evidence as VersionEvidence;
    expect(ev).toMatchObject({ cli: 'v1.4.6', used: 'cli', lastKnownGood: null });
  });

  it('binding is sticky for the process lifetime; reset is the test seam', async () => {
    const paths = sandboxPaths();
    let probes = 0;
    resetCredentialStoreForTests(paths, async () => {
      probes += 1;
      return 'v2.0.15';
    }, undefined, { env: {}, openDatabase: fakeDb([]), now: () => 1 });

    const s1 = await getCredentialStore();
    const s2 = await getCredentialStore();
    expect(s1).toBe(s2);
    expect(probes).toBe(1);

    const status: StoreStatus = await getCredentialStoreStatus();
    expect(status.kind).toBe('opencode-v2');
    expect(status.credentialFile).toBe(paths.opencodeDbPath);

    // a reset with fresh overrides re-binds (new probe returns null; the
    // persisted opencode v2 LKG + unreadable db lands badged OcrStore — hysteresis)
    resetCredentialStoreForTests(paths, async () => null, undefined, {
      env: {},
      openDatabase: throwingOpener(),
      now: () => 1,
    });
    const s3 = await getCredentialStore();
    expect(s3.kind).toBe('ocr');
    expect(probes).toBe(1); // the first probe ran exactly once across the sticky section
  });
});

describe('bind totality + sticky rejection reset (reviewer P1-2)', () => {
  it('unexpected bind throw lands OcrStore badged bind_failed — bindCredentialStore never rejects', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-1' } }));
    // the FIRST clock read blows up (status.boundAt) — the bind machinery
    // must land on the degraded OcrStore, never reject, never go silent.
    let clockBooms = 1;
    const now = () => {
      if (clockBooms-- > 0) throw new Error('clock exploded');
      return 888_000;
    };
    // A v2 machine exercises the store-construction limb; the totality handler is
    // shared, so the version evidence used to reach it does not change the landing.
    const binding = await bindCredentialStore(base({ paths, versionProbe: probeVersion('v2.0.15'), now }));
    expect(binding.store.kind).toBe('ocr');
    expect(binding.status.kind).toBe('ocr');
    expect(binding.status.degradedCode).toBe('bind_failed');
    expect(binding.status.detail).toContain('clock exploded');
    expect(binding.excludedWithReason).toEqual([
      { provider: '*', reasonCode: 'bind_failed', detail: expect.stringContaining('clock exploded') },
    ]);
    // the failed bind persists a degraded record (no prior LKG existed —
    // version stays null; a persisted pin WOULD be kept by the landing)
    const persisted = readLkg(paths)!;
    expect(persisted).toMatchObject({ bound: 'ocr', degradedCode: 'bind_failed' });
    expect(persisted.evidence).toMatchObject({ used: 'none' });
  });

  it('injected opener throws once → concurrent getCredentialStore() resolve to the degraded landing (no rejection cached), reset re-binds next boot', async () => {
    const paths = sandboxPaths();
    const good = fakeDb([]);
    let opens = 0;
    const flaky: DbOpener = async (file) => {
      opens += 1;
      if (opens <= 1) throw new Error('opener boom');
      return good(file);
    };
    resetCredentialStoreForTests(paths, probeVersion('v2.0.15'), undefined, {
      env: {},
      now: () => 1,
      openDatabase: flaky,
      busyAttempts: 1,
    });
    const [s1, s2] = await Promise.all([getCredentialStore(), getCredentialStore()]);
    expect(s1.kind).toBe('ocr');
    expect(s2).toBe(s1); // concurrent callers share one landing
    const st = await getCredentialStoreStatus();
    expect(st.degradedCode).toBe('db_unreadable'); // loud, degraded — never silent
    // next boot (process restart equivalent): reset + healthy opener rebinds opencode v2
    resetCredentialStoreForTests(paths, probeVersion('v2.0.15'), undefined, {
      env: {},
      now: () => 1,
      openDatabase: good,
    });
    const s3 = await getCredentialStore();
    expect(s3.kind).toBe('opencode-v2');
  });

  it('a bind that STILL rejects (crash inside the degraded landing) is never cached — the next call re-binds', async () => {
    const paths = sandboxPaths();
    const realHome = paths.ocrHome;
    let homeReads = 0;
    const hostile: CredentialPaths = {
      ...paths,
      get ocrHome() {
        homeReads += 1;
        // #1: lkg read (swallowed internally), #2: standalone OcrStore ctor
        // (bind crashes), #3: landing OcrStore ctor (degraded path crashes
        // too) -> bindCredentialStore rejects and ensureBinding must reset.
        if (homeReads <= 3) throw new Error('home unreadable');
        return realHome;
      },
    };
    resetCredentialStoreForTests(hostile, probeVersion(null), undefined, {
      env: {},
      now: () => 1,
      sleep: async () => {}, // probe-retry guard must not cost real time here
    });
    let firstErr: unknown;
    try {
      await getCredentialStore();
    } catch (e) {
      firstErr = e;
    }
    expect(String(firstErr)).toContain('home unreadable');
    // the rejection must NOT stick: next call retries the bind for real
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
