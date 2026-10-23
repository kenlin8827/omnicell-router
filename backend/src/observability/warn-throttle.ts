/**
 * Throttled warn: console.warn with two layers of noise control.
 *
 * 1. Dedup: an identical `key` triple is only printed ONCE per process
 *    lifetime. The "repeat" counter is folded into the first line so
 *    operators still see that the condition is recurring — just not on
 *    every single request.
 * 2. Rate limit: even when keys differ, total warns per rolling window
 *    (default 60s) are capped (default 50). Beyond the cap we emit one
 *    summary line per window instead of N individual ones, with the
 *    suppressed count.
 *
 * Designed for the orchestrator hot path: every request may produce up
 * to two warn events (model lacks effort support; effort downgraded).
 * Without throttling, a misconfigured pool that always downgrades would
 * flood stderr at inference QPS.
 *
 * The class is process-scoped (singleton). Tests that need to assert
 * specific warn counts should construct their own instance via
 * `new WarnThrottle({ ... })`.
 */
export interface WarnThrottleOptions {
  /** Rolling window length in milliseconds. Default 60_000. */
  windowMs?: number;
  /** Max warns per window. Default 50. */
  maxPerWindow?: number;
  /** Sink for warn output (defaults to console.warn). Overrideable for tests. */
  sink?: (line: string) => void;
  /** Time source (defaults to Date.now). Overrideable for tests. */
  now?: () => number;
}

export class WarnThrottle {
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly sink: (line: string) => void;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>(); // key → repeat count since first print
  private readonly firstSeen = new Map<string, number>(); // key → epoch ms of first warn
  private windowStart = 0;
  private windowCount = 0;
  private suppressedThisWindow = 0;

  constructor(opts: WarnThrottleOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxPerWindow = opts.maxPerWindow ?? 50;
    this.sink = opts.sink ?? ((line) => console.warn(line));
    this.now = opts.now ?? Date.now;
    this.windowStart = this.now();
  }

  /**
   * Emit a warn with dedup + rate limit. `key` should uniquely identify the
   * warning condition (e.g. `${requestedEffort}->${actualEffort}@${modelId}`)
   * — same key across requests is collapsed into one line plus a repeat
   * counter. Returns true if the line was emitted, false if suppressed.
   */
  warn(key: string, line: string): boolean {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) this.rollWindow(t);

    // Dedup: if we've already printed this key, fold the repeat into the
    // first line and don't re-emit. A repeat counter is enough signal.
    const prior = this.seen.get(key);
    if (prior !== undefined) {
      this.seen.set(key, prior + 1);
      return false;
    }
    this.seen.set(key, 1);
    this.firstSeen.set(key, t);

    // Rate limit: when the window is full, accumulate suppressed count
    // and emit nothing per-line. A summary line fires once the window rolls.
    if (this.windowCount >= this.maxPerWindow) {
      this.suppressedThisWindow++;
      return false;
    }

    this.windowCount++;
    this.sink(line);
    return true;
  }

  /**
   * Emit a summary line for everything suppressed in the current window.
   * Intended to be called on a timer (e.g. once per minute) or on graceful
   * shutdown. Bypasses the per-window rate cap — these are operator-driven
   * queries, not hot-path warnings, and missing the count would defeat the
   * purpose of asking.
   */
  flushSuppressed(): void {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) this.rollWindow(t);
    if (this.suppressedThisWindow > 0) {
      this.sink(
        `[ocr] suppressed ${this.suppressedThisWindow} similar warn lines in the last ${Math.round(this.windowMs / 1000)}s window`
      );
      this.suppressedThisWindow = 0;
    }
  }

  /**
   * Print a one-line summary for every key currently being deduped, with
   * its repeat count and "first seen" age. Intended for graceful-shutdown
   * diagnostics or a periodic console reporter. Bypasses the rate cap —
   * these are deliberately infrequent.
   */
  summary(): void {
    if (this.seen.size === 0) return;
    const t = this.now();
    const lines: string[] = [];
    for (const [key, repeats] of this.seen) {
      const firstT = this.firstSeen.get(key) ?? t;
      const ageSec = Math.max(0, Math.round((t - firstT) / 1000));
      // Escape single quotes + backslashes to prevent the key value from
      // breaking out of the surrounding quote pair in shell-rendered logs.
      const safeKey = String(key).replace(/[\\']/g, '\\$&');
      lines.push(`[ocr] recurring warn key='${safeKey}' repeats=${repeats} since ${ageSec}s ago`);
    }
    for (const l of lines) this.sink(l);
  }

  private rollWindow(t: number): void {
    this.windowStart = t;
    this.windowCount = 0;
    this.suppressedThisWindow = 0;
    // Keep the dedup map across windows — operators benefit from "first time
    // we saw X was at startup; we've seen it N times since" even after a
    // roll. If long-running processes accumulate too many keys, switch to
    // a WeakMap or an LRU; today the cardinality is bounded by model count
    // × effort ladder = ~50 keys, well under any limit.
  }

  /** Test-only: reset all state. */
  reset(): void {
    this.seen.clear();
    this.windowStart = this.now();
    this.windowCount = 0;
    this.suppressedThisWindow = 0;
  }

  /** Test-only: number of distinct keys seen since process start. */
  keyCount(): number {
    return this.seen.size;
  }

  /** Test-only: repeat count for a specific key (1 = no repeats yet). */
  repeatCount(key: string): number {
    return this.seen.get(key) ?? 0;
  }
}

/**
 * Process-wide singleton. Constructed lazily on first use so test isolation
 * can call `resetWarnThrottle()` between cases if it really matters.
 */
let singleton: WarnThrottle | null = null;

export function getWarnThrottle(): WarnThrottle {
  if (!singleton) singleton = new WarnThrottle();
  return singleton;
}

export function resetWarnThrottle(): void {
  if (singleton) singleton.reset();
}

/**
 * Test-only: replace the singleton with one whose sink + clock are
 * controllable. Returns a handle for restoring the original singleton
 * after the test.
 */
export function injectWarnThrottle(opts: WarnThrottleOptions): () => void {
  const prev = singleton;
  singleton = new WarnThrottle(opts);
  return () => {
    singleton = prev;
  };
}