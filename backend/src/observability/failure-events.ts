import fs from 'node:fs';
import path from 'node:path';

/** Ring capacity, coalesce window and message bound: shared ring skeleton. */
import {
  EventRing,
  EVENT_COALESCE_WINDOW_MS,
  EVENT_MESSAGE_MAX_CHARS,
  nextRingEventId,
  truncateEventMessage,
} from '../utils/event-ring.js';
import type { ErrorCategory } from '../resilience/types.js';

/**
 * The failure_events ledger — the "WHICH model calls failed, and WHY"
 * history that no other plane answers. The trace table records executed
 * turns only (failed rounds have no turn to record), the circuit breaker
 * keeps state but no reason/timeline, and the log tail is unaggregated raw
 * text: a chain of 429s or a dead decision layer was invisible to every one of them.
 *
 * One event per failed upstream MODEL CALL, from two emitters:
 *  - serving  — each diagnosed candidate failure inside the orchestrator's
 *               candidate pool (the classifier verdict is already in hand
 *               at that point)
 *  - decision layer    — the L2 decision layer's wire call failing or blowing its
 *               deadline (a late rejection after the deadline never
 *               double-records — the timeout already owned the observation)
 *
 * NOT recorded: calls that never left the gateway (policy-denied, empty
 * pool, breaker-skipped candidates, disabled credentials) — the ledger
 * observes CALLS, not refusals — and content-level failures (a 200 whose
 * answer cannot be parsed is the /auto last-outcome surface's concern).
 *
 * Storage mirrors the quota_events ledger exactly (precedent acknowledged,
 * code original): an in-process ring, DURABLE MIRROR in the shared
 * traces.db under its own `failure_events` table + independent bun:sqlite
 * handle (fault isolation, WAL), trimmed to the same budget on every
 * insert, replayed into the ring at boot. Fail-open everywhere: a failure
 * event must never break the request path it observes.
 *
 * Coalescing: consecutive repeats of the same model+provider+errorClass+role
 * within EVENT_COALESCE_WINDOW_MS fold into one entry with a bumped `count`
 * (a 429 storm is one observation, not 500) — the rate-limit ledger's
 * exact rule. A repeat UPSERTs the same row by `id`.
 */

export type FailureEventRole = 'serving' | 'l2-decision' | 'probe';

/**
 * `errorClass` vocabulary: the error classifier's category (the same words
 * the breaker rules and the /auto surface speak), extended by TIMEOUT for
 * the decision layer's deadline — an abandoned call has no HTTP status to classify.
 * `probe` rows (health prober) share the table for one day an emitter
 * lands there; today only serving and decision layer write.
 */
export type FailureErrorClass = ErrorCategory | 'TIMEOUT';

export interface FailureEvent {
  /** Stable row key — the UPSERT target for coalesced repeats (never a natural key). */
  id: string;
  /** First occurrence (epoch ms); `lastTs` carries the most recent coalesced one. */
  ts: number;
  lastTs: number;
  /** Repeat count within the coalescing window (1 = single occurrence). */
  count: number;
  /** Model whose call failed. */
  model: string;
  /** Provider owning the model (a model id alone can be ambiguous across providers). */
  provider: string;
  errorClass: FailureErrorClass;
  /** Upstream HTTP status when the error carried one (absent for timeouts / network tears). */
  status?: number;
  /** Raw English error text, log-grade, truncated to EVENT_MESSAGE_MAX_CHARS. */
  message: string;
  role: FailureEventRole;
  /** Conversation session the failure belongs to — the serving pool's owning
   *  turn, or (decision layer rows) the conversation whose routing the decision layer was
   *  deciding, threaded by the orchestrator. Undefined for sessionless
   *  callers (direct evaluate() invocations, probes). */
  sessionId?: string;
}

export interface FailureEventInput {
  model: string;
  provider: string;
  errorClass: FailureErrorClass;
  status?: number;
  message: string;
  role: FailureEventRole;
  sessionId?: string;
}

export interface FailureEventStore {
  /** Insert or replace the row for `ev.id` (coalesced repeats UPSERT). */
  upsert(ev: FailureEvent): void;
  /** Newest `limit` events, OLDEST first (ready for ring replay). */
  loadRecent(limit: number): FailureEvent[];
  /** Keep the newest `keep` rows by lastTs, delete the rest. */
  trim(keep: number): void;
  /** Delete one row by id (single-event delete — mirrors the ring splice). */
  delete(id: string): void;
  /** Delete every row — mirrors the in-memory clear (trace-store precedent). */
  clearAll(): void;
  close(): void;
}

export class FailureEventLog {
  private ring = new EventRing<FailureEvent>();

  /**
   * Attach the durable mirror and replay its history into the ring
   * (boot-time only, before traffic). Returns the replayed count.
   */
  attachStore(store: FailureEventStore): number {
    return this.ring.attachStore(store);
  }

  record(input: FailureEventInput, now: number = Date.now()): void {
    const last = this.ring.last();
    if (
      last &&
      last.model === input.model &&
      last.provider === input.provider &&
      last.errorClass === input.errorClass &&
      last.role === input.role &&
      now - last.lastTs <= EVENT_COALESCE_WINDOW_MS
    ) {
      last.count++;
      last.lastTs = now;
      this.ring.touchCoalesced(last);
      return;
    }
    this.ring.append({
      id: nextRingEventId('f-', now),
      ts: now,
      lastTs: now,
      count: 1,
      model: input.model,
      provider: input.provider,
      errorClass: input.errorClass,
      status: input.status,
      message: truncateEventMessage(input.message, EVENT_MESSAGE_MAX_CHARS),
      role: input.role,
      sessionId: input.sessionId,
    });
  }

  /**
   * Newest first, narrowed by the optional equality filters and capped by
   * `limit` (default all). Filtering is equality-only on purpose — the ring
   * is small enough that the console narrows client-side too; this serves
   * the REST surface its scoped view.
   */
  list(filter?: {
    model?: string;
    provider?: string;
    errorClass?: string;
    role?: string;
    limit?: number;
  }): FailureEvent[] {
    let rows = this.ring.rows().reverse();
    if (filter?.model) rows = rows.filter((e) => e.model === filter.model);
    if (filter?.provider) rows = rows.filter((e) => e.provider === filter.provider);
    if (filter?.errorClass) rows = rows.filter((e) => e.errorClass === filter.errorClass);
    if (filter?.role) rows = rows.filter((e) => e.role === filter.role);
    if (filter?.limit !== undefined && filter.limit >= 0) rows = rows.slice(0, filter.limit);
    return rows;
  }

  /**
   * Remove ONE event by id — the ring row and its durable mirror row go
   * together (a coalesced ×N observation is one row and dies whole).
   * Returns true when a row was found and removed.
   */
  remove(id: string): boolean {
    return this.ring.remove(id);
  }

  clear(): void {
    this.ring.clear();
  }
}

/**
 * Open the ledger store on the SAME on-disk file the trace/FinOps/quota/
 * ratelimit stores use (`<dir>/traces.db`) with an independent bun:sqlite
 * handle — the FinOpsStore precedent: no cross-table transactions, fault
 * isolation via separate WAL handles. Returns null (caller stays
 * memory-only) on a non-bun runtime or any open/init failure.
 */
export async function openFailureEventStore(dir: string): Promise<FailureEventStore | null> {
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
    db.run(`CREATE TABLE IF NOT EXISTS failure_events (
      id TEXT PRIMARY KEY,
      last_ts INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_failure_events_last ON failure_events(last_ts)');
  } catch {
    return null; // db open/init failed — memory-only mode
  }

  return {
    upsert(ev) {
      try {
        db.query('INSERT OR REPLACE INTO failure_events (id, last_ts, data) VALUES (?, ?, ?)').run([
          ev.id,
          ev.lastTs,
          JSON.stringify(ev),
        ]);
      } catch {
        // fail open — observability must not break the hot path
      }
    },

    loadRecent(limit) {
      try {
        const rows = db.query('SELECT data FROM failure_events ORDER BY last_ts DESC LIMIT ?').all([limit]) as {
          data: string;
        }[];
        return rows
          .map((r) => {
            try {
              const ev = JSON.parse(r.data);
              return ev &&
                typeof ev === 'object' &&
                typeof ev.id === 'string' &&
                typeof ev.lastTs === 'number' &&
                typeof ev.model === 'string' &&
                typeof ev.provider === 'string' &&
                typeof ev.errorClass === 'string' &&
                typeof ev.role === 'string'
                ? (ev as FailureEvent)
                : null;
            } catch {
              return null; // skip corrupted rows
            }
          })
          .filter((e): e is FailureEvent => e !== null)
          .reverse();
      } catch {
        return [];
      }
    },

    trim(keep) {
      try {
        db.query('DELETE FROM failure_events WHERE id NOT IN (SELECT id FROM failure_events ORDER BY last_ts DESC LIMIT ?)').run([keep]);
      } catch {
        // ignore
      }
    },

    delete(id) {
      try {
        db.query('DELETE FROM failure_events WHERE id = ?').run([id]);
      } catch {
        // ignore
      }
    },

    clearAll() {
      try {
        db.run('DELETE FROM failure_events');
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
// Same pattern as the quota/ratelimit ledgers: call sites reach the shared
// log via getFailureEventLog(); the durable store is attached ONCE at boot
// (index.ts) — never lazily here and never inside createServer, so tests and
// secondary server instances stay on the memory-only ring by construction.

let instance: FailureEventLog | undefined;

export function getFailureEventLog(): FailureEventLog {
  if (!instance) instance = new FailureEventLog();
  return instance;
}

/** Convenience for hot call sites — one line at each failure join point. */
export function recordFailureEvent(input: FailureEventInput): void {
  getFailureEventLog().record(input);
}

/** Test seam — swap in a fresh (or inspected) log. */
export function setFailureEventLogForTests(next?: FailureEventLog): FailureEventLog | undefined {
  const previous = instance;
  instance = next;
  return previous;
}
