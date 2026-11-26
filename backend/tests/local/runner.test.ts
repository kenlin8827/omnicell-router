/**
 * The run supervisor with a faked process layer (ADR-0037 §5): launch resolves
 * the plan into real `-ngl`/`-c` arguments, health polls migrate starting →
 * ready, stop kills by pid, a crash restarts within budget, and the boot sweep
 * adopts pid-alive survivors while closing the dead.
 */
import '../helpers/sandbox-home.js';
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../src/cli/paths.js';
import { writeInstalledEngines } from '../../src/local/engines.js';
import { modelsRoot } from '../../src/local/model-store.js';
import {
  DEFAULT_RUN_OPTIONS,
  listLocalRuns,
  llamaServerArgs,
  restoreLocalRuns,
  runLogs,
  setLocalRunnerDepsForTests,
  startLocalRun,
  stopLocalRun,
  stopSpawnedLocalRunsSync,
  type LocalRun,
  type LocalRunChildLike,
} from '../../src/local/runner.js';
import { buildGguf } from '../helpers/gguf-builder.js';
import { makeStrataWorkspace, type StrataFixture } from './strata-fixture.js';

const FAKE_PID = 43210;
const alivePids = new Set<number>();
let healthy = true;
let killed: number[] = [];
let spawnCalls: { cmd: string; args: string[] }[] = [];
let exitHandlers: ((code: number | null) => void)[] = [];

function fakeChild(pid: number): LocalRunChildLike {
  return {
    pid,
    on(event: string, listener: (...args: any[]) => void) {
      if (event === 'exit') exitHandlers.push(listener as (code: number | null) => void);
    },
    stdout: { on() {} },
    stderr: { on() {} },
  };
}

function seedModel(): { id: string; filePath: string } {
  const dir = modelsRoot();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'tiny-llama.gguf');
  fs.writeFileSync(filePath, buildGguf([
    { key: 'general.architecture', type: 'string', value: 'llama' },
    { key: 'llama.block_count', type: 'uint32', value: 32 },
    { key: 'llama.context_length', type: 'uint32', value: 32768 },
    { key: 'llama.embedding_length', type: 'uint32', value: 2048 },
    { key: 'llama.attention.head_count', type: 'uint32', value: 32 },
    { key: 'llama.attention.head_count_kv', type: 'uint32', value: 8 },
  ]));
  const id = 'local-import/tiny-llama.gguf';
  fs.writeFileSync(path.join(dir, 'installed.json'), `${JSON.stringify({
    [id]: {
      id,
      repo: 'local-import',
      filename: 'tiny-llama.gguf',
      filePath,
      size: fs.statSync(filePath).size,
      downloadedAt: Date.now(),
    },
  }, null, 2)}\n`);
  return { id, filePath };
}

function seedEngines(): void {
  const root = path.join(getOcrHomeDir(), 'engines');
  const mk = (target: string) => {
    const installDir = path.join(root, 'llamacpp', `b8000-${target}`);
    fs.mkdirSync(installDir, { recursive: true });
    return {
      engine: 'llamacpp' as const,
      version: 'b8000',
      target,
      installDir,
      binaries: [path.join(installDir, 'llama-server.exe')],
      installedAt: Date.now(),
    };
  };
  const strataDir = path.join(root, 'strata', 'e1-cuda12');
  fs.mkdirSync(strataDir, { recursive: true });
  const strataExe = path.join(strataDir, 'strata.exe');
  fs.writeFileSync(strataExe, '');
  writeInstalledEngines({
    'llamacpp:cpu': mk('cpu'),
    'llamacpp:vulkan': mk('vulkan'),
    'strata:cuda12': {
      engine: 'strata',
      version: 'e1',
      target: 'cuda12',
      installDir: strataDir,
      binaries: [strataExe],
      installedAt: Date.now(),
    },
  });
}

/** A curated-family MoE checkpoint, laid out inside a real Strata workspace. */
function seedStrataModel(): { id: string; ws: StrataFixture } {
  const ws = makeStrataWorkspace({ slug: 'qwen3next', modelDir: 'qwen3next', fileName: 'moe-qwen3next.gguf' });
  fs.writeFileSync(ws.modelPath, buildGguf([
    { key: 'general.architecture', type: 'string', value: 'qwen3next' },
    { key: 'qwen3next.block_count', type: 'uint32', value: 40 },
    { key: 'qwen3next.context_length', type: 'uint32', value: 262144 },
    { key: 'qwen3next.embedding_length', type: 'uint32', value: 4096 },
    { key: 'qwen3next.attention.head_count', type: 'uint32', value: 32 },
    { key: 'qwen3next.attention.head_count_kv', type: 'uint32', value: 8 },
    { key: 'qwen3next.expert_count', type: 'uint32', value: 128 },
    { key: 'qwen3next.expert_used_count', type: 'uint32', value: 8 },
  ]));
  const id = 'local-import/moe-qwen3next.gguf';
  const stateFile = path.join(modelsRoot(), 'installed.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  state[id] = {
    id,
    repo: 'local-import',
    filename: 'moe-qwen3next.gguf',
    filePath: ws.modelPath,
    size: fs.statSync(ws.modelPath).size,
    downloadedAt: Date.now(),
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { id, ws };
}

function runsStateFile(): string {
  return path.join(getOcrHomeDir(), 'engines', 'runs.json');
}

let modelId = '';

beforeAll(() => {
  const seeded = seedModel();
  modelId = seeded.id;
  seedEngines();
  alivePids.add(FAKE_PID);
  setLocalRunnerDepsForTests({
    spawnImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return fakeChild(FAKE_PID);
    },
    killTreeImpl: (pid) => {
      killed.push(pid);
      alivePids.delete(pid);
      return true;
    },
    pidAliveImpl: (pid) => alivePids.has(pid),
    healthProbe: async () => healthy,
    readyTimeoutMs: 60_000,
    pollIntervalMs: 5,
  });
});

afterAll(() => {
  setLocalRunnerDepsForTests(null);
});

describe('llamaServerArgs', () => {
  test('the plan made literal: model, host, port, ctx, ngl and toggles', () => {
    const args = llamaServerArgs(
      { port: 4801, host: '127.0.0.1', ctx: 4096, ngl: 0, options: { ...DEFAULT_RUN_OPTIONS, extraArgs: ['--prio', '2'] } },
      '/models/tiny.gguf',
    );
    expect(args).toEqual([
      '-m', '/models/tiny.gguf',
      '--host', '127.0.0.1',
      '--port', '4801',
      '-c', '4096',
      '-ngl', '0',
      '-lv', '4',
      '--flash-attn', 'on',
      '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
      '--prio', '2',
    ]);
  });

  test('reasoning and threads add their flags only when set', () => {
    const args = llamaServerArgs(
      { port: 4801, host: '127.0.0.1', ctx: 8192, ngl: 999, options: { ...DEFAULT_RUN_OPTIONS, reasoning: true, threads: 8, flashAttn: false, kvCacheQ8: false, extraArgs: [] } },
      '/models/tiny.gguf',
    );
    expect(args).toContain('--jinja');
    expect(args).toContain('--reasoning-format');
    expect(args).toContain('-t');
    expect(args).not.toContain('--flash-attn');
    expect(args).not.toContain('--cache-type-k');
  });
});

describe('startLocalRun', () => {
  test('an unknown model is refused', async () => {
    const res = await startLocalRun({ modelId: 'nope/missing.gguf', engine: 'llamacpp' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('model-missing');
  });

  test('strata refuses a dense checkpoint and says it is dense', async () => {
    // A dense file has nothing to offload, so the refusal is inherent — unlike
    // an undocumented MoE, which stays offered (ADR-0039 §6).
    const res = await startLocalRun({ modelId, engine: 'strata' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('engine-cannot-serve');
      expect(res.error).toContain('dense');
    }
  });

  test('strata refuses a curated Family MoE whose workspace is not on disk, naming the artefact', async () => {
    // No workspace: the engine has nothing to spawn and no config to write, so
    // the refusal names what is missing on disk instead of demanding a path.
    const loose = path.join(modelsRoot(), 'loose-moe.gguf');
    fs.writeFileSync(loose, buildGguf([
      { key: 'general.architecture', type: 'string', value: 'qwen3next' },
      { key: 'qwen3next.block_count', type: 'uint32', value: 40 },
      { key: 'qwen3next.expert_count', type: 'uint32', value: 128 },
    ]));
    const stateFile = path.join(modelsRoot(), 'installed.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    const id = 'local-import/loose-moe.gguf';
    state[id] = { id, repo: 'local-import', filename: 'loose-moe.gguf', filePath: loose, size: fs.statSync(loose).size, downloadedAt: Date.now() };
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const res = await startLocalRun({ modelId: id, engine: 'strata' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('engine-cannot-serve');
      expect(res.error).toContain('serve/server.py');
      expect(res.error).toContain('generated here');
    }
  });

  test('strata launches with NO operator profile: workspace resolved, config generated', async () => {
    // `strata.exe` is a stdin worker that exits 2 on any unknown flag (`--port`
    // included), so the leg is `serve/server.py`, and the run config it reads —
    // pack, shard, PLE, expert profile, draft, ctx, kv — is written here from
    // the model's own workspace (ADR-0039 §8).
    const moe = seedStrataModel();
    const res = await startLocalRun({ modelId: moe.id, engine: 'strata' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.engine).toBe('strata');
    expect(res.run.ngl).toBe(-1);
    expect(res.run.ctx).toBe(32768);

    const call = spawnCalls[spawnCalls.length - 1];
    expect(call.cmd).toBe(moe.ws.python);
    expect(call.args[0]).toBe(moe.ws.entry);
    expect(call.args.slice(1, 4)).toEqual(['--engine', 'strata', '--config']);
    expect(call.args[call.args.indexOf('--port') + 1]).toBe(String(res.run.port));
    // The engine flags live in the generated config — the front-end never sees them.
    expect(call.args).not.toContain('--pack');
    expect(call.args).not.toContain('-ngl');
    expect(call.args).not.toContain('--max-context');

    const configPath = call.args[4];
    expect(configPath).toContain(path.join('strata', 'configs'));
    expect(path.basename(configPath)).toBe('qwen3next-ctx32768.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      exe: string;
      args: string[];
      cwd: string;
      tokenizer?: string;
      model_name?: string;
    };
    expect(config.cwd).toBe(moe.ws.workspace);
    expect(config.args[0]).toBe('--pack');
    expect(config.args[1]).toBe(moe.ws.pack);
    expect(config.args[config.args.indexOf('--native') + 1]).toBe(moe.ws.modelPath);
    expect(config.args[config.args.indexOf('--max-context') + 1]).toBe('32768');
    expect(config.args[config.args.indexOf('--mtp') + 1]).toBe(moe.ws.mtp);
    expect(config.tokenizer).toBe(path.join(moe.ws.pack, 'tokenizer'));
    expect(config.model_name).toBe('qwen3next');
    stopLocalRun(res.run.id);
  });

  test('explicit cpu target launches with ngl 0 and planner ctx', async () => {
    const res = await startLocalRun({ modelId, engine: 'llamacpp', target: 'cpu' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.status).toBe('starting');
    expect(res.run.target).toBe('cpu');
    expect(res.run.ngl).toBe(0);
    expect(res.run.ctx).toBeGreaterThanOrEqual(8192);
    expect(res.run.port).toBeGreaterThanOrEqual(4800);
    expect(res.run.pid).toBe(FAKE_PID);
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call.cmd).toContain('llama-server');
    expect(call.args).toContain('-ngl');
    expect(call.args[call.args.indexOf('-ngl') + 1]).toBe('0');
    expect(call.args[call.args.indexOf('-c') + 1]).toBe(String(res.run.ctx));
    stopLocalRun(res.run.id);
  });

  test('explicit ctx/ngl override the planner', async () => {
    const res = await startLocalRun({ modelId, engine: 'llamacpp', target: 'cpu', options: { ctx: 4096, ngl: 7 } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.ctx).toBe(4096);
    expect(res.run.ngl).toBe(7);
    stopLocalRun(res.run.id);
  });

  test('no target pick prefers the GPU-backed install', async () => {
    const res = await startLocalRun({ modelId, engine: 'llamacpp' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.target).toBe('vulkan');
    stopLocalRun(res.run.id);
  });
});

describe('status lifecycle', () => {
  test('health poll migrates starting → ready; stop kills by pid', async () => {
    const res = await startLocalRun({ modelId, engine: 'llamacpp', target: 'cpu' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    alivePids.add(FAKE_PID);
    healthy = true;
    const rows = await listLocalRuns();
    const row = rows.find((r) => r.id === res.run.id);
    expect(row?.status).toBe('ready');
    expect(row?.readyAt).toBeGreaterThan(0);
    killed = [];
    expect(stopLocalRun(res.run.id).ok).toBe(true);
    expect(killed).toContain(FAKE_PID);
    const after = await listLocalRuns();
    expect(after.find((r) => r.id === res.run.id)?.status).toBe('stopped');
    const log = runLogs(res.run.id);
    expect(log.some((line) => line.text.includes('ready'))).toBe(true);
  });

  test('a crash within budget restarts and counts', async () => {
    const res = await startLocalRun({ modelId, engine: 'llamacpp', target: 'cpu', options: { autoRestart: true } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const handler = exitHandlers[exitHandlers.length - 1];
    handler(1); // crash: non-zero exit
    // The crashed pid is reaped but the run is mid-restart: keep it alive-ish
    // and unhealthy so the poll shows the restart state, not a death verdict.
    alivePids.add(FAKE_PID);
    healthy = false;
    const rows = await listLocalRuns();
    const row = rows.find((r) => r.id === res.run.id);
    expect(row?.status).toBe('starting');
    expect(row?.restarts).toBe(1);
    expect(row?.lastError).toContain('restart 1/');
    // Stop before the 2s respawn timer fires so it no-ops.
    stopLocalRun(res.run.id);
    healthy = true;
  });
});

describe('boot sweep', () => {
  test('restoreLocalRuns adopts survivors and closes the dead', async () => {
    const survivor: LocalRun = {
      id: 'run-restore-alive',
      modelId,
      engine: 'llamacpp',
      target: 'cpu',
      binary: '/x/llama-server.exe',
      host: '127.0.0.1',
      port: 4990,
      pid: 55501,
      status: 'ready',
      ctx: 8192,
      ngl: 0,
      options: { ...DEFAULT_RUN_OPTIONS },
      startedAt: Date.now() - 60_000,
      restarts: 0,
      apiPath: '/v1',
    };
    const dead: LocalRun = { ...survivor, id: 'run-restore-dead', port: 4991, pid: 55502, status: 'starting' };
    fs.mkdirSync(path.dirname(runsStateFile()), { recursive: true });
    const existing = JSON.parse(fs.readFileSync(runsStateFile(), 'utf8')) as Record<string, LocalRun>;
    existing[survivor.id] = survivor;
    existing[dead.id] = dead;
    fs.writeFileSync(runsStateFile(), `${JSON.stringify(existing, null, 2)}\n`);

    alivePids.add(55501); // 55502 stays dead
    healthy = true;
    await restoreLocalRuns();

    const rows = await listLocalRuns();
    const adoptedRow = rows.find((r) => r.id === survivor.id);
    const deadRow = rows.find((r) => r.id === dead.id);
    expect(adoptedRow?.status).toBe('ready');
    expect(deadRow?.status).toBe('failed');
    expect(runLogs(survivor.id).some((line) => line.text.includes('adopted'))).toBe(true);
    // Cleanup: stop the adopted run so the sync teardown leaves it alone.
    stopLocalRun(survivor.id);
  });
});

describe('exit teardown', () => {
  test('stopSpawnedLocalRunsSync kills only spawned children', async () => {
    const res = await startLocalRun({ modelId, engine: 'llamacpp', target: 'cpu' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    alivePids.add(FAKE_PID);
    killed = [];
    stopSpawnedLocalRunsSync();
    expect(killed).toContain(FAKE_PID);
    stopLocalRun(res.run.id);
  });
});
