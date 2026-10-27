import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable checkpoint store for the rate limiter's sliding windows.
 *
 * One row per window key (`subject|windowMs|countable`), data = JSON array of
 * `[wallClockTs, amount]` pairs covering the window's LIVE events only. The
 * limiter checkpoints periodically and on graceful shutdown; boot replays the
 * rows back into the engine (rebased onto the new process's timebase), so a
 * `1d` cost budget survives a restart instead of resetting — the restart
 * reset the uncheckpointed engine suffered is retired.
 *
 * Storage: the SAME traces.db file the trace/FinOps/ratelimit-event stores use,
 * an independent bun:sqlite handle — the FinOpsStore precedent (no cross-table
 * transactions, fault isolation via separate WAL handles). Fail-open
 * everywhere: a checkpoint write must never break the request path, and a
 * replay failure must never break boot.
 */

export interface RateLimitWindowStore {
  /** Upsert the checkpoint row for one window key. */
  save(key: string, data: string): void;
  /** Every stored row (any order — the engine filters by live constraints). */
  loadAll(): { key: string; data: string }[];
  /** Delete rows whose key is NOT in `keepKeys` (post-reload garbage collection). */
  deleteStale(keepKeys: string[]): void;
  close(): void;
}

/**
 * Open the window-checkpoint store on `<dir>/traces.db` (independent handle).
 * Returns null (caller stays memory-only) on a non-bun runtime or any
 * open/init failure.
 */
export async function openRateLimitWindowStore(dir: string): Promise<RateLimitWindowStore | null> {
  let Database: typeof import('bun:sqlite').Database;
  try {
    ({ Database } = await import('bun:sqlite'));
  } catch {
    return null; // non-bun runtime — memory-only mode
  }

  let db: import('bun:sqlite').Database;
  try {
    fs.mkdirSync(dir, { recursive: true });
    db = new Database(path.join(dir, 'traces.db'), { create: true });
    db.run('PRAGMA journal_mode = WAL;');
    db.run(`CREATE TABLE IF NOT EXISTS ratelimit_windows (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )`);
  } catch {
    return null; // db open/init failed — memory-only mode
  }

  return {
    save(key, data) {
      try {
        db.query('INSERT OR REPLACE INTO ratelimit_windows (key, data) VALUES (?, ?)').run([key, data]);
      } catch {
        // fail open — a lost checkpoint only widens the post-restart under-count
      }
    },

    loadAll() {
      try {
        const rows = db.query('SELECT key, data FROM ratelimit_windows').all() as { key: string; data: string }[];
        return rows.filter((r) => typeof r.key === 'string' && typeof r.data === 'string');
      } catch {
        return [];
      }
    },

    deleteStale(keepKeys) {
      try {
        const all = db.query('SELECT key FROM ratelimit_windows').all() as { key: string }[];
        const keep = new Set(keepKeys);
        const del = db.query('DELETE FROM ratelimit_windows WHERE key = ?');
        for (const { key } of all) {
          if (!keep.has(key)) del.run([key]);
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
}
