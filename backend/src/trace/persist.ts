import fs from 'node:fs';
import path from 'node:path';
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
 * Normalize a legacy persisted trace (written before the 2026-10 observability
 * rework) into the current ExecutionTrace shape: old prompt/completion field
 * names map to input/output/cached, the derived `savedCostUsd` is dropped.
 * `costUsd` (actual cost at request time) is KEPT — it is a historical fact
 * that catalog price changes make impossible to recompute. Removable once
 * every legacy row has aged past the trace retention window.
 */
function normalizeReplayedTrace(raw: any): ExecutionTrace | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw.finops;
  if (f && typeof f === 'object') {
    if (f.inputTokens === undefined && f.promptTokens !== undefined) {
      f.inputTokens = Number(f.promptTokens) || 0;
      f.outputTokens = Number(f.completionTokens) || 0;
      f.cachedTokens = Number(f.cachedPromptTokens) || 0;
      delete f.promptTokens;
      delete f.completionTokens;
      delete f.cachedPromptTokens;
    }
    delete f.savedCostUsd;
    f.costUsd = Number(f.costUsd) || 0;
  }
  return raw as ExecutionTrace;
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

export async function openTraceStore(dir: string): Promise<TraceStore | null> {
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
    db.run(`CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts)');

    return {
      insert(trace) {
        try {
          db.query('INSERT OR REPLACE INTO traces (trace_id, session_id, ts, data) VALUES (?, ?, ?, ?)').run([
            trace.traceId,
            trace.sessionId,
            trace.timestamp,
            JSON.stringify(trace),
          ]);
        } catch {
          // storage hiccup must not break the hot path
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
            db.run('DELETE FROM traces WHERE trace_id IN (SELECT trace_id FROM traces ORDER BY ts ASC LIMIT 500)');
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
  } catch {
    return null; // db open/init failed — memory-only mode
  }
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
