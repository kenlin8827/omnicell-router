/**
 * Per-run request accounting for a live local engine (ADR-0040).
 *
 * The gateway is the only party that sees a local call — clients dial the
 * gateway, never the engine's loopback port (ADR-0038 §4) — so the numbers here
 * are not an approximation of the traffic, they ARE the traffic. Nothing in
 * this module scrapes an engine: a `/metrics` surface is a llama.cpp fact, and
 * reading it would make the monitor answer "unknown" for every other runtime
 * (the per-engine branching ADR-0039 removed).
 *
 * The seam is the `local` provider decorator (`local-provider.ts`), which
 * already resolves WHICH run answers. `createCompletion` and `createStream`
 * both feed this module, so the streamed and buffered legs are ONE accounting
 * plane — the same discipline the cache-integrity gate demands.
 *
 * Counters are PROCESS-LOCAL and live beside `runs.json`, never inside it: the
 * persisted record is lifecycle state the boot sweep adopts, while a rate is a
 * derived observation. Persisting it would let a four-hour-old TPS read as a
 * live figure after a gateway restart.
 */
import { appendRunLog } from './runner.js';

/** One timing observation — the rolling pair of §3 (aggregate + latest). */
export interface RateSample {
  /** Number of observations folded into this sample. */
  samples: number;
  /** Mean over every observation since the run started. */
  avg: number;
  /** Most recent observation (what "right now" means). */
  last: number;
}

export interface LocalRunStats {
  runId: string;
  /** Requests currently being served by this run (gauge). */
  inFlight: number;
  /** Requests completed successfully since this process started. */
  requests: number;
  /** Requests that threw before answering (breaker/route handled them). */
  errors: number;
  /** Token totals across completed requests. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Request start → first streamed delta. Absent until one leg reports it. */
  ttftMs: RateSample | null;
  /** Output tokens ÷ decode window (first delta → end). Absent until one
   *  leg could measure a window (a buffered leg has none). */
  decodeTps: RateSample | null;
  /** True when every observation came from a buffered (non-streamed) leg, so
   *  the TTFT figure is "the whole response" rather than a first-token wait. */
  bufferedOnly: boolean;
  /** Wall-clock of the last completed request (0 = none yet). */
  lastRequestAt: number;
  /** Epoch ms this process began counting (a restart resets the window). */
  since: number;
}

/** An in-flight request's start instant, keyed by run id. */
interface PendingMark {
  startedAt: number;
  firstDeltaAt: number | null;
  /** Set on the first settle — a mark releases its gauge exactly once. */
  released?: boolean;
}

const stats = new Map<string, LocalRunStats>();
/** In-flight marks per run — a run can serve several requests at once. */
const pending = new Map<string, PendingMark[]>();

function blank(runId: string): LocalRunStats {
  return {
    runId,
    inFlight: 0,
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    ttftMs: null,
    decodeTps: null,
    bufferedOnly: false,
    lastRequestAt: 0,
    since: Date.now(),
  };
}

function rowFor(runId: string): LocalRunStats {
  let row = stats.get(runId);
  if (!row) {
    row = blank(runId);
    stats.set(runId, row);
  }
  return row;
}

/** Fold one observation into a rolling pair. */
function fold(sample: RateSample | null, value: number): RateSample {
  if (!Number.isFinite(value) || value < 0) return sample ?? { samples: 0, avg: 0, last: 0 };
  if (!sample) return { samples: 1, avg: value, last: value };
  const samples = sample.samples + 1;
  return { samples, avg: (sample.avg * sample.samples + value) / samples, last: value };
}

/**
 * Register a request about to be served by `runId`. Returns the mark that
 * `completeRequest` / `failRequest` must hand back, so two concurrent requests
 * on the same run never overwrite each other's timing.
 */
export function beginRequest(runId: string): PendingMark {
  const row = rowFor(runId);
  row.inFlight += 1;
  const mark: PendingMark = { startedAt: Date.now(), firstDeltaAt: null };
  const queue = pending.get(runId) ?? [];
  queue.push(mark);
  pending.set(runId, queue);
  return mark;
}

/**
 * Note the arrival of the first streamed delta for `mark` — the instant the
 * TTFT window closes and the decode window opens. Idempotent: only the first
 * call per request counts.
 */
export function markFirstDelta(mark: PendingMark): void {
  if (mark.firstDeltaAt !== null) return;
  mark.firstDeltaAt = Date.now();
}

function release(runId: string, mark: PendingMark): void {
  // Only the FIRST release of a mark moves the gauge: a completed request that
  // is later settled again (a `finally` after the loop's own settle) must not
  // decrement a slot another request now holds.
  if (mark.released) return;
  mark.released = true;
  const queue = pending.get(runId);
  if (queue) {
    const idx = queue.indexOf(mark);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) pending.delete(runId);
  }
  const row = stats.get(runId);
  if (row && row.inFlight > 0) row.inFlight -= 1;
}

/**
 * Record a completed request. `usage` is the canonical usage the provider
 * returned (or the terminal event of a streamed call) — the single source of
 * token facts, so a leg that forgets to expose usage is visibly a zero here
 * rather than a plausible-looking estimate.
 */
export function completeRequest(
  runId: string,
  mark: PendingMark,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  },
  options: { streamed: boolean }
): void {
  const row = rowFor(runId);
  const endedAt = Date.now();
  row.requests += 1;
  row.lastRequestAt = endedAt;
  row.inputTokens += Math.max(0, usage.inputTokens ?? 0);
  row.outputTokens += Math.max(0, usage.outputTokens ?? 0);
  row.cachedInputTokens += Math.max(0, usage.cachedInputTokens ?? 0);

  const ttft = (mark.firstDeltaAt ?? endedAt) - mark.startedAt;
  row.ttftMs = fold(row.ttftMs, ttft);
  // A buffered leg has no first-chunk instant, so its "TTFT" is the whole
  // response. That is a different measurement; keep it in the average but
  // tell the page, so the figure is never read as a first-token wait.
  if (!options.streamed) row.bufferedOnly = true;

  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  const window = endedAt - (mark.firstDeltaAt ?? endedAt);
  if (options.streamed && mark.firstDeltaAt !== null && outputTokens > 0 && window > 0) {
    row.decodeTps = fold(row.decodeTps, (outputTokens / window) * 1000);
  }

  release(runId, mark);
}

/** Record a request that threw. The gauge is still released — a leaked slot
 *  would make the in-flight number climb forever and the page lie. */
export function failRequest(runId: string, mark: PendingMark, error?: unknown): void {
  const row = rowFor(runId);
  row.errors += 1;
  row.lastRequestAt = Date.now();
  release(runId, mark);
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (text) appendRunLog(runId, 'gateway', `request failed: ${text}`);
}

/** One run's counters, or a blank row for a run that served nothing yet. */
export function statsFor(runId: string): LocalRunStats {
  return stats.get(runId) ?? blank(runId);
}

/** Every run's counters (the monitor's merge source). */
export function allStats(): Map<string, LocalRunStats> {
  return stats;
}

/** Ids that currently hold counters (prune sweeps survivors of a record drop). */
export function statsRunIds(): string[] {
  return [...stats.keys()];
}

/** Drop counters for runs that no longer exist (prune follows `runs.json`). */
export function dropStats(runId: string): void {
  stats.delete(runId);
  pending.delete(runId);
}

/**
 * Test seam: wipe every counter. Production never clears the map wholesale —
 * a run's counters die with the run (`dropStats`).
 */
export function resetStatsForTests(): void {
  stats.clear();
  pending.clear();
}