/**
 * ADR-0039's promise, pinned: an engine is a DATA REGISTRATION, not a branch.
 *
 * The stub below is a full third engine — its own file extension, its own
 * placement authority, its own operator profile, its own argv — registered at
 * runtime with no edit to the runner, the routes or the console. If this test
 * ever needs to know the word "stub" anywhere outside this file, extensibility
 * has regressed to the pre-ADR-0039 state where every engine was a hardcoded
 * `=== 'strata'` in four modules.
 */
import '../helpers/sandbox-home.js';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../src/cli/paths.js';
import {
  engineById,
  engineRuntimeInfo,
  engineSupportFor,
  registerEngine,
  unregisterEngine,
  writeInstalledEngines,
} from '../../src/local/engines.js';
import { modelsRoot } from '../../src/local/model-store.js';
import {
  DEFAULT_RUN_OPTIONS,
  setLocalRunnerDepsForTests,
  startLocalRun,
  stopLocalRun,
} from '../../src/local/runner.js';

const STUB_ID = 'stub-engine';
const STUB_BIN = 'stub-server';
const spawnCalls: { cmd: string; args: string[] }[] = [];
const alivePids = new Set<number>();

/** The third engine: serves `.stub` weight files, declares its own placement,
 *  and needs one operator-supplied directory. */
function registerStub(): void {
  registerEngine({
    id: STUB_ID,
    name: 'Stub Engine',
    repo: 'example/stub-engine',
    description: 'test double',
    binaryNames: [STUB_BIN],
    targets: (platform, arch) => [{ id: 'cpu', backend: 'cpu', label: 'CPU', requires: ['cpu'], approxBytes: 0 }],
    matchAssets: () => null,
    resolveRelease: async () => ({ tag: 'v0', assets: [] }),
    recommendTarget: () => 'cpu',
    runtime: {
      placement: 'engine',
      accepts: { ngl: false, threads: false, flashAttn: false, kv: false, reasoning: false, spec: false, vision: false },
      serves: ({ modelPath, profile }) => {
        if (!modelPath.endsWith('.stub')) return { serves: false, reason: 'stub only loads .stub files' };
        if (!profile) return { serves: false, needsSetup: true, family: true, reason: 'the stub engine needs its root directory' };
        return { serves: true, family: true };
      },
      resolveCtx: () => 4096,
      legs: async (facts) => [
        {
          key: facts.runId,
          cmd: facts.binary,
          args: ['--root', String((facts.profile as { root: string }).root), '--listen', String(facts.port), '--ctx', String(facts.ctx)],
          cwd: path.dirname(facts.binary),
          aux: false,
        },
      ],
      profile: {
        intro: 'localModels.strataProfileIntro',
        // One field per wire shape the contract allows: a path, an enum, a
        // toggle and an argv list. The console renders all four from this data
        // alone, which is what "the UI is an adapter too" means (ADR-0039).
        groups: [
          {
            id: 'core',
            label: 'localModels.strataSectionCore',
            fields: [
              { key: 'root', label: 'localModels.strataPack', kind: 'text', required: true },
              { key: 'mode', label: 'localModels.strataPack', kind: 'select', options: [{ value: 'fast', label: 'Fast' }, { value: 'exact', label: 'Exact' }] },
              { key: 'warmup', label: 'localModels.strataPack', kind: 'boolean' },
              { key: 'args', label: 'localModels.strataExtraArgs', kind: 'list' },
            ],
          },
        ],
        normalize: (raw) => {
          const root = (raw as { root?: unknown } | null)?.root;
          if (typeof root !== 'string' || !root.trim()) return { ok: false, code: 'profile-invalid', error: 'root is required' };
          return { ok: true, profile: { root: root.trim() } };
        },
        paths: (profile) => [(profile as { root: string }).root],
        describe: (profile, ctx) => ({ argv: [`--root ${(profile as { root: string }).root}`, `--ctx ${ctx}`], features: [] }),
      },
    },
  });
}

let modelId = '';

beforeAll(() => {
  const dir = modelsRoot();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'stub-weights.stub');
  fs.writeFileSync(filePath, 'not weights, but the gate only reads the extension');
  const root = path.join(getOcrHomeDir(), 'stub-root');
  fs.mkdirSync(root, { recursive: true });
  modelId = 'local-import/stub-weights.stub';
  fs.writeFileSync(path.join(dir, 'installed.json'), `${JSON.stringify({
    [modelId]: {
      id: modelId,
      repo: 'local-import',
      filename: 'stub-weights.stub',
      filePath,
      size: fs.statSync(filePath).size,
      downloadedAt: Date.now(),
      profiles: { [STUB_ID]: { root } },
    },
  }, null, 2)}\n`);

  const installDir = path.join(getOcrHomeDir(), 'engines', STUB_ID, 'v0-cpu');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'stub-server.exe'), '');
  writeInstalledEngines({
    [`${STUB_ID}:cpu`]: {
      engine: STUB_ID,
      version: 'v0',
      target: 'cpu',
      installDir,
      binaries: [path.join(installDir, 'stub-server.exe')],
      installedAt: Date.now(),
    },
  });

  alivePids.add(43210);
  setLocalRunnerDepsForTests({
    spawnImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return { pid: 43210, on() {}, stdout: { on() {} }, stderr: { on() {} } };
    },
    killTreeImpl: (pid) => alivePids.delete(pid),
    pidAliveImpl: (pid) => alivePids.has(pid),
    healthProbe: async () => true,
    readyTimeoutMs: 5_000,
  });

  registerStub();
});

afterAll(() => {
  setLocalRunnerDepsForTests(null);
  unregisterEngine(STUB_ID);
});

describe('a runtime-registered engine', () => {
  test('participates in file gating with its own reason', () => {
    const support = engineSupportFor('model.stub', null, { [STUB_ID]: { root: '/x' } });
    expect(support.runnable).toContain(STUB_ID);
    // llama.cpp never claims a non-GGUF file: the verdict is per engine.
    expect(support.runnable).not.toContain('llamacpp');
    const gated = engineSupportFor('model.stub', null);
    expect(gated.engines[STUB_ID]?.needsSetup).toBe(true);
    expect(gated.engines[STUB_ID]?.reason).toContain('root directory');
  });

  test('exposes its profile schema and placement to the console', () => {
    const info = engineRuntimeInfo(engineById(STUB_ID)!);
    expect(info?.placement).toBe('engine');
    expect(info?.accepts.ngl).toBe(false);
    const fields = info?.profile?.groups[0].fields ?? [];
    expect(fields.map((field) => field.kind)).toEqual(['text', 'select', 'boolean', 'list']);
    // The enum choices travel as data — the console does not know the values.
    expect(fields[1]?.options?.map((option) => option.value)).toEqual(['fast', 'exact']);
  });

  test('version-tag listing is optional adapter surface, not a name check', () => {
    // llama.cpp offers a nightly tag STREAM (the picker needs the list);
    // Strata has one stable channel (the picker shows that tag). Both are the
    // engine's own answer, so the route branches on the capability, not the id.
    expect(typeof engineById('llamacpp')?.listTags).toBe('function');
    expect(engineById('strata')?.listTags).toBeUndefined();
  });

  test('launches through the runner with its own argv and declared ctx', async () => {
    const res = await startLocalRun({ modelId, engine: STUB_ID, options: { ...DEFAULT_RUN_OPTIONS } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.ctx).toBe(4096); // resolveCtx, not the layer planner
    expect(res.run.ngl).toBe(-1); // declared placement
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call.cmd).toContain(STUB_BIN);
    expect(call.args[0]).toBe('--root');
    expect(call.args).toContain('--listen');
    stopLocalRun(res.run.id);
  });
});
