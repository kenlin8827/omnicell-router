/**
 * Strata runtime — `EngineRuntime` + the run-config generator (ADR-0039, §7–§8).
 *
 * Three facts shape this file.
 *
 * 1. `strata.exe` is NOT an HTTP server. It is a resident stdin worker: `--serve`
 *    makes it read `GEN <max_new> <ids>` / `GENI …` lines and stream `T <id>`
 *    back, it has no tokenizer ("this build has no tokenizer"), and its argv
 *    parser treats ANY unknown flag as fatal (`unknown argument: --port` → exit
 *    2). The HTTP/OpenAI surface is the vendor's `serve/server.py`, which owns
 *    the port, spawns `strata … --serve`, and spawns the `strata-vision` encoder
 *    when its config has a `vision` block.
 *
 * 2. The thing the front-end reads is a run config (`strata-*.json`) that IS the
 *    engine command line: pack, native shard, PLE table, expert binary, MTP
 *    head, ctx, kv, pool workers, CUDA DLL dirs. The gateway writes that file.
 *    The operator supplies nothing.
 *
 * 3. The layout is OURS, under the gateway home (ADR-0039 §13). A source
 *    checkout next to a model file is not an install and is never consulted:
 *    `<ocrHome>/strata/runtime` is the control bundle (`serve/server.py` plus
 *    the Python it ships), `<ocrHome>/strata/data` holds `packs/`, `models/`
 *    and `mtp/`, and the `strata.exe` that runs is the one this gateway
 *    installed. The model file stays wherever the registry put it. Pack
 *    matching is still by the model's folder name, under OUR data directory —
 *    a guess that silently picks the wrong pack would load the wrong weights.
 *
 * Consequences the rest of the gateway reads off this module:
 *   - `serves()` is TRUE whenever the layout resolves: there is no operator
 *     setup step left to gate on, so a supported model is never shown as
 *     "needs setup" again.
 *   - `placement: 'engine'` — the engine's `--expert-cache` owns the split.
 *   - `accepts`: no `-ngl`, no `--threads`, no `--kv` — the config owns them.
 *   - `resolveCtx` honours the requested ctx, because the config is ours now.
 *   - NO vision leg: `server.py` starts the encoder from the config's `vision`
 *     block. A gateway-spawned `strata-vision.exe` on a port could never be
 *     used — that binary speaks `ENC <image> <out>` on stdin.
 *
 * What the profile still carries: the per-launch knobs (`kv`, `maxContext`)
 * and optional `mtp`/`mmproj` overrides for a layout discovery cannot see.
 * Nothing there is required, and an empty profile is the normal case. The
 * pack is NOT among them (§11): it is matched by the model's folder name or
 * built by the gateway, and a match tie is refused, never overridden.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';
import { CTX_LADDER } from './plan.js';
import { readLocalModelSettings } from './settings.js';
import type { EngineDeclaration, EngineFieldSpec, EngineLeg, EngineProfileSpec, EngineProfileWhere, EngineRuntime, EngineSetupSpec } from './engine-runtime.js';

/** `--kv` values this engine accepts (`strata --help`, plan v0.3 P7 + PR #21). */
export type StrataKv = 'int8' | 'fp16' | 'q4_0' | 'k8v4';

/** The engine's own context default when its config names none. */
export const STRATA_DEFAULT_CTX = 32768;

/**
 * Optional per-model knobs. Every field is fillable ONLY when discovery cannot
 * see the artefact — the normal record is `undefined`, and the console shows
 * no required input at all (ADR-0039 §8). The front-end, data directory and
 * interpreter live under the gateway home (§13); engine setup (§10) can pin
 * a different path, and the pack is never a field at all (§11).
 */
export interface StrataProfile {
  /** The MTP draft runtime (`…/mtp/rt`). Auto-discovered; `'off'` (the run
   *  console's speculative-draft switch) disables the draft outright. */
  mtp?: string;
  /** The vision projector. Auto-discovered under `<data>/models/mmproj-*.gguf`;
   *  `'off'` (the run console's vision switch) launches text-only. */
  mmproj?: string;
  /** Context ceiling written into the generated config. */
  maxContext?: number;
  /** KV storage type written into the generated config (engine default int8). */
  kv?: StrataKv;
  /**
   * Requests decoded together (the config's `parallel` → the engine's
   * `--batch N`), 2-8. Absent = one at a time, the vendor default and the
   * right one for a card whose experts mostly stream from RAM (batch slots
   * cost the expert cache ~0.56 GiB VRAM each at 32K, 10-25% per-request
   * speed there — BATCHING.md). The engine clamps to what fits, never
   * refuses; the vendor's recommendation rule lives in ITS setup, so the
   * gateway offers the knob and computes no number of its own.
   */
  parallel?: number;
}

export type StrataProfileResult =
  | { ok: true; profile: StrataProfile }
  | { ok: false; code: string; error: string };

/** A non-empty string, trimmed. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

const KV_VALUES: ReadonlySet<string> = new Set(['int8', 'fp16', 'q4_0', 'k8v4']);

/**
 * Normalise one raw blob. Unknown keys are dropped rather than rejected: a
 * record written by an older build stored `root`/`workspace`/`dataRoot`/
 * `python` (installation facts — engine setup owns them since §10), `pack`
 * (a tie is refused on disk, never overridden — §11) or `config`, and a hard
 * failure there would make an existing model unlaunchable. Those keys are
 * simply ignored here.
 */
export function normalizeStrataProfile(raw: unknown): StrataProfileResult {
  if (raw === undefined || raw === null) return { ok: true, profile: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'profile-invalid', error: 'strata profile must be an object' };
  }
  const src = raw as Record<string, unknown>;
  const profile: StrataProfile = {};
  const mtp = str(src.mtp);
  if (mtp) profile.mtp = mtp;
  const mmproj = str(src.mmproj);
  if (mmproj) profile.mmproj = mmproj;
  const ctx = Number(src.maxContext);
  if (Number.isFinite(ctx) && ctx >= 256) profile.maxContext = Math.floor(ctx);
  const kv = str(src.kv);
  if (kv && KV_VALUES.has(kv)) profile.kv = kv as StrataKv;
  const parallel = Number(src.parallel);
  if (Number.isInteger(parallel) && parallel >= 2 && parallel <= 8) profile.parallel = parallel;
  return { ok: true, profile };
}

/** Typed view of a stored blob, or null when it is not a usable profile. */
function asProfile(raw: unknown): StrataProfile | null {
  const normalized = normalizeStrataProfile(raw);
  return normalized.ok ? normalized.profile : null;
}

/* ------------------------------------------------------------------------- *
 * Layout discovery — the model path is the anchor
 * ------------------------------------------------------------------------- */

export interface StrataLayout {
  /** The tree holding `serve/` and `.venv/`. */
  workspace: string;
  /** `serve/server.py` — the front-end the gateway spawns. */
  entry: string;
  /** The interpreter that runs the front-end. */
  python: string;
  /** The directory holding `packs/`, `models/`, `mtp/`. */
  dataRoot: string;
  /** The built pack for this model. */
  pack: string;
  /** `<pack>/tokenizer`, when the pack ships one (it always does in practice). */
  tokenizer?: string;
  /** The MTP draft runtime. */
  mtp?: string;
  /** `expert-profile.bin` — what makes `--expert-cache auto` profile-driven. */
  expertProfile?: string;
  /** The vision projector. */
  mmproj?: string;
  /** The engine build this launch runs. */
  engineExe?: string;
  /** The encoder binary beside `engineExe`, when that build ships one. */
  visionExe?: string;
  /** CUDA runtime dirs the venv provides; the engine's DLL loader needs them. */
  libDirs: string[];
  /** The name the HTTP surface answers as. */
  modelName: string;
}

export type StrataLayoutResult =
  | { ok: true; layout: StrataLayout }
  | { ok: false; missing: string[]; reason: string; buildable?: boolean };

/**
 * The workspace half of the layout — everything except the pack. A build only
 * needs these (the pack is what the build PRODUCES), so this resolution never
 * looks at `packs/`.
 */
interface StrataWorkspaceParts {
  workspace: string;
  entry: string;
  python: string;
  dataRoot: string;
}

function resolveWorkspaceParts(): { ok: true; parts: StrataWorkspaceParts } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const workspace = findWorkspace();
  if (!workspace) missing.push(`serve/server.py in ${strataRuntimeDir()}`);
  const entry = workspace ? path.join(workspace, SERVE_ENTRY) : undefined;
  if (workspace && !entry) missing.push('serve/server.py');
  const python = workspace ? findPython(workspace) : undefined;
  if (workspace && !python) missing.push(`a Python interpreter for the front-end (${pythonCandidates(workspace)[0]})`);
  const dataRoot = findDataRoot();
  if (!workspace || !entry || !python || !dataRoot) return { ok: false, missing };
  return { ok: true, parts: { workspace, entry, python, dataRoot } };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Immediate child directories, capped — a scan must not walk a whole drive. */
function childDirs(dir: string, limit: number): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, limit)
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

const SERVE_ENTRY = path.join('serve', 'server.py');

function looksLikeWorkspace(dir: string): boolean {
  return isFile(path.join(dir, SERVE_ENTRY));
}

/**
 * Engine-level setup values (ADR-0039 §10): an optional pin on the engines
 * page. A pin that does not look like the thing it names is ignored — a stale
 * path must not hide the directory the gateway owns.
 */
function engineSetup(): Record<string, string> {
  return readLocalModelSettings().engineSetup?.strata ?? {};
}

/** The control bundle: `serve/server.py` and the Python that runs it. */
export function strataRuntimeDir(): string {
  return path.join(getOcrHomeDir(), 'strata', 'runtime');
}

/** `packs/`, `models/`, `mtp/`. Created on demand — this directory is ours. */
export function strataDataDir(): string {
  const dir = path.join(getOcrHomeDir(), 'strata', 'data');
  fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  return dir;
}

/** The front-end. A setup pin wins when it really holds `serve/server.py`;
 *  otherwise the gateway's own runtime directory. A checkout beside a model
 *  file is not a candidate (ADR-0039 §13). */
function findWorkspace(): string | undefined {
  const explicit = engineSetup().workspace;
  if (explicit && looksLikeWorkspace(explicit)) return explicit;
  const ours = strataRuntimeDir();
  return looksLikeWorkspace(ours) ? ours : undefined;
}

/** A data root is the directory carrying both `packs/` and `models/`. */
function looksLikeDataRoot(dir: string): boolean {
  return isDir(path.join(dir, 'packs')) && isDir(path.join(dir, 'models'));
}

function findDataRoot(): string {
  const explicit = engineSetup().dataRoot;
  if (explicit && looksLikeDataRoot(explicit)) return explicit;
  return strataDataDir();
}

/**
 * A pack is a directory the packer FINISHED: the weights or index beside
 * `native_experts.txt`, the completion marker `iq_pack.py` publishes LAST
 * ("a pack without it is not finished"). Requiring the marker is what makes a
 * build interruptible: a half-written pack (an interrupted gateway build, a
 * Ctrl-C'd manual one) never matches, so the engine can never load a
 * truncated weight set and fail 40 GB into the read.
 */
function looksLikePack(dir: string): boolean {
  return (
    isDir(dir) &&
    (isFile(path.join(dir, 'dense.bin')) || isFile(path.join(dir, 'index.txt'))) &&
    isFile(path.join(dir, 'native_experts.txt'))
  );
}

function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0 && !/^\d+$/.test(token) && token !== 'gguf');
}

/**
 * Match a pack to a model. Exact name match first (`abl-IQ2_XS` → `abl-iq2_xs`,
 * the vendor's own convention), then shared non-numeric tokens. A tie is
 * reported, never broken arbitrarily: loading the wrong pack would run the
 * wrong weights and look like a model bug.
 */
export function matchPack(packsDir: string, modelPath: string): { pack?: string; ambiguous?: string[] } {
  const modelDir = path.basename(path.dirname(modelPath)).toLowerCase();
  const modelFile = path.basename(modelPath).replace(/\.gguf$/i, '').toLowerCase();
  const direct = path.join(packsDir, modelDir);
  if (looksLikePack(direct)) return { pack: direct };
  const directFile = path.join(packsDir, modelFile);
  if (looksLikePack(directFile)) return { pack: directFile };

  const wanted = new Set([...tokensOf(modelDir), ...tokensOf(modelFile)]);
  const scored = childDirs(packsDir, 64)
    .filter(looksLikePack)
    .map((dir) => {
      const name = path.basename(dir).toLowerCase();
      const score = tokensOf(name).filter((token) => wanted.has(token)).length;
      return { dir, name, score };
    })
    .filter((row) => row.score >= 2)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return {};
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { ambiguous: scored.filter((row) => row.score === scored[0].score).map((row) => row.dir) };
  }
  return { pack: scored[0].dir };
}

/** The MTP draft runtime: the directory `--mtp` accepts. The profile's `'off'`
 *  sentinel (the console's speculative-draft switch) disables discovery. */
function findMtp(dataRoot: string, profile: StrataProfile): string | undefined {
  if (profile.mtp === 'off') return undefined;
  if (profile.mtp && isDir(profile.mtp)) return profile.mtp;
  const rt = path.join(dataRoot, 'mtp', 'rt');
  if (isFile(path.join(rt, 'experts.bin')) || isFile(path.join(rt, 'dense.bin'))) return rt;
  return undefined;
}

/** The vision projector: one `mmproj-*.gguf` beside the model folders. The
 *  profile's `'off'` sentinel (the console's vision switch) skips the leg. */
function findMmproj(dataRoot: string, profile: StrataProfile, modelPath: string): string | undefined {
  if (profile.mmproj === 'off') return undefined;
  if (profile.mmproj && isFile(profile.mmproj)) return profile.mmproj;
  const dirs = [path.join(dataRoot, 'models'), path.dirname(modelPath)];
  const candidates: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (/^mmproj.*\.gguf$/i.test(name)) candidates.push(path.join(dir, name));
    }
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const wanted = new Set(tokensOf(path.basename(modelPath)));
  const scored = candidates
    .map((file) => ({ file, score: tokensOf(path.basename(file)).filter((token) => wanted.has(token)).length }))
    .sort((a, b) => b.score - a.score);
  return scored[0].file;
}

/** The `bin` dirs under the runtime's `nvidia` packages — the engine's DLLs.
 *  The control bundle installs them into its own Python; a `.venv` is the
 *  older layout of the same directory. */
function findLibDirs(workspace: string): string[] {
  const sitePackages: string[] = [];
  const roots = [
    path.join(workspace, 'python', 'Lib', 'site-packages'),
    path.join(workspace, '.venv', 'Lib', 'site-packages'),
  ];
  for (const dir of roots) {
    if (isDir(dir)) sitePackages.push(dir);
  }
  for (const lib of [path.join(workspace, 'python', 'lib'), path.join(workspace, '.venv', 'lib')]) {
    for (const dir of childDirs(lib, 8)) {
      const candidate = path.join(dir, 'site-packages');
      if (isDir(candidate)) sitePackages.push(candidate);
    }
  }
  const out: string[] = [];
  for (const base of sitePackages) {
    for (const pkg of childDirs(path.join(base, 'nvidia'), 16)) {
      const bin = path.join(pkg, 'bin');
      if (isDir(bin)) out.push(bin);
    }
  }
  return out;
}

/** Interpreters the control bundle ships, then a venv in the same directory. */
function pythonCandidates(workspace: string): string[] {
  return process.platform === 'win32'
    ? [path.join(workspace, 'python', 'python.exe'), path.join(workspace, '.venv', 'Scripts', 'python.exe')]
    : [
        path.join(workspace, 'python', 'bin', 'python3'),
        path.join(workspace, 'python', 'bin', 'python'),
        path.join(workspace, '.venv', 'bin', 'python3'),
        path.join(workspace, '.venv', 'bin', 'python'),
      ];
}

function findPython(workspace: string): string | undefined {
  const explicit = engineSetup().python;
  const candidates = explicit ? [explicit, ...pythonCandidates(workspace)] : pythonCandidates(workspace);
  return candidates.find((candidate) => isFile(candidate));
}

/** Resolve every artefact one launch needs. The owned data directory is created
 *  if it is missing; everything else is a read. */
export function resolveStrataLayout(input: {
  modelPath: string;
  profile?: unknown;
  /** The engine binary this gateway installed. It is the exe that runs. */
  binary?: string;
}): StrataLayoutResult {
  const profile = asProfile(input.profile) ?? {};
  const parts = resolveWorkspaceParts();
  if (!parts.ok) {
    return {
      ok: false,
      missing: parts.missing,
      reason: `Strata's run config is generated here, but its inputs are missing: ${parts.missing.join('; ')}.`,
    };
  }
  const { workspace, entry, python, dataRoot } = parts.parts;

  // The pack is ALWAYS the matcher's answer — there is no profile override.
  // A tie is refused below and the operator breaks it on disk (rename or
  // remove the stray candidate), never in a form (ADR-0039 §11): a field that
  // exists only for the once-ever collision reads as "you must configure the
  // pack" to everyone else.
  const matched = matchPack(path.join(dataRoot, 'packs'), input.modelPath);
  const pack = matched.pack;
  const ambiguity = matched.ambiguous;
  if (!pack) {
    const missing = [
      ambiguity
        ? `a single pack for this model (candidates: ${ambiguity.map((dir) => path.basename(dir)).join(', ')} — rename or remove all but the one built from this model)`
        : 'a built pack for this model (packs/<model>)',
    ];
    // The pack is the ONE input the gateway can produce itself — but only when
    // the workspace it builds from resolves whole and the packer is there. A
    // tie is an operator decision, never a build trigger: building would
    // publish under the exact-match name and silently pick a winner.
    const packer = path.join(workspace, 'tools', 'iq_pack.py');
    const buildable = !ambiguity && isFile(packer);
    return {
      ok: false,
      missing,
      ...(buildable ? { buildable: true } : {}),
      reason: `Strata's run config is generated here, but its inputs are missing: ${missing.join('; ')}. Packs live under ${dataRoot}.`,
    };
  }

  const mtp = findMtp(dataRoot, profile);
  const mmproj = findMmproj(dataRoot, profile, input.modelPath);
  // The exe is the one this gateway installed. A binary sitting inside the
  // runtime tree is not a second engine and is never preferred (ADR-0039 §13).
  const engineExe = input.binary;
  const visionExe = engineExe
    ? path.join(path.dirname(engineExe), process.platform === 'win32' ? 'strata-vision.exe' : 'strata-vision')
    : undefined;
  const tokenizer = path.join(pack, 'tokenizer');

  const layout: StrataLayout = {
    workspace,
    entry,
    python,
    dataRoot,
    pack,
    modelName: path.basename(pack).toLowerCase(),
    libDirs: findLibDirs(workspace),
    ...(isDir(tokenizer) ? { tokenizer } : {}),
    ...(mtp ? { mtp } : {}),
    ...(isFile(path.join(workspace, 'data', 'expert-profile.bin'))
      ? { expertProfile: path.join(workspace, 'data', 'expert-profile.bin') }
      : {}),
    ...(mmproj ? { mmproj } : {}),
    ...(engineExe ? { engineExe } : {}),
    ...(visionExe && isFile(visionExe) ? { visionExe } : {}),
  };
  return { ok: true, layout };
}

/* ------------------------------------------------------------------------- *
 * The generated run config
 * ------------------------------------------------------------------------- */

/** The engine argv one launch passes (`strata-*.json`'s `args`, built here). */
export function strataEngineArgs(input: {
  layout: StrataLayout;
  modelPath: string;
  ctx: number;
  kv: StrataKv;
  extraArgs?: string[];
}): string[] {
  const { layout, modelPath, ctx, kv } = input;
  const args = ['--pack', layout.pack, '--native', modelPath, '--ple-gguf', modelPath];
  if (layout.expertProfile) args.push('--expert-profile', layout.expertProfile);
  args.push('--expert-cache', 'auto', '--prefill', 'auto');
  if (layout.mtp) args.push('--spec', '4', '--spec-min-p', '0.5', '--mtp', layout.mtp);
  // No `--pool-workers`: the engine's own default (0) is "every physical core
  // except the host's", which is exactly what a hand-written 15 meant. Pinning
  // a count here would be a machine fact frozen into every launch.
  args.push('--max-context', String(ctx), '--kv', kv);
  args.push(...(input.extraArgs ?? []));
  return args;
}

/** Where the generated configs live — our home, never inside the vendor tree. */
export function strataConfigDir(): string {
  return path.join(getOcrHomeDir(), 'strata', 'configs');
}

/**
 * Where a gateway-driven build writes the pack (ADR-0039 §9): the exact-name
 * candidate `matchPack` tries first — the model's own folder, lowercased, the
 * vendor's own convention (`abl-IQ2_XS` → `packs/abl-iq2_xs`). Building here
 * means the finished pack resolves with zero configuration, and the packer's
 * completion marker (`native_experts.txt`, published last) keeps a half-built
 * directory invisible to `looksLikePack` until the rename lands.
 */
export function strataPackTarget(dataRoot: string, modelPath: string): string {
  return path.join(dataRoot, 'packs', path.basename(path.dirname(modelPath)).toLowerCase());
}

/** The config path for one (model, ctx) pair — stable, so a re-launch reuses it. */
export function strataConfigPath(layout: StrataLayout, ctx: number): string {
  return path.join(strataConfigDir(), `${layout.modelName}-ctx${ctx}.json`);
}

/**
 * Build the vendor config object. Everything the old console asked for is
 * derived here. `exe` is the engine binary this gateway installed.
 */
export function buildStrataConfig(input: {
  layout: StrataLayout;
  modelPath: string;
  /** The engine binary this gateway installed. */
  engineExe: string;
  ctx: number;
  kv: StrataKv;
  /** The config's `parallel` (2-8); absent = one request at a time. */
  parallel?: number;
  /** The operator-chosen served name (ADR-0038 §7); absent = the pack's name. */
  servedName?: string;
  extraArgs?: string[];
}): Record<string, unknown> {
  const { layout, modelPath } = input;
  const servedName = input.servedName ?? layout.modelName;
  const config: Record<string, unknown> = {
    exe: layout.engineExe ?? input.engineExe,
    args: strataEngineArgs({ layout, modelPath, ctx: input.ctx, kv: input.kv, extraArgs: input.extraArgs }),
    cwd: layout.workspace,
    model_name: servedName,
    log: path.join(strataConfigDir(), `${layout.modelName}.log`),
    lib_dirs: layout.libDirs,
  };
  // `parallel` is a SERVER-level key: server.py translates it into the
  // engine's `--batch N` itself (and says when the engine clamps it). Writing
  // --batch into args directly would bypass the server's own bookkeeping
  // (#465, parallel_args()).
  if (input.parallel !== undefined) config.parallel = input.parallel;
  if (layout.tokenizer) config.tokenizer = layout.tokenizer;
  // The encoder is `server.py`'s child; without a projector there is no vision
  // block at all, so a text-only model never pays for the encoder.
  if (layout.visionExe && layout.mmproj) {
    config.vision = { exe: layout.visionExe, mmproj: layout.mmproj, model: modelPath };
  }
  return config;
}

/** Write the config and return its path. Errors surface as the launch error. */
export function writeStrataConfig(input: {
  layout: StrataLayout;
  modelPath: string;
  engineExe: string;
  ctx: number;
  kv: StrataKv;
  parallel?: number;
  /** The operator-chosen served name (ADR-0038 §7); absent = the pack's name. */
  servedName?: string;
  extraArgs?: string[];
}): { ok: true; path: string } | { ok: false; error: string } {
  const target = strataConfigPath(input.layout, input.ctx);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(buildStrataConfig(input), null, 1), 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot write the generated Strata config at ${target}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, path: target };
}

/* ------------------------------------------------------------------------- *
 * Runtime descriptor
 * ------------------------------------------------------------------------- */

/**
 * Architectures Strata's engine serves (its curated MoE families' GGUF arch
 * strings). Strata is family-locked — it does not serve arbitrary GGUF files —
 * so the family gate lives HERE, in the engine's own runtime, never in the
 * header parser or the runner.
 */
export const STRATA_FAMILY_ARCHES: ReadonlySet<string> = new Set([
  // `qwen4exp` is what "Qwen3.8-Flash-Next" MoE checkpoints report in their
  // GGUF header (48 layers / 512 experts in the field), and Strata runs them —
  // the list is evidence-driven, not derived from a family name.
  'qwen3moe',
  'qwen3next',
  'qwen4exp',
  'deepseek2',
  'glm4moe',
  'gpt-oss',
]);

const PROFILE_FIELDS: EngineFieldSpec[] = [
  // The run page already surfaces these two as the spec/vision switches; the
  // drawer offers the same pick (auto / off) plus a typed path for a layout
  // discovery cannot see — `customizable` keeps both in one dropdown.
  {
    key: 'mtp',
    label: 'localModels.strataMtp',
    hint: 'localModels.strataMtpHint',
    kind: 'select',
    customizable: true,
    mono: true,
    placeholder: 'auto',
    options: [{ value: 'off', label: 'off', labelKey: 'localModels.runSpecOff' }],
  },
  {
    key: 'mmproj',
    label: 'localModels.strataMmproj',
    hint: 'localModels.strataMmprojHint',
    kind: 'select',
    customizable: true,
    mono: true,
    placeholder: 'auto',
    options: [{ value: 'off', label: 'off', labelKey: 'localModels.runSpecOff' }],
  },
  {
    key: 'kv',
    label: 'localModels.strataKv',
    hint: 'localModels.strataKvHint',
    kind: 'select',
    options: [
      { value: 'int8', label: 'int8' },
      { value: 'fp16', label: 'fp16' },
      { value: 'q4_0', label: 'q4_0' },
      { value: 'k8v4', label: 'k8v4' },
    ],
  },
  {
    key: 'maxContext',
    label: 'localModels.strataMaxContext',
    hint: 'localModels.strataMaxContextHint',
    kind: 'select',
    placeholder: 'auto',
    // The same ladder the run page's ctx picker shows — one source, one climb.
    options: CTX_LADDER.map((step) => ({ value: String(step), label: step >= 1024 ? `${Math.round(step / 1024)}K` : String(step) })),
  },
  { key: 'parallel', label: 'localModels.strataParallel', hint: 'localModels.strataParallelHint', kind: 'number', min: 2, max: 8, step: 1, placeholder: '1' },
];

/**
 * What the engines-page card shows when nothing is pinned (ADR-0039 §13).
 * These are the gateway's own directories, whether or not the files are
 * there yet — an empty box that says "auto" hides the path the install uses.
 * Stored overrides are not consulted: the card shows those itself.
 */
function resolveSetupDiscovery(): Record<string, string> {
  const workspace = strataRuntimeDir();
  return {
    workspace,
    dataRoot: path.join(getOcrHomeDir(), 'strata', 'data'),
    python: pythonCandidates(workspace).find(isFile) ?? pythonCandidates(workspace)[0],
  };
}

const SETUP: EngineSetupSpec = {
  intro: 'localModels.strataSetupIntro',
  fields: [
    { key: 'workspace', label: 'localModels.strataWorkspace', hint: 'localModels.strataWorkspaceHint', kind: 'text', mono: true, placeholder: 'auto', picker: 'directory' },
    { key: 'dataRoot', label: 'localModels.strataDataRoot', hint: 'localModels.strataDataRootHint', kind: 'text', mono: true, placeholder: 'auto', picker: 'directory' },
    { key: 'python', label: 'localModels.strataPython', hint: 'localModels.strataPythonHint', kind: 'text', mono: true, placeholder: 'auto', derived: true },
  ],
  resolve: () => resolveSetupDiscovery(),
  normalize: (raw) => {
    if (raw === undefined || raw === null) return { ok: true, setup: {} };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'strata setup must be an object' };
    const src = raw as Record<string, unknown>;
    const setup: Record<string, string> = {};
    for (const key of ['workspace', 'dataRoot', 'python'] as const) {
      const value = str(src[key]);
      if (value) setup[key] = value;
    }
    return { ok: true, setup };
  },
};

/**
 * The engine's own load model for the plan panel's estimate cards (ADR-0039:
 * the console renders the declaration; it never estimates an engine-owned
 * placement itself). The dense half rides the GPU at VRAM bandwidth; one
 * token pulls `expertsUsed / experts` of the expert mass through the pack
 * index at page-cache bandwidth (cold-cache disk reads are the pessimistic
 * tail, not the estimate).
 */
const DENSE_GB_PER_SEC = 250;
const EXPERT_STREAM_GB_PER_SEC = 50;

/** Bytes a launch maps EAGERLY: the pack's dense half and its index. */
function eagerPackBytes(pack: string): number | undefined {
  const dense = path.join(pack, 'dense.bin');
  if (!isFile(dense)) return undefined;
  let total = fs.statSync(dense).size;
  const index = path.join(pack, 'index.txt');
  if (isFile(index)) total += fs.statSync(index).size;
  return total;
}

/** The estimate half of the declaration, from facts the caller resolved. */
function estimateStrataRun(layout: StrataLayout, where: EngineProfileWhere): Pick<EngineDeclaration, 'estTokPerSec' | 'firstLoadBytes'> {
  const eager = eagerPackBytes(layout.pack);
  if (eager == null) return {};
  const experts = where.meta?.experts ?? 0;
  const used = where.meta?.expertsUsed ?? 0;
  const total = where.sizeBytes ?? 0;
  if (experts <= 0 || used <= 0 || total <= eager) return { firstLoadBytes: eager };
  const expertBytesPerToken = (total - eager) * Math.min(1, used / experts);
  const secondsPerToken = eager / 1e9 / DENSE_GB_PER_SEC + expertBytesPerToken / 1e9 / EXPERT_STREAM_GB_PER_SEC;
  return { estTokPerSec: Math.max(1, Math.round(1 / Math.max(1e-6, secondsPerToken))), firstLoadBytes: eager };
}

const PROFILE: EngineProfileSpec = {
  intro: 'localModels.strataProfileIntro',
  // No core group: there is nothing to fill in. The rows below are OVERRIDES
  // for a workspace the layout cannot infer, and an empty record is normal.
  groups: [{ id: 'advanced', label: 'localModels.strataSectionAdvanced', fields: [...PROFILE_FIELDS] }],
  normalize: (raw) => normalizeStrataProfile(raw),
  paths: (raw, modelPath) => {
    const resolved = resolveStrataLayout({ modelPath, profile: raw });
    if (!resolved.ok) return [];
    const { layout } = resolved;
    return [
      layout.workspace,
      layout.entry,
      layout.python,
      layout.pack,
      ...(layout.engineExe ? [layout.engineExe] : []),
      ...(layout.tokenizer ? [layout.tokenizer] : []),
      ...(layout.mtp ? [layout.mtp] : []),
      ...(layout.expertProfile ? [layout.expertProfile] : []),
      ...(layout.mmproj ? [layout.mmproj] : []),
    ];
  },
  describe: (raw, ctx, _kvCacheQ8, where) => {
    if (!where?.modelPath) return { argv: [], features: [] };
    const resolved = resolveStrataLayout({ modelPath: where.modelPath, profile: raw, ...(where.binary ? { binary: where.binary } : {}) });
    if (!resolved.ok) return { argv: [], features: [] };
    const { layout } = resolved;
    // ONE line: the process the gateway actually spawns. The engine argv
    // (--pack/--native/--max-context) lives INSIDE the generated config — the
    // operator never typed it and never will, so echoing it here would dress a
    // derived fact up as a knob (and duplicate what the config filename already
    // says: pack name + ctx). The curious open the JSON; the chips carry the
    // capability readout.
    const parallel = (asProfile(raw) ?? {}).parallel ?? 1;
    return {
      argv: [`--engine strata --config ${strataConfigPath(layout, ctx)}`],
      features: [
        { label: 'MTP', on: !!layout.mtp },
        { label: 'PLE', on: true },
        { label: 'Vision', on: !!(layout.visionExe && layout.mmproj) },
        // One-at-a-time is the default and says nothing; a batch the operator
        // asked for is a fact worth seeing next to MTP/Vision.
        ...(parallel >= 2 ? [{ label: `Parallel ×${parallel}`, on: true }] : []),
      ],
      ...estimateStrataRun(layout, where),
    };
  },
  // The HTTP surface answers as the pack's name — the same string the generated
  // config's `model_name` carries, so a client and the console never disagree.
  servedName: (raw, where) => {
    if (!where?.modelPath) return undefined;
    const resolved = resolveStrataLayout({ modelPath: where.modelPath, profile: raw, ...(where.binary ? { binary: where.binary } : {}) });
    return resolved.ok ? resolved.layout.modelName : undefined;
  },
};

/** What one launch writes into the engine's `--kv` flag. */
function kvFor(profile: StrataProfile): StrataKv {
  return profile.kv ?? 'int8';
}

export const STRATA_RUNTIME: EngineRuntime = {
  // `--expert-cache auto` owns placement; there is no `-ngl` to fill in.
  placement: 'engine',
  // Every shared knob that would otherwise be a dead control: the pool, the
  // ctx ceiling and the KV type are the generated config's, and the front-end
  // takes none of them on its own command line. A control that changes nothing
  // is the bug ADR-0037 names.
  accepts: { ngl: false, threads: false, flashAttn: false, kv: false, reasoning: false, spec: true, vision: true },

  serves: ({ modelPath, meta, profile }) => {
    if (!modelPath.toLowerCase().endsWith('.gguf')) {
      return { serves: false, family: false, reason: 'Strata loads GGUF shards; this file is not one, so its engine cannot serve it' };
    }
    const experts = meta?.experts ?? 0;
    const arch = meta?.arch ?? '';
    if (experts <= 0) {
      return {
        serves: false,
        family: false,
        reason: 'this checkpoint declares no routed experts (it is dense), and Strata only serves Mixture-of-Experts models',
      };
    }
    // No operator setup step gates this: the front-end and the data directory
    // are the gateway's. `needsSetup` is never set (ADR-0039 §8, §13).
    const resolved = resolveStrataLayout({ modelPath, profile });
    if (resolved.ok) return { serves: true, family: true };
    // Unresolvable, and the reason names the missing artefact.
    return {
      serves: false,
      family: arch ? STRATA_FAMILY_ARCHES.has(arch) : false,
      reason: resolved.reason,
      // The pack is the one input the gateway can produce itself (ADR-0039 §9):
      // when the layout says so, the console offers a build, not a form.
      ...(resolved.buildable ? { buildable: true } : {}),
    };
  },

  resolveCtx: ({ requested, profile, meta }) => {
    // The config is generated per launch, so the requested ctx IS the truth —
    // it is what `--max-context` will say. The ceiling is the model's trained
    // context, and the floor is the engine's own default.
    const overrides = asProfile(profile);
    const ceiling = meta?.maxCtx && meta.maxCtx >= 256 ? meta.maxCtx : undefined;
    const wanted = Number.isFinite(requested) && requested >= 256 ? Math.floor(requested) : (overrides?.maxContext ?? STRATA_DEFAULT_CTX);
    const chosen = overrides?.maxContext ?? wanted;
    return ceiling ? Math.min(chosen, ceiling) : chosen;
  },

  legs: async (facts) => {
    const profile = asProfile(facts.profile) ?? {};
    const resolved = resolveStrataLayout({ modelPath: facts.modelPath, profile, binary: facts.binary });
    if (!resolved.ok) return { error: resolved.reason };
    const { layout } = resolved;
    const config = writeStrataConfig({
      layout,
      modelPath: facts.modelPath,
      engineExe: layout.engineExe ?? facts.binary,
      ctx: facts.ctx,
      kv: kvFor(profile),
      ...(profile.parallel !== undefined ? { parallel: profile.parallel } : {}),
      ...(facts.servedName ? { servedName: facts.servedName } : {}),
      extraArgs: facts.options.extraArgs,
    });
    if (!config.ok) return { error: config.error };

    const args = [layout.entry, '--engine', 'strata', '--config', config.path, '--port', String(facts.port)];
    if (facts.host && facts.host !== '127.0.0.1') args.push('--host', facts.host);

    // ONE leg. The vision encoder is `server.py`'s child (its config's `vision`
    // block), not the gateway's: `strata-vision.exe` reads `ENC` lines from
    // stdin, so a second process listening on a port would never be reachable.
    const leg: EngineLeg = { cmd: layout.python, args, cwd: layout.workspace, key: facts.runId, aux: false, port: facts.port, name: 'engine' };
    return [leg];
  },

  /**
   * Build the pack with the workspace's OWN tooling (ADR-0039 §9):
   * `tools/iq_pack.py --gguf <shard 1> --out packs/<model-folder>`. The default
   * standalone invocation — no `--base`, no `--experts-bin`: the engine reads
   * the experts from the GGUF itself, and the packer exports the tokenizer and
   * publishes the completion marker itself. ONE leg, no port: a build serves
   * nothing, it only writes.
   */
  build: async (input) => {
    const parts = resolveWorkspaceParts();
    if (!parts.ok) {
      return {
        error: `cannot build the pack — the Strata runtime is incomplete: ${parts.missing.join('; ')}.`,
      };
    }
    const { workspace, python, dataRoot } = parts.parts;
    const packer = path.join(workspace, 'tools', 'iq_pack.py');
    if (!isFile(packer)) return { error: `cannot build the pack — the packer is missing: ${packer}` };
    const out = strataPackTarget(dataRoot, input.modelPath);
    const leg: EngineLeg = {
      cmd: python,
      args: [packer, '--gguf', input.modelPath, '--out', out],
      cwd: workspace,
      key: input.jobId,
      aux: false,
      name: 'pack',
    };
    return [leg];
  },

  profile: PROFILE,
  setup: SETUP,
};
