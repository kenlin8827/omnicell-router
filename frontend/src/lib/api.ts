import type { Lang } from '../i18n/types';

/** Credential methods a plugin's connect card may offer (backend PluginAuthType). */
export type PluginAuthType = 'webLogin' | 'key';

export interface ProjectItem {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectsResponse {
  status: 'ok';
  activeId: string | null;
  projects: ProjectItem[];
}

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

/** Where a client hook lands — mirrors backend `ClientHookKind`. */
export type ClientHookKind = 'config' | 'launcher' | 'service-env' | 'proxy-config';

export interface ClientStatus {
  name: string;
  displayName: string;
  /** Where the hook lands (backend `ClientAdapter.hookKind`). */
  hookKind: ClientHookKind;
  configPath: string;
  exists: boolean;
  hooked: boolean;
  backupExists: boolean;
  /** Extra concrete models exposed in the client's model switcher (opencode) */
  extraModels?: string[];
  /** Installed CLI version vs the adapter's minimum-compatible floor (absent = adapter declares no probe). */
  version?: { current: string; min?: string; meetsMin: boolean };
  /** This client's model slots; value undefined = auto (intelligent routing). */
  modelSlots: { key: string; value?: string; default?: string; description?: string }[];
  /** Last-linked model profile (opencode): profile id + agent→slot-key tags
   *  (the linked rows — their effective models resolve from the profile). */
  profile?: ModelProfileBinding;
  /** A file an adapter owns besides its primary `configPath` (Cursor's CLI
   *  launcher); `exists` probed at status time. Mirrors backend ClientArtifact. */
  artifacts?: ClientArtifact[];

  /** Family adapters (JetBrains): the product instances this machine has, each
   *  with its own takeover state. Absent = single-product adapter. Mirrors
   *  backend ClientProductStatus. */
  products?: ClientProductStatus[];
}

/** Mirrors backend ClientArtifact (a file an adapter owns besides `configPath`). */
export interface ClientArtifact {
  path: string;
  exists: boolean;
}

/** One product instance inside a family adapter (mirrors backend ClientProductStatus). */
export interface ClientProductStatus {
  /** Stable product key — also the `product` action target (`intellij-idea`, `goland`). */
  id: string;
  displayName: string;
  version: string | null;
  configPath: string;
  exists: boolean;
  hooked: boolean;
  backupExists: boolean;
  /** Is the MITM root trusted where THIS product's JBR reads it (own store or
   *  the vmoptions copy)? `unknown` when the probe cannot run. */
  caTrusted: boolean | 'unknown';
  /** Installed ACP agent (Junie) version for this product's config root. */
  junieVersion: string | null;
  /** Files this product owns (settings, per-product agents dir) — the
   *  `.ocr-backup` snapshot is reversible state, never an artifact. */
  artifacts: ClientArtifact[];
}

/** Advise-only finding from a SUCCESSFUL client setup (backend
 *  `ClientActionWarning`): the artifact was written, but the client will still
 *  fail at use time until this is fixed. */
export interface ClientActionWarning {
  code:
    | 'ca_not_trusted'
    | 'ca_trust_unknown'
    | 'proxy_not_running'
    | 'ide_running'
    /** IDE install's truststore is read-only; the CA lives in a copy its vmoptions point at. */
    | 'ide_truststore_readonly'
    /** The ACP agent (Junie) could not be provisioned. */
    | 'junie_install_failed'
    /** Junie's OCR model list could not be written. */
    | 'junie_models_failed';
  params?: Record<string, string>;
}

/** Mirrors backend ModelProfileBinding (profile-link echo from the OCR sidecar meta). */
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
  /** Inherit target (config default model) — present only when `model` is
   *  absent; display-only, feeds the row's current-model infotip. */
  effective?: string;
  /** The agent's own description (frontmatter / config node / live roster) —
   *  the smart-assign decider's role context. Absent = unknown. */
  description?: string;
}

/** Mirrors backend ClientProfileMemoryEntry — per-client console form memory
 *  (config.yaml `clientProfileMemory`): a write-through mirror of the form's
 *  selections (saved on every pick). UI-only: never consulted by routing or
 *  by the hook itself. */
export interface ClientProfileMemoryEntry {
  profile: string;
  bindings: Record<string, string>;
  /** models = slot → model-ref draft (pi/omp main, plain slot clients);
   *  agentModels = role/agent → raw draft ref (native pins included);
   *  extraModels = the custom model-list draft. Mirrors backend. */
  models?: Record<string, string>;
  agentModels?: Record<string, string>;
  extraModels?: string[];
  /** Custom virtual-tier draft (auto/lite/plus/pro/ultra); undefined =
   *  untouched — setup omits `virtualModels` (adapter default block); an
   *  array (possibly empty) scopes the block to that set. Mirrors backend. */
  virtualModels?: string[];
  /** Model-list source: 'none' (default) = no concrete models exposed,
   *  'follow' = mirror the selected API key's effective model access,
   *  'custom' = manual picker. Mirrors backend. */
  modelMode?: 'none' | 'custom' | 'follow';
  /** Last-written gateway key id (apiKeys[].id); a stale id (deleted key)
   *  seeds nothing. Mirrors backend. */
  apiKeyId?: string;
  /** Agent/role link table visibility (opencode, pi). OFF = table hidden and
   *  setup omits the agent payload entirely. Absent = seed from whether
   *  links exist. Mirrors backend. */
  linksOn?: boolean;
}

// Mirrors backend CircuitBreakerSnapshot (backend/src/resilience/types.ts)
export interface BreakerInfo {
  modelId: string;
  provider: string;
  tier?: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /** Blast radius of the last trip delivered to this breaker: 'model' | 'credential' | 'pair' | 'provider'. */
  scope?: 'model' | 'credential' | 'pair' | 'provider';
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
export type BreakerScopeOverride = 'auto' | 'pair' | 'credential' | 'model' | 'provider';

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
  /** Request-fault 4xx (by status, not wording): default OFF = non-penalizing CLIENT_ERROR. No cooldown param — the tripping rule's ladder applies. */
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

/** The classifier's intrinsic, PRE-OVERRIDE disposition for a class (backend
 *  ClassifierDisposition). Advisory only: the operator's rule switches in block A
 *  decide the effective disposition, so the console never prints this as truth —
 *  it only seeds the reference row's "not counted by default" emphasis. */
export type ClassifierDisposition = 'hard_trip' | 'counted' | 'ignored';

/**
 * Read-only reference descriptor of the classifier's FIXED mapping (backend
 * ClassifierTaxonomyEntry). Single-sourced from the gateway's CLASSIFIER_TAXONOMY
 * and pinned to classify() by a backend test — the console renders it, never
 * re-declares the behavior. `category` reuses the FailureErrorClass vocabulary
 * (the auto-detected subset); `defaultScope`/variants reuse BreakerTripScope.
 */
export interface ClassifierTaxonomyEntry {
  category: Exclude<FailureErrorClass, 'MANUAL' | 'TIMEOUT'>;
  defaultScope: BreakerTripScope;
  disposition: ClassifierDisposition;
  countingToggle: boolean;
  governedBy: string;
  hostScope?: BreakerTripScope;
  credentialScope?: BreakerTripScope;
  conditionalHardTrip?: boolean;
  marksSuspect?: boolean;
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
  credentialAffinity?: {
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
 * 'model' is the legacy whole-model breaker; 'credential' is one credential across the
 * models it can reach; 'pair' is one (model, credential) pair; 'provider' is every
 * tuple of every model of the provider (host-level takedown).
 */
export type BreakerTripScope = 'model' | 'credential' | 'pair' | 'provider';

export interface BreakerScopeResponse {
  status: string;
  scope?: BreakerTripScope;
  /** Breakers taken down (trip) / reset (reset). */
  affected?: number;
  resetCount?: number;
  message?: string;
}

// Masked provider entry from /api/admin/status (ProviderConfig with apiKey masked)
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
    /**
     * Static read-only reference: the classifier's fixed error-class mapping
     * (backend CLASSIFIER_TAXONOMY, ADR-0004 §1). Additive: older gateways omit
     * it and the breaker-rules classifier-reference panel stays hidden.
     */
    classifier?: ClassifierTaxonomyEntry[];
  };
  clients: ClientStatus[];
  /**
   * Runtime credential directory (provider + keyHash prefix only). Additive:
   * older gateways omit it. Lets the guardrails matrix name an orphan breaker
   * as the inline config-baked default credential instead of a bare #hash.
   */
  credentialHashes?: { provider: string; keyHashPrefix: string }[];
  registeredModelsCount: number;
  /** Inbound forward-proxy runtime status (backend forward-proxy/status.ts). */
  forwardProxy?: {
    enabled: boolean;
    /** ADR-0019: upstream certificate verification is OFF — a standing risk. */
    upstreamInsecure?: boolean;
    running: boolean;
    port?: number;
    host?: string;
    startedAt?: number;
    error?: string;
  };
}

/** One row of the forward-proxy access log (backend forward-proxy/access-log.ts). */
export interface ProxyAccessEvent {
  id: string;
  ts: number;
  kind: 'connect' | 'http';
  host: string;
  port: number;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  reqBytes: number;
  respBytes: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  /** 'hex' when THAT side's stored body is an INLINE hex dump (persist off). */
  reqBodyFormat?: 'hex';
  resBodyFormat?: 'hex';
  /** bodies-dir ref (`<day>/<name>.bin`) when THAT binary body was persisted as a raw file. */
  reqBodyFile?: string;
  resBodyFile?: string;
  /** Opaque download token for the persisted body — the console's ONLY way to
   *  address it (one neutral URL, no storage/subsystem detail). */
  reqBodyToken?: string;
  resBodyToken?: string;
  /** Sniffed MIME for the persisted binary body file. */
  reqBodyMime?: string;
  resBodyMime?: string;
  truncated?: boolean;
  /** Wire protocol of the serving leg ('h1' | 'h2' | 'ws') — console protocol column. */
  wire?: string;
  note?: string;
}

/** One row of the federated traffic timeline — a discriminated union on
 *  `source`: the proxy access log, or a plugin gateway's traffic feed. */
export type TimelineRow =
  | { source: 'proxy'; ev: ProxyAccessEvent }
  | { source: string; ex: PluginTrafficEvent };

export interface ProxyTimelineResponse {
  status: string;
  /** Live scope only: whether the proxy access log is recording. */
  enabled?: boolean;
  /** Live scope only: per-side inline capture cap; absent = the backend
   *  default cap (`DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES`, 1 MiB), 0 = headers. */
  bodyBytes?: number;
  /** Federated rows, newest first (both scopes — the backend merges). */
  rows: TimelineRow[];
  /** Exact count across ALL sources. Live: the merged tail's length (the
   *  console pages it locally). History: the paged query's exact total. */
  total: number;
  /** History scope: the served page / page count. */
  page?: number;
  pages?: number;
}

/** One RAW captured exchange in a client-gateway plugin's generic traffic
 *  feed (base64 bodies stripped by the route; decoded layers attached). */
export interface PluginTrafficEvent {
  /** Persisted row identity (feeds written after ids existed) — the delete key. */
  id?: string;
  ts?: string;
  authority?: string;
  method?: string;
  path?: string;
  reqContentType?: string;
  resContentType?: string;
  status?: number;
  durationMs?: number;
  leg?: string;
  reqTruncated?: boolean;
  resTruncated?: boolean;
  /** Captured header maps (names lowercased, values capped by the plugin). */
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  /** Small hex preview of each captured side (≤1KiB) — the no-decoder fallback. */
  reqHex?: string;
  resHex?: string;
  /** Sidecar refs of the FULL captured bodies (`<day>/<id>-<side>.bin`). */
  reqBodyFile?: string;
  resBodyFile?: string;
  /** Opaque download token for the persisted body (neutral URL, see above). */
  reqBodyToken?: string;
  resBodyToken?: string;
  /** Full captured byte counts (independent of the display window). */
  reqBodyBytes?: number;
  resBodyBytes?: number;
  decoded?: { decoder: string; layers: { name: string; side?: 'req' | 'res'; frames?: unknown[] }[] };
}

export interface PluginTrafficDecodersResponse {
  status: string;
  decoders: { id: string; label: string }[];
}

export interface PluginTrafficResponse {
  status: string;
  days: number;
  truncated?: boolean;
  events: PluginTrafficEvent[];
}

/** OS system-proxy ownership state (backend forward-proxy/system-proxy.ts). */
export interface SystemProxyStatus {
  platform: string;
  supported: boolean;
  state: 'off' | 'on' | 'external' | 'stale' | 'unsupported';
  currentServer?: string;
  targetServer?: string;
  override?: string;
  caPath: string;
  proxyEnabled?: boolean;
}

/**
 * Persisted MITM CA identity — mirrors the backend contract `CaMeta`
 * (forward-proxy/ca.ts `describeCa`). Never key material.
 */
export interface CaMeta {
  /** Absolute path of the PEM clients must trust. */
  path: string;
  fingerprintSha256: string;
  subject: string;
  notBefore: string;
  notAfter: string;
}

/**
 * Platform trust state of the MITM CA — mirrors the backend
 * `GET /api/admin/proxy/ca/trust` answer. `unknown` means the probe could not
 * run (missing platform tool / permissions), NOT "not trusted".
 */
export interface CaTrustResponse {
  trusted: boolean | 'unknown';
  /** Absolute PEM path the probe inspected. */
  caPath: string;
  /** Epoch ms of the probe that produced this answer; ABSENT when no probe ran
   *  (there is no CA file to identify yet). */
  checkedAt?: number;
}

/**
 * Forward-proxy rule table (backend forward-proxy/rules.ts, ADR-0018 second
 * revision).
 *
 * ONE ordered table, first match wins. Each row carries TWO fields splitting
 * the decision into its axes: `ingress` — what happens at ingress (`intercept`
 * = MITM (a specific row means it; on the catch-all row it is only the default
 * posture for hosts nothing claims); `passthrough` = blind tunnel; `reject` =
 * 403 on admission) — and `egress` — where the bytes exit (`direct` /
 * `proxy`). A `reject` row uses `egress: 'direct'`. Loopback is always
 * passthrough + direct; an unmatched host takes the catch-all's `egress` and is
 * blind-tunneled unless a live client-gateway plugin CLAIMS it or the audit
 * posture (`intercept: 'all'`) is on (ADR-0018 Revision 4).
 */
export type RuleIngress = 'intercept' | 'passthrough' | 'reject';

/**
 * The interception posture (ADR-0018 Revision 4) — `'claims'` (default) decrypts
 * only plugin-claimed hosts and explicit `ingress: intercept` rows; `'all'` is
 * the machine-wide audit posture. Parity-checked against the backend's
 * `INTERCEPT_POSTURES` by `forward-proxy-console-vocabulary-parity.test.ts`.
 */
export type InterceptPosture = 'claims' | 'all';

/** Where the bytes exit. */
export type RuleEgress = 'direct' | 'proxy';

/** The exit half of a decision — where the bytes go. */
export type RuleExit = 'direct' | 'proxy' | 'reject';

/** One row of the rule table. `match` is a glob over the bare hostname. */
export interface ForwardProxyRule {
  match: string;
  ingress: RuleIngress;
  egress: RuleEgress;
}

/** Lint codes — the console owns the wording (i18n); the backend owns the rule. */
export type RuleWarningCode =
  | 'invalid-rule'
  | 'unreachable-rule'
  | 'no-catch-all'
  | 'catch-all-intercepts'
  | 'proxy-rule-without-proxy';

export interface RuleWarning {
  code: RuleWarningCode;
  /** Index into the RAW rules array (the row the operator typed). */
  ruleIndex?: number;
  /** English detail for logs — never rendered untranslated. */
  detail?: string;
}

/** The full decision for a probe host — the console preview + the ledger note. */
export interface HostDecision {
  action: RuleExit;
  tunnel: boolean;
  /** `claim` = a live client-gateway plugin claims this host, so it is decrypted. */
  reason: 'loopback' | 'rule' | 'claim' | 'fallback';
  ruleIndex?: number;
  match?: string;
}

export interface RulesResolveResponse {
  status: string;
  rules: ForwardProxyRule[];
  warnings: RuleWarning[];
  /** `config.proxy.enabled` — a `proxy` row is inert while this is false. */
  proxyEnabled: boolean;
  /** Interception posture in force (or the UNSAVED one when the body carried it). */
  intercept: InterceptPosture;
  /** Hosts a live client-gateway plugin claims — decrypted under `claims`. */
  claimed: string[];
  /** The same claim set, attributed: which plugin declares which hosts. */
  claimSources: ClaimSource[];
  /** Null when the request carried no probe host. */
  decision: HostDecision | null;
}

/** One live client-gateway plugin and the hosts it claims. */
export interface ClaimSource {
  pluginId: string;
  hosts: string[];
}

/** `POST /api/admin/forward-proxy/tighten` — the catch-all rewritten to a blind tunnel. */
export interface TightenRulesResponse {
  status: string;
  rules: ForwardProxyRule[];
  intercept: InterceptPosture;
  warnings: RuleWarning[];
}

/**
 * Structured arguments for a localized routing reason — the optional
 * `reasonParams` the gateway emits beside `reason`. Values arrive ready to be
 * substituted into `{key}` slots; `cached: true` marks a reused decision.
 */
export type ReasonParams = Record<string, string | number | boolean>;

// Mirrors backend ExecutionTrace (backend/src/trace/tracker.ts) returned by /api/admin/traces
export interface TraceRecord {
  /**
   * Gateway-owned id of this turn — unique per request, so it is the React
   * key / row identity. The caller's correlation value lives beside it as
   * `clientRequestId` and may repeat across rows (ADR-0021).
   */
  requestId: string;
  clientRequestId?: string;
  /** Gateway conversation entity id (ADR-0002). */
  sessionId: string;
  requestNumber: number;
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
    layerUsed: 'layer0' | 'entry' | 'layer2';
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
    /** Time to first forwarded chunk of the committed attempt; undefined = turn never streamed. */
    ttftMs?: number;
    /** Decode window (first chunk → stream drained) — the decode-TPS denominator; undefined as above. */
    genMs?: number;
    /** Total time in felt pauses (gaps ≥1 s between chunks carrying output the client received); undefined = no measurable gap. */
    stalledMs?: number;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    failoverOccurred?: boolean;
    failoverAttempts?: number;
    failoverPath?: string[];
    inplaceRetries?: number;
    /**
     * Thinking-effort observability (mirrors backend ExecutionTrace):
     * the level the client asked for (absent = field omitted), the level
     * actually served after translation/capability clamp, and the
     * served-below-asked flag. Absent on traces recorded before these
     * fields existed.
     */
    requestedEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    actualEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    reasoningDegraded?: boolean;
    /** WHO authored the ask (ADR-0012): 'client' or a gateway decision
     *  (l2-decision / entry / directive / model default; legacy rows from the
     *  retired retry-escalation ladder may still read 'escalation' — display
     *  only). Absent on old rows. */
    effortSource?: 'client' | 'l2-decision' | 'entry' | 'directive' | 'default' | 'escalation';
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
  redactSecrets: boolean;
  totalBytes: number;
  dateCount: number;
}

/** Wire spec for POST /api/admin/capture/replay (mirrors frontend/src/lib/curl.ts ReplaySpec). */
export interface ReplaySpec {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  provider?: string;
  model?: string;
}

export type CaptureReplayResult =
  | { status: 'loading' }
  | {
    status: 'ok';
    statusLine: string;
    headers: Record<string, string>;
    body: string;
    truncated: boolean;
    /** ms from dispatch to the status/headers event (first byte). */
    ttfbMs: number;
    /** ms from dispatch to stream end. */
    totalMs: number;
  }
  | { status: 'error'; message: string };

/** NDJSON stream events emitted by POST /api/admin/capture/replay. */
export type CaptureReplayStreamEvent =
  | { type: 'status'; statusLine: string; headers: Record<string, string> }
  | { type: 'chunk'; text: string }
  | { type: 'end'; truncated: boolean }
  | { type: 'error'; message: string };

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
  /** Total captured REQUESTS in this archive (ADR-0024 request layer). */
  requests: number;
  /** Requests with an error outcome. */
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
  /**
   * All date dirs (newest first) holding this session's archive — present
   * ONLY when the conversation spans >1 date (crossed midnight; same file
   * name is sharded by write-time date). Mirrors backend
   * listSessionsWithSpans.
   */
  spanDates?: string[];
  /**
   * Inbound protocol discriminator from the first client-request event's
   * request line (backend CaptureSessionRow.protocol). Every recognized
   * surface is labeled explicitly — chat included. Undefined = a legacy
   * archive without request lines or an unrecognized path (unbadged).
   */
  protocol?: 'chat' | 'anthropic' | 'responses' | 'systemone';
}

/** One date-dir fragment of a stitched (cross-midnight) conversation read. */
export interface CaptureFragmentRow {
  date: string;
  file: string;
  /** Requests contributed by this shard. */
  requests: number;
}

/** One archive hit for a session id: coordinates only (date dir + file name) */
export interface CaptureSessionMatch {
  date: string;
  file: string;
}

/** UTF-8 text, or hex for binary payloads. Mirrors backend `WireBody`. */
export type WireBody = string | { hex: string };

/** Byte-faithful wire snapshot of ONE side of ONE HTTP exchange. */
export interface RawWireCapture {
  requestLine: string;
  requestHeaders: Record<string, string>;
  requestBody: WireBody;
  responseLine: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: WireBody;
}

export interface CaptureEvent {
  id: string;
  ts: number;
  eventType: 'http-exchange';
  /** Every schema-2 archive line carries 2. */
  schema: 2;
  direction: 'client' | 'upstream';
  phase: 'request' | 'response';
  /** Write-time turn identity, copied onto EVERY event of the request. */
  turnIndex: number | null;
  isPromptStart: boolean;
  turnDecision: 'new_prompt' | 'continuation' | 'ambiguous_compaction' | 'no_prompt';
  /** 1-based attempt ordinal within (requestId, leg). */
  attempt: number;
  /** One HTTP request/response pair shares one exchangeId. */
  exchangeId: string;
  clientRequestId?: string;
  /** Gateway REQUEST id (ADR-0021) — the exact join key. */
  requestId: string;
  /** The provider's own response id, when its wire exposes one. */
  upstreamRequestId?: string;
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
  /** Why this exchange happened when it is NOT ordinary turn traffic. 'l2-decision' = the L2 decision layer's decision-model call. Absent = ordinary traffic. */
  purpose?: 'l2-decision';
  truncated?: boolean;
  /**
   * Completion-token total derived at read time from the response body (last
   * usage occurrence). Present on server responses so metadata-only reads
   * (bodies=none) still render per-turn tok/s chips without the body.
   */
  completionTokens?: number;
  /** Epoch ms of the first streamed body chunk (streamed exchanges only). */
  firstByteTs?: number;
  /**
   * Display-only flattened last user message, capped. Stamped on the
   * prompt-start client-request event at write time so metadata-only reads
   * (bodies=none) can render a prompt. It NEVER decides a turn boundary —
   * `turnIndex` / `isPromptStart` do.
   */
  promptSummary?: string;
}

/** One leg of a request: client ↔ gateway, gateway ↔ provider, decision. */
export type CaptureExchangeLeg = 'client' | 'upstream' | 'decision';

/**
 * ONE HTTP exchange = one request event + its response event, paired by
 * `exchangeId`. A request owns 2-N of these (client, upstream, every failover
 * attempt, the Layer-2 decision pair). `attempt` is 1-based within
 * `(requestId, leg)`; no hop is ever overwritten.
 */
export interface CaptureExchange {
  leg: CaptureExchangeLeg;
  attempt: number;
  exchangeId: string;
  purpose?: 'l2-decision';
  request?: CaptureEvent;
  response?: CaptureEvent;
  /** response.ts - request.ts (whole exchange duration). */
  latencyMs?: number;
  /** firstByteTs - request.ts (streamed replies only). */
  ttftMs?: number;
  /** response.ts - firstByteTs (decode window). */
  genMs?: number;
}

/** One REQUEST: every HTTP exchange sharing one `requestId`. ADR-0024. */
export interface CaptureRequest {
  requestId: string;
  clientRequestId?: string;
  sessionId: string;
  model: string;
  /** Immutable, session-scoped write-time turn ordinal. `null` = no turn. */
  turnIndex: number | null;
  isPromptStart: boolean;
  turnDecision: 'new_prompt' | 'continuation' | 'ambiguous_compaction' | 'no_prompt';
  /** Display-only prompt text, present on the prompt-start request. */
  promptSummary?: string;
  /** 1-based REQUEST ordinal inside the read window (the pager's unit). */
  requestNumber?: number;
  /** Every exchange of this request, in wire order. Never last-write-wins. */
  exchanges: CaptureExchange[];
  error?: string;
}

/** The last exchange of a leg — the one that served the client. */
export function primaryExchange(
  request: CaptureRequest,
  leg: CaptureExchangeLeg
): CaptureExchange | undefined {
  let found: CaptureExchange | undefined;
  for (const ex of request.exchanges ?? []) {
    if (ex.leg === leg && (!found || ex.attempt >= found.attempt)) found = ex;
  }
  return found;
}

export function exchangeEvent(
  request: CaptureRequest,
  leg: CaptureExchangeLeg,
  phase: 'request' | 'response'
): CaptureEvent | undefined {
  return primaryExchange(request, leg)?.[phase];
}

/**
 * UI PROJECTION ONLY. The console's chips, transcript and timeline need the
 * SERVING leg of each exchange; `exchanges[]` above remains the complete,
 * authoritative list and the drawer renders its tabs from it. This projection
 * never decides a turn boundary and never invents a failover hop.
 */
export interface CaptureRequestView extends CaptureRequest {
  clientRequest?: CaptureEvent;
  clientResponse?: CaptureEvent;
  upstreamRequest?: CaptureEvent;
  upstreamResponse?: CaptureEvent;
  decisionRequest?: CaptureEvent;
  decisionResponse?: CaptureEvent;
  gatewayLatencyMs?: number;
  gatewayTtftMs?: number;
  gatewayGenMs?: number;
  upstreamLatencyMs?: number;
  upstreamTtftMs?: number;
  upstreamGenMs?: number;
  decisionLatencyMs?: number;
  decisionTtftMs?: number;
  decisionGenMs?: number;
}

/** One pure projection from the canonical wire object. */
export function toCaptureRequestView(raw: CaptureRequest): CaptureRequestView {
  const view: CaptureRequestView = {
    ...raw,
    exchanges: Array.isArray(raw.exchanges) ? raw.exchanges : [],
    clientRequest: exchangeEvent(raw, 'client', 'request'),
    clientResponse: exchangeEvent(raw, 'client', 'response'),
    upstreamRequest: exchangeEvent(raw, 'upstream', 'request'),
    upstreamResponse: exchangeEvent(raw, 'upstream', 'response'),
    decisionRequest: exchangeEvent(raw, 'decision', 'request'),
    decisionResponse: exchangeEvent(raw, 'decision', 'response'),
  };
  const client = primaryExchange(raw, 'client');
  const upstream = primaryExchange(raw, 'upstream');
  const decision = primaryExchange(raw, 'decision');
  if (client) {
    view.gatewayLatencyMs = client.latencyMs;
    view.gatewayTtftMs = client.ttftMs;
    view.gatewayGenMs = client.genMs;
  }
  if (upstream) {
    view.upstreamLatencyMs = upstream.latencyMs;
    view.upstreamTtftMs = upstream.ttftMs;
    view.upstreamGenMs = upstream.genMs;
  }
  if (decision) {
    view.decisionLatencyMs = decision.latencyMs;
    view.decisionTtftMs = decision.ttftMs;
    view.decisionGenMs = decision.genMs;
  }
  return view;
}

/** One TURN over the WHOLE archive, indexed by its write-time `turnIndex`. */
export interface CaptureTurnIndexEntry {
  /** Immutable, session-scoped write-time turn ordinal. */
  turnIndex: number;
  /** New user message that opened the turn. */
  prompt?: string;
  /** Request send time (epoch ms) of the turn's first request. */
  startTs?: number;
  /** Requests in this turn (prompt request + tool-loop hops). */
  requests: number;
  firstRequest: number;
  lastRequest: number;
}

/** Exact whole-archive totals + the write-time turn index. */
export interface CaptureArchiveSummary {
  requests: number;
  fragments: number;
  turns: CaptureTurnIndexEntry[];
}

// Mirrors backend SessionRow (backend/src/session/session-row.ts) — the console
// session-row CONTRACT, not the internal ConversationSession: a row is an
// execution view, so `pinnedModel`/`pinnedProvider` (routing anchors) and
// session `origin` are absent by design.
export interface SessionRecord {
  id: string;
  /** Gateway-internal loopback row (reserved `ocr-internal:` session id —
   *  console translation/probe calls). Always derived by the backend from the
   *  id, true on live and trace-reconstructed rows alike. Hidden from the
   *  sessions list by default (hideInternal). */
  internal: boolean;
  maxTier: 'lite' | 'plus' | 'pro' | 'ultra';
  /**
   * How the client addressed this session's turns, derived from its traces:
   * 'auto' (ratchet owns the tier), 'explicit' (client named a model — no tier
   * lock to show), 'combo' (the composition IS the decision), 'mixed'. Always
   * present: both row builders derive it, so there is no fallback path.
   */
  entryMode: 'auto' | 'explicit' | 'combo' | 'mixed';
  /**
   * Which side minted `id`. 'client' = the id was adopted verbatim from the
   * client (explicit session header, embedded metadata.user_id, request.user or
   * a vendor x-<app>-session-id header); 'gateway' = the gateway minted it
   * (cold start / content anchor / alias). Null when no trace records a lookup
   * type, so the console prints the id alone instead of guessing.
   */
  idSource: 'gateway' | 'client' | null;
  /**
   * Current model = the registered id of the model that actually served this
   * session's last turn, exactly as registered: `provider/model` for
   * catalog/tier-derived models, a bare id for hand-configured ones. Pure
   * execution semantics: the routing pin is gateway-internal state and never
   * surfaces in console rows, so live and trace-reconstructed rows report the
   * same field. Null only when the row has no trace at all.
   */
  currentModel: string | null;
  /** The provider that served that turn — authoritative for both id shapes
   *  (a bare id carries no prefix to split); null exactly when currentModel is. */
  currentProvider: string | null;
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  /** Tier history in call order. Part of the admin payload; the console table
   *  does not render it (no per-tier trail column yet). */
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
  /**
   * Operator label of the bound credential, resolved server-side from the
   * live registry chain. Absent = unnamed or the credential left the chain —
   * render `boundKeyHashPrefix` instead.
   */
  boundCredentialLabel?: string;
  /** Requests whose model differs from the previous request (chronological). */
  switchCount: number;
  /** Cumulative input tokens across the session's traces. */
  inputTokens: number;
  /** Cumulative output tokens across the session's traces. */
  outputTokens: number;
  /** Cumulative cache-read input tokens across the session's traces. */
  cachedTokens: number;
  /** Cumulative recorded actual cost (USD) across the session's traces. */
  costUsd: number;
  /** Summed end-to-end latency (ms) across the session's traces. Part of the
   *  admin payload; the console renders per-turn latency instead. */
  totalLatencyMs: number;
  /** Output tokens summed over STREAMED traces only — the output-speed numerator. */
  genOutputTokens: number;
  /** Summed decode window (ms) over the same streamed traces — output-speed
   *  denominator, paired with genOutputTokens. */
  genMsSum: number;
  /** Streamed turns that reported a ttftMs — the percentile sample size. */
  ttftSamples: number;
  /**
   * Time to first token over streamed turns, as PERCENTILES (never a mean:
   * one cold start would dominate a short session). P50 = the typical wait,
   * P95 = the tail. Undefined when the session never streamed.
   */
  ttftP50Ms?: number;
  ttftP95Ms?: number;
  /**
   * Share (0..1) of the summed decode windows the client spent in felt pauses
   * — gaps ≥1 s between chunks carrying output (text, tool-call or reasoning
   * deltas), summed per streamed turn. A share, not a maximum: repeated
   * stutters and one long freeze land on the same scale, and answer length
   * does not skew it. Undefined when no turn produced a measurable gap.
   */
  stallRatio?: number;
  /** First user prompt of the session (backend-capped summary). */
  firstUserMessage?: string;
  /**
   * Latest turn's thinking-effort snapshot (ADR-0012 provenance included).
   * Display-only: effort floats per turn and is never a session-level lock,
   * so the UI words it as a "last turn" sample. Absent when the session has
   * no traces or the last trace predates the fields.
   */
  lastRequestedEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  lastActualEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  lastEffortSource?: 'client' | 'l2-decision' | 'entry' | 'directive' | 'default' | 'escalation';
  lastReasoningDegraded?: boolean;
  /** Distinct client API-key identities (applications) seen on this
   *  session's traces, write order — first element is the display anchor. */
  apiKeys?: CaptureKeyIdentity[];
  /** Distinct client User-Agent strings seen on this session's traces,
   *  write order (display-only fingerprint; forgeable, never identity). */
  clients?: string[];
  /**
   * Client-minted conversation ids seen on this session's turns, write order
   * (first = display anchor). The `id` field above remains the GATEWAY session
   * id; this is the other side of the mapping (ADR-0002 §1), rendered beside it
   * so both namespaces can be correlated. Absent when the client sent none.
   */
  clientRefs?: { kind: string; id: string }[];
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
  /** Output tokens over STREAMED turns only — decode-TPS numerator. */
  genOutputTokens: number;
  /** Summed decode window (ms) over the same turns — decode-TPS denominator. */
  genMsSum: number;
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
    /** Same streamed-turns-only pairing as KeyUsageRow, window-wide. */
    genOutputTokens: number;
    genMsSum: number;
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
  servedCredentialPrefix?: string;
  httpStatus?: number;
  error?: string;
}

/** Result of the tier end-to-end test (POST /api/admin/tiers/:tier/test).
 * Same limbs as ComboTestResult but keyed by `tier`. ok:false is a real test
 * outcome (chain exhausted, every member rejected); an unknown tier name is a
 * precondition that throws OcApiError with reasonCode instead. */
export interface TierTestResult {
  status: string;
  ok: boolean;
  tier: string;
  modelUsed?: string;
  latencyMs?: number;
  failoverOccurred?: boolean;
  failoverPath?: string[];
  servedCredentialPrefix?: string;
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

/* ─── Route-entry experience table (ADR-0011, admin API client) ─────────── */

export type RouteEntrySource = 'l2_confident' | 'human';

export interface RouteEntryRow {
  promptHash: string;
  /** First 200 chars of the prompt (absent when snippetEnabled=off). */
  snippet?: string;
  tier: TierName;
  effort?: string;
  source: RouteEntrySource;
  confidence: number;
  hitCount: number;
  sessionCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RouteEntriesGateState {
  enabled?: boolean;
  snippetEnabled?: boolean;
  maxEntries?: number;
}

export interface RouteEntriesListResponse {
  status: 'ok';
  rows: RouteEntryRow[];
  total: number;
  offset: number;
  limit: number;
  gate: RouteEntriesGateState;
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

// ---- mihomo outbound core (backend: proxy/mihomo-sidecar.ts, ADR-0022) ----

export interface MihomoSubscription {
  id: string;
  name: string;
  url: string;
  interval?: number;
  enabled?: boolean;
}
/** Protocols a hand-authored node can speak (backend whitelist, ADR-0022). */
export type MihomoManualNodeType = 'ss' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'http' | 'socks5';

/** One node typed in the console: the manual counterpart of a subscription. */
export interface MihomoManualNode {
  id: string;
  name: string;
  /** Typed rows use the protocol whitelist; a pasted YAML row keeps its own. */
  type: string;
  server: string;
  port: number;
  cipher?: string;
  password?: string;
  uuid?: string;
  alterId?: number;
  vmessCipher?: string;
  network?: 'tcp' | 'ws' | 'grpc' | 'h2';
  tls?: boolean;
  sni?: string;
  flow?: string;
  wsPath?: string;
  wsHost?: string;
  grpcServiceName?: string;
  h2Host?: string;
  h2Path?: string;
  realityPublicKey?: string;
  realityShortId?: string;
  alpn?: string[];
  clientFingerprint?: string;
  udp?: boolean;
  tfo?: boolean;
  ipVersion?: string;
  plugin?: string;
  pluginMode?: string;
  pluginHost?: string;
  pluginPath?: string;
  pluginTls?: boolean;
  obfs?: string;
  obfsPassword?: string;
  up?: string;
  down?: string;
  ports?: string;
  skipCertVerify?: boolean;
  username?: string;
  /** Canonical Clash proxy mapping for a node authored by pasting YAML. */
  yaml?: string;
  /** Form-owned fields projected from `yaml` by GET /mihomo/nodes. */
  fields?: Partial<Omit<MihomoManualNode, 'id' | 'fields'>>;
  /** Mapping keys the form does not model (YAML-only surface). */
  unmodeled?: string[];
}

/** Protocol field table + enum whitelists, served by the backend. */
export interface MihomoNodeCatalog {
  protocols: string[];
  fields: Record<string, string[]>;
  enums: {
    ssCiphers: string[];
    vmessCiphers: string[];
    networks: string[];
    fingerprints: string[];
    ssPlugins: string[];
    obfsModes: string[];
    ipVersions: string[];
    obfsTypes: string[];
  };
}

export interface MihomoStatus {
  status: string;
  installed: boolean;
  binaryPath: string | null;
  running: boolean;
  managed: boolean;
  adopted: boolean;
  pid: number | null;
  mode: 'manual' | 'mihomo';
  enabled: boolean;
  mixedPort: number;
  controllerPort: number;
  secretConfigured: boolean;
  version: string | null;
  error: string | null;
  code: string | null;
  /** mihomo's own outbound mode, as saved for the next start (default 'rule'). */
  routingMode: MihomoRoutingMode;
  /** What the running core reports right now; null when it is not answering. */
  liveRoutingMode: MihomoRoutingMode | null;
}

/** Rule types that need no external data (no GEOIP/GEOSITE/RULE-SET) — the
 *  backend whitelist, mirrored here so the editor can only offer what renders. */
export type MihomoRuleType =
  | 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD'
  | 'IP-CIDR' | 'IP-CIDR6' | 'DST-PORT' | 'SRC-PORT'
  | 'PROCESS-NAME' | 'PROCESS-PATH';

export type MihomoRuleTarget = 'PROXY' | 'DIRECT' | 'REJECT';

/** One operator-authored rule, rendered ahead of the final `MATCH` rule. */
export interface MihomoCustomRule {
  type: MihomoRuleType;
  payload: string;
  target: MihomoRuleTarget;
  /** Provenance label only ("manual", a subscription name, "paste") — never written to the core. */
  source?: string;
}

export interface MihomoRuleImportInput {
  /** 'subscription' reads the URL from config, 'text' parses what was pasted. */
  source: 'subscription' | 'text';
  subscriptionId?: string;
  text?: string;
  /** Off drops rules whose target is neither DIRECT/REJECT nor a known group. */
  mapUnknownTarget?: boolean;
}

export interface MihomoRuleImportResult {
  status: 'ok';
  /** Where the parsed document came from: the core provider cache, the network, or the paste box. */
  source?: 'cache' | 'network' | 'text';
  rules: MihomoCustomRule[];
  /** Why rows were dropped, so the console can report it instead of guessing. */
  skipped: { reason: string; count: number }[];
  total: number;
  mappedToProxy: number;
}

export interface MihomoCustomRulesResult {
  status: 'ok' | 'error';
  rules?: MihomoCustomRule[];
  message?: string;
}

/** mihomo's outbound mode — NOT the gateway's `proxy.mode` (manual vs. core). */
export type MihomoRoutingMode = 'rule' | 'global' | 'direct';

export interface MihomoRoutingModeResult {
  status: 'ok' | 'error';
  routingMode?: MihomoRoutingMode;
  /** True only when the running core accepted the PATCH immediately. */
  live?: boolean;
  warning?: string;
  message?: string;
}

export interface MihomoOpResult {
  status: string;
  ok: boolean;
  action?: string;
  reused?: boolean;
  pid: number | null;
  version: string | null;
  error: string | null;
  code: string | null;
}

export interface MihomoProviderInfo {
  name: string;
  vehicleType?: string;
  updatedAt?: string;
  nodeCount?: number;
}

export interface InstallMihomoResult {
  status: string;
  ok: boolean;
  path?: string;
  version?: string;
  error?: string;
  code?: string;
}

export interface MihomoProxyGroup {
  name: string;
  type: string;
  now: string;
  all: string[];
}

/** One row of the core's effective rule table — what is actually loaded. */
export interface MihomoRuleRow {
  type: string;
  payload: string;
  proxy: string;
}

/** How the running group picks a node: only `select` lets the console choose. */
export type MihomoGroupType = 'select' | 'url-test' | 'fallback';

export interface MihomoProxyNode {
  name: string;
  type: string;
  delay: number | null;
  selected: boolean;
  /** Manual-node id when this row is hand-authored; null for subscription/built-in rows. */
  manualId: string | null;
  /** One origin per row: filter key and label source. */
  source: MihomoNodeSource;
}

/** Where one node row came from: the subscription that contributed it, the
 *  operator's manual list, or mihomo itself (DIRECT/REJECT/PASS). */
export interface MihomoNodeSource {
  kind: 'subscription' | 'manual' | 'builtin';
  /** Subscription id for `subscription`; the manual node id for `manual`. */
  id: string | null;
}

/** Harness domain wire types (ADR-0015) — names mirror the backend contract 1:1. */
export interface HarnessCopyView {
  scope: 'global' | 'project';
  host: string;
  rootId: string;
  /**
   * Package-manager-owned copy (today: the `pi` subprocess install, which materializes into the
   * runtime's own store). `path` is then an OPAQUE IDENTITY TOKEN, NOT a filesystem path — display
   * it as an id, never as a location to open.
   */
  external?: boolean;
  path: string;
  /** Per-profile runtime store (DSH): the profile this copy belongs to. */
  profile?: string;
  /** Set on project-scope copies — the only project attribution for an external token copy. */
  projectRoot?: string;
  state: 'clean' | 'dirty' | 'missing' | 'foreign' | 'untracked';
  placement: 'materialized' | 'verified' | 'unverified';
  contentHash?: string;
  /**
   * Skill copies only: every host that reads this directory, owner first. `host` is ownership (one
   * owner per directory — install/claims/removal); this is readership (the shared `.agents/skills`
   * tree is read by up to fifteen runtimes), which is what the skills page's harness rail selects by.
   */
  readers?: string[];
}

/** `artifact.harness` is set for `kind: 'plugin'` — the runtime whose plugin API the code targets
 *  is part of the artifact's identity (one package in two runtimes is two artifacts). */
export interface HarnessArtifactView {
  id: string;
  canonicalKey: string;
  kind: 'skill' | 'mcp' | 'plugin';
  harness?: string;
  name: string;
  description: string | null;
  /** Source that produced this artifact; null for a purely local directory. */
  sourceId: string | null;
  /** Surfaces it was listed on at install time, writer source first (`['npm','pi-dev']` when the
   *  package was browsed in the Pi catalog but installed through npm). */
  listedOn: string[];
  trust: 'official' | 'aggregator' | 'community' | 'manual';
  audit: { status: 'pass' | 'warn' | 'fail'; summary: string } | null;
  copies: HarnessCopyView[];
  rollup: 'clean' | 'partial' | 'dirty' | 'missing' | 'shadowed';
}

export interface HarnessDiscoveredArtifact {
  /** Which kind the row belongs to — one discovery channel serves every kind. */
  kind: 'skill' | 'mcp' | 'plugin';
  /** Set iff `kind === 'plugin'`: the runtime whose own store the row was read from. */
  harness?: string;
  name: string;
  description: string | null;
  copies: HarnessCopyView[];
  hosts: string[];
  /** Provenance of an plugin row: the runtime's own record it came from. */
  origin?: 'runtime-store' | 'config-array' | 'local-file';
  /** File/dir the row was read from — a tooltip, never a location we own. */
  observedFrom?: string;
  /** Version the runtime's store records for it, when a lock file answers. */
  version?: string;
  canonicalKey?: string;
  /** DSH only: `false` = installed dependency not selected in `dsh.profile.bundles`. */
  enabled?: boolean;
  /**
   * The inverse of the runtime's own install record — computed by the backend from the shape the
   * scan read (`trash-path` for a real file, `drop-entry` for one string in `plugin[]`/`packages[]`,
   * `drop-server` for one member of an `mcp` object). Absent only when the shape is unknowable, and
   * then the row cannot be removed from the console.
   */
  removal?:
  | { op: 'trash-path'; path: string }
  | { op: 'drop-entry'; file: string; container: string; entry: string }
  | { op: 'drop-server'; file: string; container: string; entry: string }
  | { op: 'cli-remove'; host: string; entry: string }
  | { op: 'plugin-remove'; host: string; entry: string; profile?: string };
}

export interface HarnessInventoryResponse {
  status: string;
  envName: string;
  envRoot: string;
  hostsScanned: number;
  artifacts: HarnessArtifactView[];
  discovered: HarnessDiscoveredArtifact[];
  discoveredCopies: number;
  paths: { manifest: string; claims: string };
}

/** Live server state as the runtime reports it (backend `McpRuntimeStatus`). Distinct from
 *  `HarnessCopyView.state`: that answers "is our config member intact", this answers "did the
 *  runtime connect". A missing host/name is UNKNOWN, never a failure claim. */
export type McpRuntimeStatus = 'connected' | 'pending' | 'disabled' | 'needs_auth' | 'failed';

export interface McpRuntimeServer {
  name: string;
  status: McpRuntimeStatus;
  /** The runtime's own failure text (`failed` / `needs_auth`). */
  error?: string;
}

export interface McpRuntimeHostView {
  host: string;
  reachable: boolean;
  /** Why the runtime could not answer; present only when `reachable` is false. */
  message?: string;
  servers: McpRuntimeServer[];
}

export interface McpRuntimeReport {
  status: string;
  probedAt: number;
  hosts: McpRuntimeHostView[];
}

/** One row of a probed git-marketplace snapshot — a SKILL.md directory the source can install. */
export interface HarnessMarketplaceRow {
  dir: string;
  name: string;
  title: string;
  description: string | null;
}




/** One row of the per-harness plugin catalog (ADR-0015 §D10). Plugin kind ONLY. */
export interface HarnessCatalogRow {
  key: string;
  name: string;
  summary: string | null;
  stars: number | null;
  updatedAt: number | null;
  sourceId: string;
  hosts: string[];
  repo: string | null;
  /** Marketplace name the source's manifest declares (`postman`); git-backed installs need it. */
  marketplace: string | null;
}

/** One federated source's answer, in the source's own native order (never co-ordered). */
export interface HarnessCatalogSection {
  sourceId: string;
  label: string;
  rows: HarnessCatalogRow[];
  total?: number;
  totalExact?: boolean;
  note?: string;
}

export interface HarnessCatalogSource {
  id: string;
  catalog?: string;
  label: string;
  tier: 'index' | 'federated';
  sorts: string[];
  counts: boolean;
}

/** One operator plugin entry (the shared store's config row, mirrored by GET sources). */
export interface HarnessMarketplaceEntry {
  slug: string;
  catalog?: string;
  /** GitHub `owner/repo`, an npm package / `@scope/*`, or one PyPI project name. */
  repo: string;
  type?: 'github' | 'npm' | 'pypi';
  enabled: boolean;
  addedAt?: number;
  rescan: { enabled: boolean; intervalMs: number };
  /** The harness whose add form registered this entry; support is detected, not pinned. */
  harness?: string | null;
  /** Repo-relative layer the probe scanned; null = every served harness's form was detected. */
  extensionDir?: string | null;
  /** Harnesses the repository's own forms declare (detected at probe time). */
  hosts?: string[];
  /** Marketplace name the manifest declares, when the snapshot read one. */
  marketplace?: string | null;
  /** Kinds the source's snapshot actually carries — the dialog filters by the open tab's kind. */
  kinds: ('skill' | 'plugin' | 'mcp')[];
}

/** A summarized probe from the snapshot history (§D9) — never a raw dump. */
export interface HarnessSourceSnapshot {
  probedAt: number;
  sha: string;
  stars: number | null;
  rows: number;
  added: string[] | null;
  removed: string[] | null;
}

export interface HarnessSourceView {
  id: string;
  catalog?: string;
  label: string;
  kinds: ('skill' | 'mcp' | 'plugin')[];
  trust: string;
  auth: string;
  enabled: boolean;
  /** True when the source has a browse adapter (the market tab can show results for it). */
  browsable?: boolean;
  /**
   * Harnesses the source serves, when its artifacts are runtime-bound. An plugin source lists its
   * one runtime (its packages are written against that plugin API); a source without `hosts` serves
   * every capable harness and lets the operator name one at install time.
   */
  hosts?: string[];
  /**
   * Orderings the source OFFICIALLY offers (best default first). Absent = the catalog's own order is
   * the only one; the console then renders a single disabled entry instead of inventing alternatives.
   */
  sorts?: string[];
  unavailableReason?: string;
}

export interface HarnessRootView {
  root: string;
  origin: 'default' | 'env-override' | 'profile';
  precedence: number;
}

/** One marketplace entry, normalized by the backend adapter (never a vendor payload). */
export interface HarnessMarketItem {
  id: string;
  sourceId: string;
  catalog?: string;
  channel?: string;
  categories?: string[];
  /**
   * Portable install handle — the key the install endpoint takes (`github:<owner/repo>` /
   * `npm:<name>` / `clawhub:<owner>/<slug>`). `id` carries the same value; `key` names its role.
   */
  key: string;
  /**
   * Which writer serves this row: a skill copy tree, an plugin package, or an MCP server merged
   * into a host's own config. It is the WRITER's kind, not the page's (an npm package reached from
   * the skills page installs as an plugin).
   */
  installKind: 'skill' | 'mcp' | 'plugin';
  /**
   * MCP rows only: the server key the install merges under, derived backend-side from the package
   * identity with the host grammar's intersection (`@bytebase/dbhub` → `bytebase-dbhub`). `name`
   * stays the package identity the row is browsed by; the sheet's read-only name field shows THIS,
   * because it is what the host config will carry.
   */
  serverName?: string;
  name: string;
  /** `owner/repo` for GitHub rows; absent for sources whose identity is a package name. */
  repo?: string;
  description: string | null;
  /** Public page for the row; `null` for a row whose source publishes none (operator `mp-` skills). */
  url: string | null;
  /** GitHub stars, or `null` when the source publishes no popularity signal (npm, the Pi catalog,
   *  the community registries). `null` is not `0` — the console renders "unknown" for it, and can
   *  resolve a real count on demand for rows that name a repository. */
  stars: number | null;
  /**
   * The source's OWN popularity counters, when that source has a system of its own that is not
   * GitHub stars (today only ClawHub). A separate field on purpose: the star column means "GitHub
   * stars", and the console labels this one with its source instead of relabelling a number.
   */
  registryStats?: {
    stars: number | null;
    downloads: number | null;
    installs: number | null;
  };
  updatedAt: string;
  topics: string[];
  /** The marketplace name the source's manifest declares, for a git-backed plugin row. */
  marketplace?: string | null;
}

/**
 * The long-form half of one market row (`GET /api/admin/harness/detail`).
 *
 * Every field beyond the row is OPTIONAL: it is a patch, not a record. `readFrom` says which
 * upstream actually answered — `none` means the dialog renders the row's own fields only.
 */
export interface HarnessMarketDetail {
  /** Markdown body, capped server-side. `null` when the row publishes none. */
  readme: string | null;
  repo?: string;
  description?: string;
  homepage?: string;
  license?: string;
  latestVersion?: string;
  /** ISO publish date (npm latest) / last push (GitHub). */
  publishedAt?: string;
  updatedAt?: string;
  /** Language the README is actually written in, when the backend could tell: a selected localized
   *  edition, or script detection (zh/ja/ko). Equal to the UI language means NO translation is needed. */
  readmeLang?: Lang;
  /** Repository-relative path of the served README (a localized edition is a real file): relative
   *  links and images resolve against its directory. Absent means the repository root. */
  readmePath?: string;
  language?: string;
  stars?: number;
  topics?: string[];
  /** The source's own counters (ClawHub today) — never folded into `stars`. */
  registryStats?: {
    stars: number | null;
    downloads: number | null;
    installs: number | null;
  };
  readFrom: 'npm' | 'github' | 'clawhub' | 'none';
  /** Why the long-form read produced nothing — the console translates it via `harness.browseError.*`. */
  reason?: string;
  reasonParams?: Record<string, string>;
  /** English fallback and diagnostic; never the runtime's own error text. */
  message?: string;
}

export interface HarnessHostView {
  id: string;
  label: string;
  /** Popularity order shared with the Clients page (1 = most popular). The rail sorts by it;
   *  `universal` is unranked here and pinned first by id. */
  rank: number;
  /** Present on this machine (executable on PATH, config dir, or an existing skills root). The
   *  console rail hides undetected hosts — but never one whose rows are already landed. */
  detected: boolean;
  hasSkills: boolean;
  /** Plugin-capable host: a verified package-manager landing exists for it. */
  hasExt: boolean;
  /** MCP-capable host: a verified server-config landing exists for it (the client's own config file
   *  or container). `hasSkills` says nothing about this — a host can read the shared skills
   *  directory and still have nowhere to write an MCP server. */
  hasMcp: boolean;
  /** Per-kind landing scopes this host's adapter declares (ADR-0015 §D2). A scope absent from a
   *  kind's list must not be offered as an install target for that kind — the writers refuse it. */
  kindScopes: Record<'skill' | 'mcp' | 'plugin', ('global' | 'project')[]>;
  /** Resolved roots per accepted scope; a scope absent from `kindScopes` has no key here. */
  roots: { global: HarnessRootView[] };
  /** Per-profile plugin stores (DSH): selectable install targets. Absent = one implicit landing. */
  profiles?: { name: string; exists: boolean }[];
  /** Host that owns this host's directory per scope — differs from `id` when hosts share a path. */
  owner: { global: string | null };
}

export interface HarnessPlanAction {
  /**
   * The op follows the artifact's LANDING SHAPE, never its provenance:
   *  - `move-to-trash` — a file tree / loose file (reversible through the trash);
   *  - `drop-entry` — one string inside a JSON array (`plugin[]`, pi `packages[]`);
   *  - `drop-server` — one member of a JSON object (a server inside `mcp`);
   *  - `cli-remove` — a CLI-materialized landing: the runtime's own remove verb runs;
   *  - `prune-only` — the copy or member is already gone, only the record is left;
   *  - `prune-record` — package-manager-owned with no declaration file to edit.
   */
  op: 'move-to-trash' | 'prune-only' | 'prune-record' | 'drop-entry' | 'drop-server' | 'cli-remove';
  /** The manifest copy key: a resolved path, or the identity token for an `external` copy. */
  path: string;
  /** The config file a `drop-*` op edits. */
  file?: string;
  /** Container inside `file` (`plugin` / `packages` / `mcp`). */
  container?: string;
  /** The exact member removed: an array element (`drop-entry`) or an object key (`drop-server`). */
  entry?: string;
  host: string;
  artifactId: string | null;
  beforeHash?: string;
  dirty: boolean;
  exists: boolean;
}

/**
 * Gate plan for an install that writes third-party state (plugin gate 3 / MCP gate 2). The page
 * shows `echo` / `file`+`container` verbatim and re-sends the request with `confirm: true`.
 */
export interface HarnessInstallRun {
  command: string;
  args: string[];
  /** The EXACT argv line apply will run — gate 3 shows it verbatim. */
  echo: string;
}

/** A manual MCP launch — the two shapes the writer accepts (ADR-0015 §D6/§D8).
 *
 *  Key NAMES are the default: env / header values are supplied by the runtime. A `envValues` /
 *  `headerValues` entry is the value an operator typed into the registry-driven form — it is written
 *  verbatim into the runtime's own config and never read back. */
export type HarnessMcpLaunch =
  | { command: string; args?: string[]; envKeys?: string[]; envValues?: Record<string, string> }
  | { url: string; transport: 'http' | 'sse'; headerKeys?: string[]; headerValues?: Record<string, string> };

export interface HarnessInstallTarget {
  host: string;
  /** `subprocess` (a command chain), `config` (a merge), `manual` (interactive-only), or
   *  `webapi` (the runtime's own loopback REST install API — a transient vendor server). */
  op: 'subprocess' | 'config' | 'manual' | 'webapi';
  file?: string;
  container?: string;
  /** Structured command for a single-run subprocess target — apply runs THIS. */
  command?: string;
  args?: string[];
  /** The EXACT command apply will run — gate 3 shows it verbatim, never paraphrased. */
  echo?: string;
  /** A native marketplace chain: registration first, install last, run in order. */
  runs?: HarnessInstallRun[];
  /** `webapi` only: the plugin source string POSTed to the runtime's install route. */
  source?: string;
  /** MCP plan only: server keys the merge would add / overwrite in the target container. */
  addedKeys?: string[];
  changedKeys?: string[];
  refused?: string;
  added: boolean;
}

/** One EXISTING MCP server read from a host config (the edit sheet's pre-image).
 *  Stored env/header VALUES never travel — only their key names, plus which keys are already set. */
export interface HarnessMcpEntry {
  host: string;
  name: string;
  file: string;
  container: string;
  launch: HarnessMcpLaunch;
  /** Keys whose stored value is not a bare `{env:KEY}` reference (a literal or `{file:...}`). */
  setKeys: string[];
}

/**
 * The value-format vocabulary an MCP parameter can carry (ADR-0015 §D11). Two provenances, one
 * superset: the registry `server.json` reader emits the four official `Input`/`Argument` formats
 * (`McpRegistryFormat`); the CLI probe adds `dsn` — a connection-string flag it classifies by name
 * (`McpCliFormat`). `McpParamRow.format` (the console render row) is the superset, since a row may
 * come from either source. Declared once here so the four old inline copies cannot drift.
 */
export type McpRegistryFormat = 'string' | 'number' | 'boolean' | 'filepath';
export type McpCliFormat = McpRegistryFormat | 'dsn';

/** One configurable input declared by a registry `server.json` (`Input` in the registry schema). */
export interface HarnessMcpRegistryInput {
  name: string;
  description?: string;
  format: McpRegistryFormat;
  secret: boolean;
  required: boolean;
  default?: string;
  placeholder?: string;
  choices?: string[];
  /** Pinned by the registry — not operator-configurable. */
  value?: string;
}

/** One CLI argument declared by a registry `server.json` (`positional` or `named`). */
export interface HarnessMcpRegistryArgument {
  type: 'positional' | 'named';
  name: string;
  value?: string;
  valueHint?: string;
  default?: string;
  description?: string;
  format: McpRegistryFormat;
  secret: boolean;
  required: boolean;
  choices?: string[];
}

export interface HarnessMcpRegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;
  env: HarnessMcpRegistryInput[];
  args: HarnessMcpRegistryArgument[];
  headers: HarnessMcpRegistryInput[];
}

export interface HarnessMcpRegistryCandidate {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: string;
  packages: HarnessMcpRegistryPackage[];
}

/** One CLI flag read from a published npm package (its bundled parser, not the registry). */
export interface HarnessMcpCliOption {
  /** Without dashes; the form adds `--` on write. */
  name: string;
  valueHint?: string;
  choices?: string[];
  format?: McpCliFormat;
  secret?: boolean;
  /** Environment variable the package falls back to when the flag is absent. */
  env?: string;
  /** The parser refuses to start without it. */
  required?: boolean;
}

export interface HarnessMcpCliProbe {
  status: string;
  package: string;
  version: string;
  bin?: string;
  options: HarnessMcpCliOption[];
  files: number;
}

export interface HarnessRemovePlan {
  planId: string;
  action: 'remove';
  artifactIds: string[];
  actions: HarnessPlanAction[];
  /**
   * Copies whose `path` is an identity token, not a location. Only their manifest record can be
   * pruned — the package stays in the runtime's own store (its own package manager owns it).
   */
  external: { path: string; host: string }[];
  blocked: { path: string; code: string; message: string }[];
  warnings: { code: string; message: string; path: string }[];
  createdAt: number;
}
/** Mirrors the backend `SourceReason` (ADR-0015 §D11): the console renders its localized copy
 *  from the reason + params, so a new backend reason must be added here in the same pass. */
export type SourceReason =
  | 'registered'
  | 'registered_scoped'
  | 'already_configured'
  | 'slug_taken'
  | 'no_form'
  | 'not_a_repo'
  | 'invalid_layer'
  | 'invalid_source'
  | 'no_skill'
  | 'probe_failed'
  | 'unsupported_here';

/** A refused source registration that still carries the machine-readable cause: the drawer
 *  translates `reason`/`params` and only falls back to the English `message`. */
export class SourceOutcomeError extends Error {
  readonly reason?: SourceReason;
  readonly params?: Record<string, string>;

  constructor(message: string, reason?: SourceReason, params?: Record<string, string>) {
    super(message);
    this.name = 'SourceOutcomeError';
    this.reason = reason;
    this.params = params;
  }
}

/**
 * Read an NDJSON response body, handing each non-empty line to `onLine`.
 *
 * Two console surfaces stream this shape (capture replay and README translation progress): the
 * framing lives here so the decoder, the buffer and the partial-line rule cannot drift apart.
 */
async function readNdjsonLines(res: Response, onLine: (line: string) => void): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
}

/** Mirrors backend `UpdateCheckSnapshot` (backend/src/update/check.ts) plus the
 *  route envelope. Display-only: `checking` means the gateway's background
 *  GitHub call is still in flight. */
export interface UpdateCheckResponse {
  status: 'ok';
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseName?: string;
  publishedAt?: string;
  checkedAt?: string;
  checking: boolean;
  error?: string;
}

export const api = {
  async getStatus(): Promise<GatewayStatusResponse> {
    const res = await fetch('/api/admin/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Release update check — cached in the gateway; the first read starts the
   *  background GitHub call and answers `checking: true`. */
  async getUpdateCheck(): Promise<UpdateCheckResponse> {
    const res = await fetch('/api/admin/update-check');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** THE ONE traffic-timeline read. `scope=live` returns the merged tail
   *  (ring + plugin feeds); `scope=history` runs the backend's federated
   *  paged scan over every persisted source and returns an exact total. */
  async getProxyTimeline(params: {
    scope: 'live' | 'history';
    page?: number;
    limit?: number;
    kind?: string;
    method?: string;
    status?: string;
    host?: string;
  }): Promise<ProxyTimelineResponse> {
    const q = new URLSearchParams({ scope: params.scope });
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    for (const k of ['kind', 'method', 'status', 'host'] as const) {
      if (params[k]) q.set(k, params[k]!);
    }
    const res = await fetch(`/api/admin/proxy-log?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** HISTORY delete by FILTER — deletes every persisted row matching the
   *  same filter vocabulary the history query uses, across ALL sources
   *  (proxy day JSONL + plugin feeds). Returns per-source counts. */
  async deleteProxyHistory(params: {
    kind?: string;
    method?: string;
    status?: string;
    host?: string;
  }): Promise<{ status: string; deleted: { proxy: number; plugins: Record<string, number> } }> {
    const res = await fetch('/api/admin/proxy-log/history/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Captured body by its opaque token — the one body endpoint. */
  async getTrafficBody(token: string): Promise<ArrayBuffer> {
    const res = await fetch(`/api/admin/traffic-body/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  },

  /** Hide exactly these rows from the LIVE view. Never deletes on disk: the
   *  persisted day JSONL and body sidecars stay, so History still lists the
   *  same rows and can delete them there. */
  async clearLiveTraffic(body: {
    proxy: { key: string; ts: number }[];
    plugins: Record<string, { key: string; ts: number }[]>;
  }): Promise<{ hidden: { proxy: number; plugins: Record<string, number> } }> {
    const res = await fetch('/api/admin/traffic-live-clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { hidden: { proxy: number; plugins: Record<string, number> } };
  },
  async clearTrafficLog(): Promise<{ cleared: string[] }> {
    const res = await fetch('/api/admin/traffic-clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { cleared: string[] };
  },


  async getPluginTrafficDecoders(): Promise<PluginTrafficDecodersResponse> {
    const res = await fetch('/api/admin/plugin-traffic');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getPluginTraffic(decoder: string): Promise<PluginTrafficResponse> {
    const res = await fetch(`/api/admin/plugin-traffic/${encodeURIComponent(decoder)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async getSystemProxy(): Promise<SystemProxyStatus> {
    const res = await fetch('/api/admin/system-proxy');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async getProxyCaMeta(): Promise<CaMeta> {
    const res = await fetch('/api/admin/proxy/ca/meta');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The route answers `{ status: 'ok', ...CaMeta }`; `status` is transport
    // bookkeeping (a non-ok answer throws above), not part of the contract.
    const { status: _status, ...meta } = (await res.json()) as CaMeta & { status?: string };
    return meta;
  },
  /**
   * Is the CA trusted by the platform store? Tri-state and cached 60s in the
   * backend; `force` bypasses the cache for an operator re-check right after
   * installing the certificate.
   */
  async getProxyCaTrust(force = false): Promise<CaTrustResponse> {
    const res = await fetch(`/api/admin/proxy/ca/trust${force ? '?force=1' : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { status: _status, ...trust } = (await res.json()) as CaTrustResponse & { status?: string };
    return trust;
  },

  /**
   * Lint + dry-run the forward-proxy rule table (ADR-0018). The backend runs the
   * SAME resolver the proxy legs use, so the preview can never disagree with the
   * live decision. Pass `rules` to test UNSAVED edits.
   */
  async resolveForwardProxyRules(args: {
    host?: string;
    rules?: ForwardProxyRule[];
    intercept?: InterceptPosture;
  }): Promise<RulesResolveResponse> {
    const res = await fetch('/api/admin/forward-proxy/rules/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Tighten the rule table to the allowlist posture (ADR-0018 Revision 4):
   * the catch-all becomes a blind tunnel (same egress) and `intercept` goes to
   * `claims`. Only the operator can trigger it — nothing runs on boot.
   */
  async tightenForwardProxyRules(): Promise<TightenRulesResponse> {
    const res = await fetch('/api/admin/forward-proxy/tighten', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async enableSystemProxy(): Promise<SystemProxyStatus> {
    const res = await fetch('/api/admin/system-proxy/enable', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async disableSystemProxy(): Promise<SystemProxyStatus> {
    const res = await fetch('/api/admin/system-proxy/disable', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getRouteEntries(params: { limit?: number; offset?: number; q?: string; sort?: 'updatedAt' | 'hitCount' | 'sessionCount' } = {}): Promise<RouteEntriesListResponse> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    if (params.q) qs.set('q', params.q);
    if (params.sort) qs.set('sort', params.sort);
    const res = await fetch(`/api/admin/route-entries?${qs.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async updateRouteEntry(hash: string, body: { tier: string; effort?: string | null }): Promise<void> {
    const res = await fetch(`/api/admin/route-entries/${encodeURIComponent(hash)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.message || `HTTP ${res.status}`);
    }
  },

  async deleteRouteEntry(hash: string): Promise<void> {
    const res = await fetch(`/api/admin/route-entries/${encodeURIComponent(hash)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },

  async clearRouteEntries(): Promise<number> {
    const res = await fetch(`/api/admin/route-entries`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.removed ?? 0;
  },

  /** Last REAL decision wire attempt (cache hits never overwrite it). */
  async getDecisionOutcome(): Promise<{
    ts: number;
    modelId: string;
    ok: boolean;
    error?: string;
    latencyMs?: number;
  } | null> {
    const res = await fetch('/api/admin/decider/outcome');
    if (!res.ok) return null;
    const json = await res.json();
    return json?.outcome ?? null;
  },

  /** Comment-dictionary language for config.yaml (re-)annotation: derived
   *  from the UI locale; the backend dictionaries only ship zh-CN and en —
   *  every other UI locale maps to en. */
  commentLang(): 'zh-CN' | 'en' {
    const ui = (typeof localStorage !== 'undefined' && localStorage.getItem('ocr_lang')) || 'zh';
    return ui === 'zh' ? 'zh-CN' : 'en';
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
  /** Dynamic comment-panel data: the zh-CN/en comment dictionaries for
   *  config.yaml fields (config.yaml itself carries no comments on disk). */
  async getConfigComments(lang: 'zh-CN' | 'en'): Promise<{
    status: string;
    lang: string;
    header: string;
    fields: Record<string, string>;
  }> {
    const res = await fetch(`/api/admin/config/comments?lang=${lang}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

  async getMihomoStatus(): Promise<MihomoStatus> {
    const res = await fetch('/api/admin/proxy/mihomo/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getMihomoRules(): Promise<MihomoRuleRow[]> {
    const res = await fetch('/api/admin/proxy/mihomo/rules');
    const body = await res.json().catch(() => null);
    if (!res.ok) throw mihomoError(body, res.status);
    return (body?.rules ?? []) as MihomoRuleRow[];
  },

  async setMihomoRoutingMode(mode: MihomoRoutingMode): Promise<MihomoRoutingModeResult> {
    const res = await fetch('/api/admin/proxy/mihomo/routing-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw mihomoError(body, res.status);
    return body as MihomoRoutingModeResult;
  },

  /** Parses a subscription (or pasted rules) into a DRAFT — nothing is saved. */
  async importMihomoRules(input: MihomoRuleImportInput): Promise<MihomoRuleImportResult> {
    const res = await fetch('/api/admin/proxy/mihomo/rules/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw mihomoError(body, res.status);
    return body as MihomoRuleImportResult;
  },

  /** Writes the whole ordered rule list and lets the core pick it up. */
  async setMihomoCustomRules(rules: MihomoCustomRule[]): Promise<MihomoCustomRulesResult> {
    const res = await fetch('/api/admin/proxy/mihomo/rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw mihomoError(body, res.status);
    return body as MihomoCustomRulesResult;
  },

  async startMihomo(): Promise<MihomoOpResult> {
    const res = await fetch('/api/admin/proxy/mihomo/start', { method: 'POST' });
    return res.json();
  },

  async stopMihomo(): Promise<MihomoOpResult> {
    const res = await fetch('/api/admin/proxy/mihomo/stop', { method: 'POST' });
    return res.json();
  },

  async restartMihomo(): Promise<MihomoOpResult> {
    const res = await fetch('/api/admin/proxy/mihomo/restart', { method: 'POST' });
    return res.json();
  },

  /**
   * Install/update the mihomo core binary. The server answers NDJSON because the
   * download is tens of MB: `progress` events carry (downloaded, total) bytes and
   * exactly one `result` carries the install outcome (total 0 = unknown size).
   */
  async installMihomo(onProgress?: (downloaded: number, total: number) => void): Promise<InstallMihomoResult> {
    const res = await fetch('/api/admin/proxy/mihomo/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const contentType = res.headers.get('content-type') || '';
    if (!res.body || !contentType.includes('ndjson')) return res.json();
    let out: InstallMihomoResult | null = null;
    await readNdjsonLines(res, (line) => {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // A malformed line must not kill the stream — skip it.
      }
      if (evt.type === 'progress' && typeof evt.downloaded === 'number') {
        onProgress?.(evt.downloaded, typeof evt.total === 'number' ? evt.total : 0);
      } else if (evt.type === 'result') {
        out = evt as unknown as InstallMihomoResult;
      }
    });
    if (!out) throw new Error(`install stream ended without a result (HTTP ${res.status})`);
    return out;
  },

  async getMihomoSubscriptions(): Promise<{ status: string; subscriptions: MihomoSubscription[]; providers: MihomoProviderInfo[] }> {
    const res = await fetch('/api/admin/proxy/mihomo/subscriptions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async addMihomoSubscription(body: { name: string; url: string; interval?: number; enabled?: boolean }): Promise<{ status: string; subscription?: MihomoSubscription; message?: string }> {
    const res = await fetch('/api/admin/proxy/mihomo/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  async updateMihomoSubscription(id: string, body: Partial<MihomoSubscription>): Promise<{ status: string; subscription?: MihomoSubscription; message?: string }> {
    const res = await fetch(`/api/admin/proxy/mihomo/subscriptions/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  async deleteMihomoSubscription(id: string): Promise<void> {
    const res = await fetch(`/api/admin/proxy/mihomo/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw mihomoError(json, res.status);
    }
  },

  async refreshMihomoSubscription(id: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(`/api/admin/proxy/mihomo/subscriptions/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  async refreshAllMihomoSubscriptions(): Promise<{ status: string; refreshed: string[]; failed: string[] }> {
    const res = await fetch('/api/admin/proxy/mihomo/subscriptions/refresh', { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && !json?.refreshed) throw mihomoError(json, res.status);
    return json;
  },

  /** Config rows with the form projection of each YAML-authored mapping. */
  async getMihomoNodes(): Promise<{ status: string; nodes: MihomoManualNode[] }> {
    const res = await fetch('/api/admin/proxy/mihomo/nodes');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  /** Protocol/field/enum table driving the node form. */
  async getMihomoNodeCatalog(): Promise<{ status: string } & MihomoNodeCatalog> {
    const res = await fetch('/api/admin/proxy/mihomo/nodes/catalog');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  async addMihomoNode(body: Omit<MihomoManualNode, 'id'> | { yaml: string }): Promise<{ status: string; node?: MihomoManualNode; nodes?: MihomoManualNode[]; message?: string }> {
    const res = await fetch('/api/admin/proxy/mihomo/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  async updateMihomoNode(id: string, body: Partial<MihomoManualNode> | { yaml: string }): Promise<{ status: string; node?: MihomoManualNode; nodes?: MihomoManualNode[]; message?: string }> {
    const res = await fetch(`/api/admin/proxy/mihomo/nodes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  async deleteMihomoNode(id: string): Promise<void> {
    const res = await fetch(`/api/admin/proxy/mihomo/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw mihomoError(json, res.status);
    }
  },

  async testMihomoNode(body: { server: string; port: number } | { yaml: string }): Promise<{ status: string; reachable?: boolean; ms?: number; error?: string; message?: string }> {
    const res = await fetch('/api/admin/proxy/mihomo/nodes/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  /** Connectivity check: fetch the configured URL THROUGH the current proxy
   *  node; unlike
   *  `testMihomoNode` (a direct TCP probe) this proves the tunnel + URL pair.
   *  `group` names the RUNNING group shown in the console (config may differ). */
  async testMihomoUrl(url?: string, group?: string): Promise<{ status: string; reachable?: boolean; ms?: number; node?: string; url?: string; error?: string; message?: string }> {
    const body: Record<string, string> = {};
    if (url) body.url = url;
    if (group) body.group = group;
    const res = await fetch('/api/admin/proxy/mihomo/test-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  async getMihomoProxies(group?: string): Promise<{ status: string; running: boolean; group: string; groupType?: MihomoGroupType; now?: string | null; groups: MihomoProxyGroup[]; nodes: MihomoProxyNode[]; message?: string }> {
    const qs = group ? `?group=${encodeURIComponent(group)}` : '';
    const res = await fetch(`/api/admin/proxy/mihomo/proxies${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async selectMihomoProxy(group: string, name: string): Promise<{ status: string; group: string; name: string }> {
    const res = await fetch('/api/admin/proxy/mihomo/proxies/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, name }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
  },

  async testMihomoDelay(name: string, group = false, url?: string): Promise<{ status: string; delay?: number; delays?: Record<string, number>; message?: string }> {
    const res = await fetch('/api/admin/proxy/mihomo/proxies/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, group, ...(url ? { url } : {}) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mihomoError(json, res.status);
    return json;
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

  /** Live (committed) pool snapshot — the registry's committed member projection after the last applyTierConfigNow. */
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

  /** One-shot tier end-to-end test — a REAL minimal completion pinned to the
   * tier via the auto-<tier> virtual entry, the same force_tier path a
   * client's request takes (burns quota, lands in logs). Unknown tier names
   * throw OcApiError with the reasonCode; a failed test answers 200 with
   * ok:false limbs. */
  async testTier(tier: string): Promise<TierTestResult> {
    const res = await fetch(`/api/admin/tiers/${encodeURIComponent(tier)}/test`, { method: 'POST' });
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

  async getRawYaml(): Promise<{ status: string; yaml: string; path?: string }> {
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
      /** Follow mode: the virtual tier subset (auto/lite/plus/pro/ultra) the selected key's policy admits. */
      virtualModels?: string[];
      /** Manual agent bindings (opencode): agent name → modelRef. */
      agentModels?: Record<string, string>;
      /** Profile-linked rows (opencode): id + agent→slot-key tags, resolved server-side; id '' un-links (sweep). */
      profile?: { id: string; bindings: Record<string, string> };
      /** Family adapters (JetBrains): act on ONE product (`intellij-idea`, `goland`); absent = all. */
      product?: string;
    }
  ): Promise<{ status: string; message: string; warnings?: ClientActionWarning[] }> {
    const res = await fetch(`/api/admin/client/${client}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // reasonCode/params ride along for console i18n mapping (clients page);
      // the raw message stays the fallback for unknown codes.
      const err = new Error(body.message || `HTTP ${res.status}`) as Error & { reasonCode?: string; params?: Record<string, string> };
      err.reasonCode = body.reasonCode;
      err.params = body.params;
      throw err;
    }
    return res.json();
  },

  /** Smart slot assignment: the backend runs ONE decider-model chat call over
   *  frontend-supplied targets/candidates (console drafts are the truth) and
   *  returns slot → model-id assignments. Pure decision service — nothing is
   *  persisted; the caller applies the result to its own draft state. */
  async smartAssignClient(
    client: string,
    payload: {
      deciderModel: string;
      targets: { key: string; label?: string; role?: string; current?: string }[];
      /** Plain ids, or `{ id, note }` — the note contextualizes (e.g. the model
       *  a profile slot resolves to) but only `id` is a legal assignment. */
      candidates: (string | { id: string; note?: string })[];
    }
  ): Promise<{ status: string; resolved?: string; assignments: Record<string, string> }> {
    const res = await fetch(`/api/admin/client/${client}/smart-assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Which PHYSICAL model a decider pick actually answers with — the console's
   *  decision-model cascade (tier alias → healthy decision-surface pool head,
   *  `auto` → systemone.defaultModel). Costs nothing; the picker uses it to show
   *  the resolution instead of making the operator guess. */
  async resolveDecider(model: string): Promise<{ model: string; resolved: string } | null> {
    const res = await fetch(`/api/admin/decider/resolve?model=${encodeURIComponent(model)}`);
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.resolved ? { model: json.model, resolved: json.resolved } : null;
  },

  /** All models the gateway can route to: virtual (auto/lite/plus/pro/ultra), combos,
   *  registered models and variant exposures — `kind` tags which one each id is ('auto' = the bare auto alias, 'tier' = the bare tier aliases).
   *  `tiers` = the full membership set (a model may belong to several tiers).
   *  `efforts` = declared thinking levels (registered/variant rows only); `[]`
   *  means the model has no explicit level control. Any level written into a config
   *  field must come from this list — the pipeline clamps everything else.
   *  `wire` = the model's resolved upstream wire (registered/variant rows only):
   *  'systemone' means a decision-wire model that NO chat surface can address.
   *  Reads the console endpoint — /v1/models requires a key like every surface. */
  async listGatewayModels(): Promise<{
    id: string;
    owned_by: string;
    tiers?: string[];
    kind?: string;
    members?: number;
    efforts?: string[];
    wire?: string;
  }[]> {
    const res = await fetch('/api/admin/gateway-models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json?.models || []).map((m: any) => ({
      id: m.id,
      owned_by: m.owned_by || '',
      tiers: Array.isArray(m.tiers) ? m.tiers : [],
      kind: m.kind || undefined,
      members: typeof m.members === 'number' ? m.members : undefined,
      wire: typeof m.wire === 'string' ? m.wire : undefined,
      efforts: Array.isArray(m.efforts) ? m.efforts.filter((e: unknown): e is string => typeof e === 'string') : undefined,
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
   * Scope-aware trip for 'credential' / 'pair' / 'provider'. Deliberately NOT
   * routed through tripBreaker(): the legacy 'model' scope keeps its exact
   * body and its legacy non-throwing reply handling. Unlike the model scope,
   * a scoped trip with nothing to take down answers 400 — thrown here
   * so the console reports it as a failure instead of a fake success.
   */
  async tripBreakersScoped(
    scope: Exclude<BreakerTripScope, 'model'>,
    target: { model?: string; credential?: string; provider?: string; reason?: string; cooldownMs?: number }
  ): Promise<BreakerScopeResponse> {
    return postBreakerScope('/api/admin/health/circuit-breakers/trip', { scope, ...target });
  },

  /**
   * Credential/pair/provider reset. Resetting a credential never lifts its
   * SUSPECT flag (administrative state — see clearSuspectCredential below).
   */
  async resetBreakersScoped(
    scope: Exclude<BreakerTripScope, 'model'>,
    target: { model?: string; credential?: string; provider?: string }
  ): Promise<BreakerScopeResponse> {
    return postBreakerScope('/api/admin/health/circuit-breakers/reset', { scope, ...target });
  },

  /**
   * Explicit admin door for a SUSPECT credential (body
   * {provider, credential}; `credential` is the keyHash prefix). `cleared:false`
   * means the flag was already absent — a no-op, not an error.
   */
  async clearSuspectCredential(providerId: string, credential: string): Promise<SuspectCredentialClearResponse> {
    const res = await fetch('/api/admin/health/suspect-credentials/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, credential }),
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
   * GET .../:name/export — request parts for the archive. The console streams
   * the response itself (progress + native save picker), so it takes the URL
   * and headers; the server normally picks the filename via Content-Disposition
   * and `fallbackName` covers a header-less response (encrypted and plaintext
   * archives share ONE suffix — encryption is a property of the bytes).
   * `includePayload` selects a subset of the payload files (comma-joined
   * `?include=`); absent = every payload file that exists.
   * `encrypt` + `password` request a password-encrypted archive — the
   * password travels ONLY in the x-ocr-archive-password header, never the
   * query (access logs record URLs).
   */
  environmentExportRequest(
    name: string,
    opts: { includeSecrets: boolean; includePayload?: string[]; encrypt?: boolean; password?: string }
  ): { url: string; headers: Record<string, string>; fallbackName: string } {
    const qs = new URLSearchParams({ secrets: opts.includeSecrets ? 'include' : 'redact' });
    if (opts.includePayload && opts.includePayload.length > 0) qs.set('include', opts.includePayload.join(','));
    if (opts.encrypt) qs.set('encrypt', '1');
    const headers: Record<string, string> = {};
    if (opts.encrypt && opts.password) headers['x-ocr-archive-password'] = opts.password;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return {
      url: `/api/admin/environments/${encodeURIComponent(name)}/export?${qs.toString()}`,
      headers,
      fallbackName: `${name}-${stamp}${ENV_ARCHIVE_SUFFIX}`,
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
    apiKey?: string,
    hideInternal = true
  ): Promise<{ sessions: SessionRecord[]; total: number }> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    if (q) qs.set('q', q);
    if (apiKey) qs.set('apiKey', apiKey);
    // Backend default hides internal rows; send '0' explicitly to include them.
    qs.set('hideInternal', hideInternal ? '1' : '0');
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
   * Reset the live window(s) of ONE subject (optionally one rule label,
   * e.g. "1m/requests") — administrative escape hatch for a stuck budget.
   */
  async resetRateLimitWindows(subject: string, rule?: string): Promise<{ status: string; reset: number }> {
    const res = await fetch('/api/admin/ratelimit/windows/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, ...(rule ? { rule } : {}) }),
    });
    const body = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new Error(body?.message || `HTTP ${res.status}`);
    }
    return body;
  },

  /**
   * Failure-event ledger — every failed upstream model call (serving pool
   * attempts + decision wire calls), newest first (bounded ring, repeats
   * coalesce). Optional equality filters narrow server-side; the console
   * page loads the whole ring and filters client-side.
   */
  async getFailureEvents(params?: {
    model?: string;
    provider?: string;
    keyHashPrefix?: string;
    errorClass?: string;
    role?: string;
    limit?: number;
  }): Promise<{ status: string; events: FailureEvent[] }> {
    const qs = new URLSearchParams();
    if (params?.model) qs.set('model', params.model);
    if (params?.provider) qs.set('provider', params.provider);
    if (params?.keyHashPrefix) qs.set('keyHashPrefix', params.keyHashPrefix);
    if (params?.errorClass) qs.set('errorClass', params.errorClass);
    if (params?.role) qs.set('role', params.role);
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await fetch(`/api/admin/failure-events${suffix}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Wipe the failure ledger (ring + durable mirror). Breaker state untouched. */
  async clearFailureEvents(): Promise<{ status: string; cleared: boolean }> {
    const res = await fetch('/api/admin/failure-events/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Delete ONE failure event by id (ring + durable mirror die together). */
  async deleteFailureEvent(id: string): Promise<{ status: string; removed: boolean }> {
    const res = await fetch(`/api/admin/failure-events/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Harness source registry + measured health (ADR-0015 §D6). */
  async harnessSources(): Promise<{ status: string; sources: HarnessSourceView[] }> {
    const res = await fetch('/api/admin/harness/sources');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Harness host catalog with resolved roots and their origin. */
  async harnessHosts(): Promise<{ status: string; hosts: HarnessHostView[] }> {
    const res = await fetch('/api/admin/harness/hosts');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async listProjects(): Promise<ProjectsResponse> {
    const res = await fetch('/api/admin/projects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async createProject(input: { name: string; path: string }): Promise<{ status: 'ok'; project: ProjectItem }> {
    const res = await fetch('/api/admin/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async updateProject(id: string, input: { name?: string; path?: string }): Promise<{ status: 'ok'; project: ProjectItem }> {
    const res = await fetch(`/api/admin/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async deleteProject(id: string): Promise<{ status: 'ok' }> {
    const res = await fetch(`/api/admin/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async setActiveProject(id: string | null): Promise<{ status: 'ok'; activeId: string | null }> {
    const res = await fetch('/api/admin/projects/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async validateProjectPath(pathStr: string): Promise<{ status: 'ok'; resolved: string }> {
    const res = await fetch('/api/admin/projects/validate-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pathStr }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /**
   * Installed artifacts + untracked directories, reconciled per copy. With `projectId`, the scan
   * resolves PROJECT-scope roots against that project's path instead of the gateway cwd — the
   * same re-scan `/plan` does, so the project tab lists what that project holds.
   */
  async harnessInventory(params?: { projectId?: string }): Promise<HarnessInventoryResponse> {
    const search = new URLSearchParams();
    if (params?.projectId) search.set('projectId', params.projectId);
    const qs = search.toString();
    const res = await fetch(`/api/admin/harness/inventory${qs ? `?${qs}` : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Live MCP status from each runtime that exposes one. Unknown hosts are absent, never assumed. */
  async harnessMcpRuntime(): Promise<McpRuntimeReport> {
    const res = await fetch('/api/admin/harness/mcp/runtime');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Test the DSN builder's current values. PostgreSQL and MySQL/MariaDB log in for real
   * (`select 1` / `ping`) and answer a verdict code; every other scheme gets a TCP dial. The
   * credential goes to the local admin route for this one request — never logged, never echoed
   * (ADR-0015 §D11).
   */
  async harnessMcpDsnProbe(input: {
    driver: string;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    params: Record<string, string>;
  }): Promise<{
    status: string;
    target: string;
    engine: 'postgres' | 'mysql' | null;
    reachable: boolean;
    verified: boolean;
    code: string;
    message?: string;
  }> {
    const res = await fetch('/api/admin/harness/mcp/dsn-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.message || `HTTP ${res.status}`) as Error & { code?: string };
      err.code = data?.code;
      throw err;
    }
    return data;
  },

  /** Dry-run a maintenance action (only `remove` exists today). Writes nothing. */
  async harnessPlan(body: {
    action: 'remove';
    /** Project whose roots resolve `project`-scope copies; absent = the gateway cwd. */
    projectId?: string;
    items: {
      artifactId: string | null;
      copies: { scope: 'global' | 'project'; host: string; path: string }[];
      /** A discovered row's own record; authoritative over `copies` when present. */
      removal?: HarnessDiscoveredArtifact['removal'];
    }[];
  }): Promise<{ status: string; plan: HarnessRemovePlan }> {
    const res = await fetch('/api/admin/harness/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    return data;
  },

  /** Marketplace browse — normalized across sources; unavailable sources throw with a reason. */
  async harnessBrowse(params: {
    source?: string;
    q?: string;
    limit?: number;
    harness?: string;
    /** The market axis being browsed — a source serving several axes (npm) forks its default
     *  query and row install kind on it. */
    kind?: 'skill' | 'mcp' | 'plugin';
    /** 1-based page; the backend clamps a nonsense value to the first page. */
    page?: number;
    /** One of the source's declared `sorts`; the backend drops an order it cannot serve. */
    sort?: string;
    /** Ask the source again: the backend drops this source's 60 s browse cache before reading, so
     *  the answer is a new upstream call rather than a cached window. */
    refresh?: boolean;
  }): Promise<{
    status: string;
    source: string;
    /** The page the backend actually answered (echoed, never inferred). */
    page: number;
    items: HarnessMarketItem[];
    /** Another page exists for this query — the only honest "next" signal, because a source may
     *  report no total at all. */
    hasMore: boolean;
    /** Rows the source reports for this query, when it reports one (drives the page count). */
    total?: number;
    /**
     * What `total` counts. `window` = the reachable slice only (skills.sh ships 600 of a 9 911-skill
     * board and caps every search at 200), so the pager must keep the number for its page buttons but
     * never print it as the catalog's size.
     */
    totalScope?: 'catalog' | 'window';
    /** English fallback copy for `noteCode` (the console localizes the code it knows). */
    note?: string;
    /** Opaque note identity — the console maps it to its own translation table. */
    noteCode?: string;
    noteParams?: Record<string, string>;
  }> {
    const search = new URLSearchParams();
    if (params.source) search.set('source', params.source);
    if (params.q) search.set('q', params.q);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.harness) search.set('harness', params.harness);
    if (params.kind) search.set('kind', params.kind);
    if (params.page && params.page > 1) search.set('page', String(params.page));
    if (params.sort) search.set('sort', params.sort);
    if (params.refresh) search.set('refresh', '1');
    const res = await fetch(`/api/admin/harness/browse?${search.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data?.message || `HTTP ${res.status}`) as Error & {
        code?: string;
        /** Why it failed, in the backend's translatable vocabulary (`harness.browseError.*`). */
        reason?: string;
        reasonParams?: Record<string, string>;
      };
      error.code = data?.code;
      error.reason = data?.reason;
      error.reasonParams = data?.reasonParams;
      throw error;
    }
    return data;
  },

  /**
   * On-demand GitHub stars for the repositories the market is showing.
   *
   * Separate from `harnessBrowse` on purpose: a browse must never spend the operator's GitHub quota
   * unasked. The backend batches several `repo:` qualifiers per request and caches the answer, so a
   * repeated click (or a page turn back) is free. Repositories GitHub does not index come back in
   * `missing`.
   *
   * `cachedOnly` answers from the backend cache with the network removed: the console calls it as a
   * page renders, so a count this gateway resolved minutes ago appears WITHOUT a click, and a miss
   * stays a miss (no upstream request, nothing to spend).
   */
  async harnessMarketStars(
    repos: string[],
    options?: { cachedOnly?: boolean }
  ): Promise<{
    status: string;
    /** `owner/repo` (lowercase) → star count. */
    stars: Record<string, number>;
    /** Requested repositories the answer did not cover. */
    missing: string[];
    /** How many were already cached — a click that spent nothing. */
    cached: number;
  }> {
    const res = await fetch('/api/admin/harness/market/stars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options?.cachedOnly ? { repos, cachedOnly: true } : { repos }),
    });
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data?.message || `HTTP ${res.status}`) as Error & {
        code?: string;
        reason?: string;
        reasonParams?: Record<string, string>;
      };
      error.code = data?.code;
      error.reason = data?.reason;
      error.reasonParams = data?.reasonParams;
      throw error;
    }
    return data;
  },

  /**
   * Market-row detail — the long-form half of a browse answer (README, licence, version).
   *
   * Reads ONE row's declared identity (`npm:<name>` key and/or `owner/repo`); never a URL, so this
   * cannot be used as a generic proxy. A row with nothing readable still answers (`readFrom: 'none'`)
   * because the dialog is built on the fields the browse answer already carried.
   */
  async harnessDetail(params: {
    source?: string;
    channel?: string;
    key?: string;
    repo?: string;
    /** Console language: the backend prefers the README's own localized edition and reports
     *  `readmeLang`, so an already-localized page is shown instead of translated. */
    lang?: Lang;
  }): Promise<{
    status: string;
    source: string;
    detail: HarnessMarketDetail;
  }> {
    const search = new URLSearchParams();
    if (params.channel) search.set('channel', params.channel);
    else if (params.source) search.set('source', params.source);
    if (params.key) search.set('key', params.key);
    if (params.repo) search.set('repo', params.repo);
    if (params.lang) search.set('lang', params.lang);
    const res = await fetch(`/api/admin/harness/detail?${search.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    return data;
  },

  /**
   * Install one artifact — one store entry, N copies (skills) or ONE runtime's package (plugins).
   * The request speaks a portable `key` (`<sourceId>:<ref>[#dir]`); `kind` picks the writer.
   */
  async harnessInstall(body: {
    key?: string;
    kind?: 'skill' | 'mcp' | 'plugin';
    repo?: string;
    sourceId?: string;
    skillDir?: string;
    manualSpec?: string;
    /** Manual MCP server (`kind` must be `mcp`): written into the host's own config, no source. */
    manualPayload?: { name: string; launch: HarnessMcpLaunch };
    /** Operator-edited MCP launch (install form): replaces the resolver's generated launch. */
    launch?: HarnessMcpLaunch;
    /** Gate 3 / gate 2 acknowledgement — without it an plugin/mcp install writes nothing. */
    confirm?: boolean;
    /** Surfaces the row was browsed on, besides the one that writes it (see `HarnessArtifactView`). */
    listedOn?: string[];
    /** GIT-BACKED plugin identity: the runtime's own marketplace chain installs `<plugin>@<name>`. */
    marketplace?: { repo: string; plugin: string; name: string };
    /** The market row's one-line description; the manifest keeps it when no resolver provides one. */
    description?: string;
    /** Per-profile plugin store (DSH): the profile this install lands in. */
    profile?: string;
    /** Console-generated id for the live install log (plugin subprocess output). */
    installLogId?: string;
    hosts: string[];
    scope?: 'global' | 'project';
    projectRoot?: string;
    projectId?: string;
  }): Promise<{
    status: string;
    artifactId: string;
    name: string;
    files?: number;
    bytes?: number;
    copies: { host: string; path?: string; external?: boolean }[];
    skipped: { host: string; code: string; message: string }[];
  }> {
    const res = await fetch('/api/admin/harness/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      // `ambiguous` failures carry `candidates` (the skill directories found) — the install dialog
      // uses them to offer a picker; `confirm_required` carries `plan` (the exact commands/merges an
      // plugin or MCP install would perform) — the page shows it and retries with `confirm: true`.
      const err: Error & {
        code?: string;
        candidates?: string[];
        plan?: HarnessInstallTarget[];
        skipped?: { host: string; code: string; message: string }[];
      } = new Error(data?.message || `HTTP ${res.status}`);
      err.code = data?.code;
      err.candidates = data?.candidates;
      err.plan = data?.plan;
      err.skipped = data?.skipped;
      throw err;
    }
    return data;
  },

  /** Poll one live install's mirrored output (see POST /harness/install's `installLogId`). */
  async harnessInstallLog(id: string): Promise<{ status: string; lines: string[]; done: boolean; error?: string }> {
    const res = await fetch(`/api/admin/harness/install-log/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    return data;
  },

  /** Read ONE existing MCP server back as a launch (env/header KEY NAMES only). */
  async harnessMcpEntry(params: { host: string; name: string; scope?: 'global' | 'project'; projectId?: string }): Promise<HarnessMcpEntry> {
    const search = new URLSearchParams({ host: params.host, name: params.name, scope: params.scope ?? 'global' });
    if (params.projectId) search.set('projectId', params.projectId);
    const res = await fetch(`/api/admin/harness/mcp/entry?${search.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.message || `HTTP ${res.status}`) as Error & { code?: string };
      err.code = data?.code;
      throw err;
    }
    return data;
  },

  /**
   * Ask the MCP Registry for the latest `server.json` of every server matching `q` (a package name
   * or a registry name). Read-only; the answer drives the visual parameter form.
   */
  async harnessMcpRegistry(q: string): Promise<{ status: string; candidates: HarnessMcpRegistryCandidate[] }> {
    const res = await fetch(`/api/admin/harness/mcp/registry?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.message || `HTTP ${res.status}`) as Error & { code?: string };
      err.code = data?.code;
      throw err;
    }
    return data;
  },

  /**
   * Read one published npm package and list the CLI flags its own parser reads
   * (`--transport`, `--port`, `--dsn` …). The tarball is downloaded and scanned in memory;
   * the package is never executed.
   */
  async harnessMcpCli(pkg: string, registry: 'npm' | 'pypi' = 'npm'): Promise<HarnessMcpCliProbe> {
    const res = await fetch(
      `/api/admin/harness/mcp/cli?pkg=${encodeURIComponent(pkg)}&registry=${registry}`
    );
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.message || `HTTP ${res.status}`) as Error & { code?: string };
      err.code = data?.code;
      throw err;
    }
    return data;
  },

  /**
   * Change one existing MCP server's launch. Gate 2: without `confirm` the backend answers
   * `confirm_required` with the exact file/container plan and writes nothing.
   */
  async harnessMcpEdit(body: {
    host: string;
    name: string;
    launch: HarnessMcpLaunch;
    /** The manifest record to keep in sync; absent for a runtime-installed (discovered) entry. */
    artifactId?: string;
    scope?: 'global' | 'project';
    /** Project root resolution for `project` scope (the backend maps it to the project path). */
    projectId?: string;
    confirm?: boolean;
  }): Promise<{
    status: string;
    changed: boolean;
    host: string;
    name: string;
    file: string;
    container: string;
    artifactId: string | null;
  }> {
    const res = await fetch('/api/admin/harness/mcp/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', ...body }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.message || `HTTP ${res.status}`) as Error & {
        code?: string;
        plan?: HarnessInstallTarget[];
      };
      err.code = data?.code;
      err.plan = data?.plan;
      throw err;
    }
    return data;
  },

  /**
   * Translate one description into the console language (derived cache; may call the gateway).
   *
   * `format: 'markdown'` selects the long-form contract (a README): every prose segment is
   * translated in chunks (fenced code preserved verbatim) and rejoined in document order. `refresh`
   * (long-form only) re-translates a document that already has a cached rendering, replacing it on
   * success.
   */
  async harnessTranslate(body: {
    text: string;
    lang: string;
    format?: 'markdown';
    refresh?: boolean;
  }): Promise<{
    status: string;
    text: string;
    cached: boolean;
    model: string;
  }> {
    const res = await fetch('/api/admin/harness/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data?.message || `HTTP ${res.status}`) as Error & { code?: string };
      error.code = data?.code;
      throw error;
    }
    return data;
  },

  /**
   * Long-form translation with live progress. The server answers NDJSON: `progress` events carry
   * (completed chunks, total) while the README is translated, then exactly one `result` or `error`.
   * Resolves with the final rendering; a streamed error rejects like the plain route does.
   */
  async harnessTranslateStream(
    body: { text: string; lang: string; refresh?: boolean },
    onProgress: (done: number, total: number) => void
  ): Promise<{ text: string; cached: boolean; model: string }> {
    const res = await fetch('/api/admin/harness/translate-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, format: 'markdown' }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => undefined);
      const error = new Error(data?.message || `HTTP ${res.status}`) as Error & { code?: string };
      error.code = data?.code;
      throw error;
    }
    const out: { value?: { text: string; cached: boolean; model: string } } = {};
    let failure: string | null = null;
    await readNdjsonLines(res, (line) => {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // A malformed line must not kill the stream — skip it.
      }
      if (evt.type === 'progress' && typeof evt.done === 'number' && typeof evt.total === 'number') {
        onProgress(evt.done, evt.total);
      } else if (evt.type === 'result' && typeof evt.text === 'string') {
        out.value = { text: evt.text, cached: evt.cached === true, model: typeof evt.model === 'string' ? evt.model : '' };
      } else if (evt.type === 'error') {
        failure = typeof evt.message === 'string' && evt.message ? evt.message : 'translation failed';
      }
    });
    if (failure) throw new Error(failure);
    if (!out.value) throw new Error('translation stream ended without a result');
    return out.value;
  },

  /** Batch translation, one chunk per call (the page walks the list in chunks). */
  async harnessTranslateBatch(body: { lang: string; texts: string[] }): Promise<{
    status: string;
    results: Record<string, { text: string; model: string; cached: boolean }>;
    errors: { text: string; code: string; message: string }[];
  }> {
    const res = await fetch('/api/admin/harness/translate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data?.message || `HTTP ${res.status}`) as Error & { code?: string };
      error.code = data?.code;
      throw error;
    }
    return data;
  },

  /** Cache-only batch lookup: re-seeds the console with translations from previous visits. */
  /** Cache-only translation lookup (never calls a model). `format: 'markdown'` reads the README
   *  store instead of the description one, so a page translated yesterday opens translated. */
  async harnessTranslations(body: { lang: string; texts: string[]; format?: 'markdown' }): Promise<{
    status: string;
    translations: Record<string, { text: string; model: string }>;
  }> {
    const res = await fetch('/api/admin/harness/translations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Fire the real translation chain over a one-line payload — the default-model picker's
   *  "test" button, testing the PICKER'S PENDING value (test before save; empty = unset).
   *  Never writes the cache; an explicit click is the explicit one-call spend. */
  async translationProbe(lang = 'en', model?: string): Promise<{
    ok: boolean;
    model?: string;
    chain: string[];
    latencyMs: number;
    attempts: { model: string; ok: boolean; error?: string }[];
    code?: 'no_api_key' | 'unsupported_lang' | 'upstream';
  }> {
    const res = await fetch('/api/admin/harness/translations/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, ...(model !== undefined ? { model } : {}) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Fire the real /v1/systemone fallback path — the System One picker's "test" button, testing
   *  the PICKER'S PENDING value (test before save; empty = unset). A real surface request:
   *  captured like one, one upstream call per explicit click. */
  async systemoneProbe(model?: string): Promise<{
    ok: boolean;
    configured: string;
    model?: string;
    latencyMs: number;
    code?: 'not_configured' | 'no_api_key' | 'upstream';
    error?: string;
  }> {
    const res = await fetch('/api/admin/systemone/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model !== undefined ? { model } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Execute a plan. A 409 means the plan is stale / unknown / needs `discardLocalEdits`. */
  async harnessApply(body: { planId: string; discardLocalEdits?: boolean }): Promise<{
    status: string;
    removed: string[];
    trashDir: string | null;
    prunedArtifacts?: string[];
    /** Operator-facing explanation, present when the apply did something a generic "removed N"
     *  line would misstate (e.g. a package-manager record pruned while the package stays). */
    message?: string;
  }> {
    const res = await fetch('/api/admin/harness/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const error = new Error(data?.message || `HTTP ${res.status}`) as Error & { code?: string };
      error.code = data?.code;
      throw error;
    }
    return data;
  },

  // ---------------------------------------------------------------------------
  // Plugin catalog (ADR-0015 §D10): one merged directory per harness.
  // ---------------------------------------------------------------------------

  async harnessPluginCatalog(
    harness: string,
    opts: { q?: string; page?: number; pageSize?: number; sort?: string } = {},
  ): Promise<{
    status: string;
    sort: string;
    rows: HarnessCatalogRow[];
    page: number;
    pageSize: number;
    hasMore: boolean;
    total: number | null;
    notes: string[];
    sections?: HarnessCatalogSection[];
  }> {
    const search = new URLSearchParams();
    if (opts.q) search.set('q', opts.q);
    if (opts.page) search.set('page', String(opts.page));
    if (opts.pageSize) search.set('pageSize', String(opts.pageSize));
    if (opts.sort) search.set('sort', opts.sort);
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/catalog?${search.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessPluginSources(harness: string, kind?: 'skill' | 'plugin' | 'mcp'): Promise<{
    status: string;
    extensionDir: string | null;
    sources: HarnessCatalogSource[];
    operator: HarnessMarketplaceEntry[];
  }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/sources${kind ? `?kind=${kind}` : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessSyncHarnessMarketplaces(harness: string): Promise<{
    status: string;
    timestamp: number;
    discovered: { name: string; repo: string; type?: string; origin?: string }[];
    imported: { slug: string; repo: string }[];
    synced: { host: string; action: string; repo: string; ok: boolean; command?: string[]; error?: string }[];
    summary: { discoveredCount: number; importedCount: number; syncedCount: number; failedCount: number };
  }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/sources/sync`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessPluginCheckSource(harness: string, url: string, opts: { type?: 'github' | 'npm' | 'pypi'; kind?: 'plugin' | 'mcp'; extensionDir?: string } = {}): Promise<{
    status: string;
    ok: boolean;
    skills: number;
    mcps: number;
    plugins: number;
    hosts: string[];
    marketplace: string | null;
    /** Duplicate of the backend contract's `SourceOutcome` (ADR-0015 §D11). */
    reason?: SourceReason;
    params?: Record<string, string>;
    message?: string;
  }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/sources/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type: opts.type, kind: opts.kind, extensionDir: opts.extensionDir }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessPluginRegisterSource(
    harness: string,
    url: string,
    opts: { type?: 'github' | 'npm' | 'pypi'; kind?: 'plugin' | 'mcp'; extensionDir?: string; rescan?: { enabled?: boolean; intervalMs?: number }; catalog?: string; shared?: boolean } = {},
  ): Promise<{ status: string; reason?: SourceReason; params?: Record<string, string>; message?: string }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type: opts.type, kind: opts.kind, extensionDir: opts.extensionDir, rescan: opts.rescan, catalog: opts.catalog, shared: opts.shared }),
    });
    const data = await res.json();
    if (!res.ok) throw new SourceOutcomeError(data?.message || `HTTP ${res.status}`, data?.reason, data?.params);
    return data;
  },

  async harnessPluginRemoveSource(harness: string, slug: string): Promise<{ status: string }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/sources/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessPluginUpdateSource(harness: string, slug: string, patch: { enabled?: boolean; catalog?: string; rescan?: { enabled?: boolean; intervalMs?: number } }): Promise<{ status: string }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/sources/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessPluginRescanSource(harness: string, slug: string): Promise<{ status: string; diff: { added: string[]; removed: string[] } | null; rows: number }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/sources/${encodeURIComponent(slug)}/rescan`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessPluginSourceSnapshots(harness: string, slug: string): Promise<{ status: string; snapshots: HarnessSourceSnapshot[] }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/sources/${encodeURIComponent(slug)}/snapshots`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Skill sources are GLOBAL (ADR-0015 §D11): the route carries no harness, because a skill
   * registry serves every harness alike. Plugin sources keep their per-harness `/plugins/` verbs.
   */
  async harnessSkillSources(): Promise<{
    status: string;
    sources: HarnessCatalogSource[];
    operator: HarnessMarketplaceEntry[];
  }> {
    const res = await fetch('/api/admin/harness/skills/sources');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessSkillCheckSource(url: string): Promise<{
    status: string;
    ok: boolean;
    skills: number;
    plugins: number;
    reason?: SourceReason;
    params?: Record<string, string>;
    message?: string;
  }> {
    const res = await fetch('/api/admin/harness/skills/sources/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessSkillRegisterSource(
    url: string,
    opts: { catalog?: string; rescan?: { enabled?: boolean; intervalMs?: number } } = {},
  ): Promise<{ status: string; reason?: SourceReason; params?: Record<string, string>; message?: string }> {
    const res = await fetch('/api/admin/harness/skills/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, catalog: opts.catalog, rescan: opts.rescan }),
    });
    const data = await res.json();
    if (!res.ok) throw new SourceOutcomeError(data?.message || `HTTP ${res.status}`, data?.reason, data?.params);
    return data;
  },

  async harnessSkillUpdateSource(
    slug: string,
    patch: { enabled?: boolean; catalog?: string; rescan?: { enabled?: boolean; intervalMs?: number } },
  ): Promise<{ status: string }> {
    const res = await fetch(`/api/admin/harness/skills/sources/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessSkillRemoveSource(slug: string): Promise<{ status: string }> {
    const res = await fetch(`/api/admin/harness/skills/sources/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessSkillRescanSource(slug: string): Promise<{ status: string; diff: { added: string[]; removed: string[] } | null; rows: number }> {
    const res = await fetch(`/api/admin/harness/skills/sources/${encodeURIComponent(slug)}/rescan`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async harnessPluginInstall(
    harness: string,
    row: HarnessCatalogRow,
    opts: { scope?: string; confirm?: boolean } = {},
  ): Promise<{ status: string; ok?: boolean; artifactId?: string; name?: string; message?: string }> {
    const res = await fetch(`/api/admin/harness/plugins/${encodeURIComponent(harness)}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row, ...opts }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    return data;
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

  /** Manual refresh (POST /api/admin/quota/refresh): one pair, or the whole
   *  schedule when no identity given. The backend invalidates and then runs
   *  ONE bounded probe cycle inside the request — resolving means the next
   *  GET already carries fresh numbers, unless an armed 429 gate stopped it
   *  (`rateLimited`) or the budget ran out (`pending` left for the next tick). */
  async refreshQuota(target?: { providerId: string; keyHashPrefix: string }): Promise<{
    status: string;
    success: boolean;
    reasonCode?: string;
    probed?: number;
    pending?: number;
    rateLimited?: boolean;
  }> {
    const res = await fetch('/api/admin/quota/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target ?? {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Arm / clear ONE credential's outbound caps (config `credentials:` overlay
   * write — the credential itself is not touched). `limits: []` or `null`
   * clears the entry. Hot: the gateway reloads the rule table on save.
   */
  async setCredentialLimits(payload: {
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
    const res = await fetch('/api/admin/credentials/limits', {
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
    models: {
      id: string;
      kind: 'auto' | 'tier' | 'combo' | 'model' | 'variant';
      provider: string;
      tiers?: string[];
      tier?: string;
      virtual: boolean;
      allowed: boolean;
    }[];
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

  /** THE ONE capture read. Paging is in REQUESTS; each request carries its
   *  complete `exchanges[]`, projected into a view for the console chips. */
  async getCaptureEvents(
    date: string,
    file: string,
    limit = 50,
    bodies: 'full' | 'none' | 'chat' = 'full',
    stitched = true,
    /** 1-based page counted from the NEWEST end. */
    page = 1
  ): Promise<{
    events: CaptureEvent[];
    requests: CaptureRequestView[];
    totalLines: number;
    /** Requests in the read window (the pager's exact denominator). */
    totalRequests: number;
    /** Distinct write-time turn ordinals in the read window. */
    totalTurns: number;
    windowComplete: boolean;
    fileTruncated: boolean;
    fragments?: CaptureFragmentRow[];
    page: number;
    totalPages: number;
    hasOlder: boolean;
    hasNewer: boolean;
  }> {
    const params = new URLSearchParams({
      limit: String(limit),
      bodies,
      page: String(page),
      ...(stitched ? { stitched: '1' } : {}),
    });
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}/events?${params.toString()}`
    );
    if (!res.ok) {
      return {
        events: [],
        requests: [],
        totalLines: 0,
        totalRequests: 0,
        totalTurns: 0,
        windowComplete: true,
        fileTruncated: false,
        page: 1,
        totalPages: 1,
        hasOlder: false,
        hasNewer: false,
      };
    }
    const json = await res.json();
    return {
      ...json,
      events: Array.isArray(json.events) ? json.events : [],
      requests: Array.isArray(json.requests) ? json.requests.map(toCaptureRequestView) : [],
      totalRequests: Number(json.totalRequests) || 0,
      totalTurns: Number(json.totalTurns) || 0,
      fragments: Array.isArray(json.fragments) ? json.fragments : undefined,
    };
  },

  /** EXACT whole-archive summary: the request count and the WRITE-TIME turn
   *  index (one entry per `turnIndex`). Display-only — pagination stays
   *  window-bounded. Resolves `null` when the scan is unavailable so callers
   *  keep their previous/unknown state instead of rendering a bogus zero. */
  async getCaptureSummary(
    date: string,
    file: string,
    stitched = true
  ): Promise<CaptureArchiveSummary | null> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}/summary${
        stitched ? '?stitched=1' : ''
      }`
    );
    if (!res.ok) return null;
    const json = await res.json();
    return {
      requests: Number(json.requests) || 0,
      fragments: Number(json.fragments) || 0,
      turns: Array.isArray(json.turns) ? json.turns : [],
    };
  },

  /** Full wire bodies for ONE request, fetched on demand (metadata-first
   *  list reads). The key is its `requestId` or any of its event ids. */
  async getCaptureRequest(
    date: string,
    file: string,
    requestId: string,
    stitched = true
  ): Promise<CaptureRequestView | null> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(
        file
      )}/request?id=${encodeURIComponent(requestId)}${stitched ? '&stitched=1' : ''}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.request ? toCaptureRequestView(json.request) : null;
  },

  async getCaptureRecords(
    date: string,
    file: string,
    limit = 200
  ): Promise<{ records: Record<string, unknown>[]; totalLines: number; fileTruncated: boolean }> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}?limit=${limit}`
    );
    if (!res.ok) return { records: [], totalLines: 0, fileTruncated: false };
    return res.json();
  },

  /** URL of one session archive as JSONL; `exclude` strips body fields, metadata always kept. */
  captureArchiveUrl(date: string, file: string, exclude?: string[]): string {
    const params = new URLSearchParams({ format: 'raw' });
    if (exclude && exclude.length > 0) params.set('exclude', exclude.join(','));
    return `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}?${params.toString()}`;
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

  /** Streamed replay of POST /api/admin/capture/replay (one-shot, never
   *  recorded): the endpoint answers NDJSON; each parsed event goes to
   *  `onEvent` so the dialog renders the body incrementally. */
  async replayCaptureRequest(spec: ReplaySpec, onEvent: (evt: CaptureReplayStreamEvent) => void): Promise<void> {
    const res = await fetch('/api/admin/capture/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    if (!res.ok || !res.body) {
      const json = await res.json().catch(() => undefined);
      onEvent({ type: 'error', message: json?.message || `HTTP ${res.status}` });
      return;
    }
    await readNdjsonLines(res, (line) => {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (typeof raw.type === 'string') {
          onEvent(raw as unknown as CaptureReplayStreamEvent);
        } else if (raw.status === 'ok' && typeof raw.body === 'string') {
          // Legacy (pre-NDJSON) gateway: one whole-payload JSON answer.
          // Convert so the dialog still renders instead of erroring.
          onEvent({ type: 'chunk', text: raw.body });
          onEvent({ type: 'end', truncated: Boolean(raw.truncated) });
        } else if (raw.status === 'error') {
          onEvent({ type: 'error', message: String(raw.message || 'replay failed') });
        }
      } catch {
        // A malformed line must not kill the stream — skip it.
      }
    });
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
// Plugin management (model-service plugins installed by the operator)
// ---------------------------------------------------------------------------

export interface PluginProviderPresetInfo {
  presetId: string;
  providerId: string;
  displayName: string;
  npm: string;
  baseUrl: string;
  description?: string;
}

export interface PluginViewInfo {
  id: string;
  name: string;
  version: string;
  type: string;
  wires: string[];
  description?: string | Record<string, string>;
  presets?: PluginProviderPresetInfo[];
  source: 'dev' | 'packaged';
  path: string;
  loaded: boolean;
  /** Wall-clock ms when the backend imported this plugin's code (mirrors backend PluginView). */
  loadedAt?: number;
  error?: string;
  disabled?: boolean;
}

/** One operator-facing plugin setting, mirroring backend/src/plugins/types.ts. */
export interface PluginConfigFieldInfo {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'enum';
  /** Per-type fallback when the stored value is unset or fails validation. */
  default?: string | number | boolean | string[];
  /** number: inclusive bounds. */
  min?: number;
  max?: number;
  /** enum: the allowed values. */
  values?: string[];
  /** enum: value → display label (same string-or-locale-map convention as
   *  `title`). An unlabeled value renders as the raw value. */
  enumLabels?: Record<string, string | Record<string, string>>;
  /** Widget from the closed console vocabulary (mirrors backend
   *  `PluginConfigControl`). Omitted = the type's default control. */
  control?: 'text' | 'textarea' | 'model' | 'models' | 'segmented' | 'apiKey';
  /** Id of the plugin's `configSections` entry this field belongs to; omitted =
   *  the leading ungrouped block. */
  section?: string;
  /** Display-only predicate: render this field only while the referenced field
   *  holds one of the listed values (exactly one of `equals` / `in`). Hidden
   *  fields keep their draft value, so a mode toggle never discards input. */
  visibleWhen?: { key: string; equals?: string | boolean; in?: (string | boolean)[] };
  /** Locale map keyed by BCP-47 ('zh-CN'), like the manifest description. */
  title?: string | Record<string, string>;
  desc?: string | Record<string, string>;
}

/** One declared group of plugin settings (mirrors backend
 *  `PluginConfigSection`). Fields reference it by id; the heading lives here so
 *  it is declared exactly once. `advanced` starts the group collapsed. */
export interface PluginConfigSectionInfo {
  id: string;
  title?: string | Record<string, string>;
  advanced?: boolean;
}

// ---------------------------------------------------------------------------
// Provider management (defs file `providers` map + bound credential store)
// ---------------------------------------------------------------------------

export interface NpmVocabularyEntry {
  /** The v1 alias users type (`@ai-sdk/<x>`). */
  alias: string;
  /** The opencode v2 `package` shape stored in the defs file (ADR-0010). */
  package: string;
  /** Resolved wire — informational; authoritative in the backend's wireFor(). */
  wire: string;
  /** UI dropdown order (ascending). */
  order: number;
}
/** Process-lifetime cache — the vocabulary is boot-scoped backend data. */
let npmVocabularyCache: NpmVocabularyEntry[] | null = null;

export interface OpenCodeProviderView {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  /** Def-level custom headers (options.headers) — edit-dialog prefill; never secrets. */
  headers?: Record<string, string>;
  models: string[];
  /** DYNAMIC custom tag — derived from builtin-catalog coverage at aggregation time, never stored. */
  custom: boolean;
  /** Explicit node in providers.json — the delete-confirm branch signal; narrower than `custom` (catalog absence also sets custom). */
  defNode: boolean;
  /** Per-provider auto-pull whitelist glob (catalog.autoPullPatterns) — edit-dialog prefill. */
  autoPullPattern?: string;
  logo?: string;
  priceFrom?: number;
  modelsCount?: number;
  /** Owning plugin id when the def was registered by a plugin preset —
   *  provenance for the Connected-tab origin filter (backend ledger join). */
  pluginOrigin?: string;
  /** Operator takedown (GLOBAL disabled-providers ledger): the card stays
   *  listed, but the provider contributes nothing to the routing pool. */
  disabled?: boolean;
  /** Operator note attached at takedown time — display only. */
  disabledReason?: string;
  auth: {
    connected: boolean;
    type?: 'api' | 'oauth' | 'wellknown';
    keyMasked?: string;
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
  /** Plugin wire declares a console web-authorization (device login) — the
   *  connect card offers it through the auth-method picker. */
  webLogin?: boolean;
  /** The plugin's web-login also accepts a manually pasted token (off-box
   *  authorization) — the dialog shows the paste box. */
  webLoginSubmit?: boolean;
  /** Plugin-declared credential methods in display order; the FIRST entry is
   *  the dialog's default selection. Absent = legacy behavior (key first,
   *  web tab after it when webLogin is set). Mirrors backend PluginAuthType. */
  authTypes?: PluginAuthType[];
  /** Plugin-provided how-to hint (already localized server-side) rendered
   *  above the key form in the add-credential dialog — "where to get this
   *  key" guidance or fallback-tab explanation. Mirrors the preset keyHint. */
  keyHint?: string;
  /** Owning plugin id when the def was registered by a plugin preset —
   *  provenance for the catalog tag/filter (backend ledger join). */
  pluginOrigin?: string;
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
  /** hidden from client-facing catalogs (overrides.json `disabled` / def-level flag) —
   *  kept in the aggregate, excluded from the routing pool at boot */
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

export interface ProviderDefPayload {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyInline?: boolean;
  headers?: Record<string, string>;
  models?: Record<string, any>;
  options?: Record<string, any>;
  /** Auto-pull whitelist glob (catalog.autoPullPatterns) — blank/empty string clears the entry. */
  pullPattern?: string;
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
  kind?: 'openai' | 'anthropic' | 'google' | 'responses' | 'systemone' | 'unroutable';
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
  /** Provider-level rotation: candidates tried, in order (only when > 1). */
  triedModels?: string[];
  /** Credential rotation: masked rows tried, in order (only when > 1). */
  triedCredentials?: CredentialMeta[];
  /** Masked echo of the row that produced the verdict (addressed OR rotated). */
  credential?: CredentialMeta;
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
  /** true = a defs node maintains this physical model (the /models universe) */
  maintained: boolean;
  /** hidden from client-facing catalogs — kept on console pages, out of the pool */
  disabled?: boolean;
  /** provider-level operator takedown: listed (aggregate) but not routable */
  providerDisabled?: boolean;
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
  multiCredential: boolean;
  activate: boolean;
  /** Backend supports reordering credentials (POST …/credentials/reorder). */
  reorder: boolean;
  /** Backend supports per-credential spread weights (POST …/credentials/:id/weight). */
  weight: boolean;
  rename: boolean;
  oauth: boolean;
  envVisible: boolean;
  /** Sink addresses credentials by a registered upstream integration id. */
  integrationScoped: boolean;
}

/** Masked, management-safe credential metadata — never raw key material. */
export interface CredentialMeta {
  id: string;
  providerId: string;
  label?: string;
  type: 'api' | 'oauth' | 'wellknown' | 'unknown';
  active: boolean;
  routable: boolean;
  keyHashPrefix?: string;
  maskedKey?: string;
  /**
   * Spread weight for the deterministic new-session hash spread (integers >= 1,
   * absent = 1). OCR-file rows carry it; opencode v2 rows never do.
   */
  weight?: number;
}

export interface CredentialOverview {
  providerId: string;
  total: number;
  routable: number;
  activeCredentialId: string | null;
  /** Per-provider masked detail joined in by the B2 console handler. */
  credentials?: CredentialHealth[];
}

/**
 * The health overlay every console credential list carries
 * (GET credential-store + all three per-credential write routes answer the same
 * shape, mirrors backend `CredentialHealth` in console.ts). Additive keys only:
 * masked `CredentialMeta` fields ride through untouched.
 */
export type CredentialHealth = CredentialMeta & {
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
  /** Outbound rate-limit rules armed for THIS credential (config `credentials:` overlay). */
  limits?: RateLimitRule[];
  /**
   * Quota tracking overlay — present ONLY when the credential's
   * provider is COVERED (built-in table / code adapter / config entry).
   * Absence means "not covered", deliberately distinct from the `unverified`
   * badge ("covered, nothing probed yet"). Mirrors backend `CredentialQuotaView`.
   */
  quota?: CredentialQuotaView;
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

/** Why the last probe attempt produced nothing — mirrors backend
 *  `QuotaProbeFailure`. Display-safe: reason + HTTP status + the upstream's own
 *  short message (never headers, never key material). */
export interface QuotaProbeFailure {
  reason: 'network' | 'status' | 'shape' | 'auth';
  statusCode?: number;
  message?: string;
  at: number;
}

/** Per-credential quota view riding the CredentialHealth overlay — mirrors backend
 *  `CredentialQuotaView`. Display-only: nothing here gates routing. */
export interface CredentialQuotaView {
  badge: QuotaBadgeState;
  source?: QuotaSource;
  plan?: string;
  windows: QuotaWindow[];
  verifiedAt?: number;
  lastFailureAt?: number;
  /** Recorded verdict of the last failed attempt (present even when the pair
   *  never produced a snapshot — that is the point). */
  lastFailure?: QuotaProbeFailure;
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
  /** Operator-set credential name; absent = unnamed (render the masked key —
   *  the store id is never a display name). */
  label?: string;
  /** `maskSecret()` output — the readable identity when no label is set. */
  maskedKey?: string;
  covered: boolean;
  quota?: CredentialQuotaView;
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

/** GET /api/admin/quota response — mirrors backend `CredentialQuotaView` family. */
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
 * `apikey:<id>` or `credential:<provider>:<keyHashPrefix>`.
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
  /** Remaining ms of the subject's upstream-429 shaping cooldown (0 = none). Mirrors backend optional field. */
  cooldownMs?: number;
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
 * One failed upstream MODEL CALL — mirrors backend `FailureEvent`
 * (GET /api/admin/failure-events). `role` splits serving-pool attempts from
 * decision wire calls; `keyHashPrefix` names the credential that served the
 * failed call (the pair axis — absent = no attributable credential). Repeats
 * of the same model+provider+credential+errorClass+role fold into one entry
 * (`count`, `lastTs`) within the 10s coalescing window.
 */
export type FailureEventRole = 'serving' | 'l2-decision' | 'probe';

/** Mirrors backend `FailureErrorClass`: the breaker classifier's category
 *  vocabulary plus TIMEOUT (decision deadline — no HTTP status to classify). */
export type FailureErrorClass =
  | 'QUOTA_EXHAUSTED'
  | 'AUTHENTICATION_ERROR'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'CLIENT_ERROR'
  | 'MANUAL'
  | 'UNKNOWN'
  | 'TIMEOUT';

export interface FailureEvent {
  /** Stable row key (the durable mirror's UPSERT target) — display ignores it. */
  id: string;
  ts: number;
  lastTs: number;
  count: number;
  model: string;
  provider: string;
  /** Display-safe credential prefix, ADR-0006 key-hash identity. */
  keyHashPrefix?: string;
  errorClass: FailureErrorClass;
  status?: number;
  message: string;
  role: FailureEventRole;
  sessionId?: string;
}

/**
 * ReasonCodes of every credential-store write surface (console.ts
 * `capabilityRefusalBody` / `credentialNotFoundBody` / `mapStoreWriteFailure`,
 * shared by the per-credential routes and the provider connect/key/create ones).
 * `schema_mismatch` is deliberately absent: it exists only as a backend
 * StoreUnreadableError *reason*, and reaches the wire as `store_unreadable`.
 */
export type CredentialWriteReasonCode =
  | 'credential_not_found'
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
 * `credentialReveal`). The route ALSO surfaces the write table's codes through the
 * shared failure mapper (credential_not_found / capability_unsupported /
 * store_unreadable) — these three are its own pre-login vocabulary.
 */
export type CredentialRevealReasonCode = 'webauth_required' | 'invalid_password' | 'too_many_attempts';

/** 200 reply of activate / rename — `credentials` is the refreshed store truth. */
export interface CredentialWriteResponse {
  status: string;
  success: boolean;
  credential: CredentialHealth;
  credentials: CredentialHealth[];
}

/** 200 reply of disconnect (Decision 8: the credential itself is gone). */
export interface CredentialDisconnectResponse {
  status: string;
  success: boolean;
  disconnected: string;
  /** The deleted key material is anchored as a takedown: a pull-back lands parked, not routable. */
  takedownAnchored?: boolean;
  /** Client half of the revocation (`null` when disabled / no key material). */
  clientRevoke?: { clientId: string; result: string; detail?: string } | null;
  credentials: CredentialHealth[];
}

/** POST /api/admin/health/suspect-credentials/clear — `cleared:false` = nothing to lift. */
export interface SuspectCredentialClearResponse {
  status: string;
  provider: string;
  credential: string;
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
  credentialCount: number;
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
  credentials: CredentialOverview[];
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

/** Precondition codes of the sync paths — mirrors backend SyncPrecondition. */
export type SyncPreconditionCode = 'client_absent' | 'client_unreadable' | 'service_unreachable';

/** One per-entry record of a sync run (masked metadata only — never key material). */
export interface CredentialSyncEntry {
  provider: string;
  action: 'pulled' | 'deduped' | 'failed' | 'pushed' | 'skipped';
  reason?: string;
}

/** One sync run outcome as recorded in credential-sync.json. */
export interface CredentialSyncOutcome {
  ok: boolean;
  precondition?: SyncPreconditionCode;
  pulled?: number;
  pushed?: number;
  deduped?: number;
  /** write runs only — provider nodes rendered into the client's providers slot. */
  defsMaterialized?: number;
  /** write runs only — the client slot was actually rewritten (not merely re-rendered). */
  defsChanged?: boolean;
  /** write runs only — a CHANGED render was followed by a service reload that landed. */
  defsReloaded?: boolean;
  /** write runs only — defs left out of the config because the client defines them itself. */
  defsSkippedBuiltIn?: string[];
  /** read runs only — provider defs imported from the client config (add-only). */
  defsImported?: number;
  /** read runs only — of `defsImported`, nodes migrated from a retired shape. */
  defsConverted?: number;
  /** read runs only — client nodes already owned by the OCR defs file. */
  defsSkipped?: number;
  /** read runs only — client nodes the importer refused (surfaced in `entries`). */
  defsFailed?: number;
  entries: CredentialSyncEntry[];
  detail?: string;
}

/** One client row of the credential-sync table (GET /credential-sync). */
export interface CredentialSyncClientView {
  id: string;
  label: string;
  /** The client is this machine's active flavor: v2 = its db exists; v1 = v1 evidence (auth.json or a v1 version pin) and no v2 evidence. */
  present: boolean;
  /** The write path is usable (service endpoint discoverable / local file merge). */
  writeReady: boolean;
  /**
   * v2 only: the client's materialized `providers` slot differs from the defs
   * book (a push would change it). `undefined` = no defs book / unreadable
   * client config, i.e. nothing to compare.
   */
  defsDrift?: boolean;
  autoRead: boolean;
  autoWrite: boolean;
  lastReadAt?: number;
  lastWriteAt?: number;
  lastRead?: CredentialSyncOutcome;
  lastWrite?: CredentialSyncOutcome;
}

export interface CredentialSyncStatusResponse {
  status: string;
  clients: CredentialSyncClientView[];
}

export interface CredentialSyncRunResponse {
  status: string;
  direction: string;
  read?: CredentialSyncOutcome;
  write?: CredentialSyncOutcome;
}

/** One per-credential purge failure in the honest DELETE reply. */
export interface ProviderPurgeFailure {
  credentialId: string;
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
/** Controller-backed mihomo calls answer 409 `not-running` while the core is
 * down; keep that code so the console can localize it instead of showing the
 * transport English. */
function mihomoError(body: any, httpStatus: number): OcApiError {
  return new OcApiError(
    body?.message || `HTTP ${httpStatus}`,
    typeof body?.code === 'string' ? body.code : undefined,
    body
  );
}

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

/** Per-credential write path (rename / disconnect share it). */
function credentialPath(providerId: string, credentialId: string): string {
  return `/api/admin/opencode/providers/${encodeURIComponent(providerId)}/credentials/${encodeURIComponent(credentialId)}`;
}

/** Provider-level operator takedown response (disable/enable routes). */
export interface ProviderTakedownResponse {
  status: string;
  success: boolean;
  disabled: boolean;
  provider: string;
  message?: string;
}

export const opencodeApi = {
  async listProviders(): Promise<{
    status: string;
    configPath: string;
    providers: OpenCodeProviderView[];
  }> {
    return ocJson(await fetch(`/api/admin/opencode/providers?lang=${encodeURIComponent(api.commentLang())}`));
  },

  /**
   * Take a whole provider out of routing / put it back. State lives in the
   * GLOBAL takedown ledger (not providers.json); the backend resyncs the pool
   * in the same request, so `/v1/models` follows immediately.
   */
  async disableProvider(providerId: string, reason?: string): Promise<ProviderTakedownResponse> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(providerId)}/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      })
    );
  },

  /** Lift the takedown (the only path that does). */
  async enableProvider(providerId: string): Promise<ProviderTakedownResponse> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(providerId)}/enable`, { method: 'POST' })
    );
  },

  /** One entry of the backend-owned npm SDK vocabulary (providers/vocabulary.ts). */
  async getNpmVocabulary(): Promise<NpmVocabularyEntry[]> {
    if (npmVocabularyCache) return npmVocabularyCache;
    const res = await ocJson<{ status: string; entries: NpmVocabularyEntry[] }>(
      await fetch('/api/admin/opencode/npm-vocabulary')
    );
    npmVocabularyCache = res.entries;
    return res.entries;
  },

  /** Bound credential-store status (kind, capabilities, exclusions, masked credentials). */
  async getCredentialStore(): Promise<CredentialStoreStatusResponse> {
    return ocJson(await fetch('/api/admin/credential-store'));
  },

  /** Credential-sync table: per-client toggles, availability, last outcomes. */
  async getCredentialSync(): Promise<CredentialSyncStatusResponse> {
    return ocJson(await fetch('/api/admin/credential-sync'));
  },

  /** Flip one auto-sync direction of one client. */
  async toggleCredentialSync(
    clientId: string,
    direction: 'read' | 'write',
    enabled: boolean
  ): Promise<{ status: string; client: CredentialSyncClientView }> {
    return ocJson(
      await fetch('/api/admin/credential-sync/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, direction, enabled }),
      })
    );
  },

  /** Manual sync run (read / write / both) for one client. */
  async runCredentialSync(
    clientId: string,
    direction: 'read' | 'write' | 'both'
  ): Promise<CredentialSyncRunResponse> {
    return ocJson(
      await fetch('/api/admin/credential-sync/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, direction }),
      })
    );
  },

  /**
   * Pin one credential to the head of its provider's chain by posting the full
   * permutation of credential ids (head = ids[0]). Same wire response shape
   * as the other credential writes.
   */
  async reorderProviderCredentials(providerId: string, ids: string[]): Promise<CredentialWriteResponse> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(providerId)}/credentials/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
    );
  },

  /**
   * Set one credential's spread weight (integer 1..CREDENTIAL_WEIGHT_MAX; the
   * backend 400s anything else). OCR-file rows only — a v2-bound store refuses
   * with capability_unsupported. Same wire response shape as the other writes.
   */
  async setProviderCredentialWeight(
    providerId: string,
    credentialId: string,
    weight: number
  ): Promise<CredentialWriteResponse> {
    return ocJson(
      await fetch(credentialPath(providerId, credentialId) + '/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weight }),
      })
    );
  },

  /**
   * Take one credential out of routing / put it back. The flag lives in OCR's own
   * credential state, so unlike the store writes these work on a read-only binding
   * too. `reason` is an operator note (max 200 chars), display only.
   */
  async disableProviderCredential(
    providerId: string,
    credentialId: string,
    reason?: string
  ): Promise<CredentialWriteResponse> {
    return ocJson(
      await fetch(credentialPath(providerId, credentialId) + '/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      })
    );
  },

  /** Lift the takedown (the only path that does — cooldown never will). */
  async enableProviderCredential(providerId: string, credentialId: string): Promise<CredentialWriteResponse> {
    return ocJson(await fetch(credentialPath(providerId, credentialId) + '/enable', { method: 'POST' }));
  },

  /** Set an credential's user-editable label (backend trims, max 80). */
  async renameProviderCredential(
    providerId: string,
    credentialId: string,
    label: string
  ): Promise<CredentialWriteResponse> {
    return ocJson(
      await fetch(credentialPath(providerId, credentialId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
    );
  },

  /**
   * Disconnect one credential: the store holds the
   * only copy of the key, so the caller must have run the double confirmation
   * (see KeysPage's Decision 8 arbiter) before calling this.
   */
  async disconnectProviderCredential(
    providerId: string,
    credentialId: string,
    opts: { clientRevoke?: boolean } = {}
  ): Promise<CredentialDisconnectResponse> {
    const qs = opts.clientRevoke === false ? '?clientRevoke=0' : '';
    return ocJson(await fetch(credentialPath(providerId, credentialId) + qs, { method: 'DELETE' }));
  },

  /**
   * Controlled reveal: re-enter the console LOGIN
   * password to export one raw api key. The returned `key` must pass straight
   * from this call's scope into the clipboard — never into component state,
   * the DOM, or any persisted surface.
   */
  async revealProviderKey(
    providerId: string,
    credentialId: string,
    password: string
  ): Promise<{ status: string; key: string }> {
    return ocJson(
      await fetch(credentialPath(providerId, credentialId) + '/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
    );
  },

  async listPlugins(): Promise<{ status: string; plugins: PluginViewInfo[] }> {
    return ocJson(await fetch('/api/admin/plugins'));
  },

  /** URL of an installed plugin's package: packaged zips are returned
   *  verbatim, dev-tree plugins are zipped on the fly by the backend. */
  pluginPackageUrl(id: string): string {
    return `/api/admin/plugins/${encodeURIComponent(id)}/package`;
  },

  async uninstallPlugin(id: string): Promise<{ status: string; removed: string[]; providersRemoved?: string[]; devOnly?: boolean; plugins: PluginViewInfo[] }> {
    const res = await fetch(`/api/admin/plugins/${encodeURIComponent(id)}/uninstall`, { method: 'DELETE' });
    const parsed = (await res.json()) as { status: string; error?: string; removed: string[]; plugins: PluginViewInfo[] };
    if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
    return parsed;
  },

  async setPluginDisabled(id: string, disabled: boolean): Promise<{ status: string; plugins: PluginViewInfo[] }> {
    const res = await fetch(`/api/admin/plugins/${encodeURIComponent(id)}/${disabled ? 'disable' : 'enable'}`, { method: 'POST' });
    const parsed = (await res.json()) as { status: string; error?: string; plugins: PluginViewInfo[] };
    if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
    return parsed;
  },

  async installPlugin(bytes: ArrayBuffer): Promise<{ status: string; id: string; plugins: PluginViewInfo[] }> {
    const res = await fetch(`/api/admin/plugins/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    const text = await res.text();
    // An empty body (proxy cut, server abort) must not surface as a cryptic
    // "Unexpected end of JSON input" — report the HTTP status instead.
    const parsed = (text ? JSON.parse(text) : {}) as { status: string; id?: string; error?: string; plugins: PluginViewInfo[] };
    if (!res.ok || parsed.status !== 'ok') throw new Error(parsed.error ?? `HTTP ${res.status}${text ? '' : ' (empty response)'}`);
    return { ...parsed, id: parsed.id ?? '' };
  },

  async reloadPlugins(): Promise<{ status: string; plugins: PluginViewInfo[] }> {
    return ocJson(
      await fetch('/api/admin/plugins/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    );
  },

  /** Schema + current values (defaults already merged) for a plugin's settings drawer. */
  async getPluginConfig(id: string): Promise<{ status: string; schema: PluginConfigFieldInfo[]; sections?: PluginConfigSectionInfo[]; values: Record<string, unknown> }> {
    const res = await fetch(`/api/admin/plugins/${encodeURIComponent(id)}/config`);
    const parsed = (await res.json()) as {
      status: string;
      error?: string;
      schema: PluginConfigFieldInfo[];
      sections?: PluginConfigSectionInfo[];
      values: Record<string, unknown>;
    };
    if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
    return parsed;
  },

  /** Persist the FULL values object; the backend validates and reports warnings. */
  async putPluginConfig(
    id: string,
    values: Record<string, unknown>
  ): Promise<{ status: string; values: Record<string, unknown>; warnings: string[] }> {
    const res = await fetch(`/api/admin/plugins/${encodeURIComponent(id)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    const parsed = (await res.json()) as { status: string; error?: string; values?: Record<string, unknown>; warnings?: string[] };
    if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
    return { status: parsed.status, values: parsed.values ?? values, warnings: parsed.warnings ?? [] };
  },

  async catalog(refresh = false): Promise<{ status: string; source: string; providers: OpenCodeCatalogProvider[] }> {
    // Plugin preset name lookup uses the UI Lang short code — the backend maps
    // it to the manifest's BCP-47 locale keys (host.ts LANG_TO_BCP47 mirror).
    const lang = (typeof localStorage !== 'undefined' && localStorage.getItem('ocr_lang')) || 'zh';
    return ocJson(await fetch(`/api/admin/opencode/catalog?lang=${encodeURIComponent(lang)}${refresh ? '&refresh=1' : ''}`));
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

  async listModels(params?: { provider?: string; connected?: boolean; maintained?: boolean }): Promise<{
    status: string;
    source: string;
    total: number;
    models: OpenCodeModelView[];
  }> {
    const qs = new URLSearchParams();
    if (params?.provider) qs.set('provider', params.provider);
    if (params?.connected) qs.set('connected', '1');
    if (params?.maintained) qs.set('maintained', '1');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return ocJson(await fetch(`/api/admin/opencode/models${suffix}`));
  },

  async createProvider(payload: ProviderDefPayload): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch('/api/admin/opencode/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  async updateProvider(id: string, payload: Partial<ProviderDefPayload>): Promise<{ status: string; success: boolean }> {
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
   * held this exact key for the provider, so NO second credential was created
   * (idempotent success — `credential` names the row that survived).
   * `headPreserved` = the sink auto-activated the new key and this surface handed
   * the default credential back to the credential that was serving (opencode's `active`
   * is ALSO the key its own CLI uses, so adding an credential must not repoint it).
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
    credential?: CredentialMeta;
    headPreserved?: CredentialMeta;
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

  /** Begin a plugin web-login session; returns the vendor authorize URL for
   *  the browser (device flow — plugin-owned protocol). */
  async webLoginStart(providerId: string): Promise<{ authUrl: string }> {
    const res = await fetch(`/api/admin/opencode/providers/${encodeURIComponent(providerId)}/web-login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const json = (await res.json().catch(() => ({}))) as { authUrl?: string; error?: string };
    if (!res.ok || !json.authUrl) throw new Error(json.error ?? `web-login start failed (${res.status})`);
    return { authUrl: json.authUrl };
  },

  /** Poll the in-flight web-login once. done = finished; the backend has
   *  already wired the token into the credential store. */
  async webLoginPoll(providerId: string): Promise<{ done: boolean; connected?: boolean; error?: string }> {
    const res = await fetch(`/api/admin/opencode/providers/${encodeURIComponent(providerId)}/web-login/poll`, {
      headers: { Accept: 'application/json' },
    });
    const json = (await res.json().catch(() => ({}))) as { done?: boolean; connected?: boolean; error?: string };
    if (!res.ok) throw new Error(json.error ?? `web-login poll failed (${res.status})`);
    return { done: Boolean(json.done), connected: json.connected, error: json.error };
  },

  /** Manually complete a web login: the operator pastes a token/code obtained
   *  off-box. connected=false carries the plugin's rejection reason. */
  async webLoginSubmit(providerId: string, code: string): Promise<{ connected: boolean; error?: string }> {
    const res = await fetch(`/api/admin/opencode/providers/${encodeURIComponent(providerId)}/web-login/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const json = (await res.json().catch(() => ({}))) as { connected?: boolean; error?: string };
    if (!res.ok) throw new Error(json.error ?? `web-login submit failed (${res.status})`);
    return { connected: Boolean(json.connected), error: json.error };
  },
  async testProvider(
    id: string,
    payload?: { modelId?: string; apiKey?: string; baseURL?: string; credentialId?: string }
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
   * PurgeAuth=1 deletes the config node AND loops per-credential disconnects
   * through the bound store; the reply carries the honest `purge` detail.
   */
  async deleteProvider(
    id: string,
    purgeAuth = false
  ): Promise<{ status: string; success: boolean; message?: string; purge?: ProviderPurgeResult; defRemoved?: boolean }> {
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

  /** Persist the provider's model order. The defs file is the order truth, so
   *  this is a real write (the client defs push follows). */
  async reorderProviderModels(
    id: string,
    ids: string[]
  ): Promise<{ status: string; success: boolean; order: string[]; changed: boolean }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
    );
  },

  async pullProviderModels(
    id: string,
    opts: { pattern?: string; ids?: string[]; dryRun?: boolean; live?: boolean } = {}
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
