import { DEFAULT_QUOTA_PROBE_TIMEOUT_MS } from '../config/defaults.js';
import { BUILTIN_QUOTA_DECLARATIONS, builtinAdapters } from './declarations.js';
import { evalSuccessIf, resolveWindows, validateEntry } from './dsl.js';
import { captureBody, resolveVerdict, upstreamCode } from './verdict.js';
import { getQuotaStore } from './store.js';
import type {
  QuotaCodeAdapter,
  LastProbeCapture,
  QuotaProbeConfigEntry,
  QuotaProbeEntry,
  QuotaProbeOutcome,
  QuotaProbeFailure,
  QuotaSnapshot,
  QuotaWindow,
} from './types.js';

/**
 * Probe engine: merges the three knowledge layers into the
 * effective entry set, executes one GET probe per pair, and lands the result
 * in the snapshot store.
 *
 * Precedence (layer order L-c > L-b > L-d, with L-d overriding ONLY through
 * the explicit `override` field — silent shadowing is the banned direction,
 * iron rule 4d):
 *   adapter provider ids  -> built-in code adapter (no DSL entry consulted)
 *   built-in DSL ids      -> declaration table
 *   config ids            -> user entries (iron-rule validated)
 *   config `override: <builtinId>` -> replaces that built-in, source forked
 */

export const QUOTA_TTL_MIN_MS = 60_000;
export const QUOTA_TTL_MAX_MS = 24 * 3_600_000;

export function clampTtl(ttl: number | undefined): number {
  if (ttl === undefined || !Number.isFinite(ttl)) return 15 * 60_000;
  return Math.max(QUOTA_TTL_MIN_MS, Math.min(QUOTA_TTL_MAX_MS, ttl));
}

/** Display cap for the memory-only last-probe capture: bodies above this many
 *  chars degrade to truncated text (the capture is for humans, not parsers). */
export const LAST_BODY_MAX_CHARS = 32_768;
/** Parsed-JSON bodies whose raw form exceeded this many chars degrade too. */
export const LAST_BODY_MAX_JSON_CHARS = 262_144;

// ─── L-d iron rules ─────────────────────────────────────────────────────────

/**
 * Relative-path sanitization (iron rule 4a): reject scheme, host, `..`, `//`,
 * `@`, and anything that would leave the provider inference origin after
 * resolution. Returns the absolute URL or an error string.
 */
export function sanitizeProbePath(relUrl: string, inferenceBaseUrl: string | undefined): string | null {
  if (typeof relUrl !== 'string' || !relUrl.startsWith('/')) return null;
  if (relUrl.includes('..') || relUrl.includes('@')) return null;
  if (relUrl.startsWith('//')) return null; // protocol-relative escape
  if (/^[a-z][a-z0-9+.-]*:/i.test(relUrl)) return null; // absolute scheme (belt + braces — startsWith('/') already rejects most)
  if (!inferenceBaseUrl) return null;
  let base: URL;
  let joined: URL;
  try {
    base = new URL(inferenceBaseUrl);
    joined = new URL(relUrl, inferenceBaseUrl);
  } catch {
    return null;
  }
  // Post-resolution origin check — the iron rule is origin containment, not
  // string shape.
  if (joined.origin !== base.origin) return null;
  if (joined.protocol !== 'https:' && joined.protocol !== 'http:') return null;
  return joined.toString();
}

/**
 * Validate + convert ONE config entry (L-d). Every failure is LOUD (the
 * caller warns) and drops the whole entry — never a partial load.
 * `originProviderBaseUrl` = the provider's inference baseURL for 4a
 * containment; a config entry for a provider with no inference base is
 * refused (no origin to contain it).
 */
export function buildConfigEntry(
  providerId: string,
  index: number,
  raw: QuotaProbeConfigEntry,
  originProviderBaseUrl: string | undefined,
  builtinIdsForProvider: string[]
): { entry?: QuotaProbeEntry; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'entry is not an object' };
  // Unknown top-level keys = banned-class smuggle surface: reject (method,
  // absolute auth knobs, multi-url lists are all unrepresentable by design).
  const allowed = new Set(['url', 'successIf', 'windows', 'headers', 'cacheTtlMs', 'override', 'forkedFrom', 'verifiedAt']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return { error: `unknown key '${k}' (banned class or typo — entry dropped)` };
  }
  if (typeof raw.url !== 'string') return { error: 'url must be a relative path' };
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(raw.url)) return { error: 'absolute url rejected — L-d entries carry a relative path only (iron rule 4a)' };
  const url = sanitizeProbePath(raw.url, originProviderBaseUrl);
  if (!url) return { error: 'url fails origin containment (iron rule 4a)' };

  // Iron rule 4b: auth is the inference bearer header, full stop — there is
  // no auth field to set. (4c) GET-only is structural: the engine never
  // posts. (4d) an entry that replaces a built-in must name it.
  const overrideId = raw.override;
  if (overrideId !== undefined && typeof overrideId !== 'string') return { error: 'override must be a built-in entry id' };
  if (builtinIdsForProvider.length > 0 && overrideId === undefined) {
    return { error: `provider '${providerId}' is covered by built-in(s) [${builtinIdsForProvider.join(', ')}] — a config entry must set override: <id> (iron rule 4d)` };
  }
  if (overrideId !== undefined && !builtinIdsForProvider.includes(overrideId)) {
    return { error: `override '${overrideId}' matches no built-in for '${providerId}'` };
  }

  const id = overrideId ? `override:${overrideId}` : `${providerId}#${index}`;
  const entry: QuotaProbeEntry = {
    id,
    providerId,
    url,
    auth: 'bearer',
    headers: raw.headers,
    successIf: raw.successIf,
    windows: raw.windows,
    cacheTtlMs: clampTtl(raw.cacheTtlMs),
    forkedFrom: overrideId ? raw.forkedFrom ?? `builtin:${overrideId}` : raw.forkedFrom,
    verifiedAt: raw.verifiedAt,
    builtin: false,
  };
  const verr = validateEntry(entry);
  if (verr) return { error: verr };
  return { entry };
}

// ─── Effective entry set ────────────────────────────────────────────────────

/** The one target (DSL entry or code adapter) that probes a provider. */
export type QuotaTarget =
  | { kind: 'dsl'; entry: QuotaProbeEntry }
  | { kind: 'adapter'; adapter: QuotaCodeAdapter };

export interface EffectiveQuotaPlan {
  /** providerId -> the one entry/adapter that will probe it (never two). */
  byProvider: Map<string, QuotaTarget>;
  /** Entries dropped at validation (id + reason) — surfaced on the console. */
  rejected: { id: string; error: string }[];
}

/**
 * Merge built-ins + the config `quotaProbes:` section. Adapters cover their
 * provider ids absolutely (the DSL layer never re-covers them; config cannot
 * override an adapter — fork a code adapter by... not supporting that in v1,
 * documented). DSL entries can be replaced per provider by an `override:`
 * config entry.
 */
export function buildEffectivePlan(
  quotaProbes: Record<string, QuotaProbeConfigEntry[]> | undefined,
  providerBaseUrl: (providerId: string) => string | undefined,
  /** L-e seam (ADR-0009): candidate provider ids for the plugin layer plus
   *  the per-id capability lookup (a loaded model-service plugin's
   *  quotaCheck, wrapped as an adapter). Fills ONLY uncovered providers. */
  pluginLayer?: {
    candidateIds: () => Iterable<string>;
    adapterFor: (providerId: string) => QuotaCodeAdapter | undefined;
  }
): EffectiveQuotaPlan {
  const byProvider = new Map<string, QuotaTarget>();
  const rejected: EffectiveQuotaPlan['rejected'] = [];

  // L-c adapters first (absolute coverage).
  for (const adapter of builtinAdapters()) {
    for (const pid of adapter.providerIds) {
      byProvider.set(pid, { kind: 'adapter', adapter });
    }
  }

  // L-b built-in DSL table.
  for (const entry of BUILTIN_QUOTA_DECLARATIONS) {
    const err = validateEntry(entry);
    if (err) {
      // A shipped built-in failing its own validation is a release bug —
      // loud warn, drop the entry, never crash boot.
      console.warn(`[quota] built-in entry rejected at load (release bug): ${err}`);
      rejected.push({ id: entry.id, error: err });
      continue;
    }
    if (!byProvider.has(entry.providerId)) byProvider.set(entry.providerId, { kind: 'dsl', entry });
  }

  // L-d config entries.
  if (quotaProbes && typeof quotaProbes === 'object') {
    for (const [providerId, entries] of Object.entries(quotaProbes)) {
      if (providerId === '__proto__' || providerId === 'constructor' || providerId === 'prototype') continue;
      if (!Array.isArray(entries)) {
        rejected.push({ id: providerId, error: 'quotaProbes.<providerId> must be an array of entries' });
        continue;
      }
      const current = byProvider.get(providerId);
      const builtinIds = current?.kind === 'dsl' ? [current.entry.id] : [];
      if (current?.kind === 'adapter') {
        rejected.push({ id: providerId, error: 'provider is covered by a built-in code adapter — config cannot override it (v1)' });
        continue;
      }
      let slot = 0;
      for (const raw of entries) {
        const id = `${providerId}#${slot}`;
        const { entry, error } = buildConfigEntry(providerId, slot, raw as QuotaProbeConfigEntry, providerBaseUrl(providerId), builtinIds);
        if (error) {
          console.warn(`[quota] config entry ${id} rejected: ${error}`);
          rejected.push({ id: raw?.override ? `override:${raw.override}` : id, error });
          slot++;
          continue;
        }
        byProvider.set(providerId, { kind: 'dsl', entry: entry! });
        slot++;
      }
    }
  }

  // L-e plugin adapters (lowest precedence): a vendor plugin that declares
  // the quotaCheck capability covers its wire's providers — but only where
  // no release knowledge (L-b/L-c) and no operator entry (L-d) already
  // speaks for the provider. The plugin owns the endpoint knowledge; core
  // owns the scheduling, the store and the display vocabulary.
  if (pluginLayer) {
    for (const providerId of pluginLayer.candidateIds()) {
      if (byProvider.has(providerId)) continue;
      const adapter = pluginLayer.adapterFor(providerId);
      if (adapter) byProvider.set(providerId, { kind: 'adapter', adapter });
    }
  }

  return { byProvider, rejected };
}

// ─── Probe execution ────────────────────────────────────────────────────────

export interface RunProbeOpts {
  /** Raw key — in-process only, the same consumer contract as the executor
   *  chain — raw keys travel in process memory only, per the credential
   *  store's consumer contract; never stored, never serialized. */
  key: string;
  providerId: string;
  /** Display-safe prefix supplied by the caller (chain entry or the
   *  default-credential degeneracy) — the identity every snapshot hangs on. */
  prefix: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** HTTP outcome split the scheduler cares about. */
export interface ProbeRunResult {
  outcome: QuotaProbeOutcome;
  /** True when the endpoint answered 429 — drives the ENGINE-LEVEL global
   *  backoff (never a per-entry field — scheduling is engine-level logic). */
  rateLimited: boolean;
  /** Raw last exchange (memory-only, display-safe) — absent only when the
   *  transport failed before any response existed. */
  http?: LastProbeCapture;
}

export async function runDslProbe(entry: QuotaProbeEntry, opts: RunProbeOpts): Promise<ProbeRunResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUOTA_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = (opts.now ?? Date.now)();
  try {
    const headers: Record<string, string> = { Accept: 'application/json', ...(entry.headers ?? {}) };
    if (entry.auth === 'bearer') headers.Authorization = `Bearer ${opts.key}`;
    else if (entry.auth === 'x-api-key') headers['x-api-key'] = opts.key;
    else if (entry.auth === 'bearer-bare') headers.Authorization = opts.key;

    const res = await doFetch(entry.url, { method: 'GET', headers, signal: controller.signal });
    const meta = { url: entry.url, status: res.status, durationMs: Math.max(0, (opts.now ?? Date.now)() - startedAt) };
    // Words BEFORE the verdict. A rejection is the commonest quota failure (a
    // dead key answers 401 on every declaration-table provider) and the upstream
    // explains it in the body it sends with the 4xx — a capture that drops that
    // body can only render a reason word, which is the silence this whole change
    // exists to remove. So the text is read once, for every outcome; a body read
    // that itself breaks keeps the status and says so in `detail`.
    let bodyReadError: string | undefined;
    const raw = await res.text().catch((err) => {
      bodyReadError = failureCause(err);
      return '';
    });
    // Parsed when it parses (the console pretty-prints an object), raw text
    // otherwise (an HTML error page still says something), and bounded either
    // way — never hold an arbitrarily large JSON object per pair.
    let parsed: unknown;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }
    const http: LastProbeCapture = {
      ...meta,
      ok: res.ok,
      ...(raw ? { body: raw.length > LAST_BODY_MAX_JSON_CHARS ? raw.slice(0, LAST_BODY_MAX_CHARS) : (parsed ?? raw.slice(0, LAST_BODY_MAX_CHARS)) } : {}),
      ...(bodyReadError ? { detail: `response body read failed: ${bodyReadError}` } : {}),
    };
    if (res.status === 429) return { outcome: { ok: false, reason: 'status' }, rateLimited: true, http };
    if (res.status === 401 || res.status === 403) return { outcome: { ok: false, reason: 'auth' }, rateLimited: false, http };
    if (!res.ok) return { outcome: { ok: false, reason: 'status' }, rateLimited: false, http };

    const body = parsed;
    if (raw && body === undefined) return { outcome: { ok: false, reason: 'shape' }, rateLimited: false, http };
    if (!evalSuccessIf(entry, body)) return { outcome: { ok: false, reason: 'shape' }, rateLimited: false, http };
    const headerGetter = (name: string) => res.headers.get(name);
    const { windows, plan } = resolveWindows(entry, body, headerGetter);
    if (windows.length === 0) return { outcome: { ok: false, reason: 'shape' }, rateLimited: false, http };
    return { outcome: { ok: true, windows, plan }, rateLimited: false, http };
  } catch (err) {
    const reason = classifyThrownFailure(err);
    return {
      outcome: { ok: false, reason },
      rateLimited: false,
      http: {
        url: entry.url,
        ok: false,
        error: reason,
        detail: failureCause(err),
        durationMs: Math.max(0, (opts.now ?? Date.now)() - startedAt),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Display bound for one upstream failure message (the full body stays in the
 *  memory-only last-probe capture; this is the one-line badge caption). */
export const FAILURE_MESSAGE_MAX_CHARS = 160;

/** Collapse an upstream body to ONE display line (whitespace-normalized). */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > FAILURE_MESSAGE_MAX_CHARS ? `${flat.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1)}…` : flat;
}

/**
 * A probe that THREW is either a timeout or a plain transport fault — it is
 * never a credential verdict. Node/undici report a wall-clock timeout with
 * `err.name === 'AbortError'`, the same name an operator cancel carries, and the
 * first pass labelled every throw `network` while a status branch reserved
 * 401/403 for `auth`: a gateway that hung (or an auth shim that answered 504)
 * then read as "key rejected", which sends the operator to re-auth a working
 * credential. An HTTP ANSWER keeps its own class (`status`) — 504 says
 * "upstream refused · HTTP 504", which is honest; this rule is for legs that
 * never got an answer at all.
 */
export function classifyThrownFailure(err: unknown): 'timeout' | 'network' {
  const e = err as { name?: string; message?: string; timedOut?: boolean; cause?: { code?: string; message?: string } };
  const name = e?.name ?? '';
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : '';
  if (
    name === 'HeadersTimeoutError' ||
    name === 'BodyTimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    e?.timedOut === true ||
    /timed out|timeout/i.test(`${name} ${e?.message ?? ''} ${e?.cause?.message ?? ''}`)
  ) {
    return 'timeout';
  }
  return 'network';
}

/**
 * The cause of a failure that produced NO captured body: error class, its
 * message, the transport code Node/Bun park on `cause` (`ENOTFOUND`,
 * `ECONNREFUSED`, `ETIMEDOUT`, an abort) and the vendor's own words when the
 * thrown error carries them in `errorBody` instead. A probe that throws is only
 * ever labelled `network`, so without this line the operator cannot tell a dead
 * resolver from a refused connection from a rejected credential chain.
 */
export function failureCause(err: unknown): string {
  const e = err as { name?: string; message?: string; errorBody?: unknown; cause?: unknown };
  const cause = e?.cause as { code?: string; message?: string } | undefined;
  const parts = [
    e?.name ?? 'Error',
    typeof e?.message === 'string' && e.message ? e.message : String(err),
    typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : undefined,
  ].filter((p): p is string => Boolean(p));
  // A rejection that answered with a body the executor wrapped INTO the error
  // (host `UpstreamError.errorBody`) never reaches `http.body` — the quota plane
  // only sees the throw. Without this the sentence the vendor DID send
  // ("token was expired") disappears behind the transport label.
  const body = typeof e?.errorBody === 'string' ? upstreamMessage(e.errorBody) : undefined;
  if (body) parts.push(`body: ${body}`);
  return oneLine(parts.join(': '));
}

/**
 * The upstream's own words when the body carries a recognizable envelope
 * (MiniMax `base_resp.status_msg`, the common `error.message` / `message` /
 * `msg` / `detail` shapes), else a compact JSON stringification of a small
 * body. Returns undefined when there is nothing display-worthy.
 */
function upstreamMessage(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body.trim() ? oneLine(body) : undefined;
  if (typeof body !== 'object') return oneLine(String(body));
  const rec = body as Record<string, any>;
  const envelope = rec.base_resp ?? rec.baseResp;
  if (envelope && typeof envelope === 'object') {
    const msg = envelope.status_msg ?? envelope.statusMsg;
    const code = envelope.status_code ?? envelope.statusCode;
    if (typeof msg === 'string' && msg.trim()) {
      return oneLine(code !== undefined && code !== null ? `${msg} (code ${String(code)})` : msg);
    }
  }
  for (const key of ['error', 'message', 'msg', 'detail']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
    // { error: { message } } — the OpenAI-shaped failure body.
    if (v && typeof v === 'object') {
      const inner = (v as Record<string, unknown>).message;
      if (typeof inner === 'string' && inner.trim()) return oneLine(inner);
    }
  }
  try {
    const json = JSON.stringify(body);
    return json && json.length > 2 ? oneLine(json) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the display-safe failure verdict for one attempt: transport reason +
 * HTTP status + the upstream's short message. Display-only evidence — it never
 * gates routing and never reaches the breaker plane.
 */
export function probeFailureDetail(
  outcome: Extract<QuotaProbeOutcome, { ok: false }>,
  http: LastProbeCapture | undefined,
  at: number,
  entry?: QuotaProbeEntry
): Omit<QuotaProbeFailure, 'at'> & { at: number } {
  const message = upstreamMessage(http?.body) ?? http?.detail;
  const body = captureBody(http);
  const code = upstreamCode(body);
  return {
    reason: outcome.reason,
    verdict: outcome.verdict ?? resolveVerdict({ reason: outcome.reason, status: http?.status, body, entry }),
    ...(code !== undefined ? { upstreamCode: code } : {}),
    ...(http?.status !== undefined ? { statusCode: http.status } : {}),
    ...(message ? { message } : {}),
    at,
  };
}

/**
 * Normalize windows BEFORE they land in the store, for every source (DSL entry
 * or adapter). A NEGATIVE cap is a vendor sentinel meaning 'no stated ceiling',
 * never a credit count: passed through it rendered as `0 / -1`, a row that reads
 * as an empty pool the account does not have. The wire type carries no remaining
 * leg, so an absent ceiling cannot be rebuilt — say so with `unlimited` and drop
 * the percent that was computed against it.
 */
function sanitizeWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return windows.map((w) => {
    if (w.total === null || w.total >= 0) return w;
    return {
      ...w,
      used: w.used !== null && w.used >= 0 ? w.used : null,
      total: null,
      remainingPct: null,
      unlimited: true,
    };
  });
}

/**
 * Probe one pair through its effective entry (DSL or adapter) and land the
 * result in the store. Probe failure NEVER touches breakers — it keeps the
 * old snapshot and marks it stale: the quota plane and the health plane are
 * separate axes; the declared cap only DISPLAYS, it never gates routing.
 */
export async function probePair(target: QuotaTarget, opts: RunProbeOpts): Promise<ProbeRunResult> {
  const now = opts.now ?? Date.now;
  let outcome: QuotaProbeOutcome;
  let http: LastProbeCapture | undefined;
  let rateLimited = false;
  let entryId: string;
  let source: QuotaSnapshot['source'];
  // The effective entry, when the DSL executed it — its `refusalIf` is the
  // declaration-table half of the verdict decision (see verdict.ts).
  let probedEntry: QuotaProbeEntry | undefined;

  if (target.kind === 'adapter') {
    entryId = `adapter:${target.adapter.id}`;
    source = 'probed';
    // An adapter is THIRD-PARTY code: it may reject instead of returning the
    // failure object its contract asks for (an unwrapped transport call, its own
    // defect). Letting that escape would kill the whole pair — no failure record,
    // no capture, and the cycle dies with the other pairs unprobed — which is
    // precisely the silent `—` this plane is meant to eliminate. The adapter's
    // id stands in for a URL here: the throw happened before (or outside) any
    // exchange core could see.
    try {
      outcome = await target.adapter.probe({ providerId: opts.providerId, key: opts.key, fetchImpl: opts.fetchImpl, now, timeoutMs: opts.timeoutMs });
      http = outcome.http;
    } catch (err) {
      const reason = classifyThrownFailure(err);
      outcome = { ok: false, reason };
      http = { url: entryId, ok: false, error: reason, detail: `adapter threw: ${failureCause(err)}` };
    }
    // Any 429 from any probe (DSL or adapter) arms the engine-level global
    // backoff — adapters report it as a plain status failure, so lift it here.
    if (http?.status === 429) rateLimited = true;
  } else {
    const entry = target.entry;
    probedEntry = entry;
    entryId = entry.id;
    source = entry.builtin ? 'probed' : 'forked';
    const run = await runDslProbe(entry, opts);
    outcome = run.outcome;
    rateLimited = run.rateLimited;
    http = run.http;
  }

  const store = getQuotaStore();
  if (outcome.ok) {
    // Sanitize the OUTCOME, not just the stored copy: the returned windows are
    // what a manual 'probe now' answers with, and the two views must not
    // disagree about whether a cap exists.
    outcome = { ...outcome, windows: sanitizeWindows(outcome.windows) };
    store.put({
      providerId: opts.providerId,
      keyHashPrefix: opts.prefix,
      windows: outcome.windows,
      plan: outcome.plan,
      source,
      verifiedAt: now(),
      entryId,
    });
    // A success retires the previous failure verdict (it described evidence
    // that no longer applies).
    store.clearFailure(opts.providerId, opts.prefix);
  } else {
    // A failed attempt keeps the previous values (store marks staleness;
    // there is no "delete on failure" path — staleness is the honest
    // signal) AND records WHY, so a pair that never succeeded shows its
    // verdict instead of an eternal `unverified`.
    store.markFailure(opts.providerId, opts.prefix, probeFailureDetail(outcome, http, now(), probedEntry));
  }
  // The raw last exchange rides MEMORY-ONLY (never into the snapshot file) —
  // the console's "inspect last probe" surface reads it back here.
  if (http) store.recordHttp(`${opts.providerId}#${opts.prefix}`, http);
  return { outcome, rateLimited };
}
