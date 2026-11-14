import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBackup, restoreBackup } from '../src/cli/clients/base.js';

/**
 * `.bak.ocr` is the operator's ORIGINAL config. Every config hook snapshots on
 * setup and restores on teardown, so the snapshot must survive re-setups: a
 * second unconditional copy would capture the already-hooked file and teardown
 * would restore the takeover instead of undoing it.
 */
describe('config backup snapshot', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-backup-test-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('keeps the first snapshot across re-setups; teardown restores it', () => {
    fs.writeFileSync(configPath, '{"original":true}', 'utf8');
    expect(createBackup(configPath)).toBe(`${configPath}.bak.ocr`);

    // Second setup sees the hooked file — the original must not be replaced.
    fs.writeFileSync(configPath, '{"hooked":true}', 'utf8');
    expect(createBackup(configPath)).toBeNull();
    expect(fs.readFileSync(`${configPath}.bak.ocr`, 'utf8')).toBe('{"original":true}');

    expect(restoreBackup(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"original":true}');
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(false);
  });

  it('takes no snapshot when the target file does not exist yet', () => {
    expect(createBackup(configPath)).toBeNull();
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(false);
  });
});
