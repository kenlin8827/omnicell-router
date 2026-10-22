/**
 * Shared coalescing event-ring skeleton used by the three observation ledgers
 * (failure-events, ratelimit event-log, quota events). One source of truth
 * for the ring capacity, the coalesce window, the message truncation bound,
 * the boot-epoch id scheme, and the upsert-then-trim durability order — the
 * domain modules keep only their event shapes and coalescing keys.
 */

/** Ring capacity (and, mirrored, the durable row budget). */
export const EVENT_RING_CAPACITY = 500;
/** Repeats of the same coalescing key inside this window fold into one row. */
export const EVENT_COALESCE_WINDOW_MS = 10_000;
/** Error/note text bound — a row is an observation, not an archive of the wire body. */
export const EVENT_MESSAGE_MAX_CHARS = 400;

let nextEventId = 0;

/**
 * Process-unique row key: boot epoch + counter — collision-free across
 * restarts. `prefix` namespaces the producer (`f-` failures, `q-` quota).
 */
export function nextRingEventId(prefix: string, now: number): string {
  return `${prefix}${now.toString(36)}-${(nextEventId++).toString(36)}`;
}

/**
 * Durable mirror of the ring. Implementations are fail-open (observability
 * writes must never break the request path).
 */
export interface RingEventStore<E> {
  /** Insert or replace the row for `ev.id` (coalesced repeats UPSERT). */
  upsert(ev: E): void;
  /** Newest `limit` events, OLDEST first (ready for ring replay). */
  loadRecent(limit: number): E[];
  /** Keep the newest `keep` rows by lastTs, delete the rest. */
  trim(keep: number): void;
  /** Delete every row — mirrors the in-memory clear (trace-store precedent). */
  clearAll(): void;
  /** Delete one row by id (single-event delete — mirrors the ring splice). */
  delete?(id: string): void;
}

/**
 * In-memory event ring with an optional durable mirror. Events are oldest
 * first; consumers reverse for display. The log stays memory-only until
 * `attachStore` wires the mirror (tests and non-bun runtimes).
 */
export class EventRing<E extends { id: string; ts: number }> {
  private events: E[] = [];
  private store: RingEventStore<E> | undefined;

  constructor(store?: RingEventStore<E>) {
    this.store = store;
  }

  /**
   * Attach the durable mirror and replay its history into the ring
   * (boot-time only, before traffic). Returns the replayed count.
   */
  attachStore(store: RingEventStore<E>): number {
    this.store = store;
    const replayed = store.loadRecent(EVENT_RING_CAPACITY);
    if (replayed.length > 0) this.events = replayed;
    return replayed.length;
  }

  /** Most recent row, or undefined when the ring is empty (coalesce check). */
  last(): E | undefined {
    return this.events[this.events.length - 1];
  }

  /** UPSERT a coalesced (count-bumped) row into the durable mirror. */
  touchCoalesced(ev: E): void {
    this.store?.upsert(ev);
  }

  /**
   * Append a fresh event: ring push, durable UPSERT, then capacity trim.
   * Trim AFTER the upsert so the fresh row is inside the kept window and
   * the durable count converges on EVENT_RING_CAPACITY (upsert-then-trim
   * order).
   */
  append(ev: E): void {
    this.events.push(ev);
    this.store?.upsert(ev);
    if (this.events.length > EVENT_RING_CAPACITY) {
      this.events.splice(0, this.events.length - EVENT_RING_CAPACITY);
      this.store?.trim(EVENT_RING_CAPACITY);
    }
  }

  /** Oldest-first snapshot (callers reverse for display). */
  rows(): E[] {
    return [...this.events];
  }

  /**
   * Remove ONE event by id — the ring row and its durable mirror row go
   * together (a coalesced ×N observation is one row and dies whole).
   * Returns true when a row was found and removed. No-op mirror-side when
   * the store has no `delete` (single-direction ledgers).
   */
  remove(id: string): boolean {
    const idx = this.events.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.events.splice(idx, 1);
    this.store?.delete?.(id);
    return true;
  }

  clear(): void {
    this.events = [];
    this.store?.clearAll();
  }
}

/** Truncate free-form log text to the shared observation bound (with ellipsis). */
export function truncateEventMessage(message: string, max: number = EVENT_MESSAGE_MAX_CHARS): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}
