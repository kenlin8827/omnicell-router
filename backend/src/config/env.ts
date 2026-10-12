import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';

/* ------------------------------------------------------------------------- *
 * Named environments ("book-sets") — single source of truth for which
 * environment the process runs in and where every state file lives.
 *
 * Resolution precedence (highest first):
 *   1. process.env.OCR_ENV          (explicit, per-process)
 *   2. pointer file  <home>/envs/current   (one-line env name)
 *   3. the "default" bootstrap environment
 *
 * Environment levers: OCR_ENV / OCR_HOME come from the REAL process environment
 * only — OCR ships no .env loader (dotenv was removed entirely, ADR-0018).
 * Because the Bun runtime auto-loads a cwd `.env` by itself, every
 * entry point (package.json scripts, the daemon's spawned child, the isolated
 * test runner) passes `--no-env-file`: a stray file in a checkout can never
 * outrank the pointer file and decide which book-set boots.
 *
 * EVERY environment is a directory, `default` included — there is no legacy
 * path mode (supersedes ADR-0017 Decision 1). The pre-environments locations
 * (cwd/repo-root config.yaml, <cwd>/{data,models}, <home>/{catalog,traces,
 * capture,webauth-secret}) are NOT read by any code path: an install coming
 * from that layout starts empty, which is a deliberate operator choice.
 *
 * `default` is the bootstrap tier: when neither OCR_ENV nor the pointer names
 * an env, it resolves, and ensureEnvScaffold() materializes the directory on
 * first boot. It stays reserved (never created/renamed/trashed by hand) so the
 * fallback tier can never be lost.
 *
 * An env lives entirely under <home>/envs/<name>/:
 *   config.yaml · data/ · models/ · catalog/ · traces/ · capture/ · webauth-secret
 *
 * Fail-fast: OCR_ENV (or a well-formed pointer) naming a non-existent env is a
 * startup ERROR — never a silent fallback. The ONE controlled exception is a
 * corrupted/unparsable pointer file: fall back to default with a single warn
 * (a garbage pointer is a broken file, not an operator decision).
 *
 * Switching environments requires a gateway restart (module-level singletons
 * cache the resolution) — by design: the running process must never mix
 * book-sets mid-flight.
 * ------------------------------------------------------------------------- */

/** The bootstrap environment (reserved name, materialized on first boot). */
export const DEFAULT_ENV_NAME = 'default';

/** Pointer filename under <home>/envs/ — reserved, never a valid env name. */
const POINTER_FILE = 'current';

/**
 * Env name grammar: alphanumeric start, then up to 31 more of [A-Za-z0-9_-]
 * (32 chars max). Case-insensitive equality is enforced separately (see
 * findExistingEnvNameCi) so two envs can never collide on case-insensitive
 * filesystems and both be reachable.
 */
const ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** Names that can never be created as a user env (bootstrap tier / pointer file). */
const RESERVED_NAMES = [DEFAULT_ENV_NAME, POINTER_FILE];

export type EnvType = 'regular' | 'sandbox';

/** env.json metadata shape (schemaVersion 1). */
export interface EnvMeta {
  name: string;
  type: EnvType;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  schemaVersion: number;
  description?: string;
}

/** Where every state file of an environment lives. */
export interface EnvPaths {
  configPath: string;
  dataDir: string;
  modelsDir: string;
  catalogDir: string;
  tracesDir: string;
  captureDir: string;
  webauthSecretPath: string;
}

/** Console-facing env listing entry (Phase 2 UI). */
export interface EnvInfo {
  name: string;
  type: EnvType;
  dir: string;
  configPath: string;
  createdAt: string | null;
  description?: string;
  /** True for the env the next boot resolves (OCR_ENV/pointer, lenient). */
  active: boolean;
}

const ENV_SCHEMA_VERSION = 1;

/* ─── Directory primitives ───────────────────────────────────────────────── */

/** <home>/envs — parent of every named env, and home of the pointer file. */
export function getEnvsRootDir(): string {
  return path.join(getOcrHomeDir(), 'envs');
}

function envDir(name: string): string {
  return path.join(getEnvsRootDir(), name);
}

function pointerFile(): string {
  return path.join(getEnvsRootDir(), POINTER_FILE);
}

function envMetaPath(name: string): string {
  return path.join(envDir(name), 'env.json');
}

/* ─── Name validation ────────────────────────────────────────────────────── */

export function isValidEnvName(name: string): boolean {
  return typeof name === 'string' && ENV_NAME_RE.test(name);
}

/** True when the env directory exists (case-sensitive lookup). */
export function envExists(name: string): boolean {
  if (!isValidEnvName(name)) return false; // path-traversal guard
  try {
    return fs.statSync(envDir(name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reject ungrammatical or reserved names with a thrown Error (create/rename/
 * pointer-write boundary). Case-insensitive reserved-word check: `DEFAULT`
 * must not shadow the bootstrap env on case-sensitive filesystems.
 */
function assertValidNewName(name: string, what: string): void {
  if (!isValidEnvName(name)) {
    throw new Error(`[OCR env] ${what} "${name}" is invalid: env names match ${ENV_NAME_RE} (max 32 chars).`);
  }
  if (RESERVED_NAMES.includes(name.toLowerCase())) {
    throw new Error(`[OCR env] ${what} "${name}" is a reserved name (${RESERVED_NAMES.join(', ')}).`);
  }
}

/**
 * A name that passes grammar but whose env directory is missing → loud error.
 * `default` is exempt: it is the bootstrap tier and is created on first boot
 * (ensureEnvScaffold), so naming it before it exists is a fresh install, not
 * a typo.
 */
function assertEnvResolvable(name: string, source: string): void {
  if (name !== DEFAULT_ENV_NAME && !envExists(name)) {
    throw new Error(
      `[OCR env] ${source} selects environment "${name}", which does not exist under ${getEnvsRootDir()}. ` +
        `Create it or clear ${source} — refusing to silently fall back to a different book-set.`
    );
  }
}

/* ─── Pointer file ───────────────────────────────────────────────────────── */

let pointerCorruptionWarned = false;

/**
 * Read <home>/envs/current. Returns the env name, or null when the file is
 * absent / empty (treated as "no pointer"). A file that exists but cannot be
 * parsed as a single valid env name is CORRUPTED: warn once, return null
 * (fall back to default) — the one deliberate exception to fail-fast.
 */
export function readPointer(): string | null {
  const file = pointerFile();
  let content: string;
  try {
    if (!fs.statSync(file).isFile()) return null; // a directory named "current" is not a pointer
    content = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    warnPointerCorruption(file, `unreadable (${err?.message})`);
    return null;
  }
  const trimmed = content.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length !== 1 || !isValidEnvName(lines[0])) {
    warnPointerCorruption(file, `expected one line with a valid env name, got ${JSON.stringify(trimmed)}`);
    return null;
  }
  return lines[0];
}

function warnPointerCorruption(file: string, detail: string): void {
  if (pointerCorruptionWarned) return; // once per process (fail-fast relaxed by design)
  pointerCorruptionWarned = true;
  console.warn(`[OCR env] Corrupted pointer file ${file}: ${detail} — falling back to "${DEFAULT_ENV_NAME}".`);
}

/** Atomic pointer write (tmp + rename) so a concurrent read never sees a partial line. */
export function writePointer(name: string): void {
  if (name !== DEFAULT_ENV_NAME && !isValidEnvName(name)) {
    throw new Error(`[OCR env] Cannot write pointer: "${name}" is not a valid environment name.`);
  }
  const root = getEnvsRootDir();
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, POINTER_FILE);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${name}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function removePointer(): void {
  try {
    fs.rmSync(pointerFile(), { force: true });
  } catch {
    // best effort: a stale pointer for a trashed env fails fast at next boot
    // with a clear message, which is safer than a silent wrong-book-set boot.
  }
}

/**
 * Delete the pointer file (undo of writePointer). Used by trashEnv for the
 * trashed env and by the switch route's rollback when a spawn fails and the
 * previous state was "no pointer".
 */
export function clearPointer(): void {
  removePointer();
}

/* ─── Path computation (one layout: <home>/envs/<name>/) ─────────────────── */

function computeEnvPaths(name: string): EnvPaths {
  if (!isValidEnvName(name)) {
    throw new Error(`[OCR env] getEnvPaths("${name}") rejected: not a valid environment name.`);
  }
  const dir = envDir(name);
  return {
    configPath: path.join(dir, 'config.yaml'),
    dataDir: path.join(dir, 'data'),
    modelsDir: path.join(dir, 'models'),
    catalogDir: path.join(dir, 'catalog'),
    tracesDir: path.join(dir, 'traces'),
    captureDir: path.join(dir, 'capture'),
    webauthSecretPath: path.join(dir, 'webauth-secret'),
  };
}

/* ─── Resolution + module-level cache ────────────────────────────────────── */

let cachedEnvName: string | undefined;
const cachedEnvPaths = new Map<string, EnvPaths>();

function computeEnvName(): string {
  const raw = (process.env.OCR_ENV || '').trim();
  if (raw) {
    if (!isValidEnvName(raw)) {
      throw new Error(
        `[OCR env] OCR_ENV="${raw}" is not a valid environment name (pattern ${ENV_NAME_RE}, max 32 chars).`
      );
    }
    assertEnvResolvable(raw, 'OCR_ENV');
    return raw;
  }
  const pointer = readPointer();
  if (pointer) {
    assertEnvResolvable(pointer, `pointer file ${pointerFile()}`);
    return pointer;
  }
  // Bootstrap tier: a fresh install resolves to `default`, whose directory
  // ensureEnvScaffold() materializes during boot.
  return DEFAULT_ENV_NAME;
}

/** Active env name, resolved once per process (switch = restart). */
export function resolveEnvName(): string {
  if (cachedEnvName === undefined) cachedEnvName = computeEnvName();
  return cachedEnvName;
}

/**
 * Lenient "what the NEXT boot would pick" name: same precedence chain
 * WITHOUT the fail-fast existence assert (an invalid OCR_ENV falls through
 * to pointer/default here). Lists and CLI markers use this so a broken env
 * var can never prevent the operator from SEEING the envs to fix things —
 * fail-fast stays reserved for actual gateway boot via resolveEnvName().
 */
export function peekEnvName(): string {
  const raw = (process.env.OCR_ENV || '').trim();
  if (raw && isValidEnvName(raw)) return raw;
  const ptr = readPointer();
  return ptr ?? DEFAULT_ENV_NAME;
}

/** Where every state file of an environment lives (name defaults to the active env). */
export function getEnvPaths(name?: string): EnvPaths {
  const key = name ?? resolveEnvName();
  let paths = cachedEnvPaths.get(key);
  if (!paths) {
    paths = computeEnvPaths(key);
    cachedEnvPaths.set(key, paths);
  }
  return paths;
}

/**
 * Base directory for relative paths stored in config (flywheel datasetPath,
 * model paths): the env root <home>/envs/<name>, so a default-shaped
 * "./data/x.jsonl" always lands inside the environment's own data/ directory.
 */
export function getEnvRootDir(): string {
  return path.dirname(getEnvPaths().dataDir);
}

/* ─── env.json metadata ──────────────────────────────────────────────────── */

function readEnvMeta(name: string): EnvMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(envMetaPath(name), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string') return null;
    return parsed as EnvMeta;
  } catch {
    return null;
  }
}

function writeEnvMeta(meta: EnvMeta): void {
  fs.writeFileSync(envMetaPath(meta.name), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/** Existing dir whose name equals `name` ignoring case (undefined when none). */
function findExistingEnvNameCi(name: string): string | undefined {
  const lower = name.toLowerCase();
  try {
    return fs
      .readdirSync(getEnvsRootDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.toLowerCase() === lower)
      .map((d) => d.name)[0];
  } catch {
    return undefined;
  }
}

function assertEnvDirExists(name: string, what: string): void {
  if (!envExists(name)) {
    throw new Error(`[OCR env] Cannot ${what}: environment "${name}" does not exist under ${getEnvsRootDir()}.`);
  }
}

/* ─── CRUD (consumed by Phase 2 routes) ──────────────────────────────────── */

/**
 * Materialize an environment's on-disk tree (idempotent, never overwrites):
 * the env directory, its five state dirs, and env.json when absent. Boot calls
 * this for the resolved env so the bootstrap `default` — and any env whose
 * config.yaml appeared before its tree did — is ready for the first write.
 */
export function ensureEnvScaffold(name: string): EnvPaths {
  const paths = getEnvPaths(name);
  for (const dir of [envDir(name), paths.dataDir, paths.modelsDir, paths.catalogDir, paths.tracesDir, paths.captureDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(envMetaPath(name))) {
    writeEnvMeta({ name, type: 'regular', createdAt: new Date().toISOString(), schemaVersion: ENV_SCHEMA_VERSION });
  }
  return paths;
}

/**
 * Create <home>/envs/<name>/ with env.json metadata and a blank (annotated
 * default template) config.yaml. Does NOT touch the pointer — switching is a
 * separate, restart-requiring step.
 */
export async function createEnv(opts: { name: string; type?: EnvType; description?: string }): Promise<EnvInfo> {
  const { name } = opts;
  assertValidNewName(name, 'new environment name');
  if (findExistingEnvNameCi(name)) {
    throw new Error(`[OCR env] Cannot create "${name}": an environment with that name already exists (case-insensitive).`);
  }
  const dir = envDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const meta: EnvMeta = {
    name,
    type: opts.type ?? 'regular',
    createdAt: new Date().toISOString(),
    schemaVersion: ENV_SCHEMA_VERSION,
    ...(opts.description ? { description: opts.description } : {}),
  };
  writeEnvMeta(meta);
  // Blank config = the same annotated DEFAULT_CONFIG template a fresh install
  // gets. Dynamic import: config/index.ts statically imports this module, so
  // a static cycle here would evaluate config/index.ts against a partial env.ts.
  const configPath = getEnvPaths(name).configPath;
  if (!fs.existsSync(configPath)) {
    const { defaultConfigYaml } = await import('./index.js');
    fs.writeFileSync(configPath, defaultConfigYaml(), 'utf8');
  }
  return toEnvInfo(name);
}

/**
 * Recreate the env skeleton after a replace-mode trash (import restore).
 * Unlike createEnv this ALLOWS reserved names — the only caller is the
 * import route replacing an existing env, bootstrap `default` included —
 * and it writes NO blank config: the archive's own config.yaml is written
 * right after by the import pipeline. Type defaults to regular; a sandbox
 * archive restoring into a non-default env keeps its type.
 */
export async function recreateEnv(opts: { name: string; type?: EnvType; description?: string }): Promise<EnvInfo> {
  ensureEnvScaffold(opts.name);
  writeEnvMeta({
    name: opts.name,
    type: opts.type ?? 'regular',
    createdAt: new Date().toISOString(),
    schemaVersion: ENV_SCHEMA_VERSION,
    ...(opts.description ? { description: opts.description } : {}),
  });
  return toEnvInfo(opts.name);
}

/** Rename an env (directory + env.json name; follows the pointer if it pointed at `from`). */
export function renameEnv(from: string, to: string): EnvInfo {
  assertEnvDirExists(from, 'rename');
  assertValidNewName(to, 'new environment name');
  const clash = findExistingEnvNameCi(to);
  if (clash && clash !== from) {
    throw new Error(`[OCR env] Cannot rename "${from}" → "${to}": "${clash}" already exists (case-insensitive).`);
  }
  if (from === to) return toEnvInfo(to); // pointer/case no-op rename still keeps metadata canonical
  fs.renameSync(envDir(from), envDir(to));
  const meta = readEnvMeta(to);
  if (meta) {
    meta.name = to;
    writeEnvMeta(meta);
  }
  // Case-insensitive pointer match: names allow mixed case and pointer/dir
  // lookups behave case-insensitively on Windows filesystems (L3 P3-2).
  const ptr = readPointer();
  if (ptr && ptr.toLowerCase() === from.toLowerCase()) writePointer(to);
  return toEnvInfo(to);
}

/**
 * Move an env directory into <home>/envs/.trash/<name>-<timestamp> (NOT a
 * delete — recoverable until the operator empties the trash). Clears the
 * pointer when it pointed at the trashed env. The bootstrap default can never
 * be trashed by the DELETE route: it is the tier every resolution falls back
 * to, and a delete leaves it GONE. The import-replace path passes
 * `allowBootstrap` because its end state keeps `default` in existence
 * (trash → scaffold → archive content) — a recoverable overwrite, not a
 * removal (ADR-0017 D5).
 */
export function trashEnv(name: string, opts: { allowBootstrap?: boolean } = {}): string {
  if (name.toLowerCase() === DEFAULT_ENV_NAME && !opts.allowBootstrap) {
    throw new Error(`[OCR env] Cannot trash "${DEFAULT_ENV_NAME}": it is the bootstrap environment every resolution falls back to.`);
  }
  assertEnvDirExists(name, 'trash');
  const trashRoot = path.join(getEnvsRootDir(), '.trash');
  fs.mkdirSync(trashRoot, { recursive: true });
  const dest = path.join(trashRoot, `${name}-${Date.now()}`);
  fs.renameSync(envDir(name), dest);
  // Case-insensitive pointer match (Windows FS semantics on mixed-case names).
  const ptr = readPointer();
  if (ptr && ptr.toLowerCase() === name.toLowerCase()) removePointer();
  return dest;
}

/**
 * Sandbox reset: wipe data/traces/capture, keep config.yaml and env.json.
 * Only envs created with type 'sandbox' qualify — a regular env's training
 * data and traces are never auto-deleted.
 */
export function resetSandboxEnv(name: string): void {
  assertEnvDirExists(name, 'reset');
  const meta = readEnvMeta(name);
  if (meta?.type !== 'sandbox') {
    throw new Error(`[OCR env] Cannot reset "${name}": only sandbox environments can be reset (type is "${meta?.type ?? 'unknown'}").`);
  }
  const paths = getEnvPaths(name);
  for (const dir of [paths.dataDir, paths.tracesDir, paths.captureDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** All environments: the bootstrap "default" first, then every env.json-backed dir. */
export function listEnvs(): EnvInfo[] {
  const infos: EnvInfo[] = [toEnvInfo(DEFAULT_ENV_NAME)];
  try {
    for (const d of fs.readdirSync(getEnvsRootDir(), { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      if (!isValidEnvName(d.name) || d.name.toLowerCase() === DEFAULT_ENV_NAME) continue;
      infos.push(toEnvInfo(d.name));
    }
  } catch {
    // no envs/ directory yet — only the bootstrap default is listed
  }
  return infos;
}

/** env.json metadata for a named env (null when absent/unparsable). */
export function getEnvMeta(name: string): EnvMeta | null {
  if (!isValidEnvName(name)) return null; // traversal guard on the arg
  return readEnvMeta(name);
}

/** Update description on an existing env.json (undefined clears the key). */
export function setEnvDescription(name: string, description?: string): EnvMeta {
  assertEnvDirExists(name, 'update metadata');
  const meta = readEnvMeta(name);
  if (!meta) {
    throw new Error(`[OCR env] Cannot update metadata: environment "${name}" has no readable env.json.`);
  }
  if (description === undefined || description === null || description === '') delete meta.description;
  else meta.description = String(description);
  writeEnvMeta(meta);
  return meta;
}

function toEnvInfo(name: string): EnvInfo {
  const paths = getEnvPaths(name);
  const meta = readEnvMeta(name);
  return {
    name,
    type: meta?.type ?? 'regular',
    dir: envDir(name),
    configPath: paths.configPath,
    createdAt: meta?.createdAt ?? null,
    ...(meta?.description ? { description: meta.description } : {}),
    // Lenient "what the next boot resolves" flag (peekEnvName) — listing a
    // broken OCR_ENV must not throw; the boot fail-fast lives in
    // resolveEnvName and the running gate's booted env comes via the
    // routes' separate `running` field.
    active: peekEnvName() === name,
  };
}

/* ─── Test seam ──────────────────────────────────────────────────────────── */

/** Drop all cached resolution + the once-per-process pointer warn flag. */
export function __resetEnvResolutionForTests(): void {
  cachedEnvName = undefined;
  cachedEnvPaths.clear();
  pointerCorruptionWarned = false;
}
