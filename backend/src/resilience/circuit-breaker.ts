import {
  BreakerReasonCode,
  BreakerRecord,
  CircuitBreakerConfig,
  CircuitBreakerSnapshot,
  CircuitBreakerState,
  ErrorCategory,
  ErrorDiagnosis,
} from './types.js';
import { ReasonParams, TierLevel } from '../types/router.js';

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: Required<CircuitBreakerConfig> = {
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
  accountAffinity: {
    cacheTtlMs: 300_000,
  },
};

export class CircuitBreaker {
  public readonly modelId: string;
  public readonly provider: string;
  public readonly tier?: TierLevel;

  private config: Required<CircuitBreakerConfig>;
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
    nowFn: () => number = Date.now
  ) {
    this.modelId = modelId;
    this.provider = provider;
    this.tier = tier;
    this.nowFn = nowFn;
    this.config = {
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
      accountAffinity: {
        cacheTtlMs:
          config?.accountAffinity?.cacheTtlMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.accountAffinity.cacheTtlMs,
      },
    };
    this.currentCooldownMs = this.config.initialCooldownMs;
  }

  public getState(): CircuitBreakerState {
    this.checkCooldownTransition();
    return this.state;
  }

  /**
   * Check if requests are allowed to proceed through this model.
   * - CLOSED: Always allowed.
   * - OPEN: Blocked until cooldown expires. Once expired, transitions to HALF_OPEN.
   * - HALF_OPEN: Allows limited canary probe requests.
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
      if (this.halfOpenProbes < this.config.halfOpenMaxProbes) {
        this.halfOpenProbes++;
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Model '${this.modelId}' is in HALF_OPEN trial probe state; probe quota (${this.config.halfOpenMaxProbes}) reached.`,
      };
    }

    // OPEN state: calculate remaining cooldown
    const now = this.nowFn();
    const remainingMs = Math.max(0, this.cooldownUntil - now);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const remainingHours = (remainingMs / (3600 * 1000)).toFixed(1);

    return {
      allowed: false,
      reason: `Model '${this.modelId}' is OPEN (Tripped). Reason: ${this.reason || 'Service degradation'}. Cooldown remaining: ${remainingMs > 3600000 ? remainingHours + 'h' : remainingSec + 's'}.`,
    };
  }

  /**
   * NON-CONSUMING availability check for selection/filtering ("dry checks"):
   * pool building, session self-healing, leader picks, console introspection.
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
      if (this.halfOpenProbes < this.config.halfOpenMaxProbes) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Model '${this.modelId}' is in HALF_OPEN trial probe state; probe quota (${this.config.halfOpenMaxProbes}) reached.`,
      };
    }

    const now = this.nowFn();
    const remainingMs = Math.max(0, this.cooldownUntil - now);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const remainingHours = (remainingMs / (3600 * 1000)).toFixed(1);

    return {
      allowed: false,
      reason: `Model '${this.modelId}' is OPEN (Tripped). Reason: ${this.reason || 'Service degradation'}. Cooldown remaining: ${remainingMs > 3600000 ? remainingHours + 'h' : remainingSec + 's'}.`,
    };
  }

  /**
   * Record a successful response.
   * If in HALF_OPEN state, this confirms upstream recovery and closes the circuit!
   */
  public recordSuccess(): void {
    const now = this.nowFn();
    this.totalRequests++;
    this.totalSuccesses++;
    this.lastSuccessTime = now;
    this.recordOutcome(true);

    if (this.state === 'HALF_OPEN') {
      // Canary succeeded! Restore full operational status
      this.state = 'CLOSED';
      this.consecutiveFailures = 0;
      this.halfOpenProbes = 0;
      this.currentCooldownMs = this.config.initialCooldownMs;
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
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Record a failed response and decide whether to trip the breaker.
   */
  public recordFailure(diagnosis: ErrorDiagnosis): void {
    if (!this.config.enabled) return;

    // Client errors (400, context length exceeded, content filter) are NOT upstream failures
    if (!diagnosis.shouldTripBreaker) {
      // A consumed HALF_OPEN canary slot must be released here: the probe
      // request COMPLETED (with a non-penalty outcome), otherwise the quota
      // stays exhausted and the breaker sticks in HALF_OPEN forever.
      if (this.state === 'HALF_OPEN' && this.halfOpenProbes > 0) {
        this.halfOpenProbes--;
      }
      return;
    }

    const now = this.nowFn();
    this.totalRequests++;
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureTime = now;
    this.recordOutcome(false);

    // 1. Hard Trip: Quota exhausted (402) or Auth failure (401)
    if (diagnosis.hardTrip) {
      const cooldownMs = diagnosis.suggestedCooldownMs || this.config.quotaCooldownMs;
      this.trip(diagnosis.reason, diagnosis.category, cooldownMs, diagnosis.reasonCode, diagnosis.reasonParams);
      return;
    }

    // 2. Failure during HALF_OPEN canary trial: immediately trip again with escalated cooldown
    if (this.state === 'HALF_OPEN') {
      this.currentCooldownMs = Math.min(
        this.currentCooldownMs * this.config.cooldownMultiplier,
        this.config.maxCooldownMs
      );
      this.trip(
        `Canary probe failed: ${diagnosis.reason}`,
        diagnosis.category,
        this.currentCooldownMs,
        'breaker.canary',
        CircuitBreaker.wrappedParams(diagnosis, {})
      );
      return;
    }

    // 3. Consecutive failure threshold check
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      const multiplierFactor = Math.max(0, this.consecutiveFailures - this.config.failureThreshold);
      const computedCooldown = Math.min(
        this.config.initialCooldownMs * Math.pow(this.config.cooldownMultiplier, multiplierFactor),
        this.config.maxCooldownMs
      );
      this.currentCooldownMs = Math.max(diagnosis.suggestedCooldownMs || 0, computedCooldown);
      this.trip(
        `Consecutive failure threshold reached (${this.consecutiveFailures}/${this.config.failureThreshold}): ${diagnosis.reason}`,
        diagnosis.category,
        this.currentCooldownMs,
        'breaker.consecutive',
        CircuitBreaker.wrappedParams(diagnosis, {
          count: this.consecutiveFailures,
          threshold: this.config.failureThreshold,
        })
      );
      return;
    }

    // 4. Sliding window failure rate check
    if (this.outcomeWindow.length >= this.config.slidingWindowSize) {
      const failedCount = this.outcomeWindow.filter(v => !v).length;
      const failureRate = failedCount / this.outcomeWindow.length;
      if (failureRate >= this.config.failureRateThreshold) {
        this.currentCooldownMs = Math.max(diagnosis.suggestedCooldownMs || 0, this.config.initialCooldownMs);
        this.trip(
          `Sliding window failure rate exceeded (${(failureRate * 100).toFixed(0)}% >= ${(this.config.failureRateThreshold * 100).toFixed(0)}%): ${diagnosis.reason}`,
          diagnosis.category,
          this.currentCooldownMs,
          'breaker.rate_window',
          CircuitBreaker.wrappedParams(diagnosis, {
            rate: Math.round(failureRate * 100),
            threshold: Math.round(this.config.failureRateThreshold * 100),
          })
        );
      }
    }
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
    this.currentCooldownMs = this.config.initialCooldownMs;
    this.cooldownUntil = 0;
    this.trippedAt = 0;
    this.reason = undefined;
    this.reasonCode = undefined;
    this.reasonParams = undefined;
    this.category = undefined;
    this.halfOpenProbes = 0;
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
    };
  }

  /**
   * ADR-0008 amendment (2026-10-14) — the full mutable state for disk. Unlike
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
    // better; noted in ADR-0008.
    this.cooldownUntil = Math.min(rec.cooldownUntil, this.nowFn() + rec.currentCooldownMs);
    this.currentCooldownMs = rec.currentCooldownMs;
    // A snapshot can be flushed while a canary is in flight (debounce timer or
    // shutdown flush landing between probe dispatch and its result), which would
    // restore HALF_OPEN with an exhausted quota — and the only exits from
    // HALF_OPEN are recordSuccess/recordFailure, which the gate would never let
    // happen. Refresh the probe quota on restore: worst case one extra canary.
    this.halfOpenProbes = rec.state === 'HALF_OPEN' ? 0 : rec.halfOpenProbes;
    this.outcomeWindow = rec.outcomeWindow.slice(-this.config.slidingWindowSize);
    this.reason = rec.reason;
    this.reasonCode = rec.reasonCode;
    this.reasonParams = rec.reasonParams;
    this.category = rec.category;
  }

  private checkCooldownTransition(): void {
    if (this.state === 'OPEN') {
      const now = this.nowFn();
      if (now >= this.cooldownUntil) {
        this.state = 'HALF_OPEN';
        this.halfOpenProbes = 0;
      }
    }
  }

  private recordOutcome(success: boolean): void {
    this.outcomeWindow.push(success);
    if (this.outcomeWindow.length > this.config.slidingWindowSize) {
      this.outcomeWindow.shift();
    }
  }
}
