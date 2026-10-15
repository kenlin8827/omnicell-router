import {
  ErrorCategory,
  ErrorDiagnosis,
  CircuitBreakerConfig,
  NetworkFailureCause,
  RetriableCauseConfig,
  RetryConfig,
  TripScope,
  DEFAULT_RETRIABLE_CAUSES,
} from './types.js';

export class UpstreamError extends Error {
  public status?: number;
  public errorBody?: string;
  public provider?: string;
  public modelId?: string;
  public retryAfterSeconds?: number;
  /**
   * Display-safe sha256 prefix of the credential that was
   * actually used when this failure happened. Stamped centrally by
   * `ProviderRegistry.execute` (attribution seam for the P3 pair-scoped breaker);
   * executors never set it, constructors never receive it.
   */
  public usedCredentialKeyHashPrefix?: string;

  constructor(options: {
    message: string;
    status?: number;
    errorBody?: string;
    provider?: string;
    modelId?: string;
    retryAfterSeconds?: number;
  }) {
    super(options.message);
    this.name = 'UpstreamError';
    this.status = options.status;
    this.errorBody = options.errorBody;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * 429 wording that means "this ACCOUNT burned its
 * budget" instead of "this MODEL/KEY hit its RPM window". Only consulted when
 * the diagnosis is attributable to one credential; anything goes
 * `pair` (under-cool rather than over-cool).
 */
const ACCOUNT_LIMIT_MARKERS = [
  'daily limit',
  'weekly limit',
  'monthly limit',
  'per day',
  'per week',
  'per month',
  'daily_quota',
  'weekly_quota',
  'usage allocation',
];

export class ErrorClassifier {
  /**
   * Industrial-grade LLM upstream error classification & diagnosis engine.
   * Categorizes errors into actionable resilience decisions:
   * - Hard Trip (e.g. 402 Quota Exhausted / 401 Auth)
   * - Fine-grained Network Jitter (Timeout, Connection Reset, Gateway 502/503, DNS)
   * - In-place retriable check to preserve upstream KV cache
   * - Transient backoff (429 Rate limit burst)
   * - Non-penalizing pass-through (400 Client error / context length exceeded)
   *
   * The attribution layer adds a blast-radius annotation (`tripScope`) to every
   * diagnosis that is attributable to ONE credential of a provider chain. A
   * diagnosis without attribution carries no `tripScope` at all, so chain-less
   * providers keep the model-level trip semantics they have always had.
   */
  public static classify(
    error: any,
    modelId: string,
    provider: string,
    circuitConfig?: CircuitBreakerConfig,
    retryConfig?: RetryConfig
  ): ErrorDiagnosis {
    const quotaCooldown = circuitConfig?.quotaCooldownMs || 12 * 3600 * 1000; // default: 12 hours
    const defaultInitialCooldown = circuitConfig?.initialCooldownMs || 30 * 1000; // default: 30s
    const maxRateLimitWaitMs = retryConfig?.inplace?.maxRateLimitWaitMs ?? 2000; // default: 2s

    // attribution seam. `ProviderRegistry.execute` stamps
    // the credential actually used onto the thrown error. No stamp means the
    // provider has no credential chain, so there is no pair space to scope a
    // trip into: the diagnosis stays exactly as it was before P3 (model-level).
    const usedAttribution: string | undefined =
      typeof error?.usedCredentialKeyHashPrefix === 'string' ? error.usedCredentialKeyHashPrefix : undefined;
    // Blast radius only travels with attribution (`cp-failfast`: silently
    // scoping a chain-less trip would cool accounts nobody asked about).
    const scoped = (tripScope: TripScope, accountSuspect = false): Partial<ErrorDiagnosis> =>
      usedAttribution === undefined
        ? {}
        : accountSuspect
          ? { tripScope, accountSuspect: true }
          : { tripScope };

    // Helper: checks if this failure cause is whitelisted for in-place retry
    const isCauseInPlaceRetriable = (cause: RetriableCauseConfig): boolean => {
      if (retryConfig?.enabled === false || retryConfig?.inplace?.enabled === false) {
        return false;
      }
      const allowed = retryConfig?.inplace?.retryOnCauses || DEFAULT_RETRIABLE_CAUSES;
      return allowed.includes(cause);
    };

    // Extract status code
    let statusCode: number | undefined = undefined;
    if (error?.status && typeof error.status === 'number') {
      statusCode = error.status;
    } else if (error?.statusCode && typeof error.statusCode === 'number') {
      statusCode = error.statusCode;
    }

    // Extract raw text message / error body
    const rawMessage = (error?.message || '').toString();
    const rawBody = (error?.errorBody || error?.body || error?.responseBody || '').toString();
    const combinedText = `${rawMessage} ${rawBody}`.toLowerCase();

    // If status code not directly on error object, try parsing from status pattern in message
    if (!statusCode) {
      const match = combinedText.match(/\bstatus\s*[:=]?\s*(\d{3})\b/) ||
                    combinedText.match(/\b\[\s*(\d{3})\s*\]/) ||
                    combinedText.match(/\bcode\s*[:=]?\s*(\d{3})\b/);
      if (match) {
        statusCode = parseInt(match[1], 10);
      }
    }

    // Extract retry-after header if present
    let retryAfterSeconds: number | undefined = error?.retryAfterSeconds;
    if (!retryAfterSeconds && error?.headers) {
      const h = error.headers;
      const ra = typeof h.get === 'function' ? h.get('retry-after') : h['retry-after'];
      if (ra) {
        const parsed = parseInt(ra, 10);
        if (!isNaN(parsed) && parsed > 0) {
          retryAfterSeconds = parsed;
        }
      }
    }

    // -------------------------------------------------------------
    // 1. QUOTA_EXHAUSTED (out of balance / quota burned down / suspended for non-payment)
    // -------------------------------------------------------------
    const isQuotaPattern =
      statusCode === 402 ||
      combinedText.includes('insufficient_quota') ||
      combinedText.includes('quota_exceeded') ||
      combinedText.includes('exceeded_current_quota') ||
      combinedText.includes('credit_expired') ||
      combinedText.includes('billing_not_active') ||
      combinedText.includes('balance_exhausted') ||
      combinedText.includes('out_of_credits') ||
      combinedText.includes('has exceeded its quota') ||
      combinedText.includes('payment_required') ||
      combinedText.includes('account_deactivated') ||
      combinedText.includes('insufficient balance') ||
      combinedText.includes('insufficient credit') ||
      combinedText.includes('arrears');

    if (isQuotaPattern) {
      return {
        category: 'QUOTA_EXHAUSTED',
        networkCause: 'HARD_FAILURE',
        statusCode: statusCode || 402,
        isRetriable: true, // Retriable by falling back to ANOTHER model in the pool!
        isInPlaceRetriable: false, // 402 will NEVER succeed on the same model
        shouldTripBreaker: true,
        hardTrip: true, // Immediate circuit trip!
        // Hard-trip LENGTH is resolved by the manager gate from trip.quota.cooldownMs
        // (default: the quotaCooldownMs knob echoed here); this field is only the
        // statistical-path floor and is not consulted on the hard path.
        minCooldownMs: quotaCooldown,
        reason: `Quota or balance exhausted for model '${modelId}' (Provider: ${provider})`,
        reasonCode: 'breaker.quota',
        reasonParams: { model: modelId, provider },
        // Account-wide burn: every model this credential can reach is out of
        // budget. No SUSPECT mark — quota resets, a dead key does not.
        ...scoped('account'),
        rawError: error,
      };
    }

    // -------------------------------------------------------------
    // 2. AUTHENTICATION_ERROR (invalid key / unauthorized)
    // -------------------------------------------------------------
    const isAuthPattern =
      statusCode === 401 ||
      combinedText.includes('invalid_api_key') ||
      combinedText.includes('incorrect api key') ||
      combinedText.includes('unauthorized') ||
      combinedText.includes('authentication_error');

    if (isAuthPattern) {
      return {
        category: 'AUTHENTICATION_ERROR',
        networkCause: 'HARD_FAILURE',
        statusCode: 401,
        isRetriable: true, // Retriable by failing over to another provider/model
        isInPlaceRetriable: false,
        shouldTripBreaker: true,
        hardTrip: true, // Immediate circuit trip!
        // Echoes the global knob; the manager gate resolves the hard-trip length
        // from trip.auth.cooldownMs — this field never steers it.
        minCooldownMs: quotaCooldown,
        reason: `Invalid API key or unauthorized for model '${modelId}' (Provider: ${provider})`,
        reasonCode: 'breaker.auth',
        reasonParams: { model: modelId, provider },
        // A rejected key is administrative, not a cooldown: the account goes
        // SUSPECT (never auto-returns) and every model it can reach is out.
        ...scoped('account', true),
        rawError: error,
      };
    }

    // -------------------------------------------------------------
    // 3. RATE_LIMITED (HTTP 429 throttling)
    // -------------------------------------------------------------
    const isRateLimitPattern =
      statusCode === 429 ||
      combinedText.includes('rate_limit') ||
      combinedText.includes('too many requests') ||
      combinedText.includes('tokens per minute') ||
      combinedText.includes('requests per minute') ||
      combinedText.includes('tpm') ||
      combinedText.includes('rpm');

    if (isRateLimitPattern) {
      // Rule-agnostic defaults: the manager gate RE-DERIVES the hard/counted
      // boundary and the cooldown floor from trip.rateLimit params (invariant 1
      // — the prober calls classify() without config, so gating lives there).
      // The floors here mirror today's hardcoded values exactly.
      const maxCooldownMs = circuitConfig?.maxCooldownMs || 5 * 3600 * 1000;
      const cooldownMs = retryAfterSeconds
        ? Math.max(1000, Math.min(retryAfterSeconds * 1000, maxCooldownMs))
        : Math.min(60 * 1000, defaultInitialCooldown);

      const isShortBurst = Boolean(
        retryAfterSeconds !== undefined &&
        (retryAfterSeconds * 1000) <= maxRateLimitWaitMs
      );
      const networkCause: NetworkFailureCause = isShortBurst ? 'RATE_LIMIT_BURST' : 'UNKNOWN';
      const inPlaceAllowed = isShortBurst && isCauseInPlaceRetriable('rate_limit_burst');
      // The upstream gave an explicit wait LONGER than we would ever retry
      // in place — trust it and hard-trip for exactly that duration instead
      // of re-discovering the limit through the 3-strike threshold. 429
      // without Retry-After stays a soft statistical failure. shouldTripBreaker
      // stays unconditional: every 429 counts (countedness has no toggle).
      const hardTrip = Boolean(retryAfterSeconds && !isShortBurst);
      // "per day / weekly limit / usage allocation" wording = the ACCOUNT's
      // budget, not this model's RPM window -> account. Plain 429/RPM/TPM stays
      // pair; uncertain stays pair (Decision 6: under-cool over over-cool).
      const isAccountLimit = ACCOUNT_LIMIT_MARKERS.some((m) => combinedText.includes(m));

      return {
        category: 'RATE_LIMITED',
        networkCause,
        statusCode: 429,
        isRetriable: true,
        isInPlaceRetriable: inPlaceAllowed,
        shouldTripBreaker: true,
        hardTrip,
        minCooldownMs: cooldownMs,
        retryAfterSeconds,
        reason: `Rate limit (429) on model '${modelId}' (Retry-After: ${retryAfterSeconds ?? 'unknown'}s, InPlace: ${inPlaceAllowed}, HardTrip: ${hardTrip})`,
        reasonCode: 'breaker.rate_limit',
        reasonParams: { model: modelId, retry_after: retryAfterSeconds ?? 'unknown' },
        ...scoped(isAccountLimit ? 'account' : 'pair'),
        rawError: error,
      };
    }

    // -------------------------------------------------------------
    // 4. CLIENT_ERROR (bad client params / context length exceeded — never penalizes model health!)
    // -------------------------------------------------------------
    const isClientErrorPattern =
      (statusCode === 400 || statusCode === 422) &&
      (
        combinedText.includes('context_length_exceeded') ||
        combinedText.includes('maximum context length') ||
        combinedText.includes('content_filter') ||
        combinedText.includes('invalid_request_error') ||
        combinedText.includes('does not support') ||
        combinedText.includes('json_schema')
      );

    if (isClientErrorPattern) {
      return {
        category: 'CLIENT_ERROR',
        networkCause: 'HARD_FAILURE',
        statusCode: statusCode || 400,
        isRetriable: false, // Client payload is fundamentally invalid
        isInPlaceRetriable: false,
        shouldTripBreaker: false, // Never trip circuit breaker for client payload error!
        hardTrip: false,
        reason: `Client parameter or context length error: ${rawMessage.slice(0, 200)}`,
        rawError: error,
      };
    }

    // -------------------------------------------------------------
    // 5. SERVICE_UNAVAILABLE (upstream outage / 5xx / network timeout / ETIMEDOUT)
    // -------------------------------------------------------------
    const isServerUnavailable =
      (statusCode !== undefined && statusCode >= 500 && statusCode < 600) ||
      combinedText.includes('etimedout') ||
      combinedText.includes('esockettimedout') ||
      combinedText.includes('econnrefused') ||
      combinedText.includes('econnreset') ||
      combinedText.includes('econnaborted') ||
      combinedText.includes('socket hang up') ||
      combinedText.includes('epipe') ||
      combinedText.includes('fetch failed') ||
      combinedText.includes('aborted') ||
      combinedText.includes('aborterror') ||
      combinedText.includes('network error') ||
      combinedText.includes('service unavailable') ||
      combinedText.includes('bad gateway') ||
      combinedText.includes('gateway timeout') ||
      combinedText.includes('overloaded') ||
      combinedText.includes('cloudflare') ||
      combinedText.includes('eai_again') ||
      combinedText.includes('enotfound');

    if (isServerUnavailable) {
      let networkCause: NetworkFailureCause = 'GATEWAY_ERROR';
      let causeKey: RetriableCauseConfig = 'gateway_error';

      // Dissect specific network failure cause:
      if (
        combinedText.includes('econnreset') ||
        combinedText.includes('econnaborted') ||
        combinedText.includes('socket hang up') ||
        combinedText.includes('epipe') ||
        combinedText.includes('und_err_socket')
      ) {
        networkCause = 'CONNECTION_RESET';
        causeKey = 'connection_reset';
      } else if (
        statusCode === 504 ||
        combinedText.includes('etimedout') ||
        combinedText.includes('esockettimedout') ||
        combinedText.includes('aborterror') ||
        combinedText.includes('gateway timeout') ||
        (combinedText.includes('timeout') && !combinedText.includes('rate'))
      ) {
        networkCause = 'NETWORK_TIMEOUT';
        causeKey = 'network_timeout';
      } else if (
        combinedText.includes('eai_again') ||
        combinedText.includes('enotfound')
      ) {
        networkCause = 'DNS_ERROR';
        causeKey = 'dns_error';
      } else if (
        statusCode === 500 ||
        combinedText.includes('internal server error')
      ) {
        networkCause = 'SERVER_INTERNAL_ERROR';
        causeKey = 'server_internal_error';
      } else {
        networkCause = 'GATEWAY_ERROR';
        causeKey = 'gateway_error';
      }

      const inPlaceAllowed = isCauseInPlaceRetriable(causeKey);

      return {
        category: 'SERVICE_UNAVAILABLE',
        networkCause,
        statusCode: statusCode || 503,
        isRetriable: true,
        isInPlaceRetriable: inPlaceAllowed,
        shouldTripBreaker: true,
        hardTrip: false,
        minCooldownMs: defaultInitialCooldown,
        reason: `Upstream network jitter [${networkCause}, status ${statusCode || 'N/A'}]: ${rawMessage.slice(0, 150)}`,
        reasonCode: 'breaker.network',
        reasonParams: { cause: networkCause, status: statusCode || 'N/A', message: rawMessage.slice(0, 150) },
        // Key-independent: the upstream itself is failing, so the whole model
        // (this model, every credential) goes.
        ...scoped('model'),
        rawError: error,
      };
    }

    // -------------------------------------------------------------
    // 6. UNKNOWN / Generic Error
    // -------------------------------------------------------------
    return {
      category: 'UNKNOWN',
      networkCause: 'UNKNOWN',
      statusCode,
      isRetriable: true,
      isInPlaceRetriable: false,
      shouldTripBreaker: true,
      hardTrip: false,
      minCooldownMs: defaultInitialCooldown,
      reason: `Unknown upstream error: ${rawMessage.slice(0, 150)}`,
      reasonCode: 'breaker.unknown',
      reasonParams: { message: rawMessage.slice(0, 150) },
      // Decision 6 last bullet: an UNCLASSIFIED failure cools only its own
      // pair ("under-cool rather than over-cool; retry naturally validates
      // siblings"). A real outage still reaches the model breaker through
      // SERVICE_UNAVAILABLE above, which is where network causes land.
      ...scoped('pair'),
      rawError: error,
    };
  }
}


