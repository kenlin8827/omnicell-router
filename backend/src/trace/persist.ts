import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionTrace } from './tracker.js';

/**
 * Durable store for execution traces: a single SQLite database written
 * through on every record() and replayed into the in-memory ring at boot.
 *
 * bun:sqlite is imported dynamically so a node fallback runtime (no bun
 * builtins) degrades gracefully to memory-only instead of crashing at import
 * time. Every method fails open — an observability write must never break
 * the inference hot path.
 */
/**
 * Store schema version (PRAGMA user_version). v3 = ADR-0024 write-time turn
 * identity (`turnIndex` / `isPromptStart` / `turnDecision`, `requestNumber`);
 * v2 keyed by the gateway's own `requestId`; v1 keyed by the CALLER's trace
 * id, which collapsed distinct requests of one distributed trace onto a
 * single row (ADR-0021).
 */
const DB_VERSION = 3;

/**
 * Normalize a legacy persisted trace (written before the 2026-10 observability
 * rework) into the current ExecutionTrace shape: old prompt/completion field
 * names map to input/output/cached, the derived `savedCostUsd` is dropped.
 * `costUsd` (actual cost at request time) is KEPT — it is a historical fact
 * that catalog price changes make impossible to recompute. Removable once
 * every legacy row has aged past the trace retention window.
 */
function normalizeReplayedTrace(raw: unknown): ExecutionTrace | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  // Rows written before request identity existed carry no `requestId`; the
  // migration stored them under their trace id, so replay keeps that key.
  // A row with NEITHER id is corrupt (or from a foreign writer): skip it —
  // keying it on '' would make every such row collapse onto one entry.
  if (typeof record.requestId !== 'string' || !record.requestId) {
    record.requestId = String(record.traceId ?? '');
  }
  if (!record.requestId) return null;
  const f = record.finops;
  if (f && typeof f === 'object') {
    const fin = f as Record<string, unknown>;
    if (fin.inputTokens === undefined && fin.promptTokens !== undefined) {
      fin.inputTokens = Number(fin.promptTokens) || 0;
      fin.outputTokens = Number(fin.completionTokens) || 0;
      fin.cachedTokens = Number(fin.cachedPromptTokens) || 0;
      delete fin.promptTokens;
      delete fin.completionTokens;
      delete fin.cachedPromptTokens;
    }
    delete fin.savedCostUsd;
    fin.costUsd = Number(fin.costUsd) || 0;
  }
  return record as unknown as ExecutionTrace;
}

export interface TraceStore {
  insert(trace: ExecutionTrace): void;
  /** Most recent `limit` traces, oldest first (ready for ring replay). */
  loadRecent(limit: number): ExecutionTrace[];
  deleteBySession(sessionId: string): void;
  /** Delete every trace (console "clear sessions" — must match the in-memory clear). */
  clearAll(): void;
  /** Age-based deletion, then oldest-first deletion to a total-size budget. */
  sweep(retentionMs: number, maxTotalBytes: number): void;
  close(): void;
}

async function tryOpenTraceStore(dir: string): Promise<TraceStore | null> {
  let Database: typeof import('bun:sqlite').Database;
  try {
    ({ Database } = await import('bun:sqlite'));
  } catch {
    return null; // non-bun runtime — memory-only mode
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'traces.db'), { create: true });
    db.run('PRAGMA journal_mode = WAL;');
    // The file is shared with the FinOps / failure-event / quota / ratelimit
    // stores (each with its own handle), so contend politely and keep the
    // schema switch atomic.
    db.run('PRAGMA busy_timeout = 5000;');
    const version = Number(
      (db.query('PRAGMA user_version').get() as { user_version?: number } | null)?.user_version ?? 0
    );
    // `user_version` is FILE-wide (SQLite has no per-table version): this store
    // is its sole owner — every other store on the file only runs
    // `CREATE TABLE IF NOT EXISTS` and must never touch it.
    //
    // The VERSION alone is not trusted: a file written by an intermediate
    // build can carry the v2 number with a different shape (observed in the
    // wild: `request_id` PK plus a NOT NULL `trace_id`, which makes every
    // write fail the NOT NULL constraint — silently, because writes fail
    // open). The rebuild below is therefore gated on the SHAPE as well.
    const cols = db
      .query('PRAGMA table_info(traces)')
      .all() as { name: string; pk: number }[];
    const byName = new Map(cols.map(c => [c.name, c]));
    const shapeIsV2 =
      cols.length === 4 &&
      byName.get('request_id')?.pk === 1 &&
      ['request_id', 'session_id', 'ts', 'data'].every(c => byName.has(c));
    if (version > DB_VERSION) {
      // A newer build already migrated this file. Forward-compat: read it as
      // it is, do not attempt a down-migration (the columns we need — data is
      // a JSON blob — are stable across versions).
    } else if (!shapeIsV2) {
      // v1 keyed records by the CALLER's trace id (PK trace_id), so a client
      // reusing one traceparent collapsed distinct requests onto one row
      // (ADR-0021). v2 keys on the gateway request id and has no trace-id
      // column at all. SQLite cannot drop a PRIMARY KEY column, hence the
      // rebuild; the whole switch runs in ONE transaction so a crash can
      // never strand half a table (a killed process leaves user_version
      // untouched and re-runs).
      //
      // Key precedence: a row that already carries a gateway `request_id`
      // keeps it (an intermediate build may have written one); only rows
      // that have none fall back to the caller value — the same value replay
      // normalization would derive.
      const migrate = db.transaction(() => {
        const hasRequestId = byName.has('request_id');
        const hasTraceId = byName.has('trace_id');
        const keyExpr =
          hasRequestId && hasTraceId
            ? "CASE WHEN request_id IS NOT NULL AND request_id <> '' THEN request_id ELSE trace_id END"
            : hasRequestId
              ? 'request_id'
              : hasTraceId
                ? 'trace_id'
                : '';
        db.run('DROP TABLE IF EXISTS traces_v2');
        db.run(`CREATE TABLE traces_v2 (
          request_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          data TEXT NOT NULL
        )`);
        if (
          keyExpr &&
          ['session_id', 'ts', 'data'].every(c => byName.has(c))
        ) {
          db.run(`INSERT OR IGNORE INTO traces_v2 (request_id, session_id, ts, data)
                  SELECT ${keyExpr}, session_id, ts, data FROM traces`);
        }
        db.run('DROP TABLE IF EXISTS traces');
        db.run('ALTER TABLE traces_v2 RENAME TO traces');
        db.run(`PRAGMA user_version = ${DB_VERSION}`);
      });
      migrate();
    }

    // v3 (ADR-0024): one-shot normalization of stored trace blobs. The old
    // `turnNumber` is renamed to `requestNumber`, and every row is stamped
    // with an explicit write-time turn identity. Before this build the only
    // boundary signal was `request.userPromptSummary` (blanked on tool-result
    // continuations), so the migration replays it into the structured fields
    // ONCE. Runtime readers stay strictly single-shaped: no dual-field
    // fallback and no text heuristic on the hot path.
    if (version < 3) {
      db.run(`UPDATE traces SET data = REPLACE(data, '"turnNumber":', '"requestNumber":')
              WHERE data LIKE '%"turnNumber":%'`);
      const rows = db
        .query('SELECT request_id, session_id, data FROM traces ORDER BY ts ASC, request_id ASC')
        .all() as { request_id: string; session_id: string; data: string }[];
      const update = db.query('UPDATE traces SET data = ? WHERE request_id = ?');
      const highWater = new Map<string, number>();
      db.transaction(() => {
        for (const row of rows) {
          let trace: Record<string, any>;
          try {
            trace = JSON.parse(row.data);
          } catch {
            continue;
          }
          if (!trace || typeof trace !== 'object' || trace.turnIndex !== undefined) continue;
          const isPromptStart = Boolean(trace.request?.userPromptSummary);
          const key = String(trace.sessionId ?? row.session_id ?? '');
          const next = (highWater.get(key) ?? 0) + (isPromptStart ? 1 : 0);
          highWater.set(key, next);
          trace.turnIndex = next > 0 ? next : null;
          trace.isPromptStart = isPromptStart;
          trace.turnDecision = isPromptStart
            ? 'new_prompt'
            : next > 0 ? 'continuation' : 'no_prompt';
          update.run([JSON.stringify(trace), row.request_id]);
        }
        db.run('PRAGMA user_version = 3');
      })();
    }
    db.run('CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts)');

    // A storage failure must stay off the hot path, but it must not be
    // INVISIBLE either: a schema drift used to turn every write into a silent
    // no-op. One warning per process makes that state visible.
    let insertWarned = false;
    return {
      insert(trace) {
        try {
          db.query('INSERT OR REPLACE INTO traces (request_id, session_id, ts, data) VALUES (?, ?, ?, ?)').run([
            trace.requestId,
            trace.sessionId,
            trace.timestamp,
            JSON.stringify(trace),
          ]);
        } catch (err) {
          // storage hiccup must not break the hot path
          if (!insertWarned) {
            insertWarned = true;
            console.warn('[trace] persist write failed — traces are NOT being stored:', err);
          }
        }
      },

      loadRecent(limit) {
        try {
          const rows = db.query('SELECT data FROM traces ORDER BY ts DESC LIMIT ?').all([limit]) as {
            data: string;
          }[];
          return rows
            .map(r => {
              try {
                return normalizeReplayedTrace(JSON.parse(r.data));
              } catch {
                return null; // skip corrupted lines
              }
            })
            .filter((t): t is ExecutionTrace => t !== null)
            .reverse();
        } catch {
          return [];
        }
      },

      deleteBySession(sessionId) {
        try {
          db.query('DELETE FROM traces WHERE session_id = ?').run([sessionId]);
        } catch {
          // ignore
        }
      },

      clearAll() {
        try {
          db.query('DELETE FROM traces').run();
        } catch {
          // ignore
        }
      },

      sweep(retentionMs, maxTotalBytes) {
        try {
          db.query('DELETE FROM traces WHERE ts < ?').run([Date.now() - retentionMs]);
          // Size budget: drop the oldest rows in batches until the payload fits.
          for (let i = 0; i < 200; i++) {
            const row = db.query('SELECT SUM(LENGTH(data)) AS bytes FROM traces').get() as { bytes: number | null };
            if (!row?.bytes || row.bytes <= maxTotalBytes) break;
            db.run('DELETE FROM traces WHERE request_id IN (SELECT request_id FROM traces ORDER BY ts ASC LIMIT 500)');
          }
        } catch {
          // ignore
        }
      },

      close() {
        try {
          db.close();
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    // Logged, never silent: a failed open (lock contention during the
    // v1→v2 rebuild, corrupt file, permissions) degrades the store to
    // memory-only, and that state must be visible — otherwise "traces
    // stopped persisting" looks exactly like "no traffic".
    console.warn('[trace] store open failed:', err);
    return null;
  }
}

/**
 * Open the durable trace store, retrying ONCE. The first attempt can lose a
 * lock race with the OUTGOING process during a hot restart (the schema
 * rebuild needs the write lock; `busy_timeout` absorbs 5s of contention).
 */
export async function openTraceStore(dir: string): Promise<TraceStore | null> {
  const first = await tryOpenTraceStore(dir);
  if (first) return first;
  await delay(1000);
  return tryOpenTraceStore(dir);
}

/**
 * Open the FinOps cumulative-totals store on the SAME on-disk file the
 * trace store uses (`<dir>/traces.db`) but with an independent `bun:sqlite`
 * handle. The two stores never need cross-table transactions — the trace
 * store only writes the `traces` table and the FinOps store only writes
 * `finops_totals` / `finops_meta` — so separate handles give us fault
 * isolation (one handle's WAL contention can never block the other) and
 * let the trace store's `db` stay a private implementation detail.
 *
 * Schema (idempotent CREATE):
 *   finops_totals(key TEXT PK, value REAL) — only 2 rows: totalRequests,
 *                                            fallbackCount (cumulative
 *                                            counters that must survive
 *                                            restart; per-request tier /
 *                                            token / cost / latency
 *                                            numbers stay in process
 *                                            memory and reset to zero
 *                                            on restart)
 *   finops_meta(key TEXT PK, value TEXT)   — since / lastWriteTs
 *
 * The store is fail-open: every write is in a try/catch and an SQLite
 * error must never break the inference hot path. Hydration reports back
 * the snapshot so the caller can mark `getStats().persistence.persistent`
 * accurately for the console UI.
 */
export interface FinOpsStore {
  /** Load the current totals snapshot (returns {} when the table is empty). */
  hydrate(): { totals: Record<string, number>; meta: { since: number; lastWriteTs: number | null } };
  /**
   * Increment totalRequests by 1; if `fallback` is true also increment
   * fallbackCount by 1. Always bumps `lastWriteTs` to `ts`. One UPSERT
   * pair + one meta UPDATE, all in a single transaction.
   */
  bumpRequestCount(fallback: boolean, ts: number): void;
  /** Clear all counters; reset `since` to now; remove `lastWriteTs`. */
  reset(now: number): void;
  close(): void;
}

export async function openFinOpsStore(dir: string): Promise<FinOpsStore | null> {
  let Database: typeof import('bun:sqlite').Database;
  try {
    ({ Database } = await import('bun:sqlite'));
  } catch {
    return null; // non-bun runtime — caller falls back to memory-only mode
  }

  let db: import('bun:sqlite').Database;
  try {
    fs.mkdirSync(dir, { recursive: true });
    db = new Database(path.join(dir, 'traces.db'), { create: true });
    db.run('PRAGMA journal_mode = WAL;');
    db.run(`CREATE TABLE IF NOT EXISTS finops_totals (
      key TEXT PRIMARY KEY,
      value REAL NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS finops_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  } catch {
    return null; // db open/init failed — caller falls back to memory-only mode
  }

  return {
    hydrate() {
      const totals: Record<string, number> = {};
      try {
        const rows = db
          .query('SELECT key, value FROM finops_totals')
          .all() as { key: string; value: number }[];
        for (const r of rows) totals[r.key] = r.value;
      } catch {
        // ignore — start from zero
      }
      const meta = { since: 0, lastWriteTs: null as number | null };
      try {
        const rows = db
          .query("SELECT key, value FROM finops_meta WHERE key IN ('since','lastWriteTs')")
          .all() as { key: string; value: string }[];
        for (const r of rows) {
          const n = Number(r.value);
          if (r.key === 'since') meta.since = Number.isFinite(n) ? n : 0;
          else if (r.key === 'lastWriteTs') meta.lastWriteTs = Number.isFinite(n) ? n : null;
        }
      } catch {
        // ignore
      }
      // First-boot marker: if `since` is missing (fresh install or a
      // previous run never wrote it), write one now so the value is
      // stable across subsequent `record()` calls. INSERT OR IGNORE is
      // safe — if `since` already exists we leave it alone. This means
      // the very first `record()` of a fresh gateway seeds `since` to
      // roughly the construction time, which is what the console
      // surfaces as the "accumulated since X" banner.
      if (meta.since === 0) {
        const now = Date.now();
        try {
          db.query(
            'INSERT OR IGNORE INTO finops_meta(key,value) VALUES(?, ?)'
          ).run(['since', String(now)]);
          meta.since = now;
        } catch {
          // ignore — caller will fall back to in-memory construction time
        }
      }
      return { totals, meta };
    },

    bumpRequestCount(fallback, ts) {
      try {
        const txn = db.transaction(() => {
          // totalRequests — always +1
          db.query(
            'INSERT INTO finops_totals(key, value) VALUES(?, 1) ' +
              'ON CONFLICT(key) DO UPDATE SET value = value + 1'
          ).run(['totalRequests']);
          // fallbackCount — +1 only when this request fell back
          if (fallback) {
            db.query(
              'INSERT INTO finops_totals(key, value) VALUES(?, 1) ' +
                'ON CONFLICT(key) DO UPDATE SET value = value + 1'
            ).run(['fallbackCount']);
          }
          // lastWriteTs — bump to the current wall clock
          db.query(
            'INSERT INTO finops_meta(key,value) VALUES(?,?) ' +
              'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
          ).run(['lastWriteTs', String(ts)]);
        });
        txn();
      } catch {
        // fail open — observability must not break the hot path
      }
    },

    reset(now) {
      try {
        const txn = db.transaction(() => {
          db.run('DELETE FROM finops_totals');
          db.run('DELETE FROM finops_meta WHERE key = ?', ['lastWriteTs']);
          db.query(
            'INSERT INTO finops_meta(key,value) VALUES(?,?) ' +
              'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
          ).run(['since', String(now)]);
        });
        txn();
      } catch {
        // ignore
      }
    },

    close() {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}
