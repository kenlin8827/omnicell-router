/**
 * The build supervisor with a faked process layer (ADR-0039 §9): a build
 * spawns the engine's OWN tooling (never a gateway-invented command line),
 * streams its output into the job's log ring, refuses a concurrent duplicate
 * (two packers on one pack dir would interleave writes), and a finished build
 * rescans the model so the verdict flips to runnable with no restart.
 */
import '../helpers/sandbox-home.js';
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../src/cli/paths.js';
import { writeInstalledEngines } from '../../src/local/engines.js';
import { modelsRoot, readInstalledModels } from '../../src/local/model-store.js';
import {
  buildLogs,
  getBuildJob,
  setBuildJobDepsForTests,
  startBuildJob,
} from '../../src/local/build-jobs.js';
import type { LocalRunChildLike } from '../../src/local/runner.js';
import { buildGguf } from '../helpers/gguf-builder.js';
import { makeStrataWorkspace, type StrataFixture } from './strata-fixture.js';

const fixtures: StrataFixture[] = [];
let spawnCalls: { cmd: string; args: string[] }[] = [];
let exitListeners: ((code: number | null) => void)[] = [];
let exitCode: number | null | 'never' = 0;
/** Simulates the packer: runs at spawn time, writing a FINISHED pack. */
let onSpawn: ((args: string[]) => void) | null = null;

function fakeSpawn(cmd: string, args: string[]): LocalRunChildLike {
  spawnCalls.push({ cmd, args });
  onSpawn?.(args);
  return {
    pid: 43211,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event !== 'exit') return;
      const exit = listener as (code: number | null) => void;
      if (exitCode === 'never') exitListeners.push(exit);
      else queueMicrotask(() => exit(exitCode));
    },
    stdout: { on() {} },
    stderr: { on() {} },
  };
}

function resetSpawn(code: number | null | 'never', write?: (args: string[]) => void): void {
  spawnCalls = [];
  exitListeners = [];
  exitCode = code;
  onSpawn = write ?? null;
  setBuildJobDepsForTests({ spawnImpl: fakeSpawn });
}

function workspace(modelDir: string): StrataFixture {
  const fixture = makeStrataWorkspace({ modelDir, withPack: false });
  fixtures.push(fixture);
  return fixture;
}

/** Seed the registry row pointing INSIDE the Strata workspace, with a MoE
 *  header (the engine only packs MoE checkpoints). */
function seedModel(ws: StrataFixture): string {
  fs.writeFileSync(
    ws.modelPath,
    buildGguf([
      { key: 'general.architecture', type: 'string', value: 'qwen3moe' },
      { key: 'qwen3moe.block_count', type: 'uint32', value: 48 },
      { key: 'qwen3moe.expert_count', type: 'uint32', value: 512 },
      { key: 'qwen3moe.context_length', type: 'uint32', value: 32768 },
    ])
  );
  const id = `local-import/${path.basename(path.dirname(ws.modelPath))}/${path.basename(ws.modelPath)}`;
  const dir = modelsRoot();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'installed.json'),
    `${JSON.stringify({
      [id]: {
        id,
        repo: 'local-import',
        filename: path.basename(ws.modelPath),
        filePath: ws.modelPath,
        size: fs.statSync(ws.modelPath).size,
        downloadedAt: Date.now(),
      },
    }, null, 2)}\n`
  );
  return id;
}

function seedStrataInstall(): void {
  const installDir = path.join(getOcrHomeDir(), 'engines', 'strata', 'e1-cuda12');
  fs.mkdirSync(installDir, { recursive: true });
  const exe = path.join(installDir, 'strata.exe');
  fs.writeFileSync(exe, '');
  writeInstalledEngines({
    'strata:cuda12': { engine: 'strata', version: 'e1', target: 'cuda12', installDir, binaries: [exe], installedAt: Date.now() },
  });
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterAll(() => {
  setBuildJobDepsForTests(null);
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe('build jobs', () => {
  test('a build spawns the workspace packer, logs it, and the finish flips the verdict', async () => {
    const ws = workspace('abl-IQ2_XS');
    const modelId = seedModel(ws);
    seedStrataInstall();
    // The fake packer publishes a FINISHED pack (marker included), exactly
    // where the leg says it would.
    resetSpawn(0, (args) => {
      const out = args[args.indexOf('--out') + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'dense.bin'), '');
      fs.writeFileSync(path.join(out, 'native_experts.txt'), '');
    });

    const started = await startBuildJob({ modelId, engine: 'strata' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => getBuildJob(started.job.id)?.status === 'done');

    // The argv is the packer's, resolved from the workspace — one leg, no port.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe(ws.python);
    expect(spawnCalls[0].args).toEqual([
      path.join(ws.workspace, 'tools', 'iq_pack.py'),
      '--gguf', ws.modelPath,
      '--out', path.join(ws.dataRoot, 'packs', 'abl-iq2_xs'),
    ]);
    expect(buildLogs(started.job.id).some((line) => line.stream === 'gateway' && line.text.includes('process started'))).toBe(true);

    // The rescan is what makes the console's next poll show the engine as
    // runnable — no restart, no profile edit.
    const record = readInstalledModels()[modelId];
    expect(record.meta?.engines?.strata?.serves).toBe(true);
  });

  test('a second build for the same model and engine is refused while one runs', async () => {
    const ws = workspace('dup-IQ2_XS');
    const modelId = seedModel(ws);
    seedStrataInstall();
    resetSpawn('never');

    const first = await startBuildJob({ modelId, engine: 'strata' });
    expect(first.ok).toBe(true);
    const second = await startBuildJob({ modelId, engine: 'strata' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('build-active');
  });

  test('a failed leg marks the job failed with the exit code', async () => {
    const ws = workspace('fail-IQ2_XS');
    const modelId = seedModel(ws);
    seedStrataInstall();
    resetSpawn(1);

    const started = await startBuildJob({ modelId, engine: 'strata' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => getBuildJob(started.job.id)?.status === 'failed');
    expect(getBuildJob(started.job.id)?.error).toContain('exited (code 1)');
  });

  test('a build for an engine without a build capability is refused by name', async () => {
    const ws = workspace('nobuild-IQ2_XS');
    const modelId = seedModel(ws);
    const result = await startBuildJob({ modelId, engine: 'llamacpp' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('engine-cannot-build');
  });
});
