import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialPaths, credentialStoreStateFile } from '../src/opencode/credentials/paths.js';
import {
  CredentialStoreState,
  StoreStatus,
  bindCredentialStore,
  readCredentialStoreState,
} from '../src/opencode/credentials/factory.js';
import { DbOpener, OpencodeV2Store } from '../src/opencode/credentials/opencode-v2-store.js';
import {
  CredentialStore,
  StoreCapabilities,
  StoreProbeResult,
  keyHashPrefix,
} from '../src/opencode/credentials/types.js';
import {
  ensureReconciled,
  isAuthJsonWriteDisabled,
} from '../src/opencode/credentials/reconcile.js';

const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

function fakeDb(rows: unknown[] = [], loads?: { loads: number }): DbOpener {
  return async () => ({
    query(sql: string) {
      return {
        all: () => {
          if (sql.includes('table_info')) return ALL_COLS.map((c) => ({ name: c }));
          if (loads) loads.loads += 1;
          return rows;
        },
      };
    },
    close() {
      // no-op
    },
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function makeFetch(onPost: (url: string) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init?.body)) : undefined });
    if (method === 'GET') {
      return new Response(
        JSON.stringify({ data: [{ id: 'anthropic' }, { id: 'openai' }, { id: 'failing' }, { id: 'other' }] }),
        { status: 200 }
      );
    }
    const res = onPost(url);
    return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
  };
  return { fetchImpl, calls };
}

function captureLog() {
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
  return { log, lines };
}

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-reconcile-'));
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
  // service.json for the write path — without it resolveServiceConfig returns
  // null and pushes never reach the fetch mock.
  fs.writeFileSync(paths.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  return paths;
}

function seedAuthJson(paths: CredentialPaths): void {
  fs.writeFileSync(
    paths.authJsonPath,
    JSON.stringify(
      {
        anthropic: { type: 'api', key: 'sk-auth-only-111222' },
        openai: { type: 'api', key: 'sk-dup-key-333444' }, // same key already in db → deduped
        failing: { type: 'api', key: 'sk-will-fail-555666' },
        zen: { type: 'oauth', access: 'tok', refresh: 'ref' },
        wky: { type: 'wellknown', account_id: 'acct-1' },
      },
      null,
      2
    )
  );
}

const dupRow = {
  id: 'db-openai-1',
  integration_id: 'openai',
  label: null,
  value: JSON.stringify({ type: 'key', key: 'sk-dup-key-333444' }),
  active: 1,
  time_created: 1,
  time_updated: 1,
};

/** Bind through the REAL factory so the state file write-through is realistic. */
async function bindV2(paths: CredentialPaths, fetchImpl: typeof fetch, loads?: { loads: number }, rows: unknown[] = [dupRow]) {
  return bindCredentialStore({
    paths,
    versionProbe: async () => 'v2.0.15',
    fetchImpl,
    env: {},
    now: () => 777,
    openDatabase: fakeDb(rows, loads),
  });
}

describe('reconcile gate (ADR-0019 Decision 4)', () => {
  it('pushes auth.json-only keys, dedups by keyHash, skips oauth/wellknown, never touches auth.json, completes idempotently', async () => {
    const paths = sandboxPaths();
    seedAuthJson(paths);
    const authBefore = fs.readFileSync(paths.authJsonPath);
    const loads = { loads: 0 };
    const { fetchImpl, calls } = makeFetch((url) =>
      url.includes('/failing/') ? { status: 500 } : { status: 201, json: { credential: { id: 'new-1' } } }
    );
    const binding = await bindV2(paths, fetchImpl, loads);
    expect(binding.store.kind).toBe('opencode-v2');
    const { log, lines } = captureLog();

    const res = await ensureReconciled(binding.store, binding.status, { paths, log, now: () => 4242 });

    expect(res.ran).toBe(true);
    expect(res.entries).toEqual([
      { provider: 'anthropic', action: 'pushed' },
      { provider: 'openai', action: 'deduped' },
      { provider: 'failing', action: 'failed', reason: expect.any(String) },
    ]);
    // zen (oauth) / wky (wellknown) never pushed and never recorded
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.filter((c) => c.url.includes('/anthropic/connect/key'))).toHaveLength(1);
    expect(posts.filter((c) => c.url.includes('/openai/connect/key'))).toHaveLength(0); // deduped by keyHash
    expect(posts.filter((c) => c.url.includes('/zen/'))).toHaveLength(0);
    expect(posts.filter((c) => c.url.includes('/wky/'))).toHaveLength(0);
    expect((posts.find((c) => c.url.includes('/anthropic/'))!.body as Record<string, unknown>).key).toBe('sk-auth-only-111222');

    // push failure → loud excluded entry with the ADR detail, remaining entries kept going
    expect(binding.status.excluded).toContainEqual({
      provider: 'failing',
      reasonCode: 'reconcile_push_failed',
      detail: 'push failed, key present locally',
    });

    // auth.json is opencode's territory — byte-identical after reconcile
    expect(fs.readFileSync(paths.authJsonPath).equals(authBefore)).toBe(true);

    // pushed keys resolvable THIS boot: invalidate() dropped the cached view
    const loadsBefore = loads.loads;
    binding.store.listAccounts('anthropic');
    expect(loads.loads).toBe(loadsBefore + 1); // would have been served from cache without invalidate

    // per-entry logging
    expect(lines.some((l) => l.includes('anthropic: pushed'))).toBe(true);
    expect(lines.some((l) => l.includes('openai: deduped'))).toBe(true);
    expect(lines.some((l) => l.includes('failing: push failed'))).toBe(true);

    // marker + audit trail roundtrip through the state file
    const state = readCredentialStoreState(paths)!;
    expect(state.reconcile).toMatchObject({ doneAt: 4242, authWriteDisabled: true });
    expect(state.reconcile!.entries).toHaveLength(3);
    expect(isAuthJsonWriteDisabled(paths)).toBe(true);

    // idempotent rerun: marker short-circuits, no new pushes, entries echo
    const postCount = calls.filter((c) => c.method === 'POST').length;
    const res2 = await ensureReconciled(binding.store, binding.status, { paths, log, now: () => 9999 });
    expect(res2).toMatchObject({ ran: false, skipped: 'already-done', authWriteDisabled: true });
    expect(res2.entries).toHaveLength(3);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(postCount);

    // marker survives rebind (additive schema, bind write-through preserves it)
    const rebinding = await bindV2(paths, fetchImpl, loads);
    const afterRebind: CredentialStoreState | null = readCredentialStoreState(paths);
    expect(afterRebind?.reconcile?.authWriteDisabled).toBe(true);
    expect(afterRebind?.bound).toBe('opencode-v2');
    void rebinding;
  });

  it('OpencodeV2Store-readonly never triggers the gate (writes refused, auth.json stays enabled)', async () => {
    const paths = sandboxPaths();
    seedAuthJson(paths);
    fs.writeFileSync(paths.opencodeDbPath, 'db-bytes'); // db-present evidence BEFORE binding
    const { fetchImpl, calls } = makeFetch(() => ({ status: 201 }));
    const binding = await bindCredentialStore({
      paths,
      versionProbe: async () => null, // CLI absent + db present -> readonly
      fetchImpl,
      env: {},
      now: () => 1,
      openDatabase: fakeDb([]),
    });
    expect(binding.status.kind).toBe('opencode-v2-readonly');
    const res = await ensureReconciled(binding.store, binding.status, { paths, ...captureLog() });
    expect(res).toMatchObject({ ran: false, skipped: 'not-opencode-v2' });
    expect(isAuthJsonWriteDisabled(paths)).toBe(false);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('all pushes failing still completes and disables the auth.json write path', async () => {
    const paths = sandboxPaths();
    seedAuthJson(paths);
    const { fetchImpl } = makeFetch(() => ({ status: 502 }));
    const binding = await bindV2(paths, fetchImpl);
    const res = await ensureReconciled(binding.store, binding.status, { paths, ...captureLog(), now: () => 5000 });
    expect(res.ran).toBe(true);
    expect(res.entries).toEqual([
      { provider: 'anthropic', action: 'failed', reason: expect.any(String) },
      { provider: 'openai', action: 'deduped' },
      { provider: 'failing', action: 'failed', reason: expect.any(String) },
    ]);
    expect(binding.status.excluded.map((e) => e.provider)).toEqual(['anthropic', 'failing']);
    const state = readCredentialStoreState(paths)!;
    expect(state.reconcile).toMatchObject({ doneAt: 5000, authWriteDisabled: true });
    expect(isAuthJsonWriteDisabled(paths)).toBe(true);
  });

  it('P2-5: boot1 push-fails -> boot2 rebind clean -> status.excluded STILL shows the stranded key', async () => {
    const paths = sandboxPaths();
    seedAuthJson(paths);
    const { fetchImpl } = makeFetch((url) => (url.includes('/failing/') ? { status: 500 } : { status: 201 }));
    const boot1 = await bindV2(paths, fetchImpl);
    const r1 = await ensureReconciled(boot1.store, boot1.status, { paths, ...captureLog(), now: () => 100 });
    expect(r1.ran).toBe(true);
    expect(r1.entries.some((e) => e.action === 'failed')).toBe(true);

    // boot 2: fresh bind (fresh StoreStatus) — the already-done gate must
    // RE-APPEND the persisted failed entries; without the fix the stranded
    // 'failing' key would be invisible forever (Decision 4 honesty).
    const boot2 = await bindV2(paths, fetchImpl);
    expect(boot2.status.excluded.some((e) => e.provider === 'failing')).toBe(false); // bind-time view is clean
    const r2 = await ensureReconciled(boot2.store, boot2.status, { paths, ...captureLog(), now: () => 200 });
    expect(r2).toMatchObject({ ran: false, skipped: 'already-done' });
    const stranded = boot2.status.excluded.find((e) => e.provider === 'failing');
    expect(stranded).toBeDefined();
    expect(stranded!.reasonCode).toBe('reconcile_push_failed');
    expect(stranded!.detail).toContain('persisted reconcile failure');
    // the re-append is deduped — a second call does not double the entry
    await ensureReconciled(boot2.store, boot2.status, { paths, ...captureLog(), now: () => 300 });
    expect(boot2.status.excluded.filter((e) => e.provider === 'failing')).toHaveLength(1);
  });

  it('P2-6: reconcile completion sets the IN-PROCESS gate even if the state file is lost', async () => {
    const paths = sandboxPaths();
    seedAuthJson(paths);
    // id-bearing 201 → connectKey fast path (the no-id landing path is covered
    // with the instant `sleep` seam elsewhere); keeps this gate-semantics test instant.
    const { fetchImpl } = makeFetch(() => ({ status: 201, json: { credential: { id: 'r1' } } }));
    const binding = await bindV2(paths, fetchImpl);
    const res = await ensureReconciled(binding.store, binding.status, { paths, ...captureLog(), now: () => 42 });
    expect(res.authWriteDisabled).toBe(true);
    // simulate the best-effort marker write having been lost (AV sweep, disk
    // pressure): the persisted-file read alone would re-enable auth.json
    // writes — the in-process override must keep the gate closed THIS boot.
    fs.unlinkSync(credentialStoreStateFile(paths));
    expect(isAuthJsonWriteDisabled(paths)).toBe(true);
    // a DIFFERENT machine (paths) is untouched by this boot's override
    const other = sandboxPaths();
    expect(isAuthJsonWriteDisabled(other)).toBe(false);
  });

  it('P2-1: non-loopback plaintext HTTP target — every push skipped loudly with reason insecure_remote_target', async () => {
    const paths = sandboxPaths();
    seedAuthJson(paths);
    fs.writeFileSync(
      paths.serviceJsonCandidates![0]!,
      JSON.stringify({ password: 'pw', baseUrl: 'http://stale-remote.test:9' })
    );
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200 }));
    const binding = await bindV2(paths, fetchImpl);
    const { log, lines } = captureLog();
    const res = await ensureReconciled(binding.store, binding.status, { paths, log, now: () => 60 });
    const failed = res.entries.filter((e) => e.action === 'failed');
    expect(failed.map((e) => e.provider).sort()).toEqual(['anthropic', 'failing']);
    expect(failed.every((e) => (e.reason ?? '').includes('insecure_remote_target'))).toBe(true);
    expect(calls).toHaveLength(0); // nothing left the process — no key exfiltrated to the stale URL
    expect(binding.status.excluded.map((e) => e.provider)).toEqual(['anthropic', 'failing']);
    expect(lines.some((l) => l.includes('insecure_remote_target'))).toBe(true);
  });

  it('P2-8: the not-opencode-v2 skip branches on CAPABILITIES, never on kind', async () => {
    const paths = sandboxPaths();
    // kind says 'opencode-v2' but the store is readonly-capped (writes refused): the
    // gate must skip. A capabilities-only fake proves the branch is honest.
    const readonlyCapped: CredentialStore = {
      kind: 'opencode-v2',
      capabilities: { multiAccount: true, activate: false, rename: false, oauth: false, envVisible: true },
      probe: () => ({ ok: true, kind: 'opencode-v2', state: 'ready', accountCount: 0 }),
      listAccounts: () => [],
      resolveKey: () => null,
      resolveKeyChain: () => [],
      connectKey: async () => {
        throw new Error('must not be reached');
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
      accountsOverview: () => [],
    };
    const status: StoreStatus = {
      kind: 'opencode-v2',
      capabilities: readonlyCapped.capabilities,
      degradedCode: 'cli_absent_db_present',
      evidence: { cli: null, file: null, used: 'db-present', lastKnownGood: null },
      excluded: [],
      accounts: [],
      probeResult: null,
      credentialFile: 'x.db',
      boundAt: 1,
    };
    const res = await ensureReconciled(readonlyCapped, status, { paths, ...captureLog() });
    expect(res).toMatchObject({ ran: false, skipped: 'not-opencode-v2', authWriteDisabled: false });
  });

  it('unreadable auth.json snapshot: loud excluded entry, gate still completes', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(paths.authJsonPath, '{ broken');
    const { fetchImpl } = makeFetch(() => ({ status: 201 }));
    const binding = await bindV2(paths, fetchImpl);
    const { log, lines } = captureLog();
    const res = await ensureReconciled(binding.store, binding.status, { paths, log });
    expect(res.ran).toBe(true);
    expect(res.entries).toEqual([]);
    expect(binding.status.excluded.some((e) => e.reasonCode === 'reconcile_push_failed' && e.detail.includes('auth.json snapshot unreadable'))).toBe(true);
    expect(lines.some((l) => l.includes('auth.json snapshot unreadable'))).toBe(true);
    expect(readCredentialStoreState(paths)?.reconcile?.authWriteDisabled).toBe(true);
  });

  it('hostile store: ensureReconciled never throws; crash lands as excluded entry, bind stands, marker withheld for retry', async () => {
    const paths = sandboxPaths();
    const capabilities: StoreCapabilities = { multiAccount: true, activate: true, rename: true, oauth: false, envVisible: true };
    let writeAttempted = 0;
    const hostile: CredentialStore = {
      kind: 'opencode-v2',
      capabilities,
      probe: (): StoreProbeResult => {
        throw new Error('boom-probe');
      },
      listAccounts: () => {
        throw new Error('boom-list');
      },
      resolveKey: () => {
        throw new Error('boom-resolve');
      },
      resolveKeyChain: () => {
        throw new Error('boom-chain');
      },
      connectKey: async () => ({ id: 'x', providerId: 'anthropic', type: 'api', active: true, routable: true }),
      activate: async () => {
        throw new Error('boom');
      },
      rename: async () => {
        throw new Error('boom');
      },
      disconnect: async () => {
        throw new Error('boom');
      },
      beginOAuth: async () => {
        throw new Error('boom');
      },
      completeOAuth: async () => {
        throw new Error('boom');
      },
      invalidate: () => {
        throw new Error('boom-invalidate');
      },
      accountsOverview: () => {
        throw new Error('boom-overview');
      },
    };
    const status: StoreStatus = {
      kind: 'opencode-v2',
      capabilities,
      degradedCode: null,
      evidence: { cli: 'v2.0.15', file: null, used: 'cli', lastKnownGood: null },
      excluded: [],
      accounts: [],
      probeResult: null,
      credentialFile: 'x.db',
      boundAt: 1,
    };
    const { log, lines } = captureLog();

    const res = await ensureReconciled(hostile, status, {
      paths,
      log,
      bridge: {
        read: () => ({ anthropic: { type: 'api', key: 'sk-1' } }),
        writeApiKey: () => {
          writeAttempted += 1;
          throw new Error('bridge must never write auth.json');
        },
        remove: () => {
          writeAttempted += 1;
          throw new Error('bridge must never remove from auth.json');
        },
      },
    });

    // resolved (boot-safe), crash surfaced as an excluded entry, no marker (next boot retries)
    expect(res.ran).toBe(false);
    expect(status.excluded.some((e) => e.provider === '*' && e.detail.includes('reconcile crashed'))).toBe(true);
    expect(lines.some((l) => l.includes('boom-overview'))).toBe(true); // dbIndex failure logged
    expect(writeAttempted).toBe(0); // reconcile NEVER writes auth.json
    expect(readCredentialStoreState(paths)?.reconcile).toBeUndefined();
  });

  it('reconcile against OpencodeV2Store uses only masked db reads for dedup (no raw-key oracle needed)', async () => {
    const paths = sandboxPaths();
    fs.writeFileSync(
      paths.authJsonPath,
      JSON.stringify({ anthropic: { type: 'api', key: 'sk-equal-both-sides' }, other: { type: 'api', key: 'sk-new' } })
    );
    const sameRow = {
      id: 'd1',
      integration_id: 'Anthropic', // case-insensitive provider match
      label: null,
      value: JSON.stringify({ type: 'key', key: 'sk-equal-both-sides' }),
      active: 0,
      time_created: 1,
      time_updated: 1,
    };
    const { fetchImpl, calls } = makeFetch((url) =>
      url.includes('/other/connect/key') ? { status: 201, json: { id: 'pushed-2' } } : { status: 500 }
    );
    const store = await OpencodeV2Store.create({
      paths,
      writable: true,
      fetchImpl,
      env: {},
      openDatabase: fakeDb([sameRow]),
    });
    const status: StoreStatus = {
      kind: 'opencode-v2',
      capabilities: store.capabilities,
      degradedCode: null,
      evidence: { cli: 'v2.0.15', file: null, used: 'cli', lastKnownGood: null },
      excluded: [],
      accounts: [],
      probeResult: null,
      credentialFile: 'x.db',
      boundAt: 1,
    };
    const res = await ensureReconciled(store, status, { paths, ...captureLog() });
    expect(res.entries).toEqual([
      { provider: 'anthropic', action: 'deduped' }, // matched by (provider case-insensitive × keyHash prefix)
      { provider: 'other', action: 'pushed' },
    ]);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      expect.stringContaining('/api/integration/other/connect/key'),
    ]);
    expect(keyHashPrefix('sk-equal-both-sides')).toHaveLength(12);
  });
});
