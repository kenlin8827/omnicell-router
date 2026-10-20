import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { getAllClientStatuses, refreshClientProfileBindings, setupClient, teardownClient } from '../cli/clients/index.js';
import { ProviderRegistry } from '../providers/registry.js';
import { matchingTiers, MEMBER_TIER_ORDER } from '../providers/member-match.js';
import { globMatchAny } from '../utils/glob.js';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { getRawConfig, loadConfig, saveConfig, saveRawConfig, getRuntimeConfigRef } from '../config/index.js';
import { getEnvPaths, resolveEnvName } from '../config/env.js';
import { applyConfig as applyDecisionCaptureConfig } from '../flywheel/decision-capture.js';
import { initProxyConfig } from '../utils/proxy.js';
import { getOcrHomeDir } from '../cli/paths.js';
import { getHeadroomSidecarStatus, startHeadroomSidecar, stopHeadroomSidecar } from '../compression/headroom-sidecar.js';
import { APP_VERSION } from '../version.js';
import { keyHashPrefix } from '../opencode/credentials/types.js';
import { isSyncClientId } from '../opencode/credentials/sync.js';
import { ensureCa } from '../forward-proxy/ca.js';
import { getForwardProxyStatus } from '../forward-proxy/status.js';
import { RouterConfig, type CredentialLimitConfig, type RateLimitRule } from '../config/types.js';
import type { CatalogModel } from '../opencode/catalog/types.js';
import type { CredentialMeta, CredentialStore, RawCred } from '../opencode/credentials/types.js';
import type { CircuitBreakerManager } from '../resilience/index.js';
import type { TraceTracker } from '../trace/tracker.js';
import type { OpenCodeProviderView } from '../opencode/user-config.js';
import { listOpenCodeAgentsLive } from '../opencode/agents.js';
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  validateApiKey,
  validateModelAccess,
} from '../auth/api-keys.js';
import { getModelAccessPolicy, isAutoEntryUsable, isModelAllowed, tierFromVirtualEntry } from '../auth/model-access.js';
import { validateRateLimitRules, getRateLimiter, credentialSubject } from '../ratelimit/rate-limiter.js';
import { getQuotaProber } from '../quota/prober.js';
import { getQuotaStore } from '../quota/store.js';
import { getQuotaEventLog } from '../quota/events.js';
import type { QuotaBadgeState, QuotaSnapshot, QuotaSource, QuotaWindow } from '../quota/types.js';
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

/** CatalogModel → opencode model definition (moved to opencode/catalog/auto-pull.ts). */

/** opencode v2 def → CatalogModel (custom-store mirror of the editor form payload). */
function defToCatalogModel(id: string, def: Record<string, any>): CatalogModel {
  const caps = def.capabilities && typeof def.capabilities === 'object' ? def.capabilities : {};
  const modalities =
    def.modalities && typeof def.modalities === 'object'
      ? def.modalities
      : caps.input || caps.output
        ? { input: caps.input, output: caps.output }
        : undefined;
  return {
    id,
    name: def.name || undefined,
    reasoning: def.reasoning === true || caps.reasoning === true || undefined,
    tool_call: def.tool_call === true || (typeof caps.tools === 'boolean' ? caps.tools : undefined),
    modalities,
    cost: def.cost && typeof def.cost === 'object' ? def.cost : undefined,
    limit: def.limit && typeof def.limit === 'object' ? def.limit : undefined,
    source: 'custom',
  };
}

/** CatalogModel → opencode v2-ish def (management view for credential-only providers). */
function catalogModelToV2Def(m: CatalogModel): Record<string, any> {
  const def: Record<string, any> = {};
  if (m.name) def.name = m.name;
  if (m.reasoning != null) def.reasoning = m.reasoning;
  const caps: Record<string, any> = {};
  if (m.tool_call != null) caps.tools = m.tool_call;
  if (m.modalities?.input?.length) caps.input = m.modalities.input;
  if (m.modalities?.output?.length) caps.output = m.modalities.output;
  if (Object.keys(caps).length > 0) def.capabilities = caps;
  if (m.cost) def.cost = m.cost;
  if (m.limit) def.limit = m.limit;
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
  cb: CircuitBreakerManager
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
   * action (the row's own set-as-chain-head button). A prior head that is SUSPECT or
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
  /** Entry that produced (or would produce) this — built-in id,
   *  `adapter:<id>`, or config `override:<id>` / `<pid>#<n>`. */
  entryId?: string;
  /** Effective cache window (ms) — the UI can render freshness honestly. */
  ttlMs?: number;
}

/** Compute the overlay for one pair, joining the live plan (coverage/TTL)
 *  with the store (snapshot). Undefined = provider not covered. */
function quotaViewFor(providerId: string, keyHashPrefix?: string): CredentialQuotaView | undefined {
  if (!keyHashPrefix) return undefined;
  const prober = getQuotaProber();
  // ttlMs is defined exactly when the LIVE plan covers the provider.
  const ttlMs = prober?.getTtlFor(providerId);
  const store = getQuotaStore();
  const snap = store.get(providerId, keyHashPrefix);
  // Uncovered rows carry no quota key at all. With the prober OFF
  // (quota.enabled:false) nothing can ever become `unverified` — the honest
  // surface is then ONLY what a previous lifetime left on disk (entryId in
  // the tooltip names its origin), never a badge promising a future probe.
  if (ttlMs === undefined && !snap) return undefined;
  const ttl = ttlMs ?? 15 * 60_000;
  if (!snap) {
    // Covered but nothing probed yet (or every attempt failed with no prior
    // value): the honest state is `unverified`, not `stale`.
    return { badge: 'unverified', windows: [], ttlMs: ttl };
  }
  const badge = store.badgeState(providerId, keyHashPrefix, ttl);
  return {
    badge,
    source: snap.source,
    plan: snap.plan,
    windows: snap.windows,
    verifiedAt: snap.verifiedAt,
    lastFailureAt: snap.lastFailureAt,
    entryId: snap.entryId,
    ttlMs: ttl,
  };
}

/**
 * One row of the QUOTA PAGE directory (GET /api/admin/quota.pairs): every
 * CONNECTED pair — the same enumeration the status surface's credentialHashes
 * uses (store chains + config-baked inference keys, display-safe prefixes
 * only) — joined with its quota view and its per-pair trace usage. This is
 * the "all connected pairs, each with its quota" cross-provider surface;
 * KeysPage keeps the per-credential inline badge, this page owns the overview.
 */
interface QuotaPairRow {
  providerId: string;
  keyHashPrefix: string;
  /** Chain label (credential name) or the config provider name for baked keys. */
  label?: string;
  /** Live-plan coverage (built-in table / adapter / config entry). */
  covered: boolean;
  quota?: CredentialQuotaView;
  /** Attributed usage from the trace ring (undefined = nothing attributed
   *  yet — turns recorded before the attribution field, or chain-less). */
  usage?: { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number };
}

function buildQuotaPairRows(
  registry: ProviderRegistry,
  cfg: RouterConfig,
  traceTracker: TraceTracker
): QuotaPairRow[] {
  const pairs = new Map<string, QuotaPairRow>();
  const add = (providerId: string, keyHashPrefix: string, label?: string) => {
    const id = `${providerId}#${keyHashPrefix}`;
    if (pairs.has(id)) return;
    pairs.set(id, {
      providerId,
      keyHashPrefix,
      label,
      covered: getQuotaProber()?.getPlan().byProvider.has(providerId) ?? false,
      quota: quotaViewFor(providerId, keyHashPrefix),
    });
  };
  for (const p of cfg.providers || []) {
    if (p.apiKey) add(p.name, keyHashPrefix(p.apiKey), p.name);
  }
  for (const m of registry.getAllModels()) {
    for (const c of registry.getCredentialChain(m.provider) ?? []) add(m.provider, c.keyHashPrefix, c.label);
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

/** Capability-gate refusal (Decision 1: branch on flags, never on `kind` — the
 *  ocr store passes with activate/rename=true; OpencodeV2Store-readonly refuses). */
function capabilityRefusalBody(capability: 'activate' | 'rename'): Record<string, unknown> {
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
async function storeProviderViews(store: CredentialStore): Promise<OpenCodeProviderView[]> {
  const { listConfigProviders } = await import('../opencode/user-config.js');
  const views = listConfigProviders();
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
        custom: false, // credential-only provider (store-connected, no defs-file node)
        auth: { connected: true, ...badge, ...(shown?.maskedKey ? { keyMasked: shown.maskedKey } : {}) },
      });
    }
  }
  return [...byId.values()].sort((a, b) => {
    // DETERMINISTIC grid order. `store.credentialsOverview()` yields credential-table
    // order (`active DESC, time_updated DESC`), so appending store-only providers
    // in that order makes a provider JUMP to the front of the grid every time a
    // key is added to it. Config-defined providers keep their author-defined
    // defs-file sequence; credential-only providers follow, alphabetically.
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

/** Machine-readable precondition failures of the credential-sync paths. */
const SYNC_PRECONDITION_ERROR: Record<'client_absent' | 'client_unreadable' | 'service_unreachable', string> = {
  client_absent: 'this sync client is not present on this machine (no usable credential file/db for it)',
  client_unreadable: 'the client credential file/db is unreadable — sync unavailable',
  service_unreachable: 'opencode v2 service not reachable now (no service.json/OPENCODE_SERVER_PASSWORD) — retry after starting opencode',
};

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
        <head><title>OneCastRouter Gateway Console</title></head>
        <body style="background:#09090b;color:#f4f4f5;font-family:sans-serif;padding:40px;text-align:center;">
          <h2>⚡ OneCastRouter Gateway Console</h2>
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
    };
    const metrics = orchestrator.getTracker().getStats();
    const clients = await getAllClientStatuses();
    const config = loadConfig();

    const maskedProviders = (config.providers || []).map((p) => ({
      ...p,
      apiKey: p.apiKey ? `${p.apiKey.slice(0, 4)}••••${p.apiKey.slice(-4)}` : '',
      rawKeyConfigured: Boolean(p.apiKey),
    }));

    // Runtime credential directory (hash prefixes ONLY — the same display-safe
    // form pair snapshots already carry): lets the guardrails view name an
    // orphan breaker's owner (e.g. the inline config-baked chain head, which
    // lives outside the store roster) instead of a bare #hash.
    const credentialHashes: { provider: string; keyHashPrefix: string }[] = [];
    const seenHashes = new Set<string>();
    const pushHash = (provider: string, keyHashPrefix: string) => {
      const id = `${provider}#${keyHashPrefix}`;
      if (seenHashes.has(id)) return;
      seenHashes.add(id);
      credentialHashes.push({ provider, keyHashPrefix });
    };
    for (const p of config.providers || []) {
      if (p.apiKey) pushHash(p.name, keyHashPrefix(p.apiKey));
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
      providers: maskedProviders,
      credentialHashes,
      registeredModelsCount: registry.getAllModels().length,
      // Inbound forward-proxy runtime status (see forward-proxy/status.ts) —
      // the Proxy Access page polls this to show running / failed / pending.
      forwardProxy: {
        enabled: Boolean(config.forwardProxy?.enabled),
        ...getForwardProxyStatus(),
      },
    };
  };

  app.get('/api/admin/status', handleStatus);

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
      pairs: buildQuotaPairRows(registry, getRuntimeConfigRef() || loadConfig(), orchestrator.getTraceTracker()),
      events: getQuotaEventLog().list().slice(0, 100),
    };
  });

  // Force a pair due on the next tick (console "reprobe now"). Body carries
  // the display-safe identity only; nothing is fetched synchronously here —
  // probing stays on the scheduler (with its engine-level 429 backoff).
  app.post('/api/admin/quota/refresh', async (req) => {
    const body = req.body as { providerId?: string; keyHashPrefix?: string };
    const prober = getQuotaProber();
    if (!prober) return { status: 'ok', success: false, reasonCode: 'quota_disabled', error: 'quota prober is disabled' };
    if (body?.providerId && body.keyHashPrefix) prober.invalidatePair(body.providerId, body.keyHashPrefix);
    else prober.resetScheduling();
    return { status: 'ok', success: true };
  });

  // Last raw HTTP exchange for one pair (memory-only capture — the quota
  // endpoint's own response, display-safe: url/status/body, never headers;
  // starts empty after a restart by design).
  app.get('/api/admin/quota/last-probe', async (req) => {
    const { providerId, keyHashPrefix } = req.query as { providerId?: string; keyHashPrefix?: string };
    if (!providerId || !keyHashPrefix) return { status: 'ok', http: null };
    return { status: 'ok', http: getQuotaStore().getLastHttp(`${providerId}#${keyHashPrefix}`) ?? null };
  });

  // 4. Client Interception Setup / Teardown
  const handleSetup = async (req: any, reply: any) => {
    const { client } = req.params as { client: string };
    const { models, apiKey, contextWindow, extraModels, agentModels, profile } = (req.body || {}) as {
      models?: Record<string, string>;
      apiKey?: string;
      contextWindow?: number;
      extraModels?: string[];
      agentModels?: Record<string, string>;
      profile?: { id?: string; bindings?: Record<string, string> };
    };
    const cleaned = models && typeof models === 'object'
      ? Object.fromEntries(Object.entries(models).map(([k, v]) => [k, String(v ?? 'auto').trim() || 'auto']))
      : undefined;
    const cleanedExtra = Array.isArray(extraModels)
      ? extraModels.map(s => String(s || '').trim()).filter(Boolean)
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
      'auto', 'auto-lite', 'auto-plus', 'auto-pro', 'auto-ultra',
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

  // 4a. OpenCode agent inventory (model-profile binding UI): live v2 service
  //     roster (`GET /api/agent`, plugins included) with the file scan
  //     (built-ins + agent(s)/*.md + config nodes) as offline fallback.
  app.get('/api/admin/opencode/agents', async () => ({ status: 'ok', agents: await listOpenCodeAgentsLive() }));

  // 4b. Console webAuth — login/logout/session probes + credential management.
  // login/logout/session stay reachable pre-login (server.ts gate whitelist);
  // the two config endpoints ride the normal console gate (session cookie or
  // master adminApiKey Bearer).
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
    orchestrator.getRegistry().applyCombos(loadConfig().combos);
    orchestrator.getRegistry().applyTierConfigNow(); // tier member lists commit immediately (no restart)
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
  app.get('/api/admin/config/raw', async () => ({ status: 'ok', yaml: getRawConfig() }));

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
    orchestrator.getRegistry().applyCombos(loadConfig().combos); // hot-apply combos too
    orchestrator.getRegistry().applyTierConfigNow(); // hot-commit tier member lists too
    warnOnEmptyTierPools(); // no residual tier → an empty pool is now possible
    orchestrator
      .getRegistry()
      .getCircuitBreakerManager()
      .applyConfig(loadConfig().circuitBreaker, loadConfig().retry); // hot-apply breaker rules too (see handleSaveConfig)
    // Profile-link write-through on the raw path too (same diff guard).
    const profileNote = await refreshClientProfileBindings(loadConfig().modelProfiles || []);
    if (profileNote) return { ...result, message: `Saved. ${profileNote.trim().replace(/^; /, '')}` };
    return result;
  };
  app.post('/api/admin/config/raw', handleSaveRawYaml);

  // 6a. Forward-proxy MITM CA export — clients using the inbound forward
  // proxy must trust this CA. Generated on first request when absent (the
  // same idempotent ensureCa the proxy itself uses).
  const handleForwardProxyCa = async (_req: any, reply: any) => {
    const cfg = loadConfig();
    const caDir = cfg.forwardProxy?.caDir?.trim() || path.join(getOcrHomeDir(), 'forward-proxy');
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
        // Decision 6 aggregate: healthy iff the model breaker is up AND at least one
        // a credential pair serves — a model whose every credential is cooling shows
        // down here exactly as it does to the pool builders.
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
          // Decision 6 aggregate: healthy iff the model breaker is up AND at least one
          // a credential pair serves — a model whose every credential is cooling shows
          // down here exactly as it does to the pool builders.
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
  //   overlap   — a model claimable by 2+ tiers (runtime resolves by tier order)
  //   orphan    — a rule matching no registered model (rename / typo / removed)
  //   deadCombo — a combo:<id> ref contributing nothing (unknown / disabled /
  //               shadowed / zero registered members)
  const handleTiersCheck = async (req: any) => {
    const body = req.body as { tiers?: unknown };
    const tiers = (body?.tiers ?? loadConfig().tiers ?? {}) as any;
    const expanded = registry.expandedMemberRules(tiers);
    const members = expanded.tiers;
    const modelIds = registry
      .getAllModels()
      .filter((m) => m.tierMatch)
      .map((m) => m.id);
    const overlapGroups = new Map<string, { tiers: string[]; count: number; sampleIds: string[] }>();
    for (const id of modelIds) {
      const hits = matchingTiers(id, members);
      if (hits.length < 2) continue;
      const key = hits.join('|');
      const g = overlapGroups.get(key) ?? { tiers: hits, count: 0, sampleIds: [] };
      g.count++;
      if (g.sampleIds.length < 5) g.sampleIds.push(id);
      overlapGroups.set(key, g);
    }
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
        ...[...overlapGroups.values()].map((g) => ({
          kind: 'overlap' as const,
          tiers: g.tiers,
          count: g.count,
          sampleIds: g.sampleIds,
        })),
        ...orphans.map((o) => ({ kind: 'orphan' as const, tier: o.tier, pattern: o.pattern })),
        ...expanded.dead.map((d) => ({ kind: 'deadCombo' as const, tier: d.tier, pattern: d.ref })),
      ],
    };
  };
  app.post('/api/admin/tiers/check', handleTiersCheck);

  // End-to-end tier test — one REAL minimal completion pinned to the tier via
  // the `auto-<tier>` virtual entry: the same force_tier path a client's
  // `model: "auto-pro"` request takes (a BARE tier name is not addressable on
  // the chat wire — the orchestrator would classifier-route it). One run only
  // exercises the SELECTED member (the chain head, or the weighted/round-robin
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
          model: `auto-${tier}`,
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
    app.post(`${prefix}/catalog/sources`, handleAddCatalogSource);
    app.post(`${prefix}/catalog/sources/refresh`, handleRefreshCatalogSources);
    app.post(`${prefix}/catalog/sources/:id/refresh`, handleRefreshCatalogSource);
    app.put(`${prefix}/catalog/sources/:id`, handleToggleCatalogSource);
    app.delete(`${prefix}/catalog/sources/:id`, handleRemoveCatalogSource);
    app.get(`${prefix}/catalog/sources/:id/data`, getCatalogSourceData);
    app.get(`${prefix}/catalog/locked-models`, listLockedCatalogModels);
    app.post(`${prefix}/catalog/locked-models`, handleLockCatalogModel);
    app.get(`${prefix}/catalog/ocr`, getCatalogOcr);
    app.get(`${prefix}/catalog/override`, handleGetCatalogOverride);
    app.put(`${prefix}/catalog/override`, handlePutCatalogOverride);
    app.delete(`${prefix}/catalog/override`, handleDeleteCatalogOverride);
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
          breakerState: model ? cb.getBreaker(model.id)?.getState() ?? 'CLOSED' : undefined,
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
  //     - Definitions live in <ocrHome>/custom-providers.json (provider-defs.ts)
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
    list: async () => {
      const { getProviderNodeById } = await import('../opencode/user-config.js');
      const { getProviderDefsPath } = await import('../opencode/provider-defs.js');
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const { getCustomProviderModels } = await import('../opencode/catalog/custom-store.js');
      const store = await getCredentialStore();
      // B4: credentials come from the BOUND store on every binding — the masked store
      // credentials merge into the config views, so a stale auth.json entry can never
      // masquerade as a connected provider.
      const views = await storeProviderViews(store);
      const unified = await catalogRepository.list();
      const byId = new Map(unified.map((p) => [p.id, p]));
      return {
        status: 'ok',
        configPath: getProviderDefsPath(),
        catalogSync: catalogRepository.lastSyncOrigin,
        providers: views.map((v) => {
          const u = byId.get(v.id);
          const hasDefNode = getProviderNodeById(v.id) !== undefined;
          return {
            ...v,
            // Precise delete-branch signal: an explicit defs-file node is the
            // ONLY case where DELETE removes a definition — credential-only rows
            // (catalog connects, private relays) purge credentials alone. The
            // `custom` flag is broader (catalog coverage counts) and must not
            // drive the delete confirm wording.
            defNode: hasDefNode,
            // Runtime capability for console editing — the SAME rule modelsGet
            // applies when serving a manage view (defs node OR pulled
            // custom-store models). The catalog-relative `custom` flag must not
            // gate editing: third-party sources drift and would flip the gate
            // without any local change.
            modelsManageable: hasDefNode || getCustomProviderModels(v.id).length > 0,
            // upgraded custom: an explicit defs-file definition OR not covered by
            // the remote catalog (credential-only zhipu, private relays, …)
            custom: u?.custom ?? v.custom,
            logo: u?.logo,
            // auth-only providers have no config baseURL — fall back to the
            // catalog's effective base (config override → live service hint)
            baseURL: v.baseURL || u?.baseURL,
            priceFrom: u ? catalogRepository.minInputPrice(u) : undefined,
            modelsCount: u?.models.length ?? v.models.length,
          };
        }),
      };
    },

    catalog: async () => {
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
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
        sources: p.sources,
        modelCount: p.models.length,
        priceFrom: catalogRepository.minInputPrice(p),
      }));
      return { status: 'ok', source: catalogRepository.lastSyncOrigin, providers };
    },

    /** Flat model catalog across providers (supports ?provider= & ?connected=1). */
    models: async (req: any) => {
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const query = req.query as { provider?: string; connected?: string };
      const providerFilter = query.provider?.trim().toLowerCase();
      const connectedOnly = query.connected === '1' || query.connected === 'true';
      const unified = await catalogRepository.list();
      const models = unified
        .filter(
          (p) =>
            (!providerFilter || p.id.toLowerCase() === providerFilter) &&
            (!connectedOnly || p.connected)
        )
        .flatMap((p) =>
          p.models.map((m) => ({
            ...m,
            providerId: p.id,
            providerName: p.name,
            logo: p.logo,
            custom: p.custom,
            connected: p.connected,
          }))
        );
      return { status: 'ok', source: catalogRepository.lastSyncOrigin, total: models.length, models };
    },

    create: async (req: any, reply: any) => {
      const body = req.body as any;
      if (!body?.id) {
        return reply.status(400).send({ success: false, error: 'Provider id is required' });
      }
      const id = String(body.id);
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
      const { upsertCustomProvider, getProviderNodeById } = await import('../opencode/user-config.js');
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      // Captured BEFORE the def write — decides whether a failed key push may roll
      // the node back (only a node this request created).
      const existedBefore = getProviderNodeById(id) !== undefined;
      // A non-inline key is NEVER written into a file by
      // the def helper — it goes to the bound store, and upsertCustomProvider is fed no
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
      const result = upsertCustomProvider({
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
      // The def can register an integration upstream — never answer from the stale
      // registry snapshot (a false refusal would grey the button for up to the TTL).
      store.invalidate();

      let keyMeta: CredentialMeta | undefined;
      if (keyToStore) {
        try {
          keyMeta = (await connectKeyIdempotent(store, id, String(body.apiKey), undefined, registry.getCircuitBreakerManager())).credential;
        } catch (err) {
          // Roll back only a node THIS request created — with ONE exception: the
          // unmatched refusal now fires only AFTER the store's reload attempt, so
          // it means upstream cannot host this id at all (e.g. a service build
          // without POST /api/location/reload). The def is the prerequisite for
          // the retry after a restart; deleting it would make the operator
          // re-type the whole definition. Existing defs are never touched.
          const m = await import('../opencode/credentials/index.js');
          if (!existedBefore && !(err instanceof m.IntegrationUnmatchedError)) {
            const { deleteCustomProvider } = await import('../opencode/user-config.js');
            deleteCustomProvider(id);
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
      // console shows models on the next refresh. Skipped when the caller brought
      // explicit models (their list wins).
      if (!body.models) {
        import('../opencode/catalog/auto-pull.js')
          .then(({ autoPullProvider }) => autoPullProvider(id))
          .then((pull) => {
            if (pull.httpStatus !== 200) app.log.warn({ providerId: id, pull }, 'post-create model pull refused (swallowed by design)');
          })
          .catch((err) => app.log.warn({ err, providerId: id }, 'post-create model pull errored (swallowed by design)'));
      }
      return { status: 'ok', ...result };
    },

    update: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const { upsertCustomProvider, getProviderNodeById } = await import('../opencode/user-config.js');
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const existing = getProviderNodeById(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' not found in the provider defs file` });
      }
      // B4: same implicit auth.json side-write as create (apiKey + !inline) —
      // routed to the bound store when auth.json is not the sink (Decision 4).
      const store = await getCredentialStore();
      const inline = body.apiKeyInline ?? Boolean(existing.options?.apiKey);
      const keyToStore = Boolean(body?.apiKey) && !inline;
      let keyMeta: CredentialMeta | undefined;
      if (keyToStore) {
        try {
          keyMeta = (await connectKeyIdempotent(store, id, String(body.apiKey), undefined, registry.getCircuitBreakerManager())).credential;
        } catch (err) {
          const failure = await mapStoreWriteFailure(err);
          if (failure) return reply.status(failure.status).send(failure.body);
          return reply.status(400).send({ success: false, error: errMessage(err) });
        }
      }
      const result = upsertCustomProvider({
        id,
        name: body.name ?? existing.name,
        npm: body.npm ?? existing.npm,
        baseURL: body.baseURL ?? existing.options?.baseURL,
        apiKey: keyToStore ? undefined : body.apiKey,
        apiKeyInline: inline,
        headers: body.headers ?? existing.options?.headers,
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
      // A def edit can change what upstream registers — never answer from the stale
      // integration snapshot.
      store.invalidate();
      if (keyToStore) clearSuspectForCredential(registry.getCircuitBreakerManager(), id, keyMeta?.keyHashPrefix);
      return { status: 'ok', ...result };
    },

    connect: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { apiKey?: string; baseURL?: string };
      const { upsertCustomProvider, getProviderNodeById } = await import('../opencode/user-config.js');
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
          store, id, body.apiKey, undefined, registry.getCircuitBreakerManager()
        );
        // Optional baseURL override — merge with the existing definition so we
        // never wipe name/npm/models of a config-defined custom provider.
        // No apiKey field → no implicit credential write on any binding.
        if (body.baseURL) {
          const existing = getProviderNodeById(id);
          upsertCustomProvider({
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
          message: `Provider '${id}' connected via ${credentialSinkLabel(store)}`,
        };
      } catch (err: any) {
        const failure = await mapStoreWriteFailure(err);
        if (failure) return reply.status(failure.status).send(failure.body);
        return reply.status(400).send({ success: false, error: err.message });
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
      const resolved = store.resolveKey(id);
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
      const enabledDefIds = Object.keys(defs || {}).filter((k) => (defs as any)[k]?.disabled !== true);
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
        : enabledDefIds.length > 0
          ? (() => {
              const textDefs = enabledDefIds.filter((k) => {
                const cm = cat?.models.find((mm) => mm.id === upstreamId(k));
                return !cm || isTextPair(cm.modalities);
              });
              const list = textDefs.length > 0 ? textDefs : [enabledDefIds[0]];
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
      const apiKey = body.apiKey || (addressed ? addressed.key : expandEnvTemplate(def?.options?.apiKey) || resolved?.key);
      if (!apiKey) {
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
      // Rotation loop: a model-scoped failure (upstream ANSWERED and rejected
      // only that model) advances to the next candidate; one green proves the
      // provider works. Connection-level failures (auth, network, gateway 404)
      // are provider-wide — rotating would only repeat the same error.
      let result: Awaited<ReturnType<typeof probeProvider>> | undefined;
      const tried: string[] = [];
      for (const modelId of modelCandidates) {
        tried.push(modelId);
        // Model-level npm override (e.g. Zen gpt-6-luna → @ai-sdk/openai =
        // Responses API) beats provider-level npm when picking the wire shape.
        const modelNpm = cat?.models.find((mm) => mm.id === modelId)?.npm;
        const kind = probeKindFor(cat?.api, modelNpm || def?.npm || cat?.npm);
        result = await probeProvider({
          baseURL: baseForWire(kind, baseURL),
          apiKey,
          model: modelId,
          provider: id,
          kind,
          headers: def?.options?.headers,
        });
        if (result.ok || !result.modelScoped) break;
      }
      // Masked echo of the addressed row (never raw material): the UI can
      // confirm WHICH credential answered, not just that the provider did.
      const credentialMeta = addressed ? store.listCredentials(id).find((a) => a.id === addressed.credentialId) : undefined;
      return {
        status: 'ok',
        provider: id,
        model: result?.model,
        // Rotation evidence (machine data, localized by the console): which
        // candidates were tried, in order. Only meaningful when > 1.
        ...(tried.length > 1 ? { triedModels: tried } : {}),
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
          store, id, body.apiKey, undefined, registry.getCircuitBreakerManager()
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
      const { deleteCustomProvider, getProviderNodeById } = await import('../opencode/user-config.js');
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const purgeAuth = query.purgeAuth === '1' || query.purgeAuth === 'true';
      try {
        const store = await getCredentialStore();
        if (getProviderNodeById(id)) {
          // The credential side is handled through the bound store below —
          // deleteCustomProvider is def-only, so it can neither dead-write auth.json
          // nor miss the standalone store's credentials.json (the B3 regression).
          const result = deleteCustomProvider(id);
          if (!result.success) return reply.status(400).send(result);
          // Decision 8 double confirmation is enforced by the console UI
          // (purgeAuth opt-in) — server-side the loop reports honestly.
          const purge = purgeAuth ? await purgeProviderCredentials(store, id) : null;
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
        return { status: 'ok', defRemoved: false, ...purgeOutcomeMessage(purge, id, false), purge };
      } catch (err: any) {
        const failure = await mapStoreWriteFailure(err);
        if (failure) return reply.status(failure.status).send(failure.body);
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    // -- Per-provider model maintenance (config-defined providers only) ----

    /** Full model definitions of a config-defined provider (management view). */
    modelsGet: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const { getProviderModelDefs } = await import('../opencode/user-config.js');
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        // credential-only provider → models live in the custom store
        const { getCustomProviderModels } = await import('../opencode/catalog/custom-store.js');
        const custom = getCustomProviderModels(id);
        if (custom.length > 0) {
          const models: Record<string, any> = {};
          for (const m of custom) models[m.id] = catalogModelToV2Def(m);
          return { status: 'ok', id, models, custom: true };
        }
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in the provider defs file` });
      }
      return { status: 'ok', id, models: defs };
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
        // credential-only provider (no jsonc node) → the custom store is the landing spot
        const { readCustomStore, upsertCustomModel } = await import('../opencode/catalog/custom-store.js');
        const custom = readCustomStore()?.providers[id];
        if (custom?.models.some((m) => m.id === String(body.id))) {
          return reply.status(409).send({ success: false, error: `Model '${body.id}' already exists — use PATCH to modify it` });
        }
        const model = defToCatalogModel(String(body.id), bodyToModelDef(body));
        const result = upsertCustomModel(id, model);
        if (!result.success) return reply.status(400).send(result);
        const { catalogRepository } = await import('../opencode/catalog/repository.js');
        await catalogRepository.ensureOcrStore();
        return { status: 'ok', success: true, model: body.id, custom: true };
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
        // credential-only provider → merge the patch into the custom-store model
        const { readCustomStore, upsertCustomModel, removeCustomModel } = await import('../opencode/catalog/custom-store.js');
        const model = readCustomStore()?.providers[id]?.models.find((m) => m.id === modelId);
        if (!model) {
          return reply.status(404).send({ success: false, error: `Model '${modelId}' is not defined for provider '${id}'` });
        }
        const targetId = body?.newId ? String(body.newId) : modelId;
        const next = { ...model, ...defToCatalogModel(targetId, bodyToModelDef(body)), id: targetId, source: 'custom' as const };
        const result = upsertCustomModel(id, next);
        if (!result.success) return reply.status(400).send(result);
        if (targetId !== modelId) removeCustomModel(id, modelId);
        return { status: 'ok', success: true, model: targetId, renamed: targetId !== modelId, custom: true };
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
      if (!result.success) {
        // credential-only provider → remove from the custom store
        const { removeCustomModel } = await import('../opencode/catalog/custom-store.js');
        const rm = removeCustomModel(id, modelId);
        if (!rm.success) return reply.status(404).send(result);
        const { catalogRepository: repo } = await import('../opencode/catalog/repository.js');
        await repo.ensureOcrStore();
        return { status: 'ok', success: true, model: modelId, custom: true };
      }
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', success: true, model: modelId };
    },

    /**
     * Pull models into the provider's config definition. Data source is chosen
     * automatically: providers with baseURL + credential are pulled LIVE from
     * their own /v1/models (failures surface real errors); providers without a
     * usable baseURL/key fall back to the static merged catalog. The same
     * engine powers the periodic auto-pull (catalog.autoPullModels).
     */
    modelsPull: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pattern?: string; dryRun?: boolean } | undefined;
      const { autoPullProvider } = await import('../opencode/catalog/auto-pull.js');
      const result = await autoPullProvider(id, body ?? {});
      return reply.status(result.httpStatus).send(result.body);
    },

    /** Clear models — whole node without a pattern, matching ids only with one. */
    modelsClear: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pattern?: string } | undefined;
      const { clearProviderModels } = await import('../opencode/user-config.js');
      const result = clearProviderModels(id, body?.pattern);
      if (!result.success) {
        // credential-only provider (no jsonc node) → clear from the custom store,
        // same fallback as modelRemove
        const { clearCustomModels } = await import('../opencode/catalog/custom-store.js');
        const cm = clearCustomModels(id, body?.pattern);
        if (!cm.success) return reply.status(404).send(result);
        const { catalogRepository: repo } = await import('../opencode/catalog/repository.js');
        await repo.ensureOcrStore();
        return { status: 'ok', success: true, removed: cm.removed, custom: true };
      }
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
     * Push OCR credentials INTO opencode v2 (the write direction of the
     * opencode-v2 sync client; opencode v1 goes through the sync endpoints).
     * The OCR file is the truth, so local entries are NEVER removed — a push
     * converges the CLIENT toward the OCR file. Preconditions enforced
     * server-side: an opencode v2 service must be reachable NOW and its db
     * readable — otherwise 400 with a machine-readable reason code. Body
     * {provider} optional (absent = every provider with local entries).
     * The outcome is recorded into credential-sync.json (lastWrite), so the
     * per-provider push button and the sync table stay consistent.
     */
    credentialStorePush: async (req: any, reply: any) => {
      const body = (req.body || {}) as { provider?: string };
      const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined;
      const {
        getCredentialStore,
        getBoundCredentialPaths,
        getBindTestOverrides,
        pushFromOcr,
        recordSyncOutcome,
      } = await import('../opencode/credentials/index.js');
      try {
        const store = await getCredentialStore();
        const overrides = getBindTestOverrides();
        const paths = getBoundCredentialPaths() ?? undefined;
        const outcome = await pushFromOcr('opencode-v2', store, {
          paths,
          provider,
          fetchImpl: overrides.fetchImpl,
          env: overrides.env,
          now: overrides.now,
          openDatabase: overrides.openDatabase,
        });
        if (outcome.precondition) {
          return reply.status(400).send({
            status: 'error',
            success: false,
            reasonCode: outcome.precondition,
            error: SYNC_PRECONDITION_ERROR[outcome.precondition],
            pushed: [],
            failed: [],
          });
        }
        recordSyncOutcome('opencode-v2', 'write', outcome, { paths, now: overrides.now });
        // Every converged (provider, key) pair is a reconnect gesture —
        // its SUSPECT flag lifts here, anchored on the pushed key's hash.
        const cb = registry.getCircuitBreakerManager();
        for (const k of outcome.pushedKeys ?? []) clearSuspectForCredential(cb, k.provider, k.keyHashPrefix);
        const pushed = [
          ...new Set(
            outcome.entries
              .filter((e) => e.action === 'pushed' || e.action === 'deduped')
              .map((e) => e.provider)
          ),
        ];
        const failed = outcome.entries
          .filter((e) => e.action === 'failed')
          .map((e) => ({ provider: e.provider, reason: e.reason ?? 'push failed' }));
        return { status: 'ok', pushed, failed };
      } catch (err: any) {
        return reply.status(500).send({
          status: 'error',
          success: false,
          error: errMessage(err),
          pushed: [],
          failed: [],
        });
      }
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
      const body = (req.body || {}) as { clientId?: string; direction?: string };
      if (!isSyncClientId(body.clientId)) {
        return reply.status(404).send({ status: 'error', success: false, error: `unknown sync client '${body.clientId}'` });
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
        });
        const cb = registry.getCircuitBreakerManager();
        for (const k of result.write?.pushedKeys ?? []) clearSuspectForCredential(cb, k.provider, k.keyHashPrefix);
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
     * Activate ONE credential of a multi-credential provider (the
     * Keys page's "make active" action). Gated purely on
     * capabilities.activate (Decision 1): OpencodeV2Store-readonly has false
     * → 400 'capability_unsupported'; the ocr store has true → allowed (no
     * kind branching anywhere). Response carries the refreshed masked credential
     * list in the store-status overlay shape so the UI repaints without a
     * second fetch.
     */
    credentialActivate: async (req: any, reply: any) => {
      const { id, credentialId } = req.params as { id: string; credentialId: string };
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      if (!store.capabilities.activate) return reply.status(400).send(capabilityRefusalBody('activate'));
      const guard = await guardStoreCredential(store, id, credentialId);
      if (!guard.ok) return reply.status(guard.status).send(guard.body);
      try {
        const credential = await store.activate(credentialId);
        store.invalidate(); // Decision 3: console action invalidates the store view
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
      const { getCredentialStore } = await import('../opencode/credentials/index.js');
      const store = await getCredentialStore();
      const guard = await guardStoreCredential(store, id, credentialId);
      if (!guard.ok) return reply.status(guard.status).send(guard.body);
      try {
        await store.disconnect(credentialId);
        store.invalidate();
        clearSuspectForCredential(registry.getCircuitBreakerManager(), id, guard.meta.keyHashPrefix);
        // A DISABLED flag is deliberately NOT dropped here: it is anchored on the
        // key hash (Decision 5), so if the same key material comes back later the
        // operator's takedown still applies. Re-adding a parked credential must
        // not silently restore traffic to it — the row shows its takedown badge and
        // one click lifts it. (SUSPECT has the opposite lifecycle: reconnect clears it.)
        return {
          status: 'ok',
          success: true,
          disconnected: credentialId,
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
    app.post(`${prefix}/credential-store/push`, ocHandlers.credentialStorePush);
    app.get(`${prefix}/credential-sync`, ocHandlers.credentialSyncStatus);
    app.post(`${prefix}/credential-sync/toggle`, ocHandlers.credentialSyncToggle);
    app.post(`${prefix}/credential-sync/run`, ocHandlers.credentialSyncRun);
    app.get(`${prefix}/opencode/providers`, ocHandlers.list);
    app.get(`${prefix}/opencode/catalog`, ocHandlers.catalog);
    app.get(`${prefix}/opencode/models`, ocHandlers.models);
    app.post(`${prefix}/opencode/providers`, ocHandlers.create);
    app.patch(`${prefix}/opencode/providers/:id`, ocHandlers.update);
    app.post(`${prefix}/opencode/providers/:id/connect`, ocHandlers.connect);
    app.post(`${prefix}/opencode/providers/:id/key`, ocHandlers.setKey);
    app.post(`${prefix}/opencode/providers/:id/test`, ocHandlers.test);
    app.delete(`${prefix}/opencode/providers/:id`, ocHandlers.remove);

    // Per-provider model maintenance (config-defined providers only)
    app.get(`${prefix}/opencode/providers/:id/models`, ocHandlers.modelsGet);
    app.post(`${prefix}/opencode/providers/:id/models`, ocHandlers.modelAdd);
    app.patch(`${prefix}/opencode/providers/:id/models/:modelId`, ocHandlers.modelUpdate);
    app.delete(`${prefix}/opencode/providers/:id/models/:modelId`, ocHandlers.modelRemove);
    app.post(`${prefix}/opencode/providers/:id/models/pull`, ocHandlers.modelsPull);
    app.post(`${prefix}/opencode/providers/:id/models/clear`, ocHandlers.modelsClear);

    // Per-credential credential writes (activate / rename / disconnect).
    // Decision 8 double-confirm lives in the console UI; these honor the call.
    app.post(`${prefix}/opencode/providers/:id/credentials/:credentialId/activate`, ocHandlers.credentialActivate);
    // Operator takedown (OCR credential state, NOT the credential store — survives
    // cooldown/reconnect/Push and is lifted only here).
    app.post(`${prefix}/opencode/providers/:id/credentials/:credentialId/disable`, ocHandlers.credentialDisable);
    app.post(`${prefix}/opencode/providers/:id/credentials/:credentialId/enable`, ocHandlers.credentialEnable);
    app.patch(`${prefix}/opencode/providers/:id/credentials/:credentialId`, ocHandlers.credentialRename);
    app.delete(`${prefix}/opencode/providers/:id/credentials/:credentialId`, ocHandlers.credentialDisconnect);
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
  //     pool gate). Read-only: no key material in the response.
  const handleGetKeyModels = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const key = listApiKeys(false).find((k) => k.id === id);
    if (!key) {
      return reply.status(404).send({ status: 'error', message: `API Key '${id}' not found` });
    }
    const policy = getModelAccessPolicy(key);
    const registered = registry.getAllModels().map((m) => ({
      id: m.id,
      provider: m.provider,
      // Unclassified = not in any pool; m.tier there is a stale boot-time
      // classification. Never report it, or `tierAllowed` counts models no
      // pool can route toward auto-X viability.
      tier: m.unclassified ? undefined : (m.tier as string),
      virtual: false,
      allowed: isModelAllowed(m.id, policy, m.tier),
    }));
    const tierAllowed = (t: string) => registered.some((m) => m.tier === t && m.allowed);
    // Virtual auto* rows honor runtime viability (mirrors /v1/models): bare
    // `auto` needs an allowed model in ANY tier, auto-X in tier X.
    const virtual = ['auto', 'auto-lite', 'auto-plus', 'auto-pro', 'auto-ultra'].map((id) => ({
      id,
      provider: 'onecast-router',
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
      provider: 'onecast-router',
      tier: '',
      virtual: false,
      allowed: registry.resolveCombo(c.id).every((mem) => isModelAllowed(mem.id, policy, mem.tier)),
    }));
    // Variant rows (mirrors /v1/models): `base-variant` ids resolve to the
    // base model with a pinned reasoning effort; the policy verdict inherits
    // from the base id.
    const variants = registry.getVariantExposures().map(({ id, base }) => ({
      id,
      provider: base.provider,
      tier: base.unclassified ? undefined : (base.tier as string),
      virtual: false,
      allowed: isModelAllowed(base.id, policy, base.tier),
    }));
    // Order mirrors /v1/models: virtual auto* → combos → registered → variants.
    return {
      status: 'ok',
      mode: policy?.mode ?? 'none',
      policyModels: policy?.models ?? [],
      models: [...virtual, ...combos, ...registered, ...variants],
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
    // 'onecast-router'; variants share their base model's provider).
    const models = [
      ...['auto', 'auto-lite', 'auto-plus', 'auto-pro', 'auto-ultra'].map((id) => ({
        id,
        kind: 'auto' as const,
        owned_by: 'onecast-router',
        tier: '',
      })),
      // Order mirrors /v1/models: auto* → combos → registered → variants, so
      // console pickers surface the short virtual ids before the long physical
      // list.
      // `unclassified` is the live membership truth; m.tier on those models is
      // a stale registration-time classification (legacy boot classifier).
      // Reporting it let console pickers badge models that belong to NO pool.
      ...registry.getCombos().map((c) => ({ id: c.id, kind: 'combo' as const, owned_by: 'onecast-router', tier: '' })),
      ...registry.getAllModels().map((m) => ({
        id: m.id,
        kind: 'model' as const,
        owned_by: m.provider,
        tier: m.unclassified ? undefined : (m.tier as string),
      })),
      ...registry.getVariantExposures().map(({ id, base }) => ({
        id,
        kind: 'variant' as const,
        owned_by: base.provider,
        tier: base.unclassified ? undefined : (base.tier as string),
      })),
    ];
    return { status: 'ok', models };
  };
  app.get('/api/admin/gateway-models', handleGatewayModels);

  // 10. Remote restart trigger from UI — spawn a detached replacement gateway
  //     first (it waits for our pid to die, boots, and self-registers the
  //     pid/info files), THEN exit. Without the spawn we would just stop and
  //     nothing would bring the gateway back (there is no supervisor).
  const handleRestart = async () => {
    const { spawnDetachedRestartChild } = await import('../cli/daemon.js');
    const cfg = loadConfig();
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
    const spawned = spawnDetachedRestartChild({ port, host: cfg.host });
    if (!spawned) {
      // Fault-tolerance: NEVER stop the gateway without a replacement — keep
      // serving and surface the failure to the UI instead of exiting.
      return {
        status: 'failed',
        message: 'Could not spawn a replacement process — gateway keeps running. Restart it manually when convenient.',
      };
    }
    setTimeout(() => process.exit(0), 500);
    return { status: 'restarting', message: 'Gateway restart signal acknowledged — replacement process is booting' };
  };
  app.post('/api/admin/restart', handleRestart);

  // 11. Process-log tail viewer — reads ~/.onecast-router/ocr.log (only
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
    return { status: 'ok', date, sessions: captureRecorder.listSessions(date, apiKey.trim() || undefined) };
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
   * Each inference turn produces 2-4 events sharing the same `traceId`:
   * client-request, gateway-response, upstream-request, upstream-response.
   * The console joins them into one logical turn via `traceId` / `spanId`.
   */
  app.get('/api/admin/capture/:date/:file/events', async (req: any, reply: any) => {
    const { date, file } = req.params as { date: string; file: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    const limit = Math.min(Math.max(parseInt((req.query as any)?.limit || '500', 10) || 500, 1), 5000);
    // Metadata-first console reads: bodies=none strips the wire bodies (KB
    // payload, instant paint); full bodies come back per turn via /turn or a
    // bodies=full re-read.
    const bodies = (req.query as any)?.bodies === 'none' ? 'none' : 'full';
    const result = await captureRecorder.readEvents(date, file, limit, bodies);
    if (result.totalLines === 0 && !captureRecorder.listSessions(date).some(s => s.file === file)) {
      return reply.status(404).send({ status: 'error', message: 'Capture archive not found' });
    }
    return { status: 'ok', date, file, ...result };
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
    const result = await captureRecorder.readTurn(date, file, id);
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

