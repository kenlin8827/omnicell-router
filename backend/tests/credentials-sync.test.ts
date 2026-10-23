import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialPaths, credentialSyncFile, ocrCredentialsFile } from '../src/opencode/credentials/paths.js';
import { OcrStore } from '../src/opencode/credentials/ocr-store.js';
import { DbOpener } from '../src/opencode/credentials/opencode-v2-store.js';
import {
  credentialSyncStatusView,
  revokeOnClient,
  shouldRetryAutoWrite,
  initCredentialSync,
  maybeRunV2Migration,
  pullIntoOcr,
  pushFromOcr,
  readSyncState,
  runCredentialSync,
  setSyncAutoToggle,
  stopCredentialSync,
  SyncStateFile,
} from '../src/opencode/credentials/sync.js';
import { keyHashPrefix } from '../src/opencode/credentials/types.js';

/**
 * Credential sync — the OCR file is the single truth; the opencode flavors are
 * sync clients (v2: opencode.db + HTTP API; v1: auth.json), both defaulting to
 * OFF. Read (pull): client -> OCR file, keyHash-deduped, oauth never crosses.
 * Write (push): OCR file -> client, local entries ALWAYS kept. The state file
 * (credential-sync.json) records toggles, timestamps and masked outcomes.
 */

const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-sync-'));
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

const keyRow = (id: string, integration: string, key: string, active = 1) => ({
  id,
  integration_id: integration,
  label: null,
  value: JSON.stringify({ type: 'key', key }),
  active,
  time_created: 1,
  time_updated: 1,
});

const oauthRow = (id: string, integration: string) => ({
  id,
  integration_id: integration,
  label: null,
  value: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 0, methodID: 'm', metadata: {} }),
  active: 1,
  time_created: 1,
  time_updated: 1,
});

function fakeDb(rows: unknown[]): DbOpener {
  return async () => ({
    query(sql: string) {
      return {
        all: () => (sql.includes('table_info') ? ALL_COLS.map((c) => ({ name: c })) : rows),
      };
    },
    close() {
      // no-op
    },
  });
}

function readOcr(p: CredentialPaths): any {
  const file = ocrCredentialsFile(p);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readAuth(p: CredentialPaths): any {
  if (!fs.existsSync(p.authJsonPath)) return null;
  return JSON.parse(fs.readFileSync(p.authJsonPath, 'utf8'));
}

function withService(p: CredentialPaths): CredentialPaths {
  fs.writeFileSync(p.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  return p;
}

/** Make a sandbox look like a v1 machine: auth.json present, NO v2 evidence. */
function v1Machine(p: CredentialPaths, auth: Record<string, unknown>): CredentialPaths {
  fs.writeFileSync(p.authJsonPath, JSON.stringify(auth, null, 2));
  return p;
}

describe('status view — both clients ship by default, toggles OFF', () => {
  it('lists opencode-v2 then opencode-v1 with disabled toggles on a bare machine', () => {
    const p = sandboxPaths();
    const view = credentialSyncStatusView({ paths: p });
    expect(view.clients.map((c) => c.id)).toEqual(['opencode-v2', 'opencode-v1']);
    for (const c of view.clients) {
      expect(c.autoRead).toBe(false);
      expect(c.autoWrite).toBe(false);
      expect(c.lastRead).toBeUndefined();
      expect(c.lastWrite).toBeUndefined();
    }
    // availability: nothing on disk → both absent
    expect(view.clients.map((c) => c.present)).toEqual([false, false]);
  });

  it('flags availability per flavor: v2 needs the db, v1 needs v1 evidence WITHOUT v2 evidence', () => {
    const v2Paths = withService(sandboxPaths());
    fs.writeFileSync(v2Paths.opencodeDbPath, 'fake-db-bytes');
    fs.writeFileSync(v2Paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-stale' } }));
    const v2View = credentialSyncStatusView({ paths: v2Paths });
    expect(v2View.clients.find((c) => c.id === 'opencode-v2')).toMatchObject({ present: true, writeReady: true });
    // the stale auth.json on a v2 machine must NOT light up the v1 client
    expect(v2View.clients.find((c) => c.id === 'opencode-v1')).toMatchObject({ present: false });

    const v1Paths = sandboxPaths();
    fs.writeFileSync(v1Paths.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-live' } }));
    const v1View = credentialSyncStatusView({ paths: v1Paths });
    expect(v1View.clients.find((c) => c.id === 'opencode-v1')).toMatchObject({ present: true, writeReady: true });
    expect(v1View.clients.find((c) => c.id === 'opencode-v2')).toMatchObject({ present: false });

    // a v1 VERSION PIN alone is v1 evidence: on a fresh v1 install auth.json
    // does not exist yet and the write direction is what creates it.
    const pinned = sandboxPaths();
    fs.mkdirSync(path.dirname(pinned.installedVersionPath), { recursive: true });
    fs.writeFileSync(pinned.installedVersionPath, '1.4.2', 'utf8');
    const pinnedView = credentialSyncStatusView({ paths: pinned });
    expect(pinnedView.clients.find((c) => c.id === 'opencode-v1')).toMatchObject({ present: true, writeReady: true });
  });
});

describe('auto-write safety net: what the periodic tick retries', () => {
  const base = { ok: true, entries: [] as never[] };
  it('retries a defs reload that did not land even though every key entry was fine', () => {
    // The keys deduped (ok=true) but the client kept the OLD provider list —
    // without this the stale defs would survive until the next OCR mutation.
    expect(shouldRetryAutoWrite({ ...base, defsChanged: true, defsReloaded: false })).toBe(true);
    expect(shouldRetryAutoWrite({ ...base, defsChanged: true, defsReloaded: true })).toBe(false);
    expect(shouldRetryAutoWrite({ ...base, defsChanged: false })).toBe(false);
  });

  it('keeps the shipped policy: no run / service down / entry failures retry; unhealable preconditions do not', () => {
    expect(shouldRetryAutoWrite(undefined)).toBe(true);
    expect(shouldRetryAutoWrite({ ...base, ok: false, precondition: 'service_unreachable' })).toBe(true);
    expect(shouldRetryAutoWrite({ ...base, ok: false })).toBe(true);
    expect(shouldRetryAutoWrite({ ...base, ok: false, precondition: 'client_absent' })).toBe(false);
    expect(shouldRetryAutoWrite({ ...base, ok: false, precondition: 'client_unreadable' })).toBe(false);
  });
});

describe('client revoke (the client half of an operator delete)', () => {
  it('deletes ONLY the matching keyHash row on v2 — never a set diff', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const target = 'sk-revoke-target';
    const other = 'sk-revoke-other';
    const calls: { url: string; method: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      calls.push({ url, method });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const out = await revokeOnClient('anthropic', keyHashPrefix(target), {
      paths: p,
      env: {},
      fetchImpl,
      now: () => 1,
      openDatabase: fakeDb([keyRow('c-target', 'anthropic', target), keyRow('c-other', 'anthropic', other)]),
    });
    expect(out).toEqual({ clientId: 'opencode-v2', result: 'deleted' });
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toContain('/api/credential/c-target');
  });

  it('reports not_found when the client holds no row for that key material', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const out = await revokeOnClient('anthropic', keyHashPrefix('sk-absent'), {
      paths: p,
      env: {},
      openDatabase: fakeDb([keyRow('c-other', 'anthropic', 'sk-different')]),
    });
    expect(out).toEqual({ clientId: 'opencode-v2', result: 'not_found' });
  });

  it('absent / v1 machines are typed, never an exception', async () => {
    const none = sandboxPaths(); // no db, no v1 evidence
    expect(await revokeOnClient('anthropic', keyHashPrefix('sk-x'), { paths: none, env: {} })).toEqual({
      clientId: 'opencode-v1',
      result: 'absent',
    });

    const v1 = sandboxPaths(); // v1 pin, no v2 db
    fs.mkdirSync(path.dirname(v1.installedVersionPath), { recursive: true });
    fs.writeFileSync(v1.installedVersionPath, '1.9.0', 'utf8');
    expect(await revokeOnClient('anthropic', keyHashPrefix('sk-x'), { paths: v1, env: {} })).toEqual({
      clientId: 'opencode-v1',
      result: 'unsupported',
    });
  });
});

describe('read sync (pull): client -> OCR file', () => {
  it('v2: pulls routable api keys, skips oauth rows, dedups by keyHash on rerun', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes'); // existence = client present
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    const db = fakeDb([
      keyRow('c1', 'anthropic', 'sk-pull-new'),
      keyRow('c2', 'openai', 'sk-pull-existing'),
      oauthRow('c3', 'zen'),
    ]);
    // pre-seed one already-present key
    await ocr.connectKey('openai', 'sk-pull-existing');

    const first = await pullIntoOcr('opencode-v2', ocr, { paths: p, openDatabase: db, now: () => 2 });
    expect(first.ok).toBe(true);
    expect(first.pulled).toBe(1); // anthropic only — openai deduped, zen never leaves the db
    expect(first.deduped).toBe(1);
    expect(first.entries.some((e) => e.provider === 'zen')).toBe(false);
    expect(readOcr(p).providers.anthropic[0].key).toBe('sk-pull-new');

    // rerun: everything already present → zero pulls
    const second = await pullIntoOcr('opencode-v2', ocr, { paths: p, openDatabase: db, now: () => 3 });
    expect(second.pulled).toBe(0);
    expect(second.deduped).toBe(2);
  });

  it('v2: gate failures are preconditions, never throws', async () => {
    const p = sandboxPaths(); // no db file at all
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    const absent = await pullIntoOcr('opencode-v2', ocr, { paths: p });
    expect(absent).toMatchObject({ ok: false, precondition: 'client_absent' });

    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const unreadable = await pullIntoOcr('opencode-v2', ocr, {
      paths: p,
      openDatabase: async () => {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      },
    });
    expect(unreadable).toMatchObject({ ok: false, precondition: 'client_unreadable' });
  });

  it('v1: pulls api entries from auth.json; oauth/wellknown never cross; malformed is loud', async () => {
    const p = v1Machine(sandboxPaths(), {
      anthropic: { type: 'api', key: 'sk-v1-pull' },
      zen: { type: 'oauth', access: 'tok', refresh: 'r', expires: 1 },
      broken: 'not-an-object',
    });
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    const outcome = await pullIntoOcr('opencode-v1', ocr, { paths: p });
    expect(outcome.ok).toBe(false); // the malformed entry is loud
    expect(outcome.pulled).toBe(1);
    expect(readOcr(p).providers.anthropic[0].key).toBe('sk-v1-pull');
    expect(outcome.entries.some((e) => e.provider === 'zen')).toBe(false); // oauth never crosses
    expect(outcome.entries.find((e) => e.provider === 'broken')?.action).toBe('failed');
  });

  it('v1: refuses to pull on a v2 machine (auth.json is a stale snapshot there)', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-stale' } }));
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    const outcome = await pullIntoOcr('opencode-v1', ocr, { paths: p });
    expect(outcome).toMatchObject({ ok: false, precondition: 'client_absent' });
    expect(readOcr(p)).toBeNull(); // nothing crossed
  });
});

describe('write sync (push): OCR file -> client', () => {
  it('v2: pushes local keys, dedups against the db, and NEVER removes local entries', async () => {
    const p = withService(sandboxPaths());
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-push-fresh');
    await ocr.connectKey('openai', 'sk-push-dup');

    const posts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (method === 'GET') {
        return new Response(JSON.stringify({ data: ['anthropic', 'openai'].map((id) => ({ id, connections: [] })) }), {
          status: 200,
        });
      }
      posts.push(url);
      return new Response(JSON.stringify({ credential: { id: 'c-new' } }), { status: 200 });
    };
    const db = fakeDb([keyRow('d1', 'openai', 'sk-push-dup')]);

    const outcome = await pushFromOcr('opencode-v2', ocr, { paths: p, fetchImpl, openDatabase: db, now: () => 1 });
    expect(outcome.ok).toBe(true);
    expect(outcome.pushed).toBe(1);
    expect(outcome.deduped).toBe(1);
    expect(outcome.pushedKeys).toEqual([
      { provider: 'anthropic', keyHashPrefix: keyHashPrefix('sk-push-fresh') },
      { provider: 'openai', keyHashPrefix: keyHashPrefix('sk-push-dup') },
    ]);
    expect(posts.some((u) => u.includes('/api/integration/anthropic/connect/key'))).toBe(true);
    expect(posts.some((u) => u.includes('/api/integration/openai'))).toBe(false);
    // THE contract: the OCR file is the truth — the push converges the CLIENT
    expect(readOcr(p).providers.anthropic).toHaveLength(1);
    expect(readOcr(p).providers.openai).toHaveLength(1);
  });

  it('v2: empty local store is plain ok even with opencode down; unreachable service is a precondition', async () => {
    const empty = sandboxPaths(); // no service.json either
    const emptyStore = new OcrStore({ paths: empty, now: () => 1 });
    const none = await pushFromOcr('opencode-v2', emptyStore, { paths: empty });
    expect(none).toMatchObject({ ok: true, pushed: 0 });

    const p = sandboxPaths(); // local keys but NO service.json
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-orphan');
    const down = await pushFromOcr('opencode-v2', ocr, { paths: p });
    expect(down).toMatchObject({ ok: false, precondition: 'service_unreachable' });
    expect(readOcr(p).providers.anthropic).toHaveLength(1); // kept
  });

  it('v1: merges the ACTIVE-head api key per provider; oauth entries preserved; one key per provider', async () => {
    const p = v1Machine(sandboxPaths(), {
      anthropic: { type: 'api', key: 'sk-v1-old' },
      zen: { type: 'oauth', access: 'tok-keep', refresh: 'r', expires: 9 },
    });
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-v1-backup'); // first key = active head
    await ocr.connectKey('anthropic', 'sk-v1-head'); // standby — must NOT win
    await ocr.connectKey('zen', 'sk-zen-api'); // provider whose auth.json entry is oauth

    const outcome = await pushFromOcr('opencode-v1', ocr, { paths: p });
    expect(outcome.ok).toBe(true);
    expect(outcome.pushed).toBe(1); // anthropic only — zen is skipped
    expect(outcome.pushedKeys).toEqual([{ provider: 'anthropic', keyHashPrefix: keyHashPrefix('sk-v1-backup') }]);
    const auth = readAuth(p);
    // the v1 shape is one api key per provider: the ACTIVE head wins
    expect(auth.anthropic).toMatchObject({ type: 'api', key: 'sk-v1-backup' });
    // the oauth entry is preserved byte-for-value
    expect(auth.zen).toMatchObject({ type: 'oauth', access: 'tok-keep' });
    expect(outcome.entries.find((e) => e.provider === 'zen')).toMatchObject({ action: 'skipped' });
    // local entries kept
    expect(readOcr(p).providers.anthropic).toHaveLength(2);
  });

  it('v1: dedups an unchanged head (no rewrite); an absent auth.json means the client is not there', async () => {
    const absent = sandboxPaths(); // no auth.json, no version pin — no v1 client footprint
    const absentStore = new OcrStore({ paths: absent, now: () => 1 });
    await absentStore.connectKey('anthropic', 'sk-v1-fresh');
    const none = await pushFromOcr('opencode-v1', absentStore, { paths: absent });
    expect(none).toMatchObject({ ok: false, precondition: 'client_absent' });
    expect(fs.existsSync(absent.authJsonPath)).toBe(false); // OCR never fabricates the artifact

    const p = v1Machine(sandboxPaths(), { anthropic: { type: 'api', key: 'sk-v1-fresh' } });
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-v1-fresh'); // same key already merged
    const second = await pushFromOcr('opencode-v1', ocr, { paths: p, now: () => 6 });
    expect(second).toMatchObject({ ok: true, pushed: 0, deduped: 1 });
    expect(second.pushedKeys).toEqual([{ provider: 'anthropic', keyHashPrefix: keyHashPrefix('sk-v1-fresh') }]);
  });

  it('v1: a fresh install (version pin 1, no auth.json yet) is seeded — the write creates the file', async () => {
    const fresh = sandboxPaths(); // v1 pin, NO auth.json
    fs.mkdirSync(path.dirname(fresh.installedVersionPath), { recursive: true });
    fs.writeFileSync(fresh.installedVersionPath, 'v1.9.0', 'utf8');
    const ocr = new OcrStore({ paths: fresh, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-v1-seed');

    const outcome = await pushFromOcr('opencode-v1', ocr, { paths: fresh });
    expect(outcome).toMatchObject({ ok: true, pushed: 1 });
    const auth = JSON.parse(fs.readFileSync(fresh.authJsonPath, 'utf8'));
    expect(auth.anthropic).toMatchObject({ type: 'api', key: 'sk-v1-seed' });
  });

  it('v1: an unreadable auth.json is refused, never clobbered; v2 machines are guarded', async () => {
    const broken = sandboxPaths();
    fs.writeFileSync(broken.authJsonPath, '{ not json');
    const ocr = new OcrStore({ paths: broken, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-x');
    const refused = await pushFromOcr('opencode-v1', ocr, { paths: broken });
    expect(refused).toMatchObject({ ok: false, precondition: 'client_unreadable' });
    expect(fs.readFileSync(broken.authJsonPath, 'utf8')).toBe('{ not json');

    const v2Paths = withService(sandboxPaths());
    fs.writeFileSync(v2Paths.opencodeDbPath, 'fake-db-bytes');
    fs.writeFileSync(v2Paths.authJsonPath, JSON.stringify({ old: { type: 'api', key: 'sk-stale' } }));
    const refused2 = await pushFromOcr('opencode-v1', ocr, { paths: v2Paths });
    expect(refused2).toMatchObject({ ok: false, precondition: 'client_absent' });
    expect(readAuth(v2Paths).old.key).toBe('sk-stale'); // untouched
  });
});

describe('state file + runCredentialSync', () => {
  it('toggle persists per client; a run records timestamps and outcomes for both directions', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const ocr = new OcrStore({ paths: p, now: () => 1 });

    const afterRead = setSyncAutoToggle('opencode-v2', 'read', true, { paths: p, now: () => 10 });
    expect(afterRead.autoRead).toBe(true);
    expect(afterRead.autoWrite).toBe(false);
    setSyncAutoToggle('opencode-v1', 'write', true, { paths: p, now: () => 11 });
    expect(readSyncState(p).clients['opencode-v2']).toMatchObject({ autoRead: true, autoWrite: false });
    expect(readSyncState(p).clients['opencode-v1']).toMatchObject({ autoRead: false, autoWrite: true });

    const result = await runCredentialSync('opencode-v2', 'both', ocr, {
      paths: p,
      openDatabase: fakeDb([keyRow('c1', 'anthropic', 'sk-run-pull')]),
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'anthropic', connections: [] }] }), { status: 200 }),
      now: () => 20,
    });
    expect(result.read?.ok).toBe(true);
    expect(result.write?.ok).toBe(true);
    const state = readSyncState(p).clients['opencode-v2'];
    expect(state.lastReadAt).toBe(20);
    expect(state.lastWriteAt).toBe(20);
    expect(state.lastRead?.pulled).toBe(1);
    // the file itself stays display-safe: no key material anywhere
    const raw = fs.readFileSync(credentialSyncFile(p), 'utf8');
    expect(raw).not.toContain('sk-run-pull');
    const parsed = JSON.parse(raw) as SyncStateFile;
    expect(parsed.version).toBe(1);
  });
});

describe('one-shot v2 migration', () => {
  it('pulls db-only keys once, records the marker, and never reruns', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    const db = fakeDb([keyRow('c1', 'anthropic', 'sk-migrate-me')]);

    await maybeRunV2Migration(ocr, { paths: p, openDatabase: db, now: () => 100 });
    expect(readOcr(p).providers.anthropic[0].key).toBe('sk-migrate-me');
    expect(readSyncState(p).migration).toMatchObject({ doneAt: 100, pulled: 1 });

    // second boot: marker present → zero work even with a different db
    fs.rmSync(ocrCredentialsFile(p));
    await maybeRunV2Migration(ocr, { paths: p, openDatabase: fakeDb([]), now: () => 200 });
    expect(readOcr(p)).toBeNull(); // nothing re-pulled
  });

  it('no db / failed pull → no marker (retried next boot)', async () => {
    const p = sandboxPaths();
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await maybeRunV2Migration(ocr, { paths: p });
    expect(readSyncState(p).migration).toBeUndefined();

    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    await maybeRunV2Migration(ocr, {
      paths: p,
      openDatabase: async () => {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      },
      now: () => 1,
    });
    expect(readSyncState(p).migration).toBeUndefined();
  });
});

describe('boot engine: auto-read poll + auto-write debounce', () => {
  it('an OCR mutation with autoWrite on triggers a debounced push; autoRead pulls periodically', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    setSyncAutoToggle('opencode-v2', 'read', true, { paths: p });
    setSyncAutoToggle('opencode-v2', 'write', true, { paths: p });

    const posts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (String(init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ data: [{ id: 'anthropic', connections: [] }] }), { status: 200 });
      }
      posts.push(url);
      return new Response(JSON.stringify({ credential: { id: 'c1' } }), { status: 200 });
    };

    await initCredentialSync(ocr, {
      paths: p,
      fetchImpl,
      openDatabase: fakeDb([keyRow('c-db', 'openai', 'sk-auto-pulled')]),
      now: () => Date.now(),
      autoReadPollMs: 20,
      writeDebounceMs: 20,
    });
    try {
      // wait one poll tick: the poll's recorded outcome proves the pull ran
      // (the one-shot migration may already have landed the key itself)
      for (let i = 0; i < 50 && !readSyncState(p).clients['opencode-v2']?.lastRead; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(readOcr(p).providers.openai[0].key).toBe('sk-auto-pulled');
      expect(readSyncState(p).clients['opencode-v2'].lastRead?.ok).toBe(true);

      // an OCR mutation → debounced auto-push (the pulled key flows to v2)
      await ocr.connectKey('anthropic', 'sk-auto-pushed');
      for (let i = 0; i < 50 && posts.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(posts.some((u) => u.includes('/api/integration/anthropic/connect/key'))).toBe(true);
      expect(readSyncState(p).clients['opencode-v2'].lastWrite?.ok).toBe(true);
    } finally {
      stopCredentialSync();
    }
  });

  it('v1 engine: the debounced write merges into auth.json; toggles OFF mean no traffic', async () => {
    const p = sandboxPaths();
    fs.writeFileSync(p.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-engine-old' } }));
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    setSyncAutoToggle('opencode-v1', 'write', true, { paths: p });

    await initCredentialSync(ocr, {
      paths: p,
      now: () => Date.now(),
      autoReadPollMs: 20,
      writeDebounceMs: 20,
    });
    try {
      await ocr.connectKey('anthropic', 'sk-engine-new');
      for (let i = 0; i < 50 && readAuth(p)?.anthropic?.key !== 'sk-engine-new'; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(readAuth(p).anthropic.key).toBe('sk-engine-new'); // head merged
      expect(readSyncState(p).clients['opencode-v1'].lastWrite?.ok).toBe(true);
    } finally {
      stopCredentialSync();
    }

    // now with every toggle off: a mutation must record NOTHING
    const quiet = sandboxPaths();
    fs.writeFileSync(quiet.authJsonPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-quiet-old' } }));
    const quietStore = new OcrStore({ paths: quiet, now: () => 1 });
    await initCredentialSync(quietStore, {
      paths: quiet,
      now: () => Date.now(),
      autoReadPollMs: 20,
      writeDebounceMs: 20,
    });
    try {
      await quietStore.connectKey('anthropic', 'sk-quiet-new');
      await new Promise((r) => setTimeout(r, 120)); // well past the debounce
      expect(readAuth(quiet).anthropic.key).toBe('sk-quiet-old'); // no write left the process
      expect(readSyncState(quiet).clients['opencode-v1']?.lastWrite).toBeUndefined();
      expect(readSyncState(quiet).clients['opencode-v2']?.lastWrite).toBeUndefined();
    } finally {
      stopCredentialSync();
    }
  });
});

/**
 * v1 adapter conformance — fixture-verified.
 *
 * No opencode v1 binary exists on the dev box, so these assertions pin what we
 * CAN prove deterministically: the file we write is shaped like the v1 file, it
 * preserves everything we do not own, and the pre-write copy is recoverable.
 * What only a real v1 runtime can settle (does it accept the merged file, does
 * Windows ignore chmod, does it route from auth.json) is listed in ADR-0006.
 */
describe('v1 adapter conformance (fixture-verified, no v1 binary required)', () => {
  it('keeps foreign providers and unknown entry fields byte-for-byte; only the head key is replaced', async () => {
    const p = v1Machine(sandboxPaths(), {
      // a provider we do not manage — must survive untouched
      'other-vendor': { type: 'api', key: 'sk-foreign', account_id: 'acct-9', future_field: { nested: true } },
      anthropic: { type: 'api', key: 'sk-stale', account_id: 'acct-1', future_field: 'keep-me' },
    });
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-fresh-head');
    const outcome = await pushFromOcr('opencode-v1', ocr, { paths: p });
    expect(outcome).toMatchObject({ ok: true, pushed: 1 });

    const auth = readAuth(p);
    expect(auth['other-vendor']).toEqual({ type: 'api', key: 'sk-foreign', account_id: 'acct-9', future_field: { nested: true } });
    // The merge overwrites type/key only: v1 fields we do not model survive.
    expect(auth.anthropic).toMatchObject({ type: 'api', key: 'sk-fresh-head', account_id: 'acct-1', future_field: 'keep-me' });
  });

  it('preserves the pre-write file as auth.json.bak.ocr before a converging write', async () => {
    const original = JSON.stringify({ anthropic: { type: 'api', key: 'sk-before' } }, null, 2);
    const p = sandboxPaths();
    fs.writeFileSync(p.authJsonPath, original);
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-after');
    await pushFromOcr('opencode-v1', ocr, { paths: p });

    expect(fs.readFileSync(`${p.authJsonPath}.bak.ocr`, 'utf8')).toBe(original); // exactly the pre-write bytes
    expect(readAuth(p).anthropic.key).toBe('sk-after');
  });

  it('writes nothing and makes no backup when every head already matches (dedupe path)', async () => {
    const p = v1Machine(sandboxPaths(), { anthropic: { type: 'api', key: 'sk-same' } });
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-same');
    const outcome = await pushFromOcr('opencode-v1', ocr, { paths: p });
    expect(outcome).toMatchObject({ ok: true, pushed: 0, deduped: 1 });
    expect(fs.existsSync(`${p.authJsonPath}.bak.ocr`)).toBe(false);
  });

  it('a fresh install (pin only) creates the file with no backup — nothing to preserve', async () => {
    const p = sandboxPaths();
    fs.mkdirSync(path.dirname(p.installedVersionPath), { recursive: true });
    fs.writeFileSync(p.installedVersionPath, '1.9.0', 'utf8');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-first');
    expect(await pushFromOcr('opencode-v1', ocr, { paths: p })).toMatchObject({ ok: true, pushed: 1 });
    expect(readAuth(p).anthropic).toMatchObject({ type: 'api', key: 'sk-first' });
    expect(fs.existsSync(`${p.authJsonPath}.bak.ocr`)).toBe(false);
  });
});
