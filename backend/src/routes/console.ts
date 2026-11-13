import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { getAllClientStatuses, refreshClientProfileBindings, setupClient, teardownClient } from '../cli/clients/index.js';
import { VIRTUAL_AUTO_IDS } from '../cli/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { MEMBER_TIER_ORDER } from '../providers/member-match.js';
import { refreshDirectPool } from '../providers/boot-direct.js';
import { TIER_PURPOSE } from '../providers/virtual-meta.js';
import { getProviderTakedownStore } from '../providers/provider-takedown.js';
import { NPM_VOCABULARY } from '../providers/vocabulary.js';
import { getModelServicePlugin, pluginPackageZip, pluginProviderOrigins } from '../plugins/host.js';
import { PluginAuthType, type TrafficExchange, type DissectedExchange } from '../plugins/types.js';
import { listGateways, getGatewayById } from '../plugins/gateways.js';
import { globMatchAny } from '../utils/glob.js';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { getRawConfig, loadConfig, saveConfig, saveRawConfig, getRuntimeConfigRef, getConfigPath } from '../config/index.js';
import { YAML_FILE_HEADER_ZH, YAML_FIELD_COMMENTS_ZH, type CommentLang } from '../config/comments-zh.js';
import { YAML_FILE_HEADER_EN, YAML_FIELD_COMMENTS_EN } from '../config/comments-en.js';

import { getEnvPaths, resolveEnvName } from '../config/env.js';
import { applyConfig as applyDecisionCaptureConfig } from '../capture/decision-capture.js';
import { applyRouteEntriesConfig, getRouteEntryStore, routeEntriesGate } from '../router/route-entries.js';
import { applyDirectivesConfig } from '../pipeline/directive-gate.js';
import { appendRoutingLedger } from '../router/routing-ledger.js';
import { Layer2Decision } from '../router/layer2-decision.js';
import { EFFORT_LADDER, ReasoningEffort, TierLevel, modelSupportsEfforts } from '../types/router.js';
import { runSystemoneDecision } from '../protocols/systemone/decide.js';
import { SMART_ASSIGN_TIMEOUT_MS, DEFAULT_REPLAY_TIMEOUT_MS, CREDENTIAL_WEIGHT_MAX, DEFAULT_FORWARD_PROXY_PORT, PLUGIN_PACKAGE_MAX_BYTES } from '../config/defaults.js';
import { initProxyConfig, proxiedFetch } from '../utils/proxy.js';
import { getOcrHomeDir } from '../cli/paths.js';
import { getHeadroomSidecarStatus, startHeadroomSidecar, stopHeadroomSidecar } from '../compression/headroom-sidecar.js';
import { APP_VERSION } from '../version.js';
import { getUpdateChecker } from '../update/check.js';
import { isSyncClientId } from '../opencode/credentials/sync.js';
import { caCertPath, describeCa, ensureCa, resolveCaDir } from '../forward-proxy/ca.js';
import { probeCaTrustedCached } from '../forward-proxy/ca-trust.js';
import { getForwardProxyStatus } from '../forward-proxy/status.js';
import {
  lintRules,
  normalizeRules,
  osBypassHosts,
  resolveHost,
} from '../forward-proxy/rules.js';
import { listProxyAccessEvents, readProxyAccessHistory, clearProxyAccessLog, deletePersistedProxyEvents, forgetProxyAccessRingEvents, proxyAccessLogSettings, proxyAccessBodyPath, type ProxyAccessEvent } from '../forward-proxy/access-log.js';
import { hideLiveEvents, liveHiddenProxyIds, liveHiddenPluginKeys, type LiveHiddenKey } from '../observability/traffic-live-hidden.js';
import { getSystemProxyStatus, enableSystemProxy, disableSystemProxy } from '../forward-proxy/system-proxy.js';
import { RouterConfig, type CredentialLimitConfig, type ModelRegistration, type RateLimitRule } from '../config/types.js';

import type { CredentialMeta, CredentialStore, RawCred } from '../opencode/credentials/types.js';
import { keyHashPrefix } from '../opencode/credentials/types.js';
import type { CircuitBreakerManager } from '../resilience/index.js';
import { CLASSIFIER_TAXONOMY } from '../resilience/index.js';
import type { TraceTracker } from '../trace/tracker.js';
import type { OpenCodeProviderView } from '../opencode/user-config.js';
import { maskSecret, isValidProviderId, PROVIDER_ID_RULE, getProviderNodeById } from '../opencode/user-config.js';
import { isSelfBaseURL } from '../utils/self-url.js';
import { listOpenCodeAgentsLive } from '../opencode/agents.js';
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  validateApiKey,
  validateModelAccess,
} from '../auth/api-keys.js';
import { toCallCredential } from '../providers/boot-direct.js';
import { getModelAccessPolicy, isAutoEntryUsable, isModelAllowed, isModelAllowedInTiers, tierFromVirtualEntry } from '../auth/model-access.js';
import { validateRateLimitRules, getRateLimiter, credentialSubject } from '../ratelimit/rate-limiter.js';
import { getQuotaProber } from '../quota/prober.js';
import { getQuotaStore } from '../quota/store.js';
import { getQuotaEventLog } from '../quota/events.js';
import type { QuotaBadgeState, QuotaProbeFailure, QuotaSource, QuotaWindow } from '../quota/types.js';
import {
  checkLoginAllowed,
  createSessionToken,
  hashPassword,
  hasWebAuthCredentials,
  isLoopbackHost,
  isWebAuthActive,
  parseSessionCookie,
  recordLoginFailure,
  recordLoginSuccess,
  sessionClearCookie,
  sessionSetCookie,
  verifyPassword,
  verifySessionToken,
} from '../auth/web-auth.js';
/**
 * Comment language for GET /api/admin/config/comments (the console's dynamic
 * comment panel; config.yaml itself is ZERO-COMMENT on disk, ADR-0016).
 * Anything else falls back to zh-CN.
 */
const commentLangFromQuery = (q: unknown): CommentLang => (q === 'en' ? 'en' : 'zh-CN');

export { validateApiKey };

/* ------------------------------------------------------------------------ *
 * Process-log tail helpers (for GET /api/admin/logs).
 * Pino writes NDJSON with a numeric `level`; banner text is plain lines.
 * ------------------------------------------------------------------------ */
const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
const LEVEL_NAME_TO_NUM: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function parseLogLevelParam(name?: string): number {
  if (!name) return 0; // 0 = no filtering
  return LEVEL_NAME_TO_NUM[name.toLowerCase()] ?? 0;
}

export interface ParsedLogLine {
  raw: string;
  level?: string;
  levelNum?: number;
  time?: number;
  msg?: string;
}

function parseLogLine(raw: string): ParsedLogLine {
  if (!raw.startsWith('{')) return { raw };
  try {
    const j = JSON.parse(raw);
    const levelNum = typeof j.level === 'number' ? j.level : undefined;
    return {
      raw,
      level: levelNum !== undefined ? PINO_LEVELS[levelNum] : undefined,
      levelNum,
      time: typeof j.time === 'number' ? j.time : undefined,
      msg: typeof j.msg === 'string' ? j.msg : undefined,
    };
  } catch {
    return { raw };
  }
}

/**
 * Catalog-style model payload → opencode v2 model definition shape
 * (https://opencode.ai/opencode v2/docs/models/): capabilities{tools,input,output},
 * reasoning / temperature (tri-state capability flags), limit,
 * settings.reasoningEffort, reasoningOptions (via reasoningEfforts),
 * headers, body, compatibility.reasoningField, variants, modelID, disabled.
 */
function bodyToModelDef(body: any): Record<string, any> {
  if (body?.definition && typeof body.definition === 'object') return { ...body.definition };
  const def: Record<string, any> = {};
  if (body?.name) def.name = String(body.name);
  if (body?.modelID) def.modelID = String(body.modelID);
  if (body?.disabled != null) def.disabled = Boolean(body.disabled);

  // capabilities: tools + input/output modality lists (present in payload = full replace)
  const caps: Record<string, any> = {};
  if (body?.capabilities?.tools != null) caps.tools = Boolean(body.capabilities.tools);
  else if (body?.toolCall != null) caps.tools = Boolean(body.toolCall);
  const inList = body?.capabilities?.input ?? body?.modalities?.input;
  if (Array.isArray(inList)) {
    const vals = inList.map((x: any) => String(x)).filter(Boolean);
    if (vals.length > 0) caps.input = vals;
  }
  const outList = body?.capabilities?.output ?? body?.modalities?.output;
  if (Array.isArray(outList)) {
    const vals = outList.map((x: any) => String(x)).filter(Boolean);
    if (vals.length > 0) caps.output = vals;
  }
  if (body?.capabilities && typeof body.capabilities === 'object') def.capabilities = caps;
  else if (Object.keys(caps).length > 0) def.capabilities = caps;

  const limit: Record<string, number> = {};
  if (body?.contextLimit) limit.context = Number(body.contextLimit);
  if (body?.outputLimit) limit.output = Number(body.outputLimit);
  if (Object.keys(limit).length > 0) def.limit = limit;

  if (body?.cost && typeof body.cost === 'object') {
    const c: Record<string, number> = {};
    for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      const v = (body.cost as any)[k];
      if (typeof v === 'number' && Number.isFinite(v)) c[k] = v;
    }
    if (Object.keys(c).length > 0) def.cost = c;
  }

  // settings.reasoningEffort (thinking level); presence in payload = full replace
  if (body?.settings && typeof body.settings === 'object') {
    const s: Record<string, any> = {};
    if (body.settings.reasoningEffort) s.reasoningEffort = String(body.settings.reasoningEffort);
    def.settings = s;
  } else if (body?.reasoningEffort) {
    def.settings = { reasoningEffort: String(body.reasoningEffort) };
  }

  // tri-state temperature capability (def top level; null = clear the key —
  // modelUpdate deletes it after the spread so the def falls back to catalog)
  if (body?.temperature === 'true' || body?.temperature === true) def.temperature = true;
  else if (body?.temperature === 'false' || body?.temperature === false) def.temperature = false;
  else if (body?.temperature === null) def.temperature = null;

  // tri-state reasoning capability (def top level; same contract as
  // `temperature` above). `reasoning` is the standard catalog flag that marks
  // a model as thinking-capable; the level control lives separately in
  // reasoningOptions (see reasoningEfforts below).
  if (body?.reasoning === 'true' || body?.reasoning === true) def.reasoning = true;
  else if (body?.reasoning === 'false' || body?.reasoning === false) def.reasoning = false;
  else if (body?.reasoning === null) def.reasoning = null;

  // supported thinking levels (def top level, models.dev `reasoningOptions`
  // shape): non-empty → effort list, empty → toggle (no explicit control)
  if (Array.isArray(body?.reasoningEfforts)) {
    const vals = body.reasoningEfforts.map((x: any) => String(x)).filter(Boolean);
    def.reasoningOptions = vals.length > 0 ? [{ type: 'effort', values: vals }] : [{ type: 'toggle' }];
  }

  // headers: { Name: Value } map or "Name: Value" lines (presence = full replace)
  if (body?.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.headers)) {
      if (k && typeof v === 'string' && v) h[k] = v;
    }
    def.headers = h;
  } else if (typeof body?.headersText === 'string') {
    const h: Record<string, string> = {};
    for (const line of body.headersText.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k && v) h[k] = v;
      }
    }
    def.headers = h; // may be {} — clears old headers
  }

  // body: provider-specific request body fields (JSON object; presence = full replace)
  if (body?.body && typeof body.body === 'object' && !Array.isArray(body.body)) {
    def.body = body.body;
  } else if (typeof body?.bodyText === 'string') {
    let parsed: any = {};
    if (body.bodyText.trim()) {
      try {
        parsed = JSON.parse(body.bodyText);
      } catch {
        parsed = {}; // UI validates before submit
      }
    }
    def.body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  // compatibility.reasoningField (presence = full replace)
  if (body?.compatibility && typeof body.compatibility === 'object') {
    const c: Record<string, any> = {};
    if (body.compatibility.reasoningField) c.reasoningField = String(body.compatibility.reasoningField);
    def.compatibility = c;
  }

  // variants: [{ id, settings: { reasoningEffort } }]
  if (Array.isArray(body?.variants)) {
    const variants = body.variants
      .filter((v: any) => v && typeof v === 'object' && v.id)
      .map((v: any) => {
        const entry: Record<string, any> = { id: String(v.id) };
        if (v.settings?.reasoningEffort) entry.settings = { reasoningEffort: String(v.settings.reasoningEffort) };
        return entry;
      });
    if (variants.length > 0) def.variants = variants;
  }
  return def;
}

// Live/catalog model pull moved to opencode/catalog/auto-pull.ts so the
// periodic auto-pull scheduler and the console share one implementation.

/* ------------------------------------------------------------------------ *
 * credential-route helpers (store-routed console write path).
 * ------------------------------------------------------------------------ */

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Credential SINK invariant: the bound store is the
 * ONLY sink. auth.json is never written — not by these routes, and not by an implicit
 * side-write in user-config (the file-level credential writers that used to live there
 * are deleted), so every non-inline key goes through store.connectKey.
 * Branching stays on capabilities, never on `kind`.
 */

/** Human-readable sink for the connect/setKey reply message. */
function credentialSinkLabel(store: CredentialStore): string {
  // Two bindings remain: an opencode-v2 family store, or OCR's own file. auth.json is
  // not a sink on any binding, so no branch can name it.
  return store.capabilities.envVisible ? 'the opencode v2 service' : 'the OCR credential file';
}

/**
 * Reconnect clears SUSPECT. The flag never auto-returns
 * ("cleared only by manual reconnect or Push"), and every such gesture hands
 * this credential's key material to the bound store: the write's returned
 * CredentialMeta names the Decision 5 identity (keyHashPrefix), so the clear is
 * anchored on key material, never on a churnable id or label. No prefix in the
 * result (oauth / non-routable row) = nothing to clear; the next 401 re-marks it anyway.
 */
function clearSuspectForCredential(cb: CircuitBreakerManager, providerId: string, keyHashPrefix?: string): void {
  if (!keyHashPrefix) return;
  cb.getCredentialStateStore().clear(providerId, keyHashPrefix);
}

/**
 * Hot credential-chain rebuild for ONE provider — the runtime twin of the
 * boot pool's chain. The routing chain (`registry.credentialChains`) is
 * otherwise written ONLY at process boot, so a console connect/disconnect/
 * activate or a credential sync would leave the live chain stale (new keys
 * invisible to the spread, removed keys still routable) until the next
 * restart. Reads the bound store's ordered chain (active head first) and
 * swaps it in via `registry.refreshCredentialChain`; a store read failure is
 * swallowed — the boot-baked chain keeps serving (fail-open, same doctrine as
 * every observability write). RAW KEYS stay in memory (registry-only).
 */
async function refreshProviderCredentialChain(
  registry: ProviderRegistry,
  store: CredentialStore,
  providerId: string
): Promise<void> {
  try {
    registry.refreshCredentialChain(
      providerId,
      store.resolveKeyChain(providerId).map((c) => toCallCredential(c.key, c.label, c.weight))
    );
  } catch {
    // keep the existing chain — a refresh failure must never take routing down
  }
  // Chain-only by design: the pool rebuild stays behind the mutation-route
  // wrapper (`withPoolSync`) or the config-save seams — a credential-sync
  // run over P providers must not trigger P+1 full rebuilds.
}

/**
 * Wrap an admin mutation handler with a post-run POOL RESYNC: every def /
 * credential / override write lands in the live registry the same way a boot
 * rebuild would (ADR-0010 §3 amendment) — no restart. Fail-open: a rebuild
 * error keeps the existing registry serving. Handlers that already replied
 * (error paths) skip the resync.
 */
const withPoolSync =
  (registry: ProviderRegistry, handler: (req: any, reply: any) => Promise<unknown>) =>
  async (req: any, reply: any) => {
    const result = await handler(req, reply);
    if (!reply.sent) {
      try {
        await refreshDirectPool(registry);
      } catch (err) {
        // Fail-open: the registry keeps serving, but a silent drift hides a
        // failed mutation — log it so an operator can see it landed nowhere.
        console.warn(`[console] pool resync after a def/credential mutation failed (registry may drift): ${(err as Error).message}`);
      }
    }
    return result;
  };
/**
 * Idempotent connect (identity at the write seam): handing the store a
 * key it ALREADY holds for this provider is idempotent — the existing credential is
 * reported back and NO second row is created. Without this, every repeated
 * connect grows the chain (`resolveKeyChain` → `registry.credentialChains`), and
 * `pipeline/credential-selection.ts` counts chain members, so one physical key would
 * carry the weight of two credentials in the new-session spread while the console
 * showed two indistinguishable rows.
 *
 * Compared on the sha256 PREFIX (the display-safe identity the whole console
 * surface already keys breakers/SUSPECT on); reconcile/push run the stricter
 * full-hash rule against the raw db, which is their own business.
 *
 * `listCredentials` is NOT caught: an unreadable store must fail the same
 * `store_unreadable` the write path would have raised (cp-failfast — a swallowed
 * read here would silently permit the duplicate it exists to prevent).
 *
 * A caller that supplies NO label means it, down to the stored row: opencode v2's
 * `/connect/key` invents one from the integration display name (`DeepSeek`,
 * `OpenCode Console` — verified live on 2.0.15), which is a name this product
 * never chose. After a fresh connect the created row is re-read and an
 * unrequested label is CLEARED. A failed clear is not a failed connect — the
 * credential is in the sink, so the invented name simply survives and the reply
 * reports the truth instead of the request.
 */
async function connectKeyIdempotent(
  store: CredentialStore,
  providerId: string,
  key: string,
  label: string | undefined,
  // Credential flags live in the resilience state file, reached through the manager
  // so the write seam never re-derives its own view of "is this head still good".
  cb: CircuitBreakerManager,
  registry: ProviderRegistry
): Promise<{ credential: CredentialMeta; deduped: boolean; headPreserved?: CredentialMeta }> {
  const { keyHashPrefix } = await import('../opencode/credentials/index.js');
  const prefix = keyHashPrefix(key);
  const before = store.listCredentials(providerId);
  const existing = before.find((a) => a.keyHashPrefix === prefix);
  if (existing) return { credential: existing, deduped: true };

  // Who was serving before this gesture — decided on the PRE-write view.
  const priorHead = before.find((a) => a.active && a.routable);

  let credential = await store.connectKey(providerId, key, label);
  store.invalidate(); // the post-write view must reflect the sink, not the cache
  const created = store.listCredentials(providerId).find((a) => a.keyHashPrefix === prefix);

  if (label === undefined && created && store.capabilities.rename && created.label) {
    try {
      credential = await store.rename(created.id, '');
    } catch {
      credential = created; // honest: the sink's name is still on the row
    }
  }

  /**
   * Opencode v2 makes a connected credential the active one (verified live on
   * 2.0.15: adding a second deepseek key demoted the working row to active=0).
   * `active` is ALSO the credential opencode's own CLI uses, so "add an credential"
   * silently repointing the operator's terminal sessions is a hijack, not a
   * default. When a USEABLE head already existed, put it back: the new key joins
   * the chain as an extra credential, and promoting it stays a deliberate second
   * action (the row's own pin-as-default button). A prior head that is SUSPECT or
   * operator-disabled is NOT defended — there, the new key taking over IS the
   * rotation the operator was reaching for.
   */
  let headPreserved: CredentialMeta | undefined;
  if (
    priorHead &&
    created?.active &&
    created.id !== priorHead.id &&
    store.capabilities.activate
  ) {
    const state = cb.getCredentialStateStore();
    const defensible = !(
      (priorHead.keyHashPrefix && state.isSuspect(providerId, priorHead.keyHashPrefix)) ||
      (priorHead.keyHashPrefix && state.isDisabled(providerId, priorHead.keyHashPrefix))
    );
    if (defensible) {
      try {
        headPreserved = await store.activate(priorHead.id);
        credential = store.listCredentials(providerId).find((a) => a.keyHashPrefix === prefix) ?? credential;
      } catch {
        headPreserved = undefined; // the sink kept the new head; the reply stays truthful
      }
    }
  }

  // The chain is boot-baked otherwise — without this swap a newly connected key
  // stays invisible to the per-request spread until the next gateway restart.
  await refreshProviderCredentialChain(registry, store, providerId);

  return { credential, deduped: false, ...(headPreserved ? { headPreserved } : {}) };
}

/**
 * Provider defs have ONE generation and ONE slot: the v2 shape in `providers`.
 * user-config owns the detail; the routes just call it.
 */

/**
 * Map store write failures to machine-readable replies (Decision 3: writes
 * fail LOUD — an opencode v2 WriteFailedError surfaces as a 5xx and NEVER falls back
 * to OcrStore). Returns the {status, body} descriptor for the caller's
 * `return reply.status(s).send(b)` — the one send per request stays on the
 * codebase's proven async pattern. Returns null for non-store errors →
 * callers keep the legacy 400 path. Response shape stays additive:
 * {success:false, error} preserved, reasonCode added.
 */
async function mapStoreWriteFailure(err: unknown): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const m = await import('../opencode/credentials/index.js');
  if (err instanceof m.WriteFailedError) {
    return { status: 502, body: { success: false, reasonCode: 'write_failed', error: errMessage(err) } };
  }
  if (err instanceof m.IntegrationUnmatchedError) {
    return {
      status: 409,
      body: {
        success: false,
        reasonCode: 'integration_unmatched',
        error: errMessage(err),
        knownIntegrations: err.knownIntegrationIds,
      },
    };
  }
  if (err instanceof m.CapabilityUnsupportedError) {
    // Any capability gate refusal (e.g. the sync engine's transient readonly v2 store).
    return { status: 409, body: { success: false, reasonCode: 'store_readonly', error: errMessage(err) } };
  }
  if (err instanceof m.StoreUnreadableError) {
    return { status: 500, body: { success: false, reasonCode: 'store_unreadable', error: errMessage(err) } };
  }
  return null;
}

// ─── Quota tracking ─────────────────────────────────────────────────────────

/**
 * The per-credential quota view riding the CredentialHealth overlay (every
 * credential-returning response, per the per-credential overlay contract). Present
 * ONLY when the credential's provider is COVERED (built-in table / adapter /
 * config entry); uncovered credentials carry no `quota` key at all — absence
 * means "not covered", which is deliberately NOT the same signal as the
 * `unverified` badge ("covered, no data yet").
 */
export interface CredentialQuotaView {
  /** Four-state badge: probed / declared / unverified / stale. */
  badge: QuotaBadgeState;
  source?: QuotaSource;
  plan?: string;
  windows: QuotaWindow[];
  verifiedAt?: number;
  lastFailureAt?: number;
  /** WHY the last attempt produced nothing (transport reason + HTTP status +
   *  the upstream's short message). Present whenever an attempt failed —
   *  including on a pair that never succeeded, where it is the ONLY honest
   *  answer to "covered, but empty". Display-only. */
  lastFailure?: QuotaProbeFailure;
  /** Entry that produced (or would produce) this — built-in id,
   *  `adapter:<id>`, or config `override:<id>` / `<pid>#<n>`. */
  entryId?: string;
  /** Effective cache window (ms) — the UI can render freshness honestly. */
  ttlMs?: number;
}

/** Compute the overlay for one pair, joining the live plan (coverage/TTL)
 *  with the store (snapshot + failure verdict). Undefined = provider not covered. */
function quotaViewFor(providerId: string, keyHashPrefix?: string): CredentialQuotaView | undefined {
  if (!keyHashPrefix) return undefined;
  const prober = getQuotaProber();
  // ttlMs is defined exactly when the LIVE plan covers the provider.
  const ttlMs = prober?.getTtlFor(providerId);
  const store = getQuotaStore();
  const snap = store.get(providerId, keyHashPrefix);
  const failure = store.getFailure(providerId, keyHashPrefix);
  // Uncovered rows carry no quota key at all. With the prober OFF
  // (quota.enabled:false) nothing can ever become `unverified` — the honest
  // surface is then ONLY what a previous lifetime left on disk (entryId in
  // the tooltip names its origin), never a badge promising a future probe.
  if (ttlMs === undefined && !snap) return undefined;
  const ttl = ttlMs ?? 15 * 60_000;
  if (!snap) {
    // Covered but no numbers yet: `unverified` is the provenance state; the
    // failure verdict (when present) says WHY — `unverified` alone would read
    // as "waiting for the first sync" even for a 401 or a plan-level refusal.
    return {
      badge: 'unverified',
      windows: [],
      ttlMs: ttl,
      ...(failure ? { lastFailure: failure, lastFailureAt: failure.at } : {}),
    };
  }
  const badge = store.badgeState(providerId, keyHashPrefix, ttl);
  return {
    badge,
    source: snap.source,
    plan: snap.plan,
    windows: snap.windows,
    verifiedAt: snap.verifiedAt,
    lastFailureAt: snap.lastFailureAt,
    ...(failure ? { lastFailure: failure } : {}),
    entryId: snap.entryId,
    ttlMs: ttl,
  };
}

/**
 * One row of the QUOTA PAGE directory (GET /api/admin/quota.pairs): every
 * CONNECTED pair — the bound credential store's credentials UNION the registry
 * chains and config-baked inference keys (display-safe prefixes only) — joined
 * with its quota view and its per-pair trace usage. This is the "all connected
 * pairs, each with its quota" cross-provider surface; KeysPage keeps the
 * per-credential inline badge, this page owns the overview.
 *
 * The store is the PRIMARY source on purpose (ADR-0009 §1): quota activation is
 * a credential concern, model registration is a routing concern. Enumerating
 * through `registry.getAllModels()` silently hid every connected provider whose
 * model list is still empty — the store has the keys, so the row must exist.
 */
interface QuotaPairRow {
  providerId: string;
  keyHashPrefix: string;
  /** Operator-set credential name. ABSENT = unnamed — the console then shows
   *  the masked key (the same string the credentials list shows). A store
   *  machine id is never a display name. */
  label?: string;
  /** `maskSecret()` output for this credential — the sanctioned display-safe
   *  identity when no label is set (never the raw key). */
  maskedKey?: string;
  /** Live-plan coverage (built-in table / adapter / config entry). */
  covered: boolean;
  quota?: CredentialQuotaView;
  /** Attributed usage from the trace ring (undefined = nothing attributed
   *  yet — turns recorded before the attribution field, or chain-less). */
  usage?: { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number };
}

async function buildQuotaPairRows(
  registry: ProviderRegistry,
  traceTracker: TraceTracker
): Promise<QuotaPairRow[]> {
  const pairs = new Map<string, QuotaPairRow>();
  const add = (providerId: string, keyHashPrefix: string, label: string | undefined, maskedKey: string | undefined) => {
    const id = `${providerId}#${keyHashPrefix}`;
    if (pairs.has(id)) return;
    pairs.set(id, {
      providerId,
      keyHashPrefix,
      ...(label ? { label } : {}),
      ...(maskedKey ? { maskedKey } : {}),
      covered: getQuotaProber()?.getPlan().byProvider.has(providerId) ?? false,
      quota: quotaViewFor(providerId, keyHashPrefix),
    });
  };

  // 1. The bound credential store — the primary source. Connected providers are
  //    credential-store rows, NOT model rows: a provider whose defs node has no
  //    models yet can still hold keys, and those keys still carry quota.
  try {
    const { getCredentialStore } = await import('../opencode/credentials/index.js');
    const store = await getCredentialStore();
    let overview: { providerId: string }[] = [];
    try {
      overview = store.credentialsOverview();
    } catch {
      // Unreadable store: the registry fallback below still lists what boot saw.
      overview = [];
    }
    for (const o of overview) {
      let metas: CredentialMeta[] = [];
      try {
        metas = store.listCredentials(o.providerId);
      } catch {
        continue;
      }
      for (const m of metas) {
        if (!m.keyHashPrefix) continue;
        add(o.providerId, m.keyHashPrefix, m.label, m.maskedKey);
      }
    }
  } catch {
    // Store bind unavailable (mock boot / early boot) — registry-only rows.
  }

  // 2. Registry view: boot-baked chains, plus the config-baked inference key
  //    when a provider registered no chain (the chain-less degeneracy). Union
  //    with (1) — `add` dedupes by pair id, so a store row keeps its identity.
  for (const m of registry.getAllModels()) {
    const chain = registry.getCredentialChain(m.provider) ?? [];
    for (const c of chain) add(m.provider, c.keyHashPrefix, c.label, maskSecret(c.key));
    if (chain.length === 0) {
      const baked = registry.getProviderConfig(m.provider)?.apiKey;
      if (baked) add(m.provider, keyHashPrefix(baked), undefined, maskSecret(baked));
    }
  }

  // Per-pair usage join (trace ring GROUP BY provider×prefix — the step-1
  // aggregation surface).
  const usageRows = traceTracker.getCredentialPairUsageStats();
  for (const row of usageRows) {
    const p = pairs.get(`${row.provider}#${row.keyHashPrefix}`);
    if (p) {
      p.usage = {
        requests: row.requests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedTokens: row.cachedTokens,
        costUsd: row.costUsd,
      };
    }
  }
  return [...pairs.values()].sort(
    (a, b) => a.providerId.localeCompare(b.providerId) || a.keyHashPrefix.localeCompare(b.keyHashPrefix)
  );
}

// ---------------------------------------------------------------------------
// Per-credential write surface (activate / rename / disconnect routes)
// ---------------------------------------------------------------------------

/** Masked credential meta + the P3-step3 store-status overlay keys (badge shape). */
type CredentialHealth = CredentialMeta & {
  suspect: boolean;
  openPairs: number;
  cooldownUntilMs?: number;
  /** Operator takedown (the `disabled` section of the credential state file). */
  disabled: boolean;
  /** The operator's note attached at takedown time — display only, only when disabled. */
  disabledReason?: string;
  /** Outbound rate-limit rules armed for THIS credential (config `credentials:` overlay). */
  limits?: RateLimitRule[];
  /** Quota tracking overlay — present only when the provider is
   *  covered; absence != `unverified` badge. */
  quota?: CredentialQuotaView;
};

/** 404 body shared by the guard (pre-write) and the race catch (post-delete churn). */
function credentialNotFoundBody(credentialId: string, providerId: string): Record<string, unknown> {
  return {
    status: 'error',
    success: false,
    reasonCode: 'credential_not_found',
    error: `credential '${credentialId}' is not listed under provider '${providerId}'`,
  };
}

/**
 * Apply a `pullPattern` edit from the provider create/update routes to
 * config.yaml's catalog.autoPullPatterns (the per-provider auto-pull
 * whitelist). Presence semantics: string = set (blank clears), undefined =
 * untouched. The whitelist lives in the ROUTER config, never in the defs
 * file — opencode v2 nodes must stay decoder-clean (ADR-0010). Returns the
 * saveConfig result so callers surface a failed config.yaml write (400).
 */
function applyAutoPullPatternEdit(id: string, raw: unknown): { success: boolean; error?: string } {
  if (raw === undefined) return { success: true };
  const current = loadConfig().catalog ?? {};
  const patterns = { ...(current.autoPullPatterns ?? {}) };
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value) patterns[id] = value;
  else delete patterns[id];
  return saveConfig({ catalog: { ...current, autoPullPatterns: patterns } });
}

/** Capability-gate refusal (Decision 1: branch on flags, never on `kind` — the
 *  ocr store passes with activate/rename=true; OpencodeV2Store-readonly refuses). */
function capabilityRefusalBody(capability: 'activate' | 'rename' | 'reorder' | 'weight'): Record<string, unknown> {
  return {
    status: 'error',
    success: false,
    reasonCode: 'capability_unsupported',
    error: `${capability} unsupported on the bound credential store (capabilities.${capability} is false)`,
  };
}

/**
 * Cross-check guard: credentialId MUST name an credential the bound store lists
 * under :providerId — no blind passthrough of arbitrary ids to store methods
 * (OcrStore.activate would otherwise happily touch another provider's row).
 * The pre-write meta is returned because disconnect needs the keyHashPrefix
 * BEFORE deletion (Decision 5: SUSPECT state is anchored on key material).
 */
async function guardStoreCredential(
  store: CredentialStore,
  providerId: string,
  credentialId: string
): Promise<{ ok: true; meta: CredentialMeta } | { ok: false; status: number; body: Record<string, unknown> }> {
  let metas: CredentialMeta[];
  try {
    metas = store.listCredentials(providerId);
  } catch (err) {
    const failure = await mapStoreWriteFailure(err); // StoreUnreadableError → 500 store_unreadable
    if (failure) return { ok: false, status: failure.status, body: { status: 'error', ...failure.body } };
    return { ok: false, status: 500, body: { status: 'error', success: false, error: errMessage(err) } };
  }
  const meta = metas.find((a) => a.id === credentialId);
  if (!meta) return { ok: false, status: 404, body: credentialNotFoundBody(credentialId, providerId) };
  return { ok: true, meta };
}

/**
 * Shared catch for the three credential-write routes — Decision 3: writes fail
 * LOUD, never fall back to OcrStore. CredentialNotFoundError is the race edge
 * (row vanished between guard and write) → 404; everything else keeps the
 * mapStoreWriteFailure vocabulary, with `status: 'error'` merged additively.
 */
async function mapCredentialWriteFailure(
  err: unknown,
  providerId: string,
  credentialId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const m = await import('../opencode/credentials/index.js');
  if (err instanceof m.CredentialNotFoundError) {
    return { status: 404, body: credentialNotFoundBody(credentialId, providerId) };
  }
  const failure = await mapStoreWriteFailure(err);
  if (failure) return { status: failure.status, body: { status: 'error', ...failure.body } };
  return { status: 500, body: { status: 'error', success: false, error: errMessage(err) } };
}

/**
 * Masked provider views from the BOUND store (listProviders for every
 * non-opencode-v1-sink binding): config providers from the defs file ∪ store
 * credentials, in the existing OpenCodeProviderView shape — no new shape.
 * Raw keys never enter the view (CredentialMeta is masked by interface
 * contract; Decision 1 risk limb).
 */
async function storeProviderViews(store: CredentialStore, lang?: string): Promise<OpenCodeProviderView[]> {
  const { listConfigProviders } = await import('../opencode/user-config.js');
  const views = listConfigProviders();
  // Per-provider auto-pull whitelist rides the view (edit dialog prefills from it).
  const patterns = loadConfig().catalog?.autoPullPatterns ?? {};
  for (const v of views) v.autoPullPattern = patterns[v.id];
  // Position reference for the stable ordering applied at the end of this function.
  const configOrder = views.map((v) => v.id);
  const byId = new Map<string, OpenCodeProviderView>(views.map((v) => [v.id, v]));
  for (const overview of store.credentialsOverview()) {
    let metas: CredentialMeta[] = [];
    try {
      metas = store.listCredentials(overview.providerId);
    } catch {
      continue; // per-provider unreadable detail: the status endpoint carries it loudly
    }
    const shown =
      metas.find((a) => a.active && a.routable) ??
      metas.find((a) => a.routable) ??
      metas.find((a) => a.active) ??
      metas[0];
    const existing = byId.get(overview.providerId);
    const badge =
      shown && shown.type !== 'unknown' ? { type: shown.type as OpenCodeProviderView['auth']['type'] } : {};
    if (existing) {
      existing.auth = {
        ...existing.auth,
        connected: existing.auth.connected || metas.length > 0,
        ...badge,
        ...(shown?.maskedKey ? { keyMasked: shown.maskedKey } : {}),
        // inline stays the labeled source only while the store has no key
        inline: existing.auth.inline && !metas.some((a) => a.routable),
      };
    } else {
      byId.set(overview.providerId, {
        id: overview.providerId,
        models: [],
        auth: { connected: true, ...badge, ...(shown?.maskedKey ? { keyMasked: shown.maskedKey } : {}) },
      });
    }
  }
  // Plugin-preset overlay: the def's stored name is a single localeless string,
  // so the localized display name (+logo) comes from the owning plugin manifest.
  {
    const { pluginPresetCatalogEntries } = await import('../plugins/host.js');
    for (const preset of await pluginPresetCatalogEntries(lang)) {
      const v = byId.get(preset.id);
      if (v) {
        // localize only the name the preset itself registered — an operator
        // rename (providers.json is operator-owned, ADR-0010) stays untouched
        if (!v.name || v.name === preset.defaultName || v.name === preset.name) v.name = preset.name;
        if (preset.logo && !v.logo) v.logo = preset.logo;
      }
    }
  }
  return [...byId.values()].sort((a, b) => {
    // DETERMINISTIC grid order. `store.credentialsOverview()` yields credential-table
    // order (`active DESC, time_updated DESC`), so appending store-only providers
    // in that order makes a provider JUMP to the front of the grid every time a
    // key is added to it. Config-defined providers keep their author-defined
    // defs-file sequence; store-only providers (no defs node) follow, alphabetically.
    const ra = configOrder.indexOf(a.id);
    const rb = configOrder.indexOf(b.id);
    if (ra !== rb) return (ra < 0 ? Number.MAX_SAFE_INTEGER : ra) - (rb < 0 ? Number.MAX_SAFE_INTEGER : rb);
    if (ra < 0) return a.id.localeCompare(b.id);
    return 0;
  });
}

interface PurgeSummary {
  attempted: number;
  removed: number;
  /**
   * P1-3 response contract (frontend renders these as an error toast):
   * `{credentialId, reason}` + additive machine-readable `reasonCode`
   * ('store_readonly' | 'write_failed' | 'disconnect_failed').
   */
  failed: { credentialId: string; reason: string; reasonCode: 'store_readonly' | 'write_failed' | 'disconnect_failed' }[];
}

/** Map a purge disconnect failure to its machine-readable code (P1-3). */
async function purgeFailureCode(e: unknown): Promise<PurgeSummary['failed'][number]['reasonCode']> {
  const m = await import('../opencode/credentials/index.js');
  if (e instanceof m.CapabilityUnsupportedError) return 'store_readonly';
  if (e instanceof m.WriteFailedError || e instanceof m.StoreUnreadableError) return 'write_failed';
  return 'disconnect_failed';
}

/**
 * Provider-wide credential purge via the bound store:
 * provider-wide disconnect is a UI-level LOOP over per-credential disconnects
 * (not an interface primitive) — per-credential failures are collected into the
 * response detail, never dropped.
 */
async function purgeProviderCredentials(store: CredentialStore, id: string): Promise<PurgeSummary> {
  const failed: PurgeSummary['failed'] = [];
  let removed = 0;
  if (!store.capabilities.multiCredential) {
    // single-credential store (capability branch, Decision 1): the provider id addresses the sole credential
    try {
      await store.disconnect(id);
      removed = 1;
    } catch (e) {
      failed.push({ credentialId: id, reason: errMessage(e), reasonCode: await purgeFailureCode(e) });
    }
    store.invalidate();
    return { attempted: 1, removed, failed };
  }
  const metas = store.listCredentials(id);
  for (const meta of metas) {
    try {
      await store.disconnect(meta.id);
      removed += 1;
    } catch (e) {
      // Decision 8 + P1-3: honest per-credential result, machine-readable code.
      // An opencode v2-readonly binding fails HERE for every credential — loudly, through
      // failed[] (reasonCode store_readonly), never a silent removed=0.
      failed.push({ credentialId: meta.id, reason: errMessage(e), reasonCode: await purgeFailureCode(e) });
    }
  }
  store.invalidate();
  return { attempted: metas.length, removed, failed };
}

/**
 * Provider takedown lifecycle terminus: once NOTHING remains for the id (no
 * defs node, no credential), drop the ledger row — a later connect reuses the
 * id enabled. A partial state (either side still present) keeps the takedown.
 */
function dropTakedownWhenProviderGone(providerId: string, store: CredentialStore): void {
  try {
    if (!getProviderNodeById(providerId) && store.listCredentials(providerId).length === 0) {
      getProviderTakedownStore().enable(providerId);
    }
  } catch {
    // unreadable store: keep the takedown (safer than a silent re-enable)
  }
}

/**
 * P1-3 outcome flip: whenever the purge ATTEMPTED credentials but did not
 * remove them all, the response must NOT claim success. HTTP stays 200 (the
 * flip is additive: {status:'ok', success:boolean, message, purge} — the
 * frontend renders purge.failed as an error toast). An opencode v2-readonly binding
 * lands here too: every disconnect throws CapabilityUnsupportedError ->
 * failed[] reasonCode 'store_readonly', never a silent removed=0.
 */
function purgeOutcomeMessage(purge: PurgeSummary, id: string, configNodeRemoved: boolean): { success: boolean; message: string } {
  const complete = purge.attempted === 0 || purge.removed >= purge.attempted;
  if (complete) {
    // attempted===0 is success but NOT a credential removal claim: the store
    // simply showed no credential rows for this id. Say so instead of the bare
    // "'x' removed" the full-purge case uses.
    const noun = configNodeRemoved ? `Provider '${id}' removed` : `Credential entry '${id}' removed`;
    return {
      success: true,
      message: purge.attempted === 0 ? `${noun} (0 credentials visible to clear)` : noun,
    };
  }
  const codes = purge.failed.map((f) => `${f.credentialId}: ${f.reasonCode}`).join('; ');
  const head = configNodeRemoved
    ? `Provider '${id}' config removed but the credential purge FAILED`
    : `Credential purge for '${id}' FAILED`;
  return { success: false, message: `${head} (${purge.removed}/${purge.attempted} credentials removed): ${codes}` };
}

export function registerConsoleRoutes(
  app: FastifyInstance,
  registry: ProviderRegistry,
  orchestrator: PipelineOrchestrator
): void {
  const candidateDistDirs = [
    path.resolve(process.cwd(), 'frontend/dist'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../frontend/dist'),
  ];
  const FRONTEND_DIST = candidateDistDirs.find((p) => fs.existsSync(p)) || path.resolve(process.cwd(), 'frontend/dist');

  // 1. Static Asset Serving from frontend/dist/assets — production vite
  // builds use base '/admin/' so HTML references /admin/assets/* below.
  app.get('/admin/assets/:file', async (req: any, reply: any) => {
    const file = req.params.file;
    // Path traversal guard: the router percent-decodes :file, so "..%2f" arrives
    // as "../". Reject separators/dot-segments outright (asset names are flat
    // hashed filenames like "index-CeY-Ig7t.js").
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..') || file.includes('\0')) {
      return reply.status(400).send('Bad Request');
    }
    const filePath = path.join(FRONTEND_DIST, 'assets', file);
    // Defense in depth: the resolved path must stay inside the assets dir.
    if (!path.resolve(filePath).startsWith(path.join(FRONTEND_DIST, 'assets') + path.sep)) {
      return reply.status(400).send('Bad Request');
    }
    if (fs.existsSync(filePath)) {
      // Hashed filenames → safe to cache forever; a rebuild produces new names.
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      if (file.endsWith('.js')) reply.type('application/javascript');
      else if (file.endsWith('.css')) reply.type('text/css');
      else if (file.endsWith('.svg')) reply.type('image/svg+xml');
      else if (file.endsWith('.json')) reply.type('application/json');
      else if (file.endsWith('.woff2')) reply.type('font/woff2');
      else if (file.endsWith('.woff')) reply.type('font/woff');
      else if (file.endsWith('.ttf')) reply.type('font/ttf');
      return reply.send(fs.readFileSync(filePath));
    }
    return reply.status(404).send('Not Found');
  });

  // 1b. Public assets copied verbatim from frontend/public (Vite emits them at
  // the dist root). The hashed `assets/` handler above covers bundles only —
  // without this route the SPA wildcard below answers `/admin/provider-logos/*`
  // with index.html, so every bundled logo silently fell back to the remote
  // catalog (or a monogram) in production/desktop builds. Names are stable (not
  // content-hashed), so the response revalidates instead of caching immutably.
  const PUBLIC_MIME: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
  };
  app.get('/admin/provider-logos/:file', async (req: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) => {
    const file = req.params.file;
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..') || file.includes('\0')) {
      return reply.status(400).send('Bad Request');
    }
    const dir = path.join(FRONTEND_DIST, 'provider-logos');
    const filePath = path.join(dir, file);
    if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) {
      return reply.status(400).send('Bad Request');
    }
    const mime = PUBLIC_MIME[path.extname(file).toLowerCase()];
    if (!mime || !fs.existsSync(filePath)) return reply.status(404).send('Not Found');
    return reply.header('Cache-Control', 'no-cache').type(mime).send(fs.readFileSync(filePath));
  });

  // 2. React SPA HTML Handler
  const handleHtml = async (_req: any, reply: any) => {
    const indexHtmlPath = path.join(FRONTEND_DIST, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
      // no-cache: the HTML references hashed asset names — always re-fetch it so
      // a rebuilt frontend is picked up on a normal refresh (no hard-reload needed).
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(fs.readFileSync(indexHtmlPath, 'utf8'));
    }
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head><title>OmniCellRouter Gateway Console</title></head>
        <body style="background:#09090b;color:#f4f4f5;font-family:sans-serif;padding:40px;text-align:center;">
          <h2>⚡ OmniCellRouter Gateway Console</h2>
          <p style="color:#a1a1aa;">The web console assets have not been built yet.</p>
          <p>Please run <code style="color:#06b6d4;background:rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;">npm run build:frontend</code> to build the React application.</p>
        </body>
      </html>
    `);
  };

  // Everything under /admin/ is the console. Wildcard registration (not an
  // explicit page list) makes a new React page impossible to 401/404 on
  // browser refresh — App.tsx stays the single source of truth for pages.
  // Router specificity: the parametric /admin/assets/:file handler above
  // outranks this wildcard, so hashed build assets hit the static handler.
  app.get('/admin', handleHtml);
  app.get('/admin/*', handleHtml);

  // `/` is an entry redirect, not a page: land on the console prefix.
  app.get('/', async (_req: any, reply: any) => reply.redirect('/admin/', 301));

  // 3. Status Aggregation API for Console
  const handleStatus = async () => {
    const cbManager = registry.getCircuitBreakerManager();
    // `pairs` is additive: the model-only counts above
    // stay exactly as every existing consumer reads them; the guardrails view
    // renders the credential-scoped layer from this block.
    // `rules` is additive too (circuit-breaker rules spec): the EFFECTIVE
    // (startup-resolved) ruleset + the five-switch banner state the /guardrails
    // page renders ("automatic tripping: on / partly off / all off / shadow").
    // Saved rule edits hot-apply on every config save (handleSaveConfig →
    // manager.applyConfig swaps rule sets, never live state machines).
    const cbSummary = {
      ...cbManager.getSummary(),
      pairs: cbManager.getPairSummary(),
      rules: cbManager.getRulesStatus(),
      // Static read-only reference: the classifier's fixed error-class mapping
      // (ADR-0004 §1), single-sourced from CLASSIFIER_TAXONOMY. The console's
      // breaker-rules page renders it to explain what each rule's `auto` scope
      // resolves to and why e.g. 415 never trips while 403 counts. Additive:
      // older gateways omit it and the panel stays hidden.
      classifier: CLASSIFIER_TAXONOMY,
    };
    const metrics = orchestrator.getTracker().getStats();
    const clients = await getAllClientStatuses();
    const config = loadConfig();

    // Runtime credential directory (hash prefixes ONLY — the same display-safe
    // form pair snapshots already carry): lets the guardrails view name an
    // orphan breaker's owner (e.g. the inline config-baked default credential, which
    // lives outside the store roster) instead of a bare #hash. Union of the
    // bound store (the connected roster — independent of model registration)
    // and the registry chains, so a connected-but-model-less provider is named
    // here too.
    const credentialHashes: { provider: string; keyHashPrefix: string }[] = [];
    const seenHashes = new Set<string>();
    const pushHash = (provider: string, keyHashPrefix: string) => {
      const id = `${provider}#${keyHashPrefix}`;
      if (seenHashes.has(id)) return;
      seenHashes.add(id);
      credentialHashes.push({ provider, keyHashPrefix });
    };
    try {
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      for (const o of store.credentialsOverview()) {
        for (const meta of store.listCredentials(o.providerId)) {
          if (meta.keyHashPrefix) pushHash(o.providerId, meta.keyHashPrefix);
        }
      }
    } catch {
      // Unreadable/unbound store — registry rows below still name what boot saw.
    }
    for (const m of registry.getAllModels()) {
      for (const c of registry.getCredentialChain(m.provider) ?? []) pushHash(m.provider, c.keyHashPrefix);
    }

    return {
      status: 'ok',
      // Runtime version of THIS gateway process — the console shows it as the
      // "Gateway Console vX" tag, so a stale cached bundle can't misreport.
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      // Active environment (book-set) — name + resolved config path only;
      // console env-switching UI lands in Phase 3.
      env: {
        name: resolveEnvName(),
        configPath: getEnvPaths().configPath,
      },
      // Actual listening port (config.yaml `port` is the single source of truth)
      // so the console header shows the real gateway port instead of a literal.
      port: config.port,
      metrics,
      circuitBreakers: cbSummary,
      clients,
      credentialHashes,
      registeredModelsCount: registry.getAllModels().length,
      // Inbound forward-proxy runtime status (see forward-proxy/status.ts) —
      // the Proxy Access page polls this to show running / failed / pending.
      forwardProxy: {
        enabled: Boolean(config.forwardProxy?.enabled),
        // ADR-0019: a disabled upstream verification is a standing risk, so the
        // console states it next to the runtime status instead of hiding it in
        // a YAML comment.
        upstreamInsecure: config.forwardProxy?.upstreamTls?.insecure === true,
        ...getForwardProxyStatus(),
      },
    };
  };

  app.get('/api/admin/status', handleStatus);

  // 3A1'. Release update check — display-only and cached in-process. The
  // first console read starts the GitHub call in the background and answers
  // `checking: true`; the console polls until the snapshot settles. A stale
  // entry (success or failure TTL) triggers the next background refresh here,
  // so every console load is an opportunity to learn about a new release
  // without any request ever waiting on api.github.com.
  app.get('/api/admin/update-check', async () => ({ status: 'ok', ...getUpdateChecker().status() }));

  // 3A2. Forward-proxy access log: every NON-intercepted HTTP exchange plus
  // CONNECT tunnel decisions (forward-proxy/access-log.ts — memory ring backed
  // by persisted daily JSONL under <ocrHome>/forward-proxy/access-log/; binary
  // bodies land as raw files referenced by reqBodyFile/resBodyFile). Newest
  // first; the Proxy Access page renders it.
  type BodyToken = { k: 'p' | 'g'; r: string; d?: string };
  const mintBodyToken = (t: BodyToken): string => Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
  const bodyTokenOf = (ref: unknown, decoder?: string): string | undefined =>
    typeof ref === 'string' && ref !== ''
      ? mintBodyToken(decoder ? { k: 'g', r: ref, d: decoder } : { k: 'p', r: ref })
      : undefined;
  const resolveBodyPath = (token: string): string | null => {
    let t: BodyToken;
    try {
      t = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as BodyToken;
    } catch {
      return null;
    }
    if (t?.k === 'p' && typeof t.r === 'string') return proxyAccessBodyPath(t.r);
    if (t?.k === 'g' && typeof t.r === 'string' && typeof t.d === 'string' && getGatewayById(t.d)) {
      return bodyPath(t.d, t.r);
    }
    return null;
  };
  // 3A2. THE ONE traffic-timeline endpoint — the console never addresses a
  // subsystem, it declares a SCOPE and the backend federates:
  //   scope=live    → memory ring (proxy access log) + every plugin gateway's
  //                   tail feed, interleaved by timestamp, newest first.
  //   scope=history → the PERSISTED federated scan: proxy day JSONL
  //                   (`persistDays` retention) + each plugin feed's day
  //                   JSONL, merged, paged — one exact total across sources.
  // Both scopes share one row shape (a discriminated union on `source`), so
  // the console renders one table and one pager whatever the scope. Filters
  // (kind/method/status/host) bind history server-side; live filters stay in
  // the console (the ring is already fully resident there).
  /** Timestamp of a timeline row in ms — proxy rows carry epoch ms, plugin
   *  rows an ISO string; 0 when unparsable (sorts to the oldest end). */
  const tsOf = (r: TimelineRow): number =>
    'ev' in r ? (r.ev as { ts?: number }).ts ?? 0 : Date.parse((r.ex as { ts?: string }).ts ?? '') || 0;
    type TimelineRow =
    | { source: 'proxy'; ev: Record<string, unknown> }
    | { source: string; ex: Record<string, unknown> };
  app.get('/api/admin/proxy-log', async (req) => {
    const q = req.query as Record<string, string | undefined>;

    if (q.scope === 'history') {
      const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
      const pageNo = Math.max(Number(q.page) || 1, 1);
      const kindF = q.kind ?? '';
      const methodF = q.method ?? '';
      const statusF = q.status ?? '';
      const hostF = (q.host ?? '').toLowerCase();

      const rows: Array<
        | { source: 'proxy'; tsMs: number; ev: ProxyAccessEvent }
        | { source: string; tsMs: number; ex: TrafficExchange }
      > = [];
      for (const ev of readProxyAccessHistory({
        kind: kindF || undefined,
        method: methodF || undefined,
        status: statusF || undefined,
        host: hostF || undefined,
      })) {
        rows.push({ source: 'proxy', tsMs: ev.ts, ev });
      }
      for (const { id } of trafficDecoders()) {
        const dir = path.join(trafficRoot(), id);
        let files: string[] = [];
        try {
          files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
        } catch {
          continue; // fresh plugin / unreadable feed dir — no history from it
        }
        for (const f of files) {
          let lines: string[] = [];
          try {
            lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
          } catch {
            continue;
          }
          for (const line of lines) {
            if (!line) continue;
            let ex: TrafficExchange;
            try {
              ex = JSON.parse(line) as TrafficExchange;
            } catch {
              continue; // torn final line (crash mid-append) skips one row
            }
            if (methodF && ex.method !== methodF) continue;
            if (hostF && (ex.authority ?? '').toLowerCase() !== hostF) continue;
            // Plugin rows are HTTP by definition (the console's `kindOf`):
            // a CONNECT/WS filter excludes them, and a status filter prunes
            // them — otherwise the federated total counts rows the delete
            // path (and the rendered table) never includes.
            if (kindF && kindF !== 'http') continue;
            if (statusF && String(ex.status ?? '') !== statusF) continue;
            rows.push({ source: id, tsMs: Date.parse(ex.ts ?? '') || 0, ex });
          }
        }
      }
      rows.sort((a, b) => b.tsMs - a.tsMs);
      const total = rows.length;
      const pages = Math.max(Math.ceil(total / limit), 1);
      const slice = rows.slice((pageNo - 1) * limit, (pageNo - 1) * limit + limit);
      // Read-time decode is PAGE-scoped: dissect + hex previews only for the
      // rows actually returned, never for the whole scan.
      return {
        status: 'ok',
        rows: slice.map((r) =>
          'ev' in r
            ? {
                source: 'proxy' as const,
                ev: { ...r.ev, reqBodyToken: bodyTokenOf(r.ev.reqBodyFile), resBodyToken: bodyTokenOf(r.ev.resBodyFile) },
              }
            : { source: r.source, ex: decoratePluginRow(r.source, r.ex) }
        ),
        total,
        page: pageNo,
        pages,
      };
    }

    // scope=live (default) — the merged tail: ring + every plugin feed tail.
    const s = proxyAccessLogSettings();
    const rows: TimelineRow[] = [];
    const hiddenProxy = liveHiddenProxyIds();
    for (const e of listProxyAccessEvents()) {
      if (hiddenProxy.has(e.id)) continue;
      rows.push({ source: 'proxy', ev: { ...e, reqBodyToken: bodyTokenOf(e.reqBodyFile), resBodyToken: bodyTokenOf(e.resBodyFile) } });
    }
    for (const { id } of trafficDecoders()) {
      const gw = getGatewayById(id);
      if (!gw || typeof gw.dissect !== 'function') continue;
      const dir = path.join(trafficRoot(), id);
      const events: TrafficExchange[] = [];
      try {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
          for (const f of files) {
            if (events.length >= TRAFFIC_TAIL) break;
            const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
            for (let i = lines.length - 1; i >= 0 && events.length < TRAFFIC_TAIL; i--) {
              try {
                events.push(JSON.parse(lines[i]) as TrafficExchange);
              } catch {
                continue; // a torn final line (crash mid-append) skips one row
              }
            }
          }
        }
      } catch {
        // Unreadable feed dir = empty feed.
      }
      const hiddenPlugin = liveHiddenPluginKeys(id);
      for (const ex of events) {
        const key = typeof ex.id === 'string' ? ex.id : ex.ts;
        if (key && hiddenPlugin.has(key)) continue;
        rows.push({ source: id, ex: decoratePluginRow(id, ex) } as TimelineRow);
      }
    }
    rows.sort((a, b) => (tsOf(a) || 0) - (tsOf(b) || 0));
    return {
      status: 'ok',
      enabled: s.enabled,
      bodyBytes: s.bodyBytes,
      rows: rows.reverse(),
      total: rows.length,
    };
  });

  app.post('/api/admin/proxy-log/clear', async () => {
    clearProxyAccessLog();
    return { status: 'ok' };
  });

  // 3A2c. HISTORY delete by FILTER — the history-mode counterpart of the
  // clear button. History is the PERSISTED scope, so this rewrite touches the
  // day JSONL + body sidecars only and leaves the live ring alone (ADR-0017
  // §5: the same row may still be listed in the live view until it ages out).
  // The console only holds ONE page of the persisted federation at a time, so
  // "what I see" and "what I asked to delete" would diverge; the console sends
  // the SAME filter vocabulary it queries with and the backend deletes every
  // matching persisted row across ALL sources. The response reports per-source
  // counts so the confirm toast is never a guess.
  app.post('/api/admin/proxy-log/history/delete', async (req) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const kindF = b.kind ?? '';
    const methodF = b.method ?? '';
    const statusF = b.status ?? '';
    const hostF = (b.host ?? '').toLowerCase();

    // Proxy side: ids → the persisted-row deleter (day files + body sidecars).
    const ids = readProxyAccessHistory({
      kind: kindF || undefined,
      method: methodF || undefined,
      status: statusF || undefined,
      host: hostF || undefined,
    }).map((e) => e.id);
    const proxyDeleted = ids.length > 0 ? deletePersistedProxyEvents(ids) : 0;

    // Plugin side: rewrite each feed's day files without the matching lines.
    const deletedPlugins: Record<string, number> = {};
    for (const { id } of trafficDecoders()) {
      // Plugin rows are ALWAYS `http` (the console's `kindOf`): a CONNECT/WS
      // filter cannot match them, but the default `http` filter must — the
      // history table renders those rows, so refusing every kind filter left
      // them behind after a clear (the "clear is not clean" bug).
      if (kindF && kindF !== 'http') continue;
      const dir = path.join(trafficRoot(), id);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      } catch {
        continue;
      }
      let removed = 0;
      const bodyIds = new Set<string>();
      for (const f of files) {
        const abs = path.join(dir, f);
        let kept: string[] = [];
        try {
          kept = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean);
        } catch {
          continue;
        }
        let touched = false;
        const keptOut: string[] = [];
        for (const line of kept) {
          let ex: TrafficExchange;
          try {
            ex = JSON.parse(line) as TrafficExchange;
          } catch {
            keptOut.push(line); // a torn line survives deletion round-trips
            continue;
          }
          const hit =
            (!methodF || ex.method === methodF) &&
            (!hostF || (ex.authority ?? '').toLowerCase() === hostF) &&
            (!statusF || String((ex as { status?: number }).status ?? '') === statusF);
          if (hit) {
            touched = true;
            removed++;
            if (typeof (ex as { id?: unknown }).id === 'string') bodyIds.add((ex as { id: string }).id);
            continue;
          }
          keptOut.push(line);
        }
        if (!touched) continue;
        try {
          if (keptOut.length === 0) fs.unlinkSync(abs);
          else fs.writeFileSync(abs, keptOut.join('\n') + '\n');
        } catch {
          // Best effort — the row is gone from the feed view either way.
        }
      }
      // Sidecar bytes are named `<day>/<id>-<side>.bin`: drop only the ones
      // whose row just went away, never a neighbour's.
      if (bodyIds.size > 0) {
        const bodiesRoot = path.join(dir, 'bodies');
        if (fs.existsSync(bodiesRoot)) {
          for (const day of fs.readdirSync(bodiesRoot)) {
            const dayDir = path.join(bodiesRoot, day);
            let names: string[] = [];
            try {
              names = fs.readdirSync(dayDir);
            } catch {
              continue;
            }
            for (const name of names) {
              const owner = name.replace(/-(?:req|res)\.bin$/, '');
              if (!bodyIds.has(owner)) continue;
              try {
                fs.unlinkSync(path.join(dayDir, name));
              } catch {
                // Locked file (Windows) — the row is gone, the blob is orphaned.
              }
            }
          }
        }
      }
      if (removed > 0) deletedPlugins[id] = removed;
    }
    return { status: 'ok', deleted: { proxy: proxyDeleted, plugins: deletedPlugins } };
  });


  // 3A1b. Explicit FULL wipe across BOTH scopes — ring, proxy day files +
  // bodies, and every plugin feed dir. This is an admin API, not either
  // console button: live clear hides only, history delete rewrites only
  // (ADR-0017 §5). Gateway feeds are console-owned artifacts on disk, so they
  // are removed here rather than through the plugin.
  app.post('/api/admin/traffic-clear', async () => {
    clearProxyAccessLog();
    const cleared: string[] = [];
    for (const [id, gw] of listGateways()) {
      if (typeof gw.dissect !== 'function') continue;
      const dir = path.join(trafficRoot(), id);
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        cleared.push(id);
      } catch {
        // A locked feed (Windows handle) must not fail the whole clear.
      }
    }
    return { status: 'ok', cleared };
  });

  /**
   * 3A1c. Hide EXACTLY the rows the LIVE view is showing — the live-scope
   * counterpart of the history delete. Live and history are scopes over the
   * same feeds, not separate stores (ADR-0017 §5), so this route never touches
   * a file: proxy rows leave the ring, and plugin rows are recorded in a
   * live-only tombstone overlay that the live read applies and history
   * ignores. The persisted day JSONL and body sidecars stay intact and remain
   * listed/deletable from History mode.
   *
   * The console sends row keys (`id`, else the legacy feed `ts`) with their
   * timestamps, never a predicate: the filter lives in one place (the page)
   * and a backend copy would drift into hiding more than the operator sees.
   */
  app.post('/api/admin/traffic-live-clear', async (req) => {
    const body = (req.body ?? {}) as { proxy?: unknown; plugins?: unknown };
    const asLiveKeys = (v: unknown): LiveHiddenKey[] => {
      if (!Array.isArray(v)) return [];
      const out: LiveHiddenKey[] = [];
      for (const x of v) {
        if (!x || typeof x !== 'object' || !('key' in x) || !('ts' in x)) continue;
        if (typeof x.key === 'string' && x.key.length > 0 && typeof x.ts === 'number' && Number.isFinite(x.ts)) {
          out.push({ key: x.key, ts: x.ts });
        }
      }
      return out;
    };
    // Only ids the ring actually holds are part of the live view right now;
    // the tombstones cover the plugin tail rows (history ignores them).
    const ringIds = new Set(listProxyAccessEvents().map((e) => e.id));
    const liveProxy = asLiveKeys(body.proxy).filter((k) => ringIds.has(k.key));
    const plugins: Record<string, LiveHiddenKey[]> = {};
    if (body.plugins && typeof body.plugins === 'object' && !Array.isArray(body.plugins)) {
      for (const [decoderId, raw] of Object.entries(body.plugins)) {
        plugins[decoderId] = asLiveKeys(raw);
      }
    }
    forgetProxyAccessRingEvents(liveProxy.map((k) => k.key));
    const hidden = hideLiveEvents(liveProxy, plugins);
    return { status: 'ok', hidden };
  });

  // 3A2b. Generic plugin-traffic feed (Wireshark dissector model, ADR-0017
  // client gateways): each gateway that declares `dissect` owns a protocol
  // decoder AND a raw day-JSONL feed under
  // <ocrHome>/plugins/traffic/<pluginId>/. The console tab lists the decoder
  // registry and reads a feed, applying the plugin's dissector at READ time.
  // The plugin stays self-contained — the route only owns the feed layout and
  // tail discipline (newest first, capped).
  // Resolved per call, never captured at registration: OCR_HOME is the
  // environment-book-set switch (ADR-0007) and may change under a live server.
  const trafficRoot = (): string => path.join(getOcrHomeDir(), 'plugins', 'traffic');
  const TRAFFIC_TAIL = 500;
  /** Per-side DISPLAY window handed to the dissector (and the hex preview).
   *  Capture is full fidelity on disk; only this read is bounded. */
  const TRAFFIC_DISSECT_WINDOW = 32 * 1024;
  /** Inline hex preview length (the drawer's hex fallback). */
  const TRAFFIC_HEX_PREVIEW = 1024;
  /** Strict sidecar ref: `<YYYYMMDD>/<id>-<side>.bin`, no traversal. */
  const TRAFFIC_BODY_REF_RE = /^\d{8}\/[A-Za-z0-9._-]+\.bin$/;
  /** Resolve a feed body ref to an absolute path inside that decoder's dir. */
  const bodyPath = (decoderId: string, ref: string): string | null => {
    if (!TRAFFIC_BODY_REF_RE.test(ref)) return null;
    const root = path.join(trafficRoot(), decoderId, 'bodies');
    const abs = path.join(root, ref);
    return abs.startsWith(root + path.sep) ? abs : null;
  };
  const trafficDecoders = (): { id: string; label: string }[] => {
    const out: { id: string; label: string }[] = [];
    for (const [id, gw] of listGateways()) {
      if (typeof gw.dissect !== 'function') continue;
      out.push({ id, label: gw.hosts.join(', ') });
    }
    return out;
  };
  /** Read-time wire decoration for ONE plugin feed row: body windows for the
   *  dissector + hex preview, dissect layers, body tokens, bodies stripped.
   *  Shared by the live tail route and the federated history scan — one
   *  decoration path, never two. */
  const decoratePluginRow = (decoderId: string, ex: TrafficExchange): Record<string, unknown> => {
    const windowOf = (ref: unknown): Buffer | undefined => {
      if (typeof ref !== 'string') return undefined;
      const abs = bodyPath(decoderId, ref);
      if (!abs) return undefined;
      try {
        const fd = fs.openSync(abs, 'r');
        try {
          const buf = Buffer.alloc(TRAFFIC_DISSECT_WINDOW);
          const read = fs.readSync(fd, buf, 0, TRAFFIC_DISSECT_WINDOW, 0);
          return buf.subarray(0, read);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return undefined;
      }
    };
    const reqWin = windowOf(ex.reqBodyFile);
    const resWin = windowOf(ex.resBodyFile);
    // Legacy rows (inline base64 body) still decode: the window is the
    // inline body itself, so both feed generations share one path.
    const reqBytes = reqWin ?? (typeof ex.reqBody === 'string' ? Buffer.from(ex.reqBody, 'base64') : undefined);
    const resBytes = resWin ?? (typeof ex.resBody === 'string' ? Buffer.from(ex.resBody, 'base64') : undefined);
    let dissected: DissectedExchange | undefined;
    try {
      dissected = getGatewayById(decoderId)?.dissect?.({ ...ex, reqBody: reqBytes?.toString('base64'), resBody: resBytes?.toString('base64') });
    } catch {
      dissected = undefined; // a decoder bug degrades to the raw view only
    }
    // Strip bodies from the wire view: the console gets byte counts,
    // file refs and a small hex preview, never the payload itself.
    const { reqBody: _rq, resBody: _rs, ...meta } = ex as Record<string, unknown>;
    void _rq;
    void _rs;
    const hexPreview = (b?: Buffer): string | undefined => {
      if (!b || b.length === 0) return undefined;
      return b.subarray(0, TRAFFIC_HEX_PREVIEW).toString('hex');
    };
    return {
      ...meta,
      reqBodyToken: bodyTokenOf(ex.reqBodyFile, decoderId),
      resBodyToken: bodyTokenOf(ex.resBodyFile, decoderId),
      reqHex: hexPreview(reqBytes),
      resHex: hexPreview(resBytes),
      decoded: dissected,
    };
  };
  app.get('/api/admin/plugin-traffic', async () => {
    return { status: 'ok', decoders: trafficDecoders() };
  });
  app.get('/api/admin/plugin-traffic/:decoder', async (req, reply) => {
    const decoderId = String((req.params as Record<string, string>).decoder ?? '');
    const gw = getGatewayById(decoderId);
    if (!gw || typeof gw.dissect !== 'function') {
      reply.code(404);
      return { status: 'error', message: `no traffic decoder registered for '${decoderId}'` };
    }
    const dir = path.join(trafficRoot(), decoderId);
    const events: Array<Record<string, unknown>> = [];
    let days = 0;
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
        for (const f of files) {
          if (events.length >= TRAFFIC_TAIL) break;
          days++;
          const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0 && events.length < TRAFFIC_TAIL; i--) {
            let raw: unknown;
            try {
              raw = JSON.parse(lines[i]);
            } catch {
              continue; // a torn final line (crash mid-append) skips one row
            }
            const ex = raw as TrafficExchange;
            events.push(decoratePluginRow(decoderId, ex));
          }
        }
      }
    } catch {
      // Unreadable feed dir (fresh plugin, permissions) = empty feed.
    }
    return { status: 'ok', days, truncated: events.length >= TRAFFIC_TAIL, events };
  });

  // Raw persisted binary body (ref format `<day>/pa-...-<side>.bin`, validated
  // inside readProxyAccessBodyFile — no traversal).
  // 3A2c. THE body download — one neutral endpoint for every captured body,
  // whatever stored it. The console never learns which subsystem owns the
  // bytes (or which plugin captured them): the row carries an opaque token and
  // only this route resolves it. Validation happens AFTER decoding the token,
  // so a hand-crafted token is no stronger than the refs the feeds already
  // expose (strict grammar + containment inside the resolved root).
  app.get('/api/admin/traffic-body/:token', async (req, reply) => {
    const token = String((req.params as Record<string, string>).token ?? '');
    const abs = resolveBodyPath(token);
    if (!abs || !fs.existsSync(abs)) {
      reply.code(404);
      return { status: 'error', message: 'body not found' };
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${path.basename(abs)}"`);
    return reply.send(fs.createReadStream(abs));
  });

  // 3A3. OS system proxy ownership for the inbound forward proxy: snapshot →
  // point at 127.0.0.1:<port> → one-click restore (forward-proxy/system-proxy.ts).
  app.get('/api/admin/system-proxy', async () => {
    const fp = getRuntimeConfigRef()?.forwardProxy;
    const port = fp?.port ?? DEFAULT_FORWARD_PROXY_PORT;
    const sys = await getSystemProxyStatus(port, osBypassHosts(fp?.rules));
    return { status: 'ok', ...sys, proxyEnabled: Boolean(fp?.enabled) };
  });

  app.post('/api/admin/system-proxy/enable', async () => {
    const fp = getRuntimeConfigRef()?.forwardProxy;
    const port = fp?.port ?? DEFAULT_FORWARD_PROXY_PORT;
    const sys = await enableSystemProxy(port, osBypassHosts(fp?.rules));
    return { status: 'ok', ...sys };
  });

  app.post('/api/admin/system-proxy/disable', async () => {
    const fp = getRuntimeConfigRef()?.forwardProxy;
    const port = fp?.port ?? DEFAULT_FORWARD_PROXY_PORT;
    const sys = await disableSystemProxy(port, osBypassHosts(fp?.rules));
    return { status: 'ok', ...sys };
  });

  // 3A4. Forward-proxy rule table (ADR-0018): lint + dry-run resolution. The
  // console renders the warning CODES through i18n and shows which rule a probe
  // host hits, so an ordered table is never a black box. `rules` in the body =
  // the UNSAVED table being edited; omitted = the live one.
  app.post('/api/admin/forward-proxy/rules/resolve', async (req) => {
    const body = (req.body ?? {}) as { host?: unknown; rules?: unknown };
    const live = getRuntimeConfigRef();
    const rawRules = Array.isArray(body.rules) ? body.rules : live?.forwardProxy?.rules;
    const proxyEnabled = live?.proxy?.enabled === true;
    const rules = normalizeRules(rawRules);
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    return {
      status: 'ok',
      rules,
      warnings: lintRules(rawRules, proxyEnabled),
      proxyEnabled,
      // The resolver is the SAME function the proxy legs call, so the preview
      // can never disagree with the live decision.
      decision: host ? resolveHost(host, rules) : null,
    };
  });

  // 3B. Token usage aggregation from the trace ring: windowed totals plus
  // per-API-key rows (raw counts only — no cost accounting). Optional
  // `?since=<epoch-ms>` narrows to traces with `timestamp >= since`;
  // omitted covers the whole in-memory ring (bounded by trace retention).
  app.get('/api/admin/usage', async (req) => {
    const query = req.query as { since?: string };
    const sinceRaw = query.since ? Number(query.since) : NaN;
    const sinceTs = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;
    const { totals, keys } = orchestrator.getTraceTracker().getUsageStats(
      sinceTs !== undefined ? { sinceTs } : undefined
    );
    return { status: 'ok', totals, keys };
  });

  // 3C. Quota tracking surface: the coverage plan (which providers
  //     the release/config actually probe), rejected config entries (validation
  //     failures surfaced, never silent), every stored snapshot, and the quota
  //     events ledger (inference-side ceiling burns). Display-only plane —
  //     nothing here gates routing.
  app.get('/api/admin/quota', async () => {
    const prober = getQuotaProber();
    const plan = prober?.getPlan();
    const coverage = plan
      ? Array.from(plan.byProvider.entries()).map(([providerId, target]) => ({
          providerId,
          kind: target.kind,
          entryId: target.kind === 'dsl' ? target.entry.id : `adapter:${target.adapter.id}`,
        }))
      : [];
    return {
      status: 'ok',
      // The live kill switch (quota.enabled) — not just boot wiring: a config
      // save can disable probing without a restart.
      enabled: prober !== undefined && (getRuntimeConfigRef() ?? loadConfig()).quota?.enabled !== false,
      coverage,
      rejected: plan?.rejected ?? [],
      pairs: await buildQuotaPairRows(registry, orchestrator.getTraceTracker()),
      events: getQuotaEventLog().list().slice(0, 100),
    };
  });

  // Console "refresh now": invalidate (one pair, or the whole schedule), then
  // run ONE bounded probe cycle INSIDE the request — the page awaits this and
  // re-reads the snapshot, so fresh numbers land before it repaints. The
  // interval tick and its due-based cadence are untouched; the engine-level
  // 429 gate still wins (armed gate refuses, mid-cycle 429 stops the cycle).
  app.post('/api/admin/quota/refresh', async (req) => {
    const body = req.body as { providerId?: string; keyHashPrefix?: string };
    const prober = getQuotaProber();
    if (!prober) return { status: 'ok', success: false, reasonCode: 'quota_disabled', error: 'quota prober is disabled' };
    const report = await prober.refreshNow(
      body?.providerId && body.keyHashPrefix
        ? { providerId: body.providerId, keyHashPrefix: body.keyHashPrefix }
        : {}
    );
    return {
      status: 'ok',
      success: !report.disabled && !report.busy,
      ...(report.disabled ? { reasonCode: 'quota_disabled', error: 'quota prober is disabled' } : {}),
      ...(report.busy ? { reasonCode: 'busy', error: 'another probe cycle is still running' } : {}),
      probed: report.probed,
      pending: report.pending,
      rateLimited: report.rateLimited,
    };
  });

  // Last raw HTTP exchange for one pair (memory-only capture — the quota
  // endpoint's own response, display-safe: url/status/body, never headers;
  // starts empty after a restart by design).
  app.get('/api/admin/quota/last-probe', async (req) => {
    const { providerId, keyHashPrefix } = req.query as { providerId?: string; keyHashPrefix?: string };
    if (!providerId || !keyHashPrefix) return { status: 'ok', http: null };
    return { status: 'ok', http: getQuotaStore().getLastHttp(`${providerId}#${keyHashPrefix}`) ?? null };
  });

  // 3D. Route-entry experience table (ADR-0011): browse, hand-edit (lands as
  // an immutable human row), delete. The 16-hex prompt hash identifies rows;
  // snippets (when enabled) are the human-readable aid.
  app.get('/api/admin/route-entries', async (req) => {
    const query = req.query as { limit?: string; offset?: string; q?: string; sort?: string };
    const limit = query.limit !== undefined ? Math.min(parseInt(query.limit, 10) || 100, 500) : 100;
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);
    const SORTS = ['updatedAt', 'hitCount', 'sessionCount'] as const;
    const sort = (SORTS as readonly string[]).includes(query.sort ?? '')
      ? (query.sort as (typeof SORTS)[number])
      : 'updatedAt';
    const { rows, total } = getRouteEntryStore().list({ limit, offset, q: query.q, sort });
    return {
      status: 'ok',
      rows: rows.map((e) => ({
        promptHash: e.promptHash,
        snippet: e.snippet,
        tier: e.tier,
        effort: e.effort,
        source: e.source,
        confidence: e.confidence,
        hitCount: e.hitCount,
        sessionCount: e.sessions.length,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
      total,
      offset,
      limit,
      gate: routeEntriesGate(),
    };
  });

  app.patch('/api/admin/route-entries/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const body = req.body as { tier?: string; effort?: string | null };
    const tier = body?.tier;
    if (!tier || !['lite', 'plus', 'pro', 'ultra'].includes(tier)) {
      return reply.status(400).send({ success: false, message: "tier must be one of lite|plus|pro|ultra" });
    }
    const effort =
      body?.effort === null || body?.effort === undefined || body?.effort === ''
        ? undefined
        : EFFORT_LADDER.includes(body.effort as any)
          ? (body.effort as ReasoningEffort)
          : undefined;
    if (body?.effort !== null && body?.effort !== undefined && body?.effort !== '' && !EFFORT_LADDER.includes(body.effort as any)) {
      return reply.status(400).send({ success: false, message: `effort must be one of ${EFFORT_LADDER.join('|')} (or null to clear)` });
    }
    const entry = getRouteEntryStore().humanEdit(hash, tier as TierLevel, effort);
    if (!entry) return reply.status(404).send({ success: false, message: `no route entry '${hash}'` });
    appendRoutingLedger({ kind: 'entry_write', detail: { source: 'human', tier: entry.tier, effort: entry.effort, promptHash: hash } });
    return { status: 'ok', entry: { promptHash: entry.promptHash, tier: entry.tier, effort: entry.effort, source: entry.source, confidence: entry.confidence } };
  });

  app.delete('/api/admin/route-entries/:hash', async (req) => {
    const { hash } = req.params as { hash: string };
    const removed = getRouteEntryStore().remove(hash);
    return { status: 'ok', removed };
  });

  // Bulk clear (console confirm dialog guards it): wipes every learned row,
  // human rows included — the table starts empty by design. One ledger line.
  app.delete('/api/admin/route-entries', async () => {
    const removed = getRouteEntryStore().clearAll();
    if (removed > 0) appendRoutingLedger({ kind: 'entry_write', detail: { source: 'human', clearAll: true, count: removed } });
    return { status: 'ok', removed };
  });

  // 3E. Layer 2 decision layer last wire-attempt outcome — the /auto page surfaces a
  // failure until a later attempt succeeds (cache hits never clear it).
  app.get('/api/admin/decider/outcome', async () => ({
    status: 'ok',
    outcome: Layer2Decision.getLastOutcome(),
  }));

  // 4. Client Interception Setup / Teardown
  const handleSetup = async (req: any, reply: any) => {
    const { client } = req.params as { client: string };
    const { models, apiKey, contextWindow, extraModels, virtualModels, agentModels, profile } = (req.body || {}) as {
      models?: Record<string, string>;
      apiKey?: string;
      contextWindow?: number;
      extraModels?: string[];
      virtualModels?: string[];
      agentModels?: Record<string, string>;
      profile?: { id?: string; bindings?: Record<string, string> };
    };
    const cleaned = models && typeof models === 'object'
      ? Object.fromEntries(Object.entries(models).map(([k, v]) => [k, String(v ?? 'auto').trim() || 'auto']))
      : undefined;
    const cleanedExtra = Array.isArray(extraModels)
      ? extraModels.map(s => String(s || '').trim()).filter(Boolean)
      : undefined;
    // Follow-mode virtual block: clamp to the known tier aliases in canonical
    // order — the field carries the key policy's allowed verdicts, never
    // arbitrary ids (concrete pins ride in extraModels).
    const cleanedVirtual = Array.isArray(virtualModels)
      ? [...VIRTUAL_AUTO_IDS].filter(id => virtualModels.map(s => String(s || '').trim()).includes(id))
      : undefined;
    const cw = Number(contextWindow);

    // Agent-binding payloads (opencode hook):
    //  - agentModels: manual rows, agent name → modelRef (''/'auto' dropped);
    //  - profile: profile-linked rows — bindings are agent → profile-slot key,
    //    resolved here against the saved profile's slots; slots the profile
    //    no longer defines drop out (the row falls back to inherit).
    //    A wrong write to opencode.jsonc is harder to undo than a refused
    //    setup, so every merged ref must be routable (fail-fast).
    const allowedRefs = new Set<string>([
      // 'auto' is a legal slot ref (inherit-the-default): the adapter skips it.
      'auto', 'lite', 'plus', 'pro', 'ultra',
      ...registry.getAllModels().map(m => m.id),
      ...registry.getCombos().map(c => c.id),
      ...registry.getVariantExposures().map(v => v.id),
    ]);
    const manual: Record<string, string> = {};
    if (agentModels !== undefined) {
      if (!agentModels || typeof agentModels !== 'object' || Array.isArray(agentModels)) {
        return reply.status(400).send({ success: false, message: 'agentModels must be an object of agent name → modelRef' });
      }
      // The admin surface is still a trust boundary: shape-check before
      // iterating (Object.entries over a string would iterate per character).
      const manualEntries = Object.entries(agentModels);
      if (manualEntries.length > 100) {
        return reply.status(400).send({ success: false, message: 'agentModels exceeds 100 entries' });
      }
      for (const [agentName, raw] of manualEntries) {
        const ref = String(raw ?? '').trim();
        if (!ref || ref === 'auto') continue; // inherit the default model
        manual[agentName] = ref;
      }
    }
    const resolvedRefs: Record<string, string> = {};
    const resolvedTags: Record<string, string> = {};
    let profileEcho: { id: string; bindings: Record<string, string> } | undefined;
    if (profile !== undefined) {
      const profileId = (profile.id || '').trim();
      if (!profileId) {
        // Empty id = explicit un-link: sweep router-owned agent overrides + clear echo
        profileEcho = { id: '', bindings: {} };
      } else {
        const p = (loadConfig().modelProfiles || []).find(x => x.id === profileId);
        if (!p) {
          return reply.status(400).send({ success: false, message: `Model profile '${profileId}' not found in config` });
        }
        const bindingsIn = profile.bindings;
        if (bindingsIn && (typeof bindingsIn !== 'object' || Array.isArray(bindingsIn))) {
          return reply.status(400).send({ success: false, message: 'profile.bindings must be an object of agent name → slot key' });
        }
        const bindingEntries = Object.entries(bindingsIn || {});
        if (bindingEntries.length > 100) {
          return reply.status(400).send({ success: false, message: 'profile.bindings exceeds 100 entries' });
        }
        for (const [agentName, slotRaw] of bindingEntries) {
          const slotKey = String(slotRaw || '').trim();
          if (!slotKey) continue; // unlinked
          const ref = (p.slots || {})[slotKey];
          if (!ref) continue; // slot gone from the profile — row falls back to inherit
          resolvedTags[agentName] = slotKey;
          resolvedRefs[agentName] = ref;
        }
        profileEcho = { id: profileId, bindings: resolvedTags };
      }
    }
    // Merge both sources (disjoint per row; manual wins defensively) and
    // fail-fast on any ref the gateway cannot resolve.
    const merged: Record<string, string> = { ...resolvedRefs, ...manual };
    const invalid = Object.entries(merged).filter(([, ref]) => !allowedRefs.has(ref)).map(([name, ref]) => `${name}→${ref}`);
    if (invalid.length > 0) {
      return reply.status(400).send({
        success: false,
        message: `Agent model refs not routable: ${invalid.join(', ')} — register the model / combo first`,
      });
    }
    const agentModelsPayload = agentModels !== undefined || profileEcho !== undefined ? merged : undefined;

    const result = await setupClient(client, {
      ...(cleaned ? { models: cleaned } : {}),
      ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(Number.isFinite(cw) && cw > 0 ? { contextWindow: Math.floor(cw) } : {}),
      ...(cleanedExtra ? { extraModels: cleanedExtra } : {}),
      ...(cleanedVirtual !== undefined ? { virtualModels: cleanedVirtual } : {}),
      ...(agentModelsPayload ? { agentModels: agentModelsPayload } : {}),
      ...(profileEcho ? { profile: profileEcho } : {}),
    });
    if (!result.success) return reply.status(400).send(result);
    return result;
  };

  const handleTeardown = async (req: any, reply: any) => {
    const { client } = req.params as { client: string };
    const result = await teardownClient(client);
    if (!result.success) return reply.status(400).send(result);
    return result;
  };

  app.post('/api/admin/client/:client/setup', handleSetup);
  app.post('/api/admin/client/:client/teardown', handleTeardown);

  /**
   * Resolve a console decider PICK to the PHYSICAL model that answers it.
   * Deliberately the SAME cascade the /v1/systemone surface applies (ADR-0008),
   * so a name means one thing console-wide: a registered id, or a combo (its
   * leader member answers — the same leader pick the routing path uses), is
   * used as-is; a bare tier alias projects onto the leading model of its healthy
   * DECISION-SURFACE pool (the read that keeps systemone-wire models in view);
   * bare `auto` means `systemone.defaultModel`. Undefined = nothing routable
   * behind the name (unknown id, combo without members, empty/all-unhealthy
   * pool, unset default) — callers must refuse, never silently fall back.
   */
  const resolveDecider = (raw: string): ModelRegistration | undefined => {
    const direct = registry.getModel(raw);
    if (direct) return direct;
    if (registry.isCombo(raw)) {
      const members = registry.resolveCombo(raw);
      return members.length > 0 ? registry.pickComboLeader(raw, members) : undefined;
    }
    if (raw === 'auto') {
      const fallback = (loadConfig().systemone?.defaultModel || '').trim();
      return fallback ? registry.getModel(fallback) : undefined;
    }
    if ((MEMBER_TIER_ORDER as readonly string[]).includes(raw)) {
      return registry.getCandidateModelsForTier(raw as TierLevel, true, { decisionSurface: true })[0];
    }
    return undefined;
  };

  /**
   * One-line, model-readable description of a candidate — `criteria` values are
   * the ONLY per-option context the decision prompt carries (the whole
   * questions document is serialized verbatim by convert.ts
   * buildDecisionChatRequest). Registry data is the objective half (tier
   * membership, price, reasoning support, wire); the frontend-supplied note
   * carries what the registry cannot know (a profile slot link). Virtual ids
   * resolve to no entity and are described by what they MEAN, since "assign
   * `lite`" is a legitimate pick. Deliberately NO tier ladder here: writing
   * "ultra = broadest" made every role land on `ultra`.
   */
  const describeCandidate = (rawId: string, note?: string): string => {
    const m = registry.getModel(rawId);
    let body: string;
    if (m) {
      const tiers = registry.tiersOf(m);
      const parts = [
        `registered model; tiers=${tiers.length > 0 ? tiers.join('|') : 'none'}`,
        `price $${m.pricing?.input ?? 0}/$${m.pricing?.output ?? 0} per 1M tokens in/out`,
      ];
      if (m.wire === 'systemone') {
        parts.push('wire=systemone — decision protocol ONLY, cannot serve chat, never assign it to a chat role');
      } else if (m.wire) {
        parts.push(`wire=${m.wire}`);
      }
      const efforts = m.supportedReasoningEfforts;
      if (efforts && efforts.length > 0) parts.push(`reasoning=${efforts.join('|')}`);
      else if (m.supportsReasoningEffort) parts.push('reasoning=yes');
      body = parts.join('; ');
    } else if (registry.resolveVariantRef(rawId)) {
      // Variant sibling id (`<baseId>-<variantId>`): not a registry entry of its
      // own — the base model plus a pinned reasoning level (orchestrator
      // resolves it the same way). Calling it unregistered would steer the
      // decider away from a perfectly legal pick.
      const { base, variant } = registry.resolveVariantRef(rawId)!;
      const tiers = registry.tiersOf(base);
      body =
        `variant of ${base.id} (pins reasoning_effort '${variant.reasoningEffort}'); ` +
        `tiers=${tiers.length > 0 ? tiers.join('|') : 'none'}; ` +
        `price $${base.pricing?.input ?? 0}/$${base.pricing?.output ?? 0} per 1M tokens in/out; ` +
        `wire=${base.wire ?? 'unknown'}`;
    } else if (registry.isCombo(rawId)) {
      body = `combo; members=${registry.resolveCombo(rawId).length} (the router picks a healthy member per request)`;
    } else if (rawId === 'auto') {
      body = 'virtual alias auto; cross-tier auto-routing — the router picks per tier policy, not a fixed model';
    } else if ((MEMBER_TIER_ORDER as readonly string[]).includes(rawId)) {
      body = `virtual alias '${rawId}'; ${TIER_PURPOSE[rawId as TierLevel]}; the router picks a healthy member of that tier pool`;
    } else {
      body = 'NOT registered and not routable — do not pick';
    }
    return note ? `${body} · ${note}` : body;
  };

  /**
   * Smart slot assignment (console "smart assign" button): ONE System One
   * decision call against a caller-chosen decider model — per-target 'choice'
   * questions over the candidate set, so every wire works: systemone-wire
   * deciders go through the native vendor passthrough, chat-wire ones through
   * the protocol conversion (JSON mode + repair), combos resolve to their
   * leader member first. Everything that defines the problem — the slot/role
   * list and the candidate set — is supplied by the frontend (the console
   * drafts ARE the truth, including unsaved edits); the backend only runs the
   * decision and never persists anything. The caller applies the returned
   * assignments to its own draft state.
   */
  app.post('/api/admin/client/:client/smart-assign', async (req, reply) => {
    const body = (req.body || {}) as {
      deciderModel?: string;
      targets?: { key: string; label?: string; role?: string; current?: string }[];
      candidates?: (string | { id: string; note?: string })[];
    };
    const decider = (body.deciderModel || '').trim();
    const targets = Array.isArray(body.targets) ? body.targets.filter((t) => t && t.key) : [];
    // Candidates are plain ids or { id, note } — the note (e.g. the model a
    // profile slot resolves to) contextualizes the choice but only `id` is a
    // legal assignment value.
    const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
    const candidates = rawCandidates
      .map((c: any) => (typeof c === 'string' ? { id: c } : { id: String(c?.id || ''), note: typeof c?.note === 'string' ? c.note : undefined }))
      .filter((c: { id: string }) => c.id);
    if (!decider) return reply.status(400).send({ success: false, message: 'deciderModel is required' });
    if (targets.length === 0) return reply.status(400).send({ success: false, message: 'targets must not be empty' });
    if (candidates.length === 0) return reply.status(400).send({ success: false, message: 'candidates must not be empty' });

    // Resolve the pick to a PHYSICAL model through the SAME cascade the
    // /v1/systemone surface applies (see resolveDecider): physical id / combo
    // leader / tier-alias pool head / `auto` → systemone.defaultModel.
    const model = resolveDecider(decider);
    if (!model) {
      return reply.status(400).send({
        success: false,
        message: `Decider '${decider}' does not resolve to a routable model (unknown id, empty tier pool, or unset systemone.defaultModel)`,
      });
    }

    const state: Record<string, unknown> = {
      // Tier PURPOSE (what each rung is for), never a ranking: a ladder reads
      // as "ultra is the most/broadest" and then every role lands on it.
      tierPurpose: TIER_PURPOSE,
      task: 'Assign each role/slot the MOST suitable candidate id. Every candidate is described with its objective profile (tier membership, price per 1M tokens, reasoning support, wire); use that — never guess from the model name alone.',
      roles: targets.map((t) => ({
        key: t.key,
        name: t.label || t.key,
        // `purpose` = the client's OWN role description when it declares one
        // (opencode agent frontmatter / pi agent file / live service roster).
        // Absent means unknown — never synthesized server-side: role sets are
        // discovered per client and change with the installed package.
        ...(t.role ? { purpose: t.role } : {}),
        ...(t.current ? { current: t.current } : {}),
      })),
    };
    const rubric = 'Pick exactly one candidate id per question. Match the role\'s WORK to the tier whose PURPOSE describes it (see tierPurpose), then weigh that candidate\'s described profile (capability needs, cost, latency). Do not default every role to one "best" model — the four tiers exist to separate that work. A candidate marked unable to serve chat is never a valid answer.';
    const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {};
    for (const t of targets) {
      questions[t.key] = {
        type: 'choice',
        instructions: rubric,
        criteria: Object.fromEntries(candidates.map((c) => [c.id, describeCandidate(c.id, c.note)])),
      };
    }

    const params = req.params as { client: string };
    let response;
    let upstreamKind: string = 'unknown';
    // Hard deadline: a dead/slow upstream must not hang the console request
    // forever (the native limb has no built-in timeout; the converted limb
    // honors the signal for its repair retry).
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), SMART_ASSIGN_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const decision = await runSystemoneDecision(registry, { model: model.id, state, questions }, model, { signal: abort.signal });
      response = decision.response;
      upstreamKind = decision.upstreamKind;
    } catch (err: any) {
      const msg = abort.signal.aborted
        ? `Decider call timed out after ${SMART_ASSIGN_TIMEOUT_MS / 1000}s`
        : `Decider call failed: ${err?.message || err}`;
      req.log.warn({ client: params.client, decider, ms: Date.now() - startedAt, targets: targets.length, candidates: candidates.length, err: err?.message || String(err), aborted: abort.signal.aborted }, 'smart-assign: decider call failed');
      return reply.status(502).send({ success: false, message: msg });
    } finally {
      clearTimeout(deadline);
    }
    // Diagnosability: "the decider picked badly" is unactionable without the
    // INPUT it saw and the CHOICES it made. `state` is small (roles + task);
    // `criteriaSample` shows one rendered candidate description verbatim and
    // `criteriaChars` the total prompt weight; `answers` collapses each answer
    // to its chosen id, so a diff against expectations is one line per role.
    // The full questions document stays out of the log.
    req.log.info({
      client: params.client,
      decider,
      resolved: model.id,
      resolvedWire: model.wire,
      upstreamKind,
      ms: Date.now() - startedAt,
      targets: targets.length,
      candidates: candidates.length,
      criteriaChars: JSON.stringify(questions).length,
      criteriaSample: candidates[0] ? describeCandidate(candidates[0].id, candidates[0].note) : '',
      state,
      answers: Object.fromEntries(
        Object.entries((response?.answers || {}) as Record<string, { choice?: unknown }>).map(([k, v]) => [k, v?.choice])
      ),
      usage: response?.usage,
    }, 'smart-assign: decider answered');

    const allowed = new Set(candidates.map((c) => c.id));
    const assignments: Record<string, string> = {};
    const invalid: string[] = [];
    for (const t of targets) {
      const v = (response?.answers?.[t.key] as { choice?: unknown } | undefined)?.choice;
      if (typeof v === 'string' && allowed.has(v.trim())) assignments[t.key] = v.trim();
      else invalid.push(t.key);
    }
    if (invalid.length > 0) {
      return reply.status(502).send({
        success: false,
        message: `Decider returned invalid/missing assignments for: ${invalid.join(', ')}`,
      });
    }
    return { status: 'ok', resolved: model.id, assignments };
  });

  /**
   * Resolve a decider name WITHOUT spending anything: the console shows
   * "→ <physical model>" next to the pick, so `lite` (a pool projection) and
   * `auto` (the System One default) are never blind choices about who answers.
   * Same resolver as the smart-assign call itself — one implementation.
   */
  app.get('/api/admin/decider/resolve', async (req, reply) => {
    const raw = String((req.query as { model?: string })?.model || '').trim();
    if (!raw) return reply.status(400).send({ success: false, message: 'model is required' });
    const model = resolveDecider(raw);
    if (!model) {
      return reply
        .status(404)
        .send({ success: false, message: `Decider '${raw}' does not resolve to a routable model` });
    }
    return { success: true, model: raw, resolved: model.id };
  });

  // 4a. OpenCode agent inventory (model-profile binding UI): live v2 service
  //     roster (`GET /api/agent`, plugins included) with the file scan
  //     (built-ins + agent(s)/*.md + config nodes) as offline fallback.
  app.get('/api/admin/opencode/agents', async () => ({ status: 'ok', agents: await listOpenCodeAgentsLive() }));

  // 4b. Console webAuth — login/logout/session probes + credential management.
  // login/logout/session stay reachable pre-login (server.ts gate whitelist);
  // the two config endpoints ride the normal console gate (session cookie).
  app.get('/api/admin/auth/session', async (req) => {
    const disk = getRuntimeConfigRef() || loadConfig(); // runtime snapshot (see gate comment)
    const active = isWebAuthActive(disk);
    const cookieToken = parseSessionCookie(req.headers.cookie);
    return {
      status: 'ok',
      webAuth: {
        active,
        forced: !isLoopbackHost(disk.host),
        enabled: disk.webAuth?.enabled === true,
      },
      authenticated: !active || verifySessionToken(cookieToken),
    };
  });

  app.post('/api/admin/auth/login', async (req, reply) => {
    const disk = getRuntimeConfigRef() || loadConfig(); // runtime snapshot (see gate comment)
    if (!isWebAuthActive(disk)) {
      return reply.status(400).send({ success: false, message: 'webAuth is not active on this gateway' });
    }
    const ip = req.ip || 'unknown';
    const allow = checkLoginAllowed(ip);
    if (!allow.allowed) {
      reply.header('retry-after', String(allow.retryAfterSec ?? 60));
      return reply.status(429).send({
        success: false,
        message: `Too many failed login attempts. Retry in ${allow.retryAfterSec}s.`,
      });
    }
    const body = req.body as { username?: string; password?: string };
    const ok =
      hasWebAuthCredentials(disk.webAuth) &&
      (body?.username?.trim() || '') === (disk.webAuth!.username || '').trim() &&
      verifyPassword(body?.password || '', disk.webAuth!.passwordHash);
    if (!ok) {
      recordLoginFailure(ip);
      return reply.status(401).send({ success: false, message: 'Invalid username or password' });
    }
    recordLoginSuccess(ip);
    reply.header('set-cookie', sessionSetCookie(createSessionToken()));
    return { status: 'ok' };
  });

  app.post('/api/admin/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', sessionClearCookie());
    return { status: 'ok' };
  });

  app.get('/api/admin/auth/config', async () => {
    const disk = getRuntimeConfigRef() || loadConfig(); // runtime snapshot (see gate comment)
    return {
      status: 'ok',
      webAuth: {
        active: isWebAuthActive(disk),
        forced: !isLoopbackHost(disk.host),
        enabled: disk.webAuth?.enabled === true,
        username: disk.webAuth?.username || '',
        hasPassword: Boolean(disk.webAuth?.passwordHash),
        host: disk.host,
      },
    };
  });

  app.post('/api/admin/auth/config', async (req, reply) => {
    const body = req.body as { enabled?: boolean; username?: string; password?: string };
    const disk = getRuntimeConfigRef() || loadConfig(); // runtime snapshot (see gate comment)
    const wa = disk.webAuth || {};
    const nextEnabled = body?.enabled ?? wa.enabled === true;
    const username = body?.username !== undefined ? body.username.trim() : wa.username || '';
    if (body?.password !== undefined && body.password !== '' && body.password.length < 6) {
      return reply.status(400).send({ success: false, message: 'Password must be at least 6 characters' });
    }
    const passwordHash =
      body?.password !== undefined && body.password !== '' ? hashPassword(body.password) : wa.passwordHash;

    if (nextEnabled && (!username || !passwordHash)) {
      return reply.status(400).send({
        success: false,
        message: 'Enabling webAuth requires a username and a password (submit both, or keep the existing password).',
      });
    }
    if (!nextEnabled && !isLoopbackHost(disk.host)) {
      return reply.status(409).send({
        success: false,
        message: `webAuth cannot be disabled while the gateway binds non-loopback host '${disk.host}' — console login is mandatory.`,
      });
    }
    const result = saveConfig({
      webAuth: {
        enabled: nextEnabled || undefined,
        username: username || undefined,
        passwordHash: passwordHash || undefined,
      },
    });
    if (!result.success) return reply.status(400).send(result);
    return {
      status: 'ok',
      webAuth: { active: nextEnabled || !isLoopbackHost(disk.host), forced: !isLoopbackHost(disk.host), enabled: nextEnabled },
    };
  });

  // 5. Configuration Read & Write API
  // webAuth passwordHash is stripped from the payload — the UI never needs
  // it, and round-tripping it through the visual editor would invite erasure.
  app.get('/api/admin/config', async () => {
    const cfg = loadConfig();
    if (cfg.webAuth) {
      const { passwordHash: _ph, ...webAuthSafe } = cfg.webAuth;
      cfg.webAuth = webAuthSafe;
    }
    return { status: 'ok', config: cfg };
  });

  const handleSaveConfig = async (req: any, reply: any) => {
    const body = req.body as Partial<RouterConfig>;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ success: false, message: 'Invalid config payload' });
    }
    const result = saveConfig(body);
    if (!result.success) return reply.status(400).send(result);
    // Hot-applied config sections: proxy policy (module singleton per call),
    // the capture recorder (enabled/toggles take effect immediately, no
    // gateway restart needed), custom model combos (registry re-reads the
    // combo map per request), tier member lists, and the breaker rules
    // (manager applyConfig: ruleset swap + invariant-2 reconciliation, spec
    // invariant 6). Within circuitBreaker only persistence.debounceMs still
    // needs a restart — the state store binds its debounce at boot.
    initProxyConfig(loadConfig().proxy);
    orchestrator.getCaptureRecorder().applyConfig(loadConfig().requestCapture);
    applyDecisionCaptureConfig(loadConfig().classifier?.layer2); // L2 dataset sampling: single-key gate classifier.layer2.collectEnabled, hot too
    applyRouteEntriesConfig(loadConfig().routeEntries); // experience-table gate: hot-applies lookup/writes
    applyDirectivesConfig(loadConfig().directives); // directive gate: hot-applies the reserved namespace + kill switch
    orchestrator.getRegistry().applyCombos(loadConfig().combos);
    orchestrator.getRegistry().applyTierConfigNow(); // tier member lists commit immediately (no restart)
    try {
      await refreshDirectPool(orchestrator.getRegistry()); // provider-def sync: models/wires/chains match the defs file (no restart)
    } catch (err) {
      // Fail-open, but never silent: the registry keeps serving and may drift.
      console.warn(`[console] pool resync after config save failed (registry may drift): ${(err as Error).message}`);
    }
    warnOnEmptyTierPools(); // no residual tier → an empty pool is now possible
    orchestrator
      .getRegistry()
      .getCircuitBreakerManager()
      .applyConfig(loadConfig().circuitBreaker, loadConfig().retry); // breaker rules hot-apply (next-decision-point semantics)
    // Profile-link write-through: an edited profile re-resolves into every
    // hooked client linked to it (diff-guarded — no-op when unchanged).
    const profileNote = await refreshClientProfileBindings(loadConfig().modelProfiles || []);
    if (profileNote) return { ...result, message: `Saved. ${profileNote.trim().replace(/^; /, '')}` };
    return result;
  };
  app.post('/api/admin/config', handleSaveConfig);

  // 6. Raw YAML Configuration
  app.get('/api/admin/config/raw', async () => ({ status: 'ok', yaml: getRawConfig(), path: getConfigPath() }));

  const handleSaveRawYaml = async (req: any, reply: any) => {
    const body = req.body as { yaml?: string };
    if (!body?.yaml || typeof body.yaml !== 'string') {
      return reply.status(400).send({ success: false, message: 'YAML content is required' });
    }
    const result = saveRawConfig(body.yaml);
    if (!result.success) return reply.status(400).send(result);
    initProxyConfig(loadConfig().proxy); // hot-apply proxy policy (see handleSaveConfig)
    orchestrator.getCaptureRecorder().applyConfig(loadConfig().requestCapture); // hot-apply capture too
    applyDecisionCaptureConfig(loadConfig().classifier?.layer2); // hot-apply the L2 dataset-sampling gate too (classifier.layer2.collectEnabled)
    applyRouteEntriesConfig(loadConfig().routeEntries); // hot-apply the experience-table gate too
    applyDirectivesConfig(loadConfig().directives); // hot-apply the directive namespace too
    orchestrator.getRegistry().applyCombos(loadConfig().combos); // hot-apply combos too
    orchestrator.getRegistry().applyTierConfigNow(); // hot-commit tier member lists too
    warnOnEmptyTierPools(); // no residual tier → an empty pool is now possible
    orchestrator
      .getRegistry()
      .getCircuitBreakerManager()
      .applyConfig(loadConfig().circuitBreaker, loadConfig().retry); // hot-apply breaker rules too (see handleSaveConfig)
    // Profile-link write-through on the raw path too (same diff guard).
    try {
      await refreshDirectPool(orchestrator.getRegistry()); // provider-def sync on the raw path too (no restart)
    } catch (err) {
      // Fail-open, but never silent: the registry keeps serving and may drift.
      console.warn(`[console] pool resync after config save failed (registry may drift): ${(err as Error).message}`);
    }
    const profileNote = await refreshClientProfileBindings(loadConfig().modelProfiles || []);
    if (profileNote) return { ...result, message: `Saved. ${profileNote.trim().replace(/^; /, '')}` };
    return result;
  };
  app.post('/api/admin/config/raw', handleSaveRawYaml);

  // 6b. Dynamic comment panel data — config.yaml is ZERO-COMMENT on disk
  // (ADR-0016); the Config File page renders per-field comments from these
  // dictionaries in the operator's language. Runtime-path keyed; the panel
  // walks the flat runtime shape the same way loadConfig expands it.
  app.get('/api/admin/config/comments', async (req) => {
    const query = req.query as Record<string, unknown>;
    const lang = commentLangFromQuery(query.lang);
    const zh = lang === 'zh-CN';
    return {
      status: 'ok',
      lang,
      header: zh ? YAML_FILE_HEADER_ZH : YAML_FILE_HEADER_EN,
      fields: zh ? YAML_FIELD_COMMENTS_ZH : YAML_FIELD_COMMENTS_EN,
    };
  });

  // 6a. Forward-proxy MITM CA export — clients using the inbound forward
  // proxy must trust this CA. Generated on first request when absent (the
  // same idempotent ensureCa the proxy itself uses).
  const handleForwardProxyCa = async (_req: any, reply: any) => {
    const cfg = loadConfig();
    const caDir = resolveCaDir(cfg.forwardProxy?.caDir);
    try {
      const ca = ensureCa(caDir);
      reply.header('content-type', 'application/x-pem-file');
      reply.header('content-disposition', 'attachment; filename="ocr-forward-proxy-ca.pem"');
      return reply.send(ca.caCertPem);
    } catch (err: any) {
      return reply.status(500).send({ status: 'error', message: err?.message || 'Failed to load CA' });
    }
  };
  app.get('/api/admin/proxy/ca', handleForwardProxyCa);

  // 6a-bis. CA identity for the console card: absolute path, SHA-256
  // fingerprint and validity. Never key material — clients use it to check
  // that the root they installed is the root this proxy signs with.
  app.get('/api/admin/proxy/ca/meta', async (_req, reply) => {
    const cfg = loadConfig();
    try {
      return { status: 'ok', ...describeCa(cfg.forwardProxy?.caDir) };
    } catch (err: any) {
      return reply.status(500).send({ status: 'error', message: err?.message || 'Failed to load CA' });
    }
  });
  // 6a-ter. Trust state for the console card: does the platform store that
  // clients verify against hold THIS CA? Tri-state on purpose — `unknown` means
  // the probe could not run, never "not trusted". Cached 60s (the probe spawns
  // platform tools); `force=1` bypasses the TTL for an operator re-check after
  // an install.
  app.get('/api/admin/proxy/ca/trust', async (req) => {
    const cfg = loadConfig();
    const caPath = caCertPath(cfg.forwardProxy?.caDir);
    const force = String((req.query as Record<string, unknown> | undefined)?.force ?? '') === '1';
    // Fail SOFT: the console renders a tri-state chip, so a probe that cannot
    // run is `unknown`, never a 500 that makes the chip silently disappear.
    // `checkedAt` stays absent while no probe ran (no PEM to identify).
    if (!fs.existsSync(caPath)) return { status: 'ok', trusted: 'unknown' as const, caPath };
    try {
      return { status: 'ok', ...(await probeCaTrustedCached(caPath, { force })), caPath };
    } catch {
      return { status: 'ok', trusted: 'unknown' as const, caPath };
    }
  });

  // 6b. Tier member lists — candidate pool snapshots (console preview).
  // membership is a PURE projection of (model id × tiers.members);
  // PREVIEW never mutates live pools — real membership is committed ONLY by
  // the save events below (applyTierConfigNow), so editing takes effect
  // without a restart.
  const projectTierPools = async (policies: any) => {
    const pools: Record<string, unknown> = {};
    const shape = (pool: { model: any; weight: number }[]) =>
      pool.map(({ model, weight }) => ({
        id: model.id,
        provider: model.provider,
        upstreamModel: model.upstreamModel,
        priority: model.priority,
        isDefaultInTier: Boolean(model.isDefaultInTier),
        inputPrice: model.pricing?.input,
        outputPrice: model.pricing?.output,
        // Decision 6 aggregate: healthy iff at least one credential tuple serves —
        // a model whose every credential is cooling shows down here exactly as it
        // does to the pool builders.
        healthy: registry.modelAvailable(model).available,
        weight,
      }));
    for (const tier of MEMBER_TIER_ORDER) {
      const { pool, excluded } = registry.resolveTierPool(tier, policies);
      pools[tier] = { pool: shape(pool), excluded };
    }
    return pools;
  };

  // membership is explicit — an empty pool means the member list is
  // empty or matches no registered model. Degradation is allowed but never
  // silent — warn on every commit.
  const warnOnEmptyTierPools = () => {
    const tiers = loadConfig().tiers;
    const resolved = registry.expandedMemberRules(tiers);
    for (const tier of MEMBER_TIER_ORDER) {
      const { pool } = registry.resolveTierPool(tier, tiers);
      if (pool.length === 0) {
        const deadRef = resolved.dead.some((d) => d.tier === tier);
        const cause = deadRef
          ? 'its combo reference(s) contribute no members'
          : resolved.tiers[tier].length === 0
            ? 'the member list is empty'
            : 'no rule matches a registered model';
        console.warn(
          `[Console] Tier '${tier}' has an EMPTY candidate pool (${cause}) — its requests will degrade to another tier. ` +
            `Add models to tiers.${tier}.members on the /tiers page.`,
        );
      }
    }
  };

  const handleTierPools = async () => {
    // Snapshot of the SAVED file state (what a restart would load anyway, and
    // what the save-commit has already applied).
    const freshTiers = loadConfig().tiers;
    return {
      status: 'ok',
      pools: await projectTierPools(freshTiers),
      members: registry.expandedMemberRules(freshTiers).tiers,
    };
  };
  app.get('/api/admin/tier-pools', handleTierPools);

  // 6b'. Live (committed) tier pool snapshot — reflects the registry's
  // current m.tier (the last applyTierConfigNow result) plus the global
  // tiers.exclude filter. No preview; what the runtime would actually use.
  //
  // Read-only on purpose: the previous version called applyTierConfigNow()
  // here as a "force-commit view" trick, but that mutated m.tier / m.unclassified
  // on every Live tab open — a stealth commit with no save event behind it.
  // The console must NEVER write routing state from a GET. Out-of-band file
  // edits get picked up on the next save commit (the console already triggers
  // applyTierConfigNow in handleSaveConfig / handleSaveRawYaml).
  const handleTierPoolsLive = async () => {
    const policies = registry.getTierPolicies();
    const pools: Record<string, unknown> = {};
    for (const tier of MEMBER_TIER_ORDER) {
      const { pool, excluded } = registry.resolveTierPool(tier, policies);
      pools[tier] = {
        pool: pool.map(({ model, weight }) => ({
          id: model.id,
          provider: model.provider,
          upstreamModel: model.upstreamModel,
          priority: model.priority,
          isDefaultInTier: Boolean(model.isDefaultInTier),
          inputPrice: model.pricing?.input,
          outputPrice: model.pricing?.output,
          // Decision 6 aggregate: healthy iff at least one credential tuple serves —
          // a model whose every credential is cooling shows down here exactly as it
          // does to the pool builders.
          healthy: registry.modelAvailable(model).available,
          weight,
        })),
        excluded,
      };
    }
    return { status: 'ok', live: true, pools };
  };
  app.get('/api/admin/tier-pools/live', handleTierPoolsLive);

  // 6b'. Ephemeral preview from UNSAVED form state — { tiers } in the body;
  // the console shows what the pools WOULD be, without touching routing.
  const handleTierPoolsPreview = async (req: any) => {
    const body = req.body as { tiers?: unknown };
    const tiers = body?.tiers ?? loadConfig().tiers ?? {};
    return {
      status: 'ok',
      preview: true,
      pools: await projectTierPools(tiers),
      members: registry.expandedMemberRules(tiers as any).tiers,
    };
  };
  app.post('/api/admin/tier-pools/preview', handleTierPoolsPreview);

  // Check: dry-run validation of a DRAFT tiers config — non-blocking warnings:
  //   orphan    — a rule matching no registered model (rename / typo / removed)
  //   deadCombo — a combo:<id> ref contributing nothing (unknown / disabled /
  //               shadowed / zero registered members)
  // Cross-tier overlap is NOT warned: membership is a per-tier projection, a
  // model (or combo ref) joining several tiers is legal by contract.
  const handleTiersCheck = async (req: any) => {
    const body = req.body as { tiers?: unknown };
    const tiers = (body?.tiers ?? loadConfig().tiers ?? {}) as any;
    const expanded = registry.expandedMemberRules(tiers);
    const members = expanded.tiers;
    const modelIds = registry
      .getAllModels()
      .filter((m) => m.tierMatch)
      .map((m) => m.id);
    const orphans: { tier: string; pattern: string }[] = [];
    for (const tier of MEMBER_TIER_ORDER) {
      for (const rule of members[tier]) {
        // exact rules = combo-expanded ids: registered by construction, and a
        // hand-configured member (no tierMatch) is not in modelIds — flagging
        // them here would be a false positive; ref liveness is deadCombo's job
        if (rule.exact) continue;
        if (!modelIds.some((id) => globMatchAny([rule.pattern], id))) orphans.push({ tier, pattern: rule.pattern });
      }
    }
    return {
      status: 'ok',
      warnings: [
        ...orphans.map((o) => ({ kind: 'orphan' as const, tier: o.tier, pattern: o.pattern })),
        ...expanded.dead.map((d) => ({ kind: 'deadCombo' as const, tier: d.tier, pattern: d.ref })),
      ],
    };
  };
  app.post('/api/admin/tiers/check', handleTiersCheck);

  // End-to-end tier test — one REAL minimal completion pinned to the tier via
  // the bare tier alias: the same force_tier path a client's
  // `model: "pro"` request takes (tier aliases are reserved gateway ids,
  // never classifier-routed). One run only
  // exercises the SELECTED member (the default credential, or the weighted/round-robin
  // pick), never the whole pool — deep per-model checks stay on the providers
  // page. An EMPTY tier degrades inside getModelForTier (the session-pin birth
  // representative falls down the escalate→plus→lite chain, server-warned with
  // reason=empty-pool) — modelUsed then names the NON-tier landing model, the
  // same drift a real client request experiences. ok:false is a real test
  // outcome (chain exhausted / every member rejected); an unknown tier name is
  // a precondition (400) that never spends an upstream call.
  app.post('/api/admin/tiers/:tier/test', async (req: any, reply: any) => {
    const { tier } = req.params as { tier: string };
    if (!(MEMBER_TIER_ORDER as readonly string[]).includes(tier)) {
      return reply.status(400).send({ success: false, reasonCode: 'unknown_tier', tier });
    }
    try {
      const result = await orchestrator.process(
        {
          model: tier,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
        { wire: 'chat', clientIp: req.ip, headers: req.headers, fastifyRequest: req }
      );
      return {
        status: 'ok',
        ok: true,
        tier,
        modelUsed: result.modelUsed,
        latencyMs: result.latencyMs,
        failoverOccurred: result.failoverOccurred === true,
        ...(result.failoverPath?.length ? { failoverPath: result.failoverPath } : {}),
        ...(result.servedCredentialPrefix ? { servedCredentialPrefix: result.servedCredentialPrefix } : {}),
      };
    } catch (err: unknown) {
      // Same status mapping as the combo test route (identical execution-error
      // policy): explicit 4xx/5xx pass through, anything else collapses to 500.
      const e = err as { statusCode?: unknown; message?: string } | null | undefined;
      const statusCode = e?.statusCode;
      const status =
        typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
          ? statusCode
          : 500;
      return reply.status(200).send({
        status: 'ok',
        ok: false,
        tier,
        httpStatus: status,
        error: e?.message || 'Tier test failed',
      });
    }
  });

  // 6b-2. Catalog source management — view/add/remove/toggle/refresh the remote
  // catalog sources (config.catalog.sources). Mutations apply to the live
  // CatalogRepository immediately (no gateway restart) and are persisted to
  // config.yaml so they survive restarts. The 'opencode' baseline source is
  // mandatory: the repository rejects its removal/disabling with 403.
  const persistCatalogSources = async () => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    const current = loadConfig().catalog ?? {};
    saveConfig({
      catalog: {
        ...current,
        sources: catalogRepository.configuredSources().map((d) => ({
          id: d.id,
          type: d.type,
          url: d.url,
          enabled: d.enabled,
          priority: d.priority,
          // 'custom' sources are invalid without their field mapping — persist
          // it too, otherwise the first save silently wipes it from config.yaml
          ...(d.map ? { map: d.map } : {}),
        })),
      },
    });
  };

  const listCatalogSources = async () => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    return {
      status: 'ok',
      syncIntervalMs: catalogRepository.syncInterval,
      sources: catalogRepository.sourceStates(),
    };
  };

  // Hot-apply the auto-sync period (no restart) and persist to config.yaml.
  const handleSetCatalogSyncInterval = async (req: any, reply: any) => {
    const body = req.body ?? {};
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      catalogRepository.setSyncInterval(Number(body.intervalMs));
      const current = loadConfig().catalog ?? {};
      const result = saveConfig({ catalog: { ...current, syncIntervalMs: catalogRepository.syncInterval } });
      if (!result.success) return reply.status(400).send(result);
      return { status: 'ok', syncIntervalMs: catalogRepository.syncInterval };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  const handleAddCatalogSource = async (req: any, reply: any) => {
    const body = req.body ?? {};
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      const source = await catalogRepository.addSource({
        id: String(body.id ?? ''),
        type: String(body.type ?? ''),
        url: String(body.url ?? ''),
        priority: typeof body.priority === 'number' ? body.priority : undefined,
        enabled: body.enabled,
        map: body.map && typeof body.map === 'object' ? body.map : undefined,
      });
      await persistCatalogSources();
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', source };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message ?? 'failed to add source' });
    }
  };

  const handleToggleCatalogSource = async (req: any, reply: any) => {
    const body = req.body ?? {};
    if (typeof body.enabled !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'body.enabled (boolean) is required' });
    }
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      const source = await catalogRepository.setSourceEnabled(req.params.id, body.enabled);
      await persistCatalogSources();
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', source };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  const handleRemoveCatalogSource = async (req: any, reply: any) => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      catalogRepository.removeSource(req.params.id);
      await persistCatalogSources();
      await catalogRepository.ensureOcrStore();
      return { status: 'ok' };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  const handleRefreshCatalogSource = async (req: any, reply: any) => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      const source = await catalogRepository.refreshSource(req.params.id);
      // Rebuild + persist the OCR store immediately so catalog/ocr.json reflects
      // the refresh the moment this call returns.
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', source };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  const handleRefreshCatalogSources = async () => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    await catalogRepository.refreshAll();
    await catalogRepository.ensureOcrStore();
    return { status: 'ok', sources: catalogRepository.sourceStates() };
  };

  const getCatalogSourceData = async (req: any, reply: any) => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      const data = catalogRepository.sourceData(req.params.id);
      return { status: 'ok', ...data };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  // Toggle one model id in catalog.lockedModels (locally anchored: remote sources
  // never overwrite its maintained values, explicit zeros included). Hot-effective:
  // the repository reads config.yaml live on every aggregation.
  const handleLockCatalogModel = async (req: any, reply: any) => {
    const body = req.body as { id?: string; locked?: boolean };
    if (!body?.id || typeof body.locked !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'body.id (string) and body.locked (boolean) are required' });
    }
    const current = loadConfig().catalog ?? {};
    const set = new Set(current.lockedModels ?? []);
    if (body.locked) set.add(String(body.id));
    else set.delete(String(body.id));
    const lockedModels = [...set].sort();
    const result = saveConfig({ catalog: { ...current, lockedModels } });
    if (!result.success) return reply.status(400).send(result);
    return { status: 'ok', lockedModels };
  };

  const listLockedCatalogModels = async () => ({
    status: 'ok',
    lockedModels: loadConfig().catalog?.lockedModels ?? [],
  });

  // The FULL OCR catalog view (catalogRepository.list()): defs-file
  // definitions + credentials first, then provider-catalog sources (builtin
  // baseline) and model-list enrichments, service baseURL hints — the exact
  // aggregation the /providers and /models pages are built on.
  const getCatalogOcr = async () => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    const providers = await catalogRepository.list();
    return { status: 'ok', providers };
  };

  // Aggregate-level model overrides (OCR Catalog viewer edits) — a separate
  // editing plane from defs-file definitions. Applied LAST on the
  // aggregation so edited values always win over sourced values.
  const handleGetCatalogOverride = async (req: any) => {
    const { getOverride } = await import('../opencode/catalog/overrides-store.js');
    const q = req.query as { providerId?: string; modelId?: string };
    if (!q.providerId || !q.modelId) return { status: 'ok', entry: null };
    return { status: 'ok', entry: getOverride(q.providerId, q.modelId) ?? null };
  };

  const handlePutCatalogOverride = async (req: any, reply: any) => {
    const body = req.body as { providerId?: string; modelId?: string; entry?: any };
    if (!body?.providerId || !body?.modelId || typeof body.entry !== 'object') {
      return reply.status(400).send({ success: false, error: 'providerId, modelId and entry are required' });
    }
    const { upsertOverride } = await import('../opencode/catalog/overrides-store.js');
    const result = upsertOverride(String(body.providerId), String(body.modelId), body.entry);
    if (!result.success) return reply.status(400).send(result);
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    await catalogRepository.ensureOcrStore();
    return { status: 'ok' };
  };

  const handleDeleteCatalogOverride = async (req: any, reply: any) => {
    const q = req.query as { providerId?: string; modelId?: string };
    if (!q.providerId || !q.modelId) {
      return reply.status(400).send({ success: false, error: 'providerId and modelId are required' });
    }
    const { removeOverride } = await import('../opencode/catalog/overrides-store.js');
    const result = removeOverride(q.providerId, q.modelId);
    if (!result.success) return reply.status(400).send(result);
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    await catalogRepository.ensureOcrStore();
    return { status: 'ok' };
  };

  for (const prefix of ['/api/admin']) {
    app.get(`${prefix}/catalog/sources`, listCatalogSources);
    // Source mutations change the catalog universe the pool builder consumes —
    // resync the pool so pricing/modality/tier inputs cannot drift.
    app.post(`${prefix}/catalog/sources`, withPoolSync(registry, handleAddCatalogSource));
    app.post(`${prefix}/catalog/sources/refresh`, withPoolSync(registry, handleRefreshCatalogSources));
    app.post(`${prefix}/catalog/sources/:id/refresh`, withPoolSync(registry, handleRefreshCatalogSource));
    app.put(`${prefix}/catalog/sources/:id`, withPoolSync(registry, handleToggleCatalogSource));
    app.delete(`${prefix}/catalog/sources/:id`, withPoolSync(registry, handleRemoveCatalogSource));
    app.get(`${prefix}/catalog/sources/:id/data`, getCatalogSourceData);
    app.get(`${prefix}/catalog/locked-models`, listLockedCatalogModels);
    app.post(`${prefix}/catalog/locked-models`, withPoolSync(registry, handleLockCatalogModel));
    app.get(`${prefix}/catalog/ocr`, getCatalogOcr);
    app.get(`${prefix}/catalog/override`, handleGetCatalogOverride);
    app.put(`${prefix}/catalog/override`, withPoolSync(registry, handlePutCatalogOverride));
    app.delete(`${prefix}/catalog/override`, withPoolSync(registry, handleDeleteCatalogOverride));
    app.post(`${prefix}/catalog/sync-interval`, handleSetCatalogSyncInterval);
  }

  // 6c. Custom model combos — resolved member view for the /combos console
  // page. Reads the FRESH config (loadConfig) so a just-saved combo shows up
  // without a restart; member health/breaker state comes from the live
  // registry, and unregistered member ids are flagged via registered:false.
  const handleCombos = async () => {
    const cb = registry.getCircuitBreakerManager();
    const combos = (loadConfig().combos || []).map(c => ({
      id: c.id,
      note: c.note,
      // active=false ⇒ the gateway ignored this combo (reserved/colliding id
      // or model-shadowed) — the UI badges it instead of diverging silently.
      // A model registered AFTER the combo shadows the id but keeps isCombo
      // true — cross-check the model map (same rule as getCombos exposure).
      active: registry.isCombo(c.id) && !registry.getModel(c.id),
      // Operator takedown flag (hidden from catalogs, calls rejected).
      disabled: c.disabled === true,
      selection: c.selection || 'priority',
      members: (c.models || []).map((entry: any) => {
        const ref =
          typeof entry === 'string' ? { id: entry, weight: 1 } : { id: entry.id, weight: entry.weight ?? 1 };
        const model = registry.getModel(ref.id);
        return {
          id: ref.id,
          weight: ref.weight,
          registered: Boolean(model),
          provider: model?.provider,
          tier: model?.tier,
          inputPrice: model?.pricing?.input,
          outputPrice: model?.pricing?.output,
          breakerState: model ? cb.getSnapshot(model.id)?.state ?? 'CLOSED' : undefined,
        };
      }),
    }));
    return { status: 'ok', combos };
  };
  app.get('/api/admin/combos', handleCombos);

  // 6d. Combo end-to-end test — ONE real completion through the production
  // pipeline: the orchestrator's combo branch owns leader picking (breaker-
  // aware selection strategy), config-order failover and the chain-length
  // attempt cap, so this exercises exactly what inference traffic hits.
  // It is a REAL upstream call: it burns quota and lands in logs/capture.
  // Admin dispatch carries no per-key modelAccess policy — a policy-blocked
  // member still tests green here (known limit, never silent: per-key access
  // is exercised by real client traffic only).
  app.post('/api/admin/combos/:id/test', async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    // Inactive combo (reserved/colliding id, model-shadowed, or an id a
    // physical model claimed after registration — the catalog filter hides
    // it) never enters the pipeline as a combo — the full-id lookup would
    // silently serve the physical model instead. Refuse BEFORE spending an
    // upstream call. isCombo alone stays true under late shadowing, so
    // cross-check the model map exactly like getCombos exposure does.
    if (!registry.isCombo(id) || registry.getModel(id)) {
      return reply.status(400).send({ success: false, reasonCode: 'combo_inactive', combo: id });
    }
    try {
      const result = await orchestrator.process(
        {
          model: id,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
        { wire: 'chat', clientIp: req.ip, headers: req.headers, fastifyRequest: req }
      );
      return {
        status: 'ok',
        ok: true,
        combo: id,
        modelUsed: result.modelUsed,
        latencyMs: result.latencyMs,
        failoverOccurred: result.failoverOccurred === true,
        ...(result.failoverPath?.length ? { failoverPath: result.failoverPath } : {}),
        ...(result.servedCredentialPrefix ? { servedCredentialPrefix: result.servedCredentialPrefix } : {}),
      };
    } catch (err: unknown) {
      // Same status mapping as the chat surface's execution-error policy:
      // explicit 4xx/5xx pass through, anything else collapses to 500. The
      // chain-exhausted / zero-registered-member fast-fails arrive here as
      // orchestrator throws — machine limbs + the gateway's own message.
      const e = err as { statusCode?: unknown; message?: string } | null | undefined;
      const statusCode = e?.statusCode;
      const status =
        typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
          ? statusCode
          : 500;
      return reply.status(200).send({
        status: 'ok',
        ok: false,
        combo: id,
        httpStatus: status,
        error: e?.message || 'Combo test failed',
      });
    }
  });

  // 7. Provider Management (defs file `providers` map + bound credential store)
  //     - Definitions live in <ocrHome>/providers.json (provider-defs.ts)
  //     - Credentials live in the boot-bound CredentialStore (auth.json is never written)
  //     - Connectable catalog comes from models.dev (same source as `opencode auth login`)

  /**
   * THE credential-list shape the
   * console renders (GET credential-store + the per-credential write routes),
   * so the frontend never relearns a second variant:
   *   suspect        administrative flag (reconnect or Push lifts it)
   *   openPairs      this credential's pair breakers currently OPEN (any model)
   *   cooldownUntilMs latest OPEN pair breaker's cooldown end (epoch ms, only when openPairs>0)
   *   disabled       operator takedown — outranks every runtime signal, lifted
   *                  ONLY by the matching enable route (never by cooldown,
   *                  reconnect, Push or a breaker reset)
   * Masked CredentialMeta fields ride through untouched (additive keys only).
   */
  const withCredentialHealth = (providerId: string, metas: CredentialMeta[]): CredentialHealth[] => {
    const cb = registry.getCircuitBreakerManager();
    const credentialState = cb.getCredentialStateStore();
    const pairSnaps = cb.snapshotsWithPairs().filter((s) => s.keyHashPrefix !== undefined);
    // Rate-limit overlay (config `credentials:`): the armed rules per prefix, so
    // every credential row carries its caps beside breaker state — KeysPage
    // stays the single credential panel, no second surface learns this join.
    const limitOverlay = (getRuntimeConfigRef() || loadConfig()).credentials?.[providerId] ?? [];
    // Active-first display order, matching the chain order that actually routes
    // (resolveKeyChain: active head, then newest). opencode v2's SQL already
    // yields `ORDER BY active DESC`, but OcrStore returns FILE order — without
    // this the same list top-anchors on v2 and buries the active row on ocr,
    // which the capped drill-down view would then hide. Sort is stable, so the
    // store's own order survives inside each group. Disabled rows sink LAST
    // regardless of the store's active flag — an operator takedown must never
    // read as "the credential in service", and it sorts below every live one.
    const isOff = (meta: CredentialMeta): number =>
      meta.keyHashPrefix && credentialState.isDisabled(providerId, meta.keyHashPrefix) ? 1 : 0;
    const ordered = [...metas].sort((a, b) => isOff(a) - isOff(b) || Number(b.active) - Number(a.active));
    return ordered.map((meta) => {
      const suspect = meta.keyHashPrefix ? credentialState.isSuspect(providerId, meta.keyHashPrefix) : false;
      const disabled = meta.keyHashPrefix ? credentialState.isDisabled(providerId, meta.keyHashPrefix) : false;
      const disabledReason = disabled && meta.keyHashPrefix ? credentialState.getDisabled(providerId, meta.keyHashPrefix)?.reason : undefined;
      const pairs = meta.keyHashPrefix
        ? pairSnaps.filter((s) => s.keyHashPrefix === meta.keyHashPrefix && s.provider === providerId)
        : [];
      const open = pairs.filter((s) => s.state === 'OPEN');
      const limitEntry = meta.keyHashPrefix
        ? limitOverlay.find(
            (e) => (e.keyHashPrefix ?? '').toLowerCase() === meta.keyHashPrefix!.toLowerCase()
          )
        : undefined;
      const quota = quotaViewFor(providerId, meta.keyHashPrefix);
      return {
        ...meta,
        suspect,
        disabled,
        ...(disabledReason ? { disabledReason } : {}),
        ...(limitEntry?.limits?.length ? { limits: limitEntry.limits } : {}),
        ...(quota ? { quota } : {}),
        openPairs: open.length,
        ...(open.length > 0
          ? {
              cooldownUntilMs: Math.max(
                ...open.map((s) => s.cooldownUntil ?? Date.now() + s.remainingCooldownMs)
              ),
            }
          : {}),
      };
    });
  };

  const ocHandlers = {
    /** The npm SDK vocabulary — ONE backend-owned table (providers/vocabulary.ts)
     * served to every UI surface that renders npm choices or display names. */
    npmVocabulary: async () => {
      // Plugin-backed wires (qoder gRPC, workbuddy HTTP) are only OFFERED when
      // the plugin is installed — suggesting the alias without the executor
      // would invite authoring a def that fails on every call.
      const entries = NPM_VOCABULARY.filter((e) => {
        if (e.wire !== 'qoder' && e.wire !== 'workbuddy') return true;
        return !!getModelServicePlugin(e.wire);
      });
      return { status: 'ok', entries };
    },

    list: async (req: FastifyRequest) => {
      const { getProviderNodeById } = await import('../opencode/user-config.js');
      const { getProviderDefsPath } = await import('../opencode/provider-defs.js');
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const takedowns = getProviderTakedownStore();
      const store = await getCredentialStore();
      // B4: credentials come from the BOUND store on every binding — the masked store
      // credentials merge into the config views, so a stale auth.json entry can never
      // masquerade as a connected provider.
      const lang = typeof (req.query as any)?.lang === 'string' ? (req.query as any).lang : undefined;
      const views = await storeProviderViews(store, lang);
      const unified = await catalogRepository.list();
      const byId = new Map(unified.map((p) => [p.id, p]));
      // Plugin-origin provenance for the Connected-tab origin filter — same
      // ledger join as the catalog endpoint (ADR-0010: never written to providers.json).
      const origins = pluginProviderOrigins();
      return {
        status: 'ok',
        configPath: getProviderDefsPath(),
        catalogSync: catalogRepository.lastSyncOrigin,
        providers: views.map((v) => {
          const u = byId.get(v.id);
          const defNode = getProviderNodeById(v.id);
          const hasDefNode = defNode !== undefined;
          const takedown = takedowns.get(v.id);
          return {
            ...v,
            // Precise delete-branch signal: an explicit defs-file node is the
            // ONLY case where DELETE removes a definition — a row with no node
            // (never connected, or a retired-shape node the normalized view drops)
            // purges credentials alone. The `custom` flag is broader (catalog
            // coverage counts) and must not drive the delete confirm wording.
            defNode: hasDefNode,
            // NO `modelsManageable` flag: with ONE landing spot (the provider's own
            // node), editability IS presence — a row that exists owns a node, so the
            // constant-true capability field was removed from the wire.
            // DYNAMIC custom tag — the aggregated record already derives it from
            // builtin-catalog coverage; an aggregated-unknown id (no catalog row
            // at all) is by definition custom.
            custom: u ? u.custom : true,
            logo: u?.logo ?? v.logo,
            npm: v.npm ?? u?.npm,
            // Operator takedown: routing state, never a defs-file field (ADR-0010).
            // The card stays listed so the operator can restore it with one click.
            disabled: takedown !== undefined,
            ...(takedown?.reason ? { disabledReason: takedown.reason } : {}),
            // Def-level custom headers (non-secret metadata — the edit dialog
            // prefills from this; secrets live in the bound store, never here).
            headers: defNode?.headers ?? defNode?.options?.headers,
            // auth-only providers have no config baseURL — fall back to the
            // catalog's effective base. Precedence mirrors boot-direct's
            // wire-base chain (def baseURL > models.dev `api` > live service
            // hint) so the card shows the SAME endpoint inference routes to.
            baseURL: v.baseURL || u?.baseURL || u?.api,
            // Owning plugin id when the def was registered by a plugin preset —
            // the Connected tab mirrors the catalog's origin filter on it.
            pluginOrigin: origins[v.id],
            priceFrom: u ? catalogRepository.minInputPrice(u) : undefined,
            modelsCount: u?.models.length ?? v.models.length,
          };
        }),
      };
    },

    catalog: async (req: FastifyRequest) => {
      const lang = typeof (req.query as { lang?: unknown })?.lang === 'string' ? (req.query as { lang: string }).lang : undefined;
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      // Plugin-origin provenance for the console tag/filter — ledger join only,
      // never a field written into providers.json (ADR-0010).
      const origins = pluginProviderOrigins();
      const unified = await catalogRepository.list();
      // Trim model arrays from the list payload (detail endpoint can serve them later)
      const providers = unified.map((p) => ({
        id: p.id,
        name: p.name,
        logo: p.logo,
        npm: p.npm,
        api: p.api,
        baseURL: p.baseURL,
        doc: p.doc,
        env: p.env,
        custom: p.custom,
        connected: p.connected,
        // Plugin merges below may forward a preset's web-authorization
        // capability onto this row.
        webLogin: undefined as boolean | undefined,
        webLoginSubmit: undefined as boolean | undefined,
        authTypes: undefined as PluginAuthType[] | undefined,
        keyHint: undefined as string | undefined,
        // Owning plugin id when the def was registered by a plugin preset.
        pluginOrigin: origins[p.id],
        sources: p.sources,
        modelCount: p.models.length,
        priceFrom: catalogRepository.minInputPrice(p),
      }));
      // Plugin presets join the connect catalog (logo + one-click credential),
      // deduped against repository entries that already carry the same id.
      // Pure config-source rows are dropped: a defs-file node is already fully
      // presented on the Connected tab — the connect catalog is a DISCOVERY
      // surface (remote catalog sources + plugin presets), not a mirror of the
      // operator's own declared relays.
      try {
        const { pluginPresetCatalogEntries } = await import('../plugins/host.js');
        for (const preset of await pluginPresetCatalogEntries(lang)) {
          const idx = providers.findIndex((p) => p.id === preset.id);
          if (idx >= 0) {
            const existing = providers[idx];
            if (preset.connected || existing.sources.some((s) => s !== 'config')) {
              // Connected preset: the config entry IS the live row (its models
              // ride along) — keep it, just attach the plugin logo if missing.
              // Catalog-covered preset: the catalog entry is the richer record.
              if (!existing.logo && preset.logo) existing.logo = preset.logo;
              existing.name = preset.name; // the stored def name is localeless — show the manifest's localized one
              // Forward the web-authorization capability, or the connect card
              // never offers the plugin's device-login button.
              existing.webLogin = preset.webLogin;
              existing.pluginOrigin = existing.pluginOrigin ?? origins[preset.id];
              existing.webLoginSubmit = preset.webLoginSubmit;
              existing.authTypes = preset.authTypes;
              existing.keyHint = preset.keyHint;
              // Tag the plugin origin, or the trailing pure-config-source drop
              // below removes the row we just decided to keep.
              if (!existing.sources.includes('service')) existing.sources = [...existing.sources, 'service'];
              continue;
            }
            // Unconnected preset materialized only as a pure config-source row
            // (syncPluginPresets upserts the def at install): swap in the
            // preset row — plugin logo, displayName, connectable via the
            // preset's own baseURL/npm.
            providers.splice(idx, 1);
          }
          providers.push({ id: preset.id, name: preset.name, logo: preset.logo, npm: preset.npm, api: undefined, baseURL: preset.baseURL, doc: undefined, env: undefined, custom: preset.custom, connected: preset.connected, webLogin: preset.webLogin, webLoginSubmit: preset.webLoginSubmit, authTypes: preset.authTypes, keyHint: preset.keyHint, pluginOrigin: origins[preset.id], sources: preset.sources, modelCount: 0, priceFrom: undefined });
        }
      } catch {
        // catalog must survive a broken plugin host
      }
      // Pure config-source rows are dropped: a self-declared defs node is
      // already fully presented on the Connected tab — the connect catalog is
      // a DISCOVERY surface (remote catalog sources + plugin presets), not a
      // mirror of the operator's own declared relays.
      const connectable = providers.filter((p) => !(p.sources.length === 1 && p.sources[0] === 'config'));
      return { status: 'ok', source: catalogRepository.lastSyncOrigin, providers: connectable };
    },

    /** Flat model view across providers. `?maintained=1` narrows it to the
     *  physical models a defs node actually maintains (the /models page
     *  universe — no virtual aliases/combos/variants by construction), and
     *  tags every row with `maintained` so the console never has to infer it
     *  from the source tag. Supports ?provider= & ?connected=1. */
    models: async (req: any) => {
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const { readProviderDefsFile } = await import('../opencode/provider-defs.js');
      const query = req.query as { provider?: string; connected?: string; maintained?: string };
      const providerFilter = query.provider?.trim().toLowerCase();
      const connectedOnly = query.connected === '1' || query.connected === 'true';
      const maintainedOnly = query.maintained === '1' || query.maintained === 'true';
      // Raw file read once — the aggregate is already built from the normalized
      // view, so a retired-shape node here contributes no rows anyway.
      const rawNodes = readProviderDefsFile()?.providers ?? {};
      const takedowns = getProviderTakedownStore();
      const nodeModels = (pid: string): Record<string, unknown> => {
        const node = rawNodes[pid];
        const models = node && typeof node === 'object' ? (node as any).models : undefined;
        return models && typeof models === 'object' ? models : {};
      };
      const unified = await catalogRepository.list();
      const models = unified
        .filter(
          (p) =>
            (!providerFilter || p.id.toLowerCase() === providerFilter) &&
            (!connectedOnly || p.connected)
        )
        .flatMap((p) => {
          const defs = nodeModels(p.id);
          return p.models
            .map((m) => ({
              ...m,
              providerId: p.id,
              providerName: p.name,
              logo: p.logo,
              custom: p.custom,
              connected: p.connected,
              // Provider-level takedown: the row stays on the maintenance page
              // (aggregate truth), but the badge says it cannot route.
              providerDisabled: takedowns.isDisabled(p.id),
              maintained: Object.prototype.hasOwnProperty.call(defs, m.id),
            }))
            .filter((m) => !maintainedOnly || m.maintained);
        });
      return { status: 'ok', source: catalogRepository.lastSyncOrigin, total: models.length, models };
    },

    create: async (req: any, reply: any) => {
      const body = req.body as any;
      if (!body?.id) {
        return reply.status(400).send({ success: false, error: 'Provider id is required' });
      }
      const id = String(body.id);
      // Provider ids are lowercase slugs: they key the defs file, credential
      // store, quota (provider x keyHashPrefix) pairs, breaker state and
      // modelRef strings verbatim, and every built-in/catalog vocabulary id is
      // lowercase. Refuse anything else so a mixed-case id can never fork the
      // namespace (the form normalizes input live; direct API callers get the
      // rule stated back). Also keeps the catalog-shadow guard below exact:
      // 'OpenAI' can no longer bypass a covered 'openai' id.
      const { isValidProviderId, PROVIDER_ID_RULE, upsertProviderDef, getProviderNodeById } = await import('../opencode/user-config.js');
      if (!isValidProviderId(id)) {
        return reply.status(400).send({
          success: false,
          error: `Invalid provider id '${id}' - ${PROVIDER_ID_RULE}`,
        });
      }
      // A baseURL pointing back at THIS gateway would make the gateway its own
      // upstream (boot excludes it loudly as self_loop) — refuse at the door
      // with the same wording. Pointing at a DIFFERENT instance (another
      // port/host) is a legitimate federation upstream and passes. Criterion
      // is the URL, never the id.
      if (isSelfBaseURL(String(body.baseURL ?? ''), loadConfig().port)) {
        return reply.status(409).send({
          success: false,
          error: `baseURL (${body.baseURL}) points at this gateway itself — the gateway cannot be its own upstream`,
        });
      }
      // An id covered by the remote catalog (opencode / models-dev) may NOT be
      // redefined as a custom provider — it would shadow the catalog entry.
      // Connect it with credentials through the bound store instead, no definition needed.
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const covered = await catalogRepository.getProvider(id);
      if (covered && covered.sources.some((s) => s === 'opencode' || s === 'models-dev')) {
        return reply.status(409).send({
          success: false,
          error: `'${id}' is covered by the built-in catalog — connect it with credentials instead of redefining it`,
        });
      }
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      // Captured BEFORE the def write — decides whether a failed key push may roll
      // the node back (only a node this request created).
      const existedBefore = getProviderNodeById(id) !== undefined;
      // A non-inline key is NEVER written into a file by
      // the def helper — it goes to the bound store, and upsertProviderDef is fed no
      // apiKey at all. auth.json is not a sink on any binding.
      const keyToStore = Boolean(body?.apiKey) && !Boolean(body.apiKeyInline);

      // DEF FIRST, then the key. opencode v2 addresses a credential write by a
      // REGISTERED integration id, and a config-declared provider registers from
      // its def node only when the service LOADS config — at boot, or via the
      // reload the store itself issues on an unmatched write (see
      // OpencodeV2Store.resolveIntegrationId). Pushing the key before the def
      // exists asks upstream for an id it can NEVER resolve for a brand-new custom
      // id. A failed key push rolls back the node this request created, EXCEPT the
      // unmatched refusal (see the catch below) — that keeps the def for the retry.
      const result = upsertProviderDef({
        id,
        name: body.name,
        npm: body.npm,
        baseURL: body.baseURL,
        apiKey: keyToStore ? undefined : body.apiKey,
        apiKeyInline: Boolean(body.apiKeyInline),
        headers: body.headers,
        models: body.models,
        options: body.options,
        // opencode-v2-only passthrough slots (ignored on a legacy-resident node).
        env: body.env,
        canonical: body.canonical,
        body: body.body,
      });
      if (!result.success) return reply.status(400).send(result);
      // Auto-pull whitelist edit rides the same request — config.yaml, not the defs file.
      const patternEdit = applyAutoPullPatternEdit(id, body.pullPattern);
      if (!patternEdit.success) return reply.status(400).send(patternEdit);
      // The def can register an integration upstream — never answer from the stale
      // registry snapshot (a false refusal would grey the button for up to the TTL).
      store.invalidate();

      let keyMeta: CredentialMeta | undefined;
      if (keyToStore) {
        try {
          keyMeta = (await connectKeyIdempotent(store, id, String(body.apiKey), undefined, registry.getCircuitBreakerManager(), registry)).credential;
        } catch (err) {
          // Roll back only a node THIS request created — with ONE exception: the
          // unmatched refusal now fires only AFTER the store's reload attempt, so
          // it means upstream cannot host this id at all (e.g. a service build
          // without POST /api/location/reload). The def is the prerequisite for
          // the retry after a restart; deleting it would make the operator
          // re-type the whole definition. Existing defs are never touched.
          const m = await import('../opencode/credentials/index.js');
          if (!existedBefore && !(err instanceof m.IntegrationUnmatchedError)) {
            const { deleteProviderDef } = await import('../opencode/user-config.js');
            deleteProviderDef(id);
          }
          store.invalidate();
          const failure = await mapStoreWriteFailure(err);
          if (failure) return reply.status(failure.status).send(failure.body);
          return reply.status(400).send({ success: false, error: errMessage(err) });
        }
      }
      // Decision 6: fresh key material = reconnect — the credential's SUSPECT flag lifts.
      if (keyToStore) clearSuspectForCredential(registry.getCircuitBreakerManager(), id, keyMeta?.keyHashPrefix);
      // Opportunistic model pull — FIRE AND FORGET: a slow or unreachable
      // /v1/models must NOT hold the creation response (awaiting it made create
      // block up to its 15s timeout). Best-effort by design: refusals/errors are
      // logged and swallowed, the periodic auto-pull is the backstop, and the
      // console shows models on the next refresh. OPT-IN: only providers that
      // declared a catalog.autoPullPatterns entry are pulled (the pattern bounds
      // the pull) — an undeclared provider gets no automatic materialization of
      // its full upstream list. Skipped when the caller brought explicit models
      // (their list wins).
      if (!body.models) {
        const autoPattern = loadConfig().catalog?.autoPullPatterns?.[id]?.trim();
        if (autoPattern) {
          import('../opencode/catalog/auto-pull.js')
            .then(({ autoPullProvider }) => autoPullProvider(id, { pattern: autoPattern }))
            .then((pull) => {
              if (pull.httpStatus !== 200) app.log.warn({ providerId: id, pull }, 'post-create model pull refused (swallowed by design)');
            })
            .catch((err) => app.log.warn({ err, providerId: id }, 'post-create model pull errored (swallowed by design)'));
        }
      }
      return { status: 'ok', ...result };
    },

    update: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const { upsertProviderDef, getProviderNodeById } = await import('../opencode/user-config.js');
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const existing = getProviderNodeById(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' not found in the provider defs file` });
      }
      // Same door-guard as create: an update may SET a baseURL — or keep the
      // existing one — pointing at the gateway itself. The fallback mirrors
      // the upsert's `body.baseURL ?? existing.options?.baseURL` below.
      const effectiveBaseURL = body.baseURL ?? existing.options?.baseURL ?? '';
      if (isSelfBaseURL(String(effectiveBaseURL), loadConfig().port)) {
        return reply.status(409).send({
          success: false,
          error: `baseURL (${effectiveBaseURL}) points at this gateway itself — the gateway cannot be its own upstream`,
        });
      }
      // B4: same implicit auth.json side-write as create (apiKey + !inline) —
      // routed to the bound store when auth.json is not the sink (Decision 4).
      const store = await getCredentialStore();
      const { sanitizeExtraHeaders } = await import('../utils/http-headers.js');
      const inline = body.apiKeyInline ?? Boolean(existing.options?.apiKey);
      const keyToStore = Boolean(body?.apiKey) && !inline;
      let keyMeta: CredentialMeta | undefined;
      if (keyToStore) {
        try {
          keyMeta = (await connectKeyIdempotent(store, id, String(body.apiKey), undefined, registry.getCircuitBreakerManager(), registry)).credential;
        } catch (err) {
          const failure = await mapStoreWriteFailure(err);
          if (failure) return reply.status(failure.status).send(failure.body);
          return reply.status(400).send({ success: false, error: errMessage(err) });
        }
      }
      const result = upsertProviderDef({
        id,
        name: body.name ?? existing.name,
        npm: body.npm ?? existing.npm,
        baseURL: body.baseURL ?? existing.options?.baseURL,
        apiKey: keyToStore ? undefined : body.apiKey,
        apiKeyInline: inline,
        // Explicit `headers` (even {}) fully replaces; absent falls back to the
        // existing def — an emptied editor clears every custom header.
        headers: body.headers === undefined ? existing.options?.headers : sanitizeExtraHeaders(body.headers),
        models: body.models ?? existing.models,
        options: existing.options,
        // Single def generation (v2 shape). The v2-only slots ride the NORMALIZED
        // def so an update on an existing node preserves canonical/body/env instead
        // of silently dropping them.
        env: body.env ?? existing.env,
        canonical: body.canonical ?? existing.canonical,
        body: body.body ?? existing.body,
      });
      if (!result.success) return reply.status(400).send(result);
      // Auto-pull whitelist edit rides the same request — config.yaml, not the defs file.
      const patternEdit = applyAutoPullPatternEdit(id, body.pullPattern);
      if (!patternEdit.success) return reply.status(400).send(patternEdit);
      // A def edit can change what upstream registers — never answer from the stale
      // integration snapshot.
      store.invalidate();
      if (keyToStore) clearSuspectForCredential(registry.getCircuitBreakerManager(), id, keyMeta?.keyHashPrefix);
      return { status: 'ok', ...result };
    },

    connect: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { apiKey?: string; baseURL?: string };
      const { upsertProviderDef, getProviderNodeById } = await import('../opencode/user-config.js');
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      try {
        if (!body?.apiKey) {
          return reply.status(400).send({
            success: false,
            oauthHint: true,
            error: `API key required. For OAuth-based providers run: opencode auth login ${id}`,
          });
        }
        // The BOUND store owns the credential
        // sink — opencode v2 → opencode HTTP connect/key, ocr → <ocrHome>/credentials.json.
        // A WriteFailedError maps to 5xx and NEVER falls back to OcrStore
        // (Decision 3: read degrades with a badge, write refuses).
        const store = await getCredentialStore();
        const { credential: keyMeta, deduped, headPreserved } = await connectKeyIdempotent(
          store, id, body.apiKey, undefined, registry.getCircuitBreakerManager(), registry
        );
        // Optional baseURL override — merge with the existing definition so we
        // never wipe name/npm/models of a config-defined custom provider.
        // No apiKey field → no implicit credential write on any binding.
        if (body.baseURL) {
          const existing = getProviderNodeById(id);
          upsertProviderDef({
            id,
            baseURL: body.baseURL,
            name: existing?.name,
            npm: existing?.npm,
            headers: existing?.options?.headers,
            models: existing?.models,
            options: existing?.options,
            // keep the existing node's shape + opencode-v2-only slots
            // (a baseURL connect on a opencode-v2 shaped node must not demote it to opencode v1).
            env: existing?.env,
            canonical: existing?.canonical,
            body: existing?.body,
          });
        }
        store.invalidate(); // Decision 3: console action invalidates the store view
        // Decision 6: reconnecting lifts a SUSPECT mark on this credential.
        clearSuspectForCredential(registry.getCircuitBreakerManager(), id, keyMeta?.keyHashPrefix);
        // Connect-time doctrine: the provider now owns a defs node whose models
        // are its universe. Best-effort (live /v1/models first, static catalog
        // fallback) — a slow/unreachable upstream never fails the connect.
        const { ensureConnectedProviderBook } = await import('../opencode/catalog/auto-pull.js');
        const fill = await ensureConnectedProviderBook(id, { baseURL: body.baseURL }).catch((e: any) => ({
          nodeCreated: false,
          pulled: 0,
          fillError: String(e?.message ?? e),
        }));
        if (fill.fillError) {
          app.log.warn({ providerId: id, fillError: fill.fillError }, 'connect-time model auto-fill failed (swallowed by design)');
        }
        return {
          status: 'ok',
          success: true,
          // ADDITIVE (idempotent connect): `deduped` is a SUCCESS outcome, not a
          // refusal — the key IS in the store, which is what the caller asked
          // for — so it rides its own flag and never a failure `reasonCode`.
          // `credential` names the row (existing or new) so the UI can say which.
          deduped,
          credential: keyMeta,
          // Non-null when the sink auto-activated the new key and this surface put
          // the previous head back: the row the operator must be told is still head.
          headPreserved,
          // ADDITIVE: model auto-fill outcome (defs node created / models written).
          nodeCreated: fill.nodeCreated,
          modelsFilled: fill.pulled,
          message: `Provider '${id}' connected via ${credentialSinkLabel(store)}`,
        };
      } catch (err: any) {
        const failure = await mapStoreWriteFailure(err);
        if (failure) return reply.status(failure.status).send(failure.body);
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    /** Resolve the model-service plugin serving a provider def's wire
     *  (plugin wires only — the vendor protocol stays in the plugin). */
    webLoginPluginFor: async (id: string) => {
      const { getProviderNodeById } = await import('../opencode/user-config.js');
      const { wireFor } = await import('../providers/wire.js');
      const def = getProviderNodeById(id);
      if (!def) return { error: `provider '${id}' not found` };
      const node = def as { baseURL?: string; options?: { baseURL?: string }; npm?: string; package?: string };
      const baseURL = (node.options?.baseURL ?? node.baseURL ?? '').replace(/\/+$/, '');
      const npm = node.npm || node.package || '';
      const wire = npm ? wireFor(npm) : baseURL ? wireFor(undefined, baseURL) : 'unroutable';
      const plugin = (await import('../plugins/host.js')).getModelServicePlugin(wire);
      if (!plugin?.webLogin) {
        return { error: `provider '${id}' is not on a plugin wire with a web-login capability` };
      }
      return { plugin, baseURL };
    },
    webLoginStart: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const r = await ocHandlers.webLoginPluginFor(id);
      if ('error' in r) return reply.code(404).send({ success: false, error: r.error });
      try {
        const { authUrl } = await r.plugin.webLogin!.start({ baseURL: r.baseURL });
        return { status: 'ok', authUrl };
      } catch (err) {
        return reply.code(502).send({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    webLoginPoll: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const r = await ocHandlers.webLoginPluginFor(id);
      if ('error' in r) return reply.code(404).send({ success: false, error: r.error });
      try {
        const result = await r.plugin.webLogin!.poll({ baseURL: r.baseURL });
        if (!result.done) {
          return { status: 'ok', done: false, error: result.error };
        }
        // Login finished — wire the fresh token into the credential store
        // (same write path as a manual connect), then connect-time model
        // auto-fill so the card shows as connected with models.
        if (!result.token) {
          return { status: 'ok', done: true, connected: false, error: 'login finished without a token' };
        }
        const credentialStore = await (await import('../opencode/credentials/index.js')).getCredentialStore();
        const { credential: keyMeta } = await connectKeyIdempotent(
          credentialStore, id, result.token, undefined, registry.getCircuitBreakerManager(), registry
        );
        const { ensureConnectedProviderBook } = await import('../opencode/catalog/auto-pull.js');
        const fill = await ensureConnectedProviderBook(id, { baseURL: r.baseURL }).catch((e: any) => ({
          nodeCreated: false,
          pulled: 0,
          fillError: String(e?.message ?? e),
        }));
        if (fill.fillError) {
          app.log.warn({ providerId: id, fillError: fill.fillError }, 'web-login connect-time model auto-fill failed (swallowed by design)');
        }
        return { status: 'ok', done: true, connected: true, credential: keyMeta };
      } catch (err) {
        return reply.code(502).send({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    webLoginSubmit: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const code = String((req.body || {}).code ?? '').trim();
      if (!code) return reply.code(400).send({ success: false, error: 'missing code' });
      const r = await ocHandlers.webLoginPluginFor(id);
      if ('error' in r) return reply.code(404).send({ success: false, error: r.error });
      if (!r.plugin.webLogin!.submit) {
        return reply.code(404).send({ success: false, error: `provider '${id}' web-login has no manual token submission` });
      }
      try {
        const result = await r.plugin.webLogin!.submit({ baseURL: r.baseURL, code });
        if (!result.ok) return { status: 'ok', connected: false, error: result.error };
        // Same wiring as a finished poll: credential-store write + connect-time
        // model auto-fill so the card flips to connected. A submit that
        // consumed the code without returning a token is a plugin bug — refuse
        // to persist the (likely expired) raw code as the credential, exactly
        // like the poll path's 'login finished without a token' guard.
        if (!result.token) {
          return { status: 'ok', connected: false, error: 'submit finished without a token' };
        }
        const credentialStore = await (await import('../opencode/credentials/index.js')).getCredentialStore();
        const { credential: keyMeta } = await connectKeyIdempotent(
          credentialStore, id, result.token, undefined, registry.getCircuitBreakerManager(), registry
        );
        const { ensureConnectedProviderBook } = await import('../opencode/catalog/auto-pull.js');
        const fill = await ensureConnectedProviderBook(id, { baseURL: r.baseURL }).catch((e: any) => ({
          nodeCreated: false,
          pulled: 0,
          fillError: String(e?.message ?? e),
        }));
        if (fill.fillError) {
          app.log.warn({ providerId: id, fillError: fill.fillError }, 'web-login submit connect-time model auto-fill failed (swallowed by design)');
        }
        return { status: 'ok', connected: true, credential: keyMeta };
      } catch (err) {
        return reply.code(502).send({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    /**
     * One-shot upstream connectivity probe behind the console "Test" buttons.
     * Resolves baseURL/key/model from body overrides (test-before-save) or
     * the bound credential store. Config problems (no key/baseURL/model) are 4xx; probe
     * outcomes (auth failure, network error, upstream error) come back as data
     * on HTTP 200 with ok:false.
     */
    test: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = (req.body || {}) as {
        modelId?: string;
        apiKey?: string;
        baseURL?: string;
        credentialId?: string;
      };
      const { getProviderNodeById, getProviderModelDefs, expandEnvTemplate } = await import(
        '../opencode/user-config.js'
      );
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const def = getProviderNodeById(id);
      // B4: the probe key comes from the BOUND store — auth.json is a stale
      // snapshot on opencode v2 machines and no longer the standalone sink. resolveKey
      // is the sanctioned raw read for this route: the key leaves only as the
      // upstream probe header (its whole purpose), never in the response.
      // Inline {env:VAR}/options.apiKey keep priority ABOVE the store (Decision 1).
      const store = await getCredentialStore();
      // Provider-level probes honor the operator takedown overlay: a disabled
      // credential is parked from routing, so probing with it would report a
      // provider as healthy while inference refuses that key. The store does
      // not carry the flag (it lives in the breaker state store's overlay), so
      // the chain is filtered with the same keyHashPrefix identity routing
      // uses — and probed IN ORDER below (first key that answers wins). An
      // addressed credentialId below deliberately bypasses this.
      const credentialState = registry.getCircuitBreakerManager().getCredentialStateStore();
      const storeChain = store.resolveKeyChain(id);
      const enabledChain = storeChain.filter(
        (c) => c.key && !credentialState.isDisabled(id, keyHashPrefix(c.key))
      );
      // Per-credential probe: the operator pinned ONE credential row (KeysPage
      // credential list). resolveKeyChain is a sanctioned raw read on this route
      // — same contract as resolveKey above: the key leaves only as the
      // upstream probe header, the response carries masked metadata only.
      // An addressed read deliberately BYPASSES the inline-key precedence:
      // "test this credential" is not "what routing would pick" — the routing
      // head may be a different row, and that is exactly what is being tested.
      let addressed: RawCred | undefined;
      if (body.credentialId) {
        addressed = store.resolveKeyChain(id).find((c) => c.credentialId === body.credentialId);
        if (!addressed) {
          return reply.status(400).send({
            success: false,
            reasonCode: 'credential_not_testable',
            provider: id,
            credentialId: body.credentialId,
          });
        }
      }
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const cat = (await catalogRepository.list()).find((p) => p.id === id);
      // model: explicit override (config key or upstream id) → up to
      // PROBE_CANDIDATE_CAP enabled config defs → up to CAP catalog text
      // models. Provider-level tests get a CANDIDATE LIST because catalog order
      // is upstream-given and the head model may simply be one the credential has
      // not opened (Ark answers that as a model-scoped 404); the probe loop
      // below rotates on model-scoped failures only. An explicit modelId is
      // NEVER substituted — "test this model" reports exactly that model.
      const defs = getProviderModelDefs(id);
      const upstreamId = (mid: string): string => {
        const d = defs?.[mid];
        return d && typeof d === 'object' && d.modelID ? String(d.modelID) : mid;
      };
      const defIds = Object.keys(defs || {}).filter((k) => (defs as any)[k]?.disabled !== true);
      // The probe always sends a TEXT chat request on a text wire, so default
      // model selection prefers a model whose catalog modalities accept text in
      // AND out. A video/image-output or audio-only-input model (token-plan's
      // catalog head happyhorse-1.1-r2v) answers 400 "url error, please check
      // url" on the chat URL even when key+baseURL are perfect. Models without
      // modality data pass (no evidence against, parity with boot-direct's
      // routing-pool predicate); the unfiltered head/first def stays the last
      // resort so all-non-text providers remain probeable and behavior for
      // modality-less providers is identical to before.
      const isTextPair = (mods?: { input?: string[]; output?: string[] }): boolean => {
        const ok = (a?: string[]) => !Array.isArray(a) || a.length === 0 || a.includes('text');
        return ok(mods?.input) && ok(mods?.output);
      };
      const PROBE_CANDIDATE_CAP = 3;
      const modelCandidates: string[] = body.modelId
        ? [upstreamId(body.modelId)]
        : defIds.length > 0
          ? (() => {
              const textDefs = defIds.filter((k) => {
                const cm = cat?.models.find((mm) => mm.id === upstreamId(k));
                return !cm || isTextPair(cm.modalities);
              });
              const list = textDefs.length > 0 ? textDefs : [defIds[0]];
              return list.slice(0, PROBE_CANDIDATE_CAP).map(upstreamId);
            })()
          : (() => {
              const text = (cat?.models ?? [])
                .filter((mm) => mm.disabled !== true && isTextPair(mm.modalities))
                .map((mm) => mm.id);
              const list = text.length > 0 ? text : (cat?.models ?? []).slice(0, 1).map((mm) => mm.id);
              return list.slice(0, PROBE_CANDIDATE_CAP);
            })();
      if (modelCandidates.length === 0) {
        return reply.status(400).send({ success: false, reasonCode: 'no_testable_model', provider: id });
      }

      // probes run DIRECT against the provider on the same wire the
      // executor resolved for this model (shared wireFor()). The opencode
      // daemon is not in any request path — no test-vs-inference divergence.
      // OAuth access-token probing retires with the store flip: no
      // CredentialStore exports raw oauth tokens (masked list-and-badge only) —
      // an oauth-only provider lands on the 400 hint.
      //
      // KEY ORDER = what a provider-level probe tries, first to last:
      // an addressed row (one row only — "test this credential" is not "what
      // routing would pick"), an explicit `body.apiKey`, the def's inline key,
      // then the enabled store chain. The chain ROTATES: the whole point of
      // storing several keys is that any of them may serve inference, so "the
      // provider works" is proven by the first key that answers — reporting
      // the head's 401 while key #2 is fine would send the operator hunting a
      // problem that does not exist. Everything parked means nothing can be
      // probed at all (a disabled key is out of service).
      type ProbeAttempt = { key: string; credentialId?: string };
      const inlineKey = expandEnvTemplate(def?.options?.apiKey);
      const probeAttempts: ProbeAttempt[] = [];
      if (addressed) {
        probeAttempts.push({ key: addressed.key, credentialId: addressed.credentialId });
      } else if (body.apiKey) {
        probeAttempts.push({ key: body.apiKey });
      } else if (inlineKey) {
        probeAttempts.push({ key: inlineKey });
      } else {
        for (const c of enabledChain) probeAttempts.push({ key: c.key, credentialId: c.credentialId });
      }
      if (probeAttempts.length === 0) {
        // Every stored key parked: say THAT, not the misleading no-key/OAuth
        // hint (the operator must know a takedown is the cause). Reaching this
        // point already proves there is no addressed row, no request-body key,
        // no inline key and no enabled store row — the disabled chain is the
        // only thing left to explain.
        if (storeChain.some((c) => c.key)) {
          return reply.status(400).send({
            success: false,
            reasonCode: 'no_enabled_credential',
            provider: id,
            error: `Every credential stored for '${id}' is disabled — enable one before testing.`,
          });
        }
        return reply.status(400).send({
          success: false,
          oauthHint: true,
          error: `No API key for '${id}' (credential store or inline). For OAuth-based providers run: opencode auth login ${id}`,
        });
      }
      // Same precedence as boot-direct pool construction (models.dev `api`
      // before the daemon runtime hint) — test must hit what inference hits.
      const baseURL = body.baseURL || def?.options?.baseURL || cat?.api || cat?.baseURL;
      if (!baseURL) {
        return reply.status(400).send({ success: false, reasonCode: 'no_base_url', provider: id });
      }
      const { probeProvider, probeKindFor } = await import('../opencode/probe.js');
      const { baseForWire } = await import('../providers/wire.js');
      const { sanitizeExtraHeaders } = await import('../utils/http-headers.js');
      // Two nested rotation loops, both stopping on one green:
      //   · models — a MODEL-SCOPED failure (upstream ANSWERED and rejected
      //     only that model) advances to the next candidate model;
      //   · credentials — the rotation the operator asked for: a key that is
      //     revoked (401/403) or out of quota (429) says nothing about its
      //     siblings, so the next credential takes over and the model list
      //     restarts from the top for it.
      // Only a MOUNT failure ends the probe early: transport errors, unroutable
      // packages, 5xx and HTML gateways are properties of the baseURL, which
      // every credential of the provider shares — rotating would just repeat
      // the same error with a different key attached.
      let result: Awaited<ReturnType<typeof probeProvider>> | undefined;
      const tried: string[] = [];
      const triedCredentialIds: string[] = [];
      let answered: ProbeAttempt | undefined;
      probes: for (const attempt of probeAttempts) {
        if (attempt.credentialId) triedCredentialIds.push(attempt.credentialId);
        // Tracks the row the FINAL verdict belongs to: reassigned per attempt,
        // so a green probe is credited to the key that answered while an
        // all-red one is credited to the key tried last.
        answered = attempt;
        for (const modelId of modelCandidates) {
          if (!tried.includes(modelId)) tried.push(modelId);
          // Model-level npm override (e.g. Zen gpt-6-luna → @ai-sdk/openai =
          // Responses API) beats provider-level npm when picking the wire shape.
          const modelNpm = cat?.models.find((mm) => mm.id === modelId)?.npm;
          const kind = probeKindFor(cat?.api, modelNpm || def?.npm || cat?.npm);
          result = await probeProvider({
            baseURL: baseForWire(kind, baseURL),
            apiKey: attempt.key,
            model: modelId,
            provider: id,
            kind,
            headers: sanitizeExtraHeaders(def?.options?.headers),
          });
          if (result.ok) break probes;
          // Key-scoped refusal → this key is done, hand over to the next one.
          if (result.hintCode === 'authFailed' || result.hintCode === 'rateLimited') break;
          // Reached the upstream and got refused for THIS model → another key
          // may have it open; anything else (transport, 5xx) is the mount's
          // problem, and a mount is shared by every key of the provider.
          if (!result.modelScoped) break probes;
        }
      }
      // Masked echo of the row that produced the verdict (never raw material):
      // the row that ANSWERED on success, the row tried last on failure — the UI
      // can confirm WHICH credential the verdict belongs to, not just the
      // provider.
      const credentialMetas = store.listCredentials(id);
      const credentialMeta = answered?.credentialId
        ? credentialMetas.find((a) => a.id === answered!.credentialId)
        : undefined;
      const triedCredentials = triedCredentialIds
        .map((cid) => credentialMetas.find((a) => a.id === cid))
        .filter((a): a is (typeof credentialMetas)[number] => !!a);
      return {
        status: 'ok',
        provider: id,
        model: result?.model,
        // Rotation evidence (machine data, localized by the console): which
        // candidates were tried, in order. Only meaningful when > 1.
        ...(tried.length > 1 ? { triedModels: tried } : {}),
        ...(triedCredentials.length > 1 ? { triedCredentials } : {}),
        ...(credentialMeta ? { credential: credentialMeta } : {}),
        ...result,
      };
    },

    setKey: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { apiKey?: string };
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      if (!body?.apiKey) {
        return reply.status(400).send({ success: false, error: 'apiKey is required' });
      }
      try {
        // Route through the bound store — opencode v2
        // hits the HTTP sink (a NEW key ADDS an credential — multi-credential reality; the
        // same key is deduped, never doubled) and ocr writes the local file. No
        // auth.json write exists on any binding.
        const store = await getCredentialStore();
        const { credential: keyMeta, deduped, headPreserved } = await connectKeyIdempotent(
          store, id, body.apiKey, undefined, registry.getCircuitBreakerManager(), registry
        );
        store.invalidate();
        // Decision 6: a key rotation handed to the store is a reconnect — clear SUSPECT.
        clearSuspectForCredential(registry.getCircuitBreakerManager(), id, keyMeta?.keyHashPrefix);
        return {
          status: 'ok',
          success: true,
          deduped,
          credential: keyMeta,
          headPreserved,
          message: `Credential updated for '${id}'`,
        };
      } catch (err: any) {
        const failure = await mapStoreWriteFailure(err);
        if (failure) return reply.status(failure.status).send(failure.body);
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    remove: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const query = req.query as { purgeAuth?: string };
      const { deleteProviderDef, getProviderNodeById } = await import('../opencode/user-config.js');
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const purgeAuth = query.purgeAuth === '1' || query.purgeAuth === 'true';
      try {
        const store = await getCredentialStore();
        if (getProviderNodeById(id)) {
          // The credential side is handled through the bound store below —
          // deleteProviderDef is def-only, so it can neither dead-write auth.json
          // nor miss the standalone store's credentials.json (the B3 regression).
          const result = deleteProviderDef(id);
          if (!result.success) return reply.status(400).send(result);
          // Decision 8 double confirmation is enforced by the console UI
          // (purgeAuth opt-in) — server-side the loop reports honestly.
          const purge = purgeAuth ? await purgeProviderCredentials(store, id) : null;
          dropTakedownWhenProviderGone(id, store);
          const outcome = purge ? purgeOutcomeMessage(purge, id, true) : null;
          // Clean purge (or no purge requested): legacy response bytes kept.
          // defRemoved is the runtime truth — the console success toast follows
          // it, never the (possibly stale) pre-dialog snapshot.
          if (!outcome || outcome.success) return { status: 'ok', ...result, defRemoved: true, ...(purge ? { purge } : {}) };
          // P1-3 flip: config node is gone but credentials REMAIN — the
          // response must say so (success:false + honest message + failed[]).
          return { status: 'ok', ...result, ...outcome, defRemoved: true, purge };
        }
        // Credential-only entry: provider-wide disconnect = the UI-level
        // credential loop (Decision 1), never a direct upstream-file edit.
        const purge = await purgeProviderCredentials(store, id);
        dropTakedownWhenProviderGone(id, store);
        return { status: 'ok', defRemoved: false, ...purgeOutcomeMessage(purge, id, false), purge };
      } catch (err: any) {
        const failure = await mapStoreWriteFailure(err);
        if (failure) return reply.status(failure.status).send(failure.body);
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    // -- Per-provider model maintenance (every connected provider owns a node) ----

    /** Full model definitions of a provider (management view). Each row carries
     *  the EFFECTIVE `disabled` (override plane wins over a def-level flag) so
     *  the dialog's eye icon reflects exactly what boot-direct will do. */
    modelsGet: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const { getProviderModelDefs } = await import('../opencode/user-config.js');
      const { readOverridesStore } = await import('../opencode/catalog/overrides-store.js');
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        // no defs node — every CONNECTED provider owns one (connect-time
        // doctrine, ensureConnectedProviderBook); this row was never connected
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in the provider defs file` });
      }
      // node present but no models yet → an EMPTY manageable universe (pull or
      // add models to make them routable — the catalog is a source, not a pool)
      const overrides = readOverridesStore()?.models ?? {};
      const models: Record<string, any> = {};
      for (const [mid, raw] of Object.entries(defs)) {
        const def = raw && typeof raw === 'object' ? { ...(raw as Record<string, any>) } : {};
        const o = overrides[`${id}||${mid}`];
        if (o?.disabled !== undefined) def.disabled = o.disabled;
        models[mid] = def;
      }
      return { status: 'ok', id, models };
    },

    /** Add one model. Body: catalog-style fields or a raw `definition` object. */
    modelAdd: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const { getProviderModelDefs, upsertProviderModel } = await import('../opencode/user-config.js');
      if (!body?.id) {
        return reply.status(400).send({ success: false, error: 'Model id is required' });
      }
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        // no defs node — the provider was never connected (connect-time doctrine)
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in the provider defs file` });
      }
      if (body.id in defs) {
        return reply.status(409).send({ success: false, error: `Model '${body.id}' already exists — use PATCH to modify it` });
      }
      const result = upsertProviderModel(id, String(body.id), bodyToModelDef(body));
      if (!result.success) return reply.status(400).send(result);
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', success: true, model: body.id };
    },

    /** Modify one model (partial merge over the existing definition). */
    modelUpdate: async (req: any, reply: any) => {
      const { id, modelId } = req.params as { id: string; modelId: string };
      const body = req.body as any;
      const { getProviderModelDefs, upsertProviderModel, removeProviderModel } = await import('../opencode/user-config.js');
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in the provider defs file` });
      }
      if (!(modelId in defs)) {
        return reply.status(404).send({ success: false, error: `Model '${modelId}' is not defined for provider '${id}'` });
      }
      // rename support: newId moves the definition to a new key (write new → remove old)
      const targetId = body?.newId ? String(body.newId) : modelId;
      const existing = defs[modelId] && typeof defs[modelId] === 'object' ? defs[modelId] : {};
      const patch = bodyToModelDef(body);
      const next: Record<string, any> = { ...existing, ...patch };
      // limit/cost: partial merge (the form sends them only when edited)
      if (patch.limit || existing.limit) next.limit = { ...(existing.limit || {}), ...(patch.limit || {}) };
      // cost: a payload carrying a `cost` key replaces it wholesale (the editor
      // form always sends the full object, so blank fields clear stored prices);
      // a payload without `cost` keeps the old values. Empty `{}` clears.
      if (body?.cost && typeof body.cost === 'object') {
        const c: Record<string, number> = {};
        for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
          const v = (body.cost as any)[k];
          if (typeof v === 'number' && Number.isFinite(v)) c[k] = v;
        }
        if (Object.keys(c).length > 0) next.cost = c;
        else delete next.cost; // blank form → drop the key instead of writing `cost: {}`
      }
      // opencode v2 composite fields (capabilities/settings/headers/body/compatibility/
      // variants): the form is a full-definition editor — values present in the
      // payload (even {}) replace wholesale; absent keys keep their old values.
      const result = upsertProviderModel(id, targetId, next);
      if (!result.success) return reply.status(400).send(result);
      if (targetId !== modelId) {
        const rm = removeProviderModel(id, modelId);
        if (!rm.success) {
          return reply.status(400).send({
            success: false,
            error: `Renamed to '${targetId}' but failed to remove the old entry '${modelId}': ${rm.error}`,
          });
        }
      }
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', success: true, model: targetId, renamed: targetId !== modelId };
    },

    modelRemove: async (req: any, reply: any) => {
      const { id, modelId } = req.params as { id: string; modelId: string };
      const { removeProviderModel } = await import('../opencode/user-config.js');
      const result = removeProviderModel(id, modelId);
      if (!result.success) return reply.status(404).send(result);
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', success: true, model: modelId };
    },

    /**
     * Reorder one provider's model map. Body: `{ ids: string[] }` — the target
     * order of the models this provider owns (unknown ids ignored, omitted ids
     * keep their relative order at the tail, see reorderProviderModels).
     */
    modelReorder: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { ids?: unknown } | undefined;
      const ids = Array.isArray(body?.ids) ? body!.ids.filter((x): x is string => typeof x === 'string') : [];
      if (ids.length === 0) {
        return reply.status(400).send({ success: false, error: 'ids[] is required' });
      }
      const { getProviderNodeById, reorderProviderModels } = await import('../opencode/user-config.js');
      if (!getProviderNodeById(id)) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in the provider defs file` });
      }
      const result = reorderProviderModels(id, ids);
      if (!result.success) return reply.status(400).send(result);
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', ...result };
    },

    /**
     * Pull models into the provider's config definition. Data source is chosen
     * automatically: providers with baseURL + credential are pulled LIVE from
     * their own /v1/models (failures surface real errors); providers without a
     * usable baseURL/key fall back to the static merged catalog. Builtin
     * (first-party catalog) providers take the MERGED path — catalog sets the
     * metadata-authoritative base, a live /v1/models pass only tops up ids the
     * catalog lacks. The same engine powers the periodic auto-pull
     * (catalog.autoPullModels).
     */
    modelsPull: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pattern?: string; ids?: string[]; dryRun?: boolean } | undefined;
      const { autoPullProvider } = await import('../opencode/catalog/auto-pull.js');
      const result = await autoPullProvider(id, body ?? {});
      // withPoolSync keys on reply.sent. A dry run is a read-only preview and
      // must not rebuild the live registry; a real pull returns the body so
      // the wrapper can apply the new defs without a restart.
      if (body?.dryRun) return reply.status(result.httpStatus).send(result.body);
      reply.status(result.httpStatus);
      return result.body;
    },

    /** Clear models — whole node without a pattern, matching ids only with one. */
    modelsClear: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pattern?: string } | undefined;
      const { clearProviderModels } = await import('../opencode/user-config.js');
      const result = clearProviderModels(id, body?.pattern);
      if (!result.success) return reply.status(404).send(result);
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', ...result };
    },

    /**
     * Bound credential-store status — the console badge data
     * source, and what closes touchpoint gap #1 (boot excluded[] used to be
     * log-only). Returns the StoreStatus verbatim plus per-provider masked
     * CredentialMeta detail and the Decision 4 reconcile summary. Masked-only:
     * the payload can never carry a raw key (listCredentials/CredentialOverview
     * expose maskSecret output + keyHash prefixes only).
     */
    credentialStore: async () => {
      const { getCredentialStore, getCredentialStoreStatus, readCredentialStoreState, getBoundCredentialPaths } =
        await import('../opencode/credentials/index.js');
      const status = await getCredentialStoreStatus();
      const store = await getCredentialStore();
      // ADDITIVE keys only — old consumers ignore them:
      // per-credential pair health via the shared overlay (one shape everywhere).
      // The provider SET comes from a LIVE `credentialsOverview()`, not from
      // `status.credentials` (a bind-time snapshot): a provider connected after
      // boot would otherwise never list its credentials at all, which is exactly
      // the "added a key, nothing shows up" hole the snapshot left open. The
      // snapshot is kept as the fallback so an unreadable store still reports the
      // bind-time view plus its loud degraded badge.
      let overview: typeof status.credentials;
      try {
        overview = store.credentialsOverview();
      } catch {
        // Unreadable store: fall back to the bind-time snapshot rather than
        // emptying the list — `probeResult` / `excluded[]` carry the loud state.
        overview = status.credentials;
      }
      const credentials = overview.map((a) => {
        try {
          return { ...a, credentials: withCredentialHealth(a.providerId, store.listCredentials(a.providerId)) };
        } catch {
          return { ...a, credentials: [] }; // unreadable store: probeResult/excluded stay loud
        }
      });
      const state = readCredentialStoreState(getBoundCredentialPaths() ?? undefined);
      // ADDITIVE: an integration-scoped sink (opencode v2) also reports WHICH
      // provider ids it will accept writes for. Stale credential rows keep routing
      // while being un-writable (their integration was retired upstream), so without
      // this the console can only discover the refusal after the operator types a
      // key. Empty/absent = not integration-scoped, or the registry was unreadable
      // (never gate the UI on an unknown).
      let integrations: string[] | undefined;
      if (store.capabilities.integrationScoped && store.listIntegrationIds) {
        const ids = await store.listIntegrationIds();
        integrations = ids.length > 0 ? ids : undefined;
      }
      return {
        status: 'ok',
        store: { ...status, credentials, ...(integrations ? { integrations } : {}) },
        reconcile: state?.reconcile ?? null,
      };
    },

    /**
     * Credential-sync table data — per-client auto toggles, availability and
     * the last read/write outcomes (credential-sync.json). Masked metadata
     * only; never key material.
     */
    credentialSyncStatus: async () => {
      const { getBoundCredentialPaths, getBindTestOverrides, credentialSyncStatusView } = await import(
        '../opencode/credentials/index.js'
      );
      const overrides = getBindTestOverrides();
      const view = credentialSyncStatusView({ paths: getBoundCredentialPaths() ?? undefined, env: overrides.env });
      return { status: 'ok', clients: view.clients };
    },

    /** Flip one auto-sync direction of one client; persists to credential-sync.json. */
    credentialSyncToggle: async (req: any, reply: any) => {
      const body = (req.body || {}) as { clientId?: string; direction?: string; enabled?: boolean };
      if (!isSyncClientId(body.clientId)) {
        return reply.status(404).send({ status: 'error', success: false, error: `unknown sync client '${body.clientId}'` });
      }
      if (body.direction !== 'read' && body.direction !== 'write') {
        return reply.status(400).send({ status: 'error', success: false, error: "direction must be 'read' or 'write'" });
      }
      if (typeof body.enabled !== 'boolean') {
        return reply.status(400).send({ status: 'error', success: false, error: 'enabled must be a boolean' });
      }
      const { getBoundCredentialPaths, getBindTestOverrides, setSyncAutoToggle, credentialSyncStatusView } = await import(
        '../opencode/credentials/index.js'
      );
      const overrides = getBindTestOverrides();
      setSyncAutoToggle(body.clientId, body.direction, body.enabled, {
        paths: getBoundCredentialPaths() ?? undefined,
        now: overrides.now,
      });
      // Echo the FULL row (label/present/writeReady + sync state): the console
      // patches its table row with this object verbatim, so a state-only echo
      // would wipe the client's name and availability flags.
      const client = credentialSyncStatusView({
        paths: getBoundCredentialPaths() ?? undefined,
        env: overrides.env,
      }).clients.find((c) => c.id === body.clientId);
      return { status: 'ok', client };
    },

    /**
     * Manual sync: run one direction or both for one client and record the
     * outcomes. Write-converged pairs lift their SUSPECT flag.
     */
    credentialSyncRun: async (req: any, reply: any) => {
      const body = (req.body || {}) as { clientId?: string; direction?: string; provider?: string };
      if (!isSyncClientId(body.clientId)) {
        return reply.status(404).send({ status: 'error', success: false, error: `unknown sync client '${body.clientId}'` });
      }
      if (body.provider !== undefined && (typeof body.provider !== 'string' || !body.provider.trim() || body.provider.length > 200)) {
        return reply.status(400).send({ status: 'error', success: false, error: 'provider must be a non-empty id (max 200 chars)' });
      }
      const direction =
        body.direction === 'read' || body.direction === 'write' || body.direction === 'both' ? body.direction : 'both';
      const {
        getCredentialStore,
        getBoundCredentialPaths,
        getBindTestOverrides,
        runCredentialSync,
      } = await import('../opencode/credentials/index.js');
      try {
        const store = await getCredentialStore();
        const overrides = getBindTestOverrides();
        const result = await runCredentialSync(body.clientId, direction, store, {
          paths: getBoundCredentialPaths() ?? undefined,
          env: overrides.env,
          fetchImpl: overrides.fetchImpl,
          now: overrides.now,
          openDatabase: overrides.openDatabase,
          ...(body.provider !== undefined ? { provider: body.provider.trim() } : {}),
        });
        const cb = registry.getCircuitBreakerManager();
        for (const k of result.write?.pushedKeys ?? []) clearSuspectForCredential(cb, k.provider, k.keyHashPrefix);
        // A sync pull/import can land keys on MANY providers — refresh every
        // connected provider's runtime chain (cheap: one store read per provider).
        for (const o of store.credentialsOverview()) {
          await refreshProviderCredentialChain(registry, store, o.providerId);
        }
        return { status: 'ok', direction, ...result };
      } catch (err: any) {
        return reply.status(500).send({
          status: 'error',
          success: false,
          error: errMessage(err),
        });
      }
    },

    /**
     * REORDER a provider's credential chain (the Keys page's drag/ordering
     * action; replaces the retired operator activate route — `store.activate`
     * stays the internal head primitive for sync/connect headPreserved).
     * Body: { ids: string[] } — a permutation of the provider's credential
     * ids; the default credential becomes ids[0]. Gated on capabilities.reorder
     * (Decision 1). Response mirrors the old activate reply: the head
     * credential plus the refreshed masked credential list so the UI
     * repaints without a second fetch.
     */
    credentialReorder: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { ids?: unknown } | undefined;
      const ids = body?.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string')) {
        return reply.status(400).send({
          status: 'error',
          success: false,
          reasonCode: 'invalid_ids',
          error: 'ids must be a non-empty array of credential id strings',
        });
      }
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      if (!store.capabilities.reorder) return reply.status(400).send(capabilityRefusalBody('reorder'));
      // Guard-light: verify the provider has rows before the store call (the
      // store's own reorder validates the id permutation and 404s unknown ids).
      try {
        if (store.listCredentials(id).length === 0) {
          return reply.status(404).send(credentialNotFoundBody(ids[0] as string, id));
        }
      } catch (err) {
        const failure = await mapStoreWriteFailure(err);
        if (failure) return reply.status(failure.status).send({ status: 'error', ...failure.body });
        return reply.status(500).send({ status: 'error', success: false, error: errMessage(err) });
      }
      try {
        const reordered = await store.reorder(id, ids as string[]);
        store.invalidate(); // Decision 3: console action invalidates the store view
        // Reorder IS the chain order — swap the runtime chain so the new head
        // serves without a restart.
        await refreshProviderCredentialChain(registry, store, id);
        const credential = reordered[0];
        return { status: 'ok', success: true, credential, credentials: withCredentialHealth(id, store.listCredentials(id)) };
      } catch (err) {
        const failure = await mapCredentialWriteFailure(err, id, String((ids as string[])[0]));
        return reply.status(failure.status).send(failure.body);
      }
    },

    /**
     * SET the spread weight of ONE credential (operator lever for unequal
     * quotas: a credential weighing w occupies w slots of the deterministic
     * new-session spread). Body: { weight: number } — an INTEGER in
     * [1, CREDENTIAL_WEIGHT_MAX]; anything else is a 400 invalid_weight.
     * Gated on capabilities.weight (opencode v2 rows have no weight field and
     * refuse, exactly like reorder). The chain is hot-refreshed so the new
     * weight shapes the very next placement — no restart.
     */
    credentialSetWeight: async (req: any, reply: any) => {
      const { id, credentialId } = req.params as { id: string; credentialId: string };
      const body = req.body as { weight?: unknown } | undefined;
      const raw = body?.weight;
      const weight = typeof raw === 'number' && Number.isInteger(raw) ? raw : NaN;
      if (!Number.isFinite(weight) || weight < 1 || weight > CREDENTIAL_WEIGHT_MAX) {
        return reply.status(400).send({
          status: 'error',
          success: false,
          reasonCode: 'invalid_weight',
          error: `weight must be an integer between 1 and ${CREDENTIAL_WEIGHT_MAX}`,
        });
      }
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      if (!store.capabilities.weight) return reply.status(400).send(capabilityRefusalBody('weight'));
      const guard = await guardStoreCredential(store, id, credentialId);
      if (!guard.ok) return reply.status(guard.status).send(guard.body);
      try {
        const credential = await store.setWeight(credentialId, weight);
        store.invalidate(); // Decision 3: console action invalidates the store view
        // The weight rides the runtime chain — swap it in so the next
        // new-session placement sees the new proportions immediately.
        await refreshProviderCredentialChain(registry, store, id);
        return { status: 'ok', success: true, credential, credentials: withCredentialHealth(id, store.listCredentials(id)) };
      } catch (err) {
        const failure = await mapCredentialWriteFailure(err, id, credentialId);
        return reply.status(failure.status).send(failure.body);
      }
    },

    /**
     * Rename one credential (user-editable label; opencode v2 rows carry
     * one; a store without labels refuses via capabilities.rename=false). Label contract:
     * trimmed, ≤80 chars, and EMPTY IS VALID — it CLEARS the label. An empty value
     * used to be a 400, which made opencode's own auto-name (e.g. the default
     * `API key`) impossible to remove: OCR never generates a name, so refusing the
     * blank only locked the operator into a label this product did not choose.
     * The display falls back to the row's fingerprint handle when unlabeled.
     */
    credentialRename: async (req: any, reply: any) => {
      const { id, credentialId } = req.params as { id: string; credentialId: string };
      const body = req.body as { label?: unknown } | undefined;
      if (body?.label !== undefined && typeof body.label !== 'string') {
        return reply.status(400).send({
          status: 'error',
          success: false,
          reasonCode: 'invalid_label',
          error: 'label must be a string (empty string clears it)',
        });
      }
      const label = (typeof body?.label === 'string' ? body.label : '').trim();
      if (label.length > 80) {
        return reply
          .status(400)
          .send({ status: 'error', success: false, reasonCode: 'invalid_label', error: 'label too long (max 80 characters)' });
      }
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      if (!store.capabilities.rename) return reply.status(400).send(capabilityRefusalBody('rename'));
      const guard = await guardStoreCredential(store, id, credentialId);
      if (!guard.ok) return reply.status(guard.status).send(guard.body);
      try {
        const credential = await store.rename(credentialId, label);
        store.invalidate();
        return { status: 'ok', success: true, credential, credentials: withCredentialHealth(id, store.listCredentials(id)) };
      } catch (err) {
        const failure = await mapCredentialWriteFailure(err, id, credentialId);
        return reply.status(failure.status).send(failure.body);
      }
    },

    /**
     * Disconnect ONE credential: deletes the store's
     * copy of the credential. The double confirmation is FRONTEND-side; the
     * backend honors an explicit DELETE. Since Decision 10 the operator CAN
     * export the key first (the row's password-gated reveal) — the confirmation
     * copy says so, so the irreversible gesture stays honest.
     * No capability pre-gate exists (StoreCapabilities has no disconnect
     * flag): a OpencodeV2Store-readonly refusal surfaces from the store itself →
     * 409 store_readonly through the shared failure mapper, never an
     * OcrStore fallback. The keyHashPrefix captured by the guard BEFORE
     * deletion anchors the Decision 6 SUSPECT clear on key material — the
     * explicit clears (reconnect / Push / takedown release) are the shipped
     * anti-zombie mechanism; snapshot-wide keyHash GC is deferred follow-up.
     */
    credentialDisconnect: async (req: any, reply: any) => {
      const { id, credentialId } = req.params as { id: string; credentialId: string };
      // Client-side delete is ON by default (a delete here is a revocation, not a
      // local cleanup): `?clientRevoke=0` keeps the client copy when the operator
      // explicitly wants to retire only the OCR row.
      const clientRevoke = !['0', 'false'].includes(
        String((req.query as { clientRevoke?: string })?.clientRevoke ?? '').toLowerCase()
      );
      const { getCredentialStore, getBoundCredentialPaths, getBindTestOverrides } = await import(
        '../opencode/credentials/index.js'
      );
      const store = await getCredentialStore();
      const guard = await guardStoreCredential(store, id, credentialId);
      if (!guard.ok) return reply.status(guard.status).send(guard.body);
      const prefix = guard.meta.keyHashPrefix;
      try {
        await store.disconnect(credentialId);
        store.invalidate();
        await refreshProviderCredentialChain(registry, store, id); // removed key must leave the live chain
        clearSuspectForCredential(registry.getCircuitBreakerManager(), id, prefix);
        // The last credential of a def-less provider removes the row entirely;
        // a takedown must not outlive the thing it targeted.
        dropTakedownWhenProviderGone(id, store);
        // DELETE is a REVOCATION, so it must be as durable as a takedown: anchor
        // the key MATERIAL as disabled. Otherwise the read sync would re-import
        // the key from the client as a clean, routable credential — the delete
        // would silently undo itself. The flag is keyHash-anchored (same ledger
        // as disable), so a re-import lands parked with its badge and one-click
        // restore; SUSPECT keeps its opposite lifecycle (reconnect clears it).
        let takedownAnchored = false;
        if (prefix) {
          const state = registry.getCircuitBreakerManager().getCredentialStateStore();
          // An ALREADY-parked key material keeps its own note: `disable()` rewrites
          // `reason` when it differs, and a delete must not launder the operator's
          // audit text into 'deleted' (the flag's other half, `disabledAt`, is
          // preserved by design). Parked is anchored either way.
          takedownAnchored = state.isDisabled(id, prefix) || state.disable(id, prefix, 'deleted');
        }
        // The client copy outlives an OCR-only delete — opencode routes from its
        // own db, so a revoked key must leave the client too. Targeted (this one
        // key material), never a book-wide diff; a failure is reported, not hidden.
        let clientRevokeResult: { clientId: string; result: string; detail?: string } | null = null;
        if (clientRevoke && prefix) {
          const { revokeOnClient } = await import('../opencode/credentials/sync.js');
          const overrides = getBindTestOverrides();
          clientRevokeResult = await revokeOnClient(id, prefix, {
            paths: getBoundCredentialPaths() ?? undefined,
            env: overrides.env,
            fetchImpl: overrides.fetchImpl,
            now: overrides.now,
            openDatabase: overrides.openDatabase,
          });
        }
        return {
          status: 'ok',
          success: true,
          disconnected: credentialId,
          takedownAnchored,
          clientRevoke: clientRevokeResult,
          credentials: withCredentialHealth(id, store.listCredentials(id)),
        };
      } catch (err) {
        const failure = await mapCredentialWriteFailure(err, id, credentialId);
        return reply.status(failure.status).send(failure.body);
      }
    },

    /**
     * Controlled credential reveal: the ONLY management
     * route that ever carries a raw key out. Gated by four hard conditions:
     *  1. webAuth ACTIVE with configured credentials — the gate is a re-entry of
     *     the console LOGIN password (a secret the browser never holds after
     *     login); where no password exists there is nothing to confirm (409);
     *  2. the login brute-force bucket is shared — a wrong reveal password counts
     *     as a login failure, so this route is never an offline-guessing machine
     *     (a correct one clears the bucket exactly like a successful login);
     *  3. password verified BEFORE any store read — no pre-auth credential
     *     enumeration; POST-only + no-store — the key never enters URLs, GET
     *     surfaces, caches, or logs;
     *  4. only rows carrying raw api-key material reveal — oauth/wellknown/empty
     *     refuse via CapabilityUnsupportedError (the OAuth boundary).
     */
    credentialReveal: async (req: any, reply: any) => {
      const { id, credentialId } = req.params as { id: string; credentialId: string };
      const disk = getRuntimeConfigRef() || loadConfig(); // same snapshot the login route reads
      if (!isWebAuthActive(disk) || !hasWebAuthCredentials(disk.webAuth)) {
        return reply.status(409).send({
          status: 'error',
          success: false,
          reasonCode: 'webauth_required',
          error: 'reveal requires console password login (webAuth) with a configured username/password',
        });
      }
      const ip = req.ip || 'unknown';
      const allow = checkLoginAllowed(ip);
      if (!allow.allowed) {
        reply.header('retry-after', String(allow.retryAfterSec ?? 60));
        return reply.status(429).send({
          status: 'error',
          success: false,
          reasonCode: 'too_many_attempts',
          error: `Too many failed attempts. Retry in ${allow.retryAfterSec}s.`,
        });
      }
      const body = (req.body || {}) as { password?: unknown };
      const password = typeof body.password === 'string' ? body.password : '';
      if (!verifyPassword(password, disk.webAuth!.passwordHash)) {
        recordLoginFailure(ip);
        return reply.status(401).send({
          status: 'error',
          success: false,
          reasonCode: 'invalid_password',
          error: 'Invalid password',
        });
      }
      recordLoginSuccess(ip);
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      const guard = await guardStoreCredential(store, id, credentialId);
      if (!guard.ok) return reply.status(guard.status).send(guard.body);
      try {
        const key = store.revealKey(credentialId);
        reply.header('Cache-Control', 'no-store');
        return { status: 'ok', key };
      } catch (err) {
        // Row-level capability refusal (oauth/wellknown carries no raw api key)
        // must NOT borrow the write mapper's 'store_readonly' reading — the
        // store is perfectly writable here, the ROW is not revealable.
        const m = await import('../opencode/credentials/index.js');
        if (err instanceof m.CapabilityUnsupportedError) {
          return reply.status(409).send({
            status: 'error',
            success: false,
            reasonCode: 'capability_unsupported',
            error: errMessage(err),
          });
        }
        const failure = await mapCredentialWriteFailure(err, id, credentialId);
        return reply.status(failure.status).send(failure.body);
      }
    },

    /**
     * Operator DISABLE / ENABLE one WHOLE provider — the coarse counterpart of
     * the credential takedown below. The provider keeps its defs node, models,
     * credentials and console card; only the routing pool drops it
     * (`buildDirectPool` → `operator_disabled`), so `/v1/models` omits it and
     * direct ids 404. State lives in the GLOBAL takedown ledger, never in
     * providers.json (that file is connection truth + the sync materializer's
     * source, ADR-0010). Manual-only lifecycle: nothing auto-clears it.
     */
    providerSetDisabled: async (
      req: FastifyRequest<{ Params: { id: string }; Body: { reason?: unknown } }>,
      reply: FastifyReply,
      disabled: boolean
    ) => {
      const { id } = req.params;
      const body = req.body ?? {};
      if (!isValidProviderId(id)) {
        return reply.status(400).send({
          status: 'error',
          success: false,
          reasonCode: 'invalid_provider_id',
          error: `Invalid provider id '${id}' - ${PROVIDER_ID_RULE}`,
        });
      }
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      let hasCredential = false;
      try {
        hasCredential = store.listCredentials(id).length > 0;
      } catch {
        // unreadable per-provider detail: a defs node still proves the provider exists
      }
      if (!getProviderNodeById(id) && !hasCredential) {
        return reply.status(404).send({
          status: 'error',
          success: false,
          reasonCode: 'provider_not_found',
          error: `Provider '${id}' is neither defined in providers.json nor connected with a credential`,
        });
      }
      const takedowns = getProviderTakedownStore();
      if (disabled) {
        const raw = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (raw.length > 200) {
          return reply
            .status(400)
            .send({ status: 'error', success: false, reasonCode: 'invalid_reason', error: 'reason too long (max 200 characters)' });
        }
        takedowns.disable(id, raw);
        return {
          status: 'ok',
          success: true,
          disabled: true,
          provider: id,
          message: `Provider '${id}' taken down (no model routes through it)`,
        };
      }
      takedowns.enable(id);
      return {
        status: 'ok',
        success: true,
        disabled: false,
        provider: id,
        message: `Provider '${id}' restored to routing`,
      };
    },

    providerDisable: (req: FastifyRequest<{ Params: { id: string }; Body: { reason?: unknown } }>, reply: FastifyReply) =>
      ocHandlers.providerSetDisabled(req, reply, true),
    providerEnable: (req: FastifyRequest<{ Params: { id: string }; Body: { reason?: unknown } }>, reply: FastifyReply) =>
      ocHandlers.providerSetDisabled(req, reply, false),

    /**
     * Operator DISABLE / ENABLE one credential — a durable takedown that never
     * auto-returns (cooldown expiry, reconnect, Push and breaker resets all leave
     * it alone), and the only lever between "temporarily tripped" and "deleted".
     * The flag lives in OCR's own credential-state file, NOT the credential store,
     * so it is deliberately NOT gated on `writesBlocked` or on any store
     * capability — the same reasoning as the admin suspect-clear door
     * (Decision 6). Enforcement happens at the single shared out-of-service
     * predicate (`isPairOut`), which selection, the prober plan and model
     * availability all read — one guard, every caller.
     */
    credentialSetDisabled: async (req: any, reply: any, disabled: boolean) => {
      const { id, credentialId } = req.params as { id: string; credentialId: string };
      const body = (req.body || {}) as { reason?: unknown };
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      const guard = await guardStoreCredential(store, id, credentialId);
      if (!guard.ok) return reply.status(guard.status).send(guard.body);
      // Decision 5: every credential flag is anchored on the key hash, never on the
      // churnable id. A row without a hash (no key material) has no identity to
      // flag — refuse loudly instead of keying a flag on something that drifts.
      const keyHashPrefix = guard.meta.keyHashPrefix;
      if (!keyHashPrefix) {
        return reply.status(409).send({
          status: 'error',
          success: false,
          reasonCode: 'no_key_identity',
          error: `credential '${credentialId}' carries no key hash (type '${guard.meta.type}') — it cannot be taken down`,
        });
      }
      const credentialState = registry.getCircuitBreakerManager().getCredentialStateStore();
      const name = guard.meta.label?.trim() || credentialId;
      if (disabled) {
        const raw = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (raw.length > 200) {
          return reply
            .status(400)
            .send({ status: 'error', success: false, reasonCode: 'invalid_reason', error: 'reason too long (max 200 characters)' });
        }
        credentialState.disable(id, keyHashPrefix, raw);
        const credentials = withCredentialHealth(id, store.listCredentials(id));
        return {
          status: 'ok',
          success: true,
          disabled: true,
          credential: credentials.find((a) => a.id === credentialId),
          credentials,
          message: `Credential '${name}' taken down (no traffic will route through it)`,
        };
      }
      credentialState.enable(id, keyHashPrefix);
      const credentials = withCredentialHealth(id, store.listCredentials(id));
      return {
        status: 'ok',
        success: true,
        disabled: false,
        credentials,
        message: `Credential '${name}' restored to routing`,
      };
    },

    credentialDisable: (req: any, reply: any) => ocHandlers.credentialSetDisabled(req, reply, true),
    credentialEnable: (req: any, reply: any) => ocHandlers.credentialSetDisabled(req, reply, false),
  };

  for (const prefix of ['/api/admin']) {
    app.get(`${prefix}/credential-store`, ocHandlers.credentialStore);
    app.get(`${prefix}/credential-sync`, ocHandlers.credentialSyncStatus);
    app.post(`${prefix}/credential-sync/toggle`, ocHandlers.credentialSyncToggle);
    app.post(`${prefix}/credential-sync/run`, withPoolSync(registry, ocHandlers.credentialSyncRun));
    app.get(`${prefix}/opencode/npm-vocabulary`, ocHandlers.npmVocabulary);
    app.get(`${prefix}/opencode/providers`, ocHandlers.list);
    app.get(`${prefix}/opencode/catalog`, ocHandlers.catalog);
    app.get(`${prefix}/opencode/models`, ocHandlers.models);
    app.post(`${prefix}/opencode/providers`, withPoolSync(registry, ocHandlers.create));
    app.patch(`${prefix}/opencode/providers/:id`, withPoolSync(registry, ocHandlers.update));
    app.post(`${prefix}/opencode/providers/:id/connect`, withPoolSync(registry, ocHandlers.connect));
    // Generic plugin web-authorization seam (device flow): start opens the
    // vendor login page; poll returns done+token and wires the fresh token
    // into the credential store. The plugin owns the whole protocol.
    app.post(`${prefix}/opencode/providers/:id/web-login/start`, ocHandlers.webLoginStart);
    // Both terminal paths write the fresh credential into the store, so both
    // must trigger a credential re-sync (same contract as the key route).
    app.get(`${prefix}/opencode/providers/:id/web-login/poll`, withPoolSync(registry, ocHandlers.webLoginPoll));
    app.post(`${prefix}/opencode/providers/:id/web-login/submit`, withPoolSync(registry, ocHandlers.webLoginSubmit));
    app.post(`${prefix}/opencode/providers/:id/key`, withPoolSync(registry, ocHandlers.setKey));
    app.post(`${prefix}/opencode/providers/:id/test`, ocHandlers.test);
    app.delete(`${prefix}/opencode/providers/:id`, withPoolSync(registry, ocHandlers.remove));
    // Provider-level operator takedown: routing state, not a defs write — the
    // pool resync drops (or restores) every model of the provider (ADR-0010).
    app.post(`${prefix}/opencode/providers/:id/disable`, withPoolSync(registry, ocHandlers.providerDisable));
    app.post(`${prefix}/opencode/providers/:id/enable`, withPoolSync(registry, ocHandlers.providerEnable));

    // Per-provider model maintenance (config-defined providers only)
    app.get(`${prefix}/opencode/providers/:id/models`, ocHandlers.modelsGet);
    app.post(`${prefix}/opencode/providers/:id/models`, withPoolSync(registry, ocHandlers.modelAdd));
    app.patch(`${prefix}/opencode/providers/:id/models/:modelId`, withPoolSync(registry, ocHandlers.modelUpdate));
    app.delete(`${prefix}/opencode/providers/:id/models/:modelId`, withPoolSync(registry, ocHandlers.modelRemove));
    app.post(`${prefix}/opencode/providers/:id/models/pull`, withPoolSync(registry, ocHandlers.modelsPull));
    app.post(`${prefix}/opencode/providers/:id/models/reorder`, withPoolSync(registry, ocHandlers.modelReorder));
    app.post(`${prefix}/opencode/providers/:id/models/clear`, withPoolSync(registry, ocHandlers.modelsClear));

    // Plugin host: read-only views + hot reload of the plugin dir.
    app.get(`${prefix}/plugins`, async () => {
      // views only — a read route must not clear+rebuild the live registry
      // (in-flight dispatch/probe would see an empty plugin set mid-rebuild)
      const { listInstalledPlugins } = await import('../plugins/host.js');
      return { status: 'ok', plugins: listInstalledPlugins() };
    });
    app.post(`${prefix}/plugins/reload`, async () => {
      const { loadInstalledPlugins, syncPluginPresets, listInstalledPlugins } = await import('../plugins/host.js');
      await loadInstalledPlugins();
      const plugins = listInstalledPlugins();
      const registered = await syncPluginPresets();
      await refreshDirectPool(registry);
      return { status: 'ok', plugins, registered };
    });
    // Upload-install: raw zip bytes (application/octet-stream), id in the query.
    app.get(`${prefix}/plugins/:id/logo`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { pluginLogoFile } = await import('../plugins/host.js');
      const file = pluginLogoFile(id);
      if (!file) return reply.code(404).send({ status: 'error', error: 'no logo' });
      const ext = file.split('.').pop()?.toLowerCase();
      const mime =
        ext === 'png' ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : ext === 'svg' ? 'image/svg+xml'
        : undefined;
      if (!mime) return reply.code(415).send({ status: 'error', error: 'unsupported logo format' });
      // Logos ship inside operator-installed packages: treat them as untrusted
      // content. SVG can carry scripts on direct navigation — lock it down;
      // buffered send also avoids the uninstall race between check and stream.
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'");
      return reply.type(mime).send(await fs.promises.readFile(file));
    });

    // Package export: a packaged plugin returns its installed zip verbatim; a
    // dev-tree plugin is bundled and zipped on the fly with the same
    // deterministic packer `plugins:build` uses, so a download round-trips
    // through Install. A bundle failure is the operator's signal that the
    // plugin cannot be packaged self-contained — surface the reason.
    app.get(`${prefix}/plugins/:id/package`, async (req, reply) => {
      const { id } = req.params as { id: string };
      let zip: Uint8Array | undefined;
      try {
        zip = await pluginPackageZip(id);
      } catch (err) {
        return reply.code(500).send({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
      if (!zip) return reply.code(404).send({ status: 'error', error: 'unknown plugin or package not found' });
      if (zip.length > PLUGIN_PACKAGE_MAX_BYTES) {
        return reply.code(413).send({ status: 'error', error: 'package exceeds 64 MiB' });
      }
      // Operator-installed bytes: lock the response down (same rule as logo).
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', `attachment; filename="${id}.zip"`);
      return reply.type('application/zip').send(Buffer.from(zip));
    });

    // Plugin-level configuration (ADR-0017): schema declared in plugin.json,
    // values stored as a plugin artifact — never in config.yaml.
    app.get(`${prefix}/plugins/:id/config`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { getPluginConfig } = await import('../plugins/host.js');
      const cfg = getPluginConfig(id);
      if (!cfg) return reply.code(404).send({ status: 'error', error: 'unknown or unloaded plugin' });
      return { status: 'ok', schema: cfg.schema, sections: cfg.sections, values: cfg.values };
    });
    app.put(`${prefix}/plugins/:id/config`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { values?: unknown };
      if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
        return reply.code(400).send({ status: 'error', error: 'body.values must be an object' });
      }
      try {
        const { applyPluginConfig } = await import('../plugins/host.js');
        const result = await applyPluginConfig(id, body.values as Record<string, unknown>);
        return { status: 'ok', values: result.values, warnings: result.warnings };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Unknown/unloaded plugin = 404 (same as GET); schema/value problems = 400.
        if (message === 'unknown or unloaded plugin') return reply.code(404).send({ status: 'error', error: message });
        return reply.code(400).send({ status: 'error', error: message });
      }
    });

    app.delete(`${prefix}/plugins/:id/uninstall`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const { uninstallPlugin, loadInstalledPlugins, listInstalledPlugins } = await import('../plugins/host.js');
        const result = await uninstallPlugin(id);
        await loadInstalledPlugins();
        const plugins = listInstalledPlugins();
        await refreshDirectPool(registry);
        return { status: 'ok', removed: result.removed, providersRemoved: result.providersRemoved, plugins };
      } catch (err) {
        return reply.code(400).send({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Toggle a plugin without deleting anything (works for dev-tree plugins
    // too): disabled.json skips it at discovery; enable + reload restores it.
    app.post(`${prefix}/plugins/:id/disable`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const { setPluginDisabled, loadInstalledPlugins, listInstalledPlugins } = await import('../plugins/host.js');
        const result = await setPluginDisabled(id, true);
        await loadInstalledPlugins();
        const plugins = listInstalledPlugins();
        await refreshDirectPool(registry);
        return { status: 'ok', providersRemoved: result.providersRemoved, plugins };
      } catch (err) {
        return reply.code(400).send({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post(`${prefix}/plugins/:id/enable`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const { setPluginDisabled, loadInstalledPlugins, listInstalledPlugins, syncPluginPresets } = await import('../plugins/host.js');
        await setPluginDisabled(id, false);
        await loadInstalledPlugins();
        const plugins = listInstalledPlugins();
        const registered = await syncPluginPresets();
        await refreshDirectPool(registry);
        return { status: 'ok', registered, plugins };
      } catch (err) {
        return reply.code(400).send({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post(
      `${prefix}/plugins/install`,
      { bodyLimit: PLUGIN_PACKAGE_MAX_BYTES },
      async (req, reply) => {
      const body = req.body as Buffer | string | undefined;
      const bytes = typeof body === 'string' ? Buffer.from(body, 'binary') : body;
      if (!bytes || bytes.length === 0) {
        return reply.code(400).send({ status: 'error', error: 'empty body — send the plugin zip as application/octet-stream' });
      }
      if (bytes.length > PLUGIN_PACKAGE_MAX_BYTES) {
        return reply.code(413).send({ status: 'error', error: 'package exceeds 64 MiB' });
      }
      try {
        const { installPluginPackage, packageIdOf, pluginPackageZip, listInstalledPlugins: listing } =
          await import('../plugins/host.js');
        // Snapshot the version this upload is about to REPLACE (a packaged one
        // — a dev-tree plugin is not ours to materialize here). A failed upgrade
        // must not delete a working install.
        let previous: Uint8Array | undefined;
        try {
          const target = packageIdOf(new Uint8Array(bytes));
          const existing = listing().find((p) => p.id === target);
          if (existing?.source === 'packaged' && !existing.disabled) previous = await pluginPackageZip(target);
        } catch {
          // unreadable upload: installPluginPackage below reports it properly
        }
        const { id: installed } = installPluginPackage(new Uint8Array(bytes));
        const { loadInstalledPlugins, syncPluginPresets, listInstalledPlugins } = await import('../plugins/host.js');
        await loadInstalledPlugins();
        const plugins = listInstalledPlugins();
        const view = plugins.find((p) => p.id === installed && !p.disabled);
        if (!view?.loaded) {
          // a package that cannot load would re-fail every boot — discard it;
          // discard BEFORE preset sync / pool refresh so a broken package
          // registers nothing
          const { discardPluginPackage } = await import('../plugins/host.js');
          discardPluginPackage(installed);
          // Roll BACK to the version that was working until this upload, so a
          // bad upgrade is a no-op instead of a lost plugin.
          if (previous) {
            installPluginPackage(previous);
            await loadInstalledPlugins();
            return reply.code(422).send({
              status: 'error',
              error: `package rejected and discarded (${view?.error ?? 'unknown error'}); rolled back to the previously installed version`,
              plugins: listInstalledPlugins(),
            });
          }
          // Reload AFTER the discard: otherwise the response would hand the
          // console a row for a package that is no longer on disk (the list is
          // the disk's truth, not the last failed import's).
          await loadInstalledPlugins();
          return reply
            .code(422)
            .send({ status: 'error', error: `package installed but failed to load (discarded): ${view?.error ?? 'unknown error'}`, plugins: listInstalledPlugins() });
        }
        // presets register at install time (same contract as boot/reload) —
        // after a verified successful load, BEFORE the pool refresh so the
        // fresh defs are routable immediately
        const registered = await syncPluginPresets();
        await refreshDirectPool(registry);
        return { status: 'ok', id: installed, plugins, registered };
      } catch (err) {
        return reply.code(400).send({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
      },
    );
    // Per-credential credential writes (reorder / rename / disconnect).
    // Decision 8 double-confirm lives in the console UI; these honor the call.
    app.post(`${prefix}/opencode/providers/:id/credentials/reorder`, withPoolSync(registry, ocHandlers.credentialReorder));
    app.post(`${prefix}/opencode/providers/:id/credentials/:credentialId/weight`, withPoolSync(registry, ocHandlers.credentialSetWeight));
    // Operator takedown (OCR credential state, NOT the credential store — survives
    // cooldown/reconnect/Push and is lifted only here).
    app.post(`${prefix}/opencode/providers/:id/credentials/:credentialId/disable`, withPoolSync(registry, ocHandlers.credentialDisable));
    app.post(`${prefix}/opencode/providers/:id/credentials/:credentialId/enable`, withPoolSync(registry, ocHandlers.credentialEnable));
    app.patch(`${prefix}/opencode/providers/:id/credentials/:credentialId`, withPoolSync(registry, ocHandlers.credentialRename));
    app.delete(`${prefix}/opencode/providers/:id/credentials/:credentialId`, withPoolSync(registry, ocHandlers.credentialDisconnect));
    // password-gated raw-key export (controlled exception).
    app.post(`${prefix}/opencode/providers/:id/credentials/:credentialId/reveal`, ocHandlers.credentialReveal);
  }

  // 8b. Catalog logo proxy — remote provider logos served from the local disk
  //     cache (backend/src/opencode/catalog/logos.ts) so page loads don't break
  //     icons when models.dev / openrouter.ai are unreachable.
  const handleCatalogLogo = async (req: any, reply: any) => {
    const { getLogoCached } = await import('../opencode/catalog/logos.js');
    const url = (req.query as { url?: string }).url;
    const logo = await getLogoCached(url);
    if (!logo) return reply.status(404).send();
    return reply.header('Cache-Control', 'public, max-age=604800').type(logo.contentType).send(logo.body);
  };
  app.get('/api/admin/catalog/logo', handleCatalogLogo);

  // 9. Client API Keys Management (for external client access)
  const handleListApiKeys = async () => {
    return { status: 'ok', keys: listApiKeys(false) };
  };
  app.get('/api/admin/api-keys', handleListApiKeys);

  const handleCreateApiKey = async (req: any, reply: any) => {
    const body = req.body as { name: string; key?: string; expiresAt?: string; description?: string; modelAccess?: unknown; limits?: unknown };
    if (!body?.name) {
      return reply.status(400).send({ success: false, message: 'API Key name is required' });
    }
    const access = validateModelAccess(body.modelAccess);
    if (access.error) {
      return reply.status(400).send({ success: false, error: access.error });
    }
    const limits = validateRateLimitRules(body.limits);
    if (limits.error) {
      return reply.status(400).send({ success: false, error: limits.error });
    }
    const result = createApiKey({ ...body, modelAccess: access.value, limits: limits.value });
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.post('/api/admin/api-keys', handleCreateApiKey);

  const handleUpdateApiKey = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; enabled?: boolean; expiresAt?: string; description?: string; modelAccess?: unknown; limits?: unknown };
    const access = validateModelAccess(body?.modelAccess);
    if (access.error) {
      return reply.status(400).send({ success: false, error: access.error });
    }
    const limits = validateRateLimitRules(body?.limits);
    if (limits.error) {
      return reply.status(400).send({ success: false, error: limits.error });
    }
    const result = updateApiKey(id, {
      ...body,
      modelAccess: body?.modelAccess === null ? null : access.value,
      limits: body?.limits === null ? null : limits.value,
    });
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.put('/api/admin/api-keys/:id', handleUpdateApiKey);

  const handleDeleteApiKey = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const result = deleteApiKey(id);
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.delete('/api/admin/api-keys/:id', handleDeleteApiKey);

  // 9a. Credential rate-limit overlay (config `credentials:` section) — CONFIG-side
  // governance: the credential itself lives in the CredentialStore and is not
  // touched here, so NO store capability gates this write. The body mirrors
  // the raw-YAML shape one entry at a time; validateRateLimitRules is the
  // shared grammar, so a console-saved rule and a hand-edited rule compile
  // identically. saveConfig hot-reloads the limiter (config/index.ts sync).
  const CREDENTIAL_PREFIX_PATTERN = /^[0-9a-f]{4,64}$/i;
  const handleSetCredentialLimits = async (req: any, reply: any) => {
    const body = req.body as { provider?: unknown; keyHashPrefix?: unknown; limits?: unknown };
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const prefix = typeof body?.keyHashPrefix === 'string' ? body.keyHashPrefix.trim().toLowerCase() : '';
    if (!provider) {
      return reply.status(400).send({ success: false, error: 'provider is required' });
    }
    if (!CREDENTIAL_PREFIX_PATTERN.test(prefix)) {
      return reply.status(400).send({ success: false, error: 'keyHashPrefix must be a 4-64 char hex string' });
    }
    if (body?.limits === undefined) {
      return reply.status(400).send({ success: false, error: 'limits is required (array of rules, or null to clear)' });
    }
    if (body?.limits !== null && !Array.isArray(body.limits)) {
      return reply.status(400).send({ success: false, error: 'limits must be an array (or null to clear)' });
    }
    const checked = validateRateLimitRules(body?.limits);
    if (checked.error) {
      return reply.status(400).send({ success: false, error: checked.error });
    }
    // Disk is the freshest truth for the overlay — reading it here keeps the
    // read-modify-write immune to any same-tick writer (the runtime ref is now
    // also synced by syncRuntimeAuthView, but the file is the authoritative
    // merge base either way).
    const cfg = loadConfig();
    const credentials: Record<string, CredentialLimitConfig[]> = structuredClone(cfg.credentials ?? {});
    const list = credentials[provider] ?? [];
    const idx = list.findIndex((e) => (e.keyHashPrefix ?? '').toLowerCase() === prefix);
    const rules = checked.value ?? [];
    if (rules.length === 0) {
      if (idx >= 0) list.splice(idx, 1);
    } else if (idx >= 0) {
      list[idx] = { keyHashPrefix: prefix, limits: rules };
    } else {
      list.push({ keyHashPrefix: prefix, limits: rules });
    }
    if (list.length > 0) credentials[provider] = list;
    else delete credentials[provider];
    const result = saveConfig({ credentials: Object.keys(credentials).length > 0 ? credentials : undefined });
    if (!result.success) {
      return reply.status(400).send({ success: false, error: result.error || 'Failed to persist credential limits' });
    }
    // Live windows for the addressed subject. Constraints whose
    // (windowMs,countable) survived the reload keep their accumulated sums;
    // newly armed or reshaped constraints start empty — the response reflects
    // exactly what the reloaded engine enforces.
    const subject = credentialSubject(provider, prefix);
    const windows = getRateLimiter().snapshot().filter((w) => w.subject === subject);
    return { status: 'ok', success: true, limits: rules.length > 0 ? rules : undefined, windows };
  };
  app.put('/api/admin/credentials/limits', handleSetCredentialLimits);

  // 9b. Effective model view for ONE key — what this key can actually see &
  //     use right now (mirrors the /v1/models policy filter + the execution
  //     pool gate). Read-only: no key material in the response. Each row is
  //     tagged with `kind` (same vocabulary as /api/admin/gateway-models:
  //     auto/tier/combo/model/variant) so the console can badge the
  //     addressable-id namespace a row belongs to.
  const handleGetKeyModels = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const key = listApiKeys(false).find((k) => k.id === id);
    if (!key) {
      return reply.status(404).send({ status: 'error', message: `API Key '${id}' not found` });
    }
    const policy = getModelAccessPolicy(key);
    type KeyModelRow = {
      id: string;
      kind: 'auto' | 'tier' | 'combo' | 'model' | 'variant';
      provider: string;
      tiers?: string[];
      virtual: boolean;
      allowed: boolean;
    };
    const registered: KeyModelRow[] = registry.getAllModels().map((m) => ({
      id: m.id,
      kind: 'model' as const,
      provider: m.provider,
      // FULL membership set (pools are a per-tier projection — a model may
      // belong to several tiers): tierAllowed counts every pool the model can
      // route toward, so auto-X viability never misses a multi-pool member.
      tiers: registry.tiersOf(m) as string[],
      virtual: false,
      allowed: isModelAllowedInTiers(m.id, policy, registry.tiersOf(m)),
    }));
    const tierAllowed = (t: string) => registered.some((m) => m.tiers?.includes(t) && m.allowed);
    // Virtual auto* rows honor runtime viability (mirrors /v1/models): bare
    // `auto` needs an allowed model in ANY tier, auto-X in tier X.
    const virtual = ['auto', 'lite', 'plus', 'pro', 'ultra'].map((id) => ({
      id,
      kind: (id === 'auto' ? 'auto' : 'tier') as 'auto' | 'tier',
      provider: 'omnicell-router',
      tier: tierFromVirtualEntry(id),
      virtual: true,
      allowed: isAutoEntryUsable(id, policy, tierAllowed),
    }));
    // Combo rows (mirrors /v1/models): routable virtual ids, but concrete
    // selectable entries — NOT auto*-virtual, so follow-mode snapshots keep
    // them. A combo passes only when EVERY member is allowed (the inference
    // entry gate; no silent composition change).
    const combos = registry.getCombos().map((c) => ({
      id: c.id,
      kind: 'combo' as const,
      provider: 'omnicell-router',
      tier: '',
      virtual: false,
      allowed: registry.resolveCombo(c.id).every((mem) => isModelAllowed(mem.id, policy, mem.tier)),
    }));
    // Variant rows (mirrors /v1/models): `base-variant` ids resolve to the
    // base model with a pinned reasoning effort; the policy verdict inherits
    // from the base id.
    const variants = registry.getVariantExposures().map(({ id, base }) => ({
      id,
      kind: 'variant' as const,
      provider: base.provider,
      tiers: registry.tiersOf(base) as string[],
      virtual: false,
      allowed: isModelAllowedInTiers(base.id, policy, registry.tiersOf(base)),
    }));
    // Order mirrors the /v1/models wire body EXACTLY (the console list is a
    // pure re-rendering of that payload — same rows, same sequence). The wire
    // builds a provider map whose insertion order IS the display order: the
    // omnicell-router virtual provider (auto alias → tier aliases → combos)
    // first, then concrete providers in registry first-appearance order, each
    // carrying its concrete models then its variant siblings.
    const providerRows = new Map<string, typeof registered>();
    const ensureProviderRows = (pid: string) => {
      let rows = providerRows.get(pid);
      if (!rows) {
        rows = [];
        providerRows.set(pid, rows);
      }
      return rows;
    };
    for (const m of registry.getAllModels()) {
      ensureProviderRows(m.provider).push(registered.find((r) => r.id === m.id)!);
    }
    for (const v of variants) ensureProviderRows(v.provider).push(v);
    const models = [
      ...virtual,
      ...combos,
      ...[...providerRows.entries()].filter(([pid]) => pid !== 'omnicell-router').flatMap(([, rows]) => rows),
    ];
    return {
      status: 'ok',
      mode: policy?.mode ?? 'none',
      policyModels: policy?.models ?? [],
      models,
    };
  };
  app.get('/api/admin/api-keys/:id/models', handleGetKeyModels);

  // 9c. Full gateway catalog for CONSOLE-internal consumers (model pickers).
  //     /v1/models now requires a key like every other surface; the trusted
  //     console UI reads the unfiltered catalog here instead.
  const handleGatewayModels = async () => {
    // `kind` tags the addressable-id namespace (virtual auto* / combo /
    // registered model / variant) so console pickers can badge each row —
    // owned_by alone cannot distinguish them (auto* and combos share
    // 'omnicell-router'; variants share their base model's provider).
    // `tiers` is the model's FULL membership set (pools are a per-tier
    // projection — a model may belong to several tiers, or none): no single
    // fixed tier is reported for any row.
    const models = [
      ...['auto', 'lite', 'plus', 'pro', 'ultra'].map((id) => ({
        id,
        // `auto` keeps its own kind (true auto-routing, cross-tier ratchet);
        // the four bare tier aliases are pinned-tier entries, tagged 'tier'.
        kind: (id === 'auto' ? 'auto' : 'tier') as 'auto' | 'tier',
        owned_by: 'omnicell-router',
        tiers: [] as string[],
      })),
      // Order mirrors /v1/models: auto* → combos → registered → variants, so
      // console pickers surface the short virtual ids before the long physical
      // list.
      ...registry.getCombos().map((c) => ({
        id: c.id,
        kind: 'combo' as const,
        owned_by: 'omnicell-router',
        tiers: [] as string[],
        // Resolved member count (disabled/unregistered members dropped) —
        // console pickers show it as the combo row's meta.
        members: registry.resolveCombo(c.id).length,
      })),
      ...registry.getAllModels().map((m) => ({
        id: m.id,
        kind: 'model' as const,
        owned_by: m.provider,
        tiers: registry.tiersOf(m) as string[],
        // Declared thinking levels (ADR-0003 vocabulary). Console pickers that
        // write a level into a config field (tier effort maps, variant pins)
        // offer ONLY these — anything else would be clamped right back by
        // downgradeReasoning. `[]` is a REAL answer ("no explicit level
        // control", e.g. a toggle-only model), never "unknown".
        efforts: modelSupportsEfforts(m.supportedReasoningEfforts, m.supportsReasoningEffort) ?? [],
        // Resolved upstream wire (model-level npm beats provider npm, see
        // providers/wire.ts). Console pickers MUST read it from here instead of
        // re-deriving it from the provider's npm string — `systemone` marks a
        // decision-wire model, which no chat surface can address (ADR-0008 §7).
        ...(m.wire ? { wire: m.wire } : {}),
      })),
      ...registry.getVariantExposures().map(({ id, base }) => ({
        id,
        kind: 'variant' as const,
        owned_by: base.provider,
        tiers: registry.tiersOf(base) as string[],
        // A variant is served by its base model's upstream → same wire.
        ...(base.wire ? { wire: base.wire } : {}),
      })),
    ];
    return { status: 'ok', models };
  };
  app.get('/api/admin/gateway-models', handleGatewayModels);

  // 10. Remote restart trigger from UI — spawn a detached restart SUPERVISOR
  //     first, then exit. The supervisor waits for this process to die (and
  //     force-kills it if stuck), spawns the replacement gateway, verifies
  //     `/health` (retrying a crashed child), and records the verdict in
  //     ocr.restart.json. Without the spawn we would just stop and nothing
  //     would bring the gateway back (there is no resident supervisor).
  // One handover at a time: this process exits 500 ms after acknowledging, so
  // a second POST inside that window would spawn a SECOND supervisor and two
  // replacements would race for the listen port. Idempotent answer instead.
  let restartInFlight = false;
  const handleRestart = async () => {
    if (restartInFlight) {
      return { status: 'restarting', message: 'Gateway restart is already in progress' };
    }
    restartInFlight = true;
    try {
      const { spawnDetachedRestartChild } = await import('../cli/daemon.js');
      const cfg = loadConfig();
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
      const spawned = spawnDetachedRestartChild({ port, host: cfg.host });
      if (!spawned) {
        restartInFlight = false;
        // Fault-tolerance: NEVER stop the gateway without a replacement — keep
        // serving and surface the failure to the UI instead of exiting.
        return {
          status: 'failed',
          message: 'Could not spawn a replacement process — gateway keeps running. Restart it manually when convenient.',
        };
      }
      setTimeout(() => process.exit(0), 500);
      return { status: 'restarting', message: 'Gateway restart signal acknowledged — the detached supervisor is booting the replacement' };
    } catch (err) {
      // Un-stick the guard: a thrown spawn/config error must not make every
      // later restart answer "already in progress" forever.
      restartInFlight = false;
      return { status: 'failed', message: `Restart failed: ${(err as Error).message}` };
    }
  };
  app.post('/api/admin/restart', handleRestart);

  // 11. Process-log tail viewer — reads ~/.omnicell-router/ocr.log (only
  //     written when the gateway runs under `ocr start`; a manual `bun
  //     backend/src/index.ts` writes to its own console instead).
  //     Reads at most 1 MiB from the tail so huge files never blow up memory.
  const handleGetLogs = async (req: any) => {
    const { getLogFilePath } = await import('../cli/paths.js');
    const query = req.query as { tail?: string; level?: string; q?: string };
    const tail = Math.min(Math.max(parseInt(query.tail || '500', 10) || 500, 1), 5000);
    const minLevel = parseLogLevelParam(query.level);
    const needle = (query.q || '').toLowerCase();

    const file = getLogFilePath();
    if (!fs.existsSync(file)) {
      return { status: 'ok', file, exists: false, size: 0, mtimeMs: 0, lines: [] };
    }

    const stat = fs.statSync(file);
    const readSize = Math.min(stat.size, 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      const text = buf.toString('utf8');
      const allLines = text.split(/\r?\n/);
      // Drop the first (likely partial) line when we sliced mid-line.
      if (readSize < stat.size && allLines.length > 0) allLines.shift();

      const parsed: ParsedLogLine[] = [];
      for (const rawLine of allLines) {
        // Strip NUL: after logs/clear, a Windows stale-offset writer leaves a
        // sparse zero region between file start and its next write position.
        const raw = rawLine.replace(/\0/g, '');
        if (!raw.trim()) continue;
        const entry = parseLogLine(raw);
        // Level filter only applies to parsed pino lines; banner text is
        // always kept so startup output never silently disappears.
        if (minLevel > 0 && entry.levelNum !== undefined && entry.levelNum < minLevel) continue;
        if (needle && !raw.toLowerCase().includes(needle)) continue;
        parsed.push(entry);
      }
      const lines = parsed.slice(-tail);
      return { status: 'ok', file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, lines };
    } finally {
      fs.closeSync(fd);
    }
  };
  app.get('/api/admin/logs', handleGetLogs);

  // Clear the process log: back up the current file, then truncate it in
  // place. Truncate (not delete/rename) is deliberate — on POSIX the daemon's
  // O_APPEND fd keeps writing to the same inode, and on Windows the sparse
  // NUL hole left behind the stale writer offset is filtered by the viewer.
  const handleClearLogs = async () => {
    const { getLogFilePath } = await import('../cli/paths.js');
    const file = getLogFilePath();
    if (!fs.existsSync(file)) {
      return { status: 'ok', cleared: false, exists: false, size: 0, backup: null };
    }
    const sizeBefore = fs.statSync(file).size;
    let backup: string | null = null;
    let warning: string | undefined;
    try {
      // Timestamped sibling copy (local time, lexicographic = chronological),
      // mirroring the `ocr.log.1..N` archive convention used at daemon start.
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      fs.copyFileSync(file, `${file}.clear-${stamp}.bak`);
      // Keep at most 3 clear-backups; prune the oldest by name order.
      const dir = path.dirname(file);
      const base = path.basename(file);
      const clears = fs
        .readdirSync(dir)
        .filter((n) => n.startsWith(`${base}.clear-`) && n.endsWith('.bak'))
        .sort();
      for (const stale of clears.slice(0, Math.max(0, clears.length - 3))) {
        try {
          fs.unlinkSync(path.join(dir, stale));
        } catch {
          // best-effort prune
        }
      }
      backup = clears.length ? path.join(dir, clears[clears.length - 1]) : null;
    } catch (err: any) {
      // A sharing violation (live Windows writer) or permission error must not
      // block the clear itself — the user asked for a clean log, not a backup.
      warning = `backup failed (${err?.code || err?.message || 'unknown'}); log truncated without backup`;
    }
    fs.truncateSync(file, 0);
    return { status: 'ok', cleared: true, exists: true, size: 0, sizeBefore, backup, warning };
  };
  app.post('/api/admin/logs/clear', handleClearLogs);

  /* ---------------------------------------------------------------------- *
   * 12. Headroom sidecar lifecycle (probe → adopt, else detached-spawn).
   * The gateway only ever kills a sidecar pid it recorded itself
   * (<home>/headroom.pid); a manually started instance is adopted for
   * compression but refused on stop with an honest message. Endpoints sit
   * under /api/admin/* (auth preHandler surface) like every admin route.
   * ---------------------------------------------------------------------- */
  const headroomSidecarCfg = () => (getRuntimeConfigRef() || loadConfig()).compression?.headroom;

  app.get('/api/admin/headroom/sidecar', async () => {
    return getHeadroomSidecarStatus({ url: headroomSidecarCfg()?.url });
  });

  app.post('/api/admin/headroom/sidecar/start', async () => {
    const hr = headroomSidecarCfg();
    if (!hr?.enabled) {
      return { status: 'error', ok: false, reused: false, pid: null, version: null, code: 'disabled', error: 'compression.headroom.enabled is false — enable headroom compression first' };
    }
    const r = await startHeadroomSidecar({ url: hr.url });
    return { status: r.ok ? 'ok' : 'error', ...r };
  });

  app.post('/api/admin/headroom/sidecar/stop', async () => {
    const r = await stopHeadroomSidecar({ url: headroomSidecarCfg()?.url });
    return { status: r.ok ? 'ok' : 'error', ...r };
  });

  /* ---------------------------------------------------------------------- *
   * 12b. Request-capture archive browser (CaptureRecorder; opt-in audit log)
   * Bodies may contain sensitive data — these endpoints sit under /api/admin/*
   * which the auth preHandler whitelists, exactly like /api/admin/logs.
   * ---------------------------------------------------------------------- */
  const captureRecorder = orchestrator.getCaptureRecorder();
  const CAPTURE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const handleCaptureStatus = async () => captureRecorder.getStatus();
  app.get('/api/admin/capture/status', handleCaptureStatus);

  const handleCaptureDates = async () => ({ status: 'ok', dates: captureRecorder.listDates() });
  app.get('/api/admin/capture/dates', handleCaptureDates);

  // Locate a session's archive(s) across all dates by raw session id.
  // Query param (not path segment) — client-supplied ids may contain "/", '"'
  // or even be whole JSON blobs; encodeURIComponent round-trips them safely.
  app.get('/api/admin/capture/find-session', async (req: any, reply: any) => {
    const id = String((req.query as any)?.id || '').trim();
    if (!id) {
      return reply.status(400).send({ status: 'error', message: 'query param "id" (session id) is required' });
    }
    return { status: 'ok', matches: captureRecorder.findBySession(id) };
  });

  app.get('/api/admin/capture/:date/sessions', async (req: any, reply: any) => {
    const { date } = req.params as { date: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    // Optional per-application retrieval: `?apiKey=<id or name>` keeps only
    // sessions whose events carry that client API-key identity (exact id
    // match, case-insensitive substring on name — see listSessions).
    // Duplicated params (?apiKey=a&apiKey=b) parse to an array — take the
    // first value rather than silently dropping the filter.
    const rawApiKey = (req.query as any)?.apiKey;
    const apiKey = typeof rawApiKey === 'string'
      ? rawApiKey
      : Array.isArray(rawApiKey) && typeof rawApiKey[0] === 'string'
        ? rawApiKey[0]
        : '';
    // listSessionsWithSpans adds `spanDates` (newest-first, >1 only) — the
    // console's cross-midnight continuation badge data.
    return { status: 'ok', date, sessions: captureRecorder.listSessionsWithSpans(date, apiKey.trim() || undefined) };
  });

  app.get('/api/admin/capture/:date/:file', async (req: any, reply: any) => {
    const { date, file } = req.params as { date: string; file: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    // Raw export: verbatim JSONL download, no record parsing/cap.
    // `exclude` (comma-separated, whitelisted body fields) strips those fields
    // per turn — metadata (ts/status/model/routing/usage) always survives.
    if ((req.query as any)?.format === 'raw') {
      // The set of body fields the export endpoint accepts for strip. Wider
      // than the legacy turn schema (upstreamResponse / inboundHttp / etc.)
      // — covers everything the new HTTP exchange event stream writes too.
      const RAW_EXCLUDE_FIELDS = new Set([
        'request',
        'upstreamRequest',
        'upstreamResponse',
        'upstreamHttp',
        'inboundHttp',
        'outboundHttp',
        'response',
        'upstreamError',
      ]);
      const exclude = String((req.query as any)?.exclude || '')
        .split(',')
        .map(f => f.trim())
        .filter(f => RAW_EXCLUDE_FIELDS.has(f));
      const content = captureRecorder.readRawArchive(date, file, exclude.length ? exclude : undefined);
      if (content === null) {
        return reply.status(404).send({ status: 'error', message: 'Capture archive not found' });
      }
      reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="capture-${date}-${file}"`);
      return reply.send(content);
    }
    const limit = Math.min(Math.max(parseInt((req.query as any)?.limit || '200', 10) || 200, 1), 2000);
    const result = captureRecorder.readRecords(date, file, limit);
    if (result.totalLines === 0 && !captureRecorder.listSessions(date).some(s => s.file === file)) {
      return reply.status(404).send({ status: 'error', message: 'Capture archive not found' });
    }
    return { status: 'ok', date, file, ...result };
  });

  /**
   * Read the HTTP exchange events written by the capture pipeline.
   * Each inference turn produces 2-4 events sharing the same `requestId`:
   * client-request, gateway-response, upstream-request, upstream-response.
   * The console joins them into one logical turn via `requestId`.
   */
  app.get('/api/admin/capture/:date/:file/events', async (req: any, reply: any) => {
    const { date, file } = req.params as { date: string; file: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    // `limit` is TURNS per page (2-4 wire events travel with their turn), so
    // the pager's summary counts the same unit the header does. 50 turns is
    // the console default.
    const limit = Math.min(Math.max(parseInt((req.query as any)?.limit || '50', 10) || 50, 1), 500);
    // Metadata-first console reads: bodies=none strips the wire bodies (KB
    // payload, instant paint); full bodies come back per turn via /turn or a
    // bodies=full re-read. bodies=chat keeps round-opener request bodies +
    // response bodies only — the conversation replay's bounded footprint.
    const bodiesParam = (req.query as any)?.bodies;
    const bodies = bodiesParam === 'none' ? 'none' : bodiesParam === 'chat' ? 'chat' : 'full';
    // stitched=1: merge the session's fragments from every date dir (a
    // conversation that crossed midnight — or whose session id churned) into
    // one chronological timeline. Response carries the per-fragment breakdown.
    const stitched = (req.query as any)?.stitched === '1';
    // page=1 is the NEWEST window page; older pages count up from there.
    // Pages are TURN pages (a page never splits a turn's events), bounded by
    // the read window — history older than the window is export-only.
    const page = Math.min(Math.max(parseInt((req.query as any)?.page || '1', 10) || 1, 1), 100000);
    const result = stitched
      ? await captureRecorder.readEventsStitched(date, file, limit, bodies, page)
      : await captureRecorder.readEvents(date, file, limit, bodies, page);
    if (result.totalLines === 0 && !captureRecorder.listSessions(date).some(s => s.file === file)) {
      return reply.status(404).send({ status: 'error', message: 'Capture archive not found' });
    }
    return { status: 'ok', date, file, ...result };
  });

  /**
   * EXACT whole-archive summary: request count (header denominator / pager
   * total) and the USER-PROMPT ROUND INDEX (prompt + request range) for the
   * round selector. The events window only knows the tail; this metadata scan
   * is streamed and never parses request bodies.
   * Display-only: pagination still follows a bounded read window.
   */
  app.get('/api/admin/capture/:date/:file/summary', async (req: any) => {
    const { date, file } = req.params as { date: string; file: string };
    const stitched = (req.query as any)?.stitched === '1';
    const summary = stitched
      ? await captureRecorder.captureSummaryStitched(date, file)
      : await captureRecorder.captureSummary(date, file);
    return { status: 'ok', date, file, ...summary };
  });

  /**
   * Full wire bodies for ONE turn (the console passes the client-request
   * event id). The metadata-first events read strips bodies; the drawer
   * fetches them here when a turn is opened. Bounded by the same read
   * window as /events — a turn archived beyond the window answers 404.
   */
  app.get('/api/admin/capture/:date/:file/turn', async (req: any, reply: any) => {
    const { date, file } = req.params as { date: string; file: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    const id = (req.query as any)?.id;
    if (typeof id !== 'string' || !id || id.length > 128) {
      return reply.status(400).send({ status: 'error', message: 'id query param required' });
    }
    // stitched=1: also search the session's other date-dir fragments — a
    // cross-midnight turn's bodies live in the shard its events landed in.
    const stitched = (req.query as any)?.stitched === '1';
    const result = stitched
      ? await captureRecorder.readTurnStitched(date, file, id)
      : await captureRecorder.readTurn(date, file, id);
    if (!result) {
      return reply.status(404).send({ status: 'error', message: 'Turn not found in read window' });
    }
    return { status: 'ok', date, file, ...result };
  });

  /**
   * Serve one offloaded media file (base64 payload scrubbed out of a request
   * body at capture time). Content-addressed: the URL is just the sha256
   * prefix + date dir, so responses are immutable and cacheable. Strict
   * regexes on both params keep the read inside <rootDir>/<date>/media/.
   * Auth-exempt like the rest of /api/admin/capture (see section header).
   */
  app.get('/api/admin/capture/:date/media/:hash', async (req: any, reply: any) => {
    const { date, hash } = req.params as { date: string; hash: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    if (!/^[0-9a-f]{16,64}$/.test(hash)) {
      return reply.status(400).send({ status: 'error', message: 'hash must be 16-64 lowercase hex chars' });
    }
    const media = captureRecorder.getMediaFile(date, hash);
    if (!media) {
      return reply.status(404).send({ status: 'error', message: 'Capture media file not found' });
    }
    reply.header('Content-Type', media.contentType);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(media.data);
  });

  app.delete('/api/admin/capture/:date/:file', async (req: any, reply: any) => {
    const { date, file } = req.params as { date: string; file: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    const deleted = captureRecorder.deleteSession(date, file);
    if (!deleted) {
      return reply.status(404).send({ status: 'error', message: `Capture session ${file} not found in ${date}` });
    }
    return { status: 'ok', message: `Capture session ${date}/${file} deleted` };
  });

  app.delete('/api/admin/capture/:date', async (req: any, reply: any) => {
    const { date } = req.params as { date: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    const deleted = captureRecorder.deleteDate(date);
    if (!deleted) {
      return reply.status(404).send({ status: 'error', message: `No capture archive for ${date}` });
    }
    return { status: 'ok', message: `Capture archive ${date} deleted` };
  });

  /* ---------------------------------------------------------------------- *
   * One-shot upstream-request replay (capture drawer debug button).
   * Re-sends a captured upstream request verbatim — NO pipeline, NO session
   * machinery, NO capture recording: the fetch here is a bare console-side
   * HTTP call, invisible to the observation ledgers. Debugging aid only.
   * ---------------------------------------------------------------------- */
  app.post('/api/admin/capture/replay', async (req: any, reply: any) => {
    const { url, method, headers, body, provider, model } = (req.body || {}) as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      provider?: string;
      model?: string;
    };
    if (!url || !/^https?:\/\//i.test(url)) {
      return reply.status(400).send({ status: 'error', message: 'an absolute http(s) "url" is required' });
    }
    if (!method || !/^[A-Z]+$/.test(method)) {
      return reply.status(400).send({ status: 'error', message: '"method" must be an upper-case HTTP verb' });
    }
    if (body !== undefined && typeof body !== 'string') {
      return reply.status(400).send({ status: 'error', message: '"body" must be a UTF-8 string (hex/binary bodies are not replayable)' });
    }
    // Hop-by-hop / recomputed-by-fetch headers: replaying them verbatim
    // corrupts the request (stale length, wrong authority).
    const SKIP_HEADERS: Record<string, true> = {
      host: true,
      'content-length': true,
      connection: true,
      'transfer-encoding': true,
    };
    const outHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (!SKIP_HEADERS[name.toLowerCase()] && typeof value === 'string') outHeaders[name] = value;
    }
    // Stream the result as NDJSON so the console can render the body
    // incrementally (SSE replays become live): one JSON event per line —
    // status (status line + headers), chunk (body piece), end (terminal cap
    // flag), error (transport failure). The call is console-side only —
    // nothing is recorded anywhere.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const send = (evt: Record<string, unknown>) => raw.write(`${JSON.stringify(evt)}\n`);
    try {
      // Honor the outbound proxy policy for fidelity with the original call;
      // provider/model are the policy's glob keys (absent → direct).
      const res = await proxiedFetch(
        url,
        {
          method,
          headers: outHeaders,
          body: body || undefined,
          signal: AbortSignal.timeout(DEFAULT_REPLAY_TIMEOUT_MS),
        },
        { provider, model }
      );
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        resHeaders[key] = value;
      });
      send({ type: 'status', statusLine: `HTTP/1.1 ${res.status} ${res.statusText}`.trimEnd(), headers: resHeaders });
      // Cap the streamed echo — the replay result is console UI text, not an
      // archive record; huge streams surface their head then get cancelled.
      const REPLAY_BODY_CAP = 512 * 1024;
      const reader = res.body?.getReader();
      let total = 0;
      let truncated = false;
      if (reader) {
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total >= REPLAY_BODY_CAP) {
            truncated = true;
            send({ type: 'chunk', text: dec.decode(value.subarray(0, value.byteLength - (total - REPLAY_BODY_CAP))) });
            break;
          }
          send({ type: 'chunk', text: dec.decode(value, { stream: true }) });
        }
        await reader.cancel().catch(() => undefined);
      }
      send({ type: 'end', truncated });
      raw.end();
    } catch (err: any) {
      // Hijacked reply: transport errors must flow through the stream too.
      const cause = err?.cause?.code || err?.code;
      raw.write(`${JSON.stringify({ type: 'error', message: cause ? `${err.message} (${cause})` : String(err?.message || err) })}\n`);
      raw.end();
    }
  });

  /* ---------------------------------------------------------------------- *
   * Session observation maintenance (console /sessions page cleanup).
   * Console pages cannot present API keys, so destructive session ops live
   * under /api/admin — same trust surface as the capture-archive deletes
    * above. (DELETE /api/admin/sessions/:id is registered in server.ts together
    * with the rest of the sessions* surface.)
   * ---------------------------------------------------------------------- */

  // Clear ALL sessions: live routing state (pin / ratchet) plus every trace
  // in memory and the durable store.
  app.post('/api/admin/sessions/clear', async () => {
    const sessionMgr = orchestrator.getSessionManager();
    const sessionsCleared = sessionMgr?.getAllSessions().length ?? 0;
    sessionMgr?.clear();
    const { traces } = orchestrator.getTraceTracker().clearAll();
    return {
      status: 'ok',
      sessionsCleared,
      tracesCleared: traces,
      message: `Cleared ${sessionsCleared} session(s) and ${traces} trace(s)`,
    };
  });

}

