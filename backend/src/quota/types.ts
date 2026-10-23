/**
 * Quota tracking data model.
 *
 * Tracks the remaining allowance of every (providerId × keyHashPrefix) pair
 * whose provider is covered. Coverage ships with the release (the built-in
 * declaration table + built-in code adapters); activation follows credentials —
 * a covered provider's credential appearing in the chain is all it takes for
 * the prober to schedule it. Nothing snapshots the current credential pool.
 *
 * KNOWN v1 LOSSY FIELDS (deliberately not modeled): per-window `currency` /
 * `isCreditBalance` (DeepSeek multi-currency balances and prepaid credit are
 * flattened to plain numbers) and recurring-window metadata. The window model
 * below is what the badge renders; anything richer stays in the upstream
 * response, not in the snapshot.
 *
 * Identity note: `keyHashPrefix` is the same display-safe sha256 prefix the
 * pair breakers / credential flags anchor on — the key-hash identity. Snapshots
 * carry ONLY that prefix, never key material.
 */

/**
 * Where a snapshot's numbers came from.
 *  - probed    : built-in declaration table (L-b) or built-in code adapter (L-c)
 *                actively fetched and parsed.
 *  - measured  : harvested from inference-response headers (L-a). Phase 2 —
 *                the data plane is reserved (ExecutionTrace.execution
 *                .credentialKeyHashPrefix is the attribution base), nothing
 *                writes this value yet.
 *  - declared  : static declaration without live verification (reserved for
 *                plan-cap declarations; v1 writers: none — badge still maps
 *                the four visual states over the full enum).
 *  - forked    : produced by a user `quotaProbes:` entry (L-d), always with a
 *                lineage stamp (forkedFrom + verifiedAt) on the entry.
 */
export type QuotaSource = 'probed' | 'measured' | 'declared' | 'forked';

/**
 * The four badge states the console renders:
 *  - probed     : a probed/measured snapshot inside its cache window.
 *  - declared   : snapshot exists but only from declaration / lineage without
 *                 live verification.
 *  - unverified : provider covered, credential present, no snapshot yet
 *                 (probe never ran or never returned usable data).
 *  - stale      : last snapshot older than the entry cacheTtl, or the most
 *                 recent probe attempt failed (probe failure is NOT a quota
 *                 failure — old values are KEPT and marked stale, never a
 *                 breaker trip, never a takedown).
 */
export type QuotaBadgeState = 'probed' | 'declared' | 'unverified' | 'stale';

/** One usage window (a 5h session cap, a weekly cap, a credit balance, …). */
export interface QuotaWindow {
  /** Display name, resolved by the entry's name spec (never an index). */
  name: string;
  /** Machine-readable window-name identity (e.g. `weekly`, `sessionHours`)
   *  for console i18n mapping — opaque label, no computational meaning.
   *  Absent (legacy snapshots, config entries without codes) = show `name`
   *  verbatim. */
  nameCode?: string;
  /** Single interpolation argument for the coded name (hours, currency, …). */
  nameArg?: string;
  /** Absolute used amount in the window's own unit, when derivable. */
  used: number | null;
  /** Absolute cap in the window's own unit; null = no stated cap. */
  total: number | null;
  /** 0..100 percent remaining, when derivable (2-of-3 rule below). */
  remainingPct: number | null;
  /** Epoch ms the window resets, when derivable. */
  resetAt: number | null;
  /** True when the window carries no usable cap (null/absent total). */
  unlimited: boolean;
}

/** The stored, display-safe fact for one (provider × credential) pair. */
export interface QuotaSnapshot {
  providerId: string;
  keyHashPrefix: string;
  windows: QuotaWindow[];
  /** Plan/tier label when the upstream response carries one. */
  plan?: string;
  source: QuotaSource;
  /** Epoch ms of the last successful refresh (never of a failure). */
  verifiedAt: number;
  /** Entry id that produced it (built-in table id, adapter id, or config key). */
  entryId: string;
  /** Epoch ms of the most recent FAILED probe attempt — badge folds this
   *  into `stale`; absent when attempts never failed since success. */
  lastFailureAt?: number;
}

/**
 * WHY the last attempt produced nothing — the honest answer to "covered, but
 * empty". Without it a pair whose upstream answers 401 (dead credential) or
 * a plan-level refusal (e.g. MiniMax `base_resp.status_code: 2062 "no active
 * token plan subscription"`) is indistinguishable from "the probe has not run
 * yet", and the console can only say `unverified` forever.
 *
 * Display-safe by construction: a transport-level verdict, the HTTP status, and
 * the upstream's own short message (the last-probe dialog already shows the
 * full body to the operator). Response HEADERS and key material never enter it.
 */
export interface QuotaProbeFailure {
  /** Same closed vocabulary as `QuotaProbeOutcome.reason`. */
  reason: 'network' | 'status' | 'shape' | 'auth';
  /** HTTP status when a response existed (absent for a transport failure). */
  statusCode?: number;
  /** Upstream's own words, collapsed to one line and length-bounded. */
  message?: string;
  /** Epoch ms of this attempt. */
  at: number;
}

// ─── Declarative probe DSL ──────────────────────────────────────────────────
// Twelve constructs (windows: static / each / eachObject count as one family):
// field extraction by path, firstOf, the 2-of-3 derivation (any two of
// used/total/remaining imply the third), invert, scale:ratio, where (== / ∈ /
// presence ONLY), name template (pure interpolation + enumMap, plus the
// opaque i18n identity codes enumCode/code/argPath/nameCode), a static
// headers block, successIf (single equality), unlimited (literal or boolean
// path), source:headers, and time parsing (sec/ms magnitude detection, ISO,
// date-only strings).
//
// The five banned classes are rejected AT LOAD time, whole entry, never
// silently: arithmetic expressions, cross-call data injection, value
// comparison / regex / time-difference predicates, per-URL inverted mappings,
// header-value interpolation. They are banned because they are structurally
// unrepresentable here: resolution walks plain path/literal tables — there is
// no expression, no eval, no state between calls, and an entry carries
// exactly one URL (a provider needing per-URL semantics belongs in a code
// adapter, e.g. MiniMax).

/** Field extraction: where one NUMBER (or time) comes from. */
export interface QuotaFieldSpec {
  /** JSON pointer relative to the document root, or to the array/object item
   *  inside `each` / `eachObject` (`@key` addresses the item key there). */
  path?: string;
  /** Response-header name (construct `source: headers`); numeric value. */
  header?: string;
  /** Constant number (e.g. percent windows carry total: literal 100). */
  literal?: number;
  /** Try each candidate in order; first one that resolves wins. */
  firstOf?: QuotaFieldSpec[];
  /** Multiply the resolved value (ratio 0..1 -> percent: scale 100). */
  scale?: number;
  /** Flip a value against a constant: resolved -> `invertOf` - resolved
   *  (percent-used -> percent-left with invertOf 100). Clamped at 0. */
  invertOf?: number;
  /** Interpret the resolved value as a reset TIME (epoch seconds/millis by
   *  magnitude, ISO datetime, date-only string) -> epoch ms. */
  time?: boolean;
}

/**
 * Presence/equality gate (construct `where`): `exists` = path must resolve to
 * a non-null value; `eq` = strict equality against one literal; `in` =
 * membership in a literal list. Value comparison (<, >, regex, time deltas)
 * is a BANNED class — the loader never accepts such keys (unrepresentable by
 * this shape).
 */
export interface QuotaWhereSpec {
  path: string;
  exists?: boolean;
  eq?: string | number | boolean;
  in?: (string | number)[];
}

/** Window/plan label resolution (construct nameTemplate + enumMap). */
export interface QuotaNameSpec {
  /** Pure interpolation of item fields: "{currency}", "{number}h". */
  template?: string;
  /** Field whose value feeds `enumMap` (or the name verbatim). */
  from?: string;
  /** Literal field-value -> label map. Values may themselves interpolate
   *  item fields. A miss falls through to `fallback` (then to `from`). */
  enumMap?: Record<string, string>;
  /** Used when enumMap misses (interpolated too). */
  fallback?: string;
  /** Literal field-value -> i18n code map, keys parallel to `enumMap`: the
   *  code (not the English label) is what the console translates. */
  enumCode?: Record<string, string>;
  /** i18n code for the template / fallback / verbatim-`from` name forms. */
  code?: string;
  /** Path whose resolved value rides along as the coded name's argument
   *  (hours, currency, …). Display-only identity — not a computation. */
  argPath?: string;
}

/** One window's extraction table. */
export interface QuotaWindowSpec {
  /** Static name (form `static` only; each/eachObject need `name`). */
  name?: string;
  /** Machine-readable identity for the static `name` (console i18n mapping). */
  nameCode?: string;
  nameSpec?: QuotaNameSpec;
  /** Gate for `each` items (e.g. only limit.type ∈ [TOKENS_LIMIT,
   * CREDIT_LIMIT]) — equality/membership/presence only. */
  where?: QuotaWhereSpec;
  used?: QuotaFieldSpec;
  total?: QuotaFieldSpec;
  remaining?: QuotaFieldSpec;
  resetAt?: QuotaFieldSpec;
  /** Literal, or a boolean path (truthy value = unlimited). */
  unlimited?: { literal: boolean } | { path: string };
}

/** The three window forms. */
export type QuotaWindowsSpec =
  | { form: 'static'; windows: QuotaWindowSpec[]; plan?: QuotaNameSpec }
  | { form: 'each'; path: string; window: QuotaWindowSpec; plan?: QuotaNameSpec }
  | { form: 'eachObject'; path: string; window: QuotaWindowSpec; plan?: QuotaNameSpec };

/** Auth mode for a probe call. */
export type QuotaAuthMode =
  /** Reuse the provider's inference `Authorization: Bearer` header. */
  | 'bearer'
  /** Send the raw key as `x-api-key` (Kimi coding usage endpoint). */
  | 'x-api-key'
  /** Send the raw key as a plain `Authorization: <key>` header (no scheme). */
  | 'bearer-bare';

/**
 * A full probe entry — one URL, GET only, static headers, the window table.
 * Built-in (L-b) entries may pin an absolute `url` and a non-inference `auth`
 * (every host + auth choice is disclosed in the quota declaration table and
 * the decision record). Config (L-d) entries are constrained by the iron
 * rules: `url` is a relative path inside the provider inference origin,
 * `auth` is forced 'bearer' (inference reuse), and lineage stamps
 * (`forkedFrom`, `verifiedAt`) are required to override a built-in.
 */
export interface QuotaProbeEntry {
  /** Stable id: built-in table entries use their provider id; config entries
   *  use `<providerId>#<index>` (or `override:<builtinId>` when forking). */
  id: string;
  providerId: string;
  /** Absolute for built-ins (each host disclosed in the declaration table);
   *  relative-but-sanitized for config entries (resolved against the inference
   *  origin). */
  url: string;
  auth: QuotaAuthMode;
  /** Static headers block (no value interpolation — banned class). */
  headers?: Record<string, string>;
  /** Single-equality success gate against a body field (e.g. code == 0). */
  successIf?: QuotaWhereSpec;
  windows: QuotaWindowsSpec;
  /** Cache window for the snapshot; loader clamps to [60 s, 24 h]. */
  cacheTtlMs?: number;
  /** Lineage (config only): the built-in entry this one forks, if any. */
  forkedFrom?: string;
  /** Lineage (config only): when the user verified this probe shape. */
  verifiedAt?: number;
  /** Origin of this entry's knowledge. */
  builtin: boolean;
}

/**
 * Raw last-exchange capture (display-safe, memory-only): the quota endpoint's
 * own response — url/status/parsed body. Response HEADERS are never captured
 * (request auth travels there); an oversized or non-JSON body degrades to
 * truncated text. Never persisted to the snapshot file.
 */
export interface LastProbeCapture {
  url: string;
  status?: number;
  ok: boolean;
  durationMs?: number;
  /** Transport-level failure — no response at all. */
  error?: 'network';
  /** Parsed JSON body, or truncated raw text when not JSON / oversized. */
  body?: unknown;
}

/** Engine-level probe outcome, kept separate from the breaker vocabulary. */
export type QuotaProbeOutcome =
  | { ok: true; windows: QuotaWindow[]; plan?: string; http?: LastProbeCapture }
  | { ok: false; reason: 'network' | 'status' | 'shape' | 'auth'; http?: LastProbeCapture };

// ─── Built-in code adapters (L-c) ───────────────────────────────────────────

/**
 * A code adapter owns its HTTP shape end to end (multi-URL fallback, per-URL
 * inverted semantics — the classes the DSL bans). It receives the RAW key
 * in-process only (the same consumer contract as the executor chain — raw
 * keys travel in memory, never onto a surface); returned values are
 * display-safe aggregates. `fetchImpl` / `now` are test seams — production
 * wiring passes the globals.
 */
export interface QuotaAdapterContext {
  providerId: string;
  key: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface QuotaCodeAdapter {
  /** Stable adapter id (file/provider name). */
  id: string;
  /** Which covered providers resolve to this adapter (region-aware sets). */
  providerIds: string[];
  probe(ctx: QuotaAdapterContext): Promise<QuotaProbeOutcome>;
}

// ─── L-d config surface (config.yaml `quotaProbes:`) ───────────────────────

/**
 * A user-declared probe, iron-rule-bound: relative
 * path inside the provider's inference origin, inference-reuse bearer auth,
 * GET-only, one URL, cacheTtl clamped [60 s, 24 h]. Overriding a built-in
 * entry requires the explicit `override` field; `forkedFrom` + `verifiedAt`
 * are the lineage stamps carried into snapshots/badges.
 */
export interface QuotaProbeConfigEntry {
  /** Path relative to the provider inference baseURL origin (no scheme,
   *  no host, no `..`, no `//`, no `@`). */
  url: string;
  /** Single-equality success gate against a body field (optional). */
  successIf?: QuotaWhereSpec;
  windows: QuotaWindowsSpec;
  /** Static headers only (no interpolation). */
  headers?: Record<string, string>;
  /** Clamped to [60 s, 24 h] at load. */
  cacheTtlMs?: number;
  /** Built-in entry id this forks (REQUIRED to replace a built-in). */
  override?: string;
  /** Lineage: source of the forked knowledge. */
  forkedFrom?: string;
  /** Lineage: epoch ms the user verified this shape. */
  verifiedAt?: number;
}
