import { TierLevel } from '../types/router.js';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type ErrorCategory =
  | 'QUOTA_EXHAUSTED'      // out of balance / quota burned down / suspended for non-payment (HTTP 402, insufficient_quota)
  | 'AUTHENTICATION_ERROR' // API Key invalid or unauthorized (HTTP 401)
  | 'RATE_LIMITED'         // rate limit, TPM/RPM exceeded (HTTP 429)
  | 'SERVICE_UNAVAILABLE'  // upstream down, gateway timeout, connection refused (HTTP 500/502/503/504, ETIMEDOUT, ECONNREFUSED)
  | 'CLIENT_ERROR'         // bad client input, context length exceeded (HTTP 400, context length exceeded)
  | 'MANUAL'               // operator tripped the breaker from the console (deliberate takedown, not an auto-detected failure)
  | 'UNKNOWN';

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
 * ADR-0019 Decision 6 — blast radius of a trip once the failure is attributed
 * to one credential of a multi-credential provider.
 *  pair    = (model × credential) only — per-model rate limit, uncertain errors
 *  account = this credential everywhere — account quota / dead key
 *  model   = this model for every credential — outage / 5xx / network
 * Absent on a diagnosis means "model", today's pre-P3 semantics. The same
 * vocabulary serves manual (console/REST) trips: 'model' is the legacy scope.
 */
export type TripScope = 'pair' | 'account' | 'model';

export interface ErrorDiagnosis {
  category: ErrorCategory;
  networkCause?: NetworkFailureCause; // fine-grained network jitter vs. hard failure reason
  statusCode?: number;
  isRetriable: boolean;               // eligible for failover to another candidate
  isInPlaceRetriable: boolean;        // safe to retry the SAME model in place to rescue the KV cache
  shouldTripBreaker: boolean;
  hardTrip: boolean; // trip the breaker immediately, no need to accumulate failures (e.g. 402 unpaid)
  suggestedCooldownMs?: number;
  reason: string;
  retryAfterSeconds?: number;
  rawError?: any;
  /**
   * ADR-0019 P3 step 2 — set ONLY when the failure carried a credential
   * attribution (`UpstreamError.usedCredentialKeyHashPrefix`), i.e. the request ran
   * through a provider credential chain. Without it the breaker keeps the
   * model-level semantics it has always had (single-credential degeneracy).
   */
  tripScope?: TripScope;
  /** Account-scope failures that mean "this account is administratively bad" (dead key) — SUSPECT flag. */
  accountSuspect?: boolean;
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
   * ADR-0019 Decision 7 — session↔account affinity window. A session idle
   * past this window is re-selected as if new (the upstream prompt cache is
   * gone anyway, so the switch is free). Default 300000 = the Anthropic
   * cache TTL (5 min, 2026-03-06); OpenAI caches are load-dependent.
   */
  accountAffinity?: {
    cacheTtlMs?: number;
  };
}

export interface CircuitBreakerSnapshot {
  modelId: string;
  provider: string;
  tier?: TierLevel;
  state: CircuitBreakerState;
  /**
   * ADR-0019 P3 step 2 — present only on a PAIR breaker snapshot (model × this
   * credential's display-safe keyHash prefix). Absent = the model breaker,
   * which is what every pre-P3 consumer already reads.
   */
  keyHashPrefix?: string;
  reason?: string;
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

