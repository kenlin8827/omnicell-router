import {
  ErrorDiagnosis,
  CircuitBreakerConfig,
  ClassifierTaxonomyEntry,
  NetworkFailureCause,
  RetriableCauseConfig,
  RetryConfig,
  TripScope,
  DEFAULT_RETRIABLE_CAUSES,
} from './types.js';
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_MAX_RATE_LIMIT_WAIT_MS,
  RATE_LIMIT_MIN_COOLDOWN_MS,
  RATE_LIMIT_NO_RETRY_AFTER_CAP_MS,
} from './circuit-breaker.js';

export class UpstreamError extends Error {
  public status?: number;
  public errorBody?: string;
  public provider?: string;
  public modelId?: string;
  public retryAfterSeconds?: number;
  /**
   * Alias of `status`: every surface's `executionError` and the orchestrator's
   * explicit-model wrapper read `err.statusCode` — without this alias an
   * upstream 4xx loses its status here and collapses to the 502 fallback,
   * which retry-happy harness clients then treat as retryable.
   */
  get statusCode(): number | undefined {
    return this.status;
  }
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
 * 429 wording that means "this credential burned its
 * budget" instead of "this MODEL/KEY hit its RPM window". Only consulted when
 * the diagnosis is attributable to one credential; anything goes
 * `pair` (under-cool rather than over-cool).
 */
const CREDENTIAL_LIMIT_MARKERS = [
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
   * - Non-penalizing pass-through (request-fault 4xx: 400/415/422/... — the
   *   request is wrong, the upstream is healthy; counting it would cool a
   *   healthy model on a deterministic error)
   *
   * The attribution layer adds a blast-radius annotation (`tripScope`) to every
   * diagnosis that is attributable to ONE credential of a provider chain. A
   * diagnosis without attribution carries no `tripScope` at all, so chain-less
   * providers keep the model-level trip semantics they have always had. The
   * ONE exception is the host-level connection failure (DNS / TCP refused /
   * TLS): its radius is the PROVIDER — credential- and model-independent — so
   * it travels with or without attribution (the provider is known from the
   * model registration, and the fan-out only ever feeds the statistical
   * ladder, never a hard trip).
   */
  public static classify(
    error: any,
    modelId: string,
    provider: string,
    circuitConfig?: CircuitBreakerConfig,
    retryConfig?: RetryConfig
  ): ErrorDiagnosis {
    const quotaCooldown = circuitConfig?.quotaCooldownMs || DEFAULT_CIRCUIT_BREAKER_CONFIG.quotaCooldownMs;
    const defaultInitialCooldown = circuitConfig?.initialCooldownMs || DEFAULT_CIRCUIT_BREAKER_CONFIG.initialCooldownMs;
    const maxRateLimitWaitMs = retryConfig?.inplace?.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;

    // attribution seam. `ProviderRegistry.execute` stamps
    // the credential actually used onto the thrown error. No stamp means the
    // provider has no credential chain, so there is no pair space to scope a
    // trip into: the diagnosis stays exactly as it was before P3 (model-level).
    const usedAttribution: string | undefined =
      typeof error?.usedCredentialKeyHashPrefix === 'string' ? error.usedCredentialKeyHashPrefix : undefined;
    // Blast radius only travels with attribution (`cp-failfast`: silently
    // scoping a chain-less trip would cool credentials nobody asked about).
    const scoped = (tripScope: TripScope, credentialSuspect = false): Partial<ErrorDiagnosis> =>
      usedAttribution === undefined
        ? {}
        : credentialSuspect
          ? { tripScope, credentialSuspect: true, usedKeyHashPrefix: usedAttribution }
          : { tripScope, usedKeyHashPrefix: usedAttribution };
    // Host-level radius: travels WITHOUT attribution — the provider is known
    // from the model registration, and the fan-out covers every credential
    // (sentinel tuples included), so no chain-less degeneracy applies.
    const hostScoped = (): Partial<ErrorDiagnosis> =>
      usedAttribution === undefined
        ? { tripScope: 'provider' }
        : { tripScope: 'provider', usedKeyHashPrefix: usedAttribution };

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
      combinedText.includes('allocated quota exceeded') ||
      combinedText.includes('credit_expired') ||
      combinedText.includes('billing_not_active') ||
      combinedText.includes('balance_exhausted') ||
      combinedText.includes('out_of_credits') ||
      combinedText.includes('has exceeded its quota') ||
      combinedText.includes('payment_required') ||
      combinedText.includes('credential_deactivated') ||
      combinedText.includes('insufficient balance') ||
      combinedText.includes('insufficient credit') ||
      combinedText.includes('arrears') ||
      // Chinese quota-plan ceiling wording (CJK marker literals live in the
      // includes below as match data only — the classifier's combined text is
      // lowercased and CJK passes through unchanged). Deliberately broad: any
      // CN upstream error naming "quota/credit" or the rolling-session cap in
      // its failure text is a ceiling burn for THIS credential, and QUOTA routes
      // to another model rather than hard-cooling on the same key.
      combinedText.includes('额度') ||
      combinedText.includes('会话频控');

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
        // Credential-wide burn: every model this credential can reach is out of
        // budget. No SUSPECT mark — quota resets, a dead key does not.
        ...scoped('credential'),
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
        // A rejected key is administrative, not a cooldown: the credential goes
        // SUSPECT (never auto-returns) and every model it can reach is out.
        ...scoped('credential', true),
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
      // The floors here read the same single-source constants as the resolver.
      const maxCooldownMs = circuitConfig?.maxCooldownMs || DEFAULT_CIRCUIT_BREAKER_CONFIG.maxCooldownMs;
      const cooldownMs = retryAfterSeconds
        ? Math.max(RATE_LIMIT_MIN_COOLDOWN_MS, Math.min(retryAfterSeconds * 1000, maxCooldownMs))
        : Math.min(RATE_LIMIT_NO_RETRY_AFTER_CAP_MS, defaultInitialCooldown);

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
      // "per day / weekly limit / usage allocation" wording = the credential's
      // budget, not this model's RPM window -> credential. Plain 429/RPM/TPM stays
      // pair; uncertain stays pair (Decision 6: under-cool over over-cool).
      const isCredentialLimit = CREDENTIAL_LIMIT_MARKERS.some((m) => combinedText.includes(m));

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
        ...scoped(isCredentialLimit ? 'credential' : 'pair'),
        rawError: error,
      };
    }

    // -------------------------------------------------------------
    // 4. CLIENT_ERROR (request-fault 4xx — never penalizes upstream health!)
    // The STATUS is the signal, no wording allowlist: 400 bad params, 415
    // unsupported media type, 413 payload too large, 422 unprocessable
    // entity, ... all repeat identically on every retry, so counting them
    // would cool a HEALTHY upstream on a deterministic request fault (the
    // 415 false-trip). 401/402/429 already returned above (dedicated
    // classes); the exceptions below stay counted evidence:
    //   403      — permission signal about this (model, credential) pair
    //   404/410  — dead model address: the pair truly cannot serve, and
    //              failover (isRetriable) routes around it
    //   408/425  — transient server-side waits, handled with the 5xx class
    // -------------------------------------------------------------
    const isRequestFault4xx =
      statusCode !== undefined &&
      statusCode >= 400 &&
      statusCode < 500 &&
      statusCode !== 403 &&
      statusCode !== 404 &&
      statusCode !== 408 &&
      statusCode !== 410 &&
      statusCode !== 425;

    if (isRequestFault4xx) {
      return {
        category: 'CLIENT_ERROR',
        networkCause: 'HARD_FAILURE',
        statusCode,
        isRetriable: false, // The request itself is at fault — another model gets the same fault
        isInPlaceRetriable: false,
        shouldTripBreaker: false, // Never trip the breaker for a request fault!
        hardTrip: false,
        reason: `Client request fault (HTTP ${statusCode}): ${rawMessage.slice(0, 200)}`,
        rawError: error,
      };
    }

    // -------------------------------------------------------------
    // 5. SERVICE_UNAVAILABLE (upstream outage / 5xx / network timeout / ETIMEDOUT)
    // 408/425 are transient server-side waits (not request faults); TLS
    // handshake failures are host-level connection failures.
    // -------------------------------------------------------------
    const isServerUnavailable =
      (statusCode !== undefined && statusCode >= 500 && statusCode < 600) ||
      statusCode === 408 ||
      statusCode === 425 ||
      combinedText.includes('etimedout') ||
      combinedText.includes('esockettimedout') ||
      // Bun surfaces a fetch deadline/abort as a TimeoutError whose message is
      // "The operation timed out." — the word "timeout" never appears (the 'd '
      // breaks the substring), so it must be matched by its own phrase.
      combinedText.includes('timed out') ||
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
      combinedText.includes('certificate') ||
      combinedText.includes('err_tls') ||
      combinedText.includes('ssl routines') ||
      combinedText.includes('self-signed') ||
      combinedText.includes('self signed') ||
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
        statusCode === 408 ||
        combinedText.includes('etimedout') ||
        combinedText.includes('esockettimedout') ||
        combinedText.includes('timed out') || // Bun TimeoutError wording (see isServerUnavailable)
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

      // Host-level connection failure: the provider's baseUrl itself is
      // unreachable (DNS / TCP refused / TLS handshake), so EVERY model behind
      // it is equally down, on every credential. Wider than model, but still
      // only statistical evidence — one DNS blip must never hard-trip a whole
      // provider (the ladder's threshold absorbs single blips).
      const hostLevelFailure =
        networkCause === 'DNS_ERROR' ||
        combinedText.includes('econnrefused') ||
        combinedText.includes('certificate') ||
        combinedText.includes('err_tls') ||
        combinedText.includes('ssl routines') ||
        combinedText.includes('self-signed') ||
        combinedText.includes('self signed');

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
        // Key-independent: the upstream itself is failing. Model-endpoint
        // evidence (5xx / timeout / reset) cools this model on every credential;
        // host-level evidence cools the whole provider.
        ...(hostLevelFailure ? hostScoped() : scoped('model')),
        rawError: error,
      };
    }

    // -------------------------------------------------------------
    // 6. UNKNOWN / Generic Error — counted, pair-scoped. Deliberately still
    // here: 403 (permission) and 404/410 (dead model address) are REAL "this
    // pair cannot serve" signals — cooling the pair lets selection route
    // around them — but they never widen to credential/model: another model
    // may serve fine on the same key. Everything else is unclassifiable.
    // -------------------------------------------------------------
    const addressFault = statusCode === 404 || statusCode === 410;
    const reason =
      statusCode === 403
        ? `Forbidden (403) for model '${modelId}' (Provider: ${provider}): ${rawMessage.slice(0, 150)}`
        : addressFault
          ? `Model address not found (${statusCode}) for '${modelId}' (Provider: ${provider}): ${rawMessage.slice(0, 150)}`
          : `Unknown upstream error: ${rawMessage.slice(0, 150)}`;
    return {
      category: 'UNKNOWN',
      networkCause: 'UNKNOWN',
      statusCode,
      isRetriable: true,
      isInPlaceRetriable: false,
      shouldTripBreaker: true,
      hardTrip: false,
      minCooldownMs: defaultInitialCooldown,
      reason,
      reasonCode: 'breaker.unknown',
      reasonParams: { message: rawMessage.slice(0, 150) },
      // Decision 6 last bullet: an UNCLASSIFIED failure cools only its own
      // pair ("under-cool rather than over-cool; retry naturally validates
      // siblings"). A real outage still reaches every tuple of the model
      // through SERVICE_UNAVAILABLE above, which is where network causes land.
      ...scoped('pair'),
      rawError: error,
    };
  }
}

/**
 * The classifier's fixed disposition table — the read-only reference the console
 * renders at /admin/breaker-rules (ADR-0004 §1). Co-located with classify() so a
 * behavior edit and its descriptor move together; classifier-taxonomy.test.ts
 * pins EVERY entry to the real classify() output (the anti-drift guard — this is
 * a summary of behavior, never a second implementation of it). Order = evaluation
 * precedence: 401/402/429 are claimed before the request-fault 4xx bucket, which
 * is claimed before 5xx/network, which is claimed before the UNKNOWN fallback.
 *
 * `defaultScope` is the radius a rule's `auto` resolves to WHEN ATTRIBUTED; a
 * chain-less diagnosis carries no tripScope and degenerates to the model sentinel
 * (the host-level provider exception travels with or without attribution).
 */
export const CLASSIFIER_TAXONOMY: readonly ClassifierTaxonomyEntry[] = [
  {
    category: 'QUOTA_EXHAUSTED',
    defaultScope: 'credential',
    disposition: 'hard_trip',
    countingToggle: false,
    governedBy: 'trip.quota',
  },
  {
    category: 'AUTHENTICATION_ERROR',
    defaultScope: 'credential',
    disposition: 'hard_trip',
    countingToggle: false,
    governedBy: 'trip.auth',
    marksSuspect: true,
  },
  {
    category: 'RATE_LIMITED',
    defaultScope: 'pair',
    disposition: 'counted',
    countingToggle: false,
    governedBy: 'trip.rateLimit',
    credentialScope: 'credential',
    conditionalHardTrip: true,
  },
  {
    category: 'CLIENT_ERROR',
    defaultScope: 'model',
    disposition: 'ignored',
    countingToggle: true,
    governedBy: 'counting.clientErrors',
  },
  {
    category: 'SERVICE_UNAVAILABLE',
    defaultScope: 'model',
    disposition: 'counted',
    countingToggle: true,
    governedBy: 'counting.serverErrors',
    hostScope: 'provider',
  },
  {
    category: 'UNKNOWN',
    defaultScope: 'pair',
    disposition: 'counted',
    countingToggle: true,
    governedBy: 'counting.unknownErrors',
  },
];


