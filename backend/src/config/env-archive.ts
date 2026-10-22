import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter, configure } from '@zip.js/zip.js';
import { parse, stringify } from 'yaml';
import { APP_VERSION } from '../version.js';
import { DEFAULT_ENV_NAME, EnvType, getEnvMeta, getEnvPaths, isValidEnvName } from './env.js';
import { sanitizeWebAuthInput } from './index.js';

// zip.js drives the AE-2 encrypted archive path AND the uniform read path;
// web workers don't exist under Bun/Node — everything stays on this thread.
configure({ useWebWorkers: false });

/* ------------------------------------------------------------------------- *
 * Environment archive ("book-set envelope") — format 'ocr-env' v1.
 *
 * A portable { config.yaml text + curated payload files } bundle. NEVER
 * contains: webAuth.passwordHash (dropped in BOTH modes), the session secret,
 * CA material, traces, capture archives, logs. Payload = the curated
 * knowledge files (judge-decision dataset, catalog customizations) that give
 * a new machine a head start; data starts empty for
 * everything else (book-set intuition: export carries KNOWLEDGE, not state).
 *
 * Redaction (default): values at adminApiKey / apiKeys[*].key become the
 * sentinel '__REDACTED__' and their paths are
 * listed in redactedPaths. `?secrets=include` exports real values instead —
 * an explicit operator decision, never the default.
 *
 * Import HARD guard — sentinel stripping: a redacted archive must not mint
 * credentials with the literal apiKey "__REDACTED__", so parseAndValidate
 * STRIPS every sentinel-valued key entirely (recursively, regardless of
 * position — a hand-crafted archive cannot smuggle the sentinel in).
 * ------------------------------------------------------------------------- */

export const ENVELOPE_FORMAT = 'ocr-env';
export const ENVELOPE_VERSION = 1;
export const REDACTION_SENTINEL = '__REDACTED__';
export const ARCHIVE_SUFFIX = '.orc_env.zip';

/** Zip transport layout: the v1
 * envelope splits into a manifest + real-path entries, so zip is a pure
 * codec and parseAndValidateEnvelope stays the single validation site. */
export const ZIP_MANIFEST_ENTRY = 'manifest.json';
export const ZIP_CONFIG_ENTRY = 'config.yaml';

/** Per-entry decompressed cap — checked against the central directory BEFORE
 * inflation, so a bomb never gets inflated at all. */
export const ZIP_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
/** Total decompressed budget across all entries (2× the 64 MB compressed body limit). */
export const ZIP_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

/** Hard cap accepted by the import route (fastify bodyLimit). */
export const IMPORT_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

export interface EnvEnvelopeSource {
  name: string;
  type: EnvType;
  appVersion: string;
}

export interface EnvEnvelope {
  format: typeof ENVELOPE_FORMAT;
  version: number;
  exportedAt: string;
  source: EnvEnvelopeSource;
  secrets: 'redacted' | 'included';
  redactedPaths: string[];
  config: string;
  payload: Record<string, string>;
  checksums: Record<string, string>;
}

/** Envelope key → on-disk file within the env (relative to the env root). */
const PAYLOAD_FILES: Array<{ key: string; resolve: (p: ReturnType<typeof getEnvPaths>) => string }> = [
  { key: 'data/layer2-decisions.jsonl', resolve: (p) => path.join(p.dataDir, 'layer2-decisions.jsonl') },
  { key: 'catalog/custom.json', resolve: (p) => path.join(p.catalogDir, 'custom.json') },
  // Field-level catalog overrides (hide/rename/cost edits made in the viewer)
  // — user-authored knowledge, unrecoverable if lost (overrides-store.ts).
  // ocr.json itself stays excluded: a sig-keyed cache that rebuilds on boot.
  { key: 'catalog/overrides.json', resolve: (p) => path.join(p.catalogDir, 'overrides.json') },
];

/**
 * The ONLY payload keys an envelope may carry (v1). Import enforces this
 * WHITELIST, not merely traversal safety: `config.yaml` / `env.json` /
 * `webauth-secret` as payload keys would silently overwrite the sanitized
 * config, flip the env type, or plant a valid session secret — a backdoored
 * book-set (L3 review P1-1).
 */
export const PAYLOAD_KEYS: readonly string[] = PAYLOAD_FILES.map((f) => f.key);

/** Only these zip entries can ever be extracted — and therefore written. */
const ZIP_ALLOWED_ENTRIES: ReadonlySet<string> = new Set([
  ZIP_MANIFEST_ENTRY,
  ZIP_CONFIG_ENTRY,
  ...PAYLOAD_KEYS,
]);

const sha256 = (text: string): string => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Archive-level failure with an HTTP-ish code for the route to map. */
export class EnvArchiveError extends Error {
  readonly code: number;
  constructor(message: string, code = 400) {
    super(message);
    this.code = code;
  }
}

/* ─── Export ─────────────────────────────────────────────────────────────── */

/**
 * Build the v1 envelope for an environment. READ-ONLY: never writes into any
 * env directory. Every env — 'default' included — exports from its own
 * envs/<name>/ tree.
 */
export function buildEnvelope(
  envName: string,
  opts: { includeSecrets: boolean; includePayload?: readonly string[] }
): EnvEnvelope {
  const paths = getEnvPaths(envName);
  if (!fs.existsSync(paths.configPath)) {
    throw new EnvArchiveError(`Environment "${envName}" has no config.yaml at ${paths.configPath}`, 404);
  }
  const raw = fs.readFileSync(paths.configPath, 'utf8');
  // `any` by design: raw parsed YAML root, mutated in place at the archive
  // boundary (same convention as config/index.ts resolveRequestCapture).
  let parsed: any;
  try {
    parsed = parse(raw);
  } catch (err: any) {
    throw new EnvArchiveError(`Environment "${envName}" config.yaml is not valid YAML: ${err?.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvArchiveError(`Environment "${envName}" config.yaml must be an object`);
  }

  // Session/login material never travels: drop the passwordHash key entirely
  // (both modes — the hash belongs to THIS install's webauth chain).
  if (parsed.webAuth && typeof parsed.webAuth === 'object') delete parsed.webAuth.passwordHash;

  // Retired hand-written def surfaces (ADR-0010) are dead config — strip them
  // from the envelope entirely. Legacy files may still carry `providers:` /
  // `systemoneUpstreams:` sections with plaintext API keys, and the redaction
  // block below no longer knows those shapes; exporting them verbatim (even
  // in a redacted archive) would leak those keys.
  for (const retired of ['providers', 'models', 'systemoneUpstreams'] as const) {
    if (parsed[retired] !== undefined) delete parsed[retired];
  }

  const redactedPaths: string[] = [];
  if (!opts.includeSecrets) {
    // Type-agnostic: redact whenever the key is present with a NON-EMPTY
    // value of ANY YAML type — a numeric `adminApiKey: 123456` is still a
    // secret (L3 review P2-1a: the old string-only check let numbers
    // straight through a "redacted" envelope).
    const redact = (obj: any, key: string, at: string) => {
      const v = obj?.[key];
      if (v !== undefined && v !== null && v !== '') {
        obj[key] = REDACTION_SENTINEL;
        redactedPaths.push(at);
      }
    };
    redact(parsed, 'adminApiKey', 'adminApiKey');
    if (Array.isArray(parsed.apiKeys)) {
      parsed.apiKeys.forEach((k: any, i: number) => redact(k, 'key', `apiKeys[${i}].key`));
    }
    // proxy.url carries inline credentials when the userinfo part has a
    // password — redact exactly then, leave plain URLs untouched (P2-1b).
    const proxyUrl = parsed.proxy?.url;
    if (typeof proxyUrl === 'string' && /:\/\/[^/@\s]+:[^/@\s]+@/.test(proxyUrl)) {
      parsed.proxy.url = REDACTION_SENTINEL;
      redactedPaths.push('proxy.url');
    }
    // opencode connector password (P2-1b).
    redact(parsed.opencode, 'password', 'opencode.password');
  }

  const payload: Record<string, string> = {};
  // includePayload selects a SUBSET of the known payload files (unknown keys
  // are ignored — the set is closed). Absent/undefined = include everything
  // that exists on disk. checksums derive from the surviving payload, so the
  // manifest always describes exactly what the archive carries.
  const wanted = opts.includePayload ? new Set(opts.includePayload) : null;
  for (const f of PAYLOAD_FILES) {
    if (wanted && !wanted.has(f.key)) continue;
    const file = f.resolve(paths);
    try {
      if (fs.statSync(file).isFile()) payload[f.key] = fs.readFileSync(file, 'utf8');
    } catch {
      // absent (or unreadable) = not included; only files that exist go in
    }
  }

  const config = stringify(parsed);
  const checksums: Record<string, string> = { config: sha256(config) };
  for (const [key, text] of Object.entries(payload)) checksums[key] = sha256(text);

  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      name: envName,
      type: envName === DEFAULT_ENV_NAME ? 'regular' : sourceType(envName),
      appVersion: APP_VERSION,
    },
    secrets: opts.includeSecrets ? 'included' : 'redacted',
    redactedPaths,
    config,
    payload,
    checksums,
  };
}

/** env.json type for the source stamp (missing env.json → 'regular'). */
function sourceType(envName: string): EnvType {
  return getEnvMeta(envName)?.type === 'sandbox' ? 'sandbox' : 'regular';
}

/* ─── Zip transport ──────────────────────────────────────────────────────── */

/**
 * Build the downloadable `.orc_env.zip`: the v1 envelope split across a
 * manifest entry + `config.yaml` + real-path payload entries. Redaction,
 * checksums and versioning all happen inside buildEnvelope — the zip adds
 * transport only.
 */
export function buildZipArchive(
  envName: string,
  opts: { includeSecrets: boolean; includePayload?: readonly string[] }
): Uint8Array {
  const { config, payload, ...manifest } = buildEnvelope(envName, opts);
  const entries: Record<string, Uint8Array> = {
    [ZIP_MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest, null, 2)),
    [ZIP_CONFIG_ENTRY]: strToU8(config),
  };
  for (const [key, text] of Object.entries(payload)) entries[key] = strToU8(text);
  return zipSync(entries);
}

/**
 * Parse an uploaded zip into the envelope shape, then hand it to the
 * UNCHANGED parseAndValidateEnvelope (checksums in the manifest cover the
 * extracted texts verbatim, so verification is byte-exact). Guards, in
 * order: whitelist filter (non-allowed entries are never extracted → never
 * written), central-directory size caps BEFORE inflation, manifest +
 * config.yaml REQUIRED. `nameOverride` retargets the imported env name
 * (query-level override — a zip cannot be renamed client-side); it still
 * passes the same reserved-name / grammar validation downstream.
 */
export async function parseZipArchiveAsync(
  bytes: Uint8Array,
  nameOverride?: string,
  password?: string,
  opts: { allowReservedName?: boolean } = {}
): Promise<EnvelopeValidation> {
  let entries: Awaited<ReturnType<ZipReader<BlobReader>['getEntries']>> = [];
  const reader = new ZipReader(new BlobReader(new Blob([bytes])), password ? { password } : undefined);
  try {
    // `tolerant` keeps hostile NAMES (e.g. `../escape.txt`) listable — the
    // whitelist below still refuses to extract them, which is the only thing
    // that matters (a rejected name would make the WHOLE archive unreadable).
    entries = await reader.getEntries({ filenameValidation: 'tolerant' });
  } catch {
    return { ok: false, code: 400, error: 'Body is not a readable zip archive' };
  }
  try {
    // Server-driven password gate: an encrypted archive without the password
    // can list its entries but MUST NOT extract them.
    if (entries.some((e) => e.encrypted) && !password) {
      return { ok: false, code: 400, error: 'Archive is encrypted — supply the x-ocr-archive-password header' };
    }
    const oversized: string[] = [];
    let total = 0;
    const texts = new Map<string, string>();
    for (const entry of entries) {
      if (entry.directory) continue;
      if (!ZIP_ALLOWED_ENTRIES.has(entry.filename)) continue;
      if (entry.uncompressedSize > ZIP_MAX_ENTRY_BYTES || total + entry.uncompressedSize > ZIP_MAX_TOTAL_BYTES) {
        oversized.push(entry.filename);
        continue;
      }
      total += entry.uncompressedSize;
      try {
        texts.set(entry.filename, await entry.getData(new TextWriter()));
      } catch {
        // Wrong password and corrupted bytes are intentionally
        // indistinguishable (single 400, no oracle).
        return { ok: false, code: 400, error: 'Archive decryption failed — wrong password or corrupted archive' };
      }
    }
    if (oversized.length > 0) {
      return {
        ok: false,
        code: 400,
        error: `Zip entry "${oversized[0]}" exceeds the decompression cap (${Math.round(ZIP_MAX_ENTRY_BYTES / (1024 * 1024))} MB per entry) — refusing a possible zip bomb`,
      };
    }
    const manifestText = texts.get(ZIP_MANIFEST_ENTRY);
    const configText = texts.get(ZIP_CONFIG_ENTRY);
    if (!manifestText || !configText) {
      return {
        ok: false,
        code: 400,
        error: `Zip archive must contain "${ZIP_MANIFEST_ENTRY}" and "${ZIP_CONFIG_ENTRY}" at its root`,
      };
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err: any) {
      return { ok: false, code: 400, error: `manifest.json is not valid JSON: ${err?.message}` };
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { ok: false, code: 400, error: 'manifest.json must be a JSON object' };
    }
    const m = manifest as Record<string, unknown>;
    if (m.format !== ENVELOPE_FORMAT) {
      return { ok: false, code: 400, error: 'Not an OCR environment archive (manifest format must be "ocr-env")' };
    }
    if (typeof nameOverride === 'string' && nameOverride) m.name = nameOverride;
    const payload: Record<string, string> = {};
    for (const key of PAYLOAD_KEYS) {
      const text = texts.get(key);
      if (text !== undefined) payload[key] = text;
    }
    return parseAndValidateEnvelope({ ...m, config: configText, payload }, opts);
  } finally {
    await reader.close().catch(() => {});
  }
}

/* ─── Encrypted archive (WinZip AE-2 via zip.js) ─────────────────────────── */

/**
 * Build the password-encrypted archive:
 * a STANDARD zip whose entries are AES-256 encrypted in WinZip AE-2 format,
 * so 360 Zip / 7-Zip / WinRAR / WinZip can open it with the password alone.
 * Chosen over the custom OCRENC1 container after the user hit the wall of
 * generic unzip tools failing on a self-describing-but-nonstandard format.
 * Trade-offs: AE-2 keys derive via PBKDF2-HMAC-SHA1
 * (fixed 1000 iterations — zip.js pins the WinZip value), so the console
 * advises a 12+ char password; the CRC-32 is stored as 0 (AE-2), so the
 * archive leaks nothing about the content; and our manifest checksums
 * (sha256 over the plaintexts) remain the strong integrity layer on import.
 * Secrets are ALWAYS plaintext inside the encrypted archive — that is the
 * point (full backup, no redaction) — so encrypt=1 implies secrets=include.
 */
export async function buildEncryptedZipArchive(
  envName: string,
  opts: { includeSecrets: boolean; includePayload?: readonly string[]; password: string }
): Promise<Uint8Array> {
  if (!opts.password) throw new EnvArchiveError('Encryption password must not be empty', 400);
  const { config, payload, ...manifest } = buildEnvelope(envName, opts);
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  const add = (name: string, text: string) =>
    writer.add(name, new TextReader(text), { password: opts.password, encryptionStrength: 3 });
  await add(ZIP_MANIFEST_ENTRY, JSON.stringify(manifest, null, 2));
  await add(ZIP_CONFIG_ENTRY, config);
  for (const [key, text] of Object.entries(payload)) await add(key, text);
  const blob = await writer.close();
  return new Uint8Array(await blob.arrayBuffer());
}

/* ─── Import validation ──────────────────────────────────────────────────── */

export type EnvelopeValidation =
  | { ok: true; name: string; type: EnvType; config: string; configWasSanitized: boolean; payload: Record<string, string>; source: EnvEnvelopeSource | null }
  | { ok: false; code: number; error: string };

/** Grammar check for an archive-relative payload key (no dir needed). */
function isSafeRelKey(relKey: string): boolean {
  if (typeof relKey !== 'string' || relKey.length === 0) return false;
  if (relKey.includes('\0')) return false;
  if (/^[A-Za-z]:[\\/]/.test(relKey)) return false; // drive-letter absolute
  if (relKey.startsWith('/') || relKey.startsWith('\\')) return false;
  if (path.isAbsolute(relKey)) return false;
  return relKey.split(/[\\/]/).every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Safe join of an archive-relative key inside a target directory. Returns
 * null for absolute / drive-letter / '..'-segment / NUL / empty-segment keys,
 * and RE-VERIFIES the resolved prefix before any write (mirror of the
 * static-asset guard in routes/console.ts).
 */
export function safeResolveWithin(dir: string, relKey: string): string | null {
  if (!isSafeRelKey(relKey)) return null;
  const target = path.resolve(dir, ...relKey.split(/[\\/]/));
  const root = path.resolve(dir);
  if (!(target === root || target.startsWith(root + path.sep))) return null;
  return target;
}

/**
 * Prototype-pollution-adjacent keys the yaml parser CAN surface as own
 * properties (probed against the bundled `yaml` version: `__proto__:` yields
 * an own enumerable key WITHOUT changing the prototype or polluting globals,
 * and Object.entries() sees it). Object spread tolerates them, but plain
 * `result[k] = v` in a re-builder would hit the __proto__ SETTER — so every
 * reconstruction site must drop these keys (L3 P3-4).
 */
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Recursively drop entries whose value is the redaction sentinel — import
 * must NEVER keep "__REDACTED__" as a literal key/api value. Arrays keep
 * their non-sentinel elements. Dangerous keys (__proto__/constructor/
 * prototype) are dropped the same way: they must never reach the written
 * config. Returns the cleaned node + whether anything was removed.
 * Object.entries() keeps iteration own-property-only (no inherited surprises).
 */
function stripSentinels(node: unknown): { value: unknown; removed: boolean } {
  if (Array.isArray(node)) {
    let removed = false;
    const out: unknown[] = [];
    for (const el of node) {
      if (el === REDACTION_SENTINEL) {
        removed = true;
        continue;
      }
      const r = stripSentinels(el);
      if (r.removed) removed = true;
      out.push(r.value);
    }
    return { value: out, removed };
  }
  if (node && typeof node === 'object') {
    let removed = false;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (DANGEROUS_KEYS.includes(k)) {
        removed = true; // never re-assign these onto a fresh object (setter/own-prop semantics)
        continue;
      }
      if (v === REDACTION_SENTINEL) {
        removed = true; // key dropped entirely — the operator re-supplies a real value
        continue;
      }
      const r = stripSentinels(v);
      if (r.removed) removed = true;
      result[k] = r.value;
    }
    return { value: result, removed };
  }
  return { value: node, removed: false };
}

/**
 * Full envelope validation: format/version/name/config/payload-key grammar/
 * checksums (REQUIRED, fail loud on mismatch), then the sanitizing chain:
 * sentinel strip → passwordHash strip → sanitizeWebAuthInput → re-serialize
 * only when something was stripped (clean archives keep their exact text).
 */
export function parseAndValidateEnvelope(
  body: unknown,
  opts: { allowReservedName?: boolean } = {}
): EnvelopeValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 400, error: 'Archive payload must be the ocr-env envelope object (manifest + extracted texts)' };
  }
  // `any` view of the untrusted request body — every field is type-checked
  // below before use (cp-boundary: validate at entry, then trust locally).
  const env = body as Record<string, any>;

  if (env.format !== ENVELOPE_FORMAT) {
    return { ok: false, code: 400, error: 'Not an OCR environment archive (format must be "ocr-env")' };
  }
  if (typeof env.version !== 'number' || !Number.isFinite(env.version) || env.version < 1) {
    return { ok: false, code: 400, error: 'Missing or invalid envelope version' };
  }
  if (env.version > ENVELOPE_VERSION) {
    return {
      ok: false,
      code: 400,
      error: `Environment archive v${env.version} comes from a newer OCR (this build understands up to v${ENVELOPE_VERSION}) — upgrade OCR to import it`,
    };
  }

  const name = env.name ?? env.source?.name;
  if (typeof name !== 'string' || !isValidEnvName(name)) {
    return { ok: false, code: 400, error: `Envelope env name ${JSON.stringify(name)} is not a valid environment name` };
  }
  // Reserved names are import targets ONLY in replace mode (restoring over
  // the bootstrap `default`); create-mode imports must pick a fresh name.
  if (!opts.allowReservedName && (name.toLowerCase() === DEFAULT_ENV_NAME || name.toLowerCase() === 'current')) {
    return { ok: false, code: 400, error: `Environment name "${name}" is reserved` };
  }

  if (typeof env.config !== 'string') {
    return { ok: false, code: 400, error: 'Envelope config must be a YAML string' };
  }
  let parsedConfig: any;
  try {
    parsedConfig = parse(env.config);
  } catch (err: any) {
    return { ok: false, code: 400, error: `Envelope config is not valid YAML: ${err?.message}` };
  }
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
    return { ok: false, code: 400, error: 'Envelope config must be a YAML object' };
  }

  if (!env.payload || typeof env.payload !== 'object' || Array.isArray(env.payload)) {
    return { ok: false, code: 400, error: 'Envelope payload must be an object of relative-path → text' };
  }
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(env.payload as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return { ok: false, code: 400, error: `Payload "${key}" must be a text string (v1 archives are text-only)` };
    }
    // Key grammar is validated HERE (shared validator) so no caller — route,
    // CLI, or future import path — can forget the traversal guard. The write
    // site re-resolves the prefix before touching disk (defense in depth).
    if (!isSafeRelKey(key)) {
      return { ok: false, code: 400, error: `Payload key "${key}" is not a safe environment-relative path` };
    }
    // P1-1 whitelist: traversal-safe is not enough — reserved env filenames
    // (config.yaml / env.json / webauth-secret) would overwrite sanitized
    // content AFTER the sanitizer wrote it. Only known data files import.
    if (!PAYLOAD_KEYS.includes(key)) {
      return {
        ok: false,
        code: 400,
        error: `Unsupported payload key "${key}" — v1 archives carry only: ${PAYLOAD_KEYS.join(', ')}`,
      };
    }
    payload[key] = value;
  }

  if (!env.checksums || typeof env.checksums !== 'object' || Array.isArray(env.checksums)) {
    return { ok: false, code: 400, error: 'Envelope checksums are required (sha256 over config + each payload entry)' };
  }
  const checksums = env.checksums as Record<string, unknown>;
  const knownKeys = new Set(['config', ...Object.keys(payload)]);
  for (const key of Object.keys(checksums)) {
    if (!knownKeys.has(key)) {
      return { ok: false, code: 400, error: `Checksum references unknown entry "${key}"` };
    }
  }
  const expect = (key: string, text: string) => {
    const want = checksums[key];
    if (typeof want !== 'string') {
      return `Checksum for "${key}" is missing`;
    }
    if (want !== sha256(text)) {
      return `Checksum mismatch for "${key}" — archive is corrupted or tampered with`;
    }
    return null;
  };
  // Checksums cover the EXACT stored strings; sanitizing happens after.
  const configErr = expect('config', env.config);
  if (configErr) return { ok: false, code: 400, error: configErr };
  for (const [key, text] of Object.entries(payload)) {
    const err = expect(key, text);
    if (err) return { ok: false, code: 400, error: err };
  }

  // Sanitizing chain: strip sentinels, then never-importable login material.
  const stripped = stripSentinels(parsedConfig);
  let sanitized: Record<string, unknown> = stripped.value as Record<string, unknown>;
  let passwordHashDropped = false;
  if (sanitized.webAuth && typeof sanitized.webAuth === 'object') {
    const wa = { ...(sanitized.webAuth as Record<string, unknown>) };
    if ('passwordHash' in wa) {
      delete wa.passwordHash;
      passwordHashDropped = true;
    }
    // Existing sanitizer: drops plaintext `password` residue (hashes only).
    const clean = sanitizeWebAuthInput(wa);
    if (clean) sanitized.webAuth = clean;
    else delete sanitized.webAuth;
  }
  const needsRewrite = stripped.removed || passwordHashDropped;
  const configOut = needsRewrite ? stringify(sanitized) : env.config;

  const source: EnvEnvelopeSource | null =
    env.source && typeof env.source === 'object'
      ? {
          name: typeof env.source.name === 'string' ? env.source.name : name,
          type: env.source.type === 'sandbox' ? 'sandbox' : 'regular',
          appVersion: typeof env.source.appVersion === 'string' ? env.source.appVersion : 'unknown',
        }
      : null;

  return {
    ok: true,
    name,
    type: source?.type ?? 'regular',
    config: configOut,
    configWasSanitized: needsRewrite,
    payload,
    source,
  };
}
