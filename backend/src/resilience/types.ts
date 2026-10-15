import { ReasonParams, TierLevel } from '../types/router.js';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

// Runtime array + derived union: the sanitizer needs a membership list, and
// a const tuple keeps vocabulary and type from drifting apart.
export const ERROR_CATEGORIES = [
  'QUOTA_EXHAUSTED',      // out of balance / quota burned down / suspended for non-payment (HTTP 402, insufficient_quota)
  'AUTHENTICATION_ERROR', // API Key invalid or unauthorized (HTTP 401)
  'RATE_LIMITED',         // rate limit, TPM/RPM exceeded (HTTP 429)
  'SERVICE_UNAVAILABLE',  // upstream down, gateway timeout, connection refused (HTTP 500/502/503/504, ETIMEDOUT, ECONNREFUSED)
  'CLIENT_ERROR',         // bad client input, context length exceeded (HTTP 400, context length exceeded)
  'MANUAL',               // operator tripped the breaker from the console (deliberate takedown, not an auto-detected failure)
  'UNKNOWN',
] as const;

export type ErrorCategory = typeof ERROR_CATEGORIES[number];

export type NetworkFailureCause =
  | 'CONNECTION_RESET'       // connection reset/aborted: ECONNRESET, ECONNABORTED, socket hang up, EPIPE
  | 'NETWORK_TIMEOUT'        // timeout jitter: ETIMEDOUT, ESOCKETTIMEDOUT, HTTP 504 Gateway Timeout, AbortError
  | 'GATEWAY_ERROR'          // gateway temporarily unavailable: HTTP 502 Bad Gateway, HTTP 503 Service Unavailable, Cloudflare 520-524
  | 'RATE_LIMIT_BURST'       // small transient 429: HTTP 429 with Retry-After <= threshold (e.g. 2s)
  | 'DNS_ERROR'              // transient DNS resolution jitter: EAI_AGAIN, ENOTFOUND
  | 'SERVER_INTERNAL_ERROR'  // upstream HTTP 500 internal error
  | 'HARD_FAILURE'           // 402 unpaid, 401 dead key, 400 bad params (never retry in place)
  | 'UNKNOWN';

/**
 * Blast radius of a trip once the failure is attributed
 * to one credential of a multi-credential provider.
 *  pair    = (model × credential) only — per-model rate limit, uncertain errors
 *  account = this credential everywhere — account quota / dead key
 *  model   = this model for every credential — outage / 5xx / network
 * Absent on a diagnosis means "model", today's pre-P3 semantics. The same
 * vocabulary serves manual (console/REST) trips: 'model' is the legacy scope.
 */
export type TripScope = 'pair' | 'account' | 'model';

/**
 * Machine-readable trip-reason vocabulary (the routing reasonCode convention).
 * Cause codes come from the error classifier; on a hard trip the snapshot
 * carries the cause code directly. Trigger codes (canary/consecutive/
 * rate_window) wrap a cause: its code rides along as `reasonParams.cause_code`
 * and its params are flattened into the same map, so the console renders the
 * inner template from the same vars. `detail` always carries the verbatim
 * English for unresolvable codes / free-form operator text.
 */
export const BREAKER_REASON_CODES = [
  'breaker.quota',        // 402 / insufficient_quota — cause
  'breaker.auth',         // 401 / invalid key — cause
  'breaker.rate_limit',   // 429 — cause
  'breaker.network',      // 5xx / timeout / jitter — cause
  'breaker.unknown',      // unclassified upstream error — cause
  'breaker.canary',       // HALF_OPEN probe failure — trigger
  'breaker.consecutive',  // consecutive-failure threshold — trigger
  'breaker.rate_window',  // sliding-window failure rate — trigger
  'breaker.manual',       // console/REST operator trip — trigger
] as const;

export type BreakerReasonCode = typeof BREAKER_REASON_CODES[number];

export interface ErrorDiagnosis {
  category: ErrorCategory;
  networkCause?: NetworkFailureCause; // fine-grained network jitter vs. hard failure reason
  statusCode?: number;
  isRetriable: boolean;               // eligible for failover to another candidate
  isInPlaceRetriable: boolean;        // safe to retry the SAME model in place to rescue the KV cache
  shouldTripBreaker: boolean;
  hardTrip: boolean; // trip the breaker immediately, no need to accumulate failures (e.g. 402 unpaid)
  /**
   * Cooldown FLOOR for the statistical trip path (breaker takes
   * max(minCooldownMs, computed ladder/rate cooldown)). Hard-trip lengths are
   * resolved by the manager gate from the trip.* rules — this field never
   * steers them (spec: Internal vocabulary refactor).
   */
  minCooldownMs?: number;
  reason: string;
  /** Machine-readable companion of `reason` (BreakerReasonCode cause codes) —
   *  the console localizes from it; `reason` stays the verbatim English for
   *  logs, gateway errors, and unknown-code fallback. */
  reasonCode?: BreakerReasonCode;
  reasonParams?: ReasonParams;
  retryAfterSeconds?: number;
  rawError?: any;
  /**
   * Set ONLY when the failure carried a credential
   * attribution (`UpstreamError.usedCredentialKeyHashPrefix`), i.e. the request ran
   * through a provider credential chain. Without it the breaker keeps the
   * model-level semantics it has always had (single-credential degeneracy).
   */
  tripScope?: TripScope;
  /** Account-scope failures that mean "this account is administratively bad" (dead key) — SUSPECT flag. */
  accountSuspect?: boolean;
}

/** Blast-radius override for one trip rule ('auto' = keep the classifier's diagnosed scope). */
export type BreakerScopeOverride = 'auto' | TripScope;

/** HALF_OPEN re-trip policy (spec rule #9): escalated backoff / reset to the initial ladder / optimistic close. */
export type OnCanaryFailureMode = 'backoff' | 'initial' | 'close';

// ─── circuitBreaker.rules — the configurable rule tree (spec v3) ────────────
// Every field is optional; UNSET means "fall back to the global knob / today's
// behavior", so a legacy config without `rules` behaves byte-for-byte as before.
// Cooldown floors are always `minCooldownMs` — "suggested" is banned from this
// vocabulary (the manager gate resolves durations; the diagnosis field is only
// a floor on the statistical path).

/** A counted error class: whether it is recorded at all, and the floor its trips inherit. */
export interface BreakerCountingClassRule {
  enabled?: boolean;
  minCooldownMs?: number;
}

export interface BreakerCountingConfig {
  serverErrors?: BreakerCountingClassRule;
  unknownErrors?: BreakerCountingClassRule;
  /** Countedness of 429 has NO toggle (the classifier always counts it); this owns only the no-Retry-After floor. */
  rateLimitErrors?: { minCooldownMs?: number };
  /** 400/422: default OFF = today's non-penalizing CLIENT_ERROR. No cooldown param — the tripping rule's ladder applies. */
  clientErrors?: { enabled?: boolean };
}

export interface BreakerQuotaTripRule {
  enabled?: boolean;
  cooldownMs?: number; // default: quotaCooldownMs
  scope?: BreakerScopeOverride;
}

export interface BreakerAuthTripRule {
  enabled?: boolean;
  cooldownMs?: number; // default: quotaCooldownMs
  markSuspect?: boolean; // default true; false stops NEW SUSPECT flags only
  scope?: BreakerScopeOverride;
}

export interface BreakerRateLimitTripRule {
  enabled?: boolean; // OFF = long-Retry-After 429 downgrades to a counted statistical failure (NOT ignored)
  hardTripAboveMs?: number; // hard/counted boundary; default: retry.inplace.maxRateLimitWaitMs
  minCooldownMs?: number; // floor of the Retry-After-derived cooldown; default today's hardcoded 1000
  scope?: BreakerScopeOverride;
}

export interface BreakerConsecutiveFailuresTripRule {
  enabled?: boolean;
  threshold?: number; // default: failureThreshold
  initialCooldownMs?: number; // default: initialCooldownMs
  cooldownMultiplier?: number; // default: cooldownMultiplier
  maxCooldownMs?: number; // default: maxCooldownMs
  scope?: BreakerScopeOverride;
}

export interface BreakerFailureRateTripRule {
  enabled?: boolean;
  windowSize?: number; // sizes the shared outcome ring buffer; default: slidingWindowSize
  failureRate?: number; // ratio 0..1; default: failureRateThreshold
  minCalls?: number; // rate evaluated only with >= this many recorded calls; default: windowSize, clamp <= windowSize
  cooldownMs?: number; // default: initialCooldownMs
  scope?: BreakerScopeOverride;
}

export interface BreakerTripConfig {
  quota?: BreakerQuotaTripRule;
  auth?: BreakerAuthTripRule;
  rateLimit?: BreakerRateLimitTripRule;
  consecutiveFailures?: BreakerConsecutiveFailuresTripRule;
  failureRate?: BreakerFailureRateTripRule;
}

export interface BreakerHalfOpenRecoveryConfig {
  maxProbes?: number; // trial budget AND the active-prober per-cycle budget; default: halfOpenMaxProbes, clamp >= 1
  successThreshold?: number; // successes required to CLOSE; default 1, clamp <= maxProbes
  maxWaitMs?: number; // cap on lingering in HALF_OPEN; default 0 = wait forever, expiry resolves via onCanaryFailure
}

export interface BreakerRecoveryConfig {
  onCanaryFailure?: OnCanaryFailureMode; // default 'backoff' (today); 'close' never applies to MANUAL breakers
  cooldownMultiplier?: number; // ladder factor for 'backoff'; default: cooldownMultiplier
  halfOpen?: BreakerHalfOpenRecoveryConfig;
}

export interface BreakerRulesConfig {
  counting?: BreakerCountingConfig;
  trip?: BreakerTripConfig;
  recovery?: BreakerRecoveryConfig;
}

/** Fully-resolved effective ruleset (startup resolution per spec invariant 5): every parameter carries a concrete value. */
export interface ResolvedBreakerRules {
  shadow: boolean;
  counting: {
    serverErrors: { enabled: boolean; minCooldownMs: number };
    unknownErrors: { enabled: boolean; minCooldownMs: number };
    rateLimitErrors: { minCooldownMs: number };
    clientErrors: { enabled: boolean };
  };
  trip: {
    quota: { enabled: boolean; cooldownMs: number; scope: BreakerScopeOverride };
    auth: { enabled: boolean; cooldownMs: number; markSuspect: boolean; scope: BreakerScopeOverride };
    rateLimit: { enabled: boolean; hardTripAboveMs: number; minCooldownMs: number; scope: BreakerScopeOverride };
    consecutiveFailures: {
      enabled: boolean;
      threshold: number;
      initialCooldownMs: number;
      cooldownMultiplier: number;
      maxCooldownMs: number;
      scope: BreakerScopeOverride;
    };
    failureRate: {
      enabled: boolean;
      windowSize: number;
      failureRate: number;
      minCalls: number;
      cooldownMs: number;
      scope: BreakerScopeOverride;
    };
  };
  recovery: {
    onCanaryFailure: OnCanaryFailureMode;
    cooldownMultiplier: number;
    halfOpen: { maxProbes: number; successThreshold: number; maxWaitMs: number };
  };
}

/** Banner state of automatic tripping (five-switch predicate, spec "Zero-rule state"). */
export type AutomaticTrippingStatus = 'on' | 'partly_off' | 'all_off';

/** Guardrails-snapshot view of the effective ruleset for the UI banner. */
export interface BreakerRulesStatus {
  automatic: AutomaticTrippingStatus;
  shadow: boolean;
  rules: ResolvedBreakerRules;
}

export interface CircuitBreakerPersistenceConfig {
  debounceMs?: number; // breaker-state file flush debounce; default 1000
}

export interface CircuitBreakerConfig {
  enabled?: boolean;
  failureThreshold?: number; // consecutive 5xx/outage failures before tripping (default: 3)
  slidingWindowSize?: number; // request sliding window size (default: 20)
  failureRateThreshold?: number; // error-rate threshold inside the window (default: 0.5 = 50%)
  initialCooldownMs?: number; // initial cooldown after the first trip (default: 30000 = 30s)
  maxCooldownMs?: number; // cooldown ceiling (default: 18000000 = 5h)
  cooldownMultiplier?: number; // backoff multiplier between trips (default: 2.0)
  quotaCooldownMs?: number; // cooldown for 402 / quota exhaustion (default: 43200000 = 12h)
  halfOpenMaxProbes?: number; // max concurrent HALF_OPEN probes (default: 1)
  activeProbing?: {
    enabled?: boolean;
    intervalMs?: number; // background liveness sweep interval (default: 60000 = 1min)
  };
  /**
   * Session↔account affinity window. A session idle
   * past this window is re-selected as if new (the upstream prompt cache is
   * gone anyway, so the switch is free). Default 300000 = the Anthropic
   * cache TTL (5 min, 2026-03-06); OpenAI caches are load-dependent.
   */
  accountAffinity?: {
    cacheTtlMs?: number;
  };
  /** Per-rule toggles/params (spec docs/design/circuit-breaker-rules-config.md); absent = today's behavior byte-for-byte. */
  rules?: BreakerRulesConfig;
  /** Shadow mode: rules evaluate and record fully (ladders, windows, snapshots), the gate verdict never denies. */
  shadow?: boolean;
  /** Breaker-memory flush policy (read by the boot path when constructing the BreakerStateStore). */
  persistence?: CircuitBreakerPersistenceConfig;
}

export interface CircuitBreakerSnapshot {
  modelId: string;
  provider: string;
  tier?: TierLevel;
  state: CircuitBreakerState;
  /**
   * Present only on a PAIR breaker snapshot (model × this
   * credential's display-safe keyHash prefix). Absent = the model breaker,
   * which is what every pre-P3 consumer already reads.
   */
  keyHashPrefix?: string;
  reason?: string;
  /** Trip trigger/cause code/params (BreakerReasonCode); absent = pre-code trip. */
  reasonCode?: BreakerReasonCode;
  reasonParams?: ReasonParams;
  category?: ErrorCategory;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  trippedAt?: number;
  cooldownUntil?: number;
  remainingCooldownMs: number;
  currentCooldownMs: number;
  halfOpenProbes: number;
  /** HALF_OPEN trial batch (spec rule #10): successes counted this episode; closes at recovery.halfOpen.successThreshold. */
  halfOpenSuccesses: number;
  /** When this HALF_OPEN episode began (0 = not in one); recovery.halfOpen.maxWaitMs expires from here. */
  halfOpenEnteredAt?: number;
}

/**
 * The persistence unit of one breaker:
 * every mutable field of the state machine (contrast the wire-contract
 * `CircuitBreakerSnapshot`, which derives display values and never carries
 * the sliding window). Identity fields (`modelId`/`provider`/`tier`/
 * `keyHashPrefix`) are self-description for the file only — on restore the
 * registry keeps the identity it resolved from the current config.
 */
export interface BreakerRecord {
  modelId: string;
  provider: string;
  tier?: TierLevel;
  /** Present only on a PAIR record (same convention as the snapshot). */
  keyHashPrefix?: string;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  trippedAt: number;
  cooldownUntil: number;
  currentCooldownMs: number;
  halfOpenProbes: number;
  /** HALF_OPEN trial-batch progress (spec rule #10 persistence; 0 outside a trial). */
  halfOpenSuccesses: number;
  /** Epoch ms the current/last HALF_OPEN episode began (0 = never). Restored HALF_OPEN re-arms it to now. */
  halfOpenEnteredAt: number;
  /** Sliding-window ring buffer (true = success) — what makes rate trips survive. */
  outcomeWindow: boolean[];
  reason?: string;
  reasonCode?: BreakerReasonCode;
  reasonParams?: ReasonParams;
  category?: ErrorCategory;
}

/** `<OCR_HOME>/breaker-state.<env>.json` payload shape (version 1). */
export interface BreakerStateFile {
  version: 1;
  savedAt: number;
  /** Model-scope breakers (bare modelId), never carrying `keyHashPrefix`. */
  models: BreakerRecord[];
  /** Pair-scope breakers, every record carrying `keyHashPrefix`. */
  pairs: BreakerRecord[];
}

export type TierCrossPolicy = 'same_tier_only' | 'allow_escalate';

export type RetriableCauseConfig =
  | 'connection_reset'       // ECONNRESET, socket hang up, EPIPE
  | 'network_timeout'        // ETIMEDOUT, 504 Gateway Timeout
  | 'gateway_error'          // 502 Bad Gateway, 503 Service Unavailable, Cloudflare 52x
  | 'rate_limit_burst'       // transient 429 (Retry-After <= maxRateLimitWaitMs)
  | 'dns_error'              // transient EAI_AGAIN resolution jitter
  | 'server_internal_error'; // 500 internal error (not retried by default unless explicitly enabled)

export const DEFAULT_RETRIABLE_CAUSES: RetriableCauseConfig[] = [
  'connection_reset',
  'network_timeout',
  'gateway_error',
  'rate_limit_burst',
  'dns_error',
];

export interface InPlaceRetryConfig {
  enabled?: boolean;
  maxAttempts?: number; // default: 1 (one in-place retry on transient network jitter to rescue the KV cache)
  backoffMs?: number; // default: 200ms
  jitterMs?: number; // default: 100ms
  retryOnCauses?: RetriableCauseConfig[]; // allowlist of failure causes that may trigger an in-place retry (default: all high-frequency jitter causes)
  maxRateLimitWaitMs?: number; // longest 429 we may wait out in place, ms (default 2000ms; beyond that we fail over)
}

export interface FailoverRetryConfig {
  enabled?: boolean;
  maxAttempts?: number; // max candidate models to try (default: 2)
  tierCrossPolicy?: TierCrossPolicy; // 'same_tier_only' (strict) | 'allow_escalate' (may climb a tier to stay alive, never demotes)
}

export interface RetryConfig {
  enabled?: boolean;
  inplace?: InPlaceRetryConfig;
  failover?: FailoverRetryConfig;
}

