/**
 * Local model run supervisor (Local Models console).
 *
 * A RUN is one launched inference server process serving one registry model
 * over its OpenAI-compatible HTTP API. Ownership mirrors the mihomo sidecar
 * doctrine (ADR-0022): a run this gateway spawned is bound to the gateway's
 * lifetime (killed on its exit, reaped when it turns deaf); a survivor of a
 * hard-killed gateway is ADOPTED on boot when its pid still answers its
 * health endpoint, otherwise its record is closed. Runs persist as
 * `<ocrHome>/engines/runs.json` so a restart never loses sight of a live
 * server it started.
 *
 * Today the runner drives llama.cpp's `llama-server` and Strata's engine — and
 * any future engine — through ONE abstraction: each engine ships an
 * `EngineRuntime` (file gate, placement authority, argv legs, profile) and this
 * module asks it instead of branching on an engine name (ADR-0039). Layered
 * execution for gateway-placed engines IS llama.cpp's `-ngl N` (N layers in
 * VRAM, the rest on CPU/RAM, mmap streaming the remainder from disk); the
 * placement plan (`plan.ts`) computes N and the console's automatic-layer-plan
 * panel previews it. Engines that own their own placement (Strata's
 * `--expert-cache`) are launched with `ngl: -1` and no layer plan at all.
 *
 * Process output lands in a per-run in-memory ring (`runLogs`) the console's
 * run-log drawer polls; nothing is written to disk.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LOCAL_RUN_PORT,
  LOCAL_RUN_MAX_RESTARTS,
  LOCAL_RUN_READY_TIMEOUT_MS,
  LOCAL_RUN_RESTART_WINDOW_MS,
} from '../config/defaults.js';
import { getOcrHomeDir } from '../cli/paths.js';
import { EventRing, MIHOMO_LOG_RING_CAPACITY, nextRingEventId } from '../utils/event-ring.js';
import {
  engineById,
  engineSupportFor,
  installedEngineFor,
  launchableEngines,
  readInstalledEngines,
  type EngineDef,
  type InstalledEngine,
} from './engines.js';
import type { EngineLeg } from './engine-runtime.js';
import { readGgufMeta } from './gguf.js';
import { autoCtx, nglForPlan, planPlacement, KV_ELEM_Q8_0 } from './plan.js';
import { profileFor, profilesOf, readInstalledModels, type InstalledModel } from './model-store.js';
import { detectDependencies } from './detect.js';

export { llamaServerArgs } from './llamacpp.js';

export type LocalRunStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface LocalRunOptions {
  /** Context length (tokens); 0 = the planner's auto pick. */
  ctx: number;
  /** Explicit GPU layer count; -1 = the planner's auto split. */
  ngl: number;
  /** Flash attention toggle (`--flash-attn on`). */
  flashAttn: boolean;
  /** KV cache quantised to q8_0 (`--cache-type-k/v q8_0`). */
  kvCacheQ8: boolean;
  /** Reasoning parsing (`--jinja --reasoning-format auto`) for thinking models. */
  reasoning: boolean;
  /** Restart the server when it crashes (bounded, see defaults). */
  autoRestart: boolean;
  /** Resource mode: true reserves VRAM/RAM headroom for the desktop and OS;
   *  false budgets nearly everything for the model (the plan preview used the
   *  same input, so the launch matches the bars). */
  headroom: boolean;
  /** CPU thread count override; 0 = the engine's own default. */
  threads: number;
  /** Extra raw CLI arguments appended verbatim (the launch-arguments drawer). */
  extraArgs: string[];
}

export const DEFAULT_RUN_OPTIONS: LocalRunOptions = {
  ctx: 0,
  ngl: -1,
  flashAttn: true,
  kvCacheQ8: true,
  reasoning: false,
  autoRestart: true,
  headroom: true,
  threads: 0,
  extraArgs: [],
};

export interface LocalRun {
  id: string;
  modelId: string;
  /** Engine + build target actually launched (`llamacpp` / `vulkan`). */
  engine: string;
  target: string;
  binary: string;
  host: string;
  port: number;
  pid: number | null;
  status: LocalRunStatus;
  /** The effective launch parameters (auto values resolved). */
  ctx: number;
  ngl: number;
  options: LocalRunOptions;
  startedAt: number;
  readyAt?: number;
  stoppedAt?: number;
  exitCode?: number | null;
  lastError?: string;
  /** Machine-readable error class for `lastError` (`engine-died-before-ready`,
   *  `load-timeout`, `engine-exited`, `crashed-restarting`, `spawn-failed`,
   *  `gateway-restarted`). The console localizes on THIS and keeps `lastError`
   *  as the human/raw detail — the same `code` + `error` pair every other
   *  local/ result type already carries. Absent on runs recorded before the
   *  field existed, and for raw engine messages we never minted a code for. */
  lastErrorCode?: string;
  restarts: number;
  /** Auxiliary processes of this run (a vision leg, a helper server…), each
   *  with its own port. Their failure is reported, never fatal (ADR-0039). */
  aux?: LocalRunAux[];
  /** OpenAI-compatible base URL path (`/v1`). */
  apiPath: string;
}

/** One sidecar process of a run (ADR-0039 — was Strata's vision leg only). */
export interface LocalRunAux {
  /** Short name from the leg (`vision`). */
  name: string;
  pid: number | null;
  port?: number;
}

export interface LocalRunLogLine {
  id: string;
  ts: number;
  stream: 'stdout' | 'stderr' | 'gateway';
  text: string;
}

/** The slice of a child this module consumes (structural; tests fake it). */
export interface LocalRunChildLike {
  pid?: number;
  on?(event: string, listener: (...args: any[]) => void): void;
  stdout?: { on(event: string, listener: (chunk: unknown) => void): void } | null;
  stderr?: { on(event: string, listener: (chunk: unknown) => void): void } | null;
}

export type LocalRunSpawnLike = (cmd: string, args: string[], opts: Record<string, unknown>) => LocalRunChildLike;

export interface LocalRunnerDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: LocalRunSpawnLike;
  killTreeImpl?: (pid: number) => boolean;
  pidAliveImpl?: (pid: number) => boolean;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Skip the actual health HTTP probe (unit tests drive status directly). */
  healthProbe?: (port: number) => Promise<boolean>;
}

let testDeps: LocalRunnerDeps | null = null;

/** Test seam, mirroring setMihomoSidecarDepsForTests. */
export function setLocalRunnerDepsForTests(deps: LocalRunnerDeps | null): void {
  testDeps = deps;
  if (!deps) {
    for (const [id] of children) children.delete(id);
  }
}

function dep<K extends keyof LocalRunnerDeps>(key: K): NonNullable<LocalRunnerDeps[K]> | undefined {
  return testDeps?.[key] as NonNullable<LocalRunnerDeps[K]> | undefined;
}

/* ------------------------------------------------------------------------- *
 * Persisted registry
 * ------------------------------------------------------------------------- */

function runsDir(): string {
  return path.join(getOcrHomeDir(), 'engines');
}

function runsStateFile(): string {
  return path.join(runsDir(), 'runs.json');
}

function readRunRecords(): Record<string, LocalRun> {
  try {
    const parsed = JSON.parse(fs.readFileSync(runsStateFile(), 'utf8')) as Record<string, LocalRun>;
    if (!parsed || typeof parsed !== 'object') return {};
    for (const record of Object.values(parsed)) backfillErrorCode(record);
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Recover `lastErrorCode` for records written before the field existed.
 *
 * Without this, an archive recorded by an older build keeps showing the raw
 * English sentence forever — the console localizes on the CODE, and a missing
 * code is exactly the "unknown, stay raw" path. The sentences below are the
 * ones this module minted, so the mapping is lossless; anything unrecognized
 * is left alone (a raw engine message we never minted a code for).
 */
function backfillErrorCode(record: LocalRun): void {
  if (record.lastErrorCode || !record.lastError) return;
  const text = record.lastError;
  if (text === 'engine process died before becoming ready') record.lastErrorCode = 'engine-died-before-ready';
  else if (text === 'gateway restarted while the engine was running') record.lastErrorCode = 'gateway-restarted';
  else if (/^the engine did not become ready within \d+ min$/.test(text)) record.lastErrorCode = 'load-timeout';
  else if (/^crashed \(exit .+\); restart \d+\/\d+$/.test(text)) record.lastErrorCode = 'crashed-restarting';
  else if (/^engine exited \(code .+\)$/.test(text)) record.lastErrorCode = 'engine-exited';
}

function writeRunRecords(state: Record<string, LocalRun>): void {
  fs.mkdirSync(runsDir(), { recursive: true });
  const tmp = `${runsStateFile()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, runsStateFile());
}

/** Live view: the in-memory map is authoritative for active runs; the file
 *  remembers ended ones until the console prunes them. */
const live = new Map<string, LocalRun>();
const children = new Map<string, ChildProcess | LocalRunChildLike>();
const logs = new Map<string, EventRing<LocalRunLogLine>>();
const ANSI_RE = /\x1b\[?[0-9;?]*[a-zA-Z]/g;
const LINE_MAX_CHARS = 2000;

/**
 * One raw child-process line as a log ring stores it; null = nothing to log.
 * Shared with the build supervisor (build-jobs.ts) so run and build logs read
 * identically.
 */
export function sanitizeRunLogText(raw: string): string | null {
  const text = raw.replace(ANSI_RE, '').replace(/\r$/, '');
  if (!text.trim()) return null;
  return text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text;
}

function ringFor(id: string): EventRing<LocalRunLogLine> {
  let ring = logs.get(id);
  if (!ring) {
    ring = new EventRing<LocalRunLogLine>(undefined, MIHOMO_LOG_RING_CAPACITY);
    logs.set(id, ring);
  }
  return ring;
}

export function appendRunLog(id: string, stream: LocalRunLogLine['stream'], raw: string): void {
  const text = sanitizeRunLogText(raw);
  if (text === null) return;
  const ts = Date.now();
  ringFor(id).append({
    id: nextRingEventId('r-', ts),
    ts,
    stream,
    text,
  });
}

export function runLogs(id: string, limit = 300): LocalRunLogLine[] {
  const rows = ringFor(id).rows();
  return limit >= rows.length ? rows : rows.slice(rows.length - limit);
}

function persist(run: LocalRun): void {
  try {
    const state = readRunRecords();
    state[run.id] = run;
    writeRunRecords(state);
  } catch {
    // A failed persist only costs the boot-time adoption of this run.
  }
}

function pidAlive(pid: number): boolean {
  const impl = dep('pidAliveImpl');
  if (impl) return impl(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid: number): boolean {
  const impl = dep('killTreeImpl');
  if (impl) return impl(pid);
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
      return res.status === 0;
    }
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- *
 * Health + ports
 * ------------------------------------------------------------------------- */

async function healthProbe(port: number): Promise<boolean> {
  const impl = dep('healthProbe');
  if (impl) return impl(port);
  const fetchImpl = dep('fetchImpl') ?? fetch;
  try {
    // llama-server answers /health 200 once the model is loaded (503 while
    // loading); /v1/models is the fallback for builds without /health.
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return true;
    if (res.status !== 503) {
      const alt = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
      return alt.ok;
    }
    return false;
  } catch {
    return false;
  }
}

/** First free port from the base, skipping ports live runs already hold.
 *  "Free" = we can bind it on the listen host right now. `reserved` covers a
 *  port this process is about to hand out but has not spawned onto yet — the
 *  vision leg allocates right after the engine, and two unbound allocations in
 *  the same tick would otherwise collide. */
async function allocatePort(reserved?: ReadonlySet<number>): Promise<number> {
  const held = new Set([...live.values()].filter((r) => r.status === 'starting' || r.status === 'ready').map((r) => r.port));
  for (let port = DEFAULT_LOCAL_RUN_PORT; port < DEFAULT_LOCAL_RUN_PORT + 100; port++) {
    if (held.has(port) || reserved?.has(port)) continue;
    const taken = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(true));
      probe.once('listening', () => probe.close(() => resolve(false)));
      probe.listen(port, '127.0.0.1');
    });
    if (!taken) return port;
  }
  return DEFAULT_LOCAL_RUN_PORT;
}

/* ------------------------------------------------------------------------- *
 * Launch
 * ------------------------------------------------------------------------- */

export type StartRunResult = { ok: true; run: LocalRun } | { ok: false; code: string; error: string };

/**
 * The engine's server binary among the unpacked ones: the catalog's own
 * `binaryNames` order wins (a `-cli` helper never takes the `-server` slot),
 * and the first binary is the fallback for a build whose names moved.
 */
function pickBinary(install: InstalledEngine, engine: EngineDef): string | null {
  const stem = (p: string): string => path.basename(p).toLowerCase().replace(/\.(exe|bat|cmd)$/i, '');
  for (const wanted of engine.binaryNames) {
    const hit = install.binaries.find((bin) => stem(bin) === wanted.toLowerCase());
    if (hit) return hit;
  }
  return install.binaries[0] ?? null;
}

/** The backend family of one install (drives the planner, not the engine). */
function backendOf(engine: EngineDef, target: string): string {
  return engine.targets(process.platform, process.arch).find((t) => t.id === target)?.backend ?? 'cpu';
}

let runSeq = 0;

/**
 * Launch one model on one installed engine target. The record is persisted
 * BEFORE the spawn returns so a crash mid-launch still leaves a trace the
 * boot sweep closes.
 *
 * Every engine-shaped question is answered by the engine's runtime
 * (ADR-0039): `serves()` gates the launch, `placement` says who resolves
 * ctx/ngl, `legs()` produces the argv. This function names no engine.
 */
export async function startLocalRun(opts: {
  modelId: string;
  engine: string;
  target?: string;
  options?: Partial<LocalRunOptions>;
}): Promise<StartRunResult> {
  const model: InstalledModel | undefined = readInstalledModels()[opts.modelId];
  if (!model) return { ok: false, code: 'model-missing', error: `model '${opts.modelId}' is not in the registry` };
  try {
    fs.statSync(model.filePath);
  } catch {
    return { ok: false, code: 'file-missing', error: `model file is gone: ${model.filePath}` };
  }
  const engine = engineById(opts.engine);
  if (!engine) return { ok: false, code: 'unknown-engine', error: `unknown engine '${opts.engine}'` };
  const runtime = engine.runtime;
  if (!runtime) return { ok: false, code: 'engine-not-launchable', error: `${engine.name} is install-only; the gateway cannot launch it` };

  const meta = readGgufMeta(model.filePath);
  const support = engineSupportFor(model.filePath, meta.ok ? meta : null, profilesOf(model));
  const verdict = support.engines[engine.id];
  if (!verdict?.serves) {
    return { ok: false, code: 'engine-cannot-serve', error: verdict?.reason ?? `${engine.name} cannot serve this file` };
  }

  // Target resolution: the explicit pick, else the engine's only install,
  // else the GPU-backed install when there is a choice.
  const installs = Object.values(readInstalledEngines()).filter((r) => r.engine === engine.id);
  const install = opts.target
    ? installedEngineFor(engine.id, opts.target)
    : installs.length === 1
      ? installs[0]
      : (installs.find((r) => r.target !== 'cpu') ?? installs[0] ?? null);
  if (!install) return { ok: false, code: 'engine-not-installed', error: `${engine.name} is not installed${opts.target ? ` for target '${opts.target}'` : ''}` };
  const binary = pickBinary(install, engine);
  if (!binary) return { ok: false, code: 'binary-missing', error: `no server binary under ${install.installDir}` };

  const options: LocalRunOptions = { ...DEFAULT_RUN_OPTIONS, ...(opts.options ?? {}), extraArgs: [...(opts.options?.extraArgs ?? [])] };
  const backend = backendOf(engine, install.target);
  const profile = runtime.profile ? profileFor(model, engine.id) : undefined;

  // A profile names paths outside the models root (a pack, a draft head, an
  // expert binary). Reporting ALL missing ones up front beats one failed
  // launch per typo — the runner never guesses an alternative.
  if (runtime.profile && profile !== undefined) {
    const missing = runtime.profile.paths(profile, model.filePath).filter((p) => {
      try {
        fs.statSync(p);
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      return { ok: false, code: 'profile-path-missing', error: `the ${engine.name} launch profile points at missing paths: ${missing.join(', ')}` };
    }
  }

  let ctx: number;
  let ngl: number;
  if (runtime.placement === 'engine') {
    // The engine owns placement: the layer planner is BYPASSED rather than
    // faked (ADR-0038 §5). `ngl -1` = not applicable, which is how the
    // console knows not to draw layer bars.
    const fallback = meta.ok && meta.maxCtx ? Math.min(meta.maxCtx, 32768) : 32768;
    ctx = runtime.resolveCtx
      ? runtime.resolveCtx({ requested: options.ctx, profile, meta: meta.ok ? meta : null })
      : fallback;
    ngl = -1;
  } else {
    // The launch parameters ARE the plan: the same estimator the console's
    // automatic-layer-plan panel previewed resolves ctx and the GPU layer split
    // here.
    const detect = await detectDependencies();
    const planInput = {
      sizeBytes: model.size,
      meta: meta.ok ? meta : null,
      ...(detect.vramMb != null ? { vramMb: detect.vramMb } : {}),
      ramBytes: os.totalmem(),
      backend,
      kvElemBytes: options.kvCacheQ8 ? KV_ELEM_Q8_0 : 2,
      headroom: options.headroom,
    };
    ctx = options.ctx > 0 ? options.ctx : autoCtx(planInput);
    const plan = planPlacement({ ...planInput, ctx });
    ngl = options.ngl >= 0 ? options.ngl : nglForPlan(plan);
  }

  const port = await allocatePort();
  // Loopback always, with no override (ADR-0038 §4). The engine is an upstream
  // of the gateway, never a second public face: a LAN listener would be a second
  // API surface with no routing, no quota, no breaker and no capture. Everything
  // a client needs from a local model is served by the gateway port.
  const host = '127.0.0.1';

  const run: LocalRun = {
    id: `run-${Date.now().toString(36)}-${(runSeq++).toString(36)}`,
    modelId: model.id,
    engine: engine.id,
    target: install.target,
    binary,
    host,
    port,
    pid: null,
    status: 'starting',
    ctx,
    ngl,
    options,
    startedAt: Date.now(),
    restarts: 0,
    apiPath: '/v1',
  };
  live.set(run.id, run);
  persist(run);
  appendRunLog(
    run.id,
    'gateway',
    `launching ${engine.name} (${install.target}) — ${path.basename(model.filePath)}, ctx ${ctx}, ngl ${ngl >= 0 ? ngl : 'n/a'}`
  );
  const spawned = await spawnFor(run, model.filePath);
  if (!spawned.ok) {
    run.status = 'failed';
    run.lastErrorCode = 'spawn-failed';
    run.lastError = spawned.error;
    run.stoppedAt = Date.now();
    persist(run);
    return { ok: false, code: 'spawn-failed', error: spawned.error };
  }
  return { ok: true, run };
}

/**
 * The argv legs one launch spawns, as the engine's runtime builds them: the
 * engine first, its auxiliary legs after. Returns the refusal text when the
 * engine needs data it does not have rather than spawning something
 * half-formed (ADR-0039).
 */
export async function launchLegs(run: LocalRun, modelPath: string, model: InstalledModel | null): Promise<EngineLeg[] | { error: string }> {
  const engine = engineById(run.engine);
  if (!engine?.runtime) return { error: `unknown engine '${run.engine}'` };
  return engine.runtime.legs(
    {
      runId: run.id,
      modelPath,
      profile: model ? profileFor(model, run.engine) : undefined,
      // The operator's name, when set — the engine answers as it (ADR-0038 §7).
      ...(model?.name?.trim() ? { servedName: model.name.trim() } : {}),
      port: run.port,
      host: run.host,
      ctx: run.ctx,
      ngl: run.ngl,
      options: run.options,
      backend: backendOf(engine, run.target),
      target: run.target,
      binary: run.binary,
    },
    // Auxiliary legs get their own port by the same allocator; reserving the
    // engine's keeps two allocations in one tick from colliding.
    { allocatePort: () => allocatePort(new Set([run.port])) }
  );
}

/**
 * Drain one child pipe into whole lines (an undrained pipe can block the
 * child). Shared with the build supervisor (build-jobs.ts).
 */
export function pipeChildLines(pipe: LocalRunChildLike['stdout'], onLine: (line: string) => void): void {
  if (!pipe) return;
  let pending = '';
  pipe.on('data', (chunk) => {
    pending += typeof chunk === 'string' ? chunk : String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) onLine(line);
    if (pending.length > 8192) {
      onLine(pending);
      pending = '';
    }
  });
}

function attachPipes(run: LocalRun, child: LocalRunChildLike, label?: string): void {
  const attach = (pipe: LocalRunChildLike['stdout'], stream: 'stdout' | 'stderr') => {
    pipeChildLines(pipe, (line) => appendRunLog(run.id, stream, label ? `[${label}] ${line}` : line));
  };
  attach(child.stdout, 'stdout');
  attach(child.stderr, 'stderr');
}

async function spawnFor(run: LocalRun, modelPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const spawnImpl = dep('spawnImpl') ?? ((cmd: string, args: string[], o: Record<string, unknown>) => spawn(cmd, args, o as never));
  const model = readInstalledModels()[run.modelId] ?? null;
  const legs = await launchLegs(run, modelPath, model);
  if (!Array.isArray(legs)) return { ok: false, error: legs.error };
  const main = legs[0];

  let child: LocalRunChildLike;
  try {
    child = spawnImpl(main.cmd, main.args, {
      cwd: main.cwd,
      detached: false,
      // Piped so the run log drawer can show the engine's own words; both
      // pipes are drained below, so a chatty engine never blocks on a full
      // pipe buffer.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'spawn failed' };
  }
  run.pid = child.pid ?? null;
  persist(run);
  if (run.pid) appendRunLog(run.id, 'gateway', `process started (pid ${run.pid}, port ${run.port})`);

  attachPipes(run, child);

  const record = run;
  child.on?.('error', (err: Error) => {
    appendRunLog(run.id, 'gateway', `spawn error: ${err.message}`);
    run.status = 'failed';
    run.lastErrorCode = 'spawn-failed';
    run.lastError = err.message;
    run.stoppedAt = Date.now();
    children.delete(record.id);
    persist(run);
  });
  child.on?.('exit', (code: number | null) => {
    children.delete(record.id);
    appendRunLog(run.id, 'gateway', `process exited (code ${code ?? 'null'})`);
    if (record.status === 'stopping') {
      record.status = 'stopped';
      record.exitCode = code;
      record.stoppedAt = Date.now();
      persist(record);
      return;
    }
    // Unexpected exit: crash. Restart within budget when asked to. The budget
    // resets after a full restart window of continuous readiness — a server
    // that ran for hours earns a fresh allowance.
    record.exitCode = code;
    const stableSince = record.readyAt ?? record.startedAt;
    if (Date.now() - stableSince > LOCAL_RUN_RESTART_WINDOW_MS) record.restarts = 0;
    const restartable = record.options.autoRestart && record.restarts < LOCAL_RUN_MAX_RESTARTS;
    if (restartable && code !== 0) {
      record.restarts += 1;
      record.status = 'starting';
      record.lastErrorCode = 'crashed-restarting';
      record.lastError = `crashed (exit ${code ?? 'null'}); restart ${record.restarts}/${LOCAL_RUN_MAX_RESTARTS}`;
      persist(record);
      appendRunLog(record.id, 'gateway', record.lastError);
      setTimeout(() => {
        if (record.status !== 'starting') return;
        void spawnFor(record, modelPathOf(record) ?? modelPath);
      }, 2000);
      return;
    }
    record.status = 'failed';
    record.lastErrorCode = 'engine-exited';
    record.lastError = `engine exited (code ${code ?? 'null'})`;
    record.stoppedAt = Date.now();
    persist(record);
  });
  if (child.pid) children.set(record.id, child);

  // Auxiliary legs: spawned AFTER the engine, and their failure is reported
  // rather than fatal (ADR-0038 §4) — the engine is what answers chat.
  for (const leg of legs.slice(1)) {
    spawnAuxLeg(run, leg, spawnImpl);
  }
  return { ok: true };
}

function spawnAuxLeg(run: LocalRun, leg: EngineLeg, spawnImpl: LocalRunSpawnLike): void {
  const label = leg.name ?? (leg.key.includes('#') ? leg.key.slice(leg.key.indexOf('#') + 1) : 'aux');
  let child: LocalRunChildLike;
  try {
    child = spawnImpl(leg.cmd, leg.args, {
      cwd: leg.cwd,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    appendRunLog(run.id, 'gateway', `${label} leg failed to start: ${err instanceof Error ? err.message : 'spawn failed'}`);
    return;
  }
  const entry: LocalRunAux = { name: label, pid: child.pid ?? null, ...(leg.port !== undefined ? { port: leg.port } : {}) };
  run.aux = [...(run.aux ?? []).filter((aux) => aux.name !== label), entry];
  persist(run);
  appendRunLog(run.id, 'gateway', `${label} leg started (pid ${child.pid ?? '?'}, port ${leg.port ?? run.port})`);
  attachPipes(run, child, label);
  child.on?.('error', (err: Error) => {
    appendRunLog(run.id, 'gateway', `${label} leg error: ${err.message}`);
    children.delete(leg.key);
  });
  child.on?.('exit', (code: number | null) => {
    children.delete(leg.key);
    appendRunLog(run.id, 'gateway', `${label} leg exited (code ${code ?? 'null'}) — the engine keeps serving`);
    run.aux = (run.aux ?? []).map((aux) => (aux.name === label ? { ...aux, pid: null } : aux));
    persist(run);
  });
  if (child.pid) children.set(leg.key, child);
}

/** The model path a restart respawns with (the registry is re-read — a
 *  deleted model fails the restart instead of resurrecting a stale path). */
function modelPathOf(run: LocalRun): string | null {
  const model = readInstalledModels()[run.modelId];
  return model?.filePath ?? null;
}

/* ------------------------------------------------------------------------- *
 * Stop / status / boot sweep
 * ------------------------------------------------------------------------- */

export function stopLocalRun(id: string): { ok: boolean; error?: string } {
  const run = live.get(id) ?? readRunRecords()[id];
  if (!run) return { ok: false, error: 'unknown run' };
  if (run.status !== 'starting' && run.status !== 'ready') return { ok: true };
  run.status = 'stopping';
  persist(run);
  appendRunLog(run.id, 'gateway', 'stop requested');
  // Auxiliary legs are SEPARATE processes (each with its own pid), so killing
  // the engine's tree would leave them holding VRAM. Stop them first — if one
  // hangs, the engine stop still proceeds.
  for (const aux of run.aux ?? []) {
    if (aux.pid == null) continue;
    if (pidAlive(aux.pid)) killTree(aux.pid);
    children.delete(`${run.id}#${aux.name}`);
  }
  if (run.aux?.length) {
    run.aux = run.aux.map((aux) => ({ ...aux, pid: null }));
  }
  const pid = run.pid;
  if (pid != null && pidAlive(pid)) {
    if (!killTree(pid)) {
      run.status = 'ready';
      persist(run);
      return { ok: false, error: `could not terminate pid ${pid}` };
    }
  }
  run.status = 'stopped';
  run.stoppedAt = Date.now();
  children.delete(id);
  persist(run);
  return { ok: true };
}

/** List every run the gateway knows: live rows refreshed, dead ones from the
 *  registry. Health is probed live for active rows (few, bounded timeout). */
export async function listLocalRuns(): Promise<LocalRun[]> {
  const records = readRunRecords();
  const out: LocalRun[] = [];
  const seen = new Set<string>();
  for (const run of live.values()) {
    seen.add(run.id);
    if (run.status === 'starting' || run.status === 'ready') {
      const alive = run.pid != null && pidAlive(run.pid);
      const healthy = alive && (await healthProbe(run.port));
      if (healthy && run.status === 'starting') {
        run.status = 'ready';
        run.readyAt = Date.now();
        persist(run);
        appendRunLog(run.id, 'gateway', `ready — http://${run.host}:${run.port}${run.apiPath} (loopback only; clients call the gateway)`);
      } else if (!alive) {
        // The exit handler may not have fired yet (adopted rows have none);
        // a dead pid is a dead run.
        run.status = run.status === 'starting' ? 'failed' : 'stopped';
        if (run.status === 'failed') {
          run.lastErrorCode = 'engine-died-before-ready';
          run.lastError = 'engine process died before becoming ready';
        }
        run.stoppedAt = Date.now();
        persist(run);
      } else if (run.status === 'starting' && Date.now() - run.startedAt > (dep('readyTimeoutMs') ?? LOCAL_RUN_READY_TIMEOUT_MS)) {
        // Still loading past the hang guard: kill it rather than leave a
        // silent weight-loader holding RAM forever.
        appendRunLog(run.id, 'gateway', 'load timed out; stopping the engine');
        if (run.pid != null) killTree(run.pid);
        run.status = 'failed';
        run.lastErrorCode = 'load-timeout';
        run.lastError = `the engine did not become ready within ${Math.round((dep('readyTimeoutMs') ?? LOCAL_RUN_READY_TIMEOUT_MS) / 60000)} min`;
        run.stoppedAt = Date.now();
        persist(run);
      }
    }
    out.push(run);
  }
  for (const record of Object.values(records)) {
    if (!seen.has(record.id)) out.push(record);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** One run's current view (detail polling). */
export async function getLocalRun(id: string): Promise<LocalRun | null> {
  const rows = await listLocalRuns();
  return rows.find((row) => row.id === id) ?? null;
}

/**
 * Boot sweep: close records whose process is gone, adopt survivors. A run
 * this gateway shape spawned that still answers its health endpoint becomes
 * `adopted`-flavoured — status polls keep working, the log ring starts empty
 * (the pipes died with the last gateway), and stop still kills by pid.
 */
export async function restoreLocalRuns(): Promise<void> {
  const records = readRunRecords();
  let changed = false;
  for (const record of Object.values(records)) {
    if (record.status !== 'starting' && record.status !== 'ready' && record.status !== 'stopping') continue;
    const alive = record.pid != null && pidAlive(record.pid);
    const healthy = alive && (await healthProbe(record.port));
    if (alive && healthy) {
      live.set(record.id, record);
      // Auxiliary legs have no children entry after a restart — trust the pid
      // probe, never a recorded one: a dead pid is cleared so stop does not
      // chase a recycled pid.
      const aux = record.aux ?? [];
      const deadAux = aux.filter((entry) => entry.pid != null && !pidAlive(entry.pid));
      if (deadAux.length > 0) {
        record.aux = aux.map((entry) => (entry.pid != null && !pidAlive(entry.pid) ? { ...entry, pid: null } : entry));
        records[record.id] = record;
        changed = true;
      }
      appendRunLog(record.id, 'gateway', 'adopted a surviving engine process from the previous gateway run');
      continue;
    }
    record.status = record.status === 'stopping' ? 'stopped' : 'failed';
    record.stoppedAt = record.stoppedAt ?? Date.now();
    if (record.status === 'failed' && record.lastError === undefined) {
      record.lastErrorCode = 'gateway-restarted';
      record.lastError = 'gateway restarted while the engine was running';
    }
    records[record.id] = record;
    changed = true;
  }
  if (changed) {
    try {
      writeRunRecords(records);
    } catch {
      // A failed sweep write only leaves stale rows until the next boot.
    }
  }
}

/**
 * Synchronous teardown for the gateway's exit handler (next to
 * stopSpawnedMihomoSync): engines THIS process spawned are our children and
 * must not survive us. Adopted survivors have no entry in `children` and are
 * left alone.
 */
/** The live run currently serving one registry model (newest wins), or null. */
export function activeRunFor(modelId: string): LocalRun | null {
  let best: LocalRun | null = null;
  for (const run of live.values()) {
    if (run.modelId !== modelId) continue;
    if (run.status !== 'ready' && run.status !== 'starting') continue;
    if (!best || run.startedAt > best.startedAt) best = run;
  }
  return best;
}

/** The name the local server answers as `model`, given the registry record.
 *  The operator-chosen name wins (ADR-0038 §7); then an engine whose profile
 *  owns the served name (Strata's `model_name`); otherwise the file stem is
 *  the honest default. */
export function servedNameFor(model: InstalledModel): string {
  const operator = model.name?.trim();
  if (operator) return operator;
  for (const engine of launchableEngines()) {
    const spec = engine.runtime?.profile;
    if (!spec?.servedName) continue;
    const profile = profileFor(model, engine.id);
    // A name only exists for a server that would actually serve the file: an
    // engine that cannot load it must not rename it in the catalog.
    const verdict = engine.runtime?.serves({ modelPath: model.filePath, meta: model.meta ? ({ ok: true, ...model.meta } as never) : null, profile });
    if (!verdict?.serves) continue;
    const name = spec.servedName(profile, { modelPath: model.filePath });
    if (name) return name;
  }
  return path.basename(model.filePath).replace(/\.gguf$/i, '');
}

export function stopSpawnedLocalRunsSync(): void {
  for (const [id, child] of children) {
    const pid = child.pid ?? live.get(id)?.pid;
    if (pid == null) continue;
    try {
      if (pidAlive(pid)) killTree(pid);
    } catch {
      // Best effort: the teardown must never wedge process exit.
    }
  }
  children.clear();
}

/** Prune ended records (the registry keeps them for the console's history
 *  until the operator clears). Returns how many rows were dropped. */
export function pruneLocalRuns(): number {
  const records = readRunRecords();
  let dropped = 0;
  for (const [id, record] of Object.entries(records)) {
    if (live.has(id)) continue;
    if (record.status === 'stopped' || record.status === 'failed') {
      delete records[id];
      logs.delete(id);
      dropped += 1;
    }
  }
  if (dropped > 0) {
    try {
      writeRunRecords(records);
    } catch {
      // Best effort.
    }
  }
  return dropped;
}

/**
 * Drop ONE ended run record (history hygiene from the monitor board).
 *
 * Returns the same `code` + `error` pair as every other local/ mutation, and
 * refuses a LIVE run by name: deleting the record of a serving engine would
 * orphan its process (nothing would own the stop), so the operator must stop
 * it first. `not-found` is reported distinctly from success so the board can
 * drop a stale row without pretending it deleted something.
 */
export function deleteLocalRun(id: string): { ok: true } | { ok: false; code: string; error: string } {
  if (live.has(id)) {
    return { ok: false, code: 'run-live', error: 'the run is still live; stop it before deleting the record' };
  }
  const records = readRunRecords();
  const record = records[id];
  if (!record) return { ok: false, code: 'not-found', error: `no run record "${id}"` };
  delete records[id];
  logs.delete(id);
  try {
    writeRunRecords(records);
  } catch (err) {
    return { ok: false, code: 'persist-failed', error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}
