import fs from 'node:fs';
import path from 'node:path';

/**
 * The quota_events ledger (quota-plane linkage).
 *
 * One event per inference-side QUOTA_EXHAUSTED diagnosis — the "credential hit
 * its ceiling" history that complements the probed snapshots. Events fire at
 * the breaker manager's single failure join point (credential attribution is
 * stamped there), BEFORE rule gating: the event plane is observability, the
 * trip decision is the breaker rule tree's policy, and turning quota tripping OFF must
 * not blind the ledger. Failed requests never enter the trace table (that
 * plane records executed turns only) — this table is their quota-shaped
 * counterpart.
 *
 * Storage mirrors the ratelimit ledger exactly (precedent acknowledged, code
 * original): an in-process ring, DURABLE MIRROR in the shared traces.db under
 * its own `quota_events` table + independent bun:sqlite handle (fault
 * isolation, WAL), trimmed to the same budget on every insert, replayed into
 * the ring at boot. Fail-open everywhere: a quota event must never break the
 * inference hot path.
 */

export interface QuotaEvent {
  /** Stable row key (boot epoch + counter — collision-free across restarts). */
  id: string;
  ts: number;
  providerId: string;
  /** Credential that served the burn (undefined when the error carried no
   *  attribution — chain-less providers). */
  keyHashPrefix?: string;
  /** Model whose request burned (attribution context). */
  modelId?: string;
  /** Upstream status when present (402 / provider code folded by the
   *  classifier). */
  statusCode?: number;
  /** Classifier diagnosis reason (raw English text, log-grade). */
  reason: string;
  /** Machine-readable discriminator for the console (i18n lookup, never a
   *  regex match against `reason`). */
  reasonCode: 'quota-exhausted';
}

export interface QuotaEventInput {
  providerId: string;
  keyHashPrefix?: string;
  modelId?: string;
  statusCode?: number;
  reason: string;
}

/** Ring capacity: shared ring skeleton (no coalescing on this ledger). */
import { EventRing, nextRingEventId, truncateEventMessage } from '../utils/event-ring.js';

export interface QuotaEventStore {
  upsert(ev: QuotaEvent): void;
  /** Newest `limit` events, OLDEST first (ring replay order). */
  loadRecent(limit: number): QuotaEvent[];
  trim(keep: number): void;
  clearAll(): void;
  close(): void;
}

export class QuotaEventLog {
  private ring = new EventRing<QuotaEvent>();

  /** Attach the durable mirror and replay its history into the ring. */
  attachStore(store: QuotaEventStore): number {
    return this.ring.attachStore(store);
  }

  record(input: QuotaEventInput, now: number = Date.now()): void {
    this.ring.append({
      id: nextRingEventId('q-', now),
      ts: now,
      providerId: input.providerId,
      keyHashPrefix: input.keyHashPrefix,
      modelId: input.modelId,
      statusCode: input.statusCode,
      reason: truncateEventMessage(input.reason),
      reasonCode: 'quota-exhausted',
    });
  }

  /** Newest first. */
  list(): QuotaEvent[] {
    return this.ring.rows().reverse();
  }

  clear(): void {
    this.ring.clear();
  }
}

/**
 * Open the ledger mirror on the SAME on-disk traces.db the trace/FinOps/
 * ratelimit stores use, with an independent handle (the FinOpsStore
 * precedent). Returns null (caller stays memory-only) on a non-bun runtime
 * or any open/init failure.
 */
export async function openQuotaEventStore(dir: string): Promise<QuotaEventStore | null> {
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
    db.run(`CREATE TABLE IF NOT EXISTS quota_events (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_quota_events_ts ON quota_events(ts)');
  } catch {
    return null; // db open/init failed — memory-only mode
  }

  return {
    upsert(ev) {
      try {
        db.query('INSERT OR REPLACE INTO quota_events (id, ts, data) VALUES (?, ?, ?)').run([
          ev.id,
          ev.ts,
          JSON.stringify(ev),
        ]);
      } catch {
        // fail open — observability must not break the hot path
      }
    },

    loadRecent(limit) {
      try {
        const rows = db.query('SELECT data FROM quota_events ORDER BY ts DESC LIMIT ?').all([limit]) as {
          data: string;
        }[];
        return rows
          .map((r) => {
            try {
              const ev = JSON.parse(r.data);
              return ev && typeof ev === 'object' && typeof ev.id === 'string' && typeof ev.ts === 'number'
                ? (ev as QuotaEvent)
                : null;
            } catch {
              return null; // skip corrupted rows
            }
          })
          .filter((e): e is QuotaEvent => e !== null)
          .reverse();
      } catch {
        return [];
      }
    },

    trim(keep) {
      try {
        db.query('DELETE FROM quota_events WHERE id NOT IN (SELECT id FROM quota_events ORDER BY ts DESC LIMIT ?)').run([keep]);
      } catch {
        // ignore
      }
    },

    clearAll() {
      try {
        db.run('DELETE FROM quota_events');
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

// ─── Singleton ───────────────────────────────────────────────────────────────
// Attached ONCE at boot (index.ts) — tests and secondary server instances
// stay on the memory-only ring by construction (the ratelimit-ledger rule).

let instance: QuotaEventLog | undefined;

export function getQuotaEventLog(): QuotaEventLog {
  if (!instance) instance = new QuotaEventLog();
  return instance;
}

/** Hot call sites — one line at the QUOTA diagnosis join point. */
export function recordQuotaEvent(input: QuotaEventInput): void {
  getQuotaEventLog().record(input);
}

/** Test seam. */
export function setQuotaEventLogForTests(next?: QuotaEventLog): QuotaEventLog | undefined {
  const previous = instance;
  instance = next;
  return previous;
}
