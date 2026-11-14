import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { CircuitBreakerConfig, DirectivesConfig, InterceptPosture, Layer2DecisionConfig, MihomoConfig, MihomoCustomRule, MihomoGroupType, MihomoManualNode, MihomoRoutingMode, MihomoRuleTarget, MihomoRuleType, MihomoSubscription, ProxyConfig, ProxyMode, RateLimitConfig, RequestCaptureConfig, RouteEntriesConfig, RouterConfig, WebAuthConfig } from './types.js';
import { normalizeUnresolvedModelConfig } from '../pipeline/unresolved-model.js';
import { INTERCEPT_POSTURES, lintRules, normalizeRuleTable } from '../forward-proxy/rules.js';
import { DEFAULT_RETRIABLE_CAUSES } from '../resilience/types.js';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG, DEFAULT_MAX_RATE_LIMIT_WAIT_MS } from '../resilience/circuit-breaker.js';
import { EFFORT_LADDER } from '../types/router.js';
import { resolveDirectivePrefix } from '../pipeline/directives.js';
import { missingNodeCredential, sanitizeTypedNode } from '../proxy/manual-node-spec.js';
import { ensureEnvScaffold, getEnvPaths, resolveEnvName } from './env.js';
import {
  DEFAULT_FORWARD_PROXY_PORT,
  DEFAULT_FORWARD_PROXY_HOST,
  DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS,
  DEFAULT_FORWARD_PROXY_RULES,
  DEFAULT_FORWARD_PROXY_INTERCEPT,
  FORWARD_PROXY_MAX_CONNECTIONS_MIN,
  FORWARD_PROXY_MAX_CONNECTIONS_MAX,
  DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS,
  PROXY_ACCESS_LOG_PERSIST_DAYS_MIN,
  PROXY_ACCESS_LOG_PERSIST_DAYS_MAX,
  DEFAULT_HEADROOM_TIMEOUT_MS,
  DEFAULT_DIRECTIVE_PREFIX,
  DEFAULT_HEADROOM_URL,
  DEFAULT_LAYER2_EFFORT_FLOOR,
  DEFAULT_LAYER2_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_ROUTE_ENTRIES_MAX,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_MIHOMO_CONTROLLER_PORT,
  DEFAULT_MIHOMO_GROUP,
  DEFAULT_MIHOMO_MIXED_PORT,
  DEFAULT_MIHOMO_SUB_INTERVAL_SEC,
  MIHOMO_SUB_INTERVAL_MAX_SEC,
  MIHOMO_SUB_INTERVAL_MIN_SEC,
  MIHOMO_GROUP_INTERVAL_MAX_SEC,
  MIHOMO_GROUP_INTERVAL_MIN_SEC,
  DEFAULT_MIHOMO_GROUP_TOLERANCE_MS,
  MIHOMO_GROUP_TOLERANCE_MAX_MS,
  DEFAULT_MIHOMO_TEST_URL,
} from './defaults.js';
import { getRateLimiter } from '../ratelimit/rate-limiter.js';
import { getQuotaProber } from '../quota/prober.js';
import { migrateConfig, toDiskConfig, toRuntimeConfig, SCHEMA_VERSION, type DiskConfig } from './schema.js';
import { getRuntimeConfigRef, registerRuntimeConfigRef } from './runtime.js';

export { getRuntimeConfigRef, registerRuntimeConfigRef };
// Bootstrap levers (OCR_ENV / OCR_HOME) come from the REAL process environment
// only — there is no .env loader. A file-based override would be a second,
// cwd-dependent source of truth next to the envs/current pointer.

/**
 * Inbound grace defaults: on by default (a sub-second blip should not become
 * a user-visible 429 for a coding agent) but hard-capped — beyond a couple of
 * seconds the wait belongs to the client's own retry loop, not our sockets.
 * Mirrors the outbound side's `retry.inplace.maxRateLimitWaitMs` (2000ms)
 * precedent: short upstream caps are already slept in place; this is the same
 * policy at the inbound gate.
 */
export const DEFAULT_INBOUND_GRACE_MS = 1000;
export const MAX_INBOUND_GRACE_MS = 2000;

/**
 * Cap on concurrent inbound grace-wait sleepers. Each sleeper parks a request
 * (and its socket) for up to MAX_INBOUND_GRACE_MS; under a retry storm the
 * denied-path sleepers would otherwise accumulate without bound. Beyond this
 * many, the gate skips the grace wait and fast-fails 429 like any other
 * denial — the window contract is unchanged, only the absorb-burst courtesy
 * is shed under pressure.
 */
export const MAX_GRACE_SLEEPERS = 64;

/**
 * Period between the limiter's durable window checkpoints (rateLimit.persist).
 * The checkpoint is also flushed on graceful shutdown, so this interval is
 * only the crash-loss bound: a hard kill loses at most the last interval of
 * window events (the same honest-loss-bound pattern as the session-manager
 * debounce).
 */
export const RATE_LIMIT_CHECKPOINT_INTERVAL_MS = 30_000;

const DEFAULT_CONFIG: RouterConfig = {
  port: parseInt(process.env.PORT || String(DEFAULT_GATEWAY_PORT), 10),
  host: process.env.HOST || '127.0.0.1',
  adminKey: process.env.OCR_ADMIN_KEY || process.env.ROUTER_API_KEY || undefined,
  // First-boot tier defaults are EMPTY pools: defaultConfigYaml() writes the
  // four tier shells into every brand-new config.yaml and the loadConfig()
  // fallback below re-applies them when a file has no `tiers:` section at all.
  // No member glob ships — the operator curates pools on the console /tiers
  // page (or by hand); until members exist every pool is empty, `auto` cannot
  // route, and boot-direct warns. Models stay directly callable by full id.
  tiers: {
    lite: {},
    plus: {},
    pro: {},
    ultra: {},
  },
  routing: { mode: 'smart' },
  fallback: {
    enabled: true,
    maxRetries: 1,
    escalateTier: 'plus',
    injectErrorContext: true,
  },
  classifier: {
    layer2: {
      enabled: false,
      // No model pinned by default — the decision layer then follows
      // `systemone.defaultModel`.
      timeoutMs: DEFAULT_LAYER2_TIMEOUT_MS,
      collectEnabled: false, // dataset sampling: sampled decisions → data/layer2-decisions.jsonl (single-key gate, opt-in)
      effortDecision: false, // decision layer also decides the thinking level (ADR-0012) — spends thinking tokens, opt-in
      effortFloor: DEFAULT_LAYER2_EFFORT_FLOOR, // lowest level L2 may assign (client-explicit asks are never touched)
    },
  },
  directives: {
    enabled: true, // false = both the scrub and the effect are off (@ocr-* travel as text)
    prefix: DEFAULT_DIRECTIVE_PREFIX, // reserved namespace; relocatable for OCR-domain prompts
  },
  routeEntries: {
    enabled: true, // experience table: lookup + whitelisted writes + ledger
    snippetEnabled: true, // store first 200 prompt chars for the console (opt-out)
    maxEntries: DEFAULT_ROUTE_ENTRIES_MAX,
  },
  proxy: {
    enabled: false, // opt-in: proxying only when explicitly enabled
    mode: 'manual', // ADR-0022: manual keeps proxy.url; mihomo routes via the local core
    url: 'http://127.0.0.1:7890',
    includes: [],
    excludes: [],
    mihomo: {
      enabled: false,
      binaryPath: '',
      mixedPort: DEFAULT_MIHOMO_MIXED_PORT,
      controllerPort: DEFAULT_MIHOMO_CONTROLLER_PORT,
      controllerSecret: '',
      subscriptions: [],
      selectedGroup: DEFAULT_MIHOMO_GROUP,
      selectedNodes: {},
    },
  },
  forwardProxy: {
    enabled: false, // opt-in: full-capture MITM proxy must be enabled consciously
    port: DEFAULT_FORWARD_PROXY_PORT,
    host: DEFAULT_FORWARD_PROXY_HOST,
    maxConnections: DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS,
    requireCredential: false, // opt-in: loopback clients must also present an API key
    // Rule table (ADR-0018 Revision 4): the fresh-install seed routes everything
    // through the outbound proxy policy as a BLIND TUNNEL. Inert until BOTH this
    // listener and `proxy.enabled` are on, so it costs a fresh install nothing.
    rules: DEFAULT_FORWARD_PROXY_RULES,
    // Interception posture: decrypt only what a capability declares (live
    // client-gateway plugin claims + explicit `ingress: intercept` rows).
    intercept: DEFAULT_FORWARD_PROXY_INTERCEPT,
    accessLog: { enabled: true, persist: true, persistDays: DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS },
    // Upstream TLS trust for the origin legs (ADR-0019): system trust store
    // unless the operator names a private CA or disables verification.
    upstreamTls: { insecure: false },
  },
  compression: {
    rtk: { enabled: false },
    headroom: { enabled: false, url: DEFAULT_HEADROOM_URL, timeoutMs: DEFAULT_HEADROOM_TIMEOUT_MS, autoStart: false },
    caveman: { enabled: false, level: 'full' },
  },
  requestCapture: {
    enabled: false, // opt-in: full bodies may contain sensitive data
    retentionDays: 7,
    // 2048 MB rolling pool; a single session seals at 512 MB (maxSessionMB)
    // so one O(n²) agent loop cannot starve the shared budget; the per-body
    // cap (16 MB) is sized for a fully-loaded 2M-token context (~13 MB worst
    // case text+JSON after image scrubbing).
    maxTotalMB: 2048,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxSessionMB: 512,
    storeMedia: true,
    redactSecrets: true, // false = raw credentials persist in the archive (explicit opt-out)
  },
  tracePersist: {
    enabled: true, // default on: console history survives restarts (pure observability data)
    retentionDays: 7,
    maxTotalMB: 100,
  },
  circuitBreaker: {
    // Global knobs mirror the runtime default exactly once (single source:
    // resilience/circuit-breaker.ts); shadow/persistence/rules below are
    // config-only surfaces with no runtime twin.
    ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
    // Shadow mode (spec docs/design/circuit-breaker-rules-config.md): rules
    // evaluate and record fully but the gate never denies; manual trips,
    // DISABLED and SUSPECT stay enforced.
    shadow: false,
    persistence: {
      debounceMs: 1000,
    },
    // The rule tree. Only today's BEHAVIOR defaults are materialized here
    // (enabled toggles, scopes, enums); per-rule numeric params stay UNSET —
    // the startup resolver falls them back to the global knobs above, so a
    // later global-knob change keeps propagating ("auto" semantics).
    rules: {
      counting: {
        serverErrors: { enabled: true },
        unknownErrors: { enabled: true },
        rateLimitErrors: {},
        clientErrors: { enabled: false },
      },
      trip: {
        quota: { enabled: true, scope: 'auto' },
        auth: { enabled: true, markSuspect: true, scope: 'auto' },
        rateLimit: { enabled: true, scope: 'auto' },
        consecutiveFailures: { enabled: true, scope: 'auto' },
        failureRate: { enabled: true, scope: 'auto' },
      },
      recovery: {
        onCanaryFailure: 'backoff',
        halfOpen: {},
      },
    },
  },
  retry: {
    enabled: true,
    inplace: {
      enabled: true,
      maxAttempts: 1,
      backoffMs: 200,
      jitterMs: 100,
      retryOnCauses: [...DEFAULT_RETRIABLE_CAUSES],
      maxRateLimitWaitMs: DEFAULT_MAX_RATE_LIMIT_WAIT_MS,
    },
    failover: {
      enabled: true,
      maxAttempts: 2,
      tierCrossPolicy: 'allow_escalate',
    },
  },
  rateLimit: {
    inboundGraceMs: DEFAULT_INBOUND_GRACE_MS,
    persist: { enabled: true },
  },
  streaming: { enabled: true },
  apiKeys: [],
  models: [],
};

export function getConfigPath(customPath?: string): string {
  // Top priority: an explicit path from the caller (CLI --config, tests).
  if (customPath) return path.resolve(customPath);
  // Otherwise the active environment's own config.yaml. resolveEnvName()
  // fails fast on an unknown env — loud startup error.
  return getEnvPaths().configPath;
}

/**
 * WebAuth sanitizer: shallow-copies and strips anything that must never
 * persist — a hand-written plaintext `password` key (hashes only), so a
 * round-tripped config can't leak or overwrite the stored hash format.
 * (Exported for the environment-archive import path — config/env-archive.ts.)
 */
export function sanitizeWebAuthInput(input: unknown): WebAuthConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const wa = { ...(input as WebAuthConfig) };
  delete (wa as { password?: unknown }).password;
  return wa;
}

/**
 * Layer 2 sanitizer: drops the retired vendor-connection keys (`provider`,
 * `baseUrl`, `apiKey`) left over from the pre-System-One decision layer, which talked
 * to a hand-configured vendor endpoint. The decision layer now addresses a REGISTERED
 * model through the gateway's own System One protocol, so those
 * keys are meaningless — and keeping them would re-persist dead settings on
 * every console save. `decisionCapture` joins the drop list after the
 * dataset-sampling move to classifier.layer2.collectEnabled (old key ignored).
 */
function sanitizeLayer2Input(input: unknown): Layer2DecisionConfig {
  const merged = { ...DEFAULT_CONFIG.classifier?.layer2, ...(input as Layer2DecisionConfig) } as Layer2DecisionConfig & {
    provider?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    decisionCapture?: unknown;
  };
  delete merged.provider;
  delete merged.baseUrl;
  delete merged.apiKey;
  delete merged.decisionCapture;
  // Retired `escalateOnRetry` (automatic retry ladder, replaced by `@ocr-*`
  // directives) must not round-trip into a saved config.yaml.
  delete (merged as { escalateOnRetry?: unknown }).escalateOnRetry;
  // A hand-edited/garbage floor must never silently strip thinking: any value
  // outside the ladder falls back to the default.
  if (!EFFORT_LADDER.includes(merged.effortFloor as (typeof EFFORT_LADDER)[number])) {
    merged.effortFloor = DEFAULT_LAYER2_EFFORT_FLOOR;
  }
  return merged;
}

/**
 * RouteEntries sanitizer: same trust-boundary clamp as resolveRequestCapture's
 * pickPositive — a non-positive `maxEntries` would make the LRU eviction
 * delete every non-human learned row on the next write (silent learned-memory
 * wipe). Finite positive values floor at 1; zero/negative/garbage (including
 * the empty string, which Number() maps to 0) falls back to the default.
 */
function sanitizeRouteEntriesInput(input: unknown): RouteEntriesConfig {
  const base = DEFAULT_CONFIG.routeEntries as RouteEntriesConfig;
  const merged = { ...base, ...(input as RouteEntriesConfig) };
  const cap = Number(merged.maxEntries ?? base.maxEntries);
  merged.maxEntries =
    Number.isFinite(cap) && cap > 0 ? Math.max(1, Math.round(cap)) : (base.maxEntries ?? DEFAULT_ROUTE_ENTRIES_MAX);
  // Retired `escalateOnRetry` (automatic retry ladder, replaced by `@ocr-*`
  // directives) must not round-trip into a saved config.yaml.
  delete (merged as { escalateOnRetry?: unknown }).escalateOnRetry;
  return merged;
}

/**
 * Directives sanitizer: the prefix decides which slice of user text the gateway
 * is allowed to rewrite, so it is validated rather than trusted — an invalid
 * value falls back to the default namespace (`resolveDirectivePrefix`).
 * Unknown keys never round-trip into config.yaml.
 */
function sanitizeDirectivesInput(input: unknown): DirectivesConfig {
  const base = DEFAULT_CONFIG.directives as DirectivesConfig;
  const raw = (input ?? {}) as DirectivesConfig;
  return {
    enabled: raw.enabled !== false,
    prefix: resolveDirectivePrefix(raw.prefix ?? base.prefix),
  };
}

/**
 * Resolve the `requestCapture:` tree from a raw parsed config. Only known
 * fields are picked, so retired/junk keys never round-trip into a saved
 * config.yaml. Raw YAML values pass through unchecked (type enforcement is
 * the consumers' nullish-merge).
 */
function resolveRequestCapture(parsed: any): RequestCaptureConfig {
  const base = DEFAULT_CONFIG.requestCapture as RequestCaptureConfig;
  const raw = (parsed?.requestCapture ?? {}) as Record<string, unknown>;
  // `as` cast: raw YAML is untyped at this boundary; the old spread was too.
  const pick = <K extends 'enabled' | 'dir'>(key: K) => (raw[key] ?? base[key]) as RequestCaptureConfig[K];
  // Trust boundary: a negative maxTotalMB makes the sweep delete EVERY date
  // dir, and a negative maxSessionMB seals every archive at its first event —
  // both irreversible. The console's number inputs run `parseInt(v) || default`,
  // which admits negatives, so clamp here (the one place all callers route
  // through): finite values floor at 1, garbage falls back to the default.
  const pickPositive = <K extends 'retentionDays' | 'maxTotalMB' | 'maxBodyBytes' | 'maxSessionMB'>(key: K): number => {
    const v = Number(raw[key] ?? base[key]);
    return Number.isFinite(v) ? Math.max(1, Math.round(v)) : (base[key] as number);
  };
  // The retired `requestCapture.systemone` subtree (two-gate capture) is
  // deliberately NOT picked — like every unknown key it never round-trips
  // into a saved config.yaml.
  return {
    enabled: pick('enabled'),
    retentionDays: pickPositive('retentionDays'),
    maxTotalMB: pickPositive('maxTotalMB'),
    maxBodyBytes: pickPositive('maxBodyBytes'),
    maxSessionMB: pickPositive('maxSessionMB'),
    // boolean needs the ?? chain (false must survive); deliberately NOT in the
    // pick union, which now types only the boolean/string keys.
    storeMedia: (raw.storeMedia ?? base.storeMedia) as boolean,
    redactSecrets: (raw.redactSecrets ?? base.redactSecrets) as boolean,
    dir: pick('dir'),
  };
}

/**
 * Resolve the whole `forwardProxy` section (ADR-0018).
 */
function resolveForwardProxyConfig(raw: unknown): RouterConfig['forwardProxy'] {
  const rawFp = (raw ?? {}) as Record<string, any>;
  const fp = { ...DEFAULT_CONFIG.forwardProxy, ...rawFp } as Record<string, any>;
  // The section carries exactly the keys `ForwardProxyConfig` declares. Any
  // other key a hand-edited file still holds — a retired key (`bypassHosts`,
  // `viaOutboundProxy`, `mitmHosts`, the interim `egress` / `egressRules` /
  // `decryptRules` shapes, `authToken`) or a typo — is dropped here: never
  // folded, never translated, never re-persisted on the next console save.
  // `authToken` (the retired shared proxy secret — proxy auth is API-key only,
  // ADR-0008) is the one that stings: an install that authenticated a loopback
  // proxy with it lands on an UNauthenticated listener until a key exists and
  // `forwardProxy.requireCredential` is on. Retired keys are never translated
  // (ADR-0018 §6), so the ADR is where the operator learns this.
  const declared = {
    enabled: fp.enabled,
    port: fp.port,
    host: fp.host,
    caDir: fp.caDir,
    maxConnections: fp.maxConnections,
    requireCredential: fp.requireCredential === true,
    accessLog: fp.accessLog,
    rules: fp.rules,
    /** ADR-0018 Revision 4: only the two declared words survive; anything else
     *  (a typo, a retired spelling) falls back to the claims posture — the
     *  SAFE direction, never to machine-wide decryption. */
    intercept: normalizeInterceptPosture(rawFp.intercept),
    upstreamTls: fp.upstreamTls,
    unresolvedModel: fp.unresolvedModel,
  };
  // An EXPLICIT `rules` array in the user's file wins (even empty — an empty
  // table is a decision); otherwise the shipped default table applies.
  const rules = Array.isArray(rawFp.rules) ? normalizeRuleTable({ rules: rawFp.rules }) : normalizeRuleTable(declared);
  return {
    ...declared,
    rules,
    maxConnections: normalizeMaxConnections(fp.maxConnections),
    unresolvedModel: normalizeUnresolvedModelConfig(fp.unresolvedModel as never),
    accessLog: normalizeAccessLogConfig(fp.accessLog),
    upstreamTls: normalizeUpstreamTlsConfig(fp.upstreamTls),
  } as RouterConfig['forwardProxy'];
}

/**
 * Resolve `forwardProxy.intercept` (ADR-0018 Revision 4): exactly `'claims'`
 * and `'all'` parse; every other value (a typo, a retired word, a non-string)
 * is ignored and the safe posture applies. Junk must never buy machine-wide
 * decryption.
 */
function normalizeInterceptPosture(raw: unknown): InterceptPosture {
  return typeof raw === 'string' && (INTERCEPT_POSTURES as readonly string[]).includes(raw)
    ? (raw as InterceptPosture)
    : DEFAULT_FORWARD_PROXY_INTERCEPT;
}

/**
 * Resolve `forwardProxy.upstreamTls` (ADR-0019) — same trust boundary as the
 * rest of the section: junk falls back to the system trust store, never to a
 * silently disabled verification. `insecure` is only ever true when the operator
 * literally wrote `true`.
 */
function normalizeUpstreamTlsConfig(raw: unknown): { caFile?: string; insecure: boolean } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const caFile = typeof r.caFile === 'string' && r.caFile.trim() ? r.caFile.trim() : undefined;
  return { ...(caFile ? { caFile } : {}), insecure: r.insecure === true };
}

/**
 * Resolve `forwardProxy.maxConnections` — junk falls back to the default (no
 * coercion), a real number is floored and clamped to the declared bounds so a
 * typo cannot turn the cap into "unlimited" or "reject everything".
 */
function normalizeMaxConnections(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS;
  return Math.min(FORWARD_PROXY_MAX_CONNECTIONS_MAX, Math.max(FORWARD_PROXY_MAX_CONNECTIONS_MIN, Math.floor(raw)));
}

/**
 * Resolve `forwardProxy.accessLog` — same trust boundary as resolveRateLimit:
 * junk values fall back to defaults, not coercion. bodyBytes: absent = the
 * consumer applies DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES (1 MiB, spill-to-file);
 * 0 = headers only; a positive number = per-side inline cap.
 * persistDays clamps to 1..365.
 */
function normalizeAccessLogConfig(raw: unknown): {
  enabled: boolean;
  bodyBytes: number | undefined;
  persist: boolean;
  persistDays: number;
} {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bodyBytes =
    typeof r.bodyBytes === 'number' && Number.isFinite(r.bodyBytes)
      ? Math.max(0, Math.floor(r.bodyBytes))
      : undefined;
  const persistDaysRaw =
    typeof r.persistDays === 'number' && Number.isFinite(r.persistDays)
      ? Math.floor(r.persistDays)
      : DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS;
  return {
    enabled: r.enabled !== false,
    bodyBytes,
    persist: r.persist !== false,
    persistDays: Math.min(PROXY_ACCESS_LOG_PERSIST_DAYS_MAX, Math.max(PROXY_ACCESS_LOG_PERSIST_DAYS_MIN, persistDaysRaw)),
  };
}

/**
 * Resolve the `circuitBreaker:` tree from a raw parsed config. Top-level knobs
 * merge shallow (unchanged from the old spread); the NEW `rules` tree merges
 * KEY-BY-KEY at every level (family maps and each rule object), so a partially
 * written rule block can never silently drop its sibling defaults against the
 * shallow merge (spec invariant 5). Numeric per-rule params stay UNSET when
 * absent — the startup resolver (resolveBreakerRules) falls them back to the
 * global knobs; materializing them here would freeze inherited values into the
 * saved YAML. Booleans/enums DO materialize (they encode "today's behavior"
 * without shadowing any knob). Clamps applied at the value level; the
 * cross-field clamps resolve against the effective global fallbacks:
 * maxProbes >= 1, successThreshold <= maxProbes, minCalls <= windowSize.
 * Unknown keys inside the rules tree are dropped (round-trip hygiene, same
 * doctrine as resolveRequestCapture).
 */
function resolveCircuitBreaker(parsed: any): CircuitBreakerConfig {
  const base = DEFAULT_CONFIG.circuitBreaker as CircuitBreakerConfig;
  // `as` cast: raw YAML is untyped at this boundary; same tolerance the old
  // spread-merge had (type enforcement is the consumers' nullish-merge).
  const raw = (parsed?.circuitBreaker ?? {}) as Record<string, any>;
  const merged: CircuitBreakerConfig = { ...base, ...raw };

  // ── value cleaners (trust-boundary validation: junk → unset → fallback) ──
  const ms = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const scope = (v: unknown): 'auto' | 'pair' | 'credential' | 'model' | 'provider' =>
    v === 'pair' || v === 'credential' || v === 'model' || v === 'provider' ? v : 'auto';
  const canaryMode = (v: unknown): 'backoff' | 'initial' | 'close' =>
    v === 'initial' || v === 'close' ? v : 'backoff';

  // Merge one rule object over an explicit key list (unknown keys dropped —
  // round-trip hygiene): raw value wins per key, null/absent falls to base.
  const obj = (baseObj: object | undefined, rawObj: unknown, keys: readonly string[]): Record<string, unknown> => {
    const src = (rawObj && typeof rawObj === 'object' && !Array.isArray(rawObj) ? rawObj : {}) as Record<string, unknown>;
    const baseRec = (baseObj ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const raw = src[key];
      out[key] = raw !== undefined && raw !== null ? raw : baseRec[key];
    }
    return out;
  };

  const rawRules = (raw.rules ?? {}) as Record<string, unknown>;
  const c = obj(base.rules?.counting, rawRules.counting, ['serverErrors', 'unknownErrors', 'rateLimitErrors', 'clientErrors']);
  const t = obj(base.rules?.trip, rawRules.trip, ['quota', 'auth', 'rateLimit', 'consecutiveFailures', 'failureRate']);
  const rec = obj(base.rules?.recovery, rawRules.recovery, ['onCanaryFailure', 'cooldownMultiplier', 'halfOpen']);

  const server = obj(base.rules?.counting?.serverErrors, c.serverErrors, ['enabled', 'minCooldownMs']);
  const unknown = obj(base.rules?.counting?.unknownErrors, c.unknownErrors, ['enabled', 'minCooldownMs']);
  const rateCounted = obj(base.rules?.counting?.rateLimitErrors, c.rateLimitErrors, ['minCooldownMs']);
  const client = obj(base.rules?.counting?.clientErrors, c.clientErrors, ['enabled']);
  const quota = obj(base.rules?.trip?.quota, t.quota, ['enabled', 'cooldownMs', 'scope']);
  const auth = obj(base.rules?.trip?.auth, t.auth, ['enabled', 'cooldownMs', 'markSuspect', 'scope']);
  const rate = obj(base.rules?.trip?.rateLimit, t.rateLimit, ['enabled', 'hardTripAboveMs', 'minCooldownMs', 'scope']);
  const consec = obj(base.rules?.trip?.consecutiveFailures, t.consecutiveFailures, [
    'enabled', 'threshold', 'initialCooldownMs', 'cooldownMultiplier', 'maxCooldownMs', 'scope',
  ]);
  const rateRule = obj(base.rules?.trip?.failureRate, t.failureRate, [
    'enabled', 'windowSize', 'failureRate', 'minCalls', 'cooldownMs', 'scope',
  ]);
  const halfOpen = obj(base.rules?.recovery?.halfOpen, rec.halfOpen, ['maxProbes', 'successThreshold', 'maxWaitMs']);

  // Effective global fallbacks the cross-field clamps resolve against.
  const globalProbes = Math.max(1, Math.floor(ms(merged.halfOpenMaxProbes) ?? 1));
  const maxProbes = halfOpen.maxProbes !== undefined ? Math.max(1, Math.floor(ms(halfOpen.maxProbes) ?? 1)) : undefined;
  const effProbes = maxProbes ?? globalProbes;
  const successThreshold =
    halfOpen.successThreshold !== undefined
      ? Math.min(Math.max(1, Math.floor(ms(halfOpen.successThreshold) ?? 1)), effProbes)
      : undefined;
  const globalWindow = Math.max(1, Math.floor(ms(merged.slidingWindowSize) ?? 20));
  const windowSize = rateRule.windowSize !== undefined ? Math.max(1, Math.floor(ms(rateRule.windowSize) ?? 1)) : undefined;
  const effWindow = windowSize ?? globalWindow;
  const minCalls =
    rateRule.minCalls !== undefined ? Math.min(Math.max(0, Math.floor(ms(rateRule.minCalls) ?? 0)), effWindow) : undefined;

  merged.rules = {
    counting: {
      serverErrors: {
        enabled: flag(server.enabled, true),
        minCooldownMs: ms(server.minCooldownMs),
      },
      unknownErrors: {
        enabled: flag(unknown.enabled, true),
        minCooldownMs: ms(unknown.minCooldownMs),
      },
      // Countedness of 429 has NO toggle; only the no-Retry-After floor is settable.
      rateLimitErrors: { minCooldownMs: ms(rateCounted.minCooldownMs) },
      clientErrors: { enabled: flag(client.enabled, false) },
    },
    trip: {
      quota: { enabled: flag(quota.enabled, true), cooldownMs: ms(quota.cooldownMs), scope: scope(quota.scope) },
      auth: {
        enabled: flag(auth.enabled, true),
        cooldownMs: ms(auth.cooldownMs),
        markSuspect: flag(auth.markSuspect, true),
        scope: scope(auth.scope),
      },
      rateLimit: {
        enabled: flag(rate.enabled, true),
        hardTripAboveMs: ms(rate.hardTripAboveMs),
        minCooldownMs: ms(rate.minCooldownMs),
        scope: scope(rate.scope),
      },
      consecutiveFailures: {
        enabled: flag(consec.enabled, true),
        threshold: consec.threshold !== undefined ? Math.max(1, Math.floor(ms(consec.threshold) ?? 1)) : undefined,
        initialCooldownMs: ms(consec.initialCooldownMs),
        cooldownMultiplier: ms(consec.cooldownMultiplier),
        maxCooldownMs: ms(consec.maxCooldownMs),
        scope: scope(consec.scope),
      },
      failureRate: {
        enabled: flag(rateRule.enabled, true),
        windowSize,
        failureRate:
          typeof rateRule.failureRate === 'number' && rateRule.failureRate >= 0 && rateRule.failureRate <= 1
            ? rateRule.failureRate
            : undefined,
        minCalls,
        cooldownMs: ms(rateRule.cooldownMs),
        scope: scope(rateRule.scope),
      },
    },
    recovery: {
      onCanaryFailure: canaryMode(rec.onCanaryFailure),
      cooldownMultiplier: ms(rec.cooldownMultiplier),
      halfOpen: {
        maxProbes,
        successThreshold,
        maxWaitMs: ms(halfOpen.maxWaitMs),
      },
    },
  };

  merged.shadow = flag(raw.shadow, false);
  const rawPersistence = (raw.persistence ?? {}) as Record<string, unknown>;
  merged.persistence = { debounceMs: ms(rawPersistence.debounceMs) ?? 1000 };

  return merged;
}

/**
 * Resolve the `rateLimit:` tree (policy knobs only — the windows themselves
 * are `apiKeys[].limits` / the `credentials:` overlay). Junk falls back to the
 * default, values are floored at 0 (disable) and hard-capped at
 * MAX_INBOUND_GRACE_MS; unknown keys are dropped (round-trip hygiene, same
 * doctrine as resolveRequestCapture). `persist.enabled` defaults to true —
 * only an explicit `false` disables the ledger store. Exported for tests.
 */
export function resolveRateLimit(parsed: any): RateLimitConfig {
  const raw = (parsed?.rateLimit ?? {}) as Record<string, unknown>;
  const v = raw.inboundGraceMs;
  // Same trust-boundary cleaner as resolveCircuitBreaker's `ms()`: non-number
  // (e.g. a quoted string in YAML) is junk → default, not coercion.
  const graceMs =
    typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? Math.min(Math.floor(v), MAX_INBOUND_GRACE_MS)
      : DEFAULT_INBOUND_GRACE_MS;
  const persistRaw = (raw.persist ?? {}) as Record<string, unknown>;
  return { inboundGraceMs: graceMs, persist: { enabled: persistRaw.enabled !== false } };
}

/** One-shot guard for the schema-version mismatch warning (loadConfig runs per request on some paths). */
let _schemaVersionWarned = false;
/** One-shot guard for the schemaVersion-position warning. */
let _schemaOrderWarned = false;
/** One-shot guard for the forward-proxy rule-table lint (ADR-0018). */
let _rulesLintWarned = false;
/**
 * The port the config FILE names, captured on the read path. The `PORT` env
 * lever overrides the LISTEN port but must never become a file value: a
 * `PORT=4700 bun run dev` boot would otherwise persist 4700 onto an installed
 * gateway's config.yaml (boot-time saves such as the catalog sync run
 * unconditionally) and silently relocate that gateway on its next restart.
 */
let _diskPort: number | undefined;

/**
 * Boot-time egress lint (ADR-0018). The console renders the same codes per row
 * with translations, but a hand-edited config.yaml never opens the console —
 * one warn per process so a table that cannot do what it says is never silent.
 *
 * Gated on `forwardProxy.enabled`: with the listener off the table routes
 * nothing, so warning about it would be noise on every fresh install.
 */
function warnForwardProxyRulesOnce(raw: unknown, proxyEnabled: boolean): void {
  if (_rulesLintWarned) return;
  const fp = (raw ?? {}) as Record<string, any>;
  if (fp.enabled !== true) return;
  _rulesLintWarned = true;
  // Lint the RAW rows (position-preserving): `lintRules` runs the same parse as
  // the resolver, so a warning's index addresses the row the operator typed.
  for (const w of lintRules(fp.rules, proxyEnabled, normalizeInterceptPosture(fp.intercept))) {
    const at = w.ruleIndex === undefined ? '' : ` rule #${w.ruleIndex + 1}`;
    console.warn(`[Config] forwardProxy.rules${at}: ${w.code}${w.detail ? ` (${w.detail})` : ''}`);
  }
}

const SUBSCRIPTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GROUP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function clampPort(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

/** Numeric field clamped to a range, with the shipped default for junk. */
function clampRange(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * `proxy.mihomo.groupInterval`: absent (or junk) stays undefined so
 * `renderMihomoConfig` can apply the shipped default; an explicit number is
 * clamped into the cadence bounds. Pinning a default here would freeze
 * today's value into every saved file and silently override later changes.
 */
function sanitizeGroupInterval(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MIHOMO_GROUP_INTERVAL_MAX_SEC, Math.max(MIHOMO_GROUP_INTERVAL_MIN_SEC, Math.round(n)));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

/** Upper bound: a rule table longer than this is a subscription dump, not an
 *  operator's decision, and it would slow every request at match time. */
const CUSTOM_RULES_MAX = 256;
const CUSTOM_RULE_PAYLOAD_MAX = 512;
/** Longest provenance label kept on a rule (a name, not a document). */
const CUSTOM_RULE_SOURCE_MAX = 40;

/** The one rule-type whitelist: the sanitizer validates against it, the
 *  subscription importer maps against it, and the console offers exactly it. */
export const MIHOMO_CUSTOM_RULE_TYPES = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD',
  'IP-CIDR', 'IP-CIDR6',
  'DST-PORT', 'SRC-PORT',
  'PROCESS-NAME', 'PROCESS-PATH',
] as const;

export const MIHOMO_CUSTOM_RULES_MAX = CUSTOM_RULES_MAX;

const CUSTOM_RULE_TYPES = new Set<string>(MIHOMO_CUSTOM_RULE_TYPES);
const CUSTOM_RULE_TARGETS = new Set<string>(['PROXY', 'DIRECT', 'REJECT']);

/**
 * Whitelist custom rules on every read.
 *
 * Everything is validated against fixed sets because these strings are written
 * VERBATIM into the generated YAML as `TYPE,payload,target`: a payload carrying
 * a newline or a comma would splice extra fields (or whole rules) into the
 * document. Unknown types are DROPPED rather than passed through — mihomo's
 * behaviour with a rule it cannot evaluate is either a hard load failure or a
 * silent fallthrough, and an operator cannot debug either from the console.
 */
function sanitizeCustomRules(raw: unknown): MihomoCustomRule[] {
  if (!Array.isArray(raw)) return [];
  const out: MihomoCustomRule[] = [];
  for (const item of raw) {
    if (out.length >= CUSTOM_RULES_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type.trim().toUpperCase() : '';
    const payload = typeof rec.payload === 'string' ? rec.payload.trim() : '';
    const targetRaw = typeof rec.target === 'string' ? rec.target.trim().toUpperCase() : '';
    if (!CUSTOM_RULE_TYPES.has(type)) continue;
    if (!payload || payload.length > CUSTOM_RULE_PAYLOAD_MAX) continue;
    // One line, no separators: the payload becomes a single YAML list entry.
    if (payload.includes(',') || payload.includes('\n') || payload.includes('\r')) continue;
    // Provenance is metadata, not routing: keep it short and printable, but a
    // junk label must not cost the rule.
    // eslint-disable-next-line no-control-regex
    const sourceRaw = typeof rec.source === 'string' ? rec.source.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    out.push({
      type: type as MihomoRuleType,
      payload,
      target: (CUSTOM_RULE_TARGETS.has(targetRaw) ? targetRaw : 'PROXY') as MihomoRuleTarget,
      ...(sourceRaw ? { source: sourceRaw.slice(0, CUSTOM_RULE_SOURCE_MAX) } : null),
    });
  }
  return out;
}

function sanitizeSubscriptions(raw: unknown): MihomoSubscription[] {
  if (!Array.isArray(raw)) return [];
  const out: MihomoSubscription[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (!SUBSCRIPTION_ID_RE.test(id) || !name || seen.has(id)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    seen.add(id);
    let interval = DEFAULT_MIHOMO_SUB_INTERVAL_SEC;
    if (typeof rec.interval === 'number' && Number.isFinite(rec.interval)) {
      interval = Math.min(MIHOMO_SUB_INTERVAL_MAX_SEC, Math.max(MIHOMO_SUB_INTERVAL_MIN_SEC, Math.round(rec.interval)));
    }
    out.push({
      id,
      name: name.slice(0, 80),
      url,
      interval,
      enabled: rec.enabled !== false,
    });
  }
  return out;
}

const MANUAL_NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Longest raw proxy mapping kept per node (a mapping, not a document). */
const MANUAL_NODE_YAML_MAX = 16 * 1024;
/** Names mihomo already owns; a manual proxy may not shadow one. */
const MANUAL_NODE_RESERVED_NAMES: Record<string, true> = {
  DIRECT: true, REJECT: true, PASS: true, GLOBAL: true, COMPATIBLE: true,
};
function cleanNodeText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value || value.length > max) return '';
  // One line, printable: these strings land in the generated YAML and in
  // mihomo's own parser; a control character can only break it.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return '';
  return value;
}

function cleanNodeHost(raw: unknown, max: number): string {
  const value = cleanNodeText(raw, max);
  return value && !/\s/.test(value) ? value : '';
}

/**
 * Whitelist hand-authored nodes on every read (ADR-0022).
 *
 * Only the fields belonging to the declared protocol survive: switching a
 * node's type must not leave a stale uuid or password in the generated YAML.
 * A row missing its identity or credentials is DROPPED — the core would fail
 * to load the whole config for one bad proxy, and a silent fall-through is
 * worse than an empty list the console can show.
 */
function sanitizeManualNodes(raw: unknown, group: string): MihomoManualNode[] {
  // A proxy named like the generated group (or a built-in) makes mihomo reject
  // the whole config; the route checks this too, but a hand-edited file must
  // not get past the loader.
  const reserved = (name: string): boolean =>
    name.toUpperCase() in MANUAL_NODE_RESERVED_NAMES || name.toUpperCase() === group.toUpperCase();
  if (!Array.isArray(raw)) return [];
  const out: MihomoManualNode[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!MANUAL_NODE_ID_RE.test(id) || seenIds.has(id)) continue;
    const rawYaml = typeof rec.yaml === 'string' ? rec.yaml.trim() : '';
    if (rawYaml) {
      // Raw pasted mapping: the operator owns every key, so only the identity
      // fields are validated. `stringify` is the canonical form (anchors and
      // aliases resolved), which is also what the console edits.
      if (rawYaml.length > MANUAL_NODE_YAML_MAX) continue;
      let mapping: unknown;
      try {
        mapping = parse(rawYaml);
      } catch {
        continue;
      }
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) continue;
      const proxy = mapping as Record<string, unknown>;
      const name = cleanNodeText(proxy.name, 64);
      const type = typeof proxy.type === 'string' ? proxy.type.trim().toLowerCase().slice(0, 32) : '';
      const server = cleanNodeHost(proxy.server, 253);
      const rawPort = typeof proxy.port === 'string' ? Number(proxy.port) : proxy.port;
      const port = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
        ? rawPort
        : 0;
      if (!name || !server || !port || !type) continue;
      // A whitelisted protocol still needs its credentials: the core loads the
      // generated document as a whole, so one incomplete proxy drops every node.
      if (missingNodeCredential(proxy)) continue;
      if (reserved(name) || seenNames.has(name.toLowerCase())) continue;
      seenIds.add(id);
      seenNames.add(name.toLowerCase());
      out.push({ id, name, type, server, port, yaml: stringify({ ...proxy, name, type, server, port }) });
      continue;
    }
    const typed = sanitizeTypedNode(rec, id);
    if (!typed.node) continue;
    const node = typed.node;
    if (reserved(node.name) || seenNames.has(node.name.toLowerCase())) continue;
    seenIds.add(id);
    seenNames.add(node.name.toLowerCase());
    out.push(node);
  }
  return out;
}
function sanitizeSelectedNodes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const name = key.trim();
    const node = value.trim();
    if (!name || !node || name.length > 128 || node.length > 256) continue;
    out[name] = node;
  }
  return out;
}

/**
 * Normalize `proxy` on every read. Missing mihomo fields take the shipped
 * defaults; junk subscriptions are dropped; `mode` stays `manual` unless the
 * file explicitly asks for mihomo (or sets `mihomo.enabled` with no mode).
 * Pure value cleaning — not a schema migration (ADR-0016 / ADR-0022).
 */
/**
 * Health-check / delay-test URL: http(s), hostful, no embedded credentials.
 * Junk falls back to the factory default rather than reaching the generated
 * config (the core would reject the whole document for one bad URL).
 */
function sanitizeTestUrl(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_MIHOMO_TEST_URL;
  const value = raw.trim();
  if (!value || value.length > 2048) return DEFAULT_MIHOMO_TEST_URL;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_MIHOMO_TEST_URL;
    if (!parsed.hostname || parsed.username || parsed.password) return DEFAULT_MIHOMO_TEST_URL;
    return value;
  } catch {
    return DEFAULT_MIHOMO_TEST_URL;
  }
}

export function sanitizeProxyConfig(raw: unknown): ProxyConfig {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ProxyConfig) : {};
  const mihomoRaw = src.mihomo && typeof src.mihomo === 'object' && !Array.isArray(src.mihomo) ? src.mihomo : {};
  const mode: ProxyMode = src.mode === 'mihomo' || (src.mode !== 'manual' && mihomoRaw.enabled === true) ? 'mihomo' : 'manual';
  const group = typeof mihomoRaw.selectedGroup === 'string' && GROUP_NAME_RE.test(mihomoRaw.selectedGroup.trim())
    ? mihomoRaw.selectedGroup.trim()
    : DEFAULT_MIHOMO_GROUP;
  const secret = typeof mihomoRaw.controllerSecret === 'string' ? mihomoRaw.controllerSecret.trim().slice(0, 256) : '';
  const binaryPath = typeof mihomoRaw.binaryPath === 'string' ? mihomoRaw.binaryPath.trim().slice(0, 1024) : '';
  // mihomo's outbound mode. Whitelisted like every other field: anything else
  // falls back to 'rule' instead of reaching the generated config.
  const routingMode: MihomoRoutingMode = mihomoRaw.routingMode === 'global' || mihomoRaw.routingMode === 'direct'
    ? mihomoRaw.routingMode
    : 'rule';
  // Group picker mode. Same whitelist discipline as `routingMode`: junk falls
  // back to the manual selector instead of reaching the generated config.
  const groupType: MihomoGroupType = mihomoRaw.groupType === 'url-test' || mihomoRaw.groupType === 'fallback'
    ? mihomoRaw.groupType
    : 'select';
  // Absent stays absent so the renderer applies the shipped default; a junk
  // value is dropped rather than pinned to a number the operator never chose
  // (both used to be materialized as 300, which also froze mihomo's default
  // into every saved file).
  const groupInterval = sanitizeGroupInterval(mihomoRaw.groupInterval);
  const groupTolerance = clampRange(mihomoRaw.groupTolerance, 0, MIHOMO_GROUP_TOLERANCE_MAX_MS, DEFAULT_MIHOMO_GROUP_TOLERANCE_MS);
  // A remembered pick belongs to the MANUAL selector only. `url-test` /
  // `fallback` hand the choice to the core, and restoring the pick would pin
  // the group (mihomo's `Set` outranks its own delay ordering while the pinned
  // node is alive) — so an automatic group keeps no entry for its own group.
  // Other groups' entries survive: the map describes the operator's manual
  // choices, not this group type.
  const selectedNodes = sanitizeSelectedNodes(mihomoRaw.selectedNodes);
  if (groupType !== 'select') delete selectedNodes[group];
  const mihomo: MihomoConfig = {
    enabled: mode === 'mihomo',
    // Tri-state passthrough (see MihomoConfig.autoStart): only an explicit
    // boolean is written, so "absent" keeps meaning "follow the mode". Do not
    // materialize it — that would erase the difference between "never chosen"
    // and "stopped by hand".
    ...(typeof mihomoRaw.autoStart === 'boolean' ? { autoStart: mihomoRaw.autoStart } : {}),
    binaryPath,
    mixedPort: clampPort(mihomoRaw.mixedPort, DEFAULT_MIHOMO_MIXED_PORT),
    controllerPort: clampPort(mihomoRaw.controllerPort, DEFAULT_MIHOMO_CONTROLLER_PORT),
    controllerSecret: secret,
    subscriptions: sanitizeSubscriptions(mihomoRaw.subscriptions),
    testUrl: sanitizeTestUrl(mihomoRaw.testUrl),
    manualNodes: sanitizeManualNodes(mihomoRaw.manualNodes, group),
    selectedGroup: group,
    routingMode,
    groupType,
    groupInterval,
    groupTolerance,
    rules: sanitizeCustomRules(mihomoRaw.rules),
    selectedNodes,
  };
  return {
    enabled: src.enabled === true,
    mode,
    url: typeof src.url === 'string' ? src.url : DEFAULT_CONFIG.proxy?.url,
    includes: stringList(src.includes),
    excludes: stringList(src.excludes),
    mihomo,
  };
}

/**
 * Deep-merge a proxy patch onto the stored section so a save that only
 * names `url` / `includes` cannot wipe subscriptions or the controller secret.
 * An explicit `subscriptions` / `manualNodes` array or `selectedNodes` object
 * replaces that field; omitting `mihomo` keeps the stored sidecar section.
 */
export function mergeProxyConfig(current: ProxyConfig | undefined, incoming: ProxyConfig): ProxyConfig {
  const prev = current ?? {};
  const prevMihomo = prev.mihomo ?? {};
  const incomingMihomo = incoming.mihomo;
  const mihomo: MihomoConfig = {
    ...prevMihomo,
    ...(incomingMihomo ?? {}),
    subscriptions: incomingMihomo && Object.prototype.hasOwnProperty.call(incomingMihomo, 'subscriptions')
      ? incomingMihomo.subscriptions
      : prevMihomo.subscriptions,
    manualNodes: incomingMihomo && Object.prototype.hasOwnProperty.call(incomingMihomo, 'manualNodes')
      ? incomingMihomo.manualNodes
      : prevMihomo.manualNodes,
    selectedNodes: incomingMihomo && Object.prototype.hasOwnProperty.call(incomingMihomo, 'selectedNodes')
      ? incomingMihomo.selectedNodes
      : prevMihomo.selectedNodes,
  };
  return sanitizeProxyConfig({
    ...prev,
    ...incoming,
    mihomo,
  });
}

export function loadConfig(configPath?: string): RouterConfig {
  const resolvedPath = getConfigPath(configPath);
  // Only the ACTIVE file's port is remembered (an explicit configPath is a
  // read of some other fixture/env and must not steer saveConfig's writes).
  if (configPath === undefined) _diskPort = undefined;
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = parse(raw) as Record<string, any>;
      // STRICT schema contract (ADR-0016): the runtime only ever reads the
      // CURRENT disk schema. Older files are upgraded ON DISK at boot
      // (upgradeConfigFile) — never here; this read path has no migration.
      // A non-current version reaching this point means the boot upgrade did
      // not process this file (a hand-copied file, a test fixture) — the same
      // lenient fallback as a syntactically broken file applies (defaults +
      // one warn). `toRuntimeConfig` is the plain v1 disk→runtime expansion,
      // not a compat shim; retired-surface keys (rules/capture/flywheel/
      // providers/models/systemoneUpstreams) are unmapped and therefore
      // already absent — stale keys never re-persist on the next save.
      // Contract (ADR-0016): `schemaVersion` is the FIRST key of the file —
      // a human scanning the file must see the format version before
      // anything else. Writers always emit it first; a mispositioned key in
      // a hand-edited file loads (the version itself still gates) but draws
      // a one-shot order warning.
      const firstKey = Object.keys(parsed ?? {})[0];
      if (firstKey !== 'schemaVersion' && !_schemaOrderWarned) {
        _schemaOrderWarned = true;
        console.warn(
          `[Config] ${resolvedPath}: 'schemaVersion' should be the FIRST key of config.yaml ` +
            `(found '${firstKey ?? 'nothing'}' first). Move it to the top — the next gateway save will.`
        );
      }
      const fileVersion =
        typeof parsed?.schemaVersion === 'number' && Number.isInteger(parsed.schemaVersion)
          ? parsed.schemaVersion
          : 0;
      if (fileVersion !== SCHEMA_VERSION) {
        if (!_schemaVersionWarned) {
          _schemaVersionWarned = true;
          console.warn(
            `[Config] ${resolvedPath}: schemaVersion ${fileVersion} !== current ${SCHEMA_VERSION} — the boot-time ` +
              `config upgrade has not processed this file. Loading built-in defaults; restart the gateway to migrate.`
          );
        }
        return DEFAULT_CONFIG;
      }
      const flat = toRuntimeConfig(parsed as unknown as DiskConfig) as Record<string, any>;
      if (configPath === undefined) {
        _diskPort = typeof flat.port === 'number' && Number.isFinite(flat.port) ? flat.port : undefined;
      }
      warnForwardProxyRulesOnce(flat.forwardProxy, flat.proxy?.enabled === true);
      return {
        ...DEFAULT_CONFIG,
        ...flat,
        // Explicit PORT env is the bootstrap/deployment lever (same tier as
        // OCR_HOME): the desktop shell and the daemon restart flows pin the
        // listen port via env, so a config.yaml `port:` must NOT override it
        // (a CLI-first install's yaml would otherwise bind the desktop
        // sidecar onto the yaml port while the shell waits on its own).
        ...(process.env.PORT?.trim()
          ? { port: parseInt(process.env.PORT, 10) }
          : {}),
        // `role` (removed key-level RBAC — unrestricted is expressed by
        // simply not configuring modelAccess) is stripped so stale keys
        // don't get re-persisted on the next config save.
        apiKeys: (flat.apiKeys || DEFAULT_CONFIG.apiKeys).map(({ role: _role, ...k }: { role?: unknown; [k: string]: unknown }) => k),
        webAuth: sanitizeWebAuthInput(flat.webAuth),
        // Absent `tiers:` section → the DEFAULT_CONFIG empty tier shells; an
        // explicit `tiers: {}` stays `{}` (truthy). Both leave every pool
        // empty by design (defaults ship no members) — the boot-direct
        // warning points at the /tiers page. Cloned so a future in-place
        // edit cannot poison the module template.
        tiers: flat.tiers || structuredClone(DEFAULT_CONFIG.tiers),
        routing: { ...DEFAULT_CONFIG.routing, ...flat.routing },
        fallback: { ...DEFAULT_CONFIG.fallback, ...flat.fallback },
        // Retired classifier keys (`localModel` / `layer1` — the Layer 1
        // micro-classifier is gone) are stripped alongside the retired Layer 2
        // vendor keys (`provider` / `baseUrl` / `apiKey` — the decision layer now calls
        // a registered model over the System One protocol) so stale values
        // don't get re-persisted on the next console save.
        classifier: {
          layer2: sanitizeLayer2Input(flat.classifier?.layer2),
        },
        routeEntries: sanitizeRouteEntriesInput(flat.routeEntries),
        directives: sanitizeDirectivesInput(flat.directives),
        proxy: sanitizeProxyConfig(flat.proxy ?? DEFAULT_CONFIG.proxy),
        forwardProxy: resolveForwardProxyConfig(flat.forwardProxy),
        compression: {
          rtk: { ...DEFAULT_CONFIG.compression?.rtk, ...flat.compression?.rtk },
          headroom: { ...DEFAULT_CONFIG.compression?.headroom, ...flat.compression?.headroom },
          caveman: { ...DEFAULT_CONFIG.compression?.caveman, ...flat.compression?.caveman },
        },
        requestCapture: resolveRequestCapture(flat),
        tracePersist: { ...DEFAULT_CONFIG.tracePersist, ...flat.tracePersist },
        circuitBreaker: resolveCircuitBreaker(flat),
        rateLimit: resolveRateLimit(flat),
        retry: {
          enabled: flat.retry?.enabled ?? DEFAULT_CONFIG.retry?.enabled,
          inplace: { ...DEFAULT_CONFIG.retry?.inplace, ...flat.retry?.inplace },
          failover: { ...DEFAULT_CONFIG.retry?.failover, ...flat.retry?.failover },
        },
        // RUNTIME carrier only — the disk value never maps; index.ts
        // assigns boot.models over this before registry construction.
        models: DEFAULT_CONFIG.models,
        combos: flat.combos || [],
        modelProfiles: flat.modelProfiles || [],
        clientProfileMemory: flat.clientProfileMemory || {},
        catalog: flat.catalog,
      };
    } catch (err) {
      console.warn(`[Config] Failed to parse ${resolvedPath}, falling back to defaults:`, err);
    }
  }
  return DEFAULT_CONFIG;
}

/**
 * Annotated default-config template: DEFAULT_CONFIG serialized through the
 * same self-documenting comment pipeline as saveConfig(). Single source of
 * truth for what a fresh config.yaml looks like — never a static example
 * file that would drift from DEFAULT_CONFIG / YAML_FIELD_COMMENTS.
 */
export function defaultConfigYaml(): string {
  // `models` is the RUNTIME carrier (index.ts assigns boot.models) — the
  // retired yaml surface must not reappear in the fresh-install template.
  const { models: _omitted, ...template } = DEFAULT_CONFIG;
  // `PORT` is a bootstrap lever (see saveConfig): a template written during a
  // PORT-fed boot (e.g. `bun run dev`) must still name the product default, or
  // that one boot's env value would silently become the env's permanent port.
  template.port = DEFAULT_GATEWAY_PORT;
  // ZERO-COMMENT disk contract (ADR-0016): config.yaml carries values only —
  // field comments are console-rendered on demand (see comments-zh/en.ts).
  return stringify({ schemaVersion: SCHEMA_VERSION, ...toDiskConfig(template) });
}

/**
 * First-boot template initialization: when the active environment has no
 * config.yaml yet, write the annotated default template to disk so a fresh
 * install starts with a self-documenting file instead of silent in-memory
 * defaults plus an empty raw-YAML editor. Idempotent — an existing file is
 * never touched; write failures only warn (the gateway can run purely on
 * in-memory defaults). Called once at gateway boot, deliberately NOT inside
 * loadConfig (which runs on auth hot paths and in tests: no write side
 * effects on a read function).
 */
export function ensureDefaultConfigFile(): { created: boolean; path: string } {
  const configPath = getConfigPath();
  // Every env needs its tree (state dirs + env.json) before the first write
  // lands in it — the bootstrap `default` included. Idempotent.
  try {
    ensureEnvScaffold(resolveEnvName());
  } catch (err: any) {
    console.warn(`[Config] Could not scaffold the environment tree for ${configPath}: ${err.message}`);
  }
  if (fs.existsSync(configPath)) return { created: false, path: configPath };
  try {
    fs.writeFileSync(configPath, defaultConfigYaml(), 'utf8');
    return { created: true, path: configPath };
  } catch (err: any) {
    console.warn(`[Config] Could not write default config template to ${configPath}: ${err.message}`);
    return { created: false, path: configPath };
  }
}

/**
 * Boot-time config schema upgrade (ADR-0016): the ONE place a legacy/older
 * config.yaml is migrated. Runs before the first loadConfig of the process;
 * on success the on-disk file IS the current schema — the runtime read path
 * (loadConfig) never migrates, it only asserts the version.
 *   - file version < current  → migrate the chain, rewrite in place
 *     (`.bak` snapshot first — the raw page's rollback promise), warn the
 *     change list once.
 *   - file version > current  → BOOT ERROR ("upgrade OCR"), same contract as
 *     the env-container import gate; fail-fast, never silent fallback.
 * Idempotent: a current-version file is untouched.
 */
export function upgradeConfigFile(): { migrated: boolean; fromVersion: number } {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return { migrated: false, fromVersion: SCHEMA_VERSION };
  let parsed: unknown;
  try {
    parsed = parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err: any) {
    // Syntax errors are loadConfig's lenient tier — not an upgrade concern.
    return { migrated: false, fromVersion: SCHEMA_VERSION };
  }
  const { disk, fromVersion, warnings, tooNew } = migrateConfig(parsed);
  if (tooNew) {
    throw new Error(
      `config.yaml schemaVersion ${fromVersion} is NEWER than this build supports (current ${SCHEMA_VERSION}). ` +
        `Upgrade OmniCellRouter — refusing to start with a newer schema.`
    );
  }
  if (fromVersion === SCHEMA_VERSION) return { migrated: false, fromVersion };
  try {
    fs.copyFileSync(configPath, `${configPath}.bak`);
    fs.writeFileSync(configPath, stringify(disk), 'utf8');
  } catch (err: any) {
    // Rewrite failure must not brick the boot: loadConfig will see the old
    // version and fall back to defaults with its own warn (same tier as a
    // broken file), and the next boot retries the upgrade.
    console.warn(`[Config] Could not rewrite ${configPath} at schemaVersion ${SCHEMA_VERSION}: ${err.message}`);
    return { migrated: false, fromVersion };
  }
  if (warnings.length > 0) {
    console.warn(`[Config] ${configPath}: config schema upgraded v${fromVersion} → v${SCHEMA_VERSION}:`);
    for (const w of warnings) console.warn(`  - ${w}`);
  }
  return { migrated: true, fromVersion };
}

export function getRawConfig(): string {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    return fs.readFileSync(configPath, 'utf8');
  }
  // No file yet — return the annotated default template so the raw-YAML
  // editor starts from a self-documenting draft; saving it creates the file.
  return defaultConfigYaml();
}

export function saveRawConfig(yamlContent: string): { success: boolean; error?: string } {
  const configPath = getConfigPath();
  try {
    const parsed = parse(yamlContent);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { success: false, error: 'YAML must define an object configuration' };
    }
    // Writers ALWAYS emit the CURRENT schema (ADR-0016): a raw save of an
    // older-format draft (or a hand-copied file pasted into the editor) is
    // migrated + regrouped before it touches disk — annotation comments
    // replace the draft's, matching every other save path. A draft targeting
    // a NEWER schema is refused ("upgrade OCR"). A config.yaml.bak snapshot
    // precedes every overwrite — the raw page's own copy (yaml.desc /
    // savedNotice) promises this backup; keeping the promise true gives
    // hand-edits a manual rollback path (loadConfig itself never rejects: a
    // semantically wrong but syntactically valid file loads leniently, so
    // the .bak is the only undo a raw save ever has).
    const { disk, tooNew, fromVersion, warnings } = migrateConfig(parsed);
    if (tooNew) {
      return {
        success: false,
        error: `config schemaVersion ${fromVersion} is newer than this build supports (current ${SCHEMA_VERSION}) — upgrade OmniCellRouter`,
      };
    }
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, `${configPath}.bak`);
    }
    // schemaVersion is machine-managed (ADR-0016): the operator can misplace
    // it, never lose it. A verbatim write is only allowed when the version key
    // is BOTH current AND the first key; anything else goes through the
    // canonical regroup, which rewrites it first with the current version.
    const firstIsVersion = parsed.schemaVersion === SCHEMA_VERSION && Object.keys(parsed)[0] === 'schemaVersion';
    fs.writeFileSync(configPath, fromVersion === SCHEMA_VERSION && firstIsVersion ? yamlContent : stringify(disk), 'utf8');
    if (warnings.length > 0) {
      console.warn(`[Config] ${configPath}: draft upgraded v${fromVersion} → v${SCHEMA_VERSION}:`);
      for (const w of warnings) console.warn(`  - ${w}`);
    }
    // credentials overlay AND the limiter rule table through the SAME routine as
    // saveConfig (the pre-fix here left the live snapshot stale — the YAML
    // editor violated the module's own hot-apply promise).
    syncRuntimeAuthView(loadConfig());
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Single sync routine for BOTH writers (saveConfig / saveRawConfig): the
 * module docstring above registerRuntimeConfigRef promises "a key edited via
 * the UI OR THE YAML EDITOR" follows immediately — refreshing apiKeys/webAuth
 * (the auth views), the credentials rate-limit overlay (withCredentialHealth badge),
 * the rateLimit grace knob (read boot-snapshot-first per request) and the
 * limiter rule table together is what makes that promise true for every save
 * path, not just the visual one.
 */
function syncRuntimeAuthView(fresh: RouterConfig): void {
  const live = getRuntimeConfigRef();
  if (live) {
    live.apiKeys = fresh.apiKeys;
    live.webAuth = fresh.webAuth;
    live.credentials = fresh.credentials;
    // quotaProbes/quota ride the SAME routine (iron rule: a raw-YAML
    // save must never leave the runtime view stale): the prober reads its
    // entry set off the live ref on every reloadConfig(), and the console
    // quota panel reads rejected/coverage state from it.
    live.quotaProbes = fresh.quotaProbes;
    live.quota = fresh.quota;
    // rateLimit (inbound grace) too: resolveActiveAuthConfig reads the boot
    // snapshot FIRST (`config.rateLimit?.inboundGraceMs ?? disk…` — the disk
    // arm never fires because loadConfig always resolves the section), so
    // without this line the grace knob would silently ignore every save.
    live.rateLimit = fresh.rateLimit;
    // classifier / routing / systemone hot-apply too (per-request reads only —
    // the decision layer resolves model/timeout/effortDecision per evaluate, the mode
    // lever per processInternal, the System One defaultModel per decision):
    // the /auto page's "restart to apply" era is over for everything it edits.
    // Sections with boot-time consumers (streaming executors, models,
    // tiers bootstrap) deliberately stay restart-only.
    live.classifier = fresh.classifier;
    live.routing = fresh.routing;
    live.systemone = fresh.systemone;
    // forwardProxy too — the MITM interceptor and the orchestrator's
    // unresolved-model policy read the live boot snapshot per request
    // (rules, unresolvedModel.onMiss/hosts), so a save must land here or the
    // console's "takes effect immediately" promise is false. Strict credential
    // mode is read from the same object by the gateway plugin host.
    live.forwardProxy = fresh.forwardProxy;
    // proxy policy is hot-applied (initProxyConfig on the save path). Keep
    // the boot snapshot on the same object so a later reader of the live
    // ref does not keep the pre-save endpoint.
    live.proxy = fresh.proxy;
  }
  getRateLimiter().reload(fresh);
  // Rebuild the effective quota plan right after the ref sync (the prober
  // reads cfg.quotaProbes through the same live ref).
  getQuotaProber()?.reloadConfig();
}

export function saveConfig(newConfig: Partial<RouterConfig>): { success: boolean; error?: string } {
  const configPath = getConfigPath();
  try {
    const current = loadConfig();
    // Retired surfaces never re-persist: a stale client (or a hand-built PUT)
    // must not resurrect the removed hand-written `providers[]` section
    // (ADR-0010 — loadConfig already strips it on the read path).
    const bodyRest: Partial<RouterConfig> = { ...newConfig };
    delete (bodyRest as Record<string, unknown>).providers; // retired surface — never re-persists (ADR-0010)
    delete (bodyRest as Record<string, unknown>).models; // runtime carrier only (index.ts assigns boot.models) — never re-persists
    delete (bodyRest as Record<string, unknown>).systemoneUpstreams; // retired native-systemone surface — never re-persists
    if (bodyRest.requestCapture && typeof bodyRest.requestCapture === 'object') {
      // Retired requestCapture.systemone two-gate subtree — never re-persists
      // (a stale client PUT must not resurrect the removed switches).
      delete (bodyRest.requestCapture as Record<string, unknown>).systemone;
    }
    const merged = { ...current, ...bodyRest };
    if (bodyRest.proxy && typeof bodyRest.proxy === 'object') {
      merged.proxy = mergeProxyConfig(current.proxy, bodyRest.proxy);
    }
    // `PORT` is a bootstrap lever, never a file value (see _diskPort): a save
    // that does not itself name a port keeps the file's own value, so a dev
    // boot's env port cannot relocate an installed gateway on its next restart.
    // A file that names no port must stay port-less — deleting the key lets the
    // next boot re-derive it (PORT or DEFAULT_GATEWAY_PORT) instead of freezing
    // this boot's env value into the file.
    if (process.env.PORT?.trim() && bodyRest.port === undefined) {
      if (_diskPort !== undefined) merged.port = _diskPort;
      else delete (merged as Record<string, unknown>).port;
    }
    // `current` comes from loadConfig(): the retired surfaces and the models
    // runtime carrier are already stripped to [] — do not persist empty
    // retired keys into the file (defaultConfigYaml omits them too).
    delete (merged as Record<string, unknown>).models;
    delete (merged as Record<string, unknown>).providers;
    delete (merged as Record<string, unknown>).systemoneUpstreams;
    // webAuth passwordHash preservation: GET /api/admin/config strips the
    // hash, so UI round-trips (SettingsPage saveConfig(config)) would erase
    // it — re-attach the stored hash whenever the incoming payload lacks one.
    if (merged.webAuth && current.webAuth?.passwordHash && !merged.webAuth.passwordHash) {
      merged.webAuth = { ...merged.webAuth, passwordHash: current.webAuth.passwordHash };
    }
    merged.webAuth = sanitizeWebAuthInput(merged.webAuth);
    // One-step undo for EVERY save, not just the raw-page editor: a sanitizer
    // regression once dropped a whole section and the console save persisted
    // the loss with no previous file to restore. Best effort — an absent file
    // (first boot) simply has nothing to back up.
    try {
      fs.copyFileSync(configPath, `${configPath}.bak`);
    } catch {
      /* first write or read-only filesystem */
    }
    // Writers ALWAYS emit the CURRENT schema: the flat runtime merge is
    // regrouped through the single mapping table before serialization
    // (ADR-0016 — a save upgrades the file, there is no downgrade path).
    // ZERO-COMMENT disk contract: values only — comments are console-rendered
    // on demand from comments-zh.ts / comments-en.ts.
    fs.writeFileSync(configPath, stringify({ schemaVersion: SCHEMA_VERSION, ...toDiskConfig(merged) }), 'utf8');
    // Single sync routine for both writers (see syncRuntimeAuthRef doc): the
    // running gateway's key snapshot, the credentials overlay and the limiter
    // rule table follow every save (key CRUD, visual editor, raw YAML — all
    // writers pass through here); windows survive unchanged constraints.
    syncRuntimeAuthView(merged);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── YAML comment annotation ────────────────────────────────────────────────
// loadConfig() parses config.yaml into a plain object, so hand-written comments
// are lost on every visual-config save. saveConfig() therefore re-attaches
// per-field comments from the map below before writing, keeping the on-disk
// file self-documenting. saveRawConfig() writes user YAML verbatim and keeps
// whatever comments the user typed.

