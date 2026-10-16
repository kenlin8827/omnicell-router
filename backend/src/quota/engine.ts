import { BUILTIN_QUOTA_DECLARATIONS, builtinAdapters } from './declarations.js';
import { evalSuccessIf, resolveWindows, validateEntry } from './dsl.js';
import { getQuotaStore } from './store.js';
import type {
  QuotaCodeAdapter,
  LastProbeCapture,
  QuotaProbeConfigEntry,
  QuotaProbeEntry,
  QuotaProbeOutcome,
  QuotaSnapshot,
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
  providerBaseUrl: (providerId: string) => string | undefined
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
   *  chain-head degeneracy) — the identity every snapshot hangs on. */
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
  const timeoutMs = opts.timeoutMs ?? 10_000;
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
    if (res.status === 429) return { outcome: { ok: false, reason: 'status' }, rateLimited: true, http: { ...meta, ok: false } };
    if (res.status === 401 || res.status === 403) return { outcome: { ok: false, reason: 'auth' }, rateLimited: false, http: { ...meta, ok: false } };
    if (!res.ok) return { outcome: { ok: false, reason: 'status' }, rateLimited: false, http: { ...meta, ok: false } };

    const raw = await res.text().catch(() => '');
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return {
          outcome: { ok: false, reason: 'shape' },
          rateLimited: false,
          http: { ...meta, ok: false, body: raw.slice(0, LAST_BODY_MAX_CHARS) },
        };
      }
    }
    // Oversized parsed bodies degrade to truncated text for the human-facing
    // capture (never hold an arbitrarily large JSON object in memory per pair).
    const captureBody = raw.length > LAST_BODY_MAX_JSON_CHARS ? raw.slice(0, LAST_BODY_MAX_CHARS) : body;
    if (!evalSuccessIf(entry, body)) return { outcome: { ok: false, reason: 'shape' }, rateLimited: false, http: { ...meta, ok: false, body: captureBody } };
    const headerGetter = (name: string) => res.headers.get(name);
    const { windows, plan } = resolveWindows(entry, body, headerGetter);
    if (windows.length === 0) return { outcome: { ok: false, reason: 'shape' }, rateLimited: false, http: { ...meta, ok: false, body: captureBody } };
    return { outcome: { ok: true, windows, plan }, rateLimited: false, http: { ...meta, ok: true, body: captureBody } };
  } catch {
    return {
      outcome: { ok: false, reason: 'network' },
      rateLimited: false,
      http: { url: entry.url, ok: false, error: 'network', durationMs: Math.max(0, (opts.now ?? Date.now)() - startedAt) },
    };
  } finally {
    clearTimeout(timer);
  }
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

  if (target.kind === 'adapter') {
    entryId = `adapter:${target.adapter.id}`;
    source = 'probed';
    outcome = await target.adapter.probe({ providerId: opts.providerId, key: opts.key, fetchImpl: opts.fetchImpl, now, timeoutMs: opts.timeoutMs });
    http = outcome.http;
    // Any 429 from any probe (DSL or adapter) arms the engine-level global
    // backoff — adapters report it as a plain status failure, so lift it here.
    if (http?.status === 429) rateLimited = true;
  } else {
    const entry = target.entry;
    entryId = entry.id;
    source = entry.builtin ? 'probed' : 'forked';
    const run = await runDslProbe(entry, opts);
    outcome = run.outcome;
    rateLimited = run.rateLimited;
    http = run.http;
  }

  const store = getQuotaStore();
  if (outcome.ok) {
    store.put({
      providerId: opts.providerId,
      keyHashPrefix: opts.prefix,
      windows: outcome.windows,
      plan: outcome.plan,
      source,
      verifiedAt: now(),
      entryId,
    });
  } else {
    // A failed attempt keeps the previous values (store marks staleness;
    // there is no "delete on failure" path — staleness is the honest
    // signal, and a never-probed pair simply stays `unverified`).
    store.markFailure(opts.providerId, opts.prefix);
  }
  // The raw last exchange rides MEMORY-ONLY (never into the snapshot file) —
  // the console's "inspect last probe" surface reads it back here.
  if (http) store.recordHttp(`${opts.providerId}#${opts.prefix}`, http);
  return { outcome, rateLimited };
}
