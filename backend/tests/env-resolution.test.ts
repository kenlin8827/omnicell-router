import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ENV_NAME,
  __resetEnvResolutionForTests,
  createEnv,
  getEnvPaths,
  getEnvsRootDir,
  isValidEnvName,
  listEnvs,
  readPointer,
  renameEnv,
  resetSandboxEnv,
  resolveEnvName,
  trashEnv,
  writePointer,
} from '../src/config/env.js';
import { getConfigPath } from '../src/config/index.js';
import { applyConfig as applyDecisionCaptureConfig } from '../src/capture/decision-capture.js';

/**
 * Phase-1 "environments as book-sets" substrate.
 *
 * Every test runs against a FRESH temp OCR_HOME (plus a chdir'd sandbox cwd
 * that no config resolution consults anymore), so neither the operator's real
 * ~/.onecast-router nor the repo's real config can leak into a run. The
 * env module caches its resolution per process, so each phase of a test
 * calls __resetEnvResolutionForTests() after mutating OCR_ENV / OCR_HOME /
 * the pointer / the cwd — the same restart-semantics the design assumes,
 * made test-addressable through the one seam.
 */

const originalCwd = process.cwd();
const prevOcrEnv = process.env.OCR_ENV;
const prevOcrHome = process.env.OCR_HOME;

let HOME = ''; // temp OCR_HOME root
const created: string[] = []; // temp dirs to clean up in afterAll

/** Run the pointer-corruption tests with console.warn captured, then restored. */
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const orig = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = orig;
  }
}

beforeEach(() => {
  delete process.env.OCR_ENV;
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-env-home-'));
  process.env.OCR_HOME = HOME;
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-env-cwd-'));
  process.chdir(fresh);
  created.push(fresh, HOME);
  __resetEnvResolutionForTests();
});

afterAll(() => {
  process.chdir(originalCwd);
  if (prevOcrEnv === undefined) delete process.env.OCR_ENV;
  else process.env.OCR_ENV = prevOcrEnv;
  if (prevOcrHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = prevOcrHome;
  __resetEnvResolutionForTests();
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/* ─── Precedence: customPath > OCR_ENV > pointer > default ───────────────── */

describe('resolveEnvName / getConfigPath precedence', () => {
  it('customPath argument wins over OCR_ENV and the pointer', async () => {
    await createEnv({ name: 'alpha' });
    await createEnv({ name: 'beta' });
    writePointer('alpha');
    process.env.OCR_ENV = 'beta';
    const custom = path.join(HOME, 'elsewhere', 'my.yaml');
    expect(path.resolve(getConfigPath(custom))).toBe(custom);
  });

  it('OCR_ENV beats the pointer file', async () => {
    await createEnv({ name: 'alpha' });
    await createEnv({ name: 'beta' });
    writePointer('alpha');
    process.env.OCR_ENV = 'beta';
    __resetEnvResolutionForTests();
    expect(resolveEnvName()).toBe('beta');
    expect(getEnvPaths().configPath).toBe(path.join(HOME, 'envs', 'beta', 'config.yaml'));
  });

  it('OCR_ENV="default" beats a pointer naming a real env', async () => {
    await createEnv({ name: 'alpha' });
    writePointer('alpha');
    process.env.OCR_ENV = 'default';
    __resetEnvResolutionForTests();
    expect(resolveEnvName()).toBe(DEFAULT_ENV_NAME);
  });

  it('pointer beats the implicit default', async () => {
    await createEnv({ name: 'alpha' });
    writePointer('alpha');
    __resetEnvResolutionForTests();
    expect(resolveEnvName()).toBe('alpha');
  });

  it('no OCR_ENV and no pointer → implicit default', () => {
    expect(resolveEnvName()).toBe(DEFAULT_ENV_NAME);
  });
});

/* ─── Pointer file: atomicity + corruption fallback ──────────────────────── */

describe('pointer file', () => {
  it('writePointer is atomic (tmp+rename): one line, no leftover .tmp', async () => {
    await createEnv({ name: 'alpha' });
    writePointer('alpha');
    const file = path.join(getEnvsRootDir(), 'current');
    expect(fs.readFileSync(file, 'utf8')).toBe('alpha\n');
    expect(readPointer()).toBe('alpha');
    const strays = fs.readdirSync(getEnvsRootDir()).filter((f) => f.includes('.tmp'));
    expect(strays).toEqual([]);
  });

  it('writePointer("default") is allowed (explicit pin)', () => {
    writePointer(DEFAULT_ENV_NAME);
    expect(readPointer()).toBe(DEFAULT_ENV_NAME);
    expect(resolveEnvName()).toBe(DEFAULT_ENV_NAME);
  });

  it('corrupted pointer → null + exactly one warn per process + default fallback', async () => {
    __resetEnvResolutionForTests(); // clear the warn-once flag for this case
    fs.mkdirSync(getEnvsRootDir(), { recursive: true });
    fs.writeFileSync(path.join(getEnvsRootDir(), 'current'), 'not a valid env name!!!', 'utf8');
    const { result, warnings } = captureWarnings(() => [readPointer(), readPointer(), resolveEnvName()]);
    expect(result[0]).toBeNull();
    expect(result[2]).toBe(DEFAULT_ENV_NAME); // controlled exception: fall back
    expect(warnings.length).toBe(1); // warn once, not per read
    expect(warnings[0]).toMatch(/[Cc]orrupted pointer/);
  });

  it('multi-line pointer is unparsable → default', () => {
    fs.mkdirSync(getEnvsRootDir(), { recursive: true });
    fs.writeFileSync(path.join(getEnvsRootDir(), 'current'), 'alpha\nbeta\n', 'utf8');
    const { warnings } = captureWarnings(() => expect(resolveEnvName()).toBe(DEFAULT_ENV_NAME));
    expect(warnings.length).toBe(1);
  });

  it('empty/whitespace pointer behaves like absent (no warn, no crash)', () => {
    fs.mkdirSync(getEnvsRootDir(), { recursive: true });
    fs.writeFileSync(path.join(getEnvsRootDir(), 'current'), '  \n', 'utf8');
    const { warnings } = captureWarnings(() => expect(resolveEnvName()).toBe(DEFAULT_ENV_NAME));
    expect(readPointer()).toBeNull();
    expect(warnings.length).toBe(0);
  });
});

/* ─── Fail-fast: unknown / invalid OCR_ENV is a startup error ────────────── */

describe('fail-fast', () => {
  it('OCR_ENV naming a non-existent env throws (never silent fallback)', () => {
    process.env.OCR_ENV = 'nosuchenv';
    __resetEnvResolutionForTests();
    expect(() => resolveEnvName()).toThrow(/does not exist/);
    // getConfigPath routes through it, so boot crashes too
    expect(() => getConfigPath()).toThrow(/does not exist/);
  });

  it('well-formed pointer naming a deleted env throws', async () => {
    await createEnv({ name: 'ghost' });
    writePointer('ghost');
    // Simulate manual/external removal (trashEnv would clear the pointer —
    // a dangling one is exactly what fail-fast must catch at next boot).
    fs.rmSync(path.join(HOME, 'envs', 'ghost'), { recursive: true, force: true });
    __resetEnvResolutionForTests();
    expect(() => resolveEnvName()).toThrow(/does not exist/);
  });

  it('grammatically invalid OCR_ENV throws with a name-pattern message', () => {
    process.env.OCR_ENV = 'Bad Name!';
    __resetEnvResolutionForTests();
    expect(() => resolveEnvName()).toThrow(/valid environment name/);
  });
});

/* ─── Name validation ────────────────────────────────────────────────────── */

describe('env name validation', () => {
  it('rejects: empty, too long, bad first char, separators, spaces, dots', () => {
    for (const bad of [
      '',
      'x'.repeat(33), // 33 chars
      '_leading',
      '-leading',
      'has space',
      'has.dot',
      'has/slash',
      'has\\backslash',
      'emoji-🚀',
    ]) {
      expect(isValidEnvName(bad)).toBe(false);
    }
  });

  it('accepts: alnum start, [A-Za-z0-9_-] body, exactly 32 chars', () => {
    for (const good of ['a', 'A', 'z9', 'dev-1', 'dev_1', 'DevAlpha', 'x'.repeat(32)]) {
      expect(isValidEnvName(good)).toBe(true);
    }
  });

  it('createEnv rejects reserved names case-insensitively', async () => {
    await expect(createEnv({ name: 'default' })).rejects.toThrow(/reserved/i);
    await expect(createEnv({ name: 'DEFAULT' })).rejects.toThrow(/reserved/i);
    await expect(createEnv({ name: 'current' })).rejects.toThrow(/reserved/i);
  });

  it('createEnv rejects invalid names and case-insensitive duplicates', async () => {
    await expect(createEnv({ name: 'no.good' })).rejects.toThrow(/invalid/);
    await createEnv({ name: 'alpha' });
    await expect(createEnv({ name: 'ALPHA' })).rejects.toThrow(/already exists/i);
  });
});

/* ─── The bootstrap default binds <home>/envs/default/ ───────────────────── */

describe('default env binds envs/default paths', () => {
  it('every path lives inside the env directory — no cwd or home-root path', () => {
    const dir = path.join(HOME, 'envs', 'default');
    const p = getEnvPaths();
    expect(p.configPath).toBe(path.join(dir, 'config.yaml'));
    expect(p.dataDir).toBe(path.join(dir, 'data'));
    expect(p.modelsDir).toBe(path.join(dir, 'models'));
    expect(p.catalogDir).toBe(path.join(dir, 'catalog'));
    expect(p.tracesDir).toBe(path.join(dir, 'traces'));
    expect(p.captureDir).toBe(path.join(dir, 'capture'));
    expect(p.webauthSecretPath).toBe(path.join(dir, 'webauth-secret'));
    expect(getConfigPath()).toBe(p.configPath);
  });

  it('OCR_ENV=default resolves to the same bootstrap directory', () => {
    process.env.OCR_ENV = 'default';
    __resetEnvResolutionForTests();
    expect(getConfigPath()).toBe(path.join(HOME, 'envs', 'default', 'config.yaml'));
  });

  it('L2 decision sink lands under the env data dir', () => {
    const dataDir = path.join(HOME, 'envs', 'default', 'data');
    const gate = applyDecisionCaptureConfig({ collectEnabled: false });
    expect(gate.datasetPath).toBe(path.resolve(dataDir, 'layer2-decisions.jsonl'));
  });
});

/* ─── Named env paths bind to <home>/envs/<name>/ ────────────────────────── */

describe('named env paths', () => {
  it('all seven paths bind inside the env dir', async () => {
    await createEnv({ name: 'dev' });
    writePointer('dev');
    __resetEnvResolutionForTests();
    const dir = path.join(HOME, 'envs', 'dev');
    const p = getEnvPaths();
    expect(p.configPath).toBe(path.join(dir, 'config.yaml'));
    expect(p.dataDir).toBe(path.join(dir, 'data'));
    expect(p.modelsDir).toBe(path.join(dir, 'models'));
    expect(p.catalogDir).toBe(path.join(dir, 'catalog'));
    expect(p.tracesDir).toBe(path.join(dir, 'traces'));
    expect(p.captureDir).toBe(path.join(dir, 'capture'));
    expect(p.webauthSecretPath).toBe(path.join(dir, 'webauth-secret'));
    expect(getConfigPath()).toBe(p.configPath);
  });

  it('createEnv writes env.json metadata + blank annotated config', async () => {
    await createEnv({ name: 'dev', type: 'sandbox', description: 'throwaway' });
    const meta = JSON.parse(fs.readFileSync(path.join(HOME, 'envs', 'dev', 'env.json'), 'utf8'));
    expect(meta).toMatchObject({ name: 'dev', type: 'sandbox', schemaVersion: 1, description: 'throwaway' });
    expect(typeof meta.createdAt).toBe('string');
    const cfg = fs.readFileSync(path.join(HOME, 'envs', 'dev', 'config.yaml'), 'utf8');
    expect(cfg).toContain('port:'); // defaultConfigYaml() template, not an empty file
  });

  it('renameEnv moves the dir, updates env.json, follows the pointer', async () => {
    await createEnv({ name: 'old' });
    writePointer('old');
    renameEnv('old', 'new');
    expect(fs.existsSync(path.join(HOME, 'envs', 'old'))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(HOME, 'envs', 'new', 'env.json'), 'utf8'));
    expect(meta.name).toBe('new');
    expect(readPointer()).toBe('new');
  });

  it('rename/trash follow a pointer whose case differs from the dir name (L3 P3-2, Windows FS semantics)', async () => {
    await createEnv({ name: 'alpha' });
    fs.mkdirSync(getEnvsRootDir(), { recursive: true });
    fs.writeFileSync(path.join(getEnvsRootDir(), 'current'), 'ALPHA\n', 'utf8'); // hand-written mixed-case pointer
    renameEnv('alpha', 'beta');
    expect(readPointer()).toBe('beta'); // would stay 'ALPHA' with the old exact comparison
    writePointer('BETA');
    trashEnv('beta');
    expect(readPointer()).toBeNull(); // cleared despite case difference
  });

  it('renameEnv rejects reserved/duplicate targets', async () => {
    await createEnv({ name: 'src' });
    await createEnv({ name: 'SRC' }).catch(() => undefined); // deduped at create — ensure only 'src' exists
    expect(() => renameEnv('src', 'default')).toThrow(/reserved/i);
    expect(() => renameEnv('src', 'x'.repeat(33))).toThrow(/invalid/);
    expect(() => renameEnv('nosuch', 'ok')).toThrow(/does not exist/);
  });
});

/* ─── trashEnv / resetSandboxEnv / listEnvs ──────────────────────────────── */

describe('trashEnv moves (never deletes)', () => {
  it('env dir lands in .trash/<name>-<ts> with its contents', async () => {
    await createEnv({ name: 'alpha' });
    const marker = path.join(HOME, 'envs', 'alpha', 'marker.txt');
    fs.writeFileSync(marker, 'keep me', 'utf8');
    writePointer('alpha');

    const dest = trashEnv('alpha');
    expect(dest.startsWith(path.join(HOME, 'envs', '.trash', 'alpha-'))).toBe(true);
    expect(fs.existsSync(path.join(HOME, 'envs', 'alpha'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'marker.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(dest, 'config.yaml'))).toBe(true); // moved along, not deleted
    expect(readPointer()).toBeNull(); // pointer cleared for the trashed env
  });

  it('the bootstrap default can never be trashed', () => {
    expect(() => trashEnv(DEFAULT_ENV_NAME)).toThrow(/bootstrap/);
  });
});

describe('resetSandboxEnv wipes state, keeps config', () => {
  it('data/traces/capture wiped; config.yaml + env.json + models kept', async () => {
    await createEnv({ name: 'sb', type: 'sandbox' });
    const dir = path.join(HOME, 'envs', 'sb');
    for (const sub of ['data', 'traces', 'capture', 'models']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
      fs.writeFileSync(path.join(dir, sub, 'file.jsonl'), 'x', 'utf8');
    }
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'port: 9999\n', 'utf8');

    resetSandboxEnv('sb');
    for (const wiped of ['data', 'traces', 'capture']) {
      expect(fs.existsSync(path.join(dir, wiped))).toBe(false);
    }
    expect(fs.existsSync(path.join(dir, 'models', 'file.jsonl'))).toBe(true); // models are config-adjacent
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe('port: 9999\n');
    expect(fs.existsSync(path.join(dir, 'env.json'))).toBe(true);
  });

  it('refuses regular envs and the bootstrap default', async () => {
    await createEnv({ name: 'reg' });
    expect(() => resetSandboxEnv('reg')).toThrow(/sandbox/);
    expect(() => resetSandboxEnv(DEFAULT_ENV_NAME)).toThrow(/does not exist/);
  });
});

describe('listEnvs', () => {
  it('bootstrap default first, created envs with metadata, trash/pointer skipped', async () => {
    await createEnv({ name: 'alpha', description: 'first' });
    await createEnv({ name: 'beta', type: 'sandbox' });
    trashEnv('beta');
    writePointer('alpha');
    __resetEnvResolutionForTests(); // "switch = restart": re-resolve against the new pointer
    const infos = listEnvs();
    expect(infos.map((e) => e.name)).toEqual(['default', 'alpha']); // beta only exists in .trash
    const def = infos[0];
    expect(def.name).toBe('default');
    expect(def.active).toBe(false); // pointer resolves 'alpha'
    const alpha = infos[1];
    expect(alpha).toMatchObject({ active: true, description: 'first' });
    expect(alpha.configPath).toBe(path.join(HOME, 'envs', 'alpha', 'config.yaml'));
  });

  it('fresh home with no envs dir lists only the bootstrap default', () => {
    const infos = listEnvs();
    expect(infos.length).toBe(1);
    expect(infos[0]).toMatchObject({ name: 'default', active: true });
  });
});
