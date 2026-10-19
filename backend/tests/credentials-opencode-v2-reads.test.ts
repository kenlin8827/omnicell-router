import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialPaths } from '../src/opencode/credentials/paths.js';
import { DbOpener, OpencodeV2Store } from '../src/opencode/credentials/opencode-v2-store.js';
import {
  EmptyCredentialTableError,
  StoreUnreadableError,
  keyHashPrefix,
} from '../src/opencode/credentials/types.js';

/**
 * Fake sqlite db fixtures in tmpdir (finops-tracker.test.ts:43-48 precedent):
 * dynamic-import bun:sqlite and skip gracefully on non-bun runtimes.
 */

const COLUMNS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

interface CredRow {
  id: string;
  integration_id: string;
  label: string | null;
  value: string;
  active: number;
  time_created: number;
  time_updated: number;
}

const keyRow = (
  id: string,
  integration: string,
  key: string,
  opts: { active?: number; updated?: number; label?: string | null } = {}
): CredRow => ({
  id,
  integration_id: integration,
  label: opts.label ?? null,
  value: JSON.stringify({ type: 'key', key }),
  active: opts.active ?? 0,
  time_created: 1,
  time_updated: opts.updated ?? 1,
});

const oauthRow = (id: string, integration: string): CredRow => ({
  id,
  integration_id: integration,
  label: null,
  value: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 0, methodID: 'm', metadata: {} }),
  active: 1,
  time_created: 1,
  time_updated: 9,
});

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cred-v2-'));
  return {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  };
}

async function makeDb(file: string, rows: CredRow[], options: { columns?: string[] } = {}): Promise<void> {
  const { Database } = await import('bun:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  const cols = (options.columns ?? COLUMNS)
    .map((c) => (c === 'active' || c.startsWith('time_') ? `${c} INTEGER` : `${c} TEXT`))
    .join(', ');
  db.run(`CREATE TABLE credential (${cols})`);
  const present = options.columns ?? COLUMNS;
  const insertCols = COLUMNS.filter((c) => present.includes(c));
  const stmt = db.query(
    `INSERT INTO credential (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`
  );
  for (const r of rows) {
    stmt.run(insertCols.map((c) => (r as unknown as Record<string, unknown>)[c]));
  }
  db.close();
}

/** Real opener that counts credential reloads — the TTL evidence source. */
function spyOpener(counter: { loads: number }): DbOpener {
  return async (file: string) => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(file, { readonly: true, create: false });
    db.run('PRAGMA busy_timeout = 100');
    return {
      query: (sql: string) => ({
        all: (params?: unknown[]) => {
          if (/FROM credential/.test(sql)) counter.loads += 1;
          return db.query(sql).all(params ?? []);
        },
      }),
      close: () => db.close(),
    };
  };
}

describe('OpencodeV2Store reads (fake sqlite fixtures)', () => {
  it('maps value JSON variants: key rows route, oauth/unknown listed-never-routed', async () => {
    const paths = sandboxPaths();
    await makeDb(paths.opencodeDbPath, [
      keyRow('c1', 'anthropic', 'sk-active-key-123', { active: 1, updated: 100 }),
      keyRow('c2', 'anthropic', 'sk-newer-key-456', { active: 0, updated: 200, label: 'work' }),
      keyRow('c3', 'anthropic', 'sk-older-key-789', { active: 0, updated: 50 }),
      oauthRow('c4', 'zen'),
      keyRow('c5', 'sole', 'sk-sole-inactive', { active: 0, updated: 7 }),
      { ...keyRow('c6', 'broken', 'sk-nope'), value: '{"type":"key"}' }, // key-type without key string
    ]);
    const loads = { loads: 0 };
    const store = await OpencodeV2Store.create({ paths, writable: true, openDatabase: spyOpener(loads), env: {} });
    expect(store.kind).toBe('opencode-v2');

    // selection order over routable rows: active first (even if not newest)
    expect(store.resolveKey('anthropic')?.key).toBe('sk-active-key-123');
    // failover chain: active first, then newest time_updated
    expect(store.resolveKeyChain('anthropic').map((r) => r.key)).toEqual([
      'sk-active-key-123',
      'sk-newer-key-456',
      'sk-older-key-789',
    ]);
    // sole row rule: single inactive row still routes
    expect(store.resolveKey('sole')?.key).toBe('sk-sole-inactive');
    // oauth + malformed variants: listed, badged, never routed
    expect(store.resolveKey('zen')).toBeNull();
    expect(store.resolveKey('broken')).toBeNull();
    expect(store.listCredentials('zen')[0]).toMatchObject({ type: 'oauth', routable: false, active: true });
    expect(store.listCredentials('broken')[0]?.type).toBe('unknown');

    // masked surfaces — no raw secret leaves listCredentials
    const dumped = JSON.stringify(store.listCredentials('anthropic'));
    expect(dumped).not.toContain('sk-active-key-123');
    const metas = store.listCredentials('anthropic');
    expect(metas[0]!.keyHashPrefix).toBe(keyHashPrefix('sk-active-key-123'));
    expect(metas[1]!.label).toBe('work');

    expect(store.credentialsOverview()).toHaveLength(4); // anthropic, zen, sole, broken
    expect(store.credentialsOverview().find((o) => o.providerId === 'zen')).toMatchObject({ total: 1, routable: 0 });
  });

  it('newest time_updated wins when no row is active', async () => {
    const paths = sandboxPaths();
    await makeDb(paths.opencodeDbPath, [
      keyRow('c1', 'multi', 'sk-old', { updated: 1000 }),
      keyRow('c2', 'multi', 'sk-new', { updated: 2000 }),
    ]);
    const store = await OpencodeV2Store.create({ paths, env: {} });
    expect(store.resolveKey('multi')?.key).toBe('sk-new');
  });

  it('"table exists but zero rows" is EmptyCredentialTableError, distinct from unreadable', async () => {
    const paths = sandboxPaths();
    await makeDb(paths.opencodeDbPath, []);
    const store = await OpencodeV2Store.create({ paths, env: {} });
    expect(store.listCredentials('anthropic')).toEqual([]);
    let err: unknown;
    try {
      store.probe();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmptyCredentialTableError);
  });

  it('missing/renamed column is a loud schema bind failure, never a partial read', async () => {
    const paths = sandboxPaths();
    await makeDb(paths.opencodeDbPath, [keyRow('c1', 'x', 'sk-1')], {
      columns: ['id', 'integration_id', 'label', 'value', 'time_created', 'time_updated'], // no 'active'
    });
    let err: unknown;
    try {
      await OpencodeV2Store.create({ paths, env: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreUnreadableError);
    expect((err as StoreUnreadableError).reason).toBe('schema_mismatch');
    expect((err as Error).message).toContain('active');
  });

  it('credential table absent -> schema_mismatch; db missing -> cannot_open (no retry spin)', async () => {
    const paths = sandboxPaths();
    const { Database } = await import('bun:sqlite');
    fs.mkdirSync(path.dirname(paths.opencodeDbPath), { recursive: true });
    const db = new Database(paths.opencodeDbPath, { create: true });
    db.run('CREATE TABLE unrelated (id TEXT)');
    db.close();
    let err: unknown;
    try {
      await OpencodeV2Store.create({ paths, env: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreUnreadableError);
    expect((err as StoreUnreadableError).reason).toBe('schema_mismatch');

    // default real opener against a db file that does not exist -> cannot_open
    const p2 = sandboxPaths();
    let err2: unknown;
    try {
      await OpencodeV2Store.create({ paths: p2, env: {} });
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeInstanceOf(StoreUnreadableError);
    expect((err2 as StoreUnreadableError).reason).toBe('cannot_open');
  });

  it('SQLITE_BUSY / -shm contention is retried, not misclassified as unreadable (no false red badge)', async () => {
    const paths = sandboxPaths();
    await makeDb(paths.opencodeDbPath, [keyRow('c1', 'x', 'sk-1', { active: 1 })]);
    const loads = { loads: 0 };
    const real = spyOpener(loads);
    let opens = 0;
    const flaky: DbOpener = async (file) => {
      opens += 1;
      if (opens <= 2) throw new Error('SQLITE_BUSY: database is locked');
      return real(file);
    };
    const store = await OpencodeV2Store.create({
      paths,
      openDatabase: flaky,
      busyAttempts: 4,
      busyBackoffMs: 0,
      env: {},
    });
    expect(opens).toBe(3);
    expect(store.kind).toBe('opencode-v2');
    expect(store.resolveKey('x')?.key).toBe('sk-1');
  });

  it('non-busy open errors fail fast without retry loops', async () => {
    const paths = sandboxPaths();
    let opens = 0;
    let err: unknown;
    try {
      await OpencodeV2Store.create({
        paths,
        openDatabase: async () => {
          opens += 1;
          throw new Error('SomeError: not a database');
        },
        busyAttempts: 4,
        busyBackoffMs: 0,
        env: {},
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreUnreadableError);
    expect((err as StoreUnreadableError).reason).toBe('cannot_open');
    expect(opens).toBe(1);
  });

  it('60s view TTL + invalidate() force the next read to re-query', async () => {
    const paths = sandboxPaths();
    await makeDb(paths.opencodeDbPath, [keyRow('c1', 'x', 'sk-1', { active: 1 })]);
    let t = 1_000_000;
    const loads = { loads: 0 };
    const store = await OpencodeV2Store.create({
      paths,
      openDatabase: spyOpener(loads),
      now: () => t,
      env: {},
    });
    expect(loads.loads).toBe(1); // initial load at create
    store.listCredentials('x');
    expect(loads.loads).toBe(1); // cached within TTL
    t += 59_000;
    store.listCredentials('x');
    expect(loads.loads).toBe(1);
    t += 2_000; // beyond the 60s TTL
    store.listCredentials('x');
    expect(loads.loads).toBe(2);
    store.invalidate();
    store.listCredentials('x');
    expect(loads.loads).toBe(3);
    store.close();
  });
});

/**
 * Security P2-2 — value-shape assertions: a column whose VALUE drifted
 * (TEXT 'true' in active, garbage time_updated) is a LOUD schema_mismatch
 * (surfaces as the db_unreadable badge), never a silently-wrong key pick.
 * Rows are injected raw (bypassing the real-sqlite fixture) because the
 * drift shape cannot be produced through the typed insert helper.
 */
describe('OpencodeV2Store value-shape assertions (security P2-2)', () => {
  const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];
  const rawDb = (rows: unknown[]): DbOpener => async () => ({
    query(sql: string) {
      return { all: () => (sql.includes('table_info') ? ALL_COLS.map((c) => ({ name: c })) : rows) };
    },
    close() {
      // no-op
    },
  });
  const baseRow = {
    id: 'c1',
    integration_id: 'anthropic',
    label: null,
    value: JSON.stringify({ type: 'key', key: 'sk-shape' }),
    time_created: 1,
  };

  it("TEXT 'true' active fails the whole read as schema_mismatch — never a silent false-active", async () => {
    const paths = sandboxPaths();
    let err: unknown;
    try {
      await OpencodeV2Store.create({ paths, env: {}, openDatabase: rawDb([{ ...baseRow, active: 'true', time_updated: 5 }]) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreUnreadableError);
    expect((err as StoreUnreadableError).reason).toBe('schema_mismatch');
    expect((err as Error).message).toContain('active');
  });

  it('active=2 (out of the 0/1 domain) fails loudly too', async () => {
    const paths = sandboxPaths();
    await expect(
      OpencodeV2Store.create({ paths, env: {}, openDatabase: rawDb([{ ...baseRow, active: 2, time_updated: 5 }]) })
    ).rejects.toBeInstanceOf(StoreUnreadableError);
  });

  it('non-integer time_updated fails loudly; numeric TEXT time_updated still parses (affinity drift tolerated)', async () => {
    const bad = sandboxPaths();
    let err: unknown;
    try {
      await OpencodeV2Store.create({
        paths: bad,
        env: {},
        openDatabase: rawDb([{ ...baseRow, active: 1, time_updated: 'soon' }]),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreUnreadableError);
    expect((err as Error).message).toContain('time_updated');

    const ok = sandboxPaths();
    const store = await OpencodeV2Store.create({
      paths: ok,
      env: {},
      openDatabase: rawDb([{ ...baseRow, active: '1', time_updated: '42' }]),
    });
    expect(store.listCredentials('anthropic')[0]).toMatchObject({ active: true, routable: true });
  });
});
