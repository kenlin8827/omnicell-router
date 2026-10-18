// Mirrors backend FinOpsStats (backend/src/metrics/finops-tracker.ts getStats)
export interface GatewayMetrics {
  totalRequests: number;
  fallbackCount: number;
  tierDistribution: {
    lite: { count: number; pct: number };
    plus: { count: number; pct: number };
    pro: { count: number; pct: number };
    ultra: { count: number; pct: number };
  };
  tokens: {
    totalInputTokens: number;
    totalCachedTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
  };
  latency: {
    avgMs: number;
    liteAvgMs: number;
    plusAvgMs: number;
    proAvgMs: number;
    ultraAvgMs: number;
  };
}

export interface ClientStatus {
  name: string;
  displayName: string;
  configPath: string;
  exists: boolean;
  hooked: boolean;
  targetProvider: string;
  backupExists: boolean;
  /** Extra concrete models exposed in the client's model switcher (opencode) */
  extraModels?: string[];
  /** This client's model slots; value undefined = auto (intelligent routing).
   *  Optional: legacy backend responses (pre-modelSlots) omit the field entirely. */
  modelSlots?: { key: string; value?: string; default?: string }[];
  /** Applied model profile (opencode): profile id + agent→slot-key bindings. */
  profile?: ModelProfileBinding;
}

/** Mirrors backend ModelProfileBinding (applied model-profile echo from the OCR sidecar meta). */
export interface ModelProfileBinding {
  id: string;
  bindings: Record<string, string>;
}

/** Mirrors backend ModelProfileConfig (config.yaml `modelProfiles` entry). */
export interface ModelProfileView {
  id: string;
  name?: string;
  /** slot key → modelRef (model id | combo id | auto*) */
  slots: Record<string, string>;
  note?: string;
}

/** Mirrors backend OpenCodeAgentView (agent inventory for model-profile binding). */
export interface OpenCodeAgentView {
  name: string;
  mode: 'primary' | 'subagent' | 'all';
  /** 'service' = live opencode v2 service roster (preferred); others = file-scan fallback. */
  source: 'builtin' | 'file' | 'config' | 'service';
  model?: string;
}

/** Mirrors backend ClientProfileMemoryEntry — per-client console form memory
 *  (config.yaml `clientProfileMemory`): last profile + agent→slot selections.
 *  UI-only: never consulted by routing or by the hook itself. */
export interface ClientProfileMemoryEntry {
  profile: string;
  bindings: Record<string, string>;
  /** Model-list source: 'none' (default) = no concrete models exposed,
   *  'follow' = mirror the selected API key's effective model access,
   *  'custom' = manual picker. Mirrors backend. */
  modelMode?: 'none' | 'custom' | 'follow';
}

// Mirrors backend CircuitBreakerSnapshot (backend/src/resilience/types.ts)
export interface BreakerInfo {
  modelId: string;
  provider: string;
  tier?: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  reason?: string;
  /** Machine-readable trip reason (backend BreakerReasonCode): trigger code on
   *  wrapped/manual trips, cause code on a hard trip. Absent = pre-code trip. */
  reasonCode?: string;
  reasonParams?: ReasonParams;
  category?: string;
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
  /** HALF_OPEN trial batch (spec rule #10): successes counted this episode. */
  halfOpenSuccesses: number;
  /** When this HALF_OPEN episode began (0 = not in one); recovery.halfOpen.maxWaitMs expires from here. */
  halfOpenEnteredAt?: number;
  /**
   * Present only on pair breakers (model × credential). Model
   * rows never carry it — readers split the two layers on `undefined`.
   */
  keyHashPrefix?: string;
}

/* ─── circuitBreaker.rules — mirrors backend/src/resilience/types.ts 1:1 by
 * contract name (spec docs/design/circuit-breaker-rules-config.md, re-exported
 * via backend/src/config/types.ts). Every per-rule param is optional: an
 * ABSENT numeric key means "auto" (inherit the global knob); booleans/enums
 * are materialized by the backend sanitizer on config load. */

/** Blast-radius override for one trip rule ('auto' = keep the diagnosed scope). */
export type BreakerScopeOverride = 'auto' | 'pair' | 'account' | 'model';

/** HALF_OPEN re-trip policy (spec rule #9). */
export type OnCanaryFailureMode = 'backoff' | 'initial' | 'close';

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
  maxWaitMs?: number; // cap on lingering in HALF_OPEN; default 0 = wait forever
}

export interface BreakerRecoveryConfig {
  onCanaryFailure?: OnCanaryFailureMode; // 'close' never applies to MANUAL breakers
  cooldownMultiplier?: number; // ladder factor for 'backoff'; default: cooldownMultiplier
  halfOpen?: BreakerHalfOpenRecoveryConfig;
}

export interface BreakerRulesConfig {
  counting?: BreakerCountingConfig;
  trip?: BreakerTripConfig;
  recovery?: BreakerRecoveryConfig;
}

/** Fully-resolved effective ruleset (resolved at startup + on every hot-apply, spec invariant 5): every parameter carries a concrete value. */
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

/** Full circuitBreaker config mirror (backend CircuitBreakerConfig) — the saved-config draft shape on /breaker-rules. */
export interface CircuitBreakerConfig {
  enabled?: boolean;
  failureThreshold?: number;
  slidingWindowSize?: number;
  failureRateThreshold?: number;
  initialCooldownMs?: number;
  maxCooldownMs?: number;
  cooldownMultiplier?: number;
  quotaCooldownMs?: number;
  halfOpenMaxProbes?: number;
  activeProbing?: {
    enabled?: boolean;
    intervalMs?: number;
  };
  accountAffinity?: {
    cacheTtlMs?: number;
  };
  /** Per-rule toggles/params; absent = today's behavior byte-for-byte. */
  rules?: BreakerRulesConfig;
  /** Shadow mode: rules evaluate and record fully, the gate verdict never denies. */
  shadow?: boolean;
  /** Breaker-memory flush policy. */
  persistence?: CircuitBreakerPersistenceConfig;
}

/**
 * Manual trip/reset granularity — mirrors backend TripScope.
 * 'model' is the legacy whole-model breaker; 'account' is one credential across the
 * models it can reach; 'pair' is one (model, credential) pair.
 */
export type BreakerTripScope = 'model' | 'account' | 'pair';

export interface BreakerScopeResponse {
  status: string;
  scope?: BreakerTripScope;
  /** Breakers taken down (trip) / reset (reset). */
  affected?: number;
  resetCount?: number;
  message?: string;
}

// Masked provider entry from /api/admin/status (ProviderConfig with apiKey masked)
export interface MaskedProviderStatus {
  name: string;
  type: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  apiKey: string; // "xxxx••••xxxx", empty string when unset
  rawKeyConfigured: boolean;
  organization?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

// Mirrors backend /api/admin/status payload exactly (backend/src/routes/console.ts handleStatus)
export interface GatewayStatusResponse {
  status: string;
  /** Runtime gateway version (backend/src/version.ts). Optional: older gateways omit it. */
  version?: string;
  timestamp: string;
  /** Actual gateway listening port (config.yaml `port`). */
  port: number;
  /**
   * Book-set this process booted with (backend console.ts handleStatus).
   * Optional: older gateways omit the field entirely.
   */
  env?: { name: string; configPath: string };
  metrics: GatewayMetrics;
  circuitBreakers: {
    total: number;
    healthy: number;
    tripped: number;
    halfOpen: number;
    breakers: BreakerInfo[];
    /**
     * Pair-only summary (model × credential).
     * Additive: older gateways omit it; the model counts above never include
     * pair breakers.
     */
    pairs?: {
      total: number;
      healthy: number;
      tripped: number;
      halfOpen: number;
      breakers: BreakerInfo[];
    };
    /**
     * EFFECTIVE (startup-resolved) ruleset + five-switch banner state (breaker
     * rules spec; backend console.ts handleStatus). Additive: older gateways
     * omit it — the UI then derives live values from the saved config.
     */
    rules?: BreakerRulesStatus;
  };
  clients: ClientStatus[];
  providers: MaskedProviderStatus[];
  /**
   * Runtime credential directory (provider + keyHash prefix only). Additive:
   * older gateways omit it. Lets the guardrails matrix name an orphan breaker
   * as the inline config-baked chain head instead of a bare #hash.
   */
  credentialHashes?: { provider: string; keyHashPrefix: string }[];
  registeredModelsCount: number;
  /** Inbound forward-proxy runtime status (backend forward-proxy/status.ts). */
  forwardProxy?: {
    enabled: boolean;
    running: boolean;
    port?: number;
    host?: string;
    startedAt?: number;
    error?: string;
  };
}

/**
 * Structured arguments for a localized routing reason — the optional
 * `reasonParams` the gateway emits beside `reason`. Values arrive ready to be
 * substituted into `{key}` slots; `cached: true` marks a reused decision.
 */
export type ReasonParams = Record<string, string | number | boolean>;

// Mirrors backend ExecutionTrace (backend/src/trace/tracker.ts) returned by /api/admin/traces
export interface TraceRecord {
  traceId: string;
  sessionId: string;
  turnNumber: number;
  timestamp: number;
  /** Client API-key identity (application) that drove this turn, when known. */
  apiKey?: CaptureKeyIdentity;
  request: {
    model: string;
    userPromptSummary: string;
    messageCount: number;
    hasSystemPrompt: boolean;
    hasToolsOrSchema: boolean;
  };
  routing: {
    layerUsed: 'layer0' | 'layer1' | 'layer2';
    targetTier: 'lite' | 'plus' | 'pro' | 'ultra';
    confidence: number;
    reason: string;
    /** Machine-readable reason vocabulary (see frontend/src/lib/reason.ts). Absent on legacy trace rows. */
    reasonCode?: string;
    reasonParams?: ReasonParams;
    sessionRatchetApplied: boolean;
  };
  execution: {
    modelUsed: string;
    provider: string;
    tierUsed: 'lite' | 'plus' | 'pro' | 'ultra';
    latencyMs: number;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    failoverOccurred?: boolean;
    failoverAttempts?: number;
    failoverPath?: string[];
    inplaceRetries?: number;
  };
  finops: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    /** Actual cost (USD) recorded at request time; no cost UI yet. */
    costUsd: number;
  };
}

// Mirrors backend capture types (backend/src/capture/recorder.ts)

/**
 * Stable identity of a client API key (mirrors backend CaptureKeyIdentity):
 * id + application name only, never the token value.
 */
export interface CaptureKeyIdentity {
  id: string;
  name: string;
}

export interface CaptureStatus {
  enabled: boolean;
  dir: string;
  retentionDays: number;
  maxTotalMB: number;
  maxBodyBytes: number;
  maxSessionMB: number;
  storeMedia: boolean;
  totalBytes: number;
  dateCount: number;
}

export interface CaptureDateRow {
  date: string; // YYYY-MM-DD
  sessions: number;
  bytes: number;
}

export interface CaptureSessionRow {
  file: string;
  sessionId: string;
  bytes: number;
  mtimeMs: number;
  turns: number;
  failed: number;
  lastStatus?: 'ok' | 'error';
  /** First user-message text of the session (backend-extracted, capped) */
  preview?: string;
  /** DISTINCT client API-key identities (applications) behind this archive,
   *  in write order — first element is the display anchor; more than one
   *  entry means the app rotated keys mid-session. */
  apiKeys?: CaptureKeyIdentity[];
  /**
   * Deterministic conversation key seen on this archive (first occurrence).
   * Stable across session-id churn — regroups a conversation split by
   * per-turn cold-start mints. Absent on key-less / legacy archives.
   */
  conversationKey?: string;
}

/** One archive hit for a session id: coordinates only (date dir + file name) */
export interface CaptureSessionMatch {
  date: string;
  file: string;
}

/**
 * HTTP-level observation of the SUCCESSFUL outbound call (mirrors
 * backend UpstreamHttpRecord): URL, status, safe response-header subset,
 * TTFB, total duration, attempt index, wire kind. Absent when no
 * outbound HTTP attempt landed successfully.
 */
export interface UpstreamHttpRecord {
  url: string;
  method: string;
  status: number;
  responseHeaders?: {
    retryAfter?: string;
    requestId?: string;
    contentType?: string;
    ratelimit?: {
      limit?: string;
      remaining?: string;
      reset?: string;
    };
  };
  ttfbMs: number | null;
  durationMs: number;
  attemptIndex: number;
  wireKind: 'openai' | 'anthropic' | 'google' | 'responses' | 'opencode-proxy';
}

export interface CaptureRecord {
  id: string;
  ts: number;
  sessionId: string;
  status: 'ok' | 'error';
  model: string;
  request?: unknown;
  /** Real outbound wire body (provider-translated, upstreamModel substituted). */
  upstreamRequest?: unknown;
  /** HTTP-level capture of the successful outbound call (last-write-wins). */
  upstreamHttp?: UpstreamHttpRecord;
  /** Upstream error payload (status + parsed body) when a candidate call failed */
  upstreamError?: unknown;
  response?: unknown;
  error?: string;
  routing?: {
    tierUsed?: string;
    layerUsed?: string;
    modelUsed?: string;
    provider?: string;
    fallbackOccurred?: boolean;
    failoverPath?: string[];
  };
  usage?: unknown;
  latencyMs?: number;
  truncated?: boolean;
}

/**
 * One HTTP-exchange event (mirrors backend HttpExchangeEvent). The capture
 * pipeline emits 2-4 events per inference turn, all sharing the same
 * `traceId` (OpenTelemetry semantics):
 *   - direction='client',   phase='request'  — the inbound HTTP request
 *   - direction='client',   phase='response' — gateway → client response
 *   - direction='upstream', phase='request'  — gateway → provider request
 *   - direction='upstream', phase='response' — provider → gateway response
 *
 * Each req/resp pair shares one `spanId`. Console readers join the four
 * events by `traceId`.
 */
export interface WireBody {
  /** Non-UTF-8 payloads fall back to hex (mirrors backend WireBody). */
  hex: string;
}

export interface RawWireCapture {
  requestLine: string;
  requestHeaders: Record<string, string>;
  requestBody: string | WireBody;
  responseLine: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string | WireBody;
}

export interface HttpExchangeEvent {
  id: string;
  ts: number;
  eventType: 'http-exchange';
  direction: 'client' | 'upstream';
  phase: 'request' | 'response';
  spanId: string;
  traceId: string;
  sessionId: string;
  /**
   * Deterministic conversation key (content-addressed sha256 of apiKey identity +
   * first user message). Stable across session-id churn and restarts — the join
   * key that regroups a conversation even when zero-header resolution minted a
   * fresh session id mid-loop. Absent on key-less / legacy archives.
   */
  conversationKey?: string;
  model: string;
  status: 'ok' | 'error' | 'pending';
  wire: RawWireCapture;
  routing?: {
    tierUsed?: string;
    layerUsed?: string;
    modelUsed?: string;
    provider?: string;
    fallbackOccurred?: boolean;
    failoverPath?: string[];
  };
  /** Client API-key identity of the owning turn (id + app name, never the token). */
  apiKey?: CaptureKeyIdentity;
  error?: string;
  /** Redacted proxy origin when the upstream call went through a proxy (upstream events only). */
  proxy?: string;
  truncated?: boolean;
}

export interface CaptureTurn {
  traceId: string;
  sessionId: string;
  model: string;
  clientRequest?: HttpExchangeEvent;
  gatewayResponse?: HttpExchangeEvent;
  upstreamRequest?: HttpExchangeEvent;
  upstreamResponse?: HttpExchangeEvent;
  error?: string;
  gatewayLatencyMs?: number;
  upstreamLatencyMs?: number;
}

// Mirrors backend ConversationSession (backend/src/session/session-manager.ts) + traceCount
export interface SessionRecord {
  id: string;
  maxTier: 'lite' | 'plus' | 'pro' | 'ultra';
  /**
   * How the client addressed this session's turns, derived from its traces:
   * 'auto' (ratchet owns the tier), 'explicit' (client named a model — no tier
   * lock to show), 'combo' (the composition IS the decision), 'mixed'.
   * Absent on pre-entryMode backends — the UI then falls back to the tier badge.
   */
  entryMode?: 'auto' | 'explicit' | 'combo' | 'mixed';
  pinnedModel: string;
  pinnedProvider: string;
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  historyTiers: string[];
  traceCount: number;
  /**
   * Credential this session is pinned to, as its
   * display-safe sha256 prefix. Live sessions only (a trace-reconstructed
   * session has no routing state to report), absent when never bound.
   */
  boundKeyHashPrefix?: string;
  /** Epoch ms of the bind/rebind. */
  boundAt?: number;
  /** Requests whose model differs from the previous request (chronological).
   *  Optional: absent when the frontend is served by a pre-aggregates backend. */
  switchCount?: number;
  /** Cumulative input tokens across the session's traces. Optional as above. */
  inputTokens?: number;
  /** Cumulative output tokens across the session's traces. Optional as above. */
  outputTokens?: number;
  /** Cumulative cache-read input tokens across the session's traces. Optional as above. */
  cachedTokens?: number;
  /** Cumulative recorded actual cost (USD) across the session's traces. Optional as above. */
  costUsd?: number;
  /** Summed end-to-end latency (ms) across the session's traces — the
   *  denominator of the average output-rate stat. Optional as above. */
  totalLatencyMs?: number;
  /** First user prompt of the session (backend-capped summary). */
  firstUserMessage?: string;
  /** Distinct client API-key identities (applications) seen on this
   *  session's traces, write order — first element is the display anchor. */
  apiKeys?: CaptureKeyIdentity[];
  /** Distinct client User-Agent strings seen on this session's traces,
   *  write order (display-only fingerprint; forgeable, never identity). */
  clients?: string[];
}

// Mirrors backend UsageStatsSummary (backend/src/trace/tracker.ts getUsageStats)
export interface KeyUsageRow {
  id: string;
  name: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMsSum: number;
  costUsd: number;
}

export interface UsageStatsResponse {
  status: string;
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    avgLatencyMs: number;
    costUsd: number;
  };
  keys: KeyUsageRow[];
}

export interface TierPoolModel {
  id: string;
  provider: string;
  upstreamModel?: string;
  priority?: number;
  isDefaultInTier: boolean;
  inputPrice?: number;
  outputPrice?: number;
  healthy: boolean;
  weight: number;
}

export interface TierPoolInfo {
  pool: TierPoolModel[];
  excluded: { id: string; reason: string }[];
}

export interface TierPoolsResponse {
  status: string;
  pools: Record<string, TierPoolInfo>;
  /** resolved member lists (post-sanitize) — the routing source of truth */
  members?: Record<string, TierMemberRule[]>;
}

/** tier member rule — mirrors backend config/types.ts TierMemberRule. */
export interface TierMemberRule {
  pattern: string;
  weight?: number;
  /** thinking-level translation (client requested → upstream); '' / missing = passthrough */
  effortMap?: Record<string, string>;
}

/** Dry-run save-check warnings overlap across tiers / orphan rules. */
export interface TierCheckWarning {
  kind: 'overlap' | 'orphan';
  tiers?: string[];
  count?: number;
  sampleIds?: string[];
  tier?: string;
  pattern?: string;
}

export interface ComboMemberView {
  id: string;
  weight: number;
  registered: boolean;
  provider?: string;
  tier?: string;
  inputPrice?: number;
  outputPrice?: number;
  breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | string;
}

export interface ComboView {
  id: string;
  active?: boolean;
  disabled?: boolean;
  selection: 'priority' | 'weighted' | 'round_robin' | string;
  members: ComboMemberView[];
  note?: string;
}

export interface CombosResponse {
  status: string;
  combos: ComboView[];
}

/** Result of the combo end-to-end test (POST /api/admin/combos/:id/test).
 * Mirror of the console contract — machine limbs only; the page composes the
 * display. `ok:false` is a real test outcome (chain exhausted, member
 * rejected); precondition failures (inactive id) throw OcApiError instead. */
export interface ComboTestResult {
  status: string;
  ok: boolean;
  combo: string;
  modelUsed?: string;
  latencyMs?: number;
  failoverOccurred?: boolean;
  failoverPath?: string[];
  servedAccountPrefix?: string;
  httpStatus?: number;
  error?: string;
}

export interface LogLine {
  raw: string;
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  levelNum?: number;
  time?: number;
  msg?: string;
}

export interface LogsResponse {
  status: string;
  file: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  lines: LogLine[];
}

export type TierName = 'lite' | 'plus' | 'pro' | 'ultra';
export type FlywheelLabelSource = 'human' | 'runtime_fallback' | 'observed_execution' | 'unlabeled';

export interface FlywheelSummary {
  total: number;
  trainable: number;
  synthetic: number;
  humanLabeled: number;
  unlabeled: number;
  trainableByTier: Record<string, number>;
  sourceDistribution: Record<string, number>;
  datasetPath: string;
  labelsPath: string;
  fileBytes: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  tiers: TierName[];
  /** Additive block (§3.4): effective retention knobs + last sweep outcome; absent on older backends. */
  retention?: FlywheelRetentionState;
}

export interface FlywheelSample {
  id: string;
  timestamp: string;
  userPrompt: string;
  tokenCount: number;
  featureVector: number[] | null;
  decision: {
    targetTier: TierName;
    confidence: number;
    layerUsed: 'layer0' | 'layer1' | 'layer2';
    reason: string;
    /** Machine-readable reason vocabulary; absent on samples recorded before the field existed. */
    reasonCode?: string;
    reasonParams?: ReasonParams;
  };
  execution: {
    tierUsed: TierName;
    modelUsed: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    latencyMs: number;
    isSynthetic: boolean;
  };
  label: {
    tier: TierName | null;
    source: FlywheelLabelSource;
    confidence: number;
    overridden: boolean;
    isNegativeForLite: boolean;
    updatedAt?: string;
  };
  trainable: boolean;
}

export interface FlywheelTrainingReport {
  trainedSamples: number;
  skipped: Record<string, number>;
  classDistribution: Record<string, number>;
  finalLoss: number;
  accuracy: number;
  epochs: number;
  lr: number;
  l2: number;
  balanced: boolean;
  durationMs: number;
  modelPath: string;
}

export interface FlywheelTrainingState {
  status: 'idle' | 'training' | 'success' | 'failed';
  lastStartedAt: string | null;
  lastTrainedAt: string | null;
  lastDurationMs: number | null;
  lastResult: FlywheelTrainingReport | null;
  error: string | null;
  model: {
    modelPath: string;
    exists: boolean;
    isBaseModel: boolean;
    sampleCount: number;
    lastTrainedAt: string | null;
    featureDimensions: number;
    classes: string[];
    routingConsumesModel: boolean;
    previousModelPath: string;
    previousModelExists: boolean;
  };
}

/** §3.4 stats `retention` block — effective knobs + last sweep outcome. */
export interface FlywheelRetentionState {
  retentionDays: number;
  maxFileSizeMB: number;
  enabled: boolean;
  lastSweepAt: string | null;
  lastRemoved: number | null;
}

/** §3.1 prune body — all optional; defaults replicate the CLI (dry-run). */
export interface FlywheelPruneRequest {
  apply?: boolean;
  dropSynthetic?: boolean;
  dropDuplicates?: boolean;
}

export interface FlywheelPruneResult {
  ok: true;
  applied: boolean;
  total: number;
  kept: number;
  dropped: { synthetic: number; duplicate: number; malformed: number };
  removedLabels: number;
  backupPath: string | null;
}

/** §3.2 batch delete — partial-success + idempotent: unknown ids are reported, never an error. */
export interface FlywheelDeleteResult {
  ok: true;
  deleted: number;
  notFound: string[];
  removedLabels: number;
  sidecarPath: string;
}

/** §3.3 reset — dataset + labels overlay archived; model weights are contractually untouched. */
export interface FlywheelResetResult {
  ok: true;
  removedRecords: number;
  removedLabels: number;
  backupPath: string | null;
  labelsBackupPath: string | null;
  modelUntouched: true;
}

/* ─── Environments ("book-sets" — admin API client) ────────────── */

export type AdminEnvType = 'regular' | 'sandbox';

/** POST /api/admin/environments seeding templates (backend create route enum). */
export type AdminEnvTemplate = 'blank' | 'copy-current' | 'copy-default';

/** One row of GET /api/admin/environments (backend EnvInfo + route extras). */
export interface AdminEnvironment {
  name: string;
  type: AdminEnvType;
  dir: string;
  configPath: string;
  createdAt: string | null;
  description?: string;
  /** Import provenance stamped by the backend import route (structured, locale-free). */
  importedFrom?: { name: string; appVersion: string };
  /** Backend's active flag (== current pointer resolves to this env). */
  active: boolean;
  /** Next boot resolves to this env (pointer / OCR_ENV). */
  current: boolean;
  /** THIS process booted with this env. */
  running: boolean;
  sizeBytes: number;
}

export interface EnvironmentsListResponse {
  status: 'ok';
  /** Env name the NEXT boot resolves (lenient — may name a missing dir). */
  current: string;
  /** Env name THIS process is running. */
  running: string;
  environments: AdminEnvironment[];
}

/** env.json metadata as echoed back by create / rename. */
export interface AdminEnvMeta {
  name: string;
  type: AdminEnvType;
  createdAt?: string;
  description?: string;
  importedFrom?: { name: string; appVersion: string };
}

/** POST .../switch — the three legal success-path shapes (failures throw). */
export type EnvSwitchResult =
  | { status: 'restarting'; env: string; newPort?: number; message?: string }
  | { status: 'ok'; env: string; message?: string }
  | { status: 'failed'; env: string; error: string };

/**
 * Shape of `manifest.json` inside an .orc_env.zip archive, as read client-side.
 * Every field optional: this is UNTRUSTED file input, so the page only reads
 * what it needs for the summary panel and lets the backend do the real
 * validation (format/version/checksums/sanitizing) before anything is written.
 */
export interface EnvArchiveManifest {
  format?: unknown;
  version?: unknown;
  exportedAt?: unknown;
  source?: { name?: unknown; type?: unknown; appVersion?: unknown };
  secrets?: unknown;
  redactedPaths?: unknown;
  checksums?: unknown;
}

/** Client-side mirror of backend ENVELOPE_VERSION (backend/src/config/env-archive.ts). */
export const ENV_ARCHIVE_VERSION = 1;
export const ENV_ARCHIVE_FORMAT = 'ocr-env';
export const ENV_ARCHIVE_SUFFIX = '.orc_env.zip';
/** Mirrors backend IMPORT_BODY_LIMIT_BYTES (fastify bodyLimit on the import route). */
export const ENV_IMPORT_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * HTTP-aware error for the admin-environment endpoints. The pages need the
 * status code to pick a localized message (409 taken vs 409 running vs 400
 * default) and the import route's `suggestion` body field; plain Error loses
 * both. Other api.ts methods keep throwing plain Errors.
 */
export class EnvApiError extends Error {
  readonly status: number;
  readonly suggestion?: string;
  /**
   * True when the failure response carried a parsable `{status,error}` JSON
   * body — i.e. the gateway is alive and told us what went wrong. The switch
   * flow uses this to separate "server refused" from "connection dropped
   * because the old process exited".
   */
  readonly hasErrorBody: boolean;

  constructor(message: string, status: number, opts: { suggestion?: string; hasErrorBody?: boolean } = {}) {
    super(message);
    this.name = 'EnvApiError';
    this.status = status;
    this.suggestion = opts.suggestion;
    this.hasErrorBody = opts.hasErrorBody ?? false;
  }
}

async function throwFor(res: Response): Promise<never> {
  const err = await res.json().catch(() => ({}));
  throw new Error(err?.error || err?.message || `HTTP ${res.status}`);
}

/**
 * Read the JSON error body the admin-environments routes emit:
 * `{ status:'error', error, suggestion? }`. `hasErrorBody` records whether the
 * response actually parsed into that contract, so callers can tell "gateway
 * answered" apart from "gateway vanished mid-request".
 */
async function throwEnvFor(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const hasErrorBody = !!body && (typeof body.error === 'string' || typeof body.status === 'string');
  const detail =
    typeof body?.error === 'string'
      ? body.error
      : typeof body?.message === 'string'
        ? body.message
        : `HTTP ${res.status}`;
  throw new EnvApiError(detail, res.status, {
    suggestion: typeof body?.suggestion === 'string' ? body.suggestion : undefined,
    hasErrorBody,
  });
}

/** Shared POST for the P3 scope-aware trip/reset routes (both 400 with {message}). */
async function postBreakerScope(path: string, body: Record<string, unknown>): Promise<BreakerScopeResponse> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
  return json;
}

// ---- headroom sidecar lifecycle (backend: compression/headroom-sidecar.ts) ----

export interface HeadroomSidecarStatus {
  url: string;
  running: boolean;
  version: string | null;
  managed: boolean; // a gateway-recorded pid exists and is alive
  pid: number | null;
  error: string | null;
  code: string | null; // machine-readable failure code → i18n key (see TokenSaverPage)
}

export interface HeadroomSidecarOpResult {
  status: string;
  ok: boolean;
  reused?: boolean; // start: already running, nothing spawned
  stopped?: boolean; // stop: actually killed a recorded pid
  pid: number | null;
  version: string | null;
  error: string | null; // English operator/log text — UI shows the localized `code` message
  code: string | null;
}

export const api = {
  async getStatus(): Promise<GatewayStatusResponse> {
    const res = await fetch('/api/admin/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getFlywheelStats(): Promise<FlywheelSummary> {
    const res = await fetch('/api/admin/flywheel/stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getFlywheelSamples(params: {
    limit?: number;
    offset?: number;
    tier?: string;
    source?: string;
    includeSynthetic?: boolean;
    trainableOnly?: boolean;
    search?: string;
  }): Promise<{ rows: FlywheelSample[]; total: number; offset: number; limit: number }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const res = await fetch(`/api/admin/flywheel/samples?${qs.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async setFlywheelLabel(id: string, tier: TierName | null): Promise<void> {
    const res = await fetch(`/api/admin/flywheel/samples/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    });
    if (!res.ok) await throwFor(res);
  },

  async getFlywheelTraining(): Promise<FlywheelTrainingState> {
    const res = await fetch('/api/admin/flywheel/training');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async rollbackFlywheelModel(): Promise<{ ok: boolean; model: FlywheelTrainingState['model'] }> {
    const res = await fetch('/api/admin/flywheel/model/rollback', { method: 'POST' });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  async startFlywheelTraining(options: {
    epochs?: number;
    balanceClasses?: boolean;
    minLabelSource?: string;
  }): Promise<{ started: boolean; state: FlywheelTrainingState; report?: FlywheelTrainingReport }> {
    const res = await fetch('/api/admin/flywheel/training', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  async clearFlywheelLabels(): Promise<{ cleared: number }> {
    const res = await fetch('/api/admin/flywheel/labels', { method: 'DELETE' });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  // ---- dataset lifecycle (§3, frozen contract) ----

  async pruneFlywheel(body: FlywheelPruneRequest): Promise<FlywheelPruneResult> {
    const res = await fetch('/api/admin/flywheel/prune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  async deleteFlywheelSamples(ids: string[]): Promise<FlywheelDeleteResult> {
    const res = await fetch('/api/admin/flywheel/samples/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  async resetFlywheelDataset(confirm: string): Promise<FlywheelResetResult> {
    const res = await fetch('/api/admin/flywheel/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm }),
    });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  async getConfig(): Promise<any> {
    const res = await fetch('/api/admin/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // Unwrap the { status, config } envelope — consumers want the RouterConfig
    // object itself (SettingsPage/AutoPage save it back via saveConfig).
    return body?.config ?? body;
  },

  async saveConfig(config: any): Promise<{ status: string; message: string }> {
    const res = await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async getHeadroomSidecar(): Promise<HeadroomSidecarStatus> {
    const res = await fetch('/api/admin/headroom/sidecar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async startHeadroomSidecar(): Promise<HeadroomSidecarOpResult> {
    const res = await fetch('/api/admin/headroom/sidecar/start', { method: 'POST' });
    return res.json();
  },

  async stopHeadroomSidecar(): Promise<HeadroomSidecarOpResult> {
    const res = await fetch('/api/admin/headroom/sidecar/stop', { method: 'POST' });
    return res.json();
  },

  async getTierPools(): Promise<TierPoolsResponse> {
    const res = await fetch('/api/admin/tier-pools');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Ephemeral pool preview computed from (unsaved) tier-policy form state. */
  async previewTierPools(tiers: unknown): Promise<TierPoolsResponse> {
    const res = await fetch('/api/admin/tier-pools/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Live (committed) pool snapshot — the registry's m.tier after the last applyTierConfigNow. */
  async getLiveTierPools(): Promise<TierPoolsResponse> {
    const res = await fetch('/api/admin/tier-pools/live');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Dry-run validation of a DRAFT tiers config (non-blocking warnings: overlap / orphan). */
  async checkTiers(tiers: unknown): Promise<{ status: string; warnings: TierCheckWarning[] }> {
    const res = await fetch('/api/admin/tiers/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getCombos(): Promise<CombosResponse> {
    const res = await fetch('/api/admin/combos');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** One-shot combo end-to-end test — a REAL minimal completion through the
   * production pipeline (burns quota, lands in logs). 4xx preconditions
   * (combo_inactive) throw OcApiError with the reasonCode for local
   * composition; a failed test itself answers 200 with ok:false limbs. */
  async testCombo(id: string): Promise<ComboTestResult> {
    const res = await fetch(`/api/admin/combos/${encodeURIComponent(id)}/test`, { method: 'POST' });
    if (!res.ok) {
      const e: any = await res.json().catch(() => ({}));
      throw new OcApiError(
        e?.error || e?.message || `HTTP ${res.status}`,
        typeof e?.reasonCode === 'string' ? e.reasonCode : undefined,
        e
      );
    }
    return res.json();
  },

  /** Model profiles (config.yaml `modelProfiles`) — raw section round-trip, no
   *  resolution view needed (refs are resolved by the client hook at apply). */
  async getModelProfiles(): Promise<ModelProfileView[]> {
    const cfg = await this.getConfig();
    return cfg.modelProfiles || [];
  },

  async saveModelProfiles(profiles: ModelProfileView[]): Promise<{ status: string; message: string }> {
    return this.saveConfig({ modelProfiles: profiles });
  },

  /** OpenCode agent inventory (built-ins + agent/*.md + global config node). */
  async listOpencodeAgents(): Promise<OpenCodeAgentView[]> {
    const res = await fetch('/api/admin/opencode/agents');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.agents || [];
  },

  /** Per-client form memory (profile + slot mapping) saved in the ACTIVE
   *  environment's config — survives reloads, restarts and teardown. */
  async getClientProfileMemory(): Promise<Record<string, ClientProfileMemoryEntry>> {
    const cfg = await this.getConfig();
    return cfg.clientProfileMemory || {};
  },

  async saveClientProfileMemory(memory: Record<string, ClientProfileMemoryEntry>): Promise<{ status: string; message: string }> {
    return this.saveConfig({ clientProfileMemory: memory });
  },

  /**
   * Token usage aggregates: windowed totals + per-API-key rows. Optional
   * `sinceMs` (inclusive lower bound on `trace.timestamp`, epoch ms) narrows
   * the window; `undefined` covers the whole in-memory trace ring.
   */
  async getUsageStats(sinceMs?: number): Promise<UsageStatsResponse> {
    const qs = sinceMs !== undefined ? `?since=${Math.floor(sinceMs)}` : '';
    const res = await fetch(`/api/admin/usage${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getRawYaml(): Promise<{ status: string; yaml: string }> {
    const res = await fetch('/api/admin/config/raw');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async saveRawYaml(yaml: string): Promise<{ status: string; message: string }> {
    const res = await fetch('/api/admin/config/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async toggleClient(
    client: string,
    action: 'setup' | 'teardown',
    payload?: {
      models?: Record<string, string>;
      apiKey?: string;
      contextWindow?: number;
      extraModels?: string[];
      /** Model profile application (opencode): id + agent→slot bindings; id '' un-applies (sweep). */
      profile?: { id: string; bindings: Record<string, string> };
    }
  ): Promise<{ status: string; message: string }> {
    const res = await fetch(`/api/admin/client/${client}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** All models the gateway can route to: virtual (auto/auto-lite/…), combos,
   *  registered models and variant exposures — `kind` tags which one each id is.
   *  Reads the console endpoint — /v1/models requires a key like every surface. */
  async listGatewayModels(): Promise<{ id: string; owned_by: string; tier?: string; kind?: string }[]> {
    const res = await fetch('/api/admin/gateway-models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json?.models || []).map((m: any) => ({
      id: m.id,
      owned_by: m.owned_by || '',
      tier: m.tier || undefined,
      kind: m.kind || undefined,
    }));
  },

  async resetBreakers(model?: string): Promise<{ status: string; message?: string }> {
    const res = await fetch('/api/admin/health/circuit-breakers/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
    });
    return res.json();
  },

  async tripBreaker(
    model: string,
    options?: { reason?: string; cooldownMs?: number }
  ): Promise<{ status: string; message?: string }> {
    const res = await fetch('/api/admin/health/circuit-breakers/trip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...options }),
    });
    return res.json();
  },

  /**
   * Scope-aware trip for 'account' / 'pair'. Deliberately NOT
   * routed through tripBreaker(): the legacy 'model' scope keeps its exact
   * body and its legacy non-throwing reply handling. Unlike the model scope,
   * an account/pair trip with nothing to take down answers 400 — thrown here
   * so the console reports it as a failure instead of a fake success.
   */
  async tripBreakersScoped(
    scope: Exclude<BreakerTripScope, 'model'>,
    target: { model?: string; account?: string; reason?: string; cooldownMs?: number }
  ): Promise<BreakerScopeResponse> {
    return postBreakerScope('/api/admin/health/circuit-breakers/trip', { scope, ...target });
  },

  /**
   * Account/pair reset. Resetting a credential never lifts its
   * SUSPECT flag (administrative state — see clearSuspectAccount below).
   */
  async resetBreakersScoped(
    scope: Exclude<BreakerTripScope, 'model'>,
    target: { model?: string; account?: string }
  ): Promise<BreakerScopeResponse> {
    return postBreakerScope('/api/admin/health/circuit-breakers/reset', { scope, ...target });
  },

  /**
   * Explicit admin door for a SUSPECT credential (body
   * {provider, account}; `account` is the keyHash prefix). `cleared:false`
   * means the flag was already absent — a no-op, not an error.
   */
  async clearSuspectAccount(providerId: string, account: string): Promise<SuspectAccountClearResponse> {
    const res = await fetch('/api/admin/health/suspect-accounts/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, account }),
    });
    if (!res.ok) {
      const e: any = await res.json().catch(() => ({}));
      throw new Error(e?.message || e?.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async restartGateway(): Promise<{ status: string; message?: string }> {
    const res = await fetch('/api/admin/restart', { method: 'POST' });
    return res.json();
  },

  /* ─── Environments (book-sets) ─────────────────────────────────────────── */

  async getEnvironments(): Promise<EnvironmentsListResponse> {
    const res = await fetch('/api/admin/environments');
    if (!res.ok) await throwEnvFor(res);
    return res.json();
  },

  /** POST /api/admin/environments — 400 invalid name / 409 duplicate (case-insensitive). */
  async createEnvironment(body: {
    name: string;
    type?: AdminEnvType;
    template: AdminEnvTemplate;
    description?: string;
  }): Promise<{ status: string; env: AdminEnvironment }> {
    const res = await fetch('/api/admin/environments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await throwEnvFor(res);
    return res.json();
  },

  /** PATCH .../:name — body carries `name` (rename) and/or `description`. */
  async updateEnvironment(
    name: string,
    body: { name?: string; description?: string | null },
  ): Promise<{ status: string; env: { name: string; meta: AdminEnvMeta | null; configPath: string } }> {
    const res = await fetch(`/api/admin/environments/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await throwEnvFor(res);
    return res.json();
  },

  /** DELETE .../:name — the backend refuses without confirm:true (moves to envs/.trash). */
  async deleteEnvironment(name: string): Promise<{ status: string; name: string; trashPath: string }> {
    const res = await fetch(`/api/admin/environments/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    if (!res.ok) await throwEnvFor(res);
    return res.json();
  },

  /** POST .../:name/reset — sandbox environments only, never the running one. */
  async resetEnvironment(name: string): Promise<{ status: string; name: string }> {
    const res = await fetch(`/api/admin/environments/${encodeURIComponent(name)}/reset`, {
      method: 'POST',
    });
    if (!res.ok) await throwEnvFor(res);
    return res.json();
  },

  /**
   * POST .../:name/switch — writes the next-boot pointer and hands over to a
   * replacement process. `newPort` is present when the target env's config
   * listens somewhere else than this gateway does.
   */
  async switchEnvironment(name: string): Promise<EnvSwitchResult> {
    const res = await fetch(`/api/admin/environments/${encodeURIComponent(name)}/switch`, {
      method: 'POST',
    });
    if (!res.ok) await throwEnvFor(res);
    return res.json();
  },

  /**
   * GET .../:name/export — returns the archive blob plus the server-chosen
   * download filename (Content-Disposition), falling back to a client-built
   * `<name>-<yyyymmdd>.orc_env.zip` when the header is absent (encrypted and
   * plaintext archives share ONE suffix — encryption is a property of the
   * bytes). `includePayload` selects a subset of the payload files
   * (comma-joined `?include=`); absent = every payload file that exists.
   * `encrypt` + `password` request a password-encrypted archive — the
   * password travels ONLY in the x-ocr-archive-password header, never the
   * query (access logs record URLs).
   */
  async exportEnvironment(
    name: string,
    opts: { includeSecrets: boolean; includePayload?: string[]; encrypt?: boolean; password?: string }
  ): Promise<{ blob: Blob; filename: string }> {
    const qs = new URLSearchParams({ secrets: opts.includeSecrets ? 'include' : 'redact' });
    if (opts.includePayload && opts.includePayload.length > 0) qs.set('include', opts.includePayload.join(','));
    if (opts.encrypt) qs.set('encrypt', '1');
    const headers: Record<string, string> = {};
    if (opts.encrypt && opts.password) headers['x-ocr-archive-password'] = opts.password;
    const res = await fetch(`/api/admin/environments/${encodeURIComponent(name)}/export?${qs.toString()}`, { headers });
    if (!res.ok) await throwEnvFor(res);
    const cd = res.headers.get('Content-Disposition') || '';
    const quoted = cd.match(/filename="?([^";]+)"?/i)?.[1];
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return {
      blob: await res.blob(),
      filename: quoted || `${name}-${stamp}${ENV_ARCHIVE_SUFFIX}`,
    };
  },

  /**
   * POST .../import?name=<name>&mode=create|replace — uploads the archive
   * bytes BLIND: whether the body needs a password is decided by the backend,
   * never sniffed client-side. An encrypted body without the
   * x-ocr-archive-password header answers 400 "Archive is encrypted …", and
   * only then the caller supplies `opts.password`. create (default) always
   * makes a NEW environment (collision → 409 + `suggestion`); replace
   * restores over an EXISTING env (old content moves to envs/.trash first —
   * recoverable; the bootstrap default and the RUNNING env are refused
   * server-side).
   */
  async importEnvironment(
    file: File,
    name: string,
    opts: { password?: string; mode?: 'create' | 'replace' } = {}
  ): Promise<{ status: string; env: AdminEnvironment }> {
    const qs = new URLSearchParams({ name });
    if (opts.mode === 'replace') qs.set('mode', 'replace');
    const headers: Record<string, string> = { 'Content-Type': 'application/zip' };
    if (opts.password) headers['x-ocr-archive-password'] = opts.password;
    const res = await fetch(`/api/admin/environments/import?${qs.toString()}`, {
      method: 'POST',
      headers,
      body: file,
    });
    if (!res.ok) await throwEnvFor(res);
    return res.json();
  },

  async getSessions(
    limit?: number,
    offset = 0,
    q?: string,
    apiKey?: string
  ): Promise<{ sessions: SessionRecord[]; total: number }> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    if (q) qs.set('q', q);
    if (apiKey) qs.set('apiKey', apiKey);
    const res = await fetch(`/api/admin/sessions?${qs.toString()}`);
    if (!res.ok) return { sessions: [], total: 0 };
    const json = await res.json();
    // /api/admin/sessions responds { object, total, limit?, offset, data }
    return { sessions: json.data || [], total: json.total || 0 };
  },

  /** Full chronological trajectory of one session — source for the switch timeline. */
  async getSessionTraces(sessionId: string): Promise<TraceRecord[]> {
    const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}/traces`);
    if (!res.ok) return [];
    const json = await res.json();
    // /api/admin/sessions/:id/traces responds { object, sessionId, total, data }
    return json.data || [];
  },

  /**
   * Global trace query scoped to one resolved model id (exact match on the
   * trace's `execution.modelUsed`), optionally narrowed to a time window.
   * Backs the usage page's per-model call list.
   */
  async getTracesByModel(modelId: string, sinceMs?: number, limit = 500): Promise<TraceRecord[]> {
    const qs = new URLSearchParams();
    qs.set('model', modelId);
    if (sinceMs !== undefined) qs.set('since', String(sinceMs));
    qs.set('limit', String(limit));
    const res = await fetch(`/api/admin/traces?${qs.toString()}`);
    if (!res.ok) return [];
    const json = await res.json();
    // /api/admin/traces responds { object, total, limit, offset, data }
    return json.data || [];
  },

  /**
   * Clear ALL sessions (console maintenance surface — browser pages cannot
   * present API keys, so destructive ops go through /api/admin).
   */
  async clearSessions(): Promise<{ status: string; sessionsCleared?: number; tracesCleared?: number; message?: string }> {
    const res = await fetch('/api/admin/sessions/clear', { method: 'POST' });
    return res.json();
  },

  /** Delete one session (live state + traces, including reconstructed history). */
  async deleteSession(sessionId: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    return res.json();
  },

  async getLogs(tail = 500, level?: string, q?: string): Promise<LogsResponse> {
    const qs = new URLSearchParams();
    qs.set('tail', String(tail));
    if (level) qs.set('level', level);
    if (q) qs.set('q', q);
    const res = await fetch(`/api/admin/logs?${qs.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** POST /api/admin/logs/clear — back up + truncate ocr.log in place. */
  async clearLogs(): Promise<{
    status: string;
    cleared: boolean;
    exists: boolean;
    size: number;
    sizeBefore?: number;
    backup: string | null;
    warning?: string;
    message?: string;
  }> {
    const res = await fetch('/api/admin/logs/clear', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  },

  async getApiKeys(): Promise<{ status: string; keys: ApiKeyItem[] }> {
    const res = await fetch('/api/admin/api-keys');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async createApiKey(payload: {
    name: string;
    key?: string;
    expiresAt?: string;
    description?: string;
    modelAccess?: ApiKeyModelAccess;
    limits?: RateLimitRule[];
  }): Promise<{ success: boolean; data?: ApiKeyItem; error?: string }> {
    const res = await fetch('/api/admin/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  },

  async updateApiKey(
    id: string,
    updates: Partial<Omit<ApiKeyItem, 'modelAccess' | 'limits'>> & {
      modelAccess?: ApiKeyModelAccess | null;
      limits?: RateLimitRule[] | null;
    }
  ): Promise<{ success: boolean; data?: ApiKeyItem; error?: string }> {
    const res = await fetch(`/api/admin/api-keys/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    return res.json();
  },

  async deleteApiKey(id: string): Promise<{ success: boolean; error?: string }> {
    const res = await fetch(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
    return res.json();
  },

  /** Rate-limiter snapshot — live windows for every armed subject. */
  async getRateLimitWindows(): Promise<{ status: string; windows: RateLimitSnapshotEntry[] }> {
    const res = await fetch('/api/admin/ratelimit');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Rate-limiter event log — triggered decisions from both directions,
   * newest first (bounded in-memory ring, repeats coalesce).
   */
  async getRateLimitEvents(): Promise<{ status: string; events: RateLimitEvent[] }> {
    const res = await fetch('/api/admin/ratelimit/events');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Wipe the event ledger (ring + durable mirror). Windows and rules untouched. */
  async clearRateLimitEvents(): Promise<{ status: string; cleared: boolean }> {
    const res = await fetch('/api/admin/ratelimit/events/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Quota tracking overview (GET /api/admin/quota): the connected
   * pair directory with per-pair quota views + served usage, the release
   * coverage plan, rejected quotaProbes entries, and the burn-event ledger.
   */
  async getQuotaOverview(): Promise<QuotaOverview> {
    const res = await fetch('/api/admin/quota');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Last raw HTTP exchange for one pair (GET /api/admin/quota/last-probe):
   *  the quota endpoint's own response, memory-only on the backend. */
  async getLastProbe(providerId: string, keyHashPrefix: string): Promise<{ status: string; http: LastProbeCapture | null }> {
    const qs = `providerId=${encodeURIComponent(providerId)}&keyHashPrefix=${encodeURIComponent(keyHashPrefix)}`;
    const res = await fetch(`/api/admin/quota/last-probe?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Re-arm probing (POST /api/admin/quota/refresh): one pair, or the whole
   *  schedule when no identity given. Invalidation only — never synchronous. */
  async refreshQuota(target?: { providerId: string; keyHashPrefix: string }): Promise<{ status: string; success: boolean; reasonCode?: string }> {
    const res = await fetch('/api/admin/quota/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target ?? {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Arm / clear ONE credential's outbound caps (config `accounts:` overlay
   * write — the credential itself is not touched). `limits: []` or `null`
   * clears the entry. Hot: the gateway reloads the rule table on save.
   */
  async setAccountLimits(payload: {
    provider: string;
    keyHashPrefix: string;
    limits: RateLimitRule[] | null;
  }): Promise<{
    status: string;
    success: boolean;
    limits?: RateLimitRule[];
    windows?: RateLimitSnapshotEntry[];
    error?: string;
  }> {
    const res = await fetch('/api/admin/accounts/limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  },

  // ── Console webAuth ────────────────────────────────────────────────────────

  /** Session probe — App boot gate: does the console need a login? */
  async getAuthSession(): Promise<AuthSessionResponse> {
    const res = await fetch('/api/admin/auth/session');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async login(username: string, password: string): Promise<{ status?: string; success?: boolean; message?: string }> {
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.message || `HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return body;
  },

  async logout(): Promise<{ status: string }> {
    const res = await fetch('/api/admin/auth/logout', { method: 'POST' });
    return res.json();
  },

  async getWebAuthConfig(): Promise<{ status: string; webAuth: WebAuthConfigView }> {
    const res = await fetch('/api/admin/auth/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async updateWebAuthConfig(
    payload: { enabled?: boolean; username?: string; password?: string }
  ): Promise<{ status: string; webAuth: WebAuthStatus; message?: string }> {
    const res = await fetch('/api/admin/auth/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.message || `HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return body;
  },

  /** Effective model view for one key — what it can see & use right now. */
  async getKeyModels(
    id: string
  ): Promise<{
    status: string;
    mode: 'none' | 'allow' | 'deny';
    policyModels: string[];
    models: { id: string; provider: string; tier: string; virtual: boolean; allowed: boolean }[];
  }> {
    const res = await fetch(`/api/admin/api-keys/${encodeURIComponent(id)}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /* ------------------------------------------------------------------ *
   * Request-capture archive (full bodies, opt-in; /api/admin/capture/*)
   * ------------------------------------------------------------------ */

  async getCaptureStatus(): Promise<CaptureStatus> {
    const res = await fetch('/api/admin/capture/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getCaptureDates(): Promise<CaptureDateRow[]> {
    const res = await fetch('/api/admin/capture/dates');
    if (!res.ok) return [];
    const json = await res.json();
    return json.dates || [];
  },

  async getCaptureSessions(date: string, apiKey?: string): Promise<CaptureSessionRow[]> {
    const qs = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : '';
    const res = await fetch(`/api/admin/capture/${encodeURIComponent(date)}/sessions${qs}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.sessions || [];
  },

  /** Locate a session's archive(s) across all dates by raw session id. */
  async findCaptureSessions(sessionId: string): Promise<CaptureSessionMatch[]> {
    const qs = new URLSearchParams({ id: sessionId });
    const res = await fetch(`/api/admin/capture/find-session?${qs.toString()}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.matches || [];
  },

  async getCaptureEvents(
    date: string,
    file: string,
    limit = 500
  ): Promise<{
    events: HttpExchangeEvent[];
    turns: CaptureTurn[];
    totalLines: number;
    totalTurns: number;
    fileTruncated: boolean;
  }> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}/events?limit=${limit}`
    );
    if (!res.ok) return { events: [], turns: [], totalLines: 0, totalTurns: 0, fileTruncated: false };
    return res.json();
  },

  async getCaptureRecords(
    date: string,
    file: string,
    limit = 200
  ): Promise<{ records: CaptureRecord[]; totalLines: number; fileTruncated: boolean }> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}?limit=${limit}`
    );
    if (!res.ok) return { records: [], totalLines: 0, fileTruncated: false };
    return res.json();
  },

  /** JSONL download of one session archive; `exclude` strips body fields, metadata always kept. */
  async exportCaptureArchive(date: string, file: string, exclude?: string[]): Promise<Blob> {
    const params = new URLSearchParams({ format: 'raw' });
    if (exclude && exclude.length > 0) params.set('exclude', exclude.join(','));
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}?${params.toString()}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },

  async deleteCaptureDate(date: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(`/api/admin/capture/${encodeURIComponent(date)}`, { method: 'DELETE' });
    return res.json();
  },

  async deleteCaptureSession(date: string, file: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}`,
      { method: 'DELETE' }
    );
    return res.json();
  },
};

export interface ApiKeyModelAccess {
  mode: 'allow' | 'deny';
  models: string[];
}

/**
 * Mirrors backend config/types.ts `RateLimitRule` (contract name kept 1:1):
 * one sliding-window rule. `window` is a duration string (30s / 5m / 1h / 1d);
 * each countable set (requests / tokens / costUsd) is an INDEPENDENT
 * constraint; any full window denies (inbound: 429 + Retry-After).
 */
export interface RateLimitRule {
  window: string;
  requests?: number;
  tokens?: number;
  costUsd?: number;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  createdAt: string;
  expiresAt?: string;
  description?: string;
  modelAccess?: ApiKeyModelAccess;
  limits?: RateLimitRule[];
}

// ---------------------------------------------------------------------------
// Console webAuth (username/password login for /admin)
// Mirrors backend GET /api/admin/auth/config (passwordHash never leaves the server)
// ---------------------------------------------------------------------------

export interface WebAuthStatus {
  active: boolean; // console requires login (enabled or forced by non-loopback bind)
  forced: boolean; // forced on because the gateway binds a non-loopback host
  enabled: boolean; // explicit config toggle
}

export interface AuthSessionResponse {
  status: string;
  webAuth: WebAuthStatus;
  authenticated: boolean;
}

export interface WebAuthConfigView extends WebAuthStatus {
  username: string;
  hasPassword: boolean;
  host: string;
}

// ---------------------------------------------------------------------------
// OpenCode-native provider management (opencode.jsonc `provider` + auth.json)
// ---------------------------------------------------------------------------

export interface OpenCodeProviderView {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  models: string[];
  custom: boolean;
  logo?: string;
  priceFrom?: number;
  modelsCount?: number;
  auth: {
    connected: boolean;
    type?: 'api' | 'oauth' | 'wellknown';
    keyMasked?: string;
    expires?: number;
    inline?: boolean;
  };
}

export interface OpenCodeCatalogProvider {
  id: string;
  name: string;
  logo?: string;
  npm?: string;
  api?: string;
  baseURL?: string;
  doc?: string;
  env?: string[];
  custom: boolean;
  connected: boolean;
  sources: string[];
  modelCount: number;
  priceFrom?: number;
}

/** One remote catalog source (config def + live sync state) — mirrors backend CatalogSourceView. */
export interface CatalogSourceView {
  id: string;
  type: 'provider-catalog' | 'model-list' | 'openai-compatible' | 'custom';
  url: string;
  enabled: boolean;
  priority: number;
  /** mandatory baseline (models.opencode.ai) — locked against removal/disabling */
  builtin: boolean;
  origin: 'network' | 'cache' | 'stale' | 'none';
  /** last successful sync (epoch ms) */
  fetchedAt?: number;
  lastError?: string;
  records: number;
}

export interface CatalogSourceDataModelRecord {
  id: string;
  name?: string;
  npm?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  defaultEffort?: string;
  reasoningOptions?: { type: string; values?: string[]; min?: number }[];
  variants?: { id: string; effort: string }[];
  interleaved?: { field?: string };
  structured_output?: boolean;
  status?: string;
  description?: string;
  family?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  knowledge?: string;
  canonical_model_id?: string;
  experimental?: Record<string, unknown>;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; input?: number; output?: number };
  /** ocr view only: creating source of this model entry */
  source?: string;
  /** hidden from the model catalog (overrides.json `disabled`) — kept in the
   *  aggregate, excluded from the routing pool at boot */
  disabled?: boolean;
}

/** Full aggregated catalog (catalogRepository.list()) — mirrors backend CatalogProviderRecord. */
export interface OcrCatalogProvider {
  id: string;
  name?: string;
  logo?: string;
  npm?: string;
  baseURL?: string;
  doc?: string;
  env?: string[];
  custom: boolean;
  connected: boolean;
  sources: string[];
  models: CatalogSourceDataModelRecord[];
}

export interface CatalogSourceDataProviderRecord {
  id: string;
  name?: string;
  npm?: string;
  api?: string;
  doc?: string;
  env?: string[];
  models?: CatalogSourceDataModelRecord[];
}

/** Payload behind the console "view data" dialog — mirrors backend sourceData(). */
export interface CatalogSourceDataResponse {
  status: string;
  source: CatalogSourceView;
  fetchedAt?: number;
  providers: CatalogSourceDataProviderRecord[];
  models: CatalogSourceDataModelRecord[];
}

export interface CustomProviderPayload {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyInline?: boolean;
  headers?: Record<string, string>;
  models?: Record<string, any>;
  options?: Record<string, any>;
}

/** Mirror of backend ProbeHintCode (opencode/probe.ts) — category labels,
 * never cause guesses or instructions (product rule 2026-10-14). */
export type ProbeHintCode =
  | 'regionBlocked'
  | 'authFailed'
  | 'protocolMismatch'
  | 'urlModelMismatch'
  | 'rateLimited'
  | 'upstreamError'
  | 'businessRejected'
  | 'endpointNotFound';

/** Result of the one-shot provider/model connectivity probe (POST .../test).
 * Mirror of backend ProbeResult (opencode/probe.ts) — machine limbs only;
 * the console composes the localized display via composeProbeError().
 * HTTP failures carry no diagnosis text by design (product decision
 * 2026-10-14): status + echoed upstream body only. */
export interface TestProviderResult {
  status: string;
  ok: boolean;
  kind?: 'openai' | 'anthropic' | 'google' | 'responses' | 'unroutable';
  model?: string;
  latencyMs?: number;
  authHint?: boolean;
  modelScoped?: boolean;
  httpStatus?: number;
  hintCode?: ProbeHintCode;
  transportCode?: 'timeout' | 'unreachable';
  transportUrl?: string;
  transportCause?: string;
  timeoutMs?: number;
  unroutableCode?: 'unknownPackage' | 'dedicatedTransport';
  unroutableNpm?: string;
  upstreamBody?: string;
  /** @deprecated pre-i18n backend limb (composed human string). Read ONLY by
   * the composeProbeError legacy passthrough during frontend/backend skew. */
  error?: string;
  /** Provider-level rotation: candidates tried, in order (only when > 1). */
  triedModels?: string[];
  account?: AccountMeta;
  provider?: string;
}

export interface OpenCodeModelView {
  providerId: string;
  providerName?: string;
  logo?: string;
  custom: boolean;
  connected: boolean;
  id: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
  /** def-level `disabled` — hidden from the model catalog (row toggle action). */
  disabled?: boolean;
  source: string;
}

// -- Bound credential store — mirrors backend credentials/types.ts + factory.ts.
// Backend serves machine-readable codes ONLY; all user-visible copy lives in i18n.

/** Bound store kinds (credentials/types.ts StoreKind). opencode v1 is unsupported:
 *  a v1 machine binds `ocr`, badged `unsupported_version`. */
export type CredentialStoreKind = 'opencode-v2' | 'opencode-v2-readonly' | 'ocr';

// 'bind_failed' is a real wire value (factory.ts StoreDegradedCode): an unexpected
// crash during the bind lands on OcrStore and badges itself with this code.
// 'unsupported_version' = opencode v1 detected, so credentials live in the OCR store.
export type CredentialStoreDegradedCode =
  | 'db_unreadable'
  | 'unsupported_version'
  | 'cli_absent_db_present'
  | 'bind_failed';

export type CredentialExcludedReasonCode =
  | 'db_unreadable'
  | 'no_routable_credential'
  | 'reconcile_push_failed'
  | 'bind_failed';

export interface CredentialStoreCapabilities {
  multiAccount: boolean;
  activate: boolean;
  rename: boolean;
  oauth: boolean;
  envVisible: boolean;
  /** Sink addresses credentials by a registered upstream integration id. */
  integrationScoped: boolean;
}

/** Masked, management-safe account metadata — never raw key material. */
export interface AccountMeta {
  id: string;
  providerId: string;
  label?: string;
  type: 'api' | 'oauth' | 'wellknown' | 'unknown';
  active: boolean;
  routable: boolean;
  keyHashPrefix?: string;
  maskedKey?: string;
}

export interface AccountOverview {
  providerId: string;
  total: number;
  routable: number;
  activeAccountId: string | null;
  /** Per-provider masked detail joined in by the B2 console handler. */
  accounts?: AccountHealth[];
}

/**
 * The health overlay every console account list carries
 * (GET credential-store + all three per-account write routes answer the same
 * shape, mirrors backend `AccountHealth` in console.ts). Additive keys only:
 * masked `AccountMeta` fields ride through untouched.
 */
export type AccountHealth = AccountMeta & {
  /** Administrative auth-failure flag; survives breaker resets (Decision 6). */
  suspect: boolean;
  /**
   * Operator takedown. Stronger than `suspect`: never set or lifted by runtime
   * evidence, survives cooldown/reconnect/Push, and excludes the credential from
   * selection, probing and model availability until the matching enable.
   */
  disabled: boolean;
  /** The operator's note attached at takedown time — present only when disabled. */
  disabledReason?: string;
  /** This credential's pair breakers currently OPEN (any model). */
  openPairs: number;
  /** Latest OPEN pair breaker's cooldown end (epoch ms) — only present when openPairs > 0. */
  cooldownUntilMs?: number;
  /** Outbound rate-limit rules armed for THIS credential (config `accounts:` overlay). */
  limits?: RateLimitRule[];
  /**
   * Quota tracking overlay — present ONLY when the account's
   * provider is COVERED (built-in table / code adapter / config entry).
   * Absence means "not covered", deliberately distinct from the `unverified`
   * badge ("covered, nothing probed yet"). Mirrors backend `AccountQuotaView`.
   */
  quota?: AccountQuotaView;
};

/** Four-state quota badge — mirrors backend `QuotaBadgeState`. */
export type QuotaBadgeState = 'probed' | 'declared' | 'unverified' | 'stale';

/** Snapshot provenance — mirrors backend `QuotaSource`. */
export type QuotaSource = 'probed' | 'measured' | 'declared' | 'forked';

/** One usage window — mirrors backend `QuotaWindow`. Absolute `used`/`total`
 *  in the window's own unit (v1 flattens currency), `remainingPct` 0..100,
 *  `resetAt` epoch ms, `unlimited` = no stated cap. */
export interface QuotaWindow {
  name: string;
  /** Machine-readable name identity for console i18n; absent = raw `name`. */
  nameCode?: string;
  /** Single argument for the coded name (hours, currency, model label, …). */
  nameArg?: string;
  used: number | null;
  total: number | null;
  remainingPct: number | null;
  resetAt: number | null;
  unlimited: boolean;
}

/** Raw last HTTP exchange for a quota pair — mirrors backend
 *  `LastProbeCapture`. Memory-only server-side (starts empty on restart). */
export interface LastProbeCapture {
  url: string;
  status?: number;
  ok: boolean;
  durationMs?: number;
  error?: 'network';
  body?: unknown;
}

/** Per-account quota view riding the AccountHealth overlay — mirrors backend
 *  `AccountQuotaView`. Display-only: nothing here gates routing. */
export interface AccountQuotaView {
  badge: QuotaBadgeState;
  source?: QuotaSource;
  plan?: string;
  windows: QuotaWindow[];
  verifiedAt?: number;
  lastFailureAt?: number;
  /** Built-in id / `adapter:<id>` / config `override:<id>` — provenance label. */
  entryId?: string;
  /** Effective cache window (ms). */
  ttlMs?: number;
}

/** Attributed per-pair served usage (trace ring GROUP BY provider×prefix) —
 *  mirrors backend `QuotaPairRow.usage`. */
export interface QuotaPairUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/** One connected (provider × credential) pair directory row — mirrors
 *  backend `QuotaPairRow` (GET /api/admin/quota). `covered` = live-plan
 *  coverage; `quota` present only when covered (or persisted by a previous
 *  lifetime); `usage` present only once turns have been attributed. */
export interface QuotaPairRow {
  providerId: string;
  keyHashPrefix: string;
  label?: string;
  covered: boolean;
  quota?: AccountQuotaView;
  usage?: QuotaPairUsage;
}

/** A provider the release covers — mirrors backend coverage rows. */
export interface QuotaCoverageRow {
  providerId: string;
  kind: 'dsl' | 'adapter';
  entryId: string;
}

/** A rejected quotaProbes config entry — mirrors backend rejected rows. */
export interface QuotaRejectedRow {
  id: string;
  error: string;
}

/** One quota burn event — mirrors backend `QuotaEvent` (quota_events ledger). */
export interface QuotaEventRow {
  id: string;
  ts: number;
  providerId: string;
  keyHashPrefix?: string;
  modelId?: string;
  statusCode?: number;
  reason: string;
  reasonCode: 'quota-exhausted';
}

/** GET /api/admin/quota response — mirrors backend `AccountQuotaView` family. */
export interface QuotaOverview {
  status: string;
  enabled: boolean;
  coverage: QuotaCoverageRow[];
  rejected: QuotaRejectedRow[];
  pairs: QuotaPairRow[];
  events: QuotaEventRow[];
}

/**
 * One live sliding-window constraint — mirrors backend `RateLimitSnapshotEntry`
 * (GET /api/admin/ratelimit). `subject` is the engine identity:
 * `apikey:<id>` or `account:<provider>:<keyHashPrefix>`.
 */
export interface RateLimitSnapshotEntry {
  subject: string;
  /** "1m/requests" style label echoing the YAML rule. */
  rule: string;
  windowMs: number;
  countable: 'requests' | 'tokens' | 'costUsd';
  limit: number;
  used: number;
  /** ms until this constraint has slack (0 when below the cap). */
  retryAfterMs: number;
}

/**
 * One TRIGGERED rate-limit decision — mirrors backend `RateLimitEvent`
 * (GET /api/admin/ratelimit/events). `direction`/`kind` classify it:
 * inbound = client key hit a cap (denied / grace-admitted), outbound =
 * a credential window was capped (skipped / forced / shaped). Repeats of
 * the same subject+kind+rule fold into one entry (`count`, `lastTs`).
 */
export type RateLimitEventDirection = 'inbound' | 'outbound';

export type RateLimitEventKind = 'denied' | 'grace-admitted' | 'skipped' | 'forced' | 'shaped';

/** Mirrors backend `RateLimitNoteCode` — machine-readable discriminator for
 *  `note`; rendered via the code→t('rateLimitPage.note*') table. */
export type RateLimitNoteCode =
  | 'grace-wait'
  | 'grace-exhausted'
  | 'keep-bound'
  | 'last-candidate'
  | 'spread'
  | 'failover';

export interface RateLimitEvent {
  /** Stable row key (the durable mirror's UPSERT target) — display ignores it. */
  id: string;
  ts: number;
  lastTs: number;
  count: number;
  direction: RateLimitEventDirection;
  kind: RateLimitEventKind;
  subject: string;
  rule: string;
  limitedBy: 'requests' | 'tokens' | 'costUsd';
  retryAfterMs: number;
  apiKeyName?: string;
  provider?: string;
  keyHashPrefix?: string;
  model?: string;
  note?: string;
  noteCode?: RateLimitNoteCode;
  noteParams?: { ms?: number };
}

/**
 * ReasonCodes of every credential-store write surface (console.ts
 * `capabilityRefusalBody` / `accountNotFoundBody` / `mapStoreWriteFailure`,
 * shared by the per-account routes and the provider connect/key/create ones).
 * `schema_mismatch` is deliberately absent: it exists only as a backend
 * StoreUnreadableError *reason*, and reaches the wire as `store_unreadable`.
 */
export type CredentialWriteReasonCode =
  | 'account_not_found'
  | 'capability_unsupported'
  | 'integration_unmatched'
  | 'invalid_label'
  | 'invalid_reason'
  | 'no_key_identity'
  | 'store_readonly'
  | 'store_unreadable'
  | 'write_failed';

/**
 * ReasonCodes of the reveal route (console.ts
 * `accountReveal`). The route ALSO surfaces the write table's codes through the
 * shared failure mapper (account_not_found / capability_unsupported /
 * store_unreadable) — these three are its own pre-login vocabulary.
 */
export type CredentialRevealReasonCode = 'webauth_required' | 'invalid_password' | 'too_many_attempts';

/** 200 reply of activate / rename — `accounts` is the refreshed store truth. */
export interface AccountWriteResponse {
  status: string;
  success: boolean;
  account: AccountHealth;
  accounts: AccountHealth[];
}

/** 200 reply of disconnect (Decision 8: the credential itself is gone). */
export interface AccountDisconnectResponse {
  status: string;
  success: boolean;
  disconnected: string;
  accounts: AccountHealth[];
}

/** POST /api/admin/health/suspect-accounts/clear — `cleared:false` = nothing to lift. */
export interface SuspectAccountClearResponse {
  status: string;
  provider: string;
  account: string;
  cleared: boolean;
}

export interface CredentialVersionEvidence {
  cli: string | null;
  file: string | null;
  used: 'cli' | 'installed.version' | 'last-known-good' | 'db-present' | 'none';
  lastKnownGood: string | null;
}

export interface CredentialProbeResult {
  ok: boolean;
  kind: CredentialStoreKind;
  state: 'ready' | 'empty' | 'unreadable';
  degradedCode?: CredentialStoreDegradedCode;
  detail?: string;
  accountCount: number;
}

export interface CredentialExcluded {
  provider: string;
  reasonCode: CredentialExcludedReasonCode;
  detail: string;
}

export interface CredentialStoreStatus {
  kind: CredentialStoreKind;
  capabilities: CredentialStoreCapabilities;
  /** null = bound cleanly (incl. the unbadged standalone 'ocr' landing). */
  degradedCode: CredentialStoreDegradedCode | null;
  evidence: CredentialVersionEvidence;
  excluded: CredentialExcluded[];
  accounts: AccountOverview[];
  probeResult: CredentialProbeResult | null;
  credentialFile: string;
  boundAt: number;
  /**
   * Integration-scoped sinks only: the provider ids that accept credential
   * writes. ABSENT when not integration-scoped OR when the registry was
   * unreadable — consumers must treat absent as "unknown", never as "nothing
   * writable", so no affordance may be disabled on it.
   */
  integrations?: string[];
  detail?: string;
}

export interface CredentialReconcileEntry {
  provider: string;
  action: 'pushed' | 'deduped' | 'failed';
  reason?: string;
}

export interface CredentialReconcileSummary {
  doneAt: number;
  authWriteDisabled: boolean;
  entries: CredentialReconcileEntry[];
}

export interface CredentialStoreStatusResponse {
  status: string;
  store: CredentialStoreStatus;
  reconcile: CredentialReconcileSummary | null;
}

/** B4 contract: POST /api/admin/credential-store/push { provider }. */
export interface CredentialPushResponse {
  status: string;
  pushed: string[];
  failed: { provider: string; reason: string }[];
}

/** 400 precondition codes of the push route — mirrors backend PUSH_PRECONDITION_ERROR keys. */
export type CredentialPushReasonCode = 'not_ocr_bound' | 'opencode_v2_service_unreachable' | 'opencode_v2_db_unreadable';

/** One per-account purge failure in the honest DELETE reply. */
export interface ProviderPurgeFailure {
  accountId: string;
  reason: string;
}

/**
 * PurgeAuth=1 detail. The route answers success=false whenever
 * attempted>0 && removed<attempted — partial purges never claim full deletion.
 */
export interface ProviderPurgeResult {
  attempted: number;
  removed: number;
  failed: ProviderPurgeFailure[];
}

/**
 * OcJson failure with the backend's machine-readable `reasonCode` attached
 * when the error body carries one (push 400 preconditions). Purely additive:
 * the message contract is unchanged and message-only callers are unaffected.
 */
export class OcApiError extends Error {
  readonly reasonCode?: string;
  /** Parsed non-2xx body — carries the machine params (url/cause/httpStatus)
   * a reasonCode needs for client-side i18n composition. */
  readonly body?: unknown;

  constructor(message: string, reasonCode?: string, body?: unknown) {
    super(message);
    this.name = 'OcApiError';
    this.reasonCode = reasonCode;
    this.body = body;
  }
}

function ocJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    return res
      .json()
      .catch(() => ({}))
      .then((e: any) => {
        throw new OcApiError(
          e?.error || e?.message || `HTTP ${res.status}`,
          typeof e?.reasonCode === 'string' ? e.reasonCode : undefined,
          e
        );
      }) as Promise<T>;
  }
  return res.json();
}

/** Per-account write path (activate / rename / disconnect share it). */
function accountPath(providerId: string, accountId: string): string {
  return `/api/admin/opencode/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`;
}

export const opencodeApi = {
  async listProviders(): Promise<{
    status: string;
    configPath: string;
    authPath: string;
    providers: OpenCodeProviderView[];
  }> {
    return ocJson(await fetch('/api/admin/opencode/providers'));
  },

  /** Bound credential-store status (kind, capabilities, exclusions, masked accounts). */
  async getCredentialStore(): Promise<CredentialStoreStatusResponse> {
    return ocJson(await fetch('/api/admin/credential-store'));
  },

  /** One-shot Push-to-opencode convergence. */
  async pushCredentialStore(provider: string): Promise<CredentialPushResponse> {
    return ocJson(
      await fetch('/api/admin/credential-store/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
    );
  },

  /** Make one account the active credential of its provider. */
  async activateProviderAccount(
    providerId: string,
    accountId: string
  ): Promise<AccountWriteResponse> {
    return ocJson(await fetch(accountPath(providerId, accountId) + '/activate', { method: 'POST' }));
  },

  /**
   * Take one credential out of routing / put it back. The flag lives in OCR's own
   * account state, so unlike the store writes these work on a read-only binding
   * too. `reason` is an operator note (max 200 chars), display only.
   */
  async disableProviderAccount(
    providerId: string,
    accountId: string,
    reason?: string
  ): Promise<AccountWriteResponse> {
    return ocJson(
      await fetch(accountPath(providerId, accountId) + '/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      })
    );
  },

  /** Lift the takedown (the only path that does — cooldown never will). */
  async enableProviderAccount(providerId: string, accountId: string): Promise<AccountWriteResponse> {
    return ocJson(await fetch(accountPath(providerId, accountId) + '/enable', { method: 'POST' }));
  },

  /** Set an account's user-editable label (backend trims, max 80). */
  async renameProviderAccount(
    providerId: string,
    accountId: string,
    label: string
  ): Promise<AccountWriteResponse> {
    return ocJson(
      await fetch(accountPath(providerId, accountId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
    );
  },

  /**
   * Disconnect one account: the store holds the
   * only copy of the key, so the caller must have run the double confirmation
   * (see KeysPage's Decision 8 arbiter) before calling this.
   */
  async disconnectProviderAccount(
    providerId: string,
    accountId: string
  ): Promise<AccountDisconnectResponse> {
    return ocJson(await fetch(accountPath(providerId, accountId), { method: 'DELETE' }));
  },

  /**
   * Controlled reveal: re-enter the console LOGIN
   * password to export one raw api key. The returned `key` must pass straight
   * from this call's scope into the clipboard — never into component state,
   * the DOM, or any persisted surface.
   */
  async revealProviderKey(
    providerId: string,
    accountId: string,
    password: string
  ): Promise<{ status: string; key: string }> {
    return ocJson(
      await fetch(accountPath(providerId, accountId) + '/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
    );
  },

  async catalog(refresh = false): Promise<{ status: string; source: string; providers: OpenCodeCatalogProvider[] }> {
    return ocJson(await fetch(`/api/admin/opencode/catalog${refresh ? '?refresh=1' : ''}`));
  },

  async catalogSources(): Promise<{ status: string; syncIntervalMs: number; sources: CatalogSourceView[] }> {
    return ocJson(await fetch('/api/admin/catalog/sources'));
  },

  async setCatalogSyncInterval(intervalMs: number): Promise<{ status: string; syncIntervalMs: number }> {
    return ocJson(
      await fetch('/api/admin/catalog/sync-interval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMs }),
      })
    );
  },

  async catalogSourceData(id: string): Promise<CatalogSourceDataResponse> {
    return ocJson(await fetch(`/api/admin/catalog/sources/${encodeURIComponent(id)}/data`));
  },

  async addCatalogSource(payload: {
    id: string;
    type: string;
    url: string;
    priority?: number;
    enabled?: boolean;
    map?: Record<string, any>;
  }): Promise<{ status: string; source: CatalogSourceView }> {
    return ocJson(
      await fetch('/api/admin/catalog/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  async toggleCatalogSource(id: string, enabled: boolean): Promise<{ status: string; source: CatalogSourceView }> {
    return ocJson(
      await fetch(`/api/admin/catalog/sources/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
    );
  },

  async removeCatalogSource(id: string): Promise<{ status: string }> {
    return ocJson(await fetch(`/api/admin/catalog/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },

  async refreshCatalogSource(id: string): Promise<{ status: string; source: CatalogSourceView }> {
    return ocJson(await fetch(`/api/admin/catalog/sources/${encodeURIComponent(id)}/refresh`, { method: 'POST' }));
  },

  async refreshAllCatalogSources(): Promise<{ status: string; sources: CatalogSourceView[] }> {
    return ocJson(await fetch('/api/admin/catalog/sources/refresh', { method: 'POST' }));
  },

  async lockedCatalogModels(): Promise<{ status: string; lockedModels: string[] }> {
    return ocJson(await fetch('/api/admin/catalog/locked-models'));
  },

  async ocrCatalog(): Promise<{ status: string; providers: OcrCatalogProvider[] }> {
    return ocJson(await fetch('/api/admin/catalog/ocr'));
  },

  async getCatalogOverride(providerId: string, modelId: string): Promise<{ status: string; entry: Record<string, any> | null }> {
    const qs = new URLSearchParams({ providerId, modelId });
    return ocJson(await fetch(`/api/admin/catalog/override?${qs.toString()}`));
  },

  async putCatalogOverride(
    providerId: string,
    modelId: string,
    entry: Record<string, any>
  ): Promise<{ status: string }> {
    return ocJson(
      await fetch('/api/admin/catalog/override', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, modelId, entry }),
      })
    );
  },

  async removeCatalogOverride(providerId: string, modelId: string): Promise<{ status: string }> {
    const qs = new URLSearchParams({ providerId, modelId });
    return ocJson(await fetch(`/api/admin/catalog/override?${qs.toString()}`, { method: 'DELETE' }));
  },

  async toggleCatalogModelLock(id: string, locked: boolean): Promise<{ status: string; lockedModels: string[] }> {
    return ocJson(
      await fetch('/api/admin/catalog/locked-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, locked }),
      })
    );
  },

  async listModels(params?: { provider?: string; connected?: boolean }): Promise<{
    status: string;
    source: string;
    total: number;
    models: OpenCodeModelView[];
  }> {
    const qs = new URLSearchParams();
    if (params?.provider) qs.set('provider', params.provider);
    if (params?.connected) qs.set('connected', '1');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return ocJson(await fetch(`/api/admin/opencode/models${suffix}`));
  },

  async createProvider(payload: CustomProviderPayload): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch('/api/admin/opencode/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  async updateProvider(id: string, payload: Partial<CustomProviderPayload>): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  /**
   * Connect hands a key to the BOUND store. `deduped:true` = the store already
   * held this exact key for the provider, so NO second account was created
   * (idempotent success — `account` names the row that survived).
   * `headPreserved` = the sink auto-activated the new key and this surface handed
   * the chain head back to the credential that was serving (opencode's `active`
   * is ALSO the key its own CLI uses, so adding an account must not repoint it).
   * The reply mirrors backend console.ts `connect` inline.
   */
  async connectProvider(
    id: string,
    apiKey: string,
    baseURL?: string
  ): Promise<{
    status: string;
    success: boolean;
    deduped?: boolean;
    account?: AccountMeta;
    headPreserved?: AccountMeta;
    message?: string;
  }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, baseURL }),
      })
    );
  },

  /** One-shot upstream connectivity probe — optional overrides enable test-before-save; `accountId` pins the probe to ONE credential row (per-account test). */
  async testProvider(
    id: string,
    payload?: { modelId?: string; apiKey?: string; baseURL?: string; accountId?: string }
  ): Promise<TestProviderResult> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
    );
  },

  /**
   * PurgeAuth=1 deletes the config node AND loops per-account disconnects
   * through the bound store; the reply carries the honest `purge` detail.
   */
  async deleteProvider(
    id: string,
    purgeAuth = false
  ): Promise<{ status: string; success: boolean; message?: string; purge?: ProviderPurgeResult }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}${purgeAuth ? '?purgeAuth=1' : ''}`, {
        method: 'DELETE',
      })
    );
  },

  // -- Per-provider model maintenance (config-defined providers only) ----

  async listProviderModels(id: string): Promise<{ status: string; id: string; models: Record<string, any> }> {
    return ocJson(await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models`));
  },

  async addProviderModel(
    id: string,
    model: {
      id: string;
      name?: string;
      modelID?: string;
      disabled?: boolean;
      capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
      settings?: Record<string, any>;
      headersText?: string;
      bodyText?: string;
      compatibility?: { reasoningField?: string };
      variants?: { id: string; settings?: Record<string, any> }[];
      reasoning?: boolean;
      toolCall?: boolean;
      attachment?: boolean;
      temperature?: boolean;
      modalities?: { input?: string[]; output?: string[] };
      contextLimit?: number;
      outputLimit?: number;
      cost?: Record<string, number>;
      definition?: Record<string, any>;
    }
  ): Promise<{ status: string; success: boolean; model: string }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      })
    );
  },

  async updateProviderModel(
    id: string,
    modelId: string,
    patch: {
      name?: string;
      modelID?: string;
      disabled?: boolean;
      capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
      settings?: Record<string, any>;
      headersText?: string;
      bodyText?: string;
      compatibility?: { reasoningField?: string };
      variants?: { id: string; settings?: Record<string, any> }[];
      reasoning?: boolean;
      toolCall?: boolean;
      attachment?: boolean;
      temperature?: boolean;
      modalities?: { input?: string[]; output?: string[] };
      contextLimit?: number;
      outputLimit?: number;
      newId?: string;
      cost?: Record<string, number>;
      definition?: Record<string, any>;
    }
  ): Promise<{ status: string; success: boolean; model: string }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    );
  },

  async deleteProviderModel(id: string, modelId: string): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, {
        method: 'DELETE',
      })
    );
  },

  async pullProviderModels(
    id: string,
    opts: { pattern?: string; dryRun?: boolean; live?: boolean } = {}
  ): Promise<{
    status: string;
    live?: boolean;
    matched?: number;
    pullable?: number;
    pulled?: number;
    skipped?: number;
    success?: boolean;
    hint?: string;
    models: OpenCodeModelView[] | string[];
  }> {
    // Failure bodies (pull_* reasonCodes + machine params) arrive on the
    // thrown OcApiError.body — localized by apiErrorText() in useModelTest.
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      })
    );
  },

  async clearProviderModels(id: string, pattern?: string): Promise<{ status: string; success: boolean; removed?: number }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern }),
      })
    );
  },
};
