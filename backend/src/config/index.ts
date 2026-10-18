import fs from 'node:fs';
import path from 'node:path';
import { isMap, parse, parseDocument, stringify } from 'yaml';
import { Layer2JudgeConfig, RequestCaptureConfig, RouterConfig, WebAuthConfig, CircuitBreakerConfig, RateLimitConfig } from './types.js';
import { DEFAULT_RETRIABLE_CAUSES } from '../resilience/types.js';
import { ensureEnvScaffold, getEnvPaths, resolveEnvName } from './env.js';
import { getRateLimiter } from '../ratelimit/rate-limiter.js';
import { getQuotaProber } from '../quota/prober.js';

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

const DEFAULT_CONFIG: RouterConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '127.0.0.1',
  adminApiKey: process.env.ROUTER_API_KEY || undefined,
  // First-boot tier members live HERE, not in runtime seeding: defaultConfigYaml()
  // bakes them into every brand-new config.yaml and the loadConfig() fallback
  // below re-applies them when a file has no `tiers:` section at all. One glob
  // per tier over the full `provider/model` id (case-insensitive), mapping the
  // four Claude model families lite→ultra: haiku / sonnet / opus / fable.
  tiers: {
    lite: { members: [{ pattern: '*haiku*' }] },
    plus: { members: [{ pattern: '*sonnet*' }] },
    pro: { members: [{ pattern: '*opus*' }] },
    ultra: { members: [{ pattern: '*fable*' }] },
  },
  routing: { mode: 'smart' },
  fallback: {
    enabled: true,
    maxRetries: 1,
    escalateTier: 'plus',
    injectErrorContext: true,
  },
  classifier: {
    localModel: {
      enabled: false,
      confidenceThreshold: 0.85,
    },
    layer2: {
      enabled: false,
      // No model pinned by default — the judge then follows
      // `systemone.defaultModel`.
      timeoutMs: 1500,
      collectEnabled: false, // dataset sampling: judged decisions → data/layer2-decisions.jsonl (single-key gate, opt-in)
    },
  },
  proxy: {
    enabled: false, // opt-in: proxying only when explicitly enabled
    url: 'http://127.0.0.1:7890',
  },
  forwardProxy: {
    enabled: false, // opt-in: full-capture MITM proxy must be enabled consciously
    port: 4555,
    host: '127.0.0.1',
    bypassHosts: [],
    viaOutboundProxy: false, // opt-in: transit egress via the outbound proxy policy
  },
  compression: {
    rtk: { enabled: false },
    headroom: { enabled: false, url: 'http://127.0.0.1:8787', timeoutMs: 3000, autoStart: false },
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
    maxBodyBytes: 16777216,
    maxSessionMB: 512,
    storeMedia: true,
    // System One group: surface master + judge-leg sub-switch, both default
    // ON — they only matter under the capture master, and a user who turns
    // the master on asked for capture; silence BOTH legs by flipping the
    // group master off, or exempt just the judge leg via the sub-switch.
    systemone: { enabled: true, l2DecisionEnabled: true },
  },
  tracePersist: {
    enabled: true, // default on: console history survives restarts (pure observability data)
    retentionDays: 7,
    maxTotalMB: 100,
  },
  flywheel: {
    // Opt-in: writing user prompts to disk is not a sensible default, and with
    // it on, every `bun test` run appends its fixtures to the production
    // dataset. Existing deployments that set `flywheel.enabled: true` in
    // config.yaml keep collecting — only the implicit default changes.
    enabled: false,
    datasetPath: './data/flywheel.jsonl',
    maxSamples: 100000,
    logUserPrompt: true,
    // Retention knobs default OFF (0 = disabled): a boot + hourly sweep that
    // silently deletes training history with no backup must be an explicit
    // operator decision (docs/design/flywheel-deletion.md D4). Backward
    // compat: deployments without these keys keep never auto-deleting.
    retentionDays: 0,
    maxFileSizeMB: 0,
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    slidingWindowSize: 20,
    failureRateThreshold: 0.5,
    initialCooldownMs: 30000,
    maxCooldownMs: 5 * 3600 * 1000, // 5 hours max cooldown
    cooldownMultiplier: 2.0,
    quotaCooldownMs: 12 * 3600 * 1000, // 12 hours for quota/balance exhaustion
    halfOpenMaxProbes: 1,
    activeProbing: {
      enabled: false,
      intervalMs: 60000,
    },
    accountAffinity: {
      // a session keeps its account while its pair breaker is up;
      // idle past this window it re-spreads like a new session (the upstream
      // prompt cache is gone by then anyway). 300000 = Anthropic cache TTL.
      cacheTtlMs: 300000,
    },
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
      maxRateLimitWaitMs: 2000,
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
  providers: [],
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
 * `baseUrl`, `apiKey`) left over from the pre-System-One judge, which talked
 * to a hand-configured vendor endpoint. The judge now addresses a REGISTERED
 * model through the gateway's own System One protocol, so those
 * keys are meaningless — and keeping them would re-persist dead settings on
 * every console save. `decisionCapture` joins the drop list after the
 * dataset-sampling move to classifier.layer2.collectEnabled (old key ignored).
 */
function sanitizeLayer2Input(input: unknown): Layer2JudgeConfig {
  const merged = { ...DEFAULT_CONFIG.classifier?.layer2, ...(input as Layer2JudgeConfig) } as Layer2JudgeConfig & {
    provider?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    decisionCapture?: unknown;
  };
  delete merged.provider;
  delete merged.baseUrl;
  delete merged.apiKey;
  delete merged.decisionCapture;
  return merged;
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
  const sysRaw = raw.systemone as Record<string, unknown> | undefined;
  return {
    enabled: pick('enabled'),
    retentionDays: pickPositive('retentionDays'),
    maxTotalMB: pickPositive('maxTotalMB'),
    maxBodyBytes: pickPositive('maxBodyBytes'),
    maxSessionMB: pickPositive('maxSessionMB'),
    // boolean needs the ?? chain (false must survive); deliberately NOT in the
    // pick union, which now types only the boolean/string keys.
    storeMedia: (raw.storeMedia ?? base.storeMedia) as boolean,
    dir: pick('dir'),
    systemone: {
      enabled: (sysRaw?.enabled ?? base.systemone?.enabled) as boolean,
      l2DecisionEnabled: (sysRaw?.l2DecisionEnabled ?? base.systemone?.l2DecisionEnabled) as boolean,
    },
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
  const scope = (v: unknown): 'auto' | 'pair' | 'account' | 'model' =>
    v === 'pair' || v === 'account' || v === 'model' ? v : 'auto';
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
 * are `apiKeys[].limits` / the `accounts:` overlay). Junk falls back to the
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

export function loadConfig(configPath?: string): RouterConfig {
  const resolvedPath = getConfigPath(configPath);
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = parse(raw);
      // Removed keys (retired systems: `rules:`, `classifier.layer2.decisionCapture`,
      // the renamed `capture:` section, key-level `role`) are STRIPPED here so
      // stale keys never re-persist on the next config save. No dual-read, no
      // migration — the config tree is the only source of truth.
      const {
        rules: _removedRules,
        capture: _removedCapture,
        ...parsedRest
      } = parsed || {};
      return applyTestEnvOverrides({
        ...DEFAULT_CONFIG,
        ...parsedRest,
        // `role` (removed key-level RBAC — unrestricted is expressed by
        // simply not configuring modelAccess) is stripped so stale keys
        // don't get re-persisted on the next config save.
        apiKeys: (parsed?.apiKeys || DEFAULT_CONFIG.apiKeys).map(({ role: _role, ...k }: { role?: unknown; [k: string]: unknown }) => k),
        webAuth: sanitizeWebAuthInput(parsed?.webAuth),
        // Absent `tiers:` section → ship the DEFAULT_CONFIG template members
        // (the 4 glob rules); an explicit `tiers: {}` stays `{}` (truthy) —
        // empty pools + the boot-direct warning, the operator's own choice.
        // Cloned so a future in-place edit cannot poison the module template.
        tiers: parsed?.tiers || structuredClone(DEFAULT_CONFIG.tiers),
        routing: { ...DEFAULT_CONFIG.routing, ...parsed?.routing },
        fallback: { ...DEFAULT_CONFIG.fallback, ...parsed?.fallback },
        classifier: {
          localModel: { ...DEFAULT_CONFIG.classifier?.localModel, ...parsed?.classifier?.localModel },
          // Retired Layer 2 vendor keys (`provider` / `baseUrl` / `apiKey` — the
          // judge now calls a registered model over the System One protocol)
          // are stripped so stale values don't get re-persisted on
          // the next console save.
          layer2: sanitizeLayer2Input(parsed?.classifier?.layer2),
        },
        flywheel: { ...DEFAULT_CONFIG.flywheel, ...parsed?.flywheel },
        proxy: { ...DEFAULT_CONFIG.proxy, ...parsed?.proxy },
        forwardProxy: { ...DEFAULT_CONFIG.forwardProxy, ...parsed?.forwardProxy },
        compression: {
          rtk: { ...DEFAULT_CONFIG.compression?.rtk, ...parsed?.compression?.rtk },
          headroom: { ...DEFAULT_CONFIG.compression?.headroom, ...parsed?.compression?.headroom },
          caveman: { ...DEFAULT_CONFIG.compression?.caveman, ...parsed?.compression?.caveman },
        },
        requestCapture: resolveRequestCapture(parsed),
        tracePersist: { ...DEFAULT_CONFIG.tracePersist, ...parsed?.tracePersist },
        circuitBreaker: resolveCircuitBreaker(parsed),
        rateLimit: resolveRateLimit(parsed),
        retry: {
          enabled: parsed?.retry?.enabled ?? DEFAULT_CONFIG.retry?.enabled,
          inplace: { ...DEFAULT_CONFIG.retry?.inplace, ...parsed?.retry?.inplace },
          failover: { ...DEFAULT_CONFIG.retry?.failover, ...parsed?.retry?.failover },
        },
        providers: parsed?.providers || DEFAULT_CONFIG.providers,
        models: parsed?.models || DEFAULT_CONFIG.models,
        combos: parsed?.combos || [],
        modelProfiles: parsed?.modelProfiles || [],
        clientProfileMemory: parsed?.clientProfileMemory || {},
        catalog: parsed?.catalog,
      });
    } catch (err) {
      console.warn(`[Config] Failed to parse ${resolvedPath}, falling back to defaults:`, err);
    }
  }
  return applyTestEnvOverrides(DEFAULT_CONFIG);
}

/**
 * Test-run guard for the flywheel collector.
 *
 * `bun test` sets NODE_ENV=test, and the test process loads the REAL config.yaml
 * — where operators reasonably keep `flywheel.enabled: true` for live traffic.
 * Without this override, every test run appends its fixtures to the production
 * dataset (observed: 6,600+ synthetic rows accumulated alongside 8 real ones).
 * Only the flywheel switch is forced off; every other config value is passed
 * through untouched, and tests that exercise the collector directly construct
 * FlywheelCollector with an explicit config + temp path, bypassing loadConfig.
 */
function applyTestEnvOverrides(cfg: RouterConfig): RouterConfig {
  if (process.env.NODE_ENV !== 'test') return cfg;
  return { ...cfg, flywheel: { ...cfg.flywheel, enabled: false } };
}

/**
 * Annotated default-config template: DEFAULT_CONFIG serialized through the
 * same self-documenting comment pipeline as saveConfig(). Single source of
 * truth for what a fresh config.yaml looks like — never a static example
 * file that would drift from DEFAULT_CONFIG / YAML_FIELD_COMMENTS.
 */
export function defaultConfigYaml(): string {
  return annotateYamlComments(stringify(DEFAULT_CONFIG));
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
    // config.yaml.bak snapshot BEFORE overwriting — the raw page's own copy
    // (yaml.desc / savedNotice) promises this backup; keeping the promise true
    // gives hand-edits a manual rollback path (loadConfig itself never
    // rejects: a semantically wrong but syntactically valid file loads
    // leniently, so the .bak is the only undo a raw save ever has).
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, `${configPath}.bak`);
    }
    fs.writeFileSync(configPath, yamlContent, 'utf8');
    // The raw save is a config save too: refresh the auth snapshot view, the
    // accounts overlay AND the limiter rule table through the SAME routine as
    // saveConfig (the pre-fix here left runtimeConfigRef stale — the YAML
    // editor violated the module's own hot-apply promise).
    syncRuntimeAuthView(loadConfig());
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Live reference to the RUNNING server's config object (registered by
 * createServer). The auth preHandler prefers `config.apiKeys` over a fresh
 * disk read (boot snapshot) — without syncing, a key edited via the UI or the
 * YAML editor would persist to config.yaml yet keep failing on the wire until
 * the next restart. Every config save refreshes the snapshot's keys in-place.
 */
let runtimeConfigRef: RouterConfig | undefined;

/** Called once by createServer so config saves can refresh the boot snapshot. */
export function registerRuntimeConfigRef(cfg: RouterConfig): void {
  runtimeConfigRef = cfg;
}

/**
 * Live config snapshot (createServer's object, hot-synced by saveConfig for
 * the fields the running gateway reads per request: apiKeys, webAuth).
 * Console-auth endpoints prefer it over a disk re-read so the gate and the
 * credential checks can never disagree.
 */
export function getRuntimeConfigRef(): RouterConfig | undefined {
  return runtimeConfigRef;
}

/**
 * Single sync routine for BOTH writers (saveConfig / saveRawConfig): the
 * module docstring above registerRuntimeConfigRef promises "a key edited via
 * the UI OR THE YAML EDITOR" follows immediately — refreshing apiKeys/webAuth
 * (the auth views), the accounts rate-limit overlay (withAccountHealth badge),
 * the rateLimit grace knob (read boot-snapshot-first per request) and the
 * limiter rule table together is what makes that promise true for every save
 * path, not just the visual one.
 */
function syncRuntimeAuthView(fresh: RouterConfig): void {
  if (runtimeConfigRef) {
    runtimeConfigRef.apiKeys = fresh.apiKeys;
    runtimeConfigRef.webAuth = fresh.webAuth;
    runtimeConfigRef.accounts = fresh.accounts;
    // quotaProbes/quota ride the SAME routine (iron rule: a raw-YAML
    // save must never leave the runtime view stale): the prober reads its
    // entry set off the live ref on every reloadConfig(), and the console
    // quota panel reads rejected/coverage state from it.
    runtimeConfigRef.quotaProbes = fresh.quotaProbes;
    runtimeConfigRef.quota = fresh.quota;
    // rateLimit (inbound grace) too: resolveActiveAuthConfig reads the boot
    // snapshot FIRST (`config.rateLimit?.inboundGraceMs ?? disk…` — the disk
    // arm never fires because loadConfig always resolves the section), so
    // without this line the grace knob would silently ignore every save.
    runtimeConfigRef.rateLimit = fresh.rateLimit;
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
    const merged = { ...current, ...newConfig };
    // webAuth passwordHash preservation: GET /api/admin/config strips the
    // hash, so UI round-trips (SettingsPage saveConfig(config)) would erase
    // it — re-attach the stored hash whenever the incoming payload lacks one.
    if (merged.webAuth && current.webAuth?.passwordHash && !merged.webAuth.passwordHash) {
      merged.webAuth = { ...merged.webAuth, passwordHash: current.webAuth.passwordHash };
    }
    merged.webAuth = sanitizeWebAuthInput(merged.webAuth);
    const yamlContent = annotateYamlComments(stringify(merged));
    fs.writeFileSync(configPath, yamlContent, 'utf8');
    // Single sync routine for both writers (see syncRuntimeAuthRef doc): the
    // running gateway's key snapshot, the accounts overlay and the limiter
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

const YAML_FILE_HEADER = [
  'OpenCode Router 网关配置（config.yaml）',
  '可视化编辑：控制台「可视化配置」页；手写编辑：「配置文件」页（原文保存，注释保留）',
  '注意：大部分配置保存即时生效（代理/捕捉/梯队/组合/熔断/限流等，逐项见注释）；标注「重启网关生效」的段落需重启；价格单位均为 美元/百万 tokens',
].join('\n');

/** yaml pkg renders commentBefore verbatim after '#', so pad one space per line ourselves. */
const padComment = (text: string) => ' ' + text.replace(/\n/g, '\n ');

/** Field path (dotted, relative to root) → zh-CN comment. `tiers.*` covers any tier name. */
const YAML_FIELD_COMMENTS: Record<string, string> = {
  port: '网关监听端口',
  host: '监听地址（默认 127.0.0.1 仅本机；0.0.0.0 = 监听所有网卡，非回环绑定强制启用 webAuth 登录）',
  adminApiKey: '推理面主密钥（/v1/* 全模型访问），亦可作为控制台 /api/admin/* 的程序化访问凭据（Authorization: Bearer）',
  webAuth: '控制台登录鉴权（/admin 管理面的账号密码；绑定非回环地址时强制启用）',
  'webAuth.enabled': '控制台登录开关：true 需账号密码登录；绑定 0.0.0.0 / 局域网 IP 时必须为 true（否则网关拒绝启动），仅 127.0.0.1 绑定可关闭',
  'webAuth.username': '控制台登录用户名',
  'webAuth.passwordHash': '登录密码的 scrypt 哈希（格式 scrypt$<saltHex>$<hashHex>，绝不存明文；在控制台「系统设置」页修改，勿手写）',
  tiers: '梯队成员策略：候选池唯一依据 = 各梯队显式 members 成员列表 + 全局排除名单；默认模板为每个梯队内置 1 条 glob 成员（haiku→lite / sonnet→plus / opus→pro / fable→ultra，运行时不再自动生成种子，删除整个 tiers 段会在下次加载时恢复这套模板默认）；无任何规则命中的模型=未分类，不进任何池；主选策略只影响池内用法（控制台 /tiers 页可视化编辑，保存即时生效）',
  'tiers.*.members': '成员列表（顺序=优先级/failover 链）：每项 { pattern, weight?, effortMap? } —— pattern 匹配完整模型 id（provider/model），glob 通配（* 任意 / ? 单字符，不区分大小写），不带通配符=子串匹配、写完整 id=单项；effortMap=思考级别翻译（如 { none: high, low: high }，未配置的级别原样透传）；同一模型只归属一个梯队（跨档重叠按 lite→plus→pro→ultra 先得，保存时提示）',
  'tiers.exclude': '全局排除名单（在原始 YAML 页编辑；/tiers 页保存时原样回传）：命中的模型不进入任何梯队候选池（无条件；仅可按 id 直连或经组合调用）',
  'tiers.*.selection': '主选策略：priority 优先级 / weighted 加权随机 / round_robin 轮询',
  'tiers.*.match': '【仅匹配建议引擎】不参与路由、不再生成成员列表：用于模型目录页推荐、/tiers 页预览与保存时检查；候选池唯一依据是上方 members，默认模板已内置四档 glob（haiku→lite / sonnet→plus / opus→pro / fable→ultra），请在控制台 /tiers 页增删成员（保存即时生效）',
  'tiers.*.match.patterns': '【仅匹配建议引擎】名称通配符（glob）',
  'tiers.*.match.minInputPerM': '【仅匹配建议引擎】输入价下限 $/M',
  'tiers.*.match.maxInputPerM': '【仅匹配建议引擎】输入价上限 $/M',
  'tiers.*.match.exclude': '【仅匹配建议引擎】名称/价格否决（不给出该梯队建议）',
  'tiers.*.match.excludeTiers': '【仅匹配建议引擎】锚定排除（被引梯队的条件命中即否决）',
  routing: '路由模式：smart=分类级联（默认）/ cost=始终 lite / quality=始终 pro',
  fallback: '失败兜底：重试耗尽后按梯队升级重试',
  'fallback.maxRetries': '兜底重试次数',
  'fallback.escalateTier': '兜底升级目标梯队',
  'fallback.injectErrorContext': '兜底请求是否注入上游错误上下文',
  classifier: '意图分类器（smart 模式的 lite/pro/ultra 判定）',
  'classifier.localModel.enabled': '本地分类模型开关',
  'classifier.localModel.confidenceThreshold': '置信度阈值（低于则交给 layer2 判定）',
  'classifier.layer2.enabled': 'Layer2 判定开关（经本机 System One 协议调用已注册模型）',
  'classifier.layer2.model': '判定模型 id（已注册的模型；留空则用 systemone.defaultModel）',
  'classifier.layer2.timeoutMs': '判定超时（毫秒，超时放行 Layer1 结果）',
  'classifier.layer2.decisionCache': '判定决策缓存（相同上下文复用判定结果）',
  'classifier.layer2.collectEnabled': 'L2 裁判决策样本采集开关（默认 false 关闭）：单键门控，落盘 data/layer2-decisions.jsonl（不进捕捉页），64MB 封顶后停写并告警一次；热生效',
  flywheel: '学习飞轮（路由决策样本沉淀，用于训练分类器；默认关闭）',
  'flywheel.datasetPath': '样本数据集路径（JSONL）',
  'flywheel.maxSamples': '样本条数上限',
  'flywheel.logUserPrompt': '是否记录用户提示词原文（隐私敏感）',
  'flywheel.retentionDays': '样本保留天数（0 或不填=不自动清理；启用后启动时+每小时自动删除超龄样本；自动清理不生成备份、删除不可恢复，请谨慎设置）',
  'flywheel.maxFileSizeMB': '数据集文件大小上限 MB（0 或不填=不限制；超出后从最旧样本开始裁剪；在保留天数清理之后执行；自动清理不生成备份）',
  'circuitBreaker': '熔断器（按模型统计失败并自动摘除，见 /guardrails 页）；规则组 rules 可逐条开关并覆写参数，保存后即时生效（无需重启；仅 persistence.debounceMs 需重启）',
  'circuitBreaker.failureThreshold': '窗口内失败次数阈值（达到即熔断）；rules.trip.consecutiveFailures.threshold 未设置时的全局默认值',
  'circuitBreaker.slidingWindowSize': '滑动窗口样本数；rules.trip.failureRate.windowSize 未设置时的全局默认值',
  'circuitBreaker.failureRateThreshold': '失败率阈值（0-1）；rules.trip.failureRate.failureRate 未设置时的全局默认值',
  'circuitBreaker.initialCooldownMs': '首次熔断冷却时长（毫秒）；各规则冷却参数未设置时的全局默认值',
  'circuitBreaker.maxCooldownMs': '冷却时长上限（毫秒），任何推导冷却（含 429 Retry-After 钳制）的总封顶',
  'circuitBreaker.cooldownMultiplier': '连续熔断的冷却指数退避倍数；rules.trip.consecutiveFailures.cooldownMultiplier 与 rules.recovery.cooldownMultiplier 未设置时的默认值',
  'circuitBreaker.quotaCooldownMs': '配额/余额耗尽专用冷却时长（毫秒）；rules.trip.quota/auth.cooldownMs 未设置时的默认值',
  'circuitBreaker.halfOpenMaxProbes': '半开状态最大并发探测数；rules.recovery.halfOpen.maxProbes 未设置时的默认值（同时是主动探测每模型每周期的预算，下限 1）',
  'circuitBreaker.activeProbing': '主动探测（冷却期内定时试探是否恢复）',
  'circuitBreaker.activeProbing.intervalMs': '探测间隔（毫秒）',
  'circuitBreaker.accountAffinity': '会话账号亲和（多账号供应商：会话绑定一个账号，仅故障转移时切换，绝不负载均衡）',
  'circuitBreaker.accountAffinity.cacheTtlMs': '亲和窗口（毫秒，默认 300000 = Anthropic 提示缓存 5 分钟）；空闲超过此窗口的会话按新会话重新分散选号',
  'circuitBreaker.rules': '熔断规则组，阅读顺序=因果链：counting 计不计入失败 → trip 何时熔断 → recovery 如何恢复；每项缺省=沿用上方全局旋钮/当前行为；整段缺省与旧版行为逐字节一致；保存后即时生效（新规则从下一次判定起生效，已有熔断状态不回溯重评）',
  'circuitBreaker.rules.counting': 'A 区：哪些错误算失败（计入 trip 规则），各自熔断的最短时长（minCooldownMs 下限，经 max(下限, 计算值) 生效）',
  'circuitBreaker.rules.counting.serverErrors': '5xx/网络抖动（SERVICE_UNAVAILABLE）计入开关+冷却下限；关闭=既不熔断也不计数（默认开，下限默认=initialCooldownMs）',
  'circuitBreaker.rules.counting.serverErrors.enabled': '关闭后 5xx/抖动不再计入熔断统计',
  'circuitBreaker.rules.counting.serverErrors.minCooldownMs': '此类失败触发的熔断不短于该毫秒数（默认=initialCooldownMs）',
  'circuitBreaker.rules.counting.unknownErrors': '未分类上游错误计入开关+冷却下限（默认开，下限默认=initialCooldownMs）',
  'circuitBreaker.rules.counting.unknownErrors.enabled': '关闭后未分类错误不再计入熔断统计',
  'circuitBreaker.rules.counting.unknownErrors.minCooldownMs': '此类失败触发的熔断不短于该毫秒数（默认=initialCooldownMs）',
  'circuitBreaker.rules.counting.rateLimitErrors': '429 的计入性无开关（分类器始终计数）；本键只拥有“无 Retry-After 时”的冷却下限（默认 min(60000, initialCooldownMs)）',
  'circuitBreaker.rules.counting.rateLimitErrors.minCooldownMs': '无 Retry-After 的 429 计入后的熔断冷却下限（毫秒）；带 Retry-After 的沿用其推导值',
  'circuitBreaker.rules.counting.clientErrors': '400/422 客户端错误是否计入失败（默认关=现行为不惩罚；开启后按 trip 规则自身阶梯计）',
  'circuitBreaker.rules.counting.clientErrors.enabled': '开启后 400/422 计入熔断统计（不建议：客户端问题不应惩罚上游）',
  'circuitBreaker.rules.trip': 'B 区：计数到的失败何时打开熔断；scope=blast 半径覆写 auto|pair|account|model（仅在有凭据归属时生效，无链供应商自然退化为模型级）；五个开关全部关闭=自动熔断彻底关闭（手动熔断不受影响）',
  'circuitBreaker.rules.trip.quota': '402/配额措辞 → 立即熔断（默认开）；关闭=402 既不熔断也不计数，并会释放存量 breaker.quota 熔断记录（保存时与重启恢复时均对账丢弃）',
  'circuitBreaker.rules.trip.quota.enabled': '关闭后 402 不再自动熔断',
  'circuitBreaker.rules.trip.quota.cooldownMs': '402 硬熔断时长（毫秒，默认=quotaCooldownMs 12h）',
  'circuitBreaker.rules.trip.quota.scope': 'blast 半径覆写：auto=按错误类型（402 默认 account=该凭据全部模型）/ pair=仅模型×该凭据 / account=该凭据全部模型 / model=该模型全部凭据',
  'circuitBreaker.rules.trip.auth': '401 → 立即熔断（默认开）；关闭=401 既不熔断也不计数，并释放存量 breaker.auth 记录',
  'circuitBreaker.rules.trip.auth.enabled': '关闭后 401 不再自动熔断',
  'circuitBreaker.rules.trip.auth.cooldownMs': '401 硬熔断时长（毫秒，默认=quotaCooldownMs 12h）',
  'circuitBreaker.rules.trip.auth.markSuspect': '熔断时把该账号标记为 SUSPECT（默认开）；关闭只停止新标记——已存在的标记仍拦截选路，直到手动清除',
  'circuitBreaker.rules.trip.auth.scope': 'blast 半径覆写（401 默认 account）；见 rules.trip 说明',
  'circuitBreaker.rules.trip.rateLimit': '429 带 Retry-After 且超过 hardTripAboveMs → 硬熔断；关闭=此类 429 降级为“计入统计的失败”（不是忽略），其 Retry-After 推导下限照常流入 max(下限, 计算值)',
  'circuitBreaker.rules.trip.rateLimit.enabled': '关闭后长 Retry-After 的 429 不再硬熔断，只计入统计失败',
  'circuitBreaker.rules.trip.rateLimit.hardTripAboveMs': '硬/软分界（毫秒）：Retry-After 超过它才硬熔断；默认=retry.inplace.maxRateLimitWaitMs（覆写后与重试侧分界脱钩，属有意分歧）',
  'circuitBreaker.rules.trip.rateLimit.minCooldownMs': 'Retry-After 推导冷却的下限（毫秒，默认 1000；总封顶仍是全局 maxCooldownMs）',
  'circuitBreaker.rules.trip.rateLimit.scope': 'blast 半径覆写（429 默认 pair；“每日/每周额度”措辞默认 account）；见 rules.trip 说明',
  'circuitBreaker.rules.trip.consecutiveFailures': '连续失败达阈值 → 熔断（默认开）；关闭=连续阈值不再检查；阶梯：initialCooldownMs×cooldownMultiplier^n，封顶 maxCooldownMs',
  'circuitBreaker.rules.trip.consecutiveFailures.enabled': '关闭后不再按“连续失败次数”自动熔断',
  'circuitBreaker.rules.trip.consecutiveFailures.threshold': '连续失败次数阈值（默认=failureThreshold 3）',
  'circuitBreaker.rules.trip.consecutiveFailures.initialCooldownMs': '阶梯首档冷却（毫秒，默认=initialCooldownMs）',
  'circuitBreaker.rules.trip.consecutiveFailures.cooldownMultiplier': '阶梯倍数（默认=cooldownMultiplier 2.0）',
  'circuitBreaker.rules.trip.consecutiveFailures.maxCooldownMs': '阶梯封顶（毫秒，默认=maxCooldownMs 5h）',
  'circuitBreaker.rules.trip.consecutiveFailures.scope': 'blast 半径覆写（计入统计类失败默认按分类器 scope：5xx=account、未分类=pair）；见 rules.trip 说明',
  'circuitBreaker.rules.trip.failureRate': '滑动窗口失败率 → 熔断（默认开）；关闭=窗口速率不再检查；速率仅在已记录调用数 >= minCalls 时评估',
  'circuitBreaker.rules.trip.failureRate.enabled': '关闭后不再按“窗口失败率”自动熔断',
  'circuitBreaker.rules.trip.failureRate.windowSize': '共享结果环形缓冲大小（默认=slidingWindowSize 20；是熔断器构造参数，改变会影响持久化窗口切片）',
  'circuitBreaker.rules.trip.failureRate.failureRate': '失败率阈值（0-1 小数，默认=failureRateThreshold 0.5）',
  'circuitBreaker.rules.trip.failureRate.minCalls': '评估速率所需的最少已记录调用数（默认=windowSize 即旧版“满窗才判”，下限 0，封顶 windowSize；调低可在稀疏流量上更快熔断）',
  'circuitBreaker.rules.trip.failureRate.cooldownMs': '速率熔断时长（毫秒，默认=initialCooldownMs）',
  'circuitBreaker.rules.trip.failureRate.scope': 'blast 半径覆写；见 rules.trip 说明（与 consecutiveFailures 同时覆写时，前者优先——两条规则共用一次记录）',
  'circuitBreaker.rules.recovery': 'C 区：已熔断模型如何恢复；半开试航=最多 maxProbes 个并发探测，成功累计到 successThreshold 才完全恢复（CLOSED）',
  'circuitBreaker.rules.recovery.onCanaryFailure': '探测失败/试航批次未达标/半开超时后的去向：backoff=阶梯加倍再熔（现行）/ initial=按阶梯首档重新熔 / close=乐观恢复（保留 consecutiveFailures 与当前阶梯，下次失败即以更高档重熔；手动熔断无视 close，必定重新打开）',
  'circuitBreaker.rules.recovery.cooldownMultiplier': 'backoff 去向的阶梯倍数（默认=cooldownMultiplier 2.0）',
  'circuitBreaker.rules.recovery.halfOpen': '半开试航参数；maxProbes 同时是主动探测每模型每周期预算',
  'circuitBreaker.rules.recovery.halfOpen.maxProbes': '半开并发探测预算（默认=halfOpenMaxProbes 1；下限 1——0 会饿死恢复通道）',
  'circuitBreaker.rules.recovery.halfOpen.successThreshold': '半开恢复所需成功探测数（默认 1=首成即闭；封顶 maxProbes）',
  'circuitBreaker.rules.recovery.halfOpen.maxWaitMs': '半开最长停留时间（毫秒，默认 0=永久等待，现行）；超时按 onCanaryFailure 去向处理',
  'circuitBreaker.shadow': '影子模式：规则照常评估、照常熔断记录/快照/事件（试航槽、阶梯、窗口全部真实推进），但 canExecute/peek 绝不拦流量；手动 OPEN、DISABLED、SUSPECT 不受影子豁免；用于上线前验证规则',
  'circuitBreaker.persistence': '熔断状态落盘策略',
  'circuitBreaker.persistence.debounceMs': 'breaker-state 文件写入去抖间隔（毫秒，默认 1000；崩溃丢失窗口即此去抖时长）',
  retry: '重试策略',
  'retry.inplace': '原地重试（同一模型）',
  'retry.inplace.maxAttempts': '额外重试次数',
  'retry.inplace.backoffMs': '重试基础退避（毫秒）',
  'retry.inplace.jitterMs': '退避随机抖动（毫秒）',
  'retry.inplace.retryOnCauses': '触发重试的错误类型',
  'retry.inplace.maxRateLimitWaitMs': '429 Retry-After 最大等待（毫秒）',
  'retry.failover': '故障转移（切换候选模型重试）',
  'retry.failover.maxAttempts': '故障转移尝试次数',
  'retry.failover.tierCrossPolicy': '跨梯队策略：allow_escalate 允许向上升级',
  rateLimit: '限流策略开关（窗口本身在 apiKeys[].limits 与 accounts: 叠加层）',
  'rateLimit.persist': '已触发限流事件账本的持久化：写入 traces.db（与 trace/FinOps 共库独立句柄），重启后 /rate-limit 页仍可回看上一次的触发历史；观测性写入 fail-open，永不阻塞请求路径',
  'rateLimit.persist.enabled': '账本持久化开关（默认开）；关闭=仅内存环（重启清零）',
  'rateLimit.inboundGraceMs': '宽限等待（毫秒，默认 1000，上限 2000，0=关闭）：客户端密钥窗口满、但重开等待不超过该值时，网关原地等待窗口重开后复查一次（不循环），复查仍满或等待超限才回 429 + Retry-After——吸收亚秒级突发，避免短限流变成用户可见错误；长窗口维持快速失败：限流契约不变，等待归属客户端自己的退避',
  apiKeys: '客户端接入密钥（sk-ocr-*，见 /keys 页）；每个密钥可配 limits=入站滑动窗口限流，规则项 { window, requests | tokens | costUsd }（window 用时长语法 30s/5m/1h/1d；同一项可写多个维度=各自独立计数；任一窗口满即拒——宽限等待内（rateLimit.inboundGraceMs）先原地等满复查一次，否则 429 + Retry-After；被拒请求不计入窗口；保存即时生效）；requests 维度覆盖全部四条推理线（前向代理 MITM 腿不经该入口、不入站计量）；tokens/costUsd 在 chat 形态线（chat/messages/responses）与 systemone 决策线均于完成时记账（决策线以协议 usage 为准，上游未带 usage 的 native 应答只计 requests）',
  accounts: '模型账户限流叠加层（原始 YAML 页编辑，保存即时生效）：按 provider id 分组，每项 { keyHashPrefix, limits } —— keyHashPrefix 是该凭据 sha256 的前 12 位（控制台凭据卡片可见，与账号增删改名无关；大小写不敏感——编译/匹配时归一，磁盘保留原文）；limits 规则语法同 apiKeys（滑动窗口；requests=请求数、tokens=消耗 token 数、costUsd=费用美元，按完成时刻记账）；出站限流只做整形：超限账号在 NEW 会话选号时跳过、绝不改动已绑定会话（重绑会烧上游提示缓存）、候选耗尽时末位强制放行，真正的上游 429 仍由熔断器处理决策线例外：/v1/systemone 不经候选池——不做本地跳过/拒绝、也不经熔断，上游错误逐字透传；但该线的出站 dispatch 与完成记账照常计入，账户窗口会被它填充。内部腿（L2 裁判、健康探测）的上游调用不经任何记账，不会填充窗口',
  'accounts.*': '该 provider 的账号规则列表（键=provider id，如 anthropic）；条目 { keyHashPrefix, limits }',
  quota: '额度探测调度：额度覆盖表与代码 adapter 随 release 内置，此处只调调度器；凭据出现即自动探测（激活随凭据），探测失败≠额度失败——保留旧值置 stale，绝不触发熔断/下架；声明上限只展示、不门控路由',
  'quota.enabled': '额度探测总开关（默认 true）；false = 停止一切出网额度探测（已存快照仍可展示，标注 stale 逻辑不变）',
  'quota.intervalMs': '调度 tick（毫秒，默认 60000，钳制 [10000, 3600000]）；每条目另有 cacheTtl 钳制 [60s, 24h] 的到期窗口 + 抖动，429 触发引擎级全局退避（非条目字段）',
  quotaProbes: '自定义额度探测（长尾/自建网关，原始 YAML 页编辑，保存即时生效）：按 provider id 分组，条目 { url, windows, headers?, cacheTtlMs?, successIf?, override?, forkedFrom?, verifiedAt? } —— 铁律（仅约束本层）：url 只写相对路径且解析后必须落在该 provider 推理 baseURL 的 origin 内（拒 ../ / / 协议头）；认证固定复用推理同款 Bearer（需拼装/换 scheme/派生头的服务商走内置代码 adapter，不进本表）；GET-only；1 条目=1 URL；覆盖内置条目必须显式 override: <内置条目 id>（静默遮蔽被拒加载），fork 条目带 forkedFrom+verifiedAt 血统戳。windows 声明式抽取（12 构件：static/each/eachObject 三形态、firstOf、used/total/remaining 二推三、invert、scale、where 仅限存在/相等/∈、名称模板+枚举映射、静态 headers、successIf 单等值、unlimited、headers 取数、秒/毫秒/ISO 时间判别；算术/跨调用注入/值比较/正则/时间差/按URL反义/头值插值 七类禁例出现即整条拒绝加载并在控制台额度页显示原因）',
  'quotaProbes.*': '该 provider 的探测条目数组（键=provider id，如 my-gateway）；每条目一张窗口表：windows { form: static|each|eachObject, path?, window|windows, plan? } —— 字段抽取 { path | header | literal, firstOf?, scale?, invertOf?, time? }；used/total/remaining 任二者可推第三；where 仅限存在/相等/∈ 三谓词；名称 nameSpec { from, enumMap, fallback } 或 template 纯插值（{field}）；successIf 单等值',
  opencode: 'OpenCode 本地服务连接',
  proxy: '出站代理策略（保存后即时生效，无需重启；作用于上游模型调用 / Layer2 判定 / 目录与 logo 同步；localhost/127.0.0.1 永不走代理）',
  'proxy.enabled': '出站代理总开关（默认 false 不启用；true 时按 url 与包含/排除规则出站）',
  'proxy.url': '全局代理 URL，http(s)://[user:pass@]host:port —— 需要鉴权时把用户名:密码嵌在 @ 前（自动转为 Proxy-Authorization，含 HTTPS CONNECT 隧道；特殊字符需 URL 编码）；留空 = 直连',
  'proxy.includes': '包含规则（glob）：非空时仅命中者走代理；pattern 匹配 provider/model 组合与模型 id —— anthropic/* 为 provider 级，*/claude-* 或 claude-* 为模型级',
  'proxy.excludes': '排除规则（glob）：命中者强制直连；与 includes 同设时先执行（excludes 命中 = 直连，其余再按 includes 过滤）',
  forwardProxy: '入站前向代理（HTTP_PROXY/HTTPS_PROXY 服务端）：默认全量接管——解密后的 LLM 协议流量（chat/messages/responses）走路由管线，其余透明转发；loopback 与 bypassHosts 命中者纯隧道透传；需在被代理客户端信任导出的 CA（重启网关生效）',
  'forwardProxy.enabled': '入站代理总开关（默认 false）',
  'forwardProxy.port': '代理监听端口（默认 4555；客户端 HTTP_PROXY/HTTPS_PROXY 指向 http://127.0.0.1:4555）',
  'forwardProxy.host': '代理监听地址（默认 127.0.0.1，仅本机）',
  'forwardProxy.bypassHosts': '例外主机（glob）：纯字符串 = 直连隧道；{ host, viaProxy: true } = 经出站代理隧道（逐主机勾选）；loopback 永远绕过',
  'forwardProxy.caDir': 'MITM CA 存放目录（默认 ~/.opencode-router/forward-proxy）',
  'forwardProxy.viaOutboundProxy': '非例外主机的转发请求（未被拦截接管的 GET 等）是否经出站代理；例外主机的出站方式在 bypassHosts 逐行勾选',
  compression: 'Token 压缩（rtk 工具输出压缩 + headroom 上下文压缩 + caveman 输出风格注入；全部失败时放行原文，重启网关生效）',
  'compression.rtk.enabled': 'rtk 工具输出压缩：git/grep/ls/tree/日志/构建输出等工具结果文本压缩 60-90%（本地确定性压缩器，不破坏上游前缀缓存）',
  'compression.headroom.enabled': 'headroom 上下文压缩：转发前调用 headroom sidecar 的 /v1/compress（失败/超时自动放行原文；会话模式保上游前缀缓存）',
  'compression.headroom.url': 'headroom sidecar 地址（需自行运行 headroom proxy，默认 127.0.0.1:8787，仅本机回环）',
  'compression.headroom.timeoutMs': 'headroom 调用超时（毫秒，超时放行原文）',
  'compression.headroom.compressUserMessages': '同时压缩 user 角色文本（会话模式下自动忽略）',
  'compression.headroom.autoStart': '网关启动时自动拉起 headroom sidecar（先探测 /health 复用已在运行的实例，没有才以分离进程启动 headroom proxy --mode cache；仅支持 loopback 地址；sidecar 独立常驻、不随网关退出，会话重放状态跨网关重启保留）',
  'compression.caveman.enabled': 'caveman 输出压缩：向 system 幂等注入简洁风格提示词，显著压缩输出 token（代码/路径/命令逐字保留）',
  'compression.caveman.level': 'caveman 强度：lite / full / ultra / wenyan-lite / wenyan / wenyan-ultra（文言）',
  requestCapture: '请求全量捕获（HTTP 交换审计日志；默认关闭）：请求/响应原文落盘 JSONL，捕获体可能含敏感数据且占用磁盘，按日期目录保留、到期或超容量自动清理；单会话另有 maxSessionMB 封顶（失控的 agent 循环不会吃光共享容量，触顶档案停止追加并落一条 archive-overflow 终态行）',
  'requestCapture.storeMedia': 'base64 图片/文档等二进制载荷转存硬盘（默认 true）：请求体中的 base64 媒体替换为 [MEDIA …sha256=… file=media/…] 占位符，内容寻址去重（同一张图多轮重发只落一份），随日期目录同批清理；关闭或写盘失败时仍替换为无 file= 的占位符（不留 base64 在归档里），对话回放页可直接显示缩略图',
  'requestCapture.systemone.enabled': 'System One 决策面总闸（默认 true；仅当 requestCapture.enabled 为 true 时生效）：关闭时两腿同哑——/v1/systemone 全链路捕捉（客户端请求/响应 + 网关对上游的调用腿；路由指标仍不捕获）连同下方 L2 裁判 HTTP 腿捕捉一并静默；开启时该面全链路捕捉照常（决策体是客户端状态快照，注意隐私与磁盘占用）',
  'requestCapture.systemone.l2DecisionEnabled': 'L2 裁判 HTTP 腿捕捉子开关（默认 true；仅当 requestCapture.enabled 与 requestCapture.systemone.enabled 均为 true 时生效）：L2 裁判内部发起的决策模型调用记为上游捕捉事件（挂外层会话/追踪），与客户端请求捕捉主语正交——只增记裁判自己的线路调用，不筛选客户端流量；注意与 classifier.layer2.collectEnabled（数据集采样落盘）是两个不同开关',
  catalog: '目录数据源：远程 catalog 源定义与本地锚定（控制台 /catalog 页可视化编辑，改后即时生效）',
  'catalog.syncIntervalMs': '目录自动同步周期（毫秒，默认 86400000 = 24h）',
  'catalog.lockedModels': '本地锚定的模型 id 列表：这些模型的本地定义值（含 0 价）不被任何远程源覆盖',
  'catalog.autoPullModels': '自动拉取模型：每个同步周期为自定义服务商拉取模型清单（live /v1/models 优先，只新增不覆盖；默认 true）',
  combos: '自定义模型组合（combo）：把若干已注册模型组成一个虚拟模型名，客户端直接以 combo id 作为 model 调用（控制台 /combos 页可视化编辑，保存后即时生效，无需重启）',
  'combos.*.selection': '主选策略：priority 配置顺序（默认）/ weighted 加权随机 / round_robin 轮询',
  'combos.*.disabled': '禁用开关：true 时该组合下线——不再出现在模型目录（不可选），客户端以该组合 id 调用会被直接拒绝（不可用）；控制台仍可查看并重新启用',
  'combos.*.models': '成员列表（顺序即故障转移链序）：成员可写 \'model-id\' 或 { id, weight }（weight 用于 weighted/round_robin，默认 1）',
  'combos.*.note': '备注：仅控制台展示的自由文本，不参与路由',
  modelProfiles: '模型方案：一张「槽位 → 模型引用（modelRef）」命名表，与具体客户端无关。客户端挂接（应用）时选择方案，把各 agent/subagent 绑定到槽位，一次写入全部模型（控制台 /model-profiles 页可视化编辑；方案本身不参与路由，仅在应用时把 modelRef 写进客户端自身配置）',
  'modelProfiles.*.id': '方案 id（唯一，供客户端挂接引用）',
  'modelProfiles.*.name': '方案显示名',
  'modelProfiles.*.slots': '槽位表：槽位名 → modelRef（注册模型 id / 组合 id / auto / auto-lite / auto-plus / auto-pro / auto-ultra）',
  'modelProfiles.*.note': '备注：仅控制台展示的自由文本，不参与路由',
  clientProfileMemory: '控制台表单记忆（按环境保存）：各客户端挂接表单上次选择的模型方案、槽位映射与模型列表模式（none=不设置（默认）/ custom=自定义 / follow=跟随所选 API Key 的权限），仅用于页面回填，不参与路由、也不影响实际接管配置',
  session: '会话粘性（棘轮：会话内模型不漂移）',
  'session.strategy': '会话策略：monotonic 单调棘轮 / sticky 粘性 / stateless 无状态',
  'session.ttlSeconds': '会话保持时长（秒）',
  'session.maxSessions': '会话表容量上限',
  streaming: '推理流式（上游 SSE 逐帧转发，而非整段缓冲后再分块）',
  'streaming.enabled': '默认 true。仅对具备流式执行器的线型生效（当前为 OpenAI chat/completions；Anthropic/Google/Responses 仍走缓冲路径），需要先看完整正文再做 Schema 断言/升档级联的请求也始终走缓冲路径。置 false 为回滚开关：恢复"上游非流式 + 网关重新分块"的旧行为，客户端首字节时间重新等于上游整段生成时间。修改后需重启生效',
  responses: 'Responses 协议面（POST /v1/responses）：网关侧 previous_response_id 会话链',
  'responses.persist': '会话链磁盘恢复（默认 false）：开启后每轮增量以 JSONL 恢复日志写入本环境数据目录（文件权限 0600），启动时自动重放，24 小时过期自动清理——网关重启后长对话仍可续接；关闭时重启即断链（返回 400，客户端需重发完整 input）。日志含对话原文，属敏感数据落盘，与请求捕获（requestCapture）同级隐私考量；磁盘写入失败绝不影响请求本身',
};

function lookupYamlComment(path: string): string | undefined {
  const direct = YAML_FIELD_COMMENTS[path];
  if (direct !== undefined) return direct;
  const segs = path.split('.');
  // Dynamic map level: tiers.<name>[.field…] → tiers.*[…]
  if (segs[0] === 'tiers' && segs.length >= 2) {
    segs[1] = '*';
    return YAML_FIELD_COMMENTS[segs.join('.')];
  }
  // Dynamic map level: combos.<comboId>.<field…> → combos.*.<field…>
  if (segs[0] === 'combos' && segs.length >= 3) {
    return YAML_FIELD_COMMENTS[`combos.*.${segs.slice(2).join('.')}`];
  }
  // Dynamic map level: accounts.<providerId> → accounts.*
  if (segs[0] === 'accounts' && segs.length >= 2) {
    return YAML_FIELD_COMMENTS['accounts.*'];
  }
  // Dynamic array level: modelProfiles.<index>.<field…> → modelProfiles.*.<field…>
  if (segs[0] === 'modelProfiles' && segs.length >= 3) {
    return YAML_FIELD_COMMENTS[`modelProfiles.*.${segs.slice(2).join('.')}`];
  }
  return undefined;
}

function applyYamlComments(node: any, prefix: string): void {
  if (!node || typeof node !== 'object' || !Array.isArray(node.items)) return;
  for (const pair of node.items) {
    const keyNode = pair?.key;
    const keyName = keyNode?.value != null ? String(keyNode.value) : null;
    if (!keyName) continue;
    const fieldPath = prefix ? `${prefix}.${keyName}` : keyName;
    const comment = lookupYamlComment(fieldPath);
    if (comment) keyNode.commentBefore = padComment(comment);
    // Recurse into plain mappings only; sequences (models/apiKeys/weights…) are
    // documented at their key — per-item comments would drown the file.
    if (isMap(pair.value)) applyYamlComments(pair.value, fieldPath);
  }
}

/** Attach file header + per-field comments; returns input untouched if it can't be parsed as a mapping. */
export function annotateYamlComments(yamlText: string): string {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return yamlText;
  if (!doc.commentBefore) doc.commentBefore = padComment(YAML_FILE_HEADER);
  applyYamlComments(doc.contents, '');
  return doc.toString();
}
