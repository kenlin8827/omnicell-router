import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  type JSONPath,
  type ParseError,
} from 'jsonc-parser';
import { isOpencodeV2Package } from '../providers/wire.js';
import { readProviderDefsFile, writeProviderDefs } from './provider-defs.js';
import { resolveDefaultPaths, resolveOpencodeConfigPath, type CredentialPaths } from './credentials/paths.js';

/**
 * OpenCode-adjacent configuration management.
 *
 * Responsibilities:
 *  - Provider definitions  -> the OCR provider-defs file (<ocrHome>/providers.json,
 *    provider-defs.ts) — the single def truth. opencode.jsonc is a sync-client
 *    materialization target, never read or written here as truth; the one-shot
 *    port from jsonc lives in provider-defs.ts.
 *  - Credentials           -> OUT of this module entirely. The bound CredentialStore
 *    owns every credential write; the legacy auth.json snapshot is read ONLY by the
 *    credentials layer (one-shot import / v1 sync client) and feeds no view here.
 *
 * Hard rules:
 *  - The remaining JSONC writes here (patchJsonc) serve CLIENT integration surfaces
 *    (the opencode CLI hook), text-level via jsonc-parser (parse -> modify -> applyEdits)
 *    so user comments and formatting survive.
 *  - All writes are read-modify-write with atomic rename (temp file + rename).
 *  - Secrets are never returned unmasked from list/read APIs.
 */

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function getOpenCodeConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'opencode');
}

export function getOpenCodeConfigPath(): string {
  // Delegates to the ONE candidate resolver (credentials/paths.ts) — the defs
  // materializer and the one-shot provider import resolve through the same function,
  // so a write can never target a different file than the read did.
  return resolveOpencodeConfigPath(resolveDefaultPaths());
}

// ---------------------------------------------------------------------------
// JSONC primitives (comment-preserving)
// ---------------------------------------------------------------------------

/** Parse a JSONC file tolerantly; returns undefined when missing or unparsable. */
export function readJsonc(filePath: string): any {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const errors: ParseError[] = [];
    const parsed = parse(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0 || parsed === undefined) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (e) {
      lastError = e;
      if (attempt < 4) {
        const until = Date.now() + (attempt + 1) * 10;
        while (Date.now() < until) {}
      }
    }
  }
  try {
    fs.unlinkSync(tmpPath);
  } catch {}
  throw lastError;
}

function backupOnce(filePath: string, suffix: string): void {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}${suffix}`;
  if (!fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch {
      // best effort
    }
  }
}

/**
 * Patch a single location inside a JSONC file with a text-level edit.
 * Passing `undefined` as value removes the property (JSONPath must point at a property).
 * Preserves all comments and unrelated formatting.
 */
export function patchJsonc(
  filePath: string,
  jsonPath: JSONPath,
  value: any,
  opts: { backupSuffix?: string } = {}
): void {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  let edits;
  try {
    edits = modify(raw, jsonPath, value, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
  } catch {
    throw new Error(`Unable to compute JSONC edit for ${filePath} at ${jsonPath.join('.')}`);
  }

  const edited = applyEdits(raw, edits);
  if (edited === raw) return; // nothing changed

  if (opts.backupSuffix) backupOnce(filePath, opts.backupSuffix);
  atomicWrite(filePath, edited);
}

// ---------------------------------------------------------------------------
// Shared masking / env-template helpers (management-safe views + def readers)
// ---------------------------------------------------------------------------

/** Never expose a full secret through management APIs. */
export function maskSecret(secret?: string): string {
  if (!secret) return '';
  if (secret.length <= 10) return `${secret.slice(0, 2)}••••`;
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

/** Expand OpenCode-style `{env:VAR}` templates against the current environment. */
export function expandEnvTemplate(value?: string): string {
  if (!value) return '';
  return value.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_m, name) => process.env[name] ?? '');
}

// ---------------------------------------------------------------------------
// Provider definitions (the OCR provider-defs file — `providers` map)
// ---------------------------------------------------------------------------

export const ROUTER_PROVIDER_ID = 'omnicell-router';
const DEFAULT_NPM = '@ai-sdk/openai-compatible';

/**
 * No legacy compatibility: provider defs have ONE shape and ONE home — the v2
 * node (`package`/`settings`/`headers`/`env`/`canonical`/`body`) in the defs
 * file's `providers` map. opencode v1 installs are not supported, so there is
 * no v1 emit path and no legacy `provider`-slot reader.
 */

export interface ProviderDefInput {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  apiKey?: string;
  /**
   * When true, the key is written inline into `settings.apiKey`. A `{env:VAR}`
   * value is TRANSLATED to `env:["VAR"]` instead (opencode v2 has no inline
   * template concept). Otherwise the bound credential store owns the secret and
   * this writer refuses to put one in the file.
   */
  apiKeyInline?: boolean;
  headers?: Record<string, string>;
  /** Passthrough merged into `settings` (apiKey/headers extracted to their v2 slots first). */
  options?: Record<string, any>;
  models?: Record<string, any>;
  /** Env-var NAMES the runtime reads as credentials (no secret material). */
  env?: string[];
  /** Built-in provider id whose catalog this def inherits. */
  canonical?: string;
  /** Provider-level request-body defaults. */
  body?: Record<string, any>;
}

export interface OpenCodeProviderView {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  models: string[];
  /** Per-provider auto-pull whitelist (catalog.autoPullPatterns) — shown/prefilled by the console. */
  autoPullPattern?: string;
  /** credential summary — defs-file inline options ∪ bound-store credentials (masked) */
  auth: {
    connected: boolean;
    type?: 'api' | 'oauth' | 'wellknown';
    keyMasked?: string;
    inline?: boolean;
  };
}

/**
 * Valid custom-provider id - lowercase slug only (`[a-z0-9._-]`, leading
 * letter/digit). The id is a verbatim key across case-sensitive stores (defs
 * file, credential store, quota (provider x keyHashPrefix) pairs, breaker
 * state, modelRef `provider/model` strings) and every built-in/catalog
 * vocabulary id is lowercase, so a mixed-case id would fork the namespace.
 * Enforced on every def write (upsertProviderDef); the console form
 * normalizes input live so users never see a silent rewrite.
 */
export function isValidProviderId(id: string): boolean {
  return Boolean(id) && /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

/** Human-readable statement of the id rule, interpolated verbatim by every
 *  rejection site (console route 400, defs-funnel error) so the wording can
 *  never drift apart. */
export const PROVIDER_ID_RULE =
  'lowercase letters, digits, ".", "_" or "-" only, starting with a letter or digit';

// ---------------------------------------------------------------------------
// opencode v2 provider-shape READ normalization 
// ---------------------------------------------------------------------------

/**
 * Opencode v2 provider defs replace opencode v1 `npm`/`options` with
 * `name`/`env`/`package`/`canonical`/`settings`/`headers`/`body`. Only
 * markers an opencode v1 def can never carry count as evidence — `env`, top-level
 * `headers` and `name` are ambiguous across the two shapes and are
 * deliberately NOT detection signals.
 */
function isOpencodeV2ShapedDef(raw: Record<string, any>): boolean {
  return (
    raw.package !== undefined ||
    raw.settings !== undefined ||
    raw.canonical !== undefined ||
    raw.body !== undefined
  );
}

/**
 * Normalize one opencode-v2 shaped provider def to the internal (opencode v1) shape every
 * consumer below boot already reads:
 *  - `package` ≙ `npm`
 *  - `settings` ≙ `options` (fill-missing overlay — an opencode v1 `options` mixed into
 *    a partially migrated file wins on conflict)
 *  - top-level `headers` ≙ `options.headers` (opencode v2 moved that slot out; opencode v1 kept
 *    it inside options)
 *  - `env`/`body`/`canonical` ride through unchanged (no internal slot
 *    consumes them yet) and `settings` stays on the def too — boot-direct's
 *    model path still reads raw `settings.reasoningEffort`.
 * opencode-v1 shaped defs are returned BY REFERENCE, untouched — zero behavior change
 * for existing files. WRITE side emits both shapes via
 * `upsertProviderDef({schema})` (P4).
 */
export function normalizeProviderDef(raw: unknown): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const rec = raw as Record<string, any>;
  if (!isOpencodeV2ShapedDef(rec)) return raw;
  const def: Record<string, any> = { ...rec };
  if (def.npm === undefined && typeof rec.package === 'string') def.npm = rec.package;
  const settings = rec.settings && typeof rec.settings === 'object' ? rec.settings : {};
  const options: Record<string, any> = rec.options && typeof rec.options === 'object' ? { ...rec.options } : {};
  for (const [k, v] of Object.entries(settings)) {
    if (options[k] === undefined) options[k] = v;
  }
  if (options.headers === undefined && rec.headers && typeof rec.headers === 'object') {
    options.headers = rec.headers;
  }
  // Credential slot: opencode v2 names the ENV VARS a provider reads instead of
  // holding an inline template. Materialize the first name that actually resolves so
  // OCR's existing `{env:X}` expansion (boot-direct, the console's inline badge) keeps
  // working on a v2-shaped node — otherwise an env-supplied key reads as "no
  // credential" while opencode itself routes fine with it.
  if (options.apiKey === undefined && Array.isArray(rec.env) && rec.env.length > 0) {
    const names = rec.env.filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
    const resolved = names.find((n) => (process.env[n] ?? '') !== '');
    const chosen = resolved ?? names[0];
    if (chosen !== undefined) options.apiKey = `{env:${chosen}}`;
  }
  def.options = options;
  return def;
}

/**
 * Model-def sibling of normalizeProviderDef: `provider.package` ≙
 * `provider.npm` — the boot-direct npm precedence chain (d.provider.npm >
 * catModel.npm > def.npm > rec.npm) then flows opencode v2 packages into wireFor
 * unchanged. NOTE: model-level `settings` is ALREADY the opencode v1 shape's slot
 * (reasoningEffort/effort are read raw there by boot-direct), so unlike the
 * provider level there is no settings→options overlay — only the genuinely
 * new `package` alias is normalized. Untouched opencode v1 model defs pass through by
 * reference.
 */
function normalizeModelDef(raw: unknown): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const rec = raw as Record<string, any>;
  const provider = rec.provider && typeof rec.provider === 'object' ? (rec.provider as Record<string, any>) : undefined;
  if (!provider || provider.npm !== undefined || typeof provider.package !== 'string') return raw;
  return { ...rec, provider: { ...provider, npm: provider.package } };
}

// ---------------------------------------------------------------------------
// opencode v2 provider-shape WRITE construction 
// ---------------------------------------------------------------------------

/**
 * Opencode v1 npm → opencode v2 package table (write side of Decision 9). Every segment is one
 * wire.ts's OPENCODE_V2_SEGMENT_WIRES already recognizes on the READ side — the write
 * side adds NO second vocabulary: `wireFor(opencode v1) === wireFor(mapped-v2)` holds
 * for each pair (pinned by user-config-v2-write.test.ts).
 * '@ai-sdk/openai-compatible' maps to the canonical compatible-runtime string
 * '@opencode/ai/providers/openai-compatible' — the only compatible-runtime
 * package the read normalizer resolves onto the 'openai' wire.
 * Unknown npm strings ride through VERBATIM into the `package` slot: inventing
 * an unprobed opencode v2 segment would silently change wire inference (opencode v2 segments are
 * matched exactly, unknown → unroutable), while a passthrough '@ai-sdk/*' (or
 * any other) string keeps resolving through the classic heuristic exactly as
 * the opencode v1 node did.
 */
/**
 * The compatible-runtime package — the single source of that string. It is also
 * the def-materializer's fallback for wires the client has no package for
 * (CLIENT_PACKAGE_FALLBACK in credentials/def-materialize.ts).
 */
export const OPENCODE_V2_OPENAI_COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible';

const AI_SDK_TO_OPENCODE_V2_PACKAGE: Record<string, string> = {
  '@ai-sdk/openai-compatible': OPENCODE_V2_OPENAI_COMPATIBLE_PACKAGE,
  '@ai-sdk/openai': '@opencode/ai/providers/openai',
  '@ai-sdk/anthropic': '@opencode/ai/providers/anthropic',
  '@ai-sdk/google': '@opencode/ai/providers/google',
  '@ai-sdk/azure': '@opencode/ai/providers/azure',
  '@ai-sdk/vertex': '@opencode/ai/providers/vertex',
  '@ai-sdk/google-vertex': '@opencode/ai/providers/google-vertex',
  '@ai-sdk/bedrock': '@opencode/ai/providers/bedrock',
  '@ai-sdk/amazon-bedrock': '@opencode/ai/providers/amazon-bedrock',
  // TypeSafe decision wire. The segment 'typesafe' resolves to wire 'systemone'
  // (wire.ts OPENCODE_V2_SEGMENT_WIRES), so the authored package keeps the
  // decision wire end to end. Client loadability is a separate concern: a client
  // that has not shipped the segment still gets the compatible-runtime package,
  // substituted in the client copy only by CLIENT_PACKAGE_FALLBACK
  // (credentials/def-materialize.ts) — the book always keeps this value.
  '@ai-sdk/typesafe-ai': '@opencode/ai/providers/typesafe',
};

/** npm string → the opencode v2 `package` value (mapped table, already-v2 passthrough, unknown passthrough). */
export function opencodeV2PackageFor(npm: string): string {
  if (isOpencodeV2Package(npm)) return npm;
  // Object.hasOwn parity with wireFor (prototype-member npm strings must never
  // resolve to Object.prototype values as a "package").
  const mapped: string | undefined = Object.hasOwn(AI_SDK_TO_OPENCODE_V2_PACKAGE, npm) ? AI_SDK_TO_OPENCODE_V2_PACKAGE[npm] : undefined;
  return mapped ?? npm;
}

// opencode v2 has no inline `{env:VAR}` string concept — the runtime reads the
// variables NAMED in the `env` array itself. A full-string template translates;
// a wrapped template ('Bearer {env:X}') cannot be expressed by `env` and is
// treated as literal key material (known ceiling: OCR only ever writes the
// full-string form today, the console form never produces wrapped templates).
const ENV_TEMPLATE_FULL_RE = /^\{env:([A-Za-z0-9_]+)\}$/;
const ENV_NAME_RE = /^[A-Za-z0-9_]+$/;

function isPlainRecord(v: unknown): v is Record<string, any> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The `providers` map key — one name shared by the defs file and the jsonc
 * materialization target.
 *
 * Slot matters more than it looks — opencode's normalizer picks its decoder BY SLOT
 * (`providers` = the v2 schema, the retired singular `provider` = the v1 schema), so
 * a node whose shape disagrees with its slot is decoded by the wrong schema and one
 * type-enforced key mismatch silently drops the WHOLE provider, every model with it.
 * Writing exactly one shape into exactly one slot removes that failure mode, and
 * `legacyShapedSlotEntries` (applied by `normalizeSlotMap`) drops and reports
 * retired-shape nodes instead of routing providers opencode never registered.
 */
/**
 * Retired NODE spellings the v2 `providers` decoder cannot read: node-level `npm`
 * and `options` (moved to `package`/`settings`).
 *
 * MODEL-level defs are deliberately NOT gated. Verified against the decoder schema
 * embedded in opencode v2.0.15: `providers.<id>.models` validates the models.dev
 * config shape — flat snake_case `cost.cache_read/cache_write`, keyed-Record
 * `variants`, and model-level `provider.npm` are the CURRENT file spellings. The
 * nested `cache:{read,write}`, array `variants`, and model `package` forms are
 * opencode's INTERNAL domain shape (Model.Info), produced by its own read-time
 * conversion. An earlier model-level gate refused the file spelling as 'legacy' and
 * broke every cache-priced model (pull + editor save) — a false positive, not a guard.
 */
export function legacyShapedProviderPaths(def: Record<string, any>): string[] {
  const bad: string[] = [];
  if (def.npm !== undefined) bad.push('npm');
  if (def.options !== undefined) bad.push('options');
  return bad;
}

/**
 * Model-level write normalization — the reverse of normalizeModelDef: the
 * internal `provider.npm` slot becomes the opencode v2 `provider.package` slot, and the
 * value passes through opencodeV2PackageFor (the SAME one vocabulary as the provider
 * level — no second converter; the reader aliases package→npm verbatim and
 * wireFor resolves both spellings to one wire, so the mapping round-trips).
 * Everything else in a model def is already opencode-v2 shaped (console.ts's
 * bodyToModelDef is the single catalog-style→def converter shared by the
 * model editor routes; this mirror does NOT fork a second converter).
 */
function opencodeV2ModelDefs(models: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!models) return undefined;
  const out: Record<string, any> = {};
  for (const [mid, m] of Object.entries(models)) {
    const provider = isPlainRecord(m) && isPlainRecord(m.provider) ? m.provider : undefined;
    if (provider && typeof provider.npm === 'string' && provider.package === undefined) {
      const providerOut: Record<string, any> = { ...provider };
      const npmValue: string = provider.npm;
      delete providerOut.npm;
      providerOut.package = opencodeV2PackageFor(npmValue);
      out[mid] = { ...m, provider: providerOut };
    } else {
      out[mid] = m;
    }
  }
  return out;
}

/**
 * Assemble the opencode-v2 shaped `provider.<id>` node from a ProviderDefInput.
 * Returns {error} without touching the file when the def cannot be written
 * honestly (cp-failfast) — never a silent credential drop.
 */
export function buildV2ProviderNode(def: ProviderDefInput): { node?: Record<string, any>; error?: string } {
  // settings ← opencode v1 `options` passthrough, minus the slots opencode v2 moved out of it.
  const settings: Record<string, any> = { ...(def.options || {}) };
  const passthroughHeaders = isPlainRecord(settings.headers) ? settings.headers : undefined;
  delete settings.headers;
  const passthroughKey = typeof settings.apiKey === 'string' ? settings.apiKey : undefined;
  delete settings.apiKey;
  if (def.baseURL) settings.baseURL = def.baseURL;

  const envNames = new Set<string>(
    (Array.isArray(def.env) ? def.env : []).filter((n) => typeof n === 'string' && ENV_NAME_RE.test(n))
  );

  // Credential slot. On opencode v2 the BOUND store owns secrets — this writer NEVER
  // touches auth.json (that write is dead on an opencode v2 install). Rules:
  //  - full `{env:X}` value → translate to env:["X"], drop the fake inline key
  //    (a literal '{env:X}' string in settings.apiKey is not an opencode v2 concept);
  //  - literal secret → settings.apiKey ONLY when the caller explicitly asked
  //    (apiKeyInline); without that opt-in the write is REFUSED — the console
  //    pushes such keys through store.connectKey first and passes no apiKey;
  //  - a literal already living in the file (options passthrough from an
  //    update route) is carried over — shape migration must never LOSE working
  //    inline config (Decision 1 keeps inline above the store for both shapes).
  const keyMaterial = def.apiKey ?? passthroughKey;
  const keyIsNew = def.apiKey !== undefined;
  if (keyMaterial !== undefined) {
    if (typeof keyMaterial !== 'string') return { error: 'apiKey must be a string' };
    const m = ENV_TEMPLATE_FULL_RE.exec(keyMaterial);
    if (m) envNames.add(m[1] as string);
    else if (def.apiKeyInline || !keyIsNew) settings.apiKey = keyMaterial;
    else
      return {
        error:
          'opencode v2 provider defs never write credentials inline — connect the key through the bound credential store (the console routes do this) or set apiKeyInline explicitly',
      };
  }

  // Explicit `def.headers` (even {}) fully replaces — presence = the whole truth,
  // so an empty map CLEARS (and never falls back to legacy `options.headers`).
  // Absent `headers` keeps a legacy `options.headers` passthrough if one exists.
  const headers =
    def.headers !== undefined
      ? Object.keys(def.headers).length > 0
        ? def.headers
        : undefined
      : passthroughHeaders;

  const node: Record<string, any> = {};
  if (def.name) node.name = def.name;
  node.package = opencodeV2PackageFor(def.npm || DEFAULT_NPM);
  if (def.canonical) node.canonical = def.canonical;
  if (envNames.size > 0) node.env = [...envNames];
  if (Object.keys(settings).length > 0) node.settings = settings;
  if (headers && Object.keys(headers).length > 0) node.headers = headers;
  if (isPlainRecord(def.body) && Object.keys(def.body).length > 0) node.body = def.body;
  const models = opencodeV2ModelDefs(def.models);
  if (models && Object.keys(models).length > 0) node.models = models;
  return { node };
}

/**
 * Provider defs from the defs file's `providers` map, normalized to the internal shape
 * (`package`≙`npm`, `settings`≙`options` — the aliasing in normalizeProviderDef).
 * The retired singular `provider` slot is not read: one shape, one home. opencode.jsonc
 * is NOT a source here — the defs file is the only def truth (the one-shot import in
 * provider-defs.ts fed it from jsonc once).
 */
function getProviderNode(): Record<string, any> {
  return normalizeSlotMap(readProviderDefsFile()?.providers ?? {});
}

/**
 * Copy-on-change normalization of the slot map (Decision 9).
 *
 * A node in the RETIRED shape (node-level `npm`/`options`) is dropped here instead
 * of passed through, so OCR never routes through a node whose v2 wire config is
 * unproven. Rationale, measured rather than assumed: opencode v2.0.0 does NOT
 * reject such a node outright — its models still enumerate (live check
 * 2026-10-23: a `npm`+`options` probe node listed its model). What it cannot be
 * shown to honor is the retired WIRE spelling, so the realistic failure is a
 * provider that looks registered while its baseURL/headers are ignored — a
 * silently wrong endpoint, worse than a missing provider. Hence: exclude loudly.
 * `legacyShapedSlotEntries()` reports the same ids with the offending paths and
 * boot-direct surfaces them in its exclusion list, so the drop is never silent.
 * (Superseded claim: an earlier revision of this comment asserted the decoder
 * discards the whole node — that was never verified and is false on 2.0.0.)
 */
function normalizeSlotMap(node: Record<string, any>): Record<string, any> {
  let normalized: Record<string, any> | undefined;
  for (const [id, def] of Object.entries(node as Record<string, unknown>)) {
    if (isPlainRecord(def) && legacyShapedProviderPaths(def as Record<string, any>).length > 0) {
      normalized ??= { ...node };
      delete normalized[id];
      continue;
    }
    const norm = normalizeProviderDef(def);
    if (norm === def) continue;
    const acc = normalized ?? { ...node };
    acc[id] = norm;
    normalized = acc;
  }
  return normalized ?? node;
}

/**
 * Entries of the defs file's `providers` map the reader drops and the writer refuses:
 * retired node shapes (node-level npm/options — see legacyShapedProviderPaths for
 * the model-level analysis: those defs are current file spelling, not retired).
 * Consumers use this to tell the operator WHY a provider they defined is missing —
 * a drop they cannot see is the bug being removed.
 */
export function legacyShapedSlotEntries(): { id: string; paths: string[] }[] {
  const entries: { id: string; paths: string[] }[] = [];
  for (const [id, def] of Object.entries(readProviderDefsFile()?.providers ?? {})) {
    if (!isPlainRecord(def)) continue;
    const paths = legacyShapedProviderPaths(def as Record<string, any>);
    if (paths.length > 0) entries.push({ id, paths });
  }
  return entries;
}

/** Raw (unmasked) provider definition from the defs file — internal use only. */
export function getProviderNodeById(id: string): any | undefined {
  const node = getProviderNode();
  const def = node[id];
  return def && typeof def === 'object' ? def : undefined;
}

/** Masked, management-safe view of every provider defined in the defs file. */
export function listConfigProviders(): OpenCodeProviderView[] {
  const node = getProviderNode();
  return Object.entries(node).map(([id, def]: [string, any]) => {
    const options = def?.options && typeof def.options === 'object' ? def.options : {};
    const models = def?.models && typeof def.models === 'object' ? Object.keys(def.models) : [];
    const inlineKey = expandEnvTemplate(options.apiKey);
    return {
      id,
      name: def?.name || undefined,
      npm: def?.npm || undefined,
      baseURL: options.baseURL || undefined,
      models,
      auth: {
        connected: Boolean(inlineKey),
        keyMasked: inlineKey ? maskSecret(inlineKey) : undefined,
        inline: Boolean(options.apiKey),
      },
    };
  });
}

/**
 * Upsert a custom provider into the OCR defs file's `providers` map, in the v2
 * node shape (`package`/`settings`/`headers`/`env`/`canonical`/`body`).
 *
 * This writer NEVER touches credential files: the bound credential store owns
 * secrets, so a non-inline key is pushed through store.connectKey once the def
 * has landed, and an inline key is an explicit apiKeyInline opt-in. Content the
 * v2 shape forbids (a retired NODE shape) is REFUSED up front — cp-failfast: a
 * rejected write is recoverable, a provider that silently vanishes from the
 * routing pool is not. Model-level defs are passed through as written (see
 * legacyShapedProviderPaths for why).
 *
 * Atomic whole-map rewrite of <ocrHome>/providers.json.
 *
 * `paths` is optional and only exists so an INJECTED path set (tests, the boot
 * bind's `BindOverrides.paths`) writes its own book instead of the env-resolved
 * one; every console route keeps relying on the default.
 */
export function upsertProviderDef(
  def: ProviderDefInput,
  paths: CredentialPaths = resolveDefaultPaths()
): { success: boolean; error?: string } {
  if (!isValidProviderId(def.id)) {
    return { success: false, error: `Invalid provider id '${def.id}' - ${PROVIDER_ID_RULE}` };
  }

  const built = buildV2ProviderNode(def);
  if (built.error) return { success: false, error: built.error };
  const node = built.node as Record<string, any>;

  const stale = legacyShapedProviderPaths(node);
  if (stale.length > 0) {
    return {
      success: false,
      error: `refused: legacy-shaped provider def for '${def.id}' (${stale.join(', ')}) — opencode v2 would drop the whole node`,
    };
  }

  try {
    const providers = { ...(readProviderDefsFile(paths)?.providers ?? {}) };
    providers[def.id] = node;
    writeProviderDefs(providers, paths);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Delete a custom provider from the defs file's `providers` map. */
export function deleteProviderDef(id: string): { success: boolean; error?: string } {
  const providers = readProviderDefsFile()?.providers ?? {};
  if (!Object.hasOwn(providers, id)) {
    return { success: false, error: `Provider '${id}' is not defined in the provider defs file` };
  }
  try {
    const next = { ...providers };
    delete next[id];
    writeProviderDefs(next);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Per-provider model maintenance (defs file `providers.<id>.models`)
// ---------------------------------------------------------------------------

/** Valid model id inside a provider's `models` map — `/` allowed (aggregator
 *  gateways return vendor-scoped ids like 'vendor/model'; the key is sent
 *  verbatim as the upstream `model` field). */
function isValidModelId(id: string): boolean {
  return Boolean(id) && /^[A-Za-z0-9][A-Za-z0-9._:\-/]*$/.test(id);
}

/**
 * Glob-style pattern match used by model pull/clear.
 * - Comma-separated alternatives (`gpt-4*, o3*`)
 * - `*` / `?` wildcards when present, otherwise case-insensitive substring
 */
export function matchesGlobPattern(pattern: string, value: string): boolean {
  const parts = pattern.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return true;
  const v = value.toLowerCase();
  return parts.some((p) => {
    if (!/[*?]/.test(p)) return v.includes(p);
    const regex = new RegExp(
      '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );
    return regex.test(v);
  });
}

/**
 * Raw model definitions of a config-defined provider ({} when the node has
 * no models yet). Values are opencode v2-read-normalized (normalizeModelDef) — the
 * returned objects are internal opencode-v1 shaped views, never the file itself.
 */
export function getProviderModelDefs(id: string): Record<string, any> | undefined {
  const def = getProviderNodeById(id);
  if (!def) return undefined;
  if (!def.models || typeof def.models !== 'object') return {};
  const out: Record<string, any> = {};
  for (const [mid, m] of Object.entries(def.models as Record<string, unknown>)) {
    out[mid] = normalizeModelDef(m);
  }
  return out;
}

/**
 * Add or replace one model inside `providers.<id>.models` (atomic defs-file
 * rewrite). `definition` is the models.dev FILE shape (flat cost cache keys,
 * keyed variants, model-level provider.npm) and is written verbatim — v2's
 * file decoder reads that shape natively (see legacyShapedProviderPaths for
 * the retired-shape analysis).
 */
export function upsertProviderModel(
  providerId: string,
  modelId: string,
  definition: Record<string, any>
): { success: boolean; error?: string } {
  if (!getProviderNodeById(providerId)) {
    return { success: false, error: `Provider '${providerId}' is not defined in the provider defs file` };
  }
  if (!isValidModelId(modelId)) {
    return { success: false, error: `Invalid model id: '${modelId}'` };
  }
  if (!definition || typeof definition !== 'object') {
    return { success: false, error: 'Model definition must be an object' };
  }
  try {
    const providers = { ...(readProviderDefsFile()?.providers ?? {}) };
    const node = { ...providers[providerId] };
    const models = { ...(node.models && typeof node.models === 'object' ? node.models : {}) };
    models[modelId] = definition;
    node.models = models;
    providers[providerId] = node;
    writeProviderDefs(providers);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Remove one model from `providers.<id>.models`. */
export function removeProviderModel(providerId: string, modelId: string): { success: boolean; error?: string } {
  const defs = getProviderModelDefs(providerId);
  if (defs === undefined) {
    return { success: false, error: `Provider '${providerId}' is not defined in the provider defs file` };
  }
  if (!(modelId in defs)) {
    return { success: false, error: `Model '${modelId}' is not defined for provider '${providerId}'` };
  }
  try {
    const providers = { ...(readProviderDefsFile()?.providers ?? {}) };
    const node = { ...providers[providerId] };
    const models = { ...(node.models && typeof node.models === 'object' ? node.models : {}) };
    delete models[modelId];
    node.models = models;
    providers[providerId] = node;
    writeProviderDefs(providers);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Reorder `providers.<id>.models` to an explicit id order.
 *
 * The defs file IS the order truth: `materializeDefs` renders the node verbatim
 * into the client config and its drift check is order-sensitive, so moving a row
 * is a real write (one client defs push), never a console-only preference.
 *
 * `ids` is advisory: ids the node does not have are ignored (a stale row must
 * never resurrect a deleted model) and ids the caller omitted keep their
 * relative order at the tail. An order that already matches is a no-op success —
 * no rewrite, so no pointless push.
 */
export function reorderProviderModels(
  providerId: string,
  ids: readonly string[]
): { success: boolean; order?: string[]; changed?: boolean; error?: string } {
  if (!getProviderNodeById(providerId)) {
    return { success: false, error: `Provider '${providerId}' is not defined in the provider defs file` };
  }
  try {
    const providers = { ...(readProviderDefsFile()?.providers ?? {}) };
    const node = { ...providers[providerId] };
    const models: Record<string, any> =
      node.models && typeof node.models === 'object' ? (node.models as Record<string, any>) : {};
    const current = Object.keys(models);
    if (current.length === 0) return { success: true, order: [], changed: false };
    const next: Record<string, any> = {};
    for (const mid of ids) {
      if (mid in models && !(mid in next)) next[mid] = models[mid];
    }
    for (const mid of current) if (!(mid in next)) next[mid] = models[mid];
    const order = Object.keys(next);
    const changed = order.length !== current.length || order.some((mid, i) => mid !== current[i]);
    if (changed) {
      node.models = next;
      providers[providerId] = node;
      writeProviderDefs(providers);
    }
    return { success: true, order, changed };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Clear models of a config-defined provider. Without a pattern the whole
 * `models` node is dropped; with a pattern only matching ids are removed
 * (a pattern that matches every id removes the empty `models` node too).
 */
export function clearProviderModels(
  providerId: string,
  pattern?: string
): { success: boolean; removed?: number; error?: string } {
  if (!getProviderNodeById(providerId)) {
    return { success: false, error: `Provider '${providerId}' is not defined in the provider defs file` };
  }
  const defs = getProviderModelDefs(providerId) || {};
  const ids = Object.keys(defs);
  if (ids.length === 0) return { success: true, removed: 0 };
  try {
    const providers = { ...(readProviderDefsFile()?.providers ?? {}) };
    const node = { ...providers[providerId] };
    const models = { ...(node.models && typeof node.models === 'object' ? node.models : {}) };
    let removed = 0;
    for (const mid of ids) {
      if (!matchesGlobPattern(pattern ?? '', mid)) continue;
      delete models[mid];
      removed++;
    }
    if (!pattern || !pattern.trim() || removed === ids.length) {
      // everything matched — drop the now-empty models node too
      delete node.models;
    } else {
      node.models = models;
    }
    providers[providerId] = node;
    writeProviderDefs(providers);
    return { success: true, removed };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

