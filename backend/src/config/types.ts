import { EffortMap, ModelPricing, ReasoningEffort, TierLevel } from '../types/router.js';

import { CircuitBreakerConfig, RetryConfig } from '../resilience/types.js';

import type { QuotaProbeConfigEntry } from '../quota/types.js';

export interface ProviderConfig {
  name: string;
  type: 'openai-compatible' | 'anthropic' | 'google' | 'responses' | 'dispatch' | 'systemone';
  baseUrl: string;
  apiKey: string;
  organization?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ModelRegistration {
  id: string; // e.g., 'gpt-4o-mini', 'claude-3-5-haiku-20241022', 'deepseek-chat'
  provider: string; // matches ProviderConfig.name
  upstreamModel: string; // actual model name sent to upstream
  tier: TierLevel;
  pricing: ModelPricing;
  /** resolved wire for direct execution (model-level npm beats provider npm). */
  wire?: 'openai' | 'anthropic' | 'google' | 'responses';
  priority?: number; // lower number = higher priority within the tier (e.g. 1 is primary, 2 is backup)
  isDefaultInTier?: boolean;
  /**
   * Subset of `ReasoningEffort` this model can natively serve. Empty / missing
   * means "model-default only". Used by the routing layer to filter + downgrade
   * the candidate pool when the client requests a specific effort level.
   * Default for thinking-capable models is the full EFFORT_LADDER.
   */
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  /** Legacy boolean; if true and `supportedReasoningEfforts` is unset, the model
   *  is treated as supporting the FULL `EFFORT_LADDER` (all 6 levels, `none`
   *  included) — see `modelSupportsEfforts` in types/router.ts. */
  supportsReasoningEffort?: boolean;
  supportsPromptCaching?: boolean;
  /**
   * Tri-state sampling-parameter capability flag (from the models.dev catalog).
   * false = the upstream explicitly rejects `temperature` (e.g. next-gen Claude
   * answers "`temperature` is deprecated for this model"), so the provider layer
   * strips it; true / undefined = pass through unchanged (undefined also covers
   * hand-registered models with no catalog data).
   */
  temperature?: boolean;
  /**
   * Model-default thinking level — pinned when the client OMITS
   * `reasoning_effort` entirely (explicit values, 'none' included, always
   * win). Sourced from overrides.json / def `settings.reasoningEffort`.
   */
  defaultEffort?: ReasoningEffort;
  /**
   * Named model variants, materialized by the boot-direct pool from
   * opencode.jsonc model defs (effort-bearing entries only — see
   * boot-direct.ts `routableVariants`). Each variant is routable as a
   * sibling id `<id>-<variant>` and via `<id>#<variant>` syntax; the
   * variant's reasoning effort is pinned onto the request.
   */
  variants?: ModelVariant[];
  /**
   * Inputs captured by the smart-match boot paths (boot-direct / sync).
   * Presence marks the model as RUNTIME-RECLASSIFIABLE: the registry replays
   * tiers[t].match + catalog overrides against these inputs without a restart.
   * Hand-configured models omit it and keep their explicit tier forever.
   */
  tierMatch?: { rawInputPerM?: number; reasoningFlag: boolean };
  /** Explicit tier from the opencode.jsonc model definition (catalog overrides are read live) */
  configTier?: TierLevel;
  /**
   * Fourth state: the model matched no tier's positive conditions
   * (no residual fallback any more). It joins NO candidate pool. Kept as a
   * flag rather than widening `tier` so TIER_RANK / failover chains / session
   * ratchet keep operating on the strict four-state TierLevel.
   */
  unclassified?: boolean;
  /**
   * The effective thinking-level translation inherited from the
   * claiming member rule (re-applied on every reclassify). Undefined = no
   * translation (passthrough).
   */
  effortMap?: EffortMap;
}

/**
 * Effort-bearing variant of a model. Serving a variant == serving the base
 * model with its pinned reasoning effort injected, so only variants carrying
 * an effort are materialized; anything else has nothing routable to add.
 */
export interface ModelVariant {
  id: string;
  /** Always a valid EFFORT_LADDER level (validated at ingestion). */
  reasoningEffort: ReasoningEffort;
}

/**
 * Combo member entry — bare string (config order = failover chain order,
 * weight 1) or an object carrying an explicit weight for the weighted /
 * round_robin selection strategies.
 */
export interface ComboModelRef {
  id: string;
  weight?: number; // >= 1, default 1
}

/**
 * Custom model combo (user-composed virtual model): the client sends the
 * combo id as `model` and the gateway executes against the member list.
 * Routing/breaker semantics stay per member; `selection` only decides who
 * leads the pool (priority = config order / weighted = weight-random /
 * round_robin = rotating weighted slots) — failover always walks config
 * order. No cross-tier escalation: the user's composition is authoritative.
 */
export interface ComboConfig {
  id: string; // client-visible virtual model name, e.g. 'my-combo'
  selection?: 'priority' | 'weighted' | 'round_robin'; // default 'priority'
  models: (string | ComboModelRef)[]; // ordered: first = preferred leader
  note?: string; // free-form remark, console-display only (never routed)
}

/**
 * Model Profile — a named slot table (slot → modelRef) used to mass-assign
 * models to a hooked client's agents (agents AND subagents) in one apply.
 * The profile itself is client-agnostic — a client adapter decides whether and
 * how to consume it (OpenCode writes `agent.<name>.model`).
 * A profile is NEVER a routing target: the gateway never resolves a profile id
 * at request time. It is consumed when a client hook applies — the resolved
 * modelRef is written into the client's own config. `modelRef` is a
 * gateway-visible id: registered model, combo id, or an auto virtual id
 * ('auto' | 'auto-lite' | 'auto-plus' | 'auto-pro' | 'auto-ultra').
 * Slot keys are free-form per profile (role names like 'flash' / 'pro' /
 * 'max' / 'vision'); an agent bound to a slot the selected profile does not
 * define stays unbound.
 */
export interface ModelProfileConfig {
  id: string; // unique profile id
  name?: string; // display name
  /** slot key → modelRef (model id | combo id | auto*) */
  slots: Record<string, string>;
  note?: string; // free-form remark, console-display only
}

export interface FallbackConfig {
  enabled: boolean;
  maxRetries: number;
  escalateTier: 'plus' | 'pro' | 'ultra';
  injectErrorContext: boolean;
}

/**
 * Per-tier composition policy. Pool membership has exactly ONE basis: the
 * explicit `members` list below — a model matching no rule ends up
 * `unclassified` and joins no pool. List order IS the chain/priority order;
 * selection strategy and per-rule weights shape HOW the pool is used,
 * never WHO is in it.
 */

/**
 * Tier member rule — the ONLY source of pool membership (routing).
 * `pattern` is a glob over the FULL model id (`provider/model`): `*`/`?`
 * wildcards, case-insensitive; NO wildcard = substring match (a full id
 * therefore pins a single model). The list order IS priority: within a tier
 * the first matching rule claims the model, and the first rule's models lead
 * the tier's failover chain. Across tiers the claim order is
 * lite → plus → pro → ultra (first claim wins; overlaps are warned at save).
 */
export interface TierMemberRule {
  pattern: string;
  /** >= 1, default 1 — reserved for weighted / round_robin selection (v1 UI does not expose). */
  weight?: number;
  /**
   * Inline thinking-level translation (client-requested → upstream
   * value), e.g. `{ none: 'high', low: 'high' }`. Missing key = passthrough.
   * Applied per candidate at selection AND at execution; capability clamps
   * afterwards (downgradeReasoning) keep the honesty contract.
   */
  effortMap?: EffortMap;
}

export interface TierPolicy {
  /** explicit member list — routing's ONLY pool-membership source. */
  members?: TierMemberRule[];
  selection?: 'priority' | 'weighted' | 'round_robin'; // primary-pick strategy (see ProviderRegistry.pickPrimary)
  /**
   * @deprecated never consulted by routing or boot seeding. The classifier
   * survives as the suggestion engine (catalog suggestions, /tiers
   * preview / save-time checks) and still reads this config.
   */
  match?: {
    patterns?: string[]; // wildcard patterns over model id (all tiers claim)
    minInputPerM?: number; // price-band floor — configured for EVERY tier incl. plus
    maxInputPerM?: number; // price-band ceiling; a band with no ceiling is a WEAK condition (consulted last)
    exclude?: string[]; // vetoes this tier's auto-claim (explicit pins bypass it)
    /**
     * Anchor-exclude: a model matching ANY condition (patterns / price
     * band / thinking-effort flag) of one of these tiers may not be AUTO-claimed by
     * THIS tier. Runtime filter derived from the other tiers' own conditions.
     */
    excludeTiers?: TierLevel[];
  };
}

export interface TiersConfig {
  /**
   * GLOBAL denylist (sibling of the tiers; edited on the raw-YAML page). A
   * model matching any pattern joins NO candidate pool — unconditionally, i.e.
   * even an explicit catalog/jsonc pin cannot rescue it. Invisible to tier
   * routing, primary pick and failover; direct calls by model id / combos
   * still work. The /tiers page round-trips this field untouched on save (the
   * backend merges `tiers` by whole-object replacement).
   */
  exclude?: string[];
  lite?: TierPolicy;
  plus?: TierPolicy;
  pro?: TierPolicy;
  ultra?: TierPolicy;
}

export type RoutingMode = 'smart' | 'cost' | 'quality';

export interface RoutingConfig {
  mode: RoutingMode; // smart = Layer1/Layer2 cascade (default); cost = always lite; quality = always pro
}

export interface OpenCodeConfig {
  url?: string;
  password?: string;
}

/**
 * Outbound proxy for upstream calls (model providers, Layer2 judge, catalog sync).
 * Resolution order: loopback targets are NEVER proxied → excludes (force direct)
 * → includes (non-empty: ONLY matches go through proxy) → proxy.url → direct.
 *
 * Patterns are wildcard globs matched against the composite `provider/modelId`
 * AND the bare model id, so both levels work:
 *   - `anthropic/*`       → provider level (all models of a provider)
 *   - `x/claude-*` (x=* ) → model level within any provider (leading star-slash)
 *   - `claude-*` / `claude` → bare model-id match (wildcard / substring)
 * If both lists are set, excludes are evaluated first (matched = force direct),
 * then includes gate what remains.
 * With no explicit proxy resolved, Bun still honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY.
 */
export interface ProxyConfig {
  enabled?: boolean; // master switch; default false (opt-in) — proxying only when explicitly true
  url?: string; // global proxy URL, http(s)://[user:pass@]host:port — embedded credentials are sent as Proxy-Authorization (verified on Bun, incl. CONNECT); empty = direct
  includes?: string[]; // non-empty: ONLY matching models/providers go through proxy
  excludes?: string[]; // matching models/providers force direct (evaluated before includes)
}

/**
 * Inbound forward proxy (the HTTP_PROXY / HTTPS_PROXY server).
 *
 * FULL-CAPTURE by design: every proxied TLS connection is MITM'd with a
 * locally generated CA; the decrypted request is inspected — LLM-protocol
 * traffic enters the routing pipeline, anything else is forwarded
 * transparently. Only loopback targets and `bypassHosts` matches are
 * blind-tunneled (never decrypted). No `mode` switch: full capture IS the
 * single behavior. The generated CA must be trusted by the clients that use
 * this proxy (`<caDir>/ca.pem`).
 */
export interface ForwardProxyConfig {
  enabled?: boolean; // master switch; default false (opt-in — full-capture MITM must be enabled consciously)
  port?: number; // listen port; default 4555
  host?: string; // listen address; default '127.0.0.1' (loopback-only)
  /**
   * Bypass list: bare glob strings = pure tunnel with DIRECT egress; object
   * entries `{ host, viaProxy }` choose the egress per host (viaProxy →
   * tunnel through the outbound proxy policy, e.g. clash). Loopback always
   * bypasses (direct).
   */
  bypassHosts?: (string | { host: string; viaProxy?: boolean })[];
  caDir?: string; // MITM CA dir; default ~/.opencode-router/forward-proxy
  /**
   * Route forward-proxy transit (bypass tunnels + non-intercepted forwards)
   * through the outbound proxy policy (`proxy:` — url/includes/excludes).
   * Default false = direct egress; recommended on when targets are
   * network-blocked and a local proxy (clash etc.) is configured.
   */
  viaOutboundProxy?: boolean;
}

export interface Layer1ClassifierConfig {
  enabled: boolean;
  modelPath?: string;
  confidenceThreshold?: number; // e.g., 0.85
}
export type LocalModelConfig = Layer1ClassifierConfig;

/**
 * Layer 2 judge configuration. The judge calls a REGISTERED model over the
 * gateway's own System One protocol — there is no vendor endpoint,
 * credential or wire format to configure: `provider`, `baseUrl` and `apiKey`
 * are gone. Point `model` at any registered id (a `type: 'systemone'` provider
 * for native passthrough, or any chat model for protocol conversion); when it
 * is omitted, `systemone.defaultModel` is used.
 */
export interface Layer2JudgeConfig {
  enabled: boolean;
  /** Registered model id, or 'auto' to fall back to `systemone.defaultModel`. */
  model?: string;
  timeoutMs?: number;
  decisionCache?: { // reuse prior judge decisions for identical contexts
    enabled?: boolean; // default true
    ttlSeconds?: number; // default 1800
    maxEntries?: number; // default 500
  };
  /**
   * L2 decision DATASET sampling — single-key gate: records judged decisions
   * (state + answer + tier) to data/layer2-decisions.jsonl for flywheel
   * distillation. Default OFF (state carries user conversation content);
   * hot-applied on config save — no restart; writes pause once the file
   * exceeds 64 MB. NOT to be confused with requestCapture.systemone.
   * l2DecisionEnabled, which captures the judge's HTTP leg instead.
   */
  collectEnabled?: boolean;
  // Retired keys `decisionCapture` (pre-collectEnabled) are stripped at load.
}
export type Layer2DecisionConfig = Layer2JudgeConfig;

export interface ClassifierConfig {
  layer1?: Layer1ClassifierConfig;
  localModel?: Layer1ClassifierConfig;
  layer2?: Layer2JudgeConfig;
}

export interface FlywheelConfig {
  enabled: boolean;
  datasetPath?: string; // default: './data/flywheel.jsonl'
  maxSamples?: number;
  logUserPrompt?: boolean;
  /**
   * Sample retention window in days (drop records older than N by `timestamp`).
   * 0/unset = never auto-delete. Sweep runs at boot + hourly; deletions write
   * NO backup. Restart-scoped (no hot applyConfig).
   */
  retentionDays?: number;
  /**
   * Dataset size cap in MB — after the age pass, trim oldest-first until the
   * file fits. 0/unset = uncapped; deletions write NO backup. The `MB`
   * suffix matches `requestCapture.maxTotalMB`. Restart-scoped.
   */
  maxFileSizeMB?: number;
}

export interface SessionConfig {
  enabled: boolean;
  strategy?: 'monotonic' | 'sticky' | 'stateless';
  ttlSeconds?: number; // default: 3600 (1 hour)
  maxSessions?: number; // default: 10000
}

/**
 * OpenAI Responses wire (POST /v1/responses) surface settings.
 */
export interface ResponsesSurfaceConfig {
  /**
   * Mirror the gateway-owned `previous_response_id` conversation tree to an
   * append-only JSONL recovery log.
   * Default FALSE — off means the in-memory-only posture holds
   * byte-for-byte (a restart breaks continuation, fail-visible 400 → the
   * client resends the full input). On: nodes are replayed at boot (24h TTL,
   * FIFO + byte budgets), file mode 0600, per-environment path. The log holds
   * raw conversation text — enabling is a conscious disk-privacy choice, same
   * content class as requestCapture. Disk failure NEVER fails a request.
   * Restart-scoped (no hot applyConfig).
   */
  persist?: boolean;
}

/**
 * Per-key model access policy. ABSENT = unrestricted (see & use every model —
 * the backward-compatible default for existing keys).
 * - mode 'allow' (whitelist): ONLY the listed model ids are visible/routable.
 * - mode 'deny'  (blacklist): every model EXCEPT the listed ids.
 * Ids are registry model ids (physical models). Virtual `auto*` ids and combo
 * ids are not listed directly — they are enforced at the execution choke point
 * (executeCandidatePool) against the physical models that would actually serve.
 */
export interface ModelAccessConfig {
  mode: 'allow' | 'deny';
  models: string[];
}

/**
 * One sliding-window rate-limit rule. `window` is a Go/Prometheus duration
 * string (`30s` / `5m` / `1h` / `1d`). At least one countable is set; more
 * than one is legal — each becomes an INDEPENDENT constraint sharing the
 * window (`{ window: 1m, requests: 10, tokens: 50000 }` = two constraints).
 * Deny = ANY constraint of the subject full. See ratelimit/rate-limiter.ts.
 */
export interface RateLimitRule {
  window: string;
  /** admitted requests per window */
  requests?: number;
  /** consumed tokens (prompt + completion) per window — recorded on completion */
  tokens?: number;
  /** USD budget per window (recorded on completion) */
  costUsd?: number;
}

/**
 * Governance overlay for ONE upstream credential (identity:
 * `keyHashPrefix`). The credential itself lives in the
 * CredentialStore; this entry only attaches outbound limit rules to it.
 */
export interface AccountLimitConfig {
  keyHashPrefix: string;
  limits: RateLimitRule[];
}

export interface ApiKeyConfig {
  id: string; // Unique identifier, e.g. 'key-xxxxxx'
  name: string; // Client / application name, e.g. 'Cursor IDE', 'NextChat'
  key: string; // The token string, e.g. 'sk-ocr-xxxxxx'
  enabled: boolean;
  createdAt: string;
  expiresAt?: string;
  description?: string;
  modelAccess?: ModelAccessConfig;
  /** Inbound sliding-window limits enforced at the auth gate (429 + Retry-After). */
  limits?: RateLimitRule[];
}

/**
 * Catalog source registry — remote sources are fully config-declared.
 * `type` maps to a normalizer registered in opencode/catalog/sources/registry.ts;
 * adding a new source of a KNOWN type is pure configuration (no code).
 * `priority`: lower number = higher precedence when merging (config=10, service=20;
 * remote sources should use >=30).
 */
export interface CatalogSourceConfig {
  id: string;
  type: 'provider-catalog' | 'model-list' | 'openai-compatible' | 'custom';
  url: string;
  enabled?: boolean;
  priority?: number;
  /**
   * Type: 'custom' ONLY — declarative field mapping from the source payload to
   * OCR standard fields (CatalogModel). Lets a NEW response shape be onboarded
   * with pure configuration, no normalizer code.
   */
  map?: SourceMapConfig;
}

/**
 * Declarative mapping for type: 'custom' sources. Field values are dotted paths
 * into each item (e.g. 'pricing.prompt'). `costScale` multiplies raw price
 * values into $/1M (1 = already $/1M; 1e-6 = $/token; 1e-3 = $/K).
 */
export interface SourceMapConfig {
  /** dotted path to the models array inside the response (default: root array) */
  items?: string;
  /** REQUIRED: dotted path to the model id */
  id: string;
  name?: string;
  /** → limit.context / limit.output */
  context?: string;
  output?: string;
  /** → cost.input / cost.output / cost.cache_read / cost.cache_write (× costScale) */
  inputCost?: string;
  outputCost?: string;
  cacheReadCost?: string;
  cacheWriteCost?: string;
  /** multiplier into $/1M (default 1 = already $/1M; 1e6 = source is $/token; 1e3 = $/K) */
  costScale?: number;
  toolCall?: string;
  reasoning?: string;
  modalitiesInput?: string;
  modalitiesOutput?: string;
}

export interface CatalogConfig {
  syncIntervalMs?: number;
  sources?: CatalogSourceConfig[];
  /**
   * Locally anchored model ids (bare model id, applies across providers): a
   * locked id that already has a local/opencode.jsonc definition keeps its
   * maintained values — INCLUDING explicit zero prices — no remote source may
   * overwrite them. Read live from config.yaml (hot, no restart needed).
   */
  lockedModels?: string[];
  /**
   * Auto-pull models for every opencode.jsonc provider on each sync period
   * (live /v1/models first, static catalog fallback). ADD-ONLY: existing
   * definitions are never overwritten. Default: true.
   */
  autoPullModels?: boolean;
}

/** The baseline catalog source is MANDATORY — console locks it against removal/disabling. */
export const BUILTIN_SOURCE_ID = 'opencode';

export const DEFAULT_CATALOG_SOURCES: CatalogSourceConfig[] = [
  // Baseline: the OpenCode built-in catalog (models.opencode.ai — same models.dev
  // schema, OpenCode's own domain) — lowest priority number, processed first, so
  // its non-blank values win and later sources only fill blanks. This source is
  // mandatory: it defines the model universe and can never be removed/disabled.
  { id: BUILTIN_SOURCE_ID, type: 'provider-catalog', url: 'https://models.opencode.ai/api.json', enabled: true, priority: 10 },
  // Extension sources fill missing fields only (never overwrite non-blank values).
  { id: 'openrouter', type: 'model-list', url: 'https://openrouter.ai/api/v1/models', enabled: true, priority: 30 },
  // Disabled by default: models.dev mirrors the opencode catalog (same schema) —
  // a spare baseline the user can enable from the console for cross-checking.
  { id: 'models-dev', type: 'provider-catalog', url: 'https://models.dev/api.json', enabled: false, priority: 20 },
];

/**
 * Token Saver compression (rtk tool-output compression + headroom context
 * compression + caveman output-style injection). Applied inside
 * PipelineOrchestrator after prompt normalization & session resolution.
 * All stages fail open; every engine has its own `enabled` flag.
 */
export interface CompressionConfig {
  rtk?: {
    enabled?: boolean; // compress tool-result text (git/grep/ls/tree/logs/build output); default false
  };
  headroom?: {
    enabled?: boolean; // whole-context compression via headroom sidecar POST /v1/compress; default false
    url?: string; // headroom proxy base URL, e.g. http://127.0.0.1:8787 (loopback-only by default)
    timeoutMs?: number; // default 3000; on timeout the original messages flow upstream unchanged
    compressUserMessages?: boolean; // also compress user-role text (ignored in session mode)
  };
  caveman?: {
    enabled?: boolean; // terse-style system-prompt injection to cut output tokens; default false
    level?: 'lite' | 'full' | 'ultra' | 'wenyan-lite' | 'wenyan' | 'wenyan-ultra'; // default 'full'
  };
}

/**
 * System One group inside the request-capture section — master/sub chain.
 * The whole group only matters under `requestCapture.enabled` (the privacy
 * master). `enabled` is the System One SURFACE MASTER (off silences BOTH
 * legs); `l2DecisionEnabled` is a SUB-switch beneath it (adds the judge-
 * internal decision-call leg only). Both default TRUE, so enabling the
 * capture master discloses the whole decision surface.
 */
export interface RequestCaptureSystemoneConfig {
  /** System One surface MASTER — off silences BOTH legs: client-leg capture
   *  of /v1/systemone decision traffic AND the judge-call sub-leg below.
   *  When on, client-leg capture records the request that arrives at the
   *  gateway + the gateway's answer. Default true. */
  enabled?: boolean;
  /** Judge-call capture SUB-switch (effective only when `enabled` is true):
   *  adds capture of the decision-model HTTP leg the Layer 2 judge fires
   *  INSIDE a routed chat turn, recorded as upstream-direction events
   *  (attached to the outer request's trace/session, purpose 'l2-judge').
   *  Default true. Subject-orthogonal to the client leg — it adds the
   *  judge's own wire call, never re-filters client traffic. This is NOT
   *  the dataset-sampling switch — that is the single-key
   *  `classifier.layer2.collectEnabled` (data/layer2-decisions.jsonl). */
  l2DecisionEnabled?: boolean;
}

/**
 * Request capture (full request/response body audit log). Every orchestrated
 * turn — successes AND failures — is appended as one JSONL line, archived by
 * local-date directory and session id:
 *   <dir>/<YYYY-MM-DD>/<sanitized-sessionId>.jsonl
 *
 * OFF by default (opt-in): captured bodies may contain sensitive data, and the
 * console /api/admin/* endpoints are auth-exempt — enable consciously.
 * Request header names are recorded; credential-shaped header VALUES are
 * redacted ([REDACTED]) by the exchange serializer.
 *
 * The requestCapture tree (audit-log capture config).
 */
export interface RequestCaptureConfig {
  enabled?: boolean; // master switch; default false
  dir?: string; // default: ~/.opencode-router/capture
  retentionDays?: number; // default 7; date dirs older than today-N are swept (at boot + hourly)
  maxTotalMB?: number; // default 512; oldest date dirs are deleted first when exceeded
  maxBodyBytes?: number; // default 65536 (64 KB); truncation budget applied to request and response separately
  systemone?: RequestCaptureSystemoneConfig;
}

export interface TracePersistConfig {
  enabled?: boolean; // default true
  dir?: string; // default: ~/.opencode-router/traces (traces.db)
  retentionDays?: number; // default 7; rows older than now-N are deleted (at boot + hourly)
  maxTotalMB?: number; // default 100; oldest rows deleted first when the db exceeds the budget
}

/**
 * Daemon-process log rotation (size-based). Only applies when the gateway is
 * started via `ocr start` — a manual `bun backend/src/index.ts` logs to its
 * own console and bypasses rotation entirely.
 * Rotation runs once per daemon start (not per write): if `ocr.log` exceeds
 * `maxSizeMB`, it is renamed to `ocr.log.1` (existing `.N` files shift up to
 * `.N+1`), and archives beyond `keepArchives` are deleted.
 */
export interface LoggingConfig {
  maxSizeMB?: number; // default 10
  keepArchives?: number; // default 7
}

/**
 * Console (web UI) login credentials. The password is stored ONLY as a
 * scrypt hash (`scrypt$<saltHex>$<hashHex>`), never in plaintext. When the
 * gateway binds a non-loopback host, `enabled: true` is MANDATORY — boot
 * refuses to start otherwise (see auth/web-auth.ts validateWebAuthStartup).
 */
export interface WebAuthConfig {
  enabled?: boolean; // default false; forced on for non-loopback binding
  username?: string;
  passwordHash?: string; // scrypt$<saltHex>$<hashHex>
}

/**
 * System One protocol surface (POST /v1/systemone). Native upstreams declare
 * `type: 'systemone'` in providers; every other registered model serves via
 * chat-model conversion. `defaultModel` backs requests that omit `model`
 * (or send 'auto') — never routed through the tier cascade.
 */
export interface SystemoneSurfaceConfig {
  defaultModel?: string;
}

/**
 * Console-only memory (per environment): the last profile id + agent→slot
 * mapping picked on the client-hook form. Never consulted by routing or by
 * the hook itself — restoring the UI selection across page reloads, gateway
 * restarts and teardown is its single job. Keyed by client name (reserved
 * for future clients' forms).
 */
export interface ClientProfileMemoryEntry {
  profile: string; // profile id ('' = none)
  bindings: Record<string, string>; // agent name → slot key
  /** Model-list source on the opencode form: 'none' (default) exposes no
   *  concrete models, 'follow' derives the extra-model set from the selected
   *  API key's effective access, 'custom' keeps the manual picker. UI-only —
   *  the hook still writes a static snapshot. */
  modelMode?: 'none' | 'custom' | 'follow';
}

/**
 * Rate-limit policy knobs (the caller-side policy of the engine —
 * ratelimit/rate-limiter.ts stays verdict-not-action and holds no policy).
 * The windows themselves are data: `apiKeys[].limits` (inbound) and the
 * `accounts:` overlay (outbound), never config-tree members.
 */
export interface RateLimitPersistConfig {
  /**
   * Persist the triggered-event ledger (ratelimit/event-log.ts) to the
   * shared SQLite file so a restart no longer wipes "what fired before the
   * restart". Default on; the store is fail-open — an observability write
   * never breaks the request path, and a non-bun runtime degrades to
   * memory-only.
   */
  enabled?: boolean;
}

export interface RateLimitConfig {
  /**
   * Bounded grace wait in ms: when an inbound denial reopens its window
   * within this budget, the auth preHandler sleeps the exact `retryAfterMs`
   * out and re-checks the window ONCE (no loop) instead of answering 429 —
   * absorbing sub-second bursts so a coding agent never sees a user-visible
   * error for a blip shorter than its own retry would cost. Denials beyond
   * the budget keep fast-failing: the per-key limits stay a contract, and
   * long waits must not turn the gateway into a hidden queue. 0 disables
   * grace entirely. Clamped to MAX_INBOUND_GRACE_MS at load.
   */
  inboundGraceMs?: number;
  /** Event-ledger persistence (see RateLimitPersistConfig). */
  persist?: RateLimitPersistConfig;
}

export interface RouterConfig {
  port: number;
  host: string;
  adminApiKey?: string;
  apiKeys?: ApiKeyConfig[];
  webAuth?: WebAuthConfig;
  opencode?: OpenCodeConfig;
  proxy?: ProxyConfig;
  forwardProxy?: ForwardProxyConfig;
  compression?: CompressionConfig;
  /** Request capture (audit log). */
  requestCapture?: RequestCaptureConfig;
  tracePersist?: TracePersistConfig;
  logging?: LoggingConfig;
  catalog?: CatalogConfig;
  tiers?: TiersConfig;
  routing?: RoutingConfig;
  fallback: FallbackConfig;
  classifier?: ClassifierConfig;
  /** System One protocol surface (POST /v1/systemone). */
  systemone?: SystemoneSurfaceConfig;
  /** OpenAI Responses protocol surface (POST /v1/responses). */
  responses?: ResponsesSurfaceConfig;
  flywheel?: FlywheelConfig;
  session?: SessionConfig;
  circuitBreaker?: CircuitBreakerConfig;
  retry?: RetryConfig;
  /** Rate-limit policy (see RateLimitConfig); the windows themselves live in `apiKeys[].limits` / `accounts:`. */
  rateLimit?: RateLimitConfig;
  providers?: ProviderConfig[];
  models?: ModelRegistration[];
  combos?: ComboConfig[];
  /** Named slot→modelRef tables for mass-assigning client agent models (see ModelProfileConfig). */
  modelProfiles?: ModelProfileConfig[];
  /**
   * Outbound rate-limit overlay for upstream credentials: provider id → list
   * of per-account rules keyed by the credential identity
   * (`keyHashPrefix`). The credentials themselves live in the CredentialStore;
   * this section only attaches window caps to them (see ratelimit/rate-limiter.ts).
   */
  accounts?: Record<string, AccountLimitConfig[]>;
  /** Per-client console form memory (see ClientProfileMemoryEntry) — UI-only, never routed. */
  clientProfileMemory?: Record<string, ClientProfileMemoryEntry>;
  /**
   * Quota tracking: long-tail custom probe declarations keyed by
   * provider id. Each entry carries a relative `url` (sanitized to stay inside
   * that provider's inference origin), reuses the inference bearer auth, GET-
   * only, one URL per entry, cacheTtl clamped [60s, 24h]. The built-in
   * coverage (L-b table + L-c code adapters) ships with the release and is
   * NOT configured here — this section only adds the long tail and explicit
   * forks (an entry overriding a built-in must name it via `override:`).
   */
  quotaProbes?: Record<string, QuotaProbeConfigEntry[]>;
  /** Quota scheduler knobs (enabled default-on; intervalMs default 60s). */
  quota?: QuotaConfig;
}

/**
 * Quota tracking scheduler knobs. The KNOWLEDGE (probe table +
 * code adapters) ships with the release; this section only tunes scheduling:
 * `enabled` is the kill switch (default ON — activation follows credentials,
 * a covered provider's credential appearing arms its probes), `intervalMs`
 * is the due-based tick (clamped [10s, 1h] at construction).
 */
export interface QuotaConfig {
  enabled?: boolean;
  intervalMs?: number;
}

export type { CircuitBreakerConfig, RetryConfig };
