/**
 * Local GGUF model registry + downloader (Local Models marketplace).
 *
 * A "model" here is one downloaded file from a HuggingFace repo — the unit
 * llama-server actually loads. Files live at
 * `<ocrHome>/models/<owner>/<name>/<filename>.gguf` and the registry at
 * `<ocrHome>/models/installed.json` mirrors the engine registry's shape.
 *
 * Downloads reuse the engine asset pipeline (`proxy/asset-download`): a
 * `.part` file plus a validator sidecar survive a cancel or a crash, the
 * next attempt resumes with `Range`/`If-Range`, and an LFS sha256 (the Hub
 * publishes it in the tree API) is verified before a record is written —
 * resume is never a way to serve spliced weights.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanupAssetPart,
  downloadAssetToFile,
  withAssetLock,
} from '../proxy/asset-download.js';
import { hfFileUrl, isValidRepoId, parseGgufQuant, parseParamsB, SHARD_RE } from './hf.js';
import { engineById, engineSupportFor } from './engines.js';
import type { EngineServeVerdict } from './engine-runtime.js';
import { readGgufMeta } from './gguf.js';
import type { StrataProfile } from './strata.js';
import { resolveHfToken, resolveModelsDir } from './settings.js';

/** Model weights run far past engine archives; 512GB is a sanity ceiling. */
const MAX_MODEL_BYTES = 512 * 1024 * 1024 * 1024;

/** Header facts cached on a model record after the first GGUF scan (the
 *  engine badges and the run planner read these without re-parsing). */
export interface InstalledModelMeta {
  /** When the header was read (ms epoch). */
  at: number;
  arch?: string;
  name?: string;
  layers?: number;
  maxCtx?: number;
  experts?: number;
  expertsUsed?: number;
  /** Attention geometry for the KV estimate (heads/kvHeads/headDim). */
  heads?: number;
  kvHeads?: number;
  headDim?: number;
  embedding?: number;
  /** Engines that can serve the file through the runner (ADR-0039). */
  runnable: string[];
  moe: boolean;
  /** Per-engine verdicts (serves / family / needsSetup / reason), so the
   *  console can explain a blocked engine without hardcoding its id. */
  engines?: Record<string, EngineServeVerdict>;
  /** Header-scan generation. Bumped whenever a gate's ANSWER can change for an
   *  unchanged file (a new engine, a widened family list, a new verdict field),
   *  so cached rows re-derive once instead of showing a stale "unsupported". */
  scanVersion?: number;
  /** @deprecated ADR-0039: read `engines[id].family`. Only records cached
   *  before the migration carry it; it is never written anew. */
  strataFamily?: boolean;
}

export interface InstalledModel {
  /** Registry key: `<repo>/<filename>` — unique, and the delete route's id. */
  id: string;
  /**
   * Operator-chosen short name (ADR-0038 §7). When set, the model's gateway
   * registration id is `local/<name>` instead of `local/<repo>/<filename>`,
   * and it is the name the launched server answers as (`servedNameFor`).
   * Optional: an unset name keeps the registry-id spelling. The registry key
   * above never changes — runs, profiles and the file on disk stay anchored
   * to it, so a rename touches only the gateway-visible id.
   */
  name?: string;
  repo: string;
  filename: string;
  /** Absolute path of the stored file. */
  filePath: string;
  size: number;
  quant?: string;
  paramsB?: number;
  /** Bytes an interrupted earlier attempt had already fetched. */
  resumedFrom?: number;
  downloadedAt: number;
  meta?: InstalledModelMeta;
  /**
   * Operator-supplied launch profiles, keyed by engine id (ADR-0039 — the
   * generalised form of ADR-0038 §4). A profile lives on the RECORD, not in a
   * global setting, because its inputs are per-model build artifacts: the
   * profile is exactly as portable as the model it describes. Presence is what
   * lets that engine claim the file as runnable.
   */
  profiles?: Record<string, unknown>;
  /**
   * @deprecated Single-engine spelling kept for records written before
   * ADR-0039. Always read profiles through `profilesOf`/`profileFor`; the next
   * write migrates the value into `profiles`.
   */
  strata?: StrataProfile;
}

export function modelsRoot(): string {
  return resolveModelsDir().dir;
}

function modelsStateFile(): string {
  return path.join(modelsRoot(), 'installed.json');
}

export function readInstalledModels(): Record<string, InstalledModel> {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsStateFile(), 'utf8')) as Record<string, InstalledModel>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeInstalledModels(state: Record<string, InstalledModel>): void {
  fs.mkdirSync(modelsRoot(), { recursive: true });
  fs.writeFileSync(modelsStateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Every stored profile for one model, legacy fields folded in. The single
 * read path: nothing outside this module should touch `record.strata`.
 */
export function profilesOf(row: InstalledModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (row.profiles && typeof row.profiles === 'object') Object.assign(out, row.profiles);
  if (row.strata && out.strata === undefined) out.strata = row.strata;
  return out;
}

/** The stored profile of one engine, or undefined when unset. */
export function profileFor(row: InstalledModel, engineId: string): unknown {
  return profilesOf(row)[engineId];
}

/**
 * Current header-scan generation; see `InstalledModelMeta.scanVersion`.
 *
 * 3: Strata's verdict stopped depending on a stored profile and started
 * depending on whether its workspace resolves on disk (ADR-0039 §8). A cached
 * row from generation 2 answers a question this build no longer asks, so it is
 * re-derived once rather than leaving the console on a stale "needs setup".
 *
 * 4: verdicts gained `buildable` (ADR-0039 §9 — the missing pack is one the
 * engine can build itself). A generation-3 row carries a pack refusal WITHOUT
 * the flag, so the console would never offer the build action until the row
 * was re-derived for another reason.
 *
 * 5: Strata's layout moved under the gateway home (ADR-0039 §13). A generation-4
 * row can say `serves: true` because the model file sat inside a developer
 * checkout the gateway no longer consults, and it never carries `buildable`
 * for a model whose only gap is the pack under `<ocrHome>/strata/data`.
 */
export const META_SCAN_VERSION = 5;

/** Read + cache the GGUF header facts for one record (badges, planner). */
function metaFor(row: InstalledModel): InstalledModelMeta {
  const parsed = readGgufMeta(row.filePath);
  const support = engineSupportFor(row.filePath, parsed.ok ? parsed : null, profilesOf(row));
  return {
    at: Date.now(),
    scanVersion: META_SCAN_VERSION,
    ...(parsed.arch ? { arch: parsed.arch } : {}),
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.layers != null ? { layers: parsed.layers } : {}),
    ...(parsed.maxCtx != null ? { maxCtx: parsed.maxCtx } : {}),
    ...(parsed.experts != null ? { experts: parsed.experts } : {}),
    ...(parsed.expertsUsed != null ? { expertsUsed: parsed.expertsUsed } : {}),
    ...(parsed.heads != null ? { heads: parsed.heads } : {}),
    ...(parsed.kvHeads != null ? { kvHeads: parsed.kvHeads } : {}),
    ...(parsed.headDim != null ? { headDim: parsed.headDim } : {}),
    ...(parsed.embedding != null ? { embedding: parsed.embedding } : {}),
    runnable: support.runnable,
    moe: support.moe,
    engines: support.engines,
    // `strataFamily` is deliberately not re-derived: every family claim now
    // lives in the per-engine verdict, so no shared field names an engine.
  };
}

/** Drop registry rows whose file vanished (manual cleanup keeps the list honest). */
export function listInstalledModels(): InstalledModel[] {
  const state = readInstalledModels();
  let dirty = false;
  const rows = Object.values(state).filter((row) => {
    try {
      return fs.statSync(row.filePath).isFile();
    } catch {
      delete state[row.id];
      dirty = true;
      return false;
    }
  });
  // Lazy header scan: a record without meta gets one, persisted back so the
  // next list call is a pure registry read. Downloads are sha-verified, so a
  // cached header cannot go stale under the same path for downloaded rows.
  // `engines` is the ADR-0039 verdict block and `scanVersion` its generation —
  // a row cached before either existed, or by a gate that has since widened
  // (ADR-0039 §6), is re-derived once, so an upgrade never leaves the console
  // showing a verdict the current code would no longer give.
  for (const row of rows) {
    const stale = !row.meta || !row.meta.engines || row.meta.scanVersion !== META_SCAN_VERSION;
    if (stale && row.filePath.toLowerCase().endsWith('.gguf')) {
      row.meta = metaFor(row);
      state[row.id] = row;
      dirty = true;
    }
  }
  if (dirty) {
    try {
      writeInstalledModels(state);
    } catch {
      // A failed write only re-runs the scan next time.
    }
  }
  // Newest first: the displayed date IS the sort key, so the card order and
  // the tertiary meta line never disagree (a download sorts by fetch time, an
  // import by the file's own mtime). Registry id is the stable tiebreak.
  return rows.sort((a, b) => b.downloadedAt - a.downloadedAt || a.id.localeCompare(b.id));
}

/** Storage used by the models directory, best effort (the card footer). */
export function modelsDiskUsage(): number {
  let total = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && !entry.name.endsWith('.json')) {
        try {
          total += fs.statSync(abs).size;
        } catch {
          // A file that vanished mid-walk contributes nothing.
        }
      }
    }
  };
  walk(modelsRoot(), 0);
  return total;
}

export type ModelDownloadStage = 'download' | 'finalize';

export type ModelDownloadEvent =
  | { type: 'stage'; stage: ModelDownloadStage; asset: string }
  | { type: 'download-start'; asset: string; total: number }
  | { type: 'progress'; asset: string; downloaded: number; total: number }
  | { type: 'stage'; stage: 'finalize' };

export interface DownloadModelOptions {
  repo: string;
  filename: string;
  /** Expected total size + digest from the tree API (drive the verifier). */
  size?: number;
  sha256?: string;
  signal?: AbortSignal;
  onEvent?: (event: ModelDownloadEvent) => void;
}

export type DownloadModelResult =
  | { ok: true; installed: InstalledModel; resumedFrom: number }
  | { ok: false; code: string; error: string };

/** One filename segment relative to the repo root — no traversal, no absolute. */
function validRepoFile(filename: string): boolean {
  const normalized = filename.replace(/\\/g, '/');
  return !!normalized && !normalized.startsWith('/') && !normalized.split('/').some((seg) => seg === '..' || seg === '');
}

type DownloadFileOutcome =
  | { ok: true; filePath: string; size: number; resumedFrom: number }
  | { ok: false; code: string; error: string };

/**
 * Download one repo file into the models tree WITHOUT registering it.
 * Concurrent calls for the SAME destination serialise on the final path
 * (two tabs must not interleave `.part` writes); different files download
 * side by side. Split-weight shards land as plain files here — the caller
 * registers once it has the whole group (or, for one file, right away).
 */
async function downloadRepoFile(
  repo: string,
  filename: string,
  opts: { size?: number; sha256?: string; signal?: AbortSignal; onEvent?: (event: ModelDownloadEvent) => void },
): Promise<DownloadFileOutcome> {
  const emit = (event: ModelDownloadEvent) => opts.onEvent?.(event);
  const [owner, name] = repo.split('/');
  const destDir = path.join(modelsRoot(), owner, name);
  const finalPath = path.join(destDir, filename);
  const partPath = `${finalPath}.part`;

  return withAssetLock(finalPath, async () => {
    emit({ type: 'stage', stage: 'download', asset: filename });
    let result;
    try {
      result = await downloadAssetToFile({
        url: hfFileUrl(repo, filename),
        partPath,
        fetchImpl: fetch,
        maxBytes: MAX_MODEL_BYTES,
        headers: {
          'User-Agent': 'omnicell-router',
          // The console-configured token (settings chain) is what unlocks a
          // gated repo — the env var alone used to leave page-set tokens dead.
          ...(resolveHfToken().token ? { Authorization: `Bearer ${resolveHfToken().token}` } : {}),
        },
        ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        onProgress: (downloaded, total) => {
          emit({ type: 'progress', asset: filename, downloaded, total });
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'download failed';
      return { ok: false, code: 'download-failed', error: message };
    }
    if (!result.ok) return { ok: false, code: result.code, error: result.error };

    emit({ type: 'stage', stage: 'finalize' });
    try {
      fs.mkdirSync(destDir, { recursive: true });
      // Rename, don't copy: a finished 20GB part must not be written twice.
      fs.renameSync(partPath, finalPath);
      cleanupAssetPart(partPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'move failed';
      return { ok: false, code: 'install-failed', error: `could not move the download into place (${message})` };
    }
    return { ok: true, filePath: finalPath, size: result.size, resumedFrom: result.resumedFrom };
  });
}

/** Write one registry row; the files on disk are the caller's responsibility. */
function registerInstalled(model: Omit<InstalledModel, 'downloadedAt'>): DownloadModelResult {
  const installed: InstalledModel = { ...model, downloadedAt: Date.now() };
  try {
    const state = readInstalledModels();
    state[installed.id] = installed;
    writeInstalledModels(state);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'state write failed';
    return { ok: false, code: 'install-failed', error: `model downloaded but the record write failed (${message})` };
  }
  return { ok: true, installed, resumedFrom: installed.resumedFrom ?? 0 };
}

/**
 * Download one repo file into the models tree and register it. Concurrent
 * calls for the SAME destination serialise on the final path (two tabs must
 * not interleave `.part` writes); different files download side by side.
 */
export async function downloadHfModel(opts: DownloadModelOptions): Promise<DownloadModelResult> {
  if (!isValidRepoId(opts.repo)) return { ok: false, code: 'invalid-model', error: `invalid model id '${opts.repo}'` };
  if (!validRepoFile(opts.filename)) return { ok: false, code: 'invalid-file', error: `invalid file name '${opts.filename}'` };
  const filename = opts.filename.replace(/\\/g, '/');
  const result = await downloadRepoFile(opts.repo, filename, {
    ...(opts.size != null ? { size: opts.size } : {}),
    ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  if (!result.ok) return result;
  return registerInstalled({
    id: `${opts.repo}/${filename}`,
    repo: opts.repo,
    filename,
    filePath: result.filePath,
    size: result.size,
    ...(parseGgufQuant(filename) ? { quant: parseGgufQuant(filename) } : {}),
    ...(parseParamsB(filename) ?? parseParamsB(opts.repo)
      ? { paramsB: parseParamsB(filename) ?? parseParamsB(opts.repo) }
      : {}),
    ...(result.resumedFrom > 0 ? { resumedFrom: result.resumedFrom } : {}),
  });
}

export interface DownloadModelGroupOptions {
  repo: string;
  /** Ordered shard parts, shard 1 first; each `{path, size?, sha256?}`. */
  parts: Array<{ path: string; size?: number; sha256?: string }>;
  signal?: AbortSignal;
  onEvent?: (event: ModelDownloadEvent) => void;
}

/**
 * Download a split-weight group (…-00001-of-00002.gguf …) and register ONE
 * model anchored at shard 1 — llama-server handed that path discovers the
 * siblings itself. Shards fetch sequentially (one `.part` stream at a time);
 * a mid-group failure keeps every staged part on disk, so the next attempt
 * resumes each shard where it stopped. Progress reports cumulative bytes
 * against the whole group.
 */
export async function downloadHfModelGroup(opts: DownloadModelGroupOptions): Promise<DownloadModelResult> {
  if (!isValidRepoId(opts.repo)) return { ok: false, code: 'invalid-model', error: `invalid model id '${opts.repo}'` };
  const parts = opts.parts.filter((part) => validRepoFile(part.path));
  if (parts.length < 2) return { ok: false, code: 'invalid-file', error: 'a split group needs at least two shard parts' };
  const firstMatch = SHARD_RE.exec(path.basename(parts[0].path));
  if (!firstMatch || Number(firstMatch[2]) !== 1) {
    return { ok: false, code: 'invalid-file', error: `group must be ordered with shard 1 first ('${parts[0].path}')` };
  }
  const baseName = firstMatch[1];
  // The group key: same base name and shard count on every part.
  for (const part of parts) {
    const match = SHARD_RE.exec(path.basename(part.path));
    if (!match || match[1].toLowerCase() !== baseName.toLowerCase() || Number(match[3]) !== parts.length) {
      return { ok: false, code: 'invalid-file', error: `inconsistent shard group ('${part.path}')` };
    }
  }

  const emit = (event: ModelDownloadEvent) => opts.onEvent?.(event);
  const groupTotal = parts.reduce((sum, part) => sum + (part.size ?? 0), 0);
  const doneFiles: Array<{ filePath: string; size: number; resumedFrom: number }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const completedBefore = doneFiles.reduce((sum, done) => sum + done.size, 0);
    const result = await downloadRepoFile(opts.repo, part.path.replace(/\\/g, '/'), {
      ...(part.size != null ? { size: part.size } : {}),
      ...(part.sha256 ? { sha256: part.sha256 } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onEvent: (event) => {
        // Rewrite per-part progress into group-cumulative bytes so the bar
        // climbs monotonically to the real total instead of resetting per shard.
        if (event.type === 'progress') {
          emit({
            type: 'progress',
            asset: part.path,
            downloaded: completedBefore + event.downloaded,
            total: groupTotal > 0 ? groupTotal : event.total,
          });
        } else {
          emit(event);
        }
      },
    });
    if (!result.ok) {
      return { ok: false, code: result.code, error: `${part.path}: ${result.error}` };
    }
    doneFiles.push(result);
  }

  const primary = parts[0].path.replace(/\\/g, '/');
  const size = doneFiles.reduce((sum, done) => sum + done.size, 0);
  const resumedFrom = doneFiles.reduce((sum, done) => sum + done.resumedFrom, 0);
  return registerInstalled({
    id: `${opts.repo}/${primary}`,
    repo: opts.repo,
    filename: primary,
    filePath: doneFiles[0].filePath,
    size,
    ...(parseGgufQuant(baseName) ? { quant: parseGgufQuant(baseName) } : {}),
    ...(parseParamsB(baseName) ?? parseParamsB(opts.repo)
      ? { paramsB: parseParamsB(baseName) ?? parseParamsB(opts.repo) }
      : {}),
    ...(resumedFrom > 0 ? { resumedFrom } : {}),
  });
}

/**
 * Set (or, with `null`, clear) one model's launch profile for one engine.
 *
 * The shape is the ENGINE's: normalization comes from its runtime, so this
 * function never learns a field name. The meta block is re-derived in the same
 * write because `runnable` is a FUNCTION of the profiles (ADR-0039) — a profile
 * change that did not refresh it would leave the console claiming an engine
 * the runner would refuse.
 */
export function setEngineProfile(
  id: string,
  engineId: string,
  raw: unknown
): { ok: true; model: InstalledModel } | { ok: false; code: string; error: string } {
  const engine = engineById(engineId);
  if (!engine) return { ok: false, code: 'unknown-engine', error: `unknown engine '${engineId}'` };
  const spec = engine.runtime?.profile;
  if (!spec) return { ok: false, code: 'engine-has-no-profile', error: `${engine.name} takes no launch profile` };

  const state = readInstalledModels();
  const record = state[id];
  if (!record) return { ok: false, code: 'model-missing', error: 'model is not installed' };

  const profiles = profilesOf(record);
  if (raw === null) {
    delete profiles[engineId];
  } else {
    const normalized = spec.normalize(raw);
    if (!normalized.ok) return normalized;
    profiles[engineId] = normalized.profile;
  }
  // Migrate forward: the legacy single-engine field is folded into `profiles`
  // on the first write, so reads have exactly one path from here on.
  if (profiles[engineId] === undefined) delete profiles[engineId];
  record.profiles = profiles;
  delete record.strata;
  record.meta = metaFor(record);
  try {
    writeInstalledModels(state);
  } catch (err) {
    return { ok: false, code: 'write-failed', error: err instanceof Error ? err.message : 'could not persist the profile' };
  }
  return { ok: true, model: record };
}

/**
 * The shape of an operator-chosen model name (ADR-0038 §7): a single URL- and
 * config-safe token — it becomes the tail of the gateway id (`local/<name>`),
 * so slashes, whitespace and shell-ish characters are out. Starts with a
 * letter or digit; 1-64 chars.
 */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Set (or, with an empty string / null, clear) one model's operator name.
 *
 * Uniqueness is case-insensitive across the registry: the name becomes a
 * gateway-visible id tail, and two ids differing only by case would route
 * differently per surface. The registry KEY (`<repo>/<file>`) never changes —
 * a rename moves only the `local/<…>` spelling, so the caller is responsible
 * for reporting which config references the old id orphaned (the route scans
 * and warns; nothing is silently rewritten).
 */
export function setModelName(
  id: string,
  raw: unknown
): { ok: true; model: InstalledModel; previousName?: string } | { ok: false; code: string; error: string } {
  const state = readInstalledModels();
  const record = state[id];
  if (!record) return { ok: false, code: 'model-missing', error: 'model is not installed' };

  const name = typeof raw === 'string' ? raw.trim() : '';
  const previousName = record.name;
  if (!name) {
    if (record.name === undefined) return { ok: true, model: record };
    delete record.name;
  } else {
    if (!MODEL_NAME_RE.test(name)) {
      return {
        ok: false,
        code: 'invalid-name',
        error: `invalid model name '${name}': use 1-64 chars of letters, digits, '.', '_' or '-', starting with a letter or digit`,
      };
    }
    const clash = Object.values(state).find(
      (row) => row.id !== id && row.name !== undefined && row.name.toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      return { ok: false, code: 'name-taken', error: `the name '${name}' already belongs to ${clash.id}` };
    }
    if (record.name === name) return { ok: true, model: record };
    record.name = name;
  }
  try {
    writeInstalledModels(state);
  } catch (err) {
    return { ok: false, code: 'write-failed', error: err instanceof Error ? err.message : 'could not persist the name' };
  }
  return { ok: true, model: record, ...(previousName !== undefined ? { previousName } : {}) };
}

/** Strata's profile writer — a named alias of the generic one (ADR-0038 §4). */
export function setStrataProfile(
  id: string,
  raw: unknown
): { ok: true; model: InstalledModel } | { ok: false; code: string; error: string } {
  return setEngineProfile(id, 'strata', raw);
}

/**
 * Re-derive and persist ONE record's meta block out of band. The verdicts are
 * a function of the DISK (ADR-0039 §8), and an engine build (ADR-0039 §9) is
 * exactly such a change: the pack it wrote flips `serves` without any profile
 * or registry edit, and only a rescan lets the console see it.
 */
export function rescanModelMeta(id: string): void {
  const state = readInstalledModels();
  const record = state[id];
  if (!record || !record.filePath.toLowerCase().endsWith('.gguf')) return;
  record.meta = metaFor(record);
  try {
    writeInstalledModels(state);
  } catch {
    // A failed write only re-runs the scan on the next list.
  }
}

/** Delete one model file and its registry row. */
export function removeHfModel(id: string): { ok: boolean; error?: string } {
  const state = readInstalledModels();
  const record = state[id];
  if (!record) return { ok: false, error: 'model is not installed' };
  if (record.repo === IMPORT_REPO) {
    // Imported rows point at the user's own files: unregister only — the
    // file on disk is the user's and is never touched.
    delete state[id];
    try {
      writeInstalledModels(state);
    } catch {
      // File stays; a failed state write only leaves a stale row.
    }
    return { ok: true };
  }
  // Only ever delete inside the models root — same containment rule the
  // engine uninstall applies to a corrupt record.
  const root = path.resolve(modelsRoot());
  const file = path.resolve(record.filePath);
  if (!file.startsWith(root + path.sep)) {
    return { ok: false, error: 'model record points outside the models root; remove it manually' };
  }
  try {
    fs.rmSync(file, { force: true, maxRetries: 2 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'delete failed';
    return { ok: false, error: `could not delete the model file (${message})` };
  }
  delete state[id];
  try {
    writeInstalledModels(state);
  } catch {
    // File gone; a failed state write only leaves a stale row.
  }
  return { ok: true };
}

/**
 * Repo marker for rows imported from the local disk. Such rows register the
 * file where it lies (multi-GB weights are never copied) and deleting them
 * only drops the registry entry.
 */
export const IMPORT_REPO = 'local-import';

export interface ImportLocalResult {
  imported: InstalledModel[];
  skipped: number;
  errors: string[];
}

type ImportOne =
  | { kind: 'imported'; model: InstalledModel }
  | { kind: 'duplicate' }
  | { kind: 'error'; error: string };

/**
 * Collapse split weights into one registrable unit per group: llama-server
 * is handed the FIRST shard and discovers the siblings itself, so only that
 * path may enter the registry — registering every shard would list one
 * model N times and each row would under-report the real weight size.
 * Groups are keyed by directory + base name + shard count; an incomplete
 * group is an error, never a partial registration that cannot run.
 */
function resolveShardGroups(files: string[], errors: string[]): Array<{ primary: string; parts: string[] }> {
  const singles: string[] = [];
  const groups = new Map<string, { total: number; parts: Map<number, string> }>();
  for (const file of files) {
    const match = SHARD_RE.exec(path.basename(file));
    if (!match) {
      singles.push(file);
      continue;
    }
    const key = `${path.dirname(file).toLowerCase()}::${match[1].toLowerCase()}::${match[3]}`;
    let group = groups.get(key);
    if (!group) {
      group = { total: Number(match[3]), parts: new Map() };
      groups.set(key, group);
    }
    group.parts.set(Number(match[2]), file);
  }
  const resolved: Array<{ primary: string; parts: string[] }> = singles.map((file) => ({ primary: file, parts: [file] }));
  for (const group of groups.values()) {
    const missing: number[] = [];
    for (let part = 1; part <= group.total; part += 1) {
      if (!group.parts.has(part)) missing.push(part);
    }
    const primary = group.parts.get(1);
    if (missing.length > 0 || !primary) {
      const name = primary ? path.basename(primary) : `…-of-${String(group.total).padStart(5, '0')}.gguf`;
      errors.push(`${name}: incomplete split model, missing shard(s) ${missing.map((n) => String(n).padStart(5, '0')).join(', ')}`);
      continue;
    }
    resolved.push({ primary, parts: Array.from({ length: group.total }, (_, i) => group.parts.get(i + 1)!) });
  }
  return resolved;
}

/** Register one on-disk .gguf file into `state` (not persisted here). */
function importLocalFile(absPath: string, state: Record<string, InstalledModel>, sizeOverride?: number): ImportOne {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { kind: 'error', error: `${absPath}: not a file` };
    const size = sizeOverride ?? stat.size;
    if (size > MAX_MODEL_BYTES) return { kind: 'error', error: `${absPath}: exceeds the 512GB ceiling` };
    if (Object.values(state).some((row) => path.resolve(row.filePath) === path.resolve(absPath))) {
      return { kind: 'duplicate' };
    }
    const filename = path.basename(absPath);
    if (!filename.toLowerCase().endsWith('.gguf')) return { kind: 'error', error: `${absPath}: not a .gguf file` };
    // Quant/params live in the base name; the shard suffix is noise for both.
    const baseName = filename.replace(SHARD_RE, '$1');
    // Unique key even when two folders hold the same filename.
    let id = `${IMPORT_REPO}/${filename}`;
    let n = 2;
    while (state[id]) id = `${IMPORT_REPO}/${filename.replace(/\.gguf$/i, '')}-${n++}.gguf`;
    const model: InstalledModel = {
      id,
      repo: IMPORT_REPO,
      filename,
      filePath: path.resolve(absPath),
      size,
      ...(parseGgufQuant(baseName) ? { quant: parseGgufQuant(baseName) } : {}),
      ...(parseParamsB(baseName) ? { paramsB: parseParamsB(baseName) } : {}),
      // For an imported file the honest timestamp is the file's own mtime —
      // the import moment says nothing about when the weights were produced,
      // while a downloaded row records its fetch time (registerInstalled).
      downloadedAt: Math.round(stat.mtimeMs),
    };
    state[model.id] = model;
    return { kind: 'imported', model };
  } catch (err) {
    return { kind: 'error', error: `${absPath}: ${err instanceof Error ? err.message : 'stat failed'}` };
  }
}

/**
 * Import .gguf files that already exist on this machine. `target` may be one
 * file or a directory (walked up to depth 4, 200-file cap). Records point at
 * the original paths — nothing is copied or moved. Split weights
 * (`-00001-of-00002.gguf` …) collapse into ONE row anchored at the first
 * shard, with the size of all shards combined.
 */
export function importLocalModels(target: string): ImportLocalResult {
  const abs = path.resolve(target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    return { imported: [], skipped: 0, errors: [err instanceof Error ? err.message : 'path not found'] };
  }
  const state = readInstalledModels();
  const imported: InstalledModel[] = [];
  const errors: string[] = [];
  let skipped = 0;

  const files: string[] = [];
  if (stat.isFile()) {
    files.push(abs);
    // Picking one shard of a split model imports the whole set: scan the
    // sibling shards in the same directory so a group stays a group.
    const shardMatch = SHARD_RE.exec(path.basename(abs));
    if (shardMatch) {
      try {
        for (const entry of fs.readdirSync(path.dirname(abs), { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const sibling = path.join(path.dirname(abs), entry.name);
          if (path.resolve(sibling) === path.resolve(abs)) continue;
          const siblingMatch = SHARD_RE.exec(entry.name);
          if (siblingMatch && siblingMatch[1].toLowerCase() === shardMatch[1].toLowerCase() && siblingMatch[3] === shardMatch[3]) {
            files.push(sibling);
          }
        }
      } catch {
        // Sibling scan is best effort; the single file still imports.
      }
    }
  } else if (stat.isDirectory()) {
    const walk = (dir: string, depth: number): void => {
      if (depth > 4 || files.length >= 200) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        errors.push(`${dir}: ${err instanceof Error ? err.message : 'read failed'}`);
        return;
      }
      for (const entry of entries) {
        if (files.length >= 200) return;
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(child, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) files.push(child);
      }
    };
    walk(abs, 0);
  }
  if (files.length === 0) {
    errors.push(`${abs}: no .gguf files found`);
    return { imported, skipped, errors };
  }

  for (const group of resolveShardGroups(files, errors)) {
    // The size a planner sees is the whole weight set, not one shard.
    let size: number | undefined;
    if (group.parts.length > 1) {
      try {
        size = group.parts.reduce((sum, part) => sum + fs.statSync(part).size, 0);
      } catch (err) {
        errors.push(`${group.primary}: ${err instanceof Error ? err.message : 'shard size failed'}`);
        continue;
      }
    }
    const outcome = importLocalFile(group.primary, state, size);
    if (outcome.kind === 'imported') imported.push(outcome.model);
    else if (outcome.kind === 'duplicate') skipped += 1;
    else errors.push(outcome.error);
  }
  if (imported.length > 0) {
    try {
      writeInstalledModels(state);
    } catch (err) {
      return { imported: [], skipped, errors: [`record write failed: ${err instanceof Error ? err.message : 'unknown'}`] };
    }
  }
  return { imported, skipped, errors };
}
