import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialPaths, credentialSyncFile, ocrCredentialsFile } from '../src/opencode/credentials/paths.js';
import { OcrStore } from '../src/opencode/credentials/ocr-store.js';
import { DbOpener } from '../src/opencode/credentials/opencode-v2-store.js';
import {
  initCredentialSync,
  maybeRunV2Migration,
  pullV2IntoOcr,
  pushOcrIntoV2,
  readSyncState,
  runCredentialSync,
  setSyncAutoToggle,
  stopCredentialSync,
  SyncStateFile,
} from '../src/opencode/credentials/sync.js';
import { keyHashPrefix } from '../src/opencode/credentials/types.js';

/**
 * Credential sync — the OCR file is the single truth; opencode v2 is a sync
 * client. Read (pull): v2 db → OCR file, keyHash-deduped, oauth rows never.
 * Write (push): OCR file → v2 HTTP sink, local entries ALWAYS kept. The state
 * file (credential-sync.json) records toggles, timestamps and masked outcomes.
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

function withService(p: CredentialPaths): CredentialPaths {
  fs.writeFileSync(p.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  return p;
}

describe('read sync (pull): v2 db → OCR file', () => {
  it('pulls routable api keys, skips oauth rows, dedups by keyHash on rerun', async () => {
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

    const first = await pullV2IntoOcr(ocr, { paths: p, openDatabase: db, now: () => 2 });
    expect(first.ok).toBe(true);
    expect(first.pulled).toBe(1); // anthropic only — openai deduped, zen never leaves the db
    expect(first.deduped).toBe(1);
    expect(first.entries.some((e) => e.provider === 'zen')).toBe(false);
    expect(readOcr(p).providers.anthropic[0].key).toBe('sk-pull-new');

    // rerun: everything already present → zero pulls
    const second = await pullV2IntoOcr(ocr, { paths: p, openDatabase: db, now: () => 3 });
    expect(second.pulled).toBe(0);
    expect(second.deduped).toBe(2);
  });

  it('gate failures are preconditions, never throws', async () => {
    const p = sandboxPaths(); // no db file at all
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    const absent = await pullV2IntoOcr(ocr, { paths: p });
    expect(absent).toMatchObject({ ok: false, precondition: 'db_absent' });

    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const unreadable = await pullV2IntoOcr(ocr, {
      paths: p,
      openDatabase: async () => {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      },
    });
    expect(unreadable).toMatchObject({ ok: false, precondition: 'db_unreadable' });
  });
});

describe('write sync (push): OCR file → v2 HTTP sink', () => {
  it('pushes local keys, dedups against the db, and NEVER removes local entries', async () => {
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

    const outcome = await pushOcrIntoV2(ocr, { paths: p, fetchImpl, openDatabase: db, now: () => 1 });
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

  it('empty local store: plain ok even with opencode down; unreachable service is a precondition', async () => {
    const empty = sandboxPaths(); // no service.json either
    const emptyStore = new OcrStore({ paths: empty, now: () => 1 });
    const none = await pushOcrIntoV2(emptyStore, { paths: empty });
    expect(none).toMatchObject({ ok: true, pushed: 0 });

    const p = sandboxPaths(); // local keys but NO service.json
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-orphan');
    const down = await pushOcrIntoV2(ocr, { paths: p });
    expect(down).toMatchObject({ ok: false, precondition: 'opencode_v2_service_unreachable' });
    expect(readOcr(p).providers.anthropic).toHaveLength(1); // kept
  });
});

describe('state file + runCredentialSync', () => {
  it('toggle persists; a run records timestamps and outcomes for both directions', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const ocr = new OcrStore({ paths: p, now: () => 1 });

    const afterRead = setSyncAutoToggle('read', true, { paths: p, now: () => 10 });
    expect(afterRead.autoRead).toBe(true);
    expect(afterRead.autoWrite).toBe(false);
    setSyncAutoToggle('write', true, { paths: p, now: () => 11 });
    expect(readSyncState(p).clients['opencode-v2']).toMatchObject({ autoRead: true, autoWrite: true });

    const result = await runCredentialSync('both', ocr, {
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
    setSyncAutoToggle('read', true, { paths: p });
    setSyncAutoToggle('write', true, { paths: p });

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

  it('toggles OFF mean no traffic: mutation with autoWrite off never pushes', async () => {
    const p = withService(sandboxPaths());
    fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    // both toggles off (the default)
    let pushed = 0;
    await initCredentialSync(ocr, {
      paths: p,
      fetchImpl: async (input, init) => {
        if (String(init?.method ?? 'GET') !== 'GET') pushed += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
      openDatabase: fakeDb([]),
      now: () => Date.now(),
      autoReadPollMs: 20,
      writeDebounceMs: 20,
    });
    try {
      await ocr.connectKey('anthropic', 'sk-manual-only');
      await new Promise((r) => setTimeout(r, 120)); // well past the debounce
      expect(pushed).toBe(0);
      expect(readSyncState(p).clients['opencode-v2']?.lastWrite).toBeUndefined();
    } finally {
      stopCredentialSync();
    }
  });
});
