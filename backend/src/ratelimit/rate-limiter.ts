import type { RateLimitRule, RouterConfig } from '../config/types.js';

/**
 * Sliding-window rate limiter — one engine, two directions:
 *
 *  - INBOUND (`apikey:<id>` subjects, from `apiKeys[].limits`): enforcing.
 *    The auth preHandler calls `tryDispatch()` before the handler runs; every
 *    full window — requests, tokens OR costUsd — is denied, and the gate
 *    fast-fails 429 + `Retry-After` unless its bounded grace wait
 *    (`rateLimit.inboundGraceMs`, a caller policy — see server.ts) absorbs a
 *    denial whose window reopens within the budget. A cost budget is a
 *    window that reopens by time like any other, and 429 is the one status
 *    every client SDK backs off on (402 means
 *    "no payment configured" to those SDKs — never retry, wrong signal here).
 *    Denied attempts are NOT counted — otherwise a retry storm would push the
 *    lockout past the window itself.
 *  - OUTBOUND (`credential:<provider>:<keyHashPrefix>` subjects, from the
 *    `credentials:` overlay): shaping. The candidate pool `peek()s` before
 *    dispatch and skips an at-cap credential while another candidate remains,
 *    EXCEPT a keep-bound session (rebinding on a local cap burns the upstream
 *    prompt cache for a mere shaping hint — the breaker stays the reactive
 *    edge). `dispatch()` consumes the request counter when the call proceeds.
 *
 * Countables: `requests`, `tokens`, `costUsd` — one or many per rule entry
 * (`{ window: 1m, requests: 10, tokens: 50000 }` is two independent
 * constraints sharing one window). Deny = ANY constraint full.
 *
 * Algorithm: exact sliding-window log. Every admitted event is
 * `(timestamp, amount)`; sums recompute over `[now - window, now]` as old
 * entries expire. This is precise (no bucket approximation) and cheap for a
 * single-process local gateway. State is MEMORY-ONLY by design: a restart
 * resets the windows (minute windows must survive no restart anyway; a day
 * window rehydration from the trace ledger is a deferred follow-up, not a
 * correctness requirement — brief under-counting after a restart is exactly
 * what the provider's own 429 + breaker catch).
 *
 * Verdict-not-action: the engine answers window questions and never decides
 * what a call site does with a denial. 429s, skips and force-throughs are
 * policies of the callers.
 *
 * METERING COVERAGE (deliberate, not accidental):
 *  - inbound `requests` — counted at the Fastify auth gate for ALL four
 *    inference wires; the MITM forward-proxy leg bypasses that preHandler and
 *    is NOT inbound-metered.
 *  - `tokens` / `costUsd` — recorded on COMPLETED generations: the chat-
 *    shaped wires (chat / messages / responses) via the orchestrator's
 *    terminal accounting, and the System One decision wire via the surface's
 *    own hook (decision-pipeline.ts — the protocol's `usage` field when the
 *    upstream publishes one; a native response WITHOUT usage records nothing
 *    for that call, the request slot still counts).
 *  - outbound `credential:` subjects — the chat pool gets the full shaping
 *    (peek skip / keep-bound / last-force + dispatch); the decision wire
 *    (which bypasses the pool) is COUNTED (dispatch + usage at the surface)
 *    but never locally refused: its frozen contract is "the named model
 *    answers or the upstream errors pass through" — no peek-admission there,
 *    and no breaker either (by the same contract).
 *  - internal legs (Layer-2 judge calls, breaker health probes) are unmetered
 *    by design — they share the decision EXECUTOR (decide.ts), and the hooks
 *    deliberately live at the HTTP surface, not in the executor.
 */

export type Countable = 'requests' | 'tokens' | 'costUsd';

export type RateLimitVerdict =
  | { allowed: true }
  | {
      allowed: false;
      limitedBy: Countable;
      /** Display label of the binding constraint, e.g. "1m/requests" — echoes the YAML rule. */
      rule: string;
      /** ms until the subject is admissible again (max over all full constraints). */
      retryAfterMs: number;
    };

/** A rule entry after validation: one window, one countable, one cap. */
interface Constraint {
  /** Original window text from the config (`1m`) for log/UI echo; collisions on the same duration share the same window. */
  windowText: string;
  windowMs: number;
  countable: Countable;
  limit: number;
}

/** Subject identity helpers — the only two spellings the engine understands. */
export function apiKeySubject(id: string): string {
  return `apikey:${id}`;
}
export function credentialSubject(provider: string, keyHashPrefix: string): string {
  return `credential:${provider}:${keyHashPrefix}`;
}

/** Go/Prometheus duration syntax: `500ms`, `30s`, `5m`, `1h`, `1d`. */
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const m = DURATION_PATTERN.exec(text.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const ms = Math.round(value * UNIT_MS[m[2]]);
  // Sub-ms durations would compile to windowMs=0: a permanently-empty window
  // nobody can ever hit OR a sum-always-zero dead rule depending on pruning —
  // reject at the grammar level instead (review MINOR-4).
  return ms >= 1 ? ms : undefined;
}

/** Flatten rule entries into per-countable constraints; invalid entries are dropped with a warning naming the rule. */
export function compileRules(rules: unknown, subjectLabel: string): Constraint[] {
  const out: Constraint[] = [];
  const seen = new Set<string>();
  if (rules === undefined || rules === null) return out;
  if (!Array.isArray(rules)) {
    console.warn(`[ratelimit] ${subjectLabel}: "limits" must be an array, ignored`);
    return out;
  }
  for (const raw of rules) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      console.warn(`[ratelimit] ${subjectLabel}: rule entry ${JSON.stringify(raw)} is not an object, ignored`);
      continue;
    }
    const { window, requests, tokens, costUsd } = raw as Record<string, unknown>;
    const windowMs = parseDuration(window);
    if (windowMs === undefined) {
      console.warn(
        `[ratelimit] ${subjectLabel}: invalid window ${JSON.stringify(window)} (expect e.g. 30s / 5m / 1h / 1d), rule ignored`
      );
      continue;
    }
    const windowText = String(window).trim();
    const dims: [Countable, unknown][] = [
      ['requests', requests],
      ['tokens', tokens],
      ['costUsd', costUsd],
    ];
    let anyCountable = false;
    for (const [countable, value] of dims) {
      if (value === undefined || value === null) continue;
      anyCountable = true;
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) {
        console.warn(
          `[ratelimit] ${subjectLabel}: ${windowText}/${countable} cap ${JSON.stringify(value)} is not a non-negative number, constraint ignored`
        );
        continue;
      }
      if (num === 0) {
        console.warn(
          `[ratelimit] ${subjectLabel}: ${windowText}/${countable} = 0 blocks every request (did you mean to remove the rule?)`
        );
      }
      const key = `${windowMs}|${countable}`;
      if (seen.has(key)) {
        console.warn(
          `[ratelimit] ${subjectLabel}: duplicate ${windowText}/${countable} constraint, first definition kept`
        );
        continue;
      }
      seen.add(key);
      out.push({ windowText, windowMs, countable, limit: num });
    }
    if (!anyCountable) {
      console.warn(
        `[ratelimit] ${subjectLabel}: rule ${JSON.stringify(raw)} carries no countable (requests/tokens/costUsd), ignored`
      );
    }
  }
  return out;
}

/** Sliding-window event log for one constraint. Amounts expire by timestamp. */
class EventWindow {
  private events: { ts: number; amount: number }[] = [];
  private head = 0;

  sum(now: number, windowMs: number): number {
    this.prune(now, windowMs);
    let s = 0;
    for (let i = this.head; i < this.events.length; i++) s += this.events[i].amount;
    return s;
  }

  /**
   * ms until the sum drops below `limit` (0 when already below), computed by
   * expiring the oldest events one at a time.
   */
  msUntilBelow(now: number, windowMs: number, limit: number): number {
    this.prune(now, windowMs);
    let s = 0;
    for (let i = this.head; i < this.events.length; i++) s += this.events[i].amount;
    if (s < limit) return 0;
    for (let i = this.head; i < this.events.length; i++) {
      s -= this.events[i].amount;
      if (s < limit) return Math.max(0, this.events[i].ts + windowMs - now);
    }
    // All events older than the window would leave sum = 0 < limit (limit >= 0
    // and a zero-limit constraint is permanently full — unreachable for
    // limit > 0; treat as "window end" so callers still get a finite answer).
    return windowMs;
  }

  /**
   * Append one event. Prunes BEFORE pushing: a write-only window (the
   * decision wire's credential subject is dispatch/recordUsage-only — no peek
   * ever touches it) must not grow unboundedly just because nobody looked
   * (review MAJOR-1: read-side-only pruning leaked ~600k events at 1 rps ×
   * 1 week per window).
   */
  add(ts: number, amount: number, windowMs: number): void {
    this.prune(ts, windowMs);
    this.events.push({ ts, amount });
    // Amortized compaction: shift the live slice down when dead entries outnumber live ones.
    if (this.head > 64 && this.head >= this.events.length - this.head) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  private prune(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    while (this.head < this.events.length && this.events[this.head].ts <= cutoff) this.head++;
  }
}

export class RateLimiter {
  /** subject -> compiled constraints (rebuilt on every config reload). */
  private constraints = new Map<string, Constraint[]>();
  /** `${subject}|${windowMs}|${countable}` -> event log (kept across reloads while the constraint survives). */
  private windows = new Map<string, EventWindow>();

  /**
   * Rebuild the rule table from a RouterConfig. Event logs for constraints
   * that still exist (same window + countable) are preserved; logs of
   * removed constraints are dropped with the rule.
   */
  reload(config: RouterConfig): void {
    const next = new Map<string, Constraint[]>();

    for (const key of config.apiKeys ?? []) {
      const subject = apiKeySubject(key.id);
      const rules = compileRules((key as { limits?: unknown }).limits, subject);
      if (rules.length > 0) next.set(subject, rules);
    }

    const credentials = config.credentials;
    if (credentials && typeof credentials === 'object') {
      for (const [provider, entries] of Object.entries(credentials)) {
        if (!Array.isArray(entries)) {
          console.warn(`[ratelimit] credentials.${provider}: expected a list of credential entries, ignored`);
          continue;
        }
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue;
          const prefix = (entry as { keyHashPrefix?: unknown }).keyHashPrefix;
          if (typeof prefix !== 'string' || !prefix) {
            console.warn(`[ratelimit] credentials.${provider}: entry without keyHashPrefix ignored`);
            continue;
          }
          const subject = credentialSubject(provider, prefix.trim().toLowerCase());
          // Lower-cased identity: chain prefixes are sha256 hex (always lower);
          // a hand-written upper-case YAML prefix would otherwise arm a subject
          // no call site can ever hit — a silent dead rule.
          const rules = compileRules((entry as { limits?: unknown }).limits, subject);
          if (rules.length > 0) next.set(subject, rules);
        }
      }
    }

    // Drop logs whose constraint disappeared or changed window; swap in the
    // new table. A CAP edit keeps the log (same windowMs|countable key) —
    // history survives a threshold retune by design.
    const keep = new Set<string>();
    for (const [subject, rules] of next) {
      for (const c of rules) keep.add(`${subject}|${c.windowMs}|${c.countable}`);
    }
    for (const logKey of [...this.windows.keys()]) {
      if (!keep.has(logKey)) this.windows.delete(logKey);
    }
    this.constraints = next;
  }

  /** True when the subject has at least one compiled constraint. */
  isTracked(subject: string): boolean {
    return this.constraints.has(subject);
  }

  /**
   * NON-CONSUMING check — the outbound pool filter asks this before deciding
   * whether to skip a candidate; an untracked subject is trivially allowed.
   */
  peek(subject: string, now: number = Date.now()): RateLimitVerdict {
    const rules = this.constraints.get(subject);
    if (!rules) return { allowed: true };
    return this.evaluate(subject, rules, now);
  }

  /**
   * Check-and-count for the REQUEST dimension: when allowed, consumes one
   * request slot in the same synchronous step (Bun is single-threaded: there
   * is no check-then-act gap without an await between the two). Used by the
   * inbound preHandler; returns the verdict WITHOUT counting when full.
   */
  tryDispatch(subject: string, now: number = Date.now()): RateLimitVerdict {
    const rules = this.constraints.get(subject);
    if (!rules) return { allowed: true };
    const verdict = this.evaluate(subject, rules, now);
    if (!verdict.allowed) return verdict;
    this.countRequests(subject, rules, now);
    return verdict;
  }

  /**
   * Outbound dispatch: consume the request slot unconditionally — even when
   * the subject is at cap (the pool forced the call through; the event did
   * happen, so the window must stay honest). Counting semantics: ONE slot per
   * ADMITTED dispatch decision, not per HTTP attempt — an in-place retry on
   * the same candidate does not re-consume (a model failover to a different
   * candidate of the SAME provider does, as that is a new dispatch decision).
   */
  dispatch(subject: string, now: number = Date.now()): void {
    const rules = this.constraints.get(subject);
    if (!rules) return;
    this.countRequests(subject, rules, now);
  }

  /**
   * Terminal usage fact for tokens/costUsd. Current wiring: fires ONCE per
   * COMPLETED generation — the chat-shaped wires at the orchestrator's
   * success terminal (SSE included, the stream is synthesized from the same
   * buffered result), and the System One decision wire at its surface hook
   * when the protocol carried a usage object.
   * Failed turns record nothing (no usage was produced; the request slots
   * they consumed were already counted at the gates). KNOWN GAPS, deliberate:
   * upstream-billed-then-failed turns and aborted streams with no usage
   * event under-count tokens/cost — brief, and the provider's own quota
   * enforcement is the hard edge (the breaker too on the chat wires; the
   * System One decision wire passes upstream errors through untouched —
   * NO breaker there by its frozen contract). Untracked subjects are a
   * no-op (the degeneracy promise: no rule, no state).
   */
  recordUsage(
    subject: string,
    usage: { tokens?: number; costUsd?: number },
    now: number = Date.now()
  ): void {
    const rules = this.constraints.get(subject);
    if (!rules) return;
    for (const c of rules) {
      if (c.countable === 'requests') continue;
      const amount = c.countable === 'tokens' ? usage.tokens ?? 0 : usage.costUsd ?? 0;
      if (amount > 0) this.window(subject, c).add(now, amount, c.windowMs);
    }
  }

  private countRequests(subject: string, rules: Constraint[], now: number): void {
    for (const c of rules) {
      if (c.countable === 'requests') this.window(subject, c).add(now, 1, c.windowMs);
    }
  }

  private evaluate(subject: string, rules: Constraint[], now: number): RateLimitVerdict {
    let binding: { rule: Constraint; waitMs: number } | undefined;
    for (const c of rules) {
      const w = this.window(subject, c);
      const sum = w.sum(now, c.windowMs);
      if (sum < c.limit) continue;
      const waitMs = w.msUntilBelow(now, c.windowMs, c.limit);
      // limitedBy = the binding constraint (latest to open); retryAfter = max
      // over all full constraints — an earlier value returns callers to a
      // still-full wall.
      if (!binding || waitMs > binding.waitMs) binding = { rule: c, waitMs };
    }
    if (!binding) return { allowed: true };
    return {
      allowed: false,
      limitedBy: binding.rule.countable,
      rule: `${binding.rule.windowText}/${binding.rule.countable}`,
      retryAfterMs: Math.max(1, binding.waitMs),
    };
  }

  private window(subject: string, c: Constraint): EventWindow {
    const key = `${subject}|${c.windowMs}|${c.countable}`;
    let w = this.windows.get(key);
    if (!w) {
      w = new EventWindow();
      this.windows.set(key, w);
    }
    return w;
  }

  /**
   * Observability snapshot: every tracked subject × constraint with its live
   * window sum. Powers /api/admin/ratelimit — operators verify a cap is armed
   * and see headroom without reading code.
   */
  snapshot(now: number = Date.now()): RateLimitSnapshotEntry[] {
    const out: RateLimitSnapshotEntry[] = [];
    for (const [subject, rules] of this.constraints) {
      for (const c of rules) {
        const sum = this.window(subject, c).sum(now, c.windowMs);
        out.push({
          subject,
          rule: `${c.windowText}/${c.countable}`,
          windowMs: c.windowMs,
          countable: c.countable,
          limit: c.limit,
          used: sum,
          retryAfterMs: sum >= c.limit ? this.window(subject, c).msUntilBelow(now, c.windowMs, c.limit) : 0,
        });
      }
    }
    return out;
  }
}

export interface RateLimitSnapshotEntry {
  subject: string;
  /** "1m/requests" style display label echoing the YAML rule. */
  rule: string;
  windowMs: number;
  countable: Countable;
  limit: number;
  used: number;
  /** ms until this constraint has slack (0 when below the cap). */
  retryAfterMs: number;
}

/**
 * Console/PUT-payload validation for a `limits` array (same semantics the
 * engine compiles at reload, surfaced as an error instead of a dropped rule):
 * duration syntax + exactly one or more countables, non-negative numbers.
 * Returns the sanitized list, undefined when absent, or an error string.
 */
export function validateRateLimitRules(input: unknown): { value?: RateLimitRule[]; error?: string } {
  if (input === undefined || input === null) return {};
  if (!Array.isArray(input)) return { error: 'limits must be an array of rate-limit rules' };
  const out: RateLimitRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `limits entry ${JSON.stringify(raw)} must be an object { window, requests?/tokens?/costUsd? }` };
    }
    const entry = raw as Record<string, unknown>;
    if (parseDuration(entry.window) === undefined) {
      return {
        error: `limits entry ${JSON.stringify(raw)}: window must be a duration string (e.g. 30s / 5m / 1h / 1d)`,
      };
    }
    const rule: RateLimitRule = { window: String(entry.window).trim() };
    let anyCountable = false;
    for (const dim of ['requests', 'tokens', 'costUsd'] as const) {
      const v = entry[dim];
      if (v === undefined || v === null) continue;
      const num = Number(v);
      if (!Number.isFinite(num) || num < 0) {
        return { error: `limits ${rule.window}/${dim} must be a non-negative number` };
      }
      rule[dim] = num;
      anyCountable = true;
    }
    if (!anyCountable) {
      return { error: `limits entry ${JSON.stringify(raw)} sets no countable (requests/tokens/costUsd)` };
    }
    const extra = Object.keys(entry).filter((k) => !['window', 'requests', 'tokens', 'costUsd'].includes(k));
    if (extra.length > 0) {
      return { error: `limits entry ${JSON.stringify(raw)} has unknown field(s): ${extra.join(', ')}` };
    }
    out.push(rule);
  }
  return { value: out };
}

// ─── Singleton ───────────────────────────────────────────────────────────────
// Same pattern as observability/warn-throttle: call sites reach the shared
// engine via getRateLimiter(); the rule table is reloaded at boot and on every
// config save (config/index.ts saveConfig/saveRawConfig are the single sync
// point — every write path, console or hand-edited YAML, passes through them).

let instance: RateLimiter | undefined;

export function getRateLimiter(): RateLimiter {
  if (!instance) instance = new RateLimiter();
  return instance;
}

/** Test seam — swap in a fresh (or preloaded) limiter. */
export function setRateLimiterForTests(next?: RateLimiter): RateLimiter | undefined {
  const previous = instance;
  instance = next;
  return previous;
}
