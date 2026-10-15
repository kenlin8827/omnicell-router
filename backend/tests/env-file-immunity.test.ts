import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimeBinary } from '../src/cli/daemon.js';

/**
 * OCR ships no dotenv/.env loader, but the Bun runtime auto-loads a cwd
 * `.env` on its own — so immunity is a CONVENTION (`--no-env-file` on every bun
 * entry point) rather than something the code can enforce from the inside. A
 * convention that nobody checks is re-decided at every new call site, so this
 * file checks it: any entry point that executes repository code under bun must
 * carry the flag, and no env-file loader may come back.
 *
 * Why it matters: a stray `.env` naming OCR_ENV becomes tier-1 of the
 * resolution chain and silently outranks the envs/current pointer that
 * `ocr env use` / the console switch writes — the "switch did not take effect"
 * trap the single-source-of-truth design exists to prevent.
 */

const repoRoot = path.resolve(import.meta.dir, '..', '..');

/** Commands that run repository code under bun (a stray .env would be read). */
function bunCodeEntryPoints(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([, cmd]) => /\bbun\b/.test(cmd) && /(backend\/src|scripts\/|src\/index\.ts|bun test)/.test(cmd))
    .map(([name]) => name);
}

describe('no env-file mechanism', () => {
  it('root package.json: every bun entry point that runs repo code passes --no-env-file', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const entries = bunCodeEntryPoints(pkg.scripts as Record<string, string>);
    // Guard the guard: if the heuristic ever matches nothing, the test must not
    // silently pass on an empty set.
    expect(entries.length).toBeGreaterThan(0);
    for (const name of entries) {
      expect(pkg.scripts[name]).toContain('--no-env-file');
    }
  });

  it('backend package.json: dev / start:bun / test pass --no-env-file', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'backend', 'package.json'), 'utf8'));
    for (const name of ['dev', 'start:bun', 'test']) {
      expect(pkg.scripts[name]).toContain('--no-env-file');
    }
  });

  it('spawned children keep the flag: dev.ts, the isolated test runner, the daemon child', () => {
    const dev = fs.readFileSync(path.join(repoRoot, 'scripts', 'dev.ts'), 'utf8');
    expect(dev).toContain("'--no-env-file'");

    const runner = fs.readFileSync(path.join(repoRoot, 'scripts', 'test-isolated.ts'), 'utf8');
    expect(runner).toContain("'--no-env-file'");

    // The detached gateway child (ocr start / env switch / restart handover).
    const runtime = resolveRuntimeBinary();
    if (/bun(\.exe)?$/.test(runtime.bin)) {
      expect(runtime.args).toContain('--no-env-file');
    }
  });

  it('the production node path reads no env file either (no --env-file, no dotenv)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.start).not.toContain('--env-file');
    for (const manifest of ['package.json', path.join('backend', 'package.json')]) {
      const json = JSON.parse(fs.readFileSync(path.join(repoRoot, manifest), 'utf8'));
      expect(json.dependencies?.dotenv ?? json.devDependencies?.dotenv).toBeUndefined();
    }
  });

  it('config/index.ts has no dotenv import or load call', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'backend', 'src', 'config', 'index.ts'), 'utf8');
    expect(src).not.toMatch(/from 'dotenv'/);
    expect(src).not.toMatch(/dotenv\.config\(/);
  });
});
