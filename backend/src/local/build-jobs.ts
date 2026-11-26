/**
 * Engine build jobs (ADR-0039 §9).
 *
 * A BUILD produces the launch input an engine derives — today that is Strata's
 * pack, written by the workspace's own tooling (`tools/iq_pack.py`). A build is
 * NOT a run: no port, no health probe, no adoption, no restart budget. It
 * spawns the engine's legs in order, streams their output into a per-job log
 * ring, and finishes. Interruption safety comes from the packer's own
 * contract — the completion marker is published last and `looksLikePack`
 * requires it — so a gateway restart mid-build needs no bookkeeping here: the
 * half-written pack simply never matches, and the next build rewrites it.
 *
 * The module names no engine: the argv comes from the engine's
 * `EngineRuntime.build`, the same registry the runner reads (ADR-0039).
 */
import { spawn } from 'node:child_process';
import { EventRing, MIHOMO_LOG_RING_CAPACITY, nextRingEventId } from '../utils/event-ring.js';
import type { EngineLeg } from './engine-runtime.js';
import { engineById, readInstalledEngines } from './engines.js';
import { profileFor, readInstalledModels, rescanModelMeta } from './model-store.js';
import {
  pipeChildLines,
  sanitizeRunLogText,
  type LocalRunChildLike,
  type LocalRunLogLine,
  type LocalRunSpawnLike,
} from './runner.js';

export type BuildJobStatus = 'building' | 'done' | 'failed';

export interface BuildJob {
  id: string;
  modelId: string;
  engine: string;
  status: BuildJobStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** Machine-readable error class for `error` (`build-leg-exited`), so the
   *  console localizes instead of showing the backend sentence raw — the same
   *  `code` + `error` pair `LocalRun.lastErrorCode` carries (ADR-0040). */
  errorCode?: string;
}

const jobs = new Map<string, BuildJob>();
const logs = new Map<string, EventRing<LocalRunLogLine>>();
/** Finished jobs the console's poll still shows; the oldest beyond this go. */
const FINISHED_JOBS_KEPT = 20;
let jobSeq = 0;

let testSpawn: LocalRunSpawnLike | null = null;

/** Test seam, mirroring setLocalRunnerDepsForTests. */
export function setBuildJobDepsForTests(deps: { spawnImpl?: LocalRunSpawnLike } | null): void {
  testSpawn = deps?.spawnImpl ?? null;
}

function ringFor(id: string): EventRing<LocalRunLogLine> {
  let ring = logs.get(id);
  if (!ring) {
    ring = new EventRing<LocalRunLogLine>(undefined, MIHOMO_LOG_RING_CAPACITY);
    logs.set(id, ring);
  }
  return ring;
}

export function appendBuildLog(id: string, stream: LocalRunLogLine['stream'], raw: string): void {
  const text = sanitizeRunLogText(raw);
  if (text === null) return;
  const ts = Date.now();
  ringFor(id).append({ id: nextRingEventId('b-', ts), ts, stream, text });
}

export function buildLogs(id: string, limit = 300): LocalRunLogLine[] {
  const rows = ringFor(id).rows();
  return limit >= rows.length ? rows : rows.slice(rows.length - limit);
}

/** Newest first; finished history is capped, building jobs are always listed. */
export function listBuildJobs(): BuildJob[] {
  const all = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  let finished = 0;
  return all.filter((job) => {
    if (job.status === 'building') return true;
    finished += 1;
    return finished <= FINISHED_JOBS_KEPT;
  });
}

export function getBuildJob(id: string): BuildJob | null {
  return jobs.get(id) ?? null;
}

export type StartBuildResult = { ok: true; job: BuildJob } | { ok: false; code: string; error: string };

/**
 * Start one build for one (model, engine). The legs come from the engine's
 * runtime; a refusal (incomplete workspace, missing tool) surfaces as the
 * error rather than spawning something half-formed.
 */
export async function startBuildJob(opts: { modelId: string; engine: string }): Promise<StartBuildResult> {
  const model = readInstalledModels()[opts.modelId];
  if (!model) return { ok: false, code: 'model-missing', error: `model '${opts.modelId}' is not in the registry` };
  const engine = engineById(opts.engine);
  if (!engine) return { ok: false, code: 'unknown-engine', error: `unknown engine '${opts.engine}'` };
  const build = engine.runtime?.build;
  if (!build) return { ok: false, code: 'engine-cannot-build', error: `${engine.name} has no launch input it can build` };
  // One active build per (model, engine): two packers writing one pack dir
  // would interleave their writes into a single weight set.
  for (const job of jobs.values()) {
    if (job.modelId === opts.modelId && job.engine === engine.id && job.status === 'building') {
      return { ok: false, code: 'build-active', error: `a build is already running for this model on ${engine.name} (job ${job.id})` };
    }
  }

  const job: BuildJob = {
    id: `build-${Date.now().toString(36)}-${(jobSeq++).toString(36)}`,
    modelId: opts.modelId,
    engine: engine.id,
    status: 'building',
    startedAt: Date.now(),
  };
  // The installed binary is only a discovery fallback (a workspace that ships
  // its tooling beside the engine); the model path anchors everything else.
  const install = Object.values(readInstalledEngines()).find((row) => row.engine === engine.id);
  const legs = await build({
    jobId: job.id,
    modelPath: model.filePath,
    profile: profileFor(model, engine.id),
    ...(install?.binaries[0] ? { binary: install.binaries[0] } : {}),
  });
  if (!Array.isArray(legs)) return { ok: false, code: 'build-refused', error: legs.error };

  jobs.set(job.id, job);
  appendBuildLog(job.id, 'gateway', `building the ${engine.name} launch input for ${model.filePath}`);
  void executeLegs(job, legs);
  return { ok: true, job };
}

async function executeLegs(job: BuildJob, legs: EngineLeg[]): Promise<void> {
  for (const leg of legs) {
    const code = await spawnLeg(job, leg);
    if (code !== 0) {
      job.status = 'failed';
      job.errorCode = 'build-leg-exited';
      job.error = `${leg.name ?? 'build'} exited (code ${code ?? 'null'})`;
      job.finishedAt = Date.now();
      appendBuildLog(job.id, 'gateway', job.error);
      return;
    }
  }
  job.status = 'done';
  job.finishedAt = Date.now();
  appendBuildLog(job.id, 'gateway', 'build finished');
  // The build changed what the engine can serve (the pack is ON DISK now), so
  // the model's cached verdicts are stale: re-derive them, and the console's
  // next list flips the engine to runnable with no restart (ADR-0039 §9).
  rescanModelMeta(job.modelId);
}

/** Spawn one leg and resolve with its exit code (-1 when the spawn failed). */
function spawnLeg(job: BuildJob, leg: EngineLeg): Promise<number | null> {
  const spawnImpl = testSpawn ?? ((cmd: string, args: string[], o: Record<string, unknown>) => spawn(cmd, args, o as never));
  return new Promise((resolve) => {
    let child: LocalRunChildLike;
    try {
      child = spawnImpl(leg.cmd, leg.args, {
        cwd: leg.cwd,
        detached: false,
        // Piped so the build log drawer can show the tool's own words; both
        // pipes are drained, so a chatty build never blocks on a full buffer.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      appendBuildLog(job.id, 'gateway', `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      resolve(-1);
      return;
    }
    appendBuildLog(job.id, 'gateway', `process started (pid ${child.pid ?? '?'})`);
    pipeChildLines(child.stdout ?? null, (line) => appendBuildLog(job.id, 'stdout', line));
    pipeChildLines(child.stderr ?? null, (line) => appendBuildLog(job.id, 'stderr', line));
    child.on?.('error', (err: Error) => {
      appendBuildLog(job.id, 'gateway', `spawn error: ${err.message}`);
      resolve(-1);
    });
    child.on?.('exit', (code: number | null) => resolve(code));
  });
}
