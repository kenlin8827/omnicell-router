/**
 * Latency presentation shared by the node table and the URL probe.
 *
 * A failed delay test is NOT a measurement. mihomo reports a dead node as
 * delay 0, a controller timeout surfaces as 504, and a batch simply omits the
 * member — none of those may render as "0 ms" or borrow the colour and the
 * sort position of a real number. Every row is therefore classified before it
 * is formatted, and a sentinel is a STATE, never a value.
 *
 * Grading and rank order follow Clash Verge: < 250 ms / < 400 ms / slower, and
 * sentinels sort below every measurement instead of comparing as numbers.
 */
export const DELAY_FAST_MS = 250;
export const DELAY_FAIR_MS = 400;

export type DelayState = 'untested' | 'testing' | 'timeout' | 'error' | 'measured';

export interface DelayReading {
  state: DelayState;
  /** Present only for `measured`. */
  ms?: number;
  /** Epoch ms of this reading; 0 = carried in by the core snapshot, not measured here. */
  at: number;
}

/** Idle state for a row nothing is known about. */
export const UNTESTED_DELAY: DelayReading = { state: 'untested', at: 0 };

const RANK: Record<DelayState, number> = {
  measured: 0,
  timeout: 1,
  error: 2,
  testing: 3,
  untested: 4,
};

/** Colour for a reading: only a real measurement is graded. */
export function delayColor(reading: DelayReading): string {
  if (reading.state === 'testing' || reading.state === 'untested') return 'var(--text-dim)';
  if (reading.state !== 'measured') return 'var(--accent-rose)';
  const ms = reading.ms ?? 0;
  if (ms < DELAY_FAST_MS) return 'var(--accent-emerald)';
  if (ms < DELAY_FAIR_MS) return 'var(--accent)';
  return 'var(--accent-amber)';
}

/**
 * Sort weight: measurements first, then timeouts, errors, in-flight tests and
 * untested rows. A sentinel is a state, not a number, so it can never outrank
 * a real 900 ms reading — including in descending order.
 */
export function delayRank(state: DelayState): number {
  return RANK[state];
}

/**
 * Console-run readings expire like Clash Verge's delay cache: after 30 minutes
 * the number no longer describes the node, so it must not keep a cell filled.
 */
export const DELAY_READING_TTL_MS = 30 * 60_000;

/** Drop expired readings; returns the same object when nothing aged out. */
export function pruneReadings(readings: Record<string, DelayReading>, now = Date.now()): Record<string, DelayReading> {
  let dropped = 0;
  const next: Record<string, DelayReading> = {};
  for (const [name, reading] of Object.entries(readings)) {
    if (reading.state === 'testing' || reading.at === 0 || now - reading.at < DELAY_READING_TTL_MS) {
      next[name] = reading;
    } else {
      dropped += 1;
    }
  }
  return dropped === 0 ? readings : next;
}
