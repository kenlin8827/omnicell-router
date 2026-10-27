import type { RateLimitRule, RouterConfig } from '../config/types.js';
import type { RateLimitWindowStore } from './window-store.js';

/**
 * Monotonic clock for window math — immune to NTP steps and manual clock
 * changes that would otherwise shrink or balloon a wall-clock window
 * (a backward step re-opens full windows instantly; a forward step fills
 * them spuriously). The engine's timebase is DELTA-ONLY: any consistent
 * millisecond scale works, which is why tests can pass fixed wall-clock-like
 * timestamps as the explicit `now` argument. Callers that don't pass `now`
 * get this monotonic scale; persistence rebases to/from wall clock at the
 * checkpoint boundary (see checkpoint/attachWindowStore).
 */
function nowMs(): number {
  return performance.now();
}

/** wall-clock → engine-timebase offset for the CURRENT instant. */
function wallOffset(): number {
  return Date.now() - nowMs();
}

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
 * single-process local gateway. Timebase: monotonic (see nowMs) — window
 * math is delta-only and immune to NTP steps; persistence rebases to
 * wall-clock pairs at the checkpoint boundary.
 *
 * Durability: windows are CHECKPOINTED to SQLite (rateLimit.persist, same
 * traces.db as the event ledger — window-store.ts) periodically and on
 * graceful shutdown, and rehydrated at boot, so a `1d` budget survives a
 * restart instead of resetting. Unattached (tests / non-bun runtimes /
 * persist disabled / checkpoint failure) the engine degrades to memory-only:
 * the pre-checkpoint behavior, where the provider's own 429 + breaker are
 * the catch for the brief post-restart under-count.
 *
 * Verdict-not-action: the engine answers window questions and never decides
 * what a call site does with a denial. 429s, skips and force-throughs are
 * policies of the callers.
 *
 * METERING COVERAGE (deliberate, not accidental):
 *  - inbound `requests` — counted at the Fastify auth gate for ALL four
 *    inference wires; the MITM forward-proxy leg bypasses that preHandler and
 *    is NOT inbound-metered. The same gate pre-reserves each admission's
 *    PROMPT-SIZE ESTIMATE (chars/4 of the body) against the tokens caps
 *    (tryDispatchWithEstimate) and reconciles it against actual usage when
 *    the response stream settles (releaseEstimate) — a large request cannot
 *    blow through a token cap on usage it has not produced YET.
 *  - `tokens` / `costUsd` — recorded on COMPLETED generations: the chat-
 *    shaped wires (chat / messages / responses) via the orchestrator's
 *    terminal accounting, and the System One decision wire via the surface's
 *    own hook (decision-pipeline.ts — the protocol's `usage` field when the
 *    upstream publishes one; a response WITHOUT usage records nothing
 *    for that call, the request slot still counts).
 *  - outbound `credential:` subjects — the chat pool gets the full shaping
 *    (peek skip / keep-bound / last-force + dispatch); the decision wire
 *    (which bypasses the pool) is COUNTED (dispatch + usage at the surface)
 *    but never locally refused: its frozen contract is "the named model
 *    answers or the upstream errors pass through" — no peek-admission there,
 *    and no breaker either (by the same contract).
 *  - internal legs (Layer-2 decision layer calls, breaker health probes) are unmetered
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
      /** Cap of the binding constraint (IETF RateLimit-Limit on the 429 wire). */
      limit: number;
      /** Usage of the binding constraint at deny time, RESERVATIONS INCLUDED
       *  (RateLimit-Remaining derives from it) — the same figure the admission
       *  check tested, so the header cannot advertise headroom the gate just
       *  refused. */
      used: number;
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

/**
 * Max LIVE events per window before the oldest are dropped (memory bound —
 * see EventWindow). 100k entries ≈ a few MB per constraint; far above any
 * realistic sliding-window population.
 */
const MAX_WINDOW_EVENTS = 100_000;

/**
 * Cooldown floor/ceiling for an upstream-429 penalty (see penalize). The floor
 * keeps a missing/garbage Retry-After from being meaningless; the ceiling
 * bounds a pathological header ("retry after 400 days") to a day.
 */
export const UPSTREAM_429_MIN_COOLDOWN_MS = 1_000;
export const UPSTREAM_429_MAX_COOLDOWN_MS = 86_400_000;
/** Default when the upstream 429 carries no usable Retry-After. Deliberately
 *  INDEPENDENT of the error-classifier's breaker initial-cooldown floor
 *  (resilience/circuit-breaker.ts): the breaker floor is operator-tunable via
 *  circuitBreaker.rules.*.minCooldownMs and governs hard-trip recovery, while
 *  this constant is the limiter's SHAPING hint (ADR-0004) — sharing a literal
 *  here would silently couple two policies that tune on different axes. */
export const UPSTREAM_429_DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Retry-After floor for a denial whose window is full purely on token
 * reservations (see EventWindow.reserved — they convert to real usage or
 * release, they do not age out like events). `msUntilBelow` walks events only,
 * so such a wall reports wait 0; advertising an immediate retry would send the
 * client straight back into a window that reopens only when live streams
 * settle. A 1s floor keeps the header honest without pretending to know when
 * the streams end.
 */
const RESERVATION_RETRY_FLOOR_MS = 1_000;

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

/** Sliding-window event log for one constraint. Amounts expire by timestamp.
 *
 * The window sum is maintained INCREMENTALLY: prune() subtracts expired
 * amounts from `liveSum` as it advances `head`, so `sum()` is O(1) instead of
 * an O(n) scan over the live slice on every evaluate. `msUntilBelow()` keeps
 * the per-event walk (only reached when the window is actually full — the
 * rare path). Floating amounts (costUsd) accumulate ε-level drift from the
 * incremental adds/subtracts; bounded by ~n·2⁻⁵² and irrelevant next to the
 * 0.01 USD granularity of the caps.
 *
 * MEMORY BOUND: live events are capped at MAX_WINDOW_EVENTS. A long window
 * (1d) at sustained high RPS would otherwise grow one entry per admitted
 * request without limit — in a single-process gateway that means the limiter
 * itself OOMs the gateway. Past the cap the OLDEST live events are dropped:
 * the window degrades to a bounded approximation that UNDER-counts (never
 * over-counts), i.e. the failure direction is "a cap admits slightly more
 * than configured under sustained saturation", never spontaneous denials.
 */
class EventWindow {
  private events: { ts: number; amount: number }[] = [];
  private head = 0;
  /** Sum of events[head..] — kept in sync by prune/add; O(1) read via sum(). */
  private liveSum = 0;
  /**
   * Admission-time token reservations (prompt-size estimates) not yet
   * reconciled against actual usage. Counted by sum() so concurrent admissions
   * cannot jointly blow through a token cap; NOT counted by msUntilBelow
   * (reservations are transient — they convert to real usage or release, they
   * do not age out like events do).
   */
  private reserved = 0;
  sum(now: number, windowMs: number): number {
    this.prune(now, windowMs);
    return this.liveSum + this.reserved;
  }

  /** Pre-occupy the window with an admission-time estimate. */
  reserve(amount: number): void {
    this.reserved += amount;
  }

  /** Release (part of) a reservation once actual usage is reconciled. Clamped at 0. */
  release(amount: number): void {
    this.reserved = Math.max(0, this.reserved - amount);
  }

  /**
   * ms until the sum drops below `limit` (0 when already below), computed by
   * expiring the oldest events one at a time.
   */
  msUntilBelow(now: number, windowMs: number, limit: number): number {
    this.prune(now, windowMs);
    let s = this.liveSum;
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

  /** Live (unpruned) entries — checkpoint serialization reads this. */
  liveEntries(): { ts: number; amount: number }[] {
    return this.events.slice(this.head);
  }

  /**
   * Load a checkpoint back into the window (boot-time rehydration). Entries
   * are pre-pruned live events in the ENGINE timebase; replaces any state.
   * liveSum is recomputed here — the incremental invariant is rebuilt, not
   * trusted from the checkpoint.
   */
  rehydrate(entries: { ts: number; amount: number }[], now: number, windowMs: number): void {
    this.events = entries.slice();
    this.head = 0;
    this.liveSum = 0;
    for (const e of this.events) this.liveSum += e.amount;
    this.prune(now, windowMs);
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
    this.liveSum += amount;
    // Bounded-memory degradation: drop the oldest LIVE events past the cap.
    // Normal traffic never reaches this (cap ≫ any realistic window population);
    // only sustained saturation at extreme RPS on a long window does.
    while (this.events.length - this.head > MAX_WINDOW_EVENTS) {
      this.liveSum -= this.events[this.head].amount;
      this.head++;
    }
    // Amortized compaction: shift the live slice down when dead entries outnumber live ones.
    if (this.head > 64 && this.head >= this.events.length - this.head) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  private prune(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    while (this.head < this.events.length && this.events[this.head].ts <= cutoff) {
      this.liveSum -= this.events[this.head].amount;
      this.head++;
    }
  }
}

export class RateLimiter {
  /** subject -> compiled constraints (rebuilt on every config reload). */
  private constraints = new Map<string, Constraint[]>();
  /** `${subject}|${windowMs}|${countable}` -> event log (kept across reloads while the constraint survives). */
  private windows = new Map<string, EventWindow>();
  /** subject -> upstream-429 cooldown deadline (engine timebase); see penalize. */
  private cooldowns = new Map<string, number>();

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
    // Cooldowns of removed subjects are equally dead.
    for (const subject of [...this.cooldowns.keys()]) {
      if (!next.has(subject)) this.cooldowns.delete(subject);
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
  peek(subject: string, now: number = nowMs()): RateLimitVerdict {
    const rules = this.constraints.get(subject);
    if (!rules) return { allowed: true };
    return this.evaluate(subject, rules, now);
  }

  /**
   * Check-and-count for the REQUEST dimension: when allowed, consumes one
   * request slot in the same synchronous step (Bun is single-threaded: there
   * is no check-then-act gap without an await between the two). Used by the
   * inbound preHandler; returns the verdict WITHOUT counting when full.
   *
   * With `tokenEstimate` > 0 the inbound token pre-reservation is folded in:
   * the admission check tests each tokens constraint against `sum + estimate`
   * and, when admitted, pre-occupies every tokens window with the estimate
   * (releaseEstimate reconciles it against actual usage at terminal). One
   * call, one synchronous step — the estimate can never slip past the cap in
   * the gap between a peek-based check and a later add.
   */
  tryDispatch(subject: string, now: number = nowMs()): RateLimitVerdict {
    return this.dispatchChecked(subject, 0, now);
  }

  /**
   * tryDispatch + admission-time token pre-reservation in ONE synchronous
   * step: each tokens constraint is checked against `sum + estimate` and,
   * when admitted, pre-occupied with the estimate (releaseEstimate reconciles
   * against actual usage at terminal). A request can never slip through a
   * token cap on account of usage it has not produced YET, and concurrent
   * admissions cannot jointly blow through it either.
   */
  tryDispatchWithEstimate(subject: string, tokenEstimate: number, now: number = nowMs()): RateLimitVerdict {
    return this.dispatchChecked(subject, tokenEstimate, now);
  }

  private dispatchChecked(subject: string, tokenEstimate: number, now: number): RateLimitVerdict {
    const rules = this.constraints.get(subject);
    if (!rules) return { allowed: true };
    const verdict = this.evaluate(subject, rules, now, tokenEstimate);
    if (!verdict.allowed) return verdict;
    this.countRequests(subject, rules, now);
    if (tokenEstimate > 0) {
      for (const c of rules) {
        if (c.countable === 'tokens') this.window(subject, c).reserve(tokenEstimate);
      }
    }
    return verdict;
  }

  /**
   * Reconcile an admission-time token estimate against the turn's ACTUAL
   * usage: release the reservation, then record the real tokens (the success
   * terminal's recordUsage adds them separately — order-independent, both
   * happen exactly once per admitted request). Called on reply close, so it
   * also covers failed/aborted turns: their reservation releases even though
   * no usage was produced. Untracked subjects / no token constraints: no-op.
   */
  releaseEstimate(subject: string, tokenEstimate: number): void {
    if (!(tokenEstimate > 0)) return;
    const rules = this.constraints.get(subject);
    if (!rules) return;
    for (const c of rules) {
      if (c.countable === 'tokens') this.window(subject, c).release(tokenEstimate);
    }
  }

  /**
   * Outbound dispatch: consume the request slot unconditionally — even when
   * the subject is at cap (the pool forced the call through; the event did
   * happen, so the window must stay honest). Counting semantics: ONE slot per
   * ADMITTED dispatch decision, not per HTTP attempt — an in-place retry on
   * the same candidate does not re-consume (a model failover to a different
   * candidate of the SAME provider does, as that is a new dispatch decision).
   */
  dispatch(subject: string, now: number = nowMs()): void {
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
    now: number = nowMs()
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

  private evaluate(subject: string, rules: Constraint[], now: number, tokenEstimate = 0): RateLimitVerdict {
    // Upstream-429 cooldown (see penalize) — a provider-declared wait binds
    // the whole subject, ahead of any local window math.
    const until = this.cooldowns.get(subject);
    if (until !== undefined) {
      if (now < until) {
        return {
          allowed: false,
          limitedBy: 'requests',
          rule: 'upstream-429',
          retryAfterMs: Math.max(1, until - now),
          limit: 0,
          used: 0,
        };
      }
      this.cooldowns.delete(subject); // expired — GC on touch
    }
    let binding: { rule: Constraint; waitMs: number; sum: number } | undefined;
    for (const c of rules) {
      const w = this.window(subject, c);
      // Token admissions pre-occupy the window with their estimate, so the
      // check tests the POST-admission sum — a request can never slip through
      // a token cap on account of usage it has not produced YET.
      const sum = w.sum(now, c.windowMs) + (c.countable === 'tokens' ? tokenEstimate : 0);
      if (sum < c.limit) continue;
      let waitMs = w.msUntilBelow(now, c.windowMs, c.limit);
      if (waitMs === 0) {
        // Full purely on reservations (+estimate): they don't age out, so no
        // event expiry will reopen this — floor the advertised wait (see
        // RESERVATION_RETRY_FLOOR_MS).
        waitMs = RESERVATION_RETRY_FLOOR_MS;
      }
      // limitedBy = the binding constraint (latest to open); retryAfter = max
      // over all full constraints — an earlier value returns callers to a
      // still-full wall.
      if (!binding || waitMs > binding.waitMs) binding = { rule: c, waitMs, sum };
    }
    if (!binding) return { allowed: true };
    return {
      allowed: false,
      limitedBy: binding.rule.countable,
      rule: `${binding.rule.windowText}/${binding.rule.countable}`,
      retryAfterMs: Math.max(1, binding.waitMs),
      limit: binding.rule.limit,
      used: binding.sum,
    };
  }

  /**
   * Feed a provider-declared 429 wait back into the local window: the subject
   * (a credential) is considered at-cap until the upstream's Retry-After (or
   * a default, when the 429 carries none) elapses — the local shaping then
   * steers NEW sessions away WITHOUT waiting to rediscover the limit by
   * hitting the wall again. The breaker keeps its own independent cooldown
   * (hard-trip semantics unchanged); this is the SHAPING input, not a second
   * breaker. Expired cooldowns GC on touch (evaluate); reload() drops
   * cooldowns of constraints that no longer exist.
   */
  penalize(subject: string, penaltyMs: number, now: number = nowMs()): void {
    const ms = Math.min(Math.max(penaltyMs, UPSTREAM_429_MIN_COOLDOWN_MS), UPSTREAM_429_MAX_COOLDOWN_MS);
    const until = now + ms;
    const existing = this.cooldowns.get(subject);
    if (existing === undefined || until > existing) this.cooldowns.set(subject, until);
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

  /** Attached durable checkpoint store (index.ts at boot); null = memory-only. */
  private windowStore?: RateLimitWindowStore;
  private checkpointTimer?: ReturnType<typeof setInterval>;

  /**
   * Attach the durable checkpoint store and rehydrate last lifetime's windows
   * into the engine (boot-time only, BEFORE traffic). Checkpoint rows whose
   * constraint no longer exists (rule removed/edited) are skipped and
   * garbage-collected. Events arrive as wall-clock pairs and are rebased onto
   * this process's monotonic timebase: the wall↔engine offset is a constant
   * per process lifetime, so `engineTs = wallTs - offset` preserves every
   * window delta. Replay failure is fail-open (fresh windows, the
   * pre-checkpoint behavior). Returns the rehydrated window count.
   */
  attachWindowStore(store: RateLimitWindowStore, now: number = nowMs()): number {
    this.windowStore = store;
    const offset = wallOffset();
    let rehydrated = 0;
    try {
      for (const { key, data } of store.loadAll()) {
        const subject = key.split('|')[0];
        if (!this.constraints.has(subject)) continue; // constraint gone — GC at next checkpoint
        let entries: [number, number][];
        try {
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed)) continue;
          entries = parsed;
        } catch {
          continue; // corrupted row — fresh window for that key
        }
        const windowMs = Number(key.split('|')[1]);
        if (!Number.isFinite(windowMs) || windowMs < 1) continue;
        const converted = entries
          .filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1]) && e[1] > 0)
          .map((e) => ({ ts: e[0] - offset, amount: e[1] }));
        const win = this.windows.get(key) ?? new EventWindow();
        win.rehydrate(converted, now, windowMs);
        this.windows.set(key, win);
        rehydrated++;
      }
    } catch {
      // fail open — replay must never break boot
    }
    return rehydrated;
  }

  /**
   * Serialize every live window to the attached store (wall-clock pairs) and
   * GC rows for constraints that no longer exist. Called periodically by
   * startCheckpointing and once on graceful shutdown. Fail-open: a failed
   * checkpoint costs only a wider post-restart under-count.
   */
  checkpoint(): void {
    const store = this.windowStore;
    if (!store) return;
    const offset = wallOffset();
    const keep: string[] = [];
    for (const [key, win] of this.windows) {
      const live = win.liveEntries();
      if (live.length === 0) continue; // nothing worth a row
      keep.push(key);
      // Live events → wall clock: `wall = engineTs + offset` inverts the
      // boot-time rebase exactly (same offset both directions per lifetime).
      const data = JSON.stringify(live.map((e) => [Math.round(e.ts + offset), e.amount]));
      store.save(key, data);
    }
    store.deleteStale(keep);
  }

  /** Arm the periodic checkpoint (index.ts at boot); unref'd so it never holds the process open. */
  startCheckpointing(intervalMs: number): void {
    this.stopCheckpointing();
    this.checkpointTimer = setInterval(() => this.checkpoint(), intervalMs);
    this.checkpointTimer.unref?.();
  }

  stopCheckpointing(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
  }

  /**
   * Close the attached window store (graceful shutdown, after the final
   * checkpoint). Detaches first so a late checkpoint cannot touch a closed
   * handle; fail-open like every store path.
   */
  closeWindowStore(): void {
    const store = this.windowStore;
    this.windowStore = undefined;
    this.stopCheckpointing();
    try {
      store?.close();
    } catch {
      // fail open — SQLite recovers via WAL on the next open
    }
  }

  /**
   * Reset the live window(s) of ONE subject — administrative escape hatch so
   * a stuck budget can be reopened without a restart. Scoped per subject
   * (optionally per rule label "1m/requests") by design: no global wipe —
   * a one-button "reset everything" would void inbound key budgets. Armed
   * rules are untouched; the next checkpoint GCs the cleared store rows
   * (empty liveEntries() rows are dropped by deleteStale). Returns the
   * number of constraints reset.
   */
  resetWindows(subject: string, rule?: string): number {
    const rules = this.constraints.get(subject);
    if (!rules) return 0;
    let reset = 0;
    for (const c of rules) {
      if (rule !== undefined && `${c.windowText}/${c.countable}` !== rule) continue;
      this.windows.set(`${subject}|${c.windowMs}|${c.countable}`, new EventWindow());
      reset++;
    }
    return reset;
  }

  /**
   * Observability snapshot: every tracked subject × constraint with its live
   * window sum. Powers /api/admin/ratelimit — operators verify a cap is armed
   * and see headroom without reading code.
   */
  snapshot(now: number = nowMs()): RateLimitSnapshotEntry[] {
    const out: RateLimitSnapshotEntry[] = [];
    for (const [subject, rules] of this.constraints) {
      // Upstream-429 shaping cooldown (penalize) — surfaced so the console can
      // explain a skipped credential whose windows are still empty (the
      // denial comes from the cooldown, not the window math).
      const until = this.cooldowns.get(subject);
      const cooldownMs = until !== undefined && now < until ? Math.max(1, until - now) : 0;
      for (const c of rules) {
        const sum = this.window(subject, c).sum(now, c.windowMs);
        out.push({
          subject,
          rule: `${c.windowText}/${c.countable}`,
          windowMs: c.windowMs,
          countable: c.countable,
          limit: c.limit,
          used: sum,
          // Same reservation floor as evaluate(): the console must not show a
          // ready-to-retry `—` for a window the 429 wire reports as 1s away.
          retryAfterMs: (() => {
            if (sum < c.limit) return 0;
            const wait = this.window(subject, c).msUntilBelow(now, c.windowMs, c.limit);
            return wait === 0 ? 1_000 : wait;
          })(),
          ...(cooldownMs > 0 ? { cooldownMs } : {}),
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
  /** Remaining ms of the subject's upstream-429 shaping cooldown (0 = none). */
  cooldownMs?: number;
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
