import fs from 'node:fs';
import path from 'node:path';

/**
 * Ledger of TRIGGERED rate-limit decisions — the "did a cap actually fire,
 * when, and against whom" history that complements the limiter's live
 * `snapshot()` (windows show headroom; this shows history).
 *
 * One event per engine verdict that mattered, from both directions:
 *  - inbound  `denied`         — client key hit a cap, 429 answered.
 *  - inbound  `grace-admitted` — window was full but the bounded grace wait
 *                                (rateLimit.inboundGraceMs) absorbed it; the
 *                                client never saw an error, yet the cap fired.
 *  - outbound `skipped`        — at-cap credential skipped, call went to the
 *                                next candidate (shaping worked).
 *  - outbound `forced`         — at-cap credential force-through (keep-bound
 *                                session or last candidate — the window was
 *                                overridden by policy, worth knowing).
 *  - outbound `shaped`         — chain member was capped and steered around
 *                                during spread selection (new-session shaping,
 *                                never a visible failure).
 *
 * NOT recorded: upstream (provider-side) 429s — those are the circuit
 * breaker's domain and already observable via breaker state / guardrails.
 *
 * Storage: an in-process ring capped at MAX_EVENTS, MIRRORED to SQLite
 * (`rateLimit.persist`, same traces.db file as the trace/FinOps stores but an
 * independent handle — the FinOpsStore precedent) so "what fired before the
 * restart" survives the restart. The store is the ring's durable mirror, not
 * an archive: rows are trimmed to the same MAX_EVENTS on every insert, and
 * boot replays the newest MAX_EVENTS back into the ring (index.ts wires the
 * store — the log stays memory-only until attached, which is what tests and
 * non-bun runtimes get). Fail-open everywhere: an observability write must
 * never break the request path.
 *
 * Coalescing: consecutive repeats of the SAME subject+kind+rule within
 * COALESCE_WINDOW_MS fold into one entry with a bumped `count` (a denied
 * retry storm would otherwise evict the whole history within seconds — the
 * storm is one observation, not 500). A repeat UPSERTs the same row by `id`.
 * KNOWN, ACCEPTED: a restart inside the coalesce window replays the entry,
 * so a still-running storm keeps coalescing onto the pre-restart row — the
 * episode straddles the restart as one observation, which is honest.
 */

export type RateLimitEventDirection = 'inbound' | 'outbound';

export type RateLimitEventKind =
  | 'denied'
  | 'grace-admitted'
  | 'skipped'
  | 'forced'
  | 'shaped';

export interface RateLimitEvent {
  /** Stable row key — the UPSERT target for coalesced repeats (never a natural key). */
  id: string;
  /** First occurrence (epoch ms); `lastTs` carries the most recent coalesced one. */
  ts: number;
  lastTs: number;
  /** Repeat count within the coalescing window (1 = single occurrence). */
  count: number;
  direction: RateLimitEventDirection;
  kind: RateLimitEventKind;
  /** Engine subject: `apikey:<id>` or `account:<provider>:<keyHashPrefix>`. */
  subject: string;
  /** Binding constraint display label, e.g. "1m/requests" — echoes the YAML rule. */
  rule: string;
  limitedBy: 'requests' | 'tokens' | 'costUsd';
  /** ms until the window reopens at deny/peek time (0 for grace-admitted — it waited it out). */
  retryAfterMs: number;
  /** Client key display name (inbound only). */
  apiKeyName?: string;
  /** Chain member provider (outbound only). */
  provider?: string;
  /** Chain member credential identity (outbound only). */
  keyHashPrefix?: string;
  /** Candidate model id (outbound skip/force only). */
  model?: string;
  /** Caller-policy detail, e.g. "grace wait 1005ms", "keep-bound session", "last candidate". */
  note?: string;
  /** Machine-readable discriminator for `note`, emitted at the producer — the
   *  console renders it via a code→i18n lookup and never regex-matches the
   *  English text. Absent on pre-noteCode rows replayed from the durable
   *  mirror, which fall back to the raw `note`. */
  noteCode?: RateLimitNoteCode;
  /** Params the i18n template interpolates (e.g. the grace sleep length). */
  noteParams?: { ms?: number };
}

/** Ring capacity (and, mirrored, the durable row budget). */
const MAX_EVENTS = 500;
/** Repeats of the same subject+kind+rule inside this window coalesce into one entry. */
const COALESCE_WINDOW_MS = 10_000;

let nextEventId = 0;
/** Process-unique row key: boot epoch + counter — collision-free across restarts. */
function makeEventId(now: number): string {
  return `${now.toString(36)}-${(nextEventId++).toString(36)}`;
}

/** Machine-readable discriminator for `note` — one code per producer call
 *  site. The console renders codes through its i18n table; the English `note`
 *  stays as raw log text (repo rule: the frontend never regex-matches
 *  backend-generated reason strings). */
export type RateLimitNoteCode =
  | 'grace-wait'
  | 'grace-exhausted'
  | 'keep-bound'
  | 'last-candidate'
  | 'spread'
  | 'failover';

export interface RateLimitEventInput {
  direction: RateLimitEventDirection;
  kind: RateLimitEventKind;
  subject: string;
  rule: string;
  limitedBy: RateLimitEvent['limitedBy'];
  retryAfterMs: number;
  apiKeyName?: string;
  provider?: string;
  keyHashPrefix?: string;
  model?: string;
  note?: string;
  noteCode?: RateLimitNoteCode;
  noteParams?: { ms?: number };
}

/**
 * Durable mirror of the ring. Every method is fail-open (swallows storage
 * errors): the ledger must never be able to break the request path.
 */
export interface RateLimitEventStore {
  /** Insert or replace the row for `ev.id` (coalesced repeats UPSERT). */
  upsert(ev: RateLimitEvent): void;
  /** Newest `limit` events, OLDEST first (ready for ring replay). */
  loadRecent(limit: number): RateLimitEvent[];
  /** Keep the newest `keep` rows by lastTs, delete the rest. */
  trim(keep: number): void;
  /** Delete every row — mirrors the in-memory clear (trace-store precedent). */
  clearAll(): void;
  close(): void;
}

export class RateLimitEventLog {
  /** Oldest first — `list()` reverses for display. */
  private events: RateLimitEvent[] = [];
  private store: RateLimitEventStore | undefined;

  /**
   * Attach the durable mirror and replay its history into the ring
   * (boot-time only, before traffic). Returns the replayed count.
   */
  attachStore(store: RateLimitEventStore): number {
    this.store = store;
    const replayed = store.loadRecent(MAX_EVENTS);
    if (replayed.length > 0) this.events = replayed;
    return replayed.length;
  }

  record(input: RateLimitEventInput, now: number = Date.now()): void {
    const last = this.events[this.events.length - 1];
    if (
      last &&
      last.subject === input.subject &&
      last.kind === input.kind &&
      last.rule === input.rule &&
      now - last.lastTs <= COALESCE_WINDOW_MS
    ) {
      last.count++;
      last.lastTs = now;
      last.retryAfterMs = input.retryAfterMs;
      this.store?.upsert(last);
      return;
    }
    const event: RateLimitEvent = {
      id: makeEventId(now),
      ts: now,
      lastTs: now,
      count: 1,
      direction: input.direction,
      kind: input.kind,
      subject: input.subject,
      rule: input.rule,
      limitedBy: input.limitedBy,
      retryAfterMs: input.retryAfterMs,
      apiKeyName: input.apiKeyName,
      provider: input.provider,
      keyHashPrefix: input.keyHashPrefix,
      model: input.model,
      note: input.note,
      noteCode: input.noteCode,
      noteParams: input.noteParams,
    };
    this.events.push(event);
    this.store?.upsert(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
      // Trim AFTER the upsert so the fresh row is inside the kept window and
      // the durable count converges on MAX_EVENTS (upsert-then-trim order).
      this.store?.trim(MAX_EVENTS);
    }
  }

  /** Newest first. */
  list(): RateLimitEvent[] {
    return [...this.events].reverse();
  }

  clear(): void {
    this.events = [];
    this.store?.clearAll();
  }
}

/**
 * Open the ledger store on the SAME on-disk file the trace store uses
 * (`<dir>/traces.db`) with an independent bun:sqlite handle — the
 * FinOpsStore precedent: no cross-table transactions, fault isolation via
 * separate WAL handles. Returns null (caller stays memory-only) on a non-bun
 * runtime or any open/init failure.
 */
export async function openRateLimitEventStore(dir: string): Promise<RateLimitEventStore | null> {
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
    db.run(`CREATE TABLE IF NOT EXISTS ratelimit_events (
      id TEXT PRIMARY KEY,
      last_ts INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_ratelimit_events_last ON ratelimit_events(last_ts)');
  } catch {
    return null; // db open/init failed — memory-only mode
  }

  return {
    upsert(ev) {
      try {
        db.query('INSERT OR REPLACE INTO ratelimit_events (id, last_ts, data) VALUES (?, ?, ?)').run([
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
        const rows = db.query('SELECT data FROM ratelimit_events ORDER BY last_ts DESC LIMIT ?').all([limit]) as {
          data: string;
        }[];
        return rows
          .map((r) => {
            try {
              const ev = JSON.parse(r.data);
              return ev && typeof ev === 'object' && typeof ev.id === 'string' && typeof ev.lastTs === 'number'
                ? (ev as RateLimitEvent)
                : null;
            } catch {
              return null; // skip corrupted rows
            }
          })
          .filter((e): e is RateLimitEvent => e !== null)
          .reverse();
      } catch {
        return [];
      }
    },

    trim(keep) {
      try {
        db.query('DELETE FROM ratelimit_events WHERE id NOT IN (SELECT id FROM ratelimit_events ORDER BY last_ts DESC LIMIT ?)').run([keep]);
      } catch {
        // ignore
      }
    },

    clearAll() {
      try {
        db.run('DELETE FROM ratelimit_events');
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
// Same pattern as the limiter itself: call sites reach the shared log via
// getRateLimitEventLog(); the durable store is attached ONCE at boot
// (index.ts) — never lazily here and never inside createServer, so tests and
// secondary server instances stay on the memory-only ring by construction.

let instance: RateLimitEventLog | undefined;

export function getRateLimitEventLog(): RateLimitEventLog {
  if (!instance) instance = new RateLimitEventLog();
  return instance;
}

/** Convenience for hot call sites — one line at each verdict branch. */
export function recordRateLimitEvent(input: RateLimitEventInput): void {
  getRateLimitEventLog().record(input);
}

/** Test seam — swap in a fresh (or inspected) log. */
export function setRateLimitEventLogForTests(next?: RateLimitEventLog): RateLimitEventLog | undefined {
  const previous = instance;
  instance = next;
  return previous;
}
