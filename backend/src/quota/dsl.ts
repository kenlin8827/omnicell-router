import type {
  QuotaFieldSpec,
  QuotaNameSpec,
  QuotaProbeEntry,
  QuotaWindow,
  QuotaWindowSpec,
  QuotaWindowsSpec,
  QuotaWhereSpec,
} from './types.js';

/**
 * The declarative quota probe DSL engine.
 *
 * Resolution is a pure walk over plain path/literal tables: no expressions,
 * no evaluation, no state across calls. That structure IS the ban on the five
 * banned classes (arithmetic, cross-call injection, value-comparison/regex/
 * time-delta predicates, per-URL inverted mappings, header interpolation) —
 * `validateEntry` additionally rejects unknown keys so a config entry can
 * never smuggle one in through an unexpected shape.
 */

// ─── Path resolution ────────────────────────────────────────────────────────

/**
 * Resolve a dotted JSON pointer. Returns undefined on any miss (non-object
 * hop, array index name, prototype keys). `@key` resolves to the bound item
 * key inside each/eachObject windows (set by the window walker, never a
 * document path).
 */
function resolvePath(doc: unknown, path: string, itemKey?: string): unknown {
  if (path === '@key') return itemKey;
  const parts = path.split('.');
  let cur: unknown = doc;
  for (const p of parts) {
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') return undefined;
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Numbers arrive from upstreams as numbers OR decimal strings ("95.50"). */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ─── Time parsing (construct: sec/ms magnitude + ISO + date-only) ───────────

/**
 * Parse a reset timestamp to epoch ms. Accepts epoch seconds/millis (number
 * or numeric string; the 1e12 boundary discriminates the two magnitudes),
 * ISO datetime strings, date-only strings ("2026-10-20") and duration
 * strings in the rate-limit header convention ("1s", "6m0s", "1h30m",
 * "12ms" — summed segment-wise). Anything else yields null (window survives
 * without a reset marker).
 */
export function parseResetTime(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    }
    // Duration string ("6m0s", "1h30m", "12ms"): whole-string match of
    // one-or-more magnitude segments summed left to right. Date strings
    // never match (they carry '-' / ':' separators between digits).
    let totalMs = 0;
    if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(s)) {
      for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n < 0) return null;
        totalMs += n * (m[2] === 'ms' ? 1 : m[2] === 's' ? 1_000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
      }
      return totalMs > 0 ? Math.round(totalMs) : null;
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// ─── Field resolution ───────────────────────────────────────────────────────

export interface QuotaResolveContext {
  /** Parsed JSON body (undefined for empty/non-JSON). */
  body: unknown;
  /** Response headers as a lowercase-keyed getter. */
  header: (name: string) => string | null;
  /** Bound item for each/eachObject windows (root doc for static). */
  item: unknown;
  /** Bound item key for eachObject windows. */
  itemKey?: string;
}

/** Resolve one field spec to a number (or epoch ms when time:true).
 *  `firstOf` candidates resolve through this same function (their own
 *  modifiers apply per candidate); the FIRST candidate that resolves wins,
 *  then the OUTER spec's scale/invert/time apply to that winner. */
function resolveField(spec: QuotaFieldSpec | undefined, ctx: QuotaResolveContext): number | null {
  if (!spec) return null;
  let out: number | null = null;
  if (spec.firstOf && spec.firstOf.length > 0) {
    for (const alt of spec.firstOf) {
      if (alt.firstOf) continue; // nested firstOf rejected at load; belt + braces
      const n = resolveField(alt, ctx);
      if (n !== null) {
        out = n;
        break;
      }
    }
    if (out === null) return null;
  } else if (spec.header !== undefined) {
    out = toFiniteNumber(ctx.header(spec.header.toLowerCase()));
    if (out === null) return null;
  } else if (spec.literal !== undefined) {
    out = spec.literal;
  } else if (spec.path !== undefined) {
    // Paths inside each/eachObject resolve against the bound item; static
    // windows bind item = whole document, so every form shares one rule.
    const raw = resolvePath(ctx.item, spec.path, ctx.itemKey);
    if (spec.time) return parseResetTime(raw);
    out = toFiniteNumber(raw);
    if (out === null) return null;
  } else {
    return null;
  }

  let v = out;
  if (spec.scale !== undefined) v = v * spec.scale;
  if (spec.invertOf !== undefined) v = Math.max(0, spec.invertOf - v);
  if (spec.time) return parseResetTime(v);
  return Number.isFinite(v) ? v : null;
}

// ─── Gates & names ──────────────────────────────────────────────────────────

/** Presence/equality gate. Undefined `where` = always pass. */
export function evalWhere(where: QuotaWhereSpec | undefined, ctx: QuotaResolveContext): boolean {
  if (!where) return true;
  const v = resolvePath(ctx.item, where.path, ctx.itemKey);
  if (where.exists) return v !== undefined && v !== null;
  if (where.eq !== undefined) {
    if (typeof where.eq === 'boolean') return v === where.eq;
    const n = toFiniteNumber(where.eq);
    const vn = toFiniteNumber(v);
    if (n !== null && vn !== null) return vn === n;
    return String(v) === String(where.eq);
  }
  if (where.in !== undefined) {
    return where.in.some((candidate) => {
      const cn = toFiniteNumber(candidate);
      const vn = toFiniteNumber(v);
      if (cn !== null && vn !== null) return vn === cn;
      return String(v) === String(candidate);
    });
  }
  return false;
}

/** Interpolate `{field}` placeholders against the bound item (pure text
 *  substitution of stringified field values — no arithmetic). */
function interpolate(template: string, ctx: QuotaResolveContext): string {
  return template.replace(/\{([A-Za-z0-9_.@-]+)\}/g, (_m, p: string) => {
    const v = resolvePath(ctx.item, p, ctx.itemKey);
    if (v === undefined || v === null) return '';
    return String(v);
  });
}

/** Resolved label + its machine-readable i18n identity (opaque code). */
interface ResolvedName {
  name: string;
  code?: string;
  arg?: string;
}

function argOf(spec: QuotaNameSpec, ctx: QuotaResolveContext): string | undefined {
  if (spec.argPath === undefined) return undefined;
  const v = resolvePath(ctx.item, spec.argPath, ctx.itemKey);
  return v === undefined || v === null ? undefined : String(v);
}

/** Resolve a name spec with its i18n identity. Returns undefined when
 *  nothing resolvable (caller falls back). */
function resolveNameDetailed(spec: QuotaNameSpec | undefined, ctx: QuotaResolveContext): ResolvedName | undefined {
  if (!spec) return undefined;
  if (spec.from !== undefined) {
    const raw = resolvePath(ctx.item, spec.from, ctx.itemKey);
    if (raw !== undefined && raw !== null) {
      const key = String(raw);
      if (spec.enumMap && Object.prototype.hasOwnProperty.call(spec.enumMap, key)) {
        return { name: interpolate(spec.enumMap[key], ctx), code: spec.enumCode?.[key] ?? spec.code, arg: argOf(spec, ctx) };
      }
      if (spec.enumMap && spec.fallback !== undefined) {
        return { name: interpolate(spec.fallback, ctx), code: spec.code, arg: argOf(spec, ctx) };
      }
      return { name: key, code: spec.code, arg: argOf(spec, ctx) };
    }
    // `from` missed: fallback, then template, then nothing.
    if (spec.fallback !== undefined) {
      return { name: interpolate(spec.fallback, ctx), code: spec.code, arg: argOf(spec, ctx) };
    }
  }
  if (spec.template !== undefined) {
    return { name: interpolate(spec.template, ctx), code: spec.code, arg: argOf(spec, ctx) };
  }
  return undefined;
}

/** Resolve a name spec against the bound item. Returns undefined when
 *  nothing resolvable (caller falls back). */
function resolveName(spec: QuotaNameSpec | undefined, ctx: QuotaResolveContext): string | undefined {
  return resolveNameDetailed(spec, ctx)?.name;
}

// ─── Window resolution (the 2-of-3 derivation) ──────────────────────────────

/**
 * Resolve one window spec in a bound context. The 2-of-3 rule: any two of
 * used / total / remaining imply the third (remaining = total - used,
 * total = used + remaining, used = total - remaining); a lone value stays a
 * lone value (the missing relatives come out null). Percentages clamp to
 * [0,100]; absolutes clamp at 0.
 */
function resolveWindowSpec(spec: QuotaWindowSpec, ctx: QuotaResolveContext, defaultName: string): QuotaWindow | null {
  if (!evalWhere(spec.where, ctx)) return null;
  const used = resolveField(spec.used, ctx);
  const total = resolveField(spec.total, ctx);
  const remaining = resolveField(spec.remaining, ctx);
  const resetAt = spec.resetAt ? resolveField(spec.resetAt, ctx) : null;

  let fUsed = used !== null ? Math.max(0, used) : null;
  let fTotal = total !== null ? Math.max(0, total) : null;
  let fRemaining = remaining !== null ? Math.max(0, remaining) : null;

  // 2-of-3 derivation.
  if (fUsed === null && fTotal !== null && fRemaining !== null) fUsed = Math.max(0, fTotal - fRemaining);
  else if (fRemaining === null && fTotal !== null && fUsed !== null) fRemaining = Math.max(0, fTotal - fUsed);
  else if (fTotal === null && fUsed !== null && fRemaining !== null) fTotal = fUsed + fRemaining;

  // A window with no usable cap reads as unlimited (presence rule, NOT a
  // value predicate: a null/absent total with anything else present still
  // names a window).
  let unlimited = false;
  if (spec.unlimited && 'literal' in spec.unlimited) unlimited = spec.unlimited.literal === true;
  else if (spec.unlimited && 'path' in spec.unlimited) {
    const v = resolvePath(ctx.item, spec.unlimited.path, ctx.itemKey);
    unlimited = Boolean(v);
  }
  if (fTotal === null && (fUsed !== null || fRemaining !== null || resetAt !== null)) unlimited = true;

  const hasAny = fUsed !== null || fTotal !== null || fRemaining !== null || resetAt !== null || unlimited;
  if (!hasAny) return null;

  let remainingPct: number | null = null;
  if (fTotal !== null && fTotal > 0) {
    if (fRemaining !== null) remainingPct = clampPct((fRemaining / fTotal) * 100);
    else if (fUsed !== null) remainingPct = clampPct(((fTotal - fUsed) / fTotal) * 100);
  } else if (fTotal === 100 && fUsed !== null) {
    // percent-native windows (total: literal 100) take the direct route.
    remainingPct = clampPct(100 - fUsed);
  }

  const resolvedName = resolveNameDetailed(spec.nameSpec, ctx);
  const name =
    resolvedName?.name ??
    spec.name ??
    ctx.itemKey ?? // eachObject without a nameSpec: the object key names the window
    defaultName;

  return {
    name: name || defaultName,
    nameCode: resolvedName?.code ?? spec.nameCode,
    nameArg: resolvedName?.arg,
    used: fUsed,
    total: fTotal,
    remainingPct,
    resetAt,
    unlimited,
  };
}

function clampPct(p: number): number {
  return Math.max(0, Math.min(100, p));
}

/**
 * Evaluate a full entry against one probe response. Windows missing names
 * deduplicate with an index suffix so a broken upstream cannot collide two
 * bars into one.
 */
export function resolveWindows(
  entry: QuotaProbeEntry,
  body: unknown,
  header: (name: string) => string | null
): { windows: QuotaWindow[]; plan?: string } {
  const rootCtx: QuotaResolveContext = { body, header, item: body, itemKey: undefined };
  const windows: QuotaWindow[] = [];
  const ws: QuotaWindowsSpec = entry.windows;

  const push = (w: QuotaWindow | null, fallback: string) => {
    if (!w) return;
    let name = w.name || fallback;
    if (windows.some((x) => x.name === name)) name = `${name} #${windows.length + 1}`;
    windows.push({ ...w, name });
  };

  if (ws.form === 'static') {
    for (const spec of ws.windows) push(resolveWindowSpec(spec, rootCtx, spec.name ?? 'window'), spec.name ?? 'window');
  } else if (ws.form === 'each') {
    const arr = resolvePath(body, ws.path);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const ctx: QuotaResolveContext = { body, header, item, itemKey: undefined };
        push(resolveWindowSpec(ws.window, ctx, 'window'), 'window');
      }
    }
  } else {
    const obj = resolvePath(body, ws.path);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [key, item] of Object.entries(obj as Record<string, unknown>)) {
        const ctx: QuotaResolveContext = { body, header, item, itemKey: key };
        push(resolveWindowSpec(ws.window, ctx, key), key);
      }
    }
  }

  // successIf gate (single equality) — checked here so the caller can treat
  // a failed gate as a `shape` failure and KEEP the previous snapshot.
  return { windows, plan: ws.plan ? resolveName(ws.plan, rootCtx) : undefined };
}

/** successIf evaluation against the parsed body. */
export function evalSuccessIf(entry: QuotaProbeEntry, body: unknown): boolean {
  if (!entry.successIf) return true;
  const ctx: QuotaResolveContext = { body, header: () => null, item: body };
  return evalWhere(entry.successIf, ctx);
}

// ─── Loader validation ──────────────────────────────────────────────────────

const FIELD_KEYS = new Set(['path', 'header', 'literal', 'firstOf', 'scale', 'invertOf', 'time']);
const WINDOW_KEYS = new Set(['name', 'nameCode', 'nameSpec', 'where', 'used', 'total', 'remaining', 'resetAt', 'unlimited']);
const WHERE_KEYS = new Set(['path', 'exists', 'eq', 'in']);
const NAME_KEYS = new Set(['template', 'from', 'enumMap', 'enumCode', 'fallback', 'code', 'argPath']);

/**
 * Reject the banned classes at load, whole entry, loudly (the caller drops
 * the entry). Structurally unrepresentable by shape; these checks catch the
 * smuggle attempts: unknown keys (expression/function payloads), multi-URL
 * entries, header-value interpolation, comparison predicates.
 * Returns an error string or null when the entry is loadable.
 */
export function validateEntry(entry: QuotaProbeEntry): string | null {
  if (!entry || typeof entry !== 'object') return 'entry is not an object';
  // Top-level unknown keys are the banned-class smuggle surface (expressions,
  // `method`, multi-url arrays, injected state): a loadable entry carries
  // exactly the schema keys — anything else rejects the WHOLE entry.
  const ENTRY_KEYS = new Set([
    'id', 'providerId', 'url', 'auth', 'headers', 'successIf', 'windows',
    'cacheTtlMs', 'forkedFrom', 'verifiedAt', 'builtin',
  ]);
  for (const k of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(k)) return `entry ${entry.id}: unknown top-level key '${k}' (banned class or typo)`;
  }
  if (typeof entry.id !== 'string' || !entry.id) return 'entry.id missing';
  if (typeof entry.providerId !== 'string' || !entry.providerId) return 'entry.providerId missing';
  if (typeof entry.url !== 'string' || !entry.url) return 'entry.url missing';
  if (entry.auth !== 'bearer' && entry.auth !== 'x-api-key' && entry.auth !== 'bearer-bare')
    return `entry ${entry.id}: unknown auth mode`;
  if (entry.cacheTtlMs !== undefined && (typeof entry.cacheTtlMs !== 'number' || !Number.isFinite(entry.cacheTtlMs)))
    return `entry ${entry.id}: cacheTtlMs must be a finite number`;

  // Static headers: plain string values only — `{...}` interpolation inside a
  // header value is the banned "header value interpolation" class.
  if (entry.headers !== undefined) {
    if (typeof entry.headers !== 'object' || entry.headers === null || Array.isArray(entry.headers))
      return `entry ${entry.id}: headers must be a static object`;
    for (const [k, v] of Object.entries(entry.headers)) {
      if (typeof v !== 'string') return `entry ${entry.id}: header ${k} is not a static string`;
      if (/\{[^}]+\}/.test(v)) return `entry ${entry.id}: header ${k} contains interpolation (banned class)`;
    }
  }

  if (entry.successIf) {
    const err = validateWhere(entry.successIf, `entry ${entry.id}: successIf`);
    if (err) return err;
    if (entry.successIf.exists || entry.successIf.in) return `entry ${entry.id}: successIf must be a single equality`;
  }

  const ws = entry.windows;
  if (!ws || typeof ws !== 'object') return `entry ${entry.id}: windows missing`;
  if (ws.form !== 'static' && ws.form !== 'each' && ws.form !== 'eachObject')
    return `entry ${entry.id}: unknown windows form`;
  if ((ws.form === 'each' || ws.form === 'eachObject') && typeof ws.path !== 'string')
    return `entry ${ws.form}: path must be a string`;

  const specs: QuotaWindowSpec[] =
    ws.form === 'static' ? ws.windows : [ws.form === 'each' ? ws.window : ws.window];
  if (ws.form === 'static' && !Array.isArray(ws.windows)) return `entry ${entry.id}: static windows must be an array`;
  for (const spec of specs) {
    const err = validateWindowSpec(spec, `entry ${entry.id}`);
    if (err) return err;
  }
  if (ws.plan) {
    const err = validateName(ws.plan, `entry ${entry.id}: plan`);
    if (err) return err;
  }
  return null;
}

function validateWindowSpec(spec: QuotaWindowSpec, where: string): string | null {
  if (!spec || typeof spec !== 'object') return `${where}: window spec missing`;
  for (const k of Object.keys(spec)) {
    if (!WINDOW_KEYS.has(k)) return `${where}: unknown window key '${k}' (banned class smuggle?)`;
  }
  if (spec.where) {
    const e = validateWhere(spec.where, `${where}: where`);
    if (e) return e;
  }
  if (spec.nameSpec) {
    const e = validateName(spec.nameSpec, `${where}: nameSpec`);
    if (e) return e;
  }
  if (spec.nameCode !== undefined && typeof spec.nameCode !== 'string')
    return `${where}: nameCode must be a string`;
  for (const key of ['used', 'total', 'remaining', 'resetAt'] as const) {
    if (spec[key]) {
      const e = validateField(spec[key]!, `${where}.${key}`);
      if (e) return e;
    }
  }
  if (spec.unlimited) {
    const u = spec.unlimited as Record<string, unknown>;
    const keys = Object.keys(u);
    if (keys.length !== 1 || (keys[0] !== 'literal' && keys[0] !== 'path'))
      return `${where}: unlimited must be {literal} or {path}`;
    if (keys[0] === 'literal' && typeof u.literal !== 'boolean') return `${where}: unlimited.literal must be boolean`;
    if (keys[0] === 'path' && typeof u.path !== 'string') return `${where}: unlimited.path must be a string`;
  }
  return null;
}

function validateField(spec: QuotaFieldSpec, where: string): string | null {
  if (!spec || typeof spec !== 'object') return `${where}: field missing`;
  for (const k of Object.keys(spec)) {
    if (!FIELD_KEYS.has(k)) return `${where}: unknown field key '${k}' (banned class smuggle?)`;
  }
  if (spec.firstOf !== undefined) {
    if (!Array.isArray(spec.firstOf) || spec.firstOf.length === 0) return `${where}: firstOf must be a non-empty array`;
    for (const alt of spec.firstOf) {
      if (alt.firstOf) return `${where}: nested firstOf is not allowed`;
      const e = validateField(alt, `${where}.firstOf`);
      if (e) return e;
    }
  }
  for (const numKey of ['literal', 'scale', 'invertOf'] as const) {
    const v = spec[numKey];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return `${where}: ${numKey} must be finite`;
  }
  if (spec.path !== undefined && typeof spec.path !== 'string') return `${where}: path must be string`;
  if (spec.path && /(\.\.|^\/\/|\/\/)/.test(spec.path)) return `${where}: path contains traversal or absolute markers`;
  if (spec.header !== undefined && typeof spec.header !== 'string') return `${where}: header must be string`;
  if (spec.time !== undefined && typeof spec.time !== 'boolean') return `${where}: time must be boolean`;
  return null;
}

function validateWhere(where: QuotaWhereSpec, label: string): string | null {
  if (!where || typeof where !== 'object') return `${label}: where missing`;
  for (const k of Object.keys(where)) {
    if (!WHERE_KEYS.has(k)) return `${label}: unknown where key '${k}' (value comparison / regex / time delta is a banned class)`;
  }
  if (typeof where.path !== 'string') return `${label}: where.path must be a string`;
  const set = [where.exists !== undefined, where.eq !== undefined, where.in !== undefined].filter(Boolean).length;
  if (set !== 1) return `${label}: exactly one of exists/eq/in must be set`;
  if (where.in !== undefined && (!Array.isArray(where.in) || where.in.length === 0))
    return `${label}: where.in must be a non-empty literal list`;
  if (where.eq !== undefined && typeof where.eq !== 'string' && typeof where.eq !== 'number' && typeof where.eq !== 'boolean')
    return `${label}: where.eq must be a literal`;
  return null;
}

function validateName(name: QuotaNameSpec, label: string): string | null {
  if (!name || typeof name !== 'object') return `${label}: name spec missing`;
  for (const k of Object.keys(name)) {
    if (!NAME_KEYS.has(k)) return `${label}: unknown name key '${k}'`;
  }
  if (name.template !== undefined && typeof name.template !== 'string') return `${label}: template must be a string`;
  if (name.from !== undefined && typeof name.from !== 'string') return `${label}: from must be a string`;
  if (name.code !== undefined && typeof name.code !== 'string') return `${label}: code must be a string`;
  if (name.argPath !== undefined && typeof name.argPath !== 'string') return `${label}: argPath must be a string`;
  if (name.enumCode !== undefined) {
    if (typeof name.enumCode !== 'object' || name.enumCode === null || Array.isArray(name.enumCode))
      return `${label}: enumCode must be an object`;
    for (const [k, v] of Object.entries(name.enumCode)) {
      if (typeof v !== 'string') return `${label}: enumCode[${k}] must be a string`;
    }
  }
  if (name.enumMap !== undefined) {
    if (typeof name.enumMap !== 'object' || name.enumMap === null || Array.isArray(name.enumMap))
      return `${label}: enumMap must be an object`;
    for (const [k, v] of Object.entries(name.enumMap)) {
      if (typeof v !== 'string') return `${label}: enumMap[${k}] must be a string`;
    }
    if (name.from === undefined) return `${label}: enumMap requires 'from'`;
  }
  return null;
}
