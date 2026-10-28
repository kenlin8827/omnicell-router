import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';

/**
 * Trust-boundary lock for the capture size knobs.
 *
 * `requestCapture.maxTotalMB` drives the retention sweep (delete oldest date
 * dirs until the pool fits) and `maxSessionMB` drives the per-session seal, so
 * a negative value written by hand — or typed into the console's number input,
 * which admits negatives — would either delete every archive or seal every
 * session at its first event. Both are irreversible, so the resolver clamps
 * finite numerics to >= 1 and falls back to the default on garbage.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-limits-'));

afterAll(() => {
  // Windows can hold a temp dir busy right after YAML writes — retry, never fail the file.
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      return;
    } catch {
      /* retry */
    }
  }
});

function load(yaml: string): ReturnType<typeof loadConfig> {
  const p = path.join(sandbox, `cfg-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, yaml, 'utf8');
  return loadConfig(p);
}

const capture = (yaml: string) => load(yaml).requestCapture!;

describe('requestCapture size knobs — clamped at the boundary', () => {
  it('negative caps clamp to 1 instead of nuking archives or sealing everything', () => {
    const c = capture(
      'schemaVersion: 1\nclient:\n  port: 3999\nops:\n  requestCapture:\n    enabled: true\n    retentionDays: -3\n    maxTotalMB: -5\n    maxBodyBytes: -1\n    maxSessionMB: -512\n'
    );
    expect(c.retentionDays).toBe(1);
    expect(c.maxTotalMB).toBe(1);
    expect(c.maxBodyBytes).toBe(1);
    expect(c.maxSessionMB).toBe(1);
  });

  it('zero clamps to 1 (0 would seal every archive immediately)', () => {
    const c = capture('schemaVersion: 1\nclient:\n  port: 3999\nops:\n  requestCapture:\n    maxSessionMB: 0\n    maxTotalMB: 0\n');
    expect(c.maxSessionMB).toBe(1);
    expect(c.maxTotalMB).toBe(1);
  });

  it('garbage falls back to the shipped default, not to zero', () => {
    const c = capture('schemaVersion: 1\nclient:\n  port: 3999\nops:\n  requestCapture:\n    maxTotalMB: "lots"\n    maxSessionMB: abc\n');
    expect(c.maxTotalMB).toBe(2048);
    expect(c.maxSessionMB).toBe(512);
  });

  it('valid values pass through untouched, and the default stays opted out', () => {
    const c = capture('schemaVersion: 1\nclient:\n  port: 3999\nops:\n  requestCapture:\n    maxTotalMB: 4096\n    maxBodyBytes: 33554432\n');
    expect(c.maxTotalMB).toBe(4096);
    expect(c.maxBodyBytes).toBe(33554432);
    expect(c.enabled).toBe(false);
  });
});
