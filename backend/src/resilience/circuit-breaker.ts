import {
  BreakerReasonCode,
  BreakerRecord,
  BreakerScopeOverride,
  CircuitBreakerConfig,
  CircuitBreakerSnapshot,
  CircuitBreakerState,
  ErrorCategory,
  ErrorDiagnosis,
  OnCanaryFailureMode,
  ResolvedBreakerRules,
  RetryConfig,
} from './types.js';
import { ReasonParams, TierLevel } from '../types/router.js';
import { DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS } from '../pipeline/credential-selection.js';

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: Required<Omit<CircuitBreakerConfig, 'rules' | 'shadow' | 'persistence'>> = {
  enabled: true,
  failureThreshold: 3,
  slidingWindowSize: 20,
  failureRateThreshold: 0.5,
  initialCooldownMs: 30 * 1000, // 30s
  maxCooldownMs: 5 * 3600 * 1000, // 5 hours (handles multi-hour major outages)
  cooldownMultiplier: 2.0, // 30s -> 60s -> 120s -> 240s ...
  quotaCooldownMs: 12 * 3600 * 1000, // 12 hours for quota/balance exhaustion
  halfOpenMaxProbes: 1, // Only allow 1 canary request through
  activeProbing: {
    enabled: false,
    intervalMs: 60 * 1000,
  },
  // Carried like activeProbing (the breaker itself never probes): the
  // affinity window is read by the selection layer from RouterConfig.
  credentialAffinity: {
    cacheTtlMs: DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS,
  },
};

/**
 * Startup resolution of the `circuitBreaker.rules` tree into one effective,
 * fully-populated `ResolvedBreakerRules` (spec invariant 5). Unset per-rule
 * params fall back to the global knob; enabled toggles default to today's
 * behavior (everything on, clientErrors off), so a legacy config without
 * `rules` resolves to exactly what the hardcoded pipeline did before.
 *
 * `retry` is consulted ONLY for `hardTripAboveMs`'s default (today's 429
 * boundary is borrowed from retry.inplace.maxRateLimitWaitMs) — the breaker
 * side never rewrites the retry-side in-place-retry decision.
 *
 * Clamps enforced here (and mirrored by the config sanitizer for saved YAML):
 *   maxProbes >= 1 (0 would starve the prober budget and pin HALF_OPEN),
 *   successThreshold <= maxProbes (an unsatisfiable threshold pins HALF_OPEN),
 *   minCalls <= windowSize (otherwise the rate rule can never evaluate).
 */
export function resolveBreakerRules(
  circuit?: CircuitBreakerConfig,
  retry?: RetryConfig
): ResolvedBreakerRules {
  const d = DEFAULT_CIRCUIT_BREAKER_CONFIG;
  // Boundary values keep today's hardcoded numbers where no knob existed.
  const ms = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  const int = (v: unknown, fallback: number): number => Math.floor(ms(v, fallback));
  const ratio = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const scope = (v: unknown): BreakerScopeOverride =>
    v === 'auto' || v === 'pair' || v === 'credential' || v === 'model' ? (v as BreakerScopeOverride) : 'auto';
  const mode = (v: unknown): OnCanaryFailureMode =>
    v === 'initial' || v === 'close' || v === 'backoff' ? (v as OnCanaryFailureMode) : 'backoff';

  const initial = ms(circuit?.initialCooldownMs, d.initialCooldownMs);
  const maxCooldown = ms(circuit?.maxCooldownMs, d.maxCooldownMs);
  const quota = ms(circuit?.quotaCooldownMs, d.quotaCooldownMs);
  const globalMultiplier = ms(circuit?.cooldownMultiplier, d.cooldownMultiplier);
  const globalWindow = Math.max(1, int(circuit?.slidingWindowSize, d.slidingWindowSize));

  const rules = circuit?.rules;
  const counting = rules?.counting;
  const trip = rules?.trip;
  const halfOpen = rules?.recovery?.halfOpen;

  const maxProbes = Math.max(1, int(halfOpen?.maxProbes, int(circuit?.halfOpenMaxProbes, d.halfOpenMaxProbes)));
  const successThreshold = Math.min(Math.max(1, int(halfOpen?.successThreshold, 1)), maxProbes);
  const windowSize = Math.max(1, int(trip?.failureRate?.windowSize, globalWindow));
  const minCalls = Math.min(Math.max(0, int(trip?.failureRate?.minCalls, windowSize)), windowSize);

  return {
    shadow: bool(circuit?.shadow, false),
    counting: {
      serverErrors: {
        enabled: bool(counting?.serverErrors?.enabled, true),
        minCooldownMs: ms(counting?.serverErrors?.minCooldownMs, initial),
      },
      unknownErrors: {
        enabled: bool(counting?.unknownErrors?.enabled, true),
        minCooldownMs: ms(counting?.unknownErrors?.minCooldownMs, initial),
      },
      // No toggle (the classifier counts every 429); floor default = today's
      // hardcoded min(60s, initial) for the no-Retry-After case.
      rateLimitErrors: {
        minCooldownMs: ms(counting?.rateLimitErrors?.minCooldownMs, Math.min(60 * 1000, initial)),
      },
      clientErrors: { enabled: bool(counting?.clientErrors?.enabled, false) },
    },
    trip: {
      quota: {
        enabled: bool(trip?.quota?.enabled, true),
        cooldownMs: ms(trip?.quota?.cooldownMs, quota),
        scope: scope(trip?.quota?.scope),
      },
      auth: {
        enabled: bool(trip?.auth?.enabled, true),
        cooldownMs: ms(trip?.auth?.cooldownMs, quota),
        markSuspect: bool(trip?.auth?.markSuspect, true),
        scope: scope(trip?.auth?.scope),
      },
      rateLimit: {
        enabled: bool(trip?.rateLimit?.enabled, true),
        hardTripAboveMs: ms(trip?.rateLimit?.hardTripAboveMs, retry?.inplace?.maxRateLimitWaitMs ?? 2000),
        minCooldownMs: ms(trip?.rateLimit?.minCooldownMs, 1000), // today's hardcoded floor
        scope: scope(trip?.rateLimit?.scope),
      },
      consecutiveFailures: {
        enabled: bool(trip?.consecutiveFailures?.enabled, true),
        threshold: Math.max(1, int(trip?.consecutiveFailures?.threshold, ms(circuit?.failureThreshold, d.failureThreshold))),
        initialCooldownMs: ms(trip?.consecutiveFailures?.initialCooldownMs, initial),
        cooldownMultiplier: ms(trip?.consecutiveFailures?.cooldownMultiplier, globalMultiplier),
        maxCooldownMs: ms(trip?.consecutiveFailures?.maxCooldownMs, maxCooldown),
        scope: scope(trip?.consecutiveFailures?.scope),
      },
      failureRate: {
        enabled: bool(trip?.failureRate?.enabled, true),
        windowSize,
        failureRate: ratio(trip?.failureRate?.failureRate, circuit?.failureRateThreshold ?? d.failureRateThreshold),
        minCalls,
        cooldownMs: ms(trip?.failureRate?.cooldownMs, initial),
        scope: scope(trip?.failureRate?.scope),
      },
    },
    recovery: {
      onCanaryFailure: mode(rules?.recovery?.onCanaryFailure),
      cooldownMultiplier: ms(rules?.recovery?.cooldownMultiplier, globalMultiplier),
      halfOpen: { maxProbes, successThreshold, maxWaitMs: ms(halfOpen?.maxWaitMs, 0) },
    },
  };
}

/**
 * Resolve the raw `CircuitBreakerConfig` into the breaker's flat, fully-defaulted
 * config snapshot (constructor + `applyConfig` share this one shape).
 */
function resolveBreakerConfig(
  config?: CircuitBreakerConfig
): Required<Omit<CircuitBreakerConfig, 'rules' | 'shadow' | 'persistence'>> {
  return {
    enabled: config?.enabled ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.enabled,
    failureThreshold: config?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold,
    slidingWindowSize: config?.slidingWindowSize ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.slidingWindowSize,
    failureRateThreshold: config?.failureRateThreshold ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.failureRateThreshold,
    initialCooldownMs: config?.initialCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.initialCooldownMs,
    maxCooldownMs: config?.maxCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxCooldownMs,
    cooldownMultiplier: config?.cooldownMultiplier ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMultiplier,
    quotaCooldownMs: config?.quotaCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.quotaCooldownMs,
    halfOpenMaxProbes: config?.halfOpenMaxProbes ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxProbes,
    activeProbing: {
      enabled: config?.activeProbing?.enabled ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.activeProbing.enabled,
      intervalMs: config?.activeProbing?.intervalMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.activeProbing.intervalMs,
    },
    credentialAffinity: {
      cacheTtlMs:
        config?.credentialAffinity?.cacheTtlMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.credentialAffinity.cacheTtlMs,
    },
  };
}

export class CircuitBreaker {
  public readonly modelId: string;
  public readonly provider: string;
  public readonly tier?: TierLevel;

  private config: Required<Omit<CircuitBreakerConfig, 'rules' | 'shadow' | 'persistence'>>;
  // Effective ruleset (resolved at construction; `applyConfig` swaps it — the
  // manager's hot-apply hands every breaker its own freshly-resolved object so
  // breaker and gate can never disagree, spec invariant 5/6).
  private rules: ResolvedBreakerRules;
  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private totalRequests = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private lastFailureTime = 0;
  private lastSuccessTime = 0;
  private trippedAt = 0;
  private cooldownUntil = 0;
  private currentCooldownMs = 0;
  private halfOpenProbes = 0;
  // HALF_OPEN trial batch (spec rule #10): successes counted and the episode
  // start for the maxWaitMs clock.
  private halfOpenSuccesses = 0;
  private halfOpenEnteredAt = 0;
  private reason?: string;
  private reasonCode?: BreakerReasonCode;
  private reasonParams?: ReasonParams;
  private category?: ErrorCategory;

  // Sliding window ring buffer (true = success, false = failure)
  private outcomeWindow: boolean[] = [];

  // Injectable clock provider for high-speed time-travel unit testing
  private nowFn: () => number;

  constructor(
    modelId: string,
    provider: string,
    tier?: TierLevel,
    config?: CircuitBreakerConfig,
    nowFn: () => number = Date.now,
    rules?: ResolvedBreakerRules
  ) {
    this.modelId = modelId;
    this.provider = provider;
    this.tier = tier;
    this.nowFn = nowFn;
    // Direct constructions (tests, harnesses) that skip the manager get the
    // defaults, which resolve to exactly today's hardcoded behavior.
    this.rules = rules ?? resolveBreakerRules(config);
    this.config = resolveBreakerConfig(config);
    this.currentCooldownMs = this.rules.trip.consecutiveFailures.initialCooldownMs;
  }

  /**
   * Hot-apply a new config + resolved ruleset (spec invariant 6, hot-apply).
   * The swap touches NO state machine fields: the new rules govern from the
   * next decision point — OPEN cooldown timers keep running at their original
   * length, ladder positions, consecutive counts, HALF_OPEN trials and the
   * sliding window are all preserved (a smaller `windowSize` clamps only as
   * new outcomes push through `recordOutcome`, so nothing is re-evaluated
   * retroactively). `rules` must be the manager's freshly-resolved object so
   * breaker and gate share one ruleset reference.
   */
  public applyConfig(
    config: CircuitBreakerConfig | undefined,
    rules: ResolvedBreakerRules
  ): void {
    this.config = resolveBreakerConfig(config);
    this.rules = rules;
  }

  public getState(): CircuitBreakerState {
    this.checkCooldownTransition();
    return this.state;
  }

  /**
   * Check if requests are allowed to proceed through this model.
   * - CLOSED: Always allowed.
   * - OPEN: Blocked until cooldown expires. Once expired, transitions to HALF_OPEN.
   * - HALF_OPEN: Allows limited canary probe requests (up to recovery.halfOpen.maxProbes concurrently).
   * Shadow mode never denies an AUTOMATIC trip (accounting keeps running fully);
   * MANUAL trips are operator intent and always enforce.
   */
  public canExecute(): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    this.checkCooldownTransition();

    if (this.state === 'CLOSED') {
      return { allowed: true };
    }

    if (this.state === 'HALF_OPEN') {
      const maxProbes = this.rules.recovery.halfOpen.maxProbes;
      if (this.halfOpenProbes < maxProbes) {
        this.halfOpenProbes++;
        return this.verdict({ allowed: true });
      }
      return this.verdict({
        allowed: false,
        reason: `Model '${this.modelId}' is in HALF_OPEN trial probe state; probe quota (${maxProbes}) reached.`,
      });
    }

    // OPEN state: calculate remaining cooldown
    const now = this.nowFn();
    const remainingMs = Math.max(0, this.cooldownUntil - now);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const remainingHours = (remainingMs / (3600 * 1000)).toFixed(1);

    return this.verdict({
      allowed: false,
      reason: `Model '${this.modelId}' is OPEN (Tripped). Reason: ${this.reason || 'Service degradation'}. Cooldown remaining: ${remainingMs > 3600000 ? remainingHours + 'h' : remainingSec + 's'}.`,
    });
  }

  /**
   * NON-CONSUMING availability check for selection/filtering ("dry checks"):
   * pool building, the eviction landing guard, leader picks, console
   * introspection. (Session-pin EVICTING itself reads the capability
   * `modelHealthView` — a busy canary must never move a pin.)
   * Identical state evaluation to canExecute() but NEVER takes a HALF_OPEN
   * probe slot — only the execution gate (canExecute, called immediately
   * before the upstream call) may consume the canary quota, otherwise
   * lookups starve a recovering model into a permanent HALF_OPEN.
   */
  public peekExecute(): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    this.checkCooldownTransition();

    if (this.state === 'CLOSED') {
      return { allowed: true };
    }

    if (this.state === 'HALF_OPEN') {
      const maxProbes = this.rules.recovery.halfOpen.maxProbes;
      if (this.halfOpenProbes < maxProbes) {
        return this.verdict({ allowed: true });
      }
      return this.verdict({
        allowed: false,
        reason: `Model '${this.modelId}' is in HALF_OPEN trial probe state; probe quota (${maxProbes}) reached.`,
      });
    }

    const now = this.nowFn();
    const remainingMs = Math.max(0, this.cooldownUntil - now);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const remainingHours = (remainingMs / (3600 * 1000)).toFixed(1);

    return this.verdict({
      allowed: false,
      reason: `Model '${this.modelId}' is OPEN (Tripped). Reason: ${this.reason || 'Service degradation'}. Cooldown remaining: ${remainingMs > 3600000 ? remainingHours + 'h' : remainingSec + 's'}.`,
    });
  }

  /**
   * Shadow mode (circuitBreaker.shadow): the state machine ran its full
   * accounting above (slots consumed, ladders advanced, windows filled) — only
   * the verdict flips. MANUAL trips are operator intent, never shadowed
   * (DISABLED/SUSPECT gating lives in the manager and is likewise exempt).
   */
  private verdict(check: { allowed: boolean; reason?: string }): { allowed: boolean; reason?: string } {
    if (this.rules.shadow && this.category !== 'MANUAL') {
      return { allowed: true };
    }
    return check;
  }

  /**
   * Record a successful response.
   * In HALF_OPEN a success counts toward the trial batch; the circuit closes
   * only once recovery.halfOpen.successThreshold successes are in (default 1 =
   * today's canary-closes-on-first-success).
   */
  public recordSuccess(): void {
    const now = this.nowFn();
    this.totalRequests++;
    this.totalSuccesses++;
    this.lastSuccessTime = now;
    this.recordOutcome(true);

    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.rules.recovery.halfOpen.successThreshold) {
        this.closeAfterRecovery();
      } else {
        // Below the threshold the trial completed: release its CONCURRENT slot
        // so the batch can continue dispatching up to maxProbes in flight.
        // (With the default successThreshold=1 this branch is unreachable —
        // the first success closes, exactly today's canary semantics.)
        this.halfOpenProbes = Math.max(0, this.halfOpenProbes - 1);
      }
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  /** Full-recovery close: ladder + window re-armed empty, as today. */
  private closeAfterRecovery(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.halfOpenProbes = 0;
    this.halfOpenSuccesses = 0;
    this.halfOpenEnteredAt = 0;
    this.currentCooldownMs = this.rules.trip.consecutiveFailures.initialCooldownMs;
    this.reason = undefined;
    this.reasonCode = undefined;
    this.reasonParams = undefined;
    this.category = undefined;
    this.cooldownUntil = 0;
    this.trippedAt = 0;
    // Re-arm the sliding window EMPTY (same as manual reset): stale failures
    // from the outage would otherwise let one transient blip push the rate
    // back over the threshold right after recovery ("fixed, then instantly
    // broken again"). The canary's own success needs no slot — it is proven.
    this.outcomeWindow = [];
  }

  /**
   * Release a consumed HALF_OPEN probe slot for a NON-PENALTY outcome: the
   * probe request COMPLETED but is not evidence about upstream health
   * (disabled counting class / CLIENT_ERROR). Without the release the quota
   * stays exhausted and the breaker sticks in HALF_OPEN forever.
   */
  public releaseProbeSlot(): void {
    if (this.state === 'HALF_OPEN' && this.halfOpenProbes > 0) {
      this.halfOpenProbes--;
    }
  }

  /**
   * Record a failed response and decide whether to trip the breaker.
   * Rule gating (counting/toggles/hard durations) lives in the manager gate —
   * what reaches this method is an effective diagnosis plus, for hard trips,
   * a resolved duration via recordHardTrip(); the diagnosis NEVER steers a
   * hard-trip length through minCooldownMs.
   */
  public recordFailure(diagnosis: ErrorDiagnosis): void {
    if (!this.config.enabled) return;

    // Client errors (400, context length exceeded, content filter) are NOT upstream failures
    if (!diagnosis.shouldTripBreaker) {
      this.releaseProbeSlot();
      return;
    }

    this.countFailure();

    // 1. Hard Trip (direct-construction path; the production manager gate
    //    calls recordHardTrip with the rule-resolved duration instead).
    if (diagnosis.hardTrip) {
      this.trip(
        diagnosis.reason,
        diagnosis.category,
        this.hardTripCooldownMs(diagnosis),
        diagnosis.reasonCode,
        diagnosis.reasonParams
      );
      return;
    }

    // 2. Failure during HALF_OPEN canary trial: resolve through recovery.onCanaryFailure.
    if (this.state === 'HALF_OPEN') {
      this.resolveHalfOpenFailure('probe_failure', diagnosis);
      return;
    }

    // 3. Consecutive failure threshold check (trip.consecutiveFailures)
    const cf = this.rules.trip.consecutiveFailures;
    if (cf.enabled && this.consecutiveFailures >= cf.threshold) {
      const multiplierFactor = Math.max(0, this.consecutiveFailures - cf.threshold);
      const computedCooldown = Math.min(
        cf.initialCooldownMs * Math.pow(cf.cooldownMultiplier, multiplierFactor),
        cf.maxCooldownMs
      );
      this.currentCooldownMs = Math.max(diagnosis.minCooldownMs || 0, computedCooldown);
      this.trip(
        `Consecutive failure threshold reached (${this.consecutiveFailures}/${cf.threshold}): ${diagnosis.reason}`,
        diagnosis.category,
        this.currentCooldownMs,
        'breaker.consecutive',
        CircuitBreaker.wrappedParams(diagnosis, {
          count: this.consecutiveFailures,
          threshold: cf.threshold,
        })
      );
      return;
    }

    // 4. Sliding window failure rate check (trip.failureRate). The rate is
    //    evaluated only once minCalls recorded outcomes fill the shared window
    //    (default = windowSize, i.e. today's full-window-only behavior).
    const fr = this.rules.trip.failureRate;
    if (fr.enabled && this.outcomeWindow.length >= fr.minCalls) {
      const failedCount = this.outcomeWindow.filter(v => !v).length;
      const failureRate = failedCount / this.outcomeWindow.length;
      if (failureRate >= fr.failureRate) {
        this.currentCooldownMs = Math.max(diagnosis.minCooldownMs || 0, fr.cooldownMs);
        this.trip(
          `Sliding window failure rate exceeded (${(failureRate * 100).toFixed(0)}% >= ${(fr.failureRate * 100).toFixed(0)}%): ${diagnosis.reason}`,
          diagnosis.category,
          this.currentCooldownMs,
          'breaker.rate_window',
          CircuitBreaker.wrappedParams(diagnosis, {
            rate: Math.round(failureRate * 100),
            threshold: Math.round(fr.failureRate * 100),
          })
        );
      }
    }
  }

  /**
   * Count a failure as upstream evidence and hard-trip immediately for the
   * RULE-RESOLVED duration (trip.quota/auth.cooldownMs or the clamped
   * Retry-After) — resolved by the manager gate, never by the diagnosis.
   */
  public recordHardTrip(diagnosis: ErrorDiagnosis, cooldownMs: number): void {
    if (!this.config.enabled) return;
    if (!diagnosis.shouldTripBreaker) {
      this.releaseProbeSlot();
      return;
    }
    this.countFailure();
    this.trip(diagnosis.reason, diagnosis.category, cooldownMs, diagnosis.reasonCode, diagnosis.reasonParams);
  }

  private countFailure(): void {
    const now = this.nowFn();
    this.totalRequests++;
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureTime = now;
    this.recordOutcome(false);
  }

  /**
   * Hard-trip length for the direct-caller branch above, from the resolved
   * rules by category. The global maxCooldownMs stays the Retry-After clamp
   * ceiling (spec: it caps any derived cooldown, not a per-rule knob); the
   * quota rule's resolved duration is the generic fallback for hard
   * diagnoses without a dedicated rule (the classifier never emits those).
   */
  private hardTripCooldownMs(diagnosis: ErrorDiagnosis): number {
    const t = this.rules.trip;
    switch (diagnosis.category) {
      case 'QUOTA_EXHAUSTED':
        return t.quota.cooldownMs;
      case 'AUTHENTICATION_ERROR':
        return t.auth.cooldownMs;
      case 'RATE_LIMITED': {
        const raMs = diagnosis.retryAfterSeconds !== undefined ? diagnosis.retryAfterSeconds * 1000 : 0;
        return Math.max(t.rateLimit.minCooldownMs, Math.min(raMs, this.config.maxCooldownMs));
      }
      default:
        return t.quota.cooldownMs;
    }
  }

  /**
   * Resolve a HALF_OPEN trial that did not reach successThreshold: a probe
   * failure, a trial batch exhausted with successes below the threshold, or
   * the maxWaitMs wait cap expiring. All three go through recovery.onCanaryFailure.
   */
  private resolveHalfOpenFailure(
    kind: 'probe_failure' | 'batch_short' | 'max_wait',
    diagnosis?: ErrorDiagnosis
  ): void {
    const rec = this.rules.recovery;
    let mode = rec.onCanaryFailure;
    // Never defeat an operator takedown: MANUAL breakers ignore 'close'.
    if (mode === 'close' && this.category === 'MANUAL') {
      mode = 'backoff';
    }
    if (mode === 'close') {
      // Optimistic close — keep consecutiveFailures and currentCooldownMs so
      // the very next counted failure re-trips with the escalated ladder.
      this.state = 'CLOSED';
      this.halfOpenProbes = 0;
      this.halfOpenSuccesses = 0;
      this.halfOpenEnteredAt = 0;
      this.cooldownUntil = 0;
      this.trippedAt = 0;
      this.reason = undefined;
      this.reasonCode = undefined;
      this.reasonParams = undefined;
      this.category = undefined;
      return;
    }
    this.currentCooldownMs =
      mode === 'initial'
        ? this.rules.trip.consecutiveFailures.initialCooldownMs // re-OPEN at the initial ladder rung
        : Math.min(this.currentCooldownMs * rec.cooldownMultiplier, this.config.maxCooldownMs);

    if (diagnosis) {
      this.trip(
        `Canary probe failed: ${diagnosis.reason}`,
        diagnosis.category,
        this.currentCooldownMs,
        'breaker.canary',
        CircuitBreaker.wrappedParams(diagnosis, {})
      );
      return;
    }
    const reason =
      kind === 'max_wait'
        ? `Half-open wait limit exceeded (${rec.halfOpen.maxWaitMs}ms in HALF_OPEN, ${this.halfOpenSuccesses}/${rec.halfOpen.successThreshold} successes)`
        : `Half-open trial batch exhausted (${this.halfOpenSuccesses}/${rec.halfOpen.successThreshold} successes)`;
    this.trip(reason, this.category, this.currentCooldownMs, 'breaker.canary', {
      cause_code: this.reasonCode ?? '',
      detail: reason,
    });
  }

  /**
   * Immediately trip the circuit breaker into OPEN state
   */
  public trip(
    reason: string,
    category: ErrorCategory = 'SERVICE_UNAVAILABLE',
    cooldownMs: number,
    reasonCode?: BreakerReasonCode,
    reasonParams?: ReasonParams
  ): void {
    const now = this.nowFn();
    this.state = 'OPEN';
    this.trippedAt = now;
    this.cooldownUntil = now + cooldownMs;
    this.currentCooldownMs = cooldownMs;
    this.reason = reason;
    this.reasonCode = reasonCode;
    this.reasonParams = reasonParams;
    this.category = category;
    this.halfOpenProbes = 0;
    this.halfOpenSuccesses = 0;
    this.halfOpenEnteredAt = 0;
  }

  /**
   * Params for a wrapped trigger (canary/consecutive/rate_window): the inner
   * cause rides along as `cause_code` with its params flattened into the same
   * map, and `detail` keeps the verbatim English for unresolvable codes.
   */
  private static wrappedParams(diagnosis: ErrorDiagnosis, extra: ReasonParams): ReasonParams {
    const params: ReasonParams = {
      ...diagnosis.reasonParams,
      cause_code: diagnosis.reasonCode ?? '',
      detail: diagnosis.reason,
      ...extra,
    };
    return params;
  }

  /**
   * Manually reset the breaker to CLOSED state (e.g. after admin recharged quota)
   */
  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.currentCooldownMs = this.rules.trip.consecutiveFailures.initialCooldownMs;
    this.cooldownUntil = 0;
    this.trippedAt = 0;
    this.reason = undefined;
    this.reasonCode = undefined;
    this.reasonParams = undefined;
    this.category = undefined;
    this.halfOpenProbes = 0;
    this.halfOpenSuccesses = 0;
    this.halfOpenEnteredAt = 0;
    this.outcomeWindow = [];
  }

  /**
   * Return real-time observability snapshot
   */
  public getSnapshot(): CircuitBreakerSnapshot {
    this.checkCooldownTransition();
    const now = this.nowFn();
    return {
      modelId: this.modelId,
      provider: this.provider,
      tier: this.tier,
      state: this.state,
      reason: this.reason,
      reasonCode: this.reasonCode,
      reasonParams: this.reasonParams,
      category: this.category,
      consecutiveFailures: this.consecutiveFailures,
      totalRequests: this.totalRequests,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      lastFailureTime: this.lastFailureTime || undefined,
      lastSuccessTime: this.lastSuccessTime || undefined,
      trippedAt: this.trippedAt || undefined,
      cooldownUntil: this.cooldownUntil || undefined,
      remainingCooldownMs: Math.max(0, this.cooldownUntil - now),
      currentCooldownMs: this.currentCooldownMs,
      halfOpenProbes: this.halfOpenProbes,
      halfOpenSuccesses: this.halfOpenSuccesses,
      halfOpenEnteredAt: this.halfOpenEnteredAt || undefined,
    };
  }

  /**
   * The full mutable state for disk. Unlike
   * `getSnapshot()` this never transitions the machine and never derives
   * display values; it copies the raw fields verbatim so a restart resumes the
   * exact same cooldown/backoff/window position.
   */
  public toRecord(): BreakerRecord {
    const rec: BreakerRecord = {
      modelId: this.modelId,
      provider: this.provider,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      totalRequests: this.totalRequests,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      trippedAt: this.trippedAt,
      cooldownUntil: this.cooldownUntil,
      currentCooldownMs: this.currentCooldownMs,
      halfOpenProbes: this.halfOpenProbes,
      halfOpenSuccesses: this.halfOpenSuccesses,
      halfOpenEnteredAt: this.halfOpenEnteredAt,
      outcomeWindow: [...this.outcomeWindow],
    };
    if (this.tier) rec.tier = this.tier;
    if (this.reason !== undefined) rec.reason = this.reason;
    if (this.reasonCode !== undefined) rec.reasonCode = this.reasonCode;
    if (this.reasonParams !== undefined) rec.reasonParams = this.reasonParams;
    if (this.category !== undefined) rec.category = this.category;
    return rec;
  }

  /**
   * Hydrate mutable state from a persisted record (identity stays the
   * registry's — provider/tier come from the current config, not the file).
   * A record with an expired cooldown restores as OPEN and flips to HALF_OPEN
   * on the first gate check, exactly like a long-lived process would have.
   */
  public applyRecord(rec: BreakerRecord): void {
    this.state = rec.state;
    this.consecutiveFailures = rec.consecutiveFailures;
    this.totalRequests = rec.totalRequests;
    this.totalSuccesses = rec.totalSuccesses;
    this.totalFailures = rec.totalFailures;
    this.lastFailureTime = rec.lastFailureTime;
    this.lastSuccessTime = rec.lastSuccessTime;
    this.trippedAt = rec.trippedAt;
    // Wall-clock guard: the liveness invariant is remaining <= ladder
    // position. A clock jump BACKWARD while the gateway was off would
    // otherwise stretch the cooldown (12h quota + 24h rewind = 36h block).
    // A forward jump shortens it — fail-open, no persistence made that
    // better; known trade-off.
    this.cooldownUntil = Math.min(rec.cooldownUntil, this.nowFn() + rec.currentCooldownMs);
    this.currentCooldownMs = rec.currentCooldownMs;
    // A snapshot can be flushed while a canary is in flight (debounce timer or
    // shutdown flush landing between probe dispatch and its result), which would
    // restore HALF_OPEN with an exhausted quota — and the only exits from
    // HALF_OPEN are recordSuccess/recordFailure, which the gate would never let
    // happen. Refresh the whole trial batch on restore (probes AND successes,
    // spec rule #10): worst case one extra canary round. The maxWaitMs clock
    // re-arms from now too — the downtime must not consume the wait budget.
    this.halfOpenProbes = rec.state === 'HALF_OPEN' ? 0 : rec.halfOpenProbes;
    this.halfOpenSuccesses = rec.state === 'HALF_OPEN' ? 0 : rec.halfOpenSuccesses;
    this.halfOpenEnteredAt = rec.state === 'HALF_OPEN' ? this.nowFn() : rec.halfOpenEnteredAt;
    // Config windowSize change: the persisted slice re-fits the ring (invariant 5 note).
    this.outcomeWindow = rec.outcomeWindow.slice(-this.rules.trip.failureRate.windowSize);
    this.reason = rec.reason;
    this.reasonCode = rec.reasonCode;
    this.reasonParams = rec.reasonParams;
    this.category = rec.category;
  }

  private checkCooldownTransition(): void {
    const now = this.nowFn();
    if (this.state === 'OPEN') {
      if (now >= this.cooldownUntil) {
        this.state = 'HALF_OPEN';
        this.halfOpenProbes = 0;
        this.halfOpenSuccesses = 0;
        this.halfOpenEnteredAt = now;
      }
      return;
    }
    if (this.state === 'HALF_OPEN') {
      const ho = this.rules.recovery.halfOpen;
      // maxWaitMs (0 = wait forever, today's shape): a trial that may not
      // resolve on traffic resolves through onCanaryFailure instead.
      if (ho.maxWaitMs > 0 && now - this.halfOpenEnteredAt >= ho.maxWaitMs) {
        this.resolveHalfOpenFailure('max_wait');
        return;
      }
      // Spec rule #10 "short batch": with a multi-probe trial (threshold > 1),
      // every concurrent slot consumed while recorded successes are below the
      // threshold resolves through onCanaryFailure. With the default
      // threshold=1 this never fires — a stuck single canary lingers as today
      // (bounded by maxWaitMs when configured), never re-tripping an
      // in-flight probe's model prematurely.
      if (
        ho.successThreshold > 1 &&
        this.halfOpenProbes >= ho.maxProbes &&
        this.halfOpenSuccesses < ho.successThreshold
      ) {
        this.resolveHalfOpenFailure('batch_short');
      }
    }
  }

  private recordOutcome(success: boolean): void {
    this.outcomeWindow.push(success);
    if (this.outcomeWindow.length > this.rules.trip.failureRate.windowSize) {
      this.outcomeWindow.shift();
    }
  }
}
