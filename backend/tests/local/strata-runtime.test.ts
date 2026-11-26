/**
 * The Strata runtime's launch contract (ADR-0039 §7–§8).
 *
 * Two field facts this file pins:
 *
 *  1. `strata.exe` is a stdin worker that exits 2 on any unknown flag (`--port`
 *     included), so the leg is the vendor front-end (`serve/server.py`).
 *  2. The front-end reads a run config whose contents ARE the engine command
 *     line. That config is GENERATED here. The front-end and the data
 *     directory live under the gateway home (`<ocrHome>/strata/runtime` and
 *     `strata/data`, ADR-0039 §13) — a checkout beside the model file is not
 *     an install. The exe is the one this gateway installed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STRATA_RUNTIME,
  buildStrataConfig,
  matchPack,
  normalizeStrataProfile,
  resolveStrataLayout,
  strataConfigPath,
  strataEngineArgs,
  strataRuntimeDir,
} from '../../src/local/strata.js';
import { getOcrHomeDir } from '../../src/cli/paths.js';
import { makeStrataWorkspace, type StrataFixture } from './strata-fixture.js';

const fixtures: StrataFixture[] = [];
const extraRoots: string[] = [];
let home = '';

// Generated configs land under the gateway home; keep them out of the real one.
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-home-'));
  process.env.OCR_HOME = home;
});

afterAll(() => {
  delete process.env.OCR_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function workspace(options?: { slug?: string; modelDir?: string; fileName?: string; withPack?: boolean }): StrataFixture {
  const fixture = makeStrataWorkspace(options);
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture.root, { recursive: true, force: true });
  for (const dir of extraRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('strata profile', () => {
  test('is optional: an empty record is valid, and unknown keys are dropped', () => {
    const empty = normalizeStrataProfile(undefined);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.profile).toEqual({});

    // A record an older build wrote (`root`/`workspace`/`config`/`pack`) still
    // loads: the installation facts are simply DROPPED — engine setup owns them
    // since §10 — `config` was already ignored, and `pack` is no longer a field
    // at all (§11: a tie is refused, never overridden). Failing here would
    // strand an existing model.
    const legacy = normalizeStrataProfile({ root: ' D:\\Strata\\Strata-main ', workspace: 'W', config: 'C', pack: 'P', bogus: 1 });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.profile).toEqual({});

    const full = normalizeStrataProfile({ kv: 'q4_0', maxContext: 8192, parallel: 4, extra: 'x' });
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.profile).toEqual({ kv: 'q4_0', maxContext: 8192, parallel: 4 });
    // An unknown kv value is dropped rather than passed to the engine as a flag.
    const badKv = normalizeStrataProfile({ kv: 'q2' });
    if (badKv.ok) expect(badKv.profile.kv).toBeUndefined();
    // Out-of-domain parallel counts are dropped: 1 is the default spelled
    // weirdly, 9+ is beyond the engine's batch window, a fraction is neither.
    for (const n of [1, 9, 2.5, 'two']) {
      const bad = normalizeStrataProfile({ parallel: n });
      if (bad.ok) expect(bad.profile.parallel).toBeUndefined();
    }
  });
});

describe('layout discovery', () => {
  test('finds the front-end, the pack, the draft head and the projector under the gateway home', () => {
    const ws = workspace();
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const { layout } = resolved;
    expect(layout.workspace).toBe(ws.workspace);
    expect(layout.entry).toBe(ws.entry);
    expect(layout.python).toBe(ws.python);
    expect(layout.dataRoot).toBe(ws.dataRoot);
    expect(layout.pack).toBe(ws.pack);
    expect(layout.tokenizer).toBe(path.join(ws.pack, 'tokenizer'));
    expect(layout.mtp).toBe(ws.mtp);
    expect(layout.mmproj).toBe(ws.mmproj);
    expect(layout.expertProfile).toBe(ws.expertProfile);
    expect(layout.modelName).toBe('abl-iq2_xs');
  });

  test('a workspace that is not on disk is reported by artefact, not by asking for a directory', () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-orphan-'));
    extraRoots.push(orphan);
    const modelPath = path.join(orphan, 'loose-model.gguf');
    fs.writeFileSync(modelPath, '');
    const resolved = resolveStrataLayout({ modelPath });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing.join(' ')).toContain(strataRuntimeDir());
    expect(resolved.reason).toContain('generated here');
  });

  test('a pack is matched by the model folder name, and a tie is reported not broken', () => {
    const ws = workspace();
    const packs = path.join(ws.dataRoot, 'packs');
    expect(matchPack(packs, ws.modelPath).pack).toBe(ws.pack);

    // Two packs sharing every token: the guess would run the wrong weights.
    const rival = path.join(packs, 'swift-iq2_xs');
    fs.mkdirSync(rival, { recursive: true });
    fs.writeFileSync(path.join(rival, 'dense.bin'), '');
    fs.writeFileSync(path.join(rival, 'native_experts.txt'), '');
    const tied = matchPack(packs, path.join(ws.dataRoot, 'models', 'merged', 'iq2_xs-unnamed-00001-of-00002.gguf'));
    expect(tied.pack).toBeUndefined();
    expect(tied.ambiguous?.length).toBe(2);
  });

  test('a pack without the completion marker is not a pack (ADR-0039 §9)', () => {
    // iq_pack.py publishes native_experts.txt LAST; a directory with weights
    // but no marker is a half-written pack (an interrupted build) and must
    // never match — the engine would load a truncated weight set.
    const ws = workspace();
    fs.rmSync(path.join(ws.pack, 'native_experts.txt'));
    expect(matchPack(path.join(ws.dataRoot, 'packs'), ws.modelPath).pack).toBeUndefined();
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    // Everything else resolved, so the missing pack is the buildable case.
    expect(resolved.buildable).toBe(true);
  });

  test('a model file anywhere uses the gateway runtime (ADR-0039 §13)', () => {
    const ws = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-outside-'));
    extraRoots.push(outside);
    const outsideModel = path.join(outside, 'moe-model', 'moe.gguf');
    fs.mkdirSync(path.dirname(outsideModel), { recursive: true });
    fs.writeFileSync(outsideModel, '');
    const resolved = resolveStrataLayout({ modelPath: outsideModel });
    // The front-end resolved. Only the pack is missing: this folder name
    // matches nothing under the gateway data dir, which is the buildable case.
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing.join(' ')).not.toContain('serve/server.py');
    expect(resolved.buildable).toBe(true);
    expect(ws.workspace).toBe(strataRuntimeDir());
  });

  test('a setup pin to a real front-end overrides the gateway runtime', async () => {
    workspace();
    const pin = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-pin-'));
    extraRoots.push(pin);
    const pinWs = path.join(pin, 'runtime');
    const entry = path.join(pinWs, 'serve', 'server.py');
    const python = process.platform === 'win32'
      ? path.join(pinWs, '.venv', 'Scripts', 'python.exe')
      : path.join(pinWs, '.venv', 'bin', 'python3');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
    const settingsFile = path.join(getOcrHomeDir(), 'local-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ engineSetup: { strata: { workspace: pinWs } } }), 'utf8');
    try {
      const modelPath = path.join(getOcrHomeDir(), 'strata', 'data', 'models', 'abl-IQ2_XS', 'x.gguf');
      const legs = await STRATA_RUNTIME.legs!(
        {
          runId: 'pin-1',
          modelPath,
          profile: undefined,
          port: 8000,
          host: '127.0.0.1',
          ctx: 4096,
          ngl: -1,
          options: { flashAttn: false, kvCacheQ8: true, reasoning: false, threads: 0, extraArgs: [] },
          backend: 'cuda',
          target: 'cuda13',
          binary: 'strata.exe',
        } as never,
        { allocatePort: async () => 8001 } as never,
      );
      expect(Array.isArray(legs)).toBe(true);
      if (!Array.isArray(legs)) return;
      expect(legs[0].cwd).toBe(pinWs);
      expect(legs[0].cmd).toBe(python);
    } finally {
      fs.rmSync(settingsFile, { force: true });
    }
  });
});

describe('setup card paths (ADR-0039 §13)', () => {
  test('shows the gateway directories even when the files are not there yet', () => {
    fs.rmSync(path.join(getOcrHomeDir(), 'strata', 'runtime'), { recursive: true, force: true });
    const resolved = STRATA_RUNTIME.setup?.resolve?.({});
    const workspaceDir = strataRuntimeDir();
    expect(resolved?.workspace).toBe(workspaceDir);
    expect(resolved?.dataRoot).toBe(path.join(getOcrHomeDir(), 'strata', 'data'));
    const pythonName = process.platform === 'win32' ? path.join('python', 'python.exe') : path.join('python', 'bin', 'python3');
    expect(resolved?.python).toBe(path.join(workspaceDir, pythonName));
  });

  test('a shipped interpreter replaces the not-yet-installed path', () => {
    const ws = workspace();
    const resolved = STRATA_RUNTIME.setup?.resolve?.({});
    expect(resolved?.python).toBe(ws.python);
  });

  test('never echoes a stored override back as the shown default', () => {
    const ws = workspace();
    const settingsFile = path.join(getOcrHomeDir(), 'local-settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ engineSetup: { strata: { workspace: path.join(ws.root, 'stale-pin') } } }), 'utf8');
    try {
      const resolved = STRATA_RUNTIME.setup?.resolve?.({});
      expect(resolved?.workspace).toBe(strataRuntimeDir());
    } finally {
      fs.rmSync(settingsFile, { force: true });
    }
  });
});

describe('the generated config', () => {
  test('carries the engine command line: pack, shard, PLE, expert profile, draft, ctx, kv', () => {
    const ws = workspace();
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    if (!resolved.ok) throw new Error(resolved.reason);
    const args = strataEngineArgs({ layout: resolved.layout, modelPath: ws.modelPath, ctx: 32768, kv: 'int8' });
    expect(args.slice(0, 6)).toEqual(['--pack', ws.pack, '--native', ws.modelPath, '--ple-gguf', ws.modelPath]);
    expect(args[args.indexOf('--expert-profile') + 1]).toBe(ws.expertProfile);
    expect(args[args.indexOf('--expert-cache') + 1]).toBe('auto');
    expect(args[args.indexOf('--mtp') + 1]).toBe(ws.mtp);
    expect(args[args.indexOf('--max-context') + 1]).toBe('32768');
    expect(args[args.indexOf('--kv') + 1]).toBe('int8');
    // A shared knob the front-end does not take is never invented.
    expect(args).not.toContain('-ngl');
    expect(args).not.toContain('--port');
  });

  test('names the installed engine binary and the projector, and drops vision without one', () => {
    const ws = workspace();
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    if (!resolved.ok) throw new Error(resolved.reason);
    const visionExe = path.join(path.dirname(ws.workspace), 'engine', 'strata-vision.exe');
    fs.mkdirSync(path.dirname(visionExe), { recursive: true });
    fs.writeFileSync(visionExe, '');
    const withVision = resolveStrataLayout({ modelPath: ws.modelPath, binary: path.join(path.dirname(visionExe), 'strata.exe') });
    if (!withVision.ok) throw new Error(withVision.reason);

    const config = buildStrataConfig({
      layout: withVision.layout,
      modelPath: ws.modelPath,
      engineExe: path.join(path.dirname(visionExe), 'strata.exe'),
      ctx: 16384,
      kv: 'fp16',
    });
    expect(config.exe).toContain('strata.exe');
    expect(config.cwd).toBe(ws.workspace);
    expect(config.model_name).toBe('abl-iq2_xs');
    expect(config.tokenizer).toBe(path.join(ws.pack, 'tokenizer'));
    expect(config.vision).toEqual({ exe: visionExe, mmproj: ws.mmproj, model: ws.modelPath });

    const textOnly = buildStrataConfig({
      layout: { ...withVision.layout, visionExe: undefined, mmproj: undefined },
      modelPath: ws.modelPath,
      engineExe: 'strata.exe',
      ctx: 16384,
      kv: 'fp16',
    });
    expect(textOnly.vision).toBeUndefined();
  });

  test('the installed engine is the exe that runs, even when a binary sits in the runtime tree', () => {
    const ws = workspace();
    const stray = path.join(ws.workspace, 'engine-cuda12', 'strata.exe');
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, '');
    const installed = path.join(ws.root, 'installed', 'strata.exe');
    const installedVision = path.join(path.dirname(installed), 'strata-vision.exe');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '');
    fs.writeFileSync(installedVision, '');

    const resolved = resolveStrataLayout({ modelPath: ws.modelPath, binary: installed });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.layout.engineExe).toBe(installed);
    expect(resolved.layout.visionExe).toBe(installedVision);

    const config = buildStrataConfig({ layout: resolved.layout, modelPath: ws.modelPath, engineExe: installed, ctx: 4096, kv: 'int8' });
    expect(config.exe).toBe(installed);
  });

  test('a runtime with no binary of its own uses the installed engine', () => {
    const ws = workspace();
    const installed = path.join(path.dirname(ws.workspace), 'installed', 'strata.exe');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '');
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath, binary: installed });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.layout.engineExe).toBe(installed);
  });

  test('is written per (model, ctx) under the gateway home, not inside the vendor tree', () => {
    const ws = workspace();
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    if (!resolved.ok) throw new Error(resolved.reason);
    const target = strataConfigPath(resolved.layout, 32768);
    expect(path.basename(target)).toBe('abl-iq2_xs-ctx32768.json');
    expect(target).not.toContain(ws.workspace);
  });

  test('parallel is a server-level config key, never an engine flag (ADR-0039 §12)', () => {
    const ws = workspace();
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    if (!resolved.ok) throw new Error(resolved.reason);
    const withBatch = buildStrataConfig({ layout: resolved.layout, modelPath: ws.modelPath, engineExe: 'strata.exe', ctx: 4096, kv: 'int8', parallel: 4 });
    expect(withBatch.parallel).toBe(4);
    // server.py translates it to --batch itself; the engine args stay clean.
    expect(withBatch.args).not.toContain('--batch');
    const solo = buildStrataConfig({ layout: resolved.layout, modelPath: ws.modelPath, engineExe: 'strata.exe', ctx: 4096, kv: 'int8' });
    expect(solo.parallel).toBeUndefined();
  });
});

describe('strata runtime', () => {
  const moeMeta = { ok: true as const, arch: 'qwen4exp', layers: 48, experts: 512 };

  test('serves a MoE whose workspace resolves, with NO profile at all', () => {
    // The complaint this rule answers: a supported model must not be shown as
    // "needs setup" because the operator declined to type a directory.
    const orphan = STRATA_RUNTIME.serves({ modelPath: 'loose/moe.gguf', meta: moeMeta as never, profile: undefined });
    expect(orphan.serves).toBe(false);
    expect(orphan.family).toBe(true);
    expect(orphan.needsSetup).toBeUndefined();
    expect(orphan.reason).toContain('serve/server.py');

    const ws = workspace();
    const ready = STRATA_RUNTIME.serves({ modelPath: ws.modelPath, meta: moeMeta as never, profile: undefined });
    expect(ready.serves).toBe(true);
    expect(ready.family).toBe(true);
  });

  test('still refuses a dense checkpoint by name', () => {
    const ws = workspace();
    const verdict = STRATA_RUNTIME.serves({ modelPath: ws.modelPath, meta: { ok: true, arch: 'llama', experts: 0 } as never, profile: undefined });
    expect(verdict.serves).toBe(false);
    expect(verdict.reason).toContain('dense');
  });

  test('one leg, no vision sidecar: server.py owns the encoder', async () => {
    const ws = workspace();
    const legs = await STRATA_RUNTIME.legs!(
      {
        runId: 'run-1',
        modelPath: ws.modelPath,
        profile: undefined,
        port: 8000,
        host: '127.0.0.1',
        ctx: 4096,
        ngl: -1,
        options: { flashAttn: false, kvCacheQ8: true, reasoning: false, threads: 0, extraArgs: [] },
        backend: 'cuda',
        target: 'cuda13',
        binary: path.join(path.dirname(ws.workspace), 'engine', 'strata.exe'),
      } as never,
      { allocatePort: async () => 8001 } as never
    );
    expect(Array.isArray(legs)).toBe(true);
    if (!Array.isArray(legs)) return;
    expect(legs).toHaveLength(1);
    expect(legs[0].aux).toBe(false);
    expect(legs[0].port).toBe(8000);
    expect(legs[0].cmd).toBe(ws.python);
    expect(legs[0].cwd).toBe(ws.workspace);
    expect(legs[0].args[0]).toBe(ws.entry);
    expect(legs[0].args.slice(1, 4)).toEqual(['--engine', 'strata', '--config']);
    const configPath = legs[0].args[4];
    expect(path.basename(configPath)).toBe('abl-iq2_xs-ctx4096.json');
    // The engine flags live in the generated config — the front-end never sees them.
    expect(legs[0].args).not.toContain('--pack');
    expect(legs[0].args).not.toContain('-ngl');

    // ...and the file it points at is on disk with the engine argv inside.
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { args: string[]; cwd: string };
    expect(written.cwd).toBe(ws.workspace);
    expect(written.args[0]).toBe('--pack');
    expect(written.args[written.args.indexOf('--max-context') + 1]).toBe('4096');
  });

  test('a dead control is not advertised', () => {
    // ngl/threads/flashAttn/kv all live in the generated config; spec/vision
    // stay offered (the engine's profile owns how "off" is expressed).
    expect(STRATA_RUNTIME.accepts).toEqual({ ngl: false, threads: false, flashAttn: false, kv: false, reasoning: false, spec: true, vision: true });
    expect(STRATA_RUNTIME.placement).toBe('engine');
  });

  test('the declaration carries engine-owned estimates (speed + eager load)', () => {
    const ws = workspace();
    // A sized dense half + index so the eager-load fact is non-zero.
    fs.writeFileSync(path.join(ws.pack, 'dense.bin'), Buffer.alloc(40 * 1024 * 1024, 1));
    fs.writeFileSync(path.join(ws.pack, 'index.txt'), 'x'.repeat(1024 * 1024));
    const decl = STRATA_RUNTIME.profile!.describe(undefined, 4096, true, {
      modelPath: ws.modelPath,
      meta: { ok: true, arch: 'qwen4exp', layers: 48, experts: 512, expertsUsed: 10 } as never,
      sizeBytes: 68e9,
    } as never);
    // ONE declared line: the spawned front-end command. The engine argv stays
    // inside the generated config — it is derived, never operator input, so the
    // panel never dresses it up as one.
    expect(decl.argv).toHaveLength(1);
    expect(decl.argv[0]).toContain('--engine strata --config');
    expect(decl.argv[0]).toContain('abl-iq2_xs-ctx4096.json');
    expect(decl.argv[0]).not.toContain('--pack');
    expect(decl.firstLoadBytes).toBe(40 * 1024 * 1024 + 1024 * 1024);
    // 68 GB total with ~41 MB eager: the expert stream (10/512 of the expert
    // mass at 50 GB/s) dominates the estimate — a sane two-digit tok/s.
    expect(decl.estTokPerSec).toBeGreaterThan(0);
    expect(decl.estTokPerSec ?? 0).toBeLessThan(100);
  });

  test('an unresolvable layout declares nothing (no pack, no estimate)', () => {
    const ws = workspace({ withPack: false });
    const decl = STRATA_RUNTIME.profile!.describe(undefined, 4096, true, { modelPath: ws.modelPath } as never);
    expect(decl).toEqual({ argv: [], features: [] });
  });
});

describe('pack building (ADR-0039 §9)', () => {
  const moeMeta = { ok: true as const, arch: 'qwen4exp', layers: 48, experts: 512 };

  test('a workspace whose only gap is the pack is buildable, and the verdict carries the offer', () => {
    const ws = workspace({ withPack: false });
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.buildable).toBe(true);
    expect(resolved.missing.join(' ')).toContain('built pack');

    const verdict = STRATA_RUNTIME.serves({ modelPath: ws.modelPath, meta: moeMeta as never, profile: undefined });
    expect(verdict.serves).toBe(false);
    expect(verdict.family).toBe(true);
    expect(verdict.buildable).toBe(true);
  });

  test('no packer on disk, no build offer', () => {
    const ws = workspace({ withPack: false });
    fs.rmSync(path.join(ws.workspace, 'tools', 'iq_pack.py'));
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.buildable).toBeUndefined();
  });

  test('a pack tie is an operator decision, never a build trigger', () => {
    // Building publishes under the exact-match name, which would silently pick
    // a winner between two equally-matching packs — so a tie is refused, not
    // built over.
    const ws = workspace({ withPack: false });
    const packs = path.join(ws.dataRoot, 'packs');
    for (const name of ['swift-iq2_xs', 'abl-merged-iq2_xs']) {
      const dir = path.join(packs, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'dense.bin'), '');
      fs.writeFileSync(path.join(dir, 'native_experts.txt'), '');
    }
    const resolved = resolveStrataLayout({ modelPath: ws.modelPath });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.buildable).toBeUndefined();
  });

  test('the build leg is the workspace packer writing the exact-match pack dir', async () => {
    const ws = workspace({ withPack: false });
    const legs = await STRATA_RUNTIME.build!({ jobId: 'build-1', modelPath: ws.modelPath, profile: undefined });
    expect(Array.isArray(legs)).toBe(true);
    if (!Array.isArray(legs)) return;
    expect(legs).toHaveLength(1);
    expect(legs[0].cmd).toBe(ws.python);
    expect(legs[0].cwd).toBe(ws.workspace);
    expect(legs[0].args).toEqual([
      path.join(ws.workspace, 'tools', 'iq_pack.py'),
      '--gguf', ws.modelPath,
      '--out', ws.pack,
    ]);
    // A build serves nothing: no port.
    expect(legs[0].port).toBeUndefined();
  });

  test('an unresolvable workspace refuses the build by naming what is missing', async () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-orphan-'));
    extraRoots.push(orphan);
    const modelPath = path.join(orphan, 'loose-model.gguf');
    fs.writeFileSync(modelPath, '');
    const legs = await STRATA_RUNTIME.build!({ jobId: 'build-2', modelPath, profile: undefined });
    expect(Array.isArray(legs)).toBe(false);
    if (Array.isArray(legs)) return;
    expect(legs.error).toContain('serve/server.py');
  });
});

describe('ctx resolution', () => {
  const meta = { ok: true as const, arch: 'qwen4exp', maxCtx: 262144, experts: 512 };

  test('the requested ctx is the truth, capped by the trained context', () => {
    expect(STRATA_RUNTIME.resolveCtx!({ requested: 8192, profile: undefined, meta: meta as never })).toBe(8192);
    expect(STRATA_RUNTIME.resolveCtx!({ requested: 0, profile: undefined, meta: meta as never })).toBe(32768);
    // The engine cannot exceed what it was trained for.
    expect(STRATA_RUNTIME.resolveCtx!({ requested: 1_000_000, profile: undefined, meta: meta as never })).toBe(262144);
    expect(STRATA_RUNTIME.resolveCtx!({ requested: 8192, profile: { maxContext: 4096 }, meta: meta as never })).toBe(4096);
  });
});
