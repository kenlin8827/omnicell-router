import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { getOcrHomeDir, getLogFilePath } from '../src/cli/paths.js';

/**
 * Contract tests for POST /api/admin/logs/clear (backup + truncate) and the
 * NUL filtering that keeps the tail viewer clean after a Windows-style
 * sparse-hole truncate. Runs against the real server with webAuth disabled;
 * the isolated runner points OCR_HOME at a sandbox, so we only ever touch
 * this test home's ocr.log.
 */
describe('Admin logs clear (POST /api/admin/logs/clear)', () => {
  const baseConfig = loadConfig();
  baseConfig.host = '127.0.0.1';
  baseConfig.webAuth = { enabled: false };
  const { app } = createServer(baseConfig, true);

  const logFile = getLogFilePath();
  const homeDir = getOcrHomeDir();

  function clearBackups(): string[] {
    return fs
      .readdirSync(homeDir)
      .filter((n) => n.startsWith('ocr.log.clear-') && n.endsWith('.bak'));
  }

  before(() => {
    fs.rmSync(logFile, { force: true });
    for (const b of clearBackups()) fs.unlinkSync(path.join(homeDir, b));
  });

  after(() => {
    fs.rmSync(logFile, { force: true });
    for (const b of clearBackups()) fs.unlinkSync(path.join(homeDir, b));
  });

  it('reports nothing to clear when the file does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/logs/clear' });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.cleared, false);
    assert.strictEqual(body.exists, false);
  });

  it('truncates the live log and keeps a full backup copy', async () => {
    const content =
      '=== OCR banner ===\n' +
      JSON.stringify({ level: 30, time: Date.now(), msg: 'boot ok' }) + '\n' +
      JSON.stringify({ level: 50, time: Date.now(), msg: 'boom' }) + '\n';
    fs.writeFileSync(logFile, content);

    const res = await app.inject({ method: 'POST', url: '/api/admin/logs/clear' });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.cleared, true);
    assert.strictEqual(body.size, 0);
    assert.strictEqual(body.sizeBefore, Buffer.byteLength(content));

    // cp-dataloss: the pre-clear content must survive in a timestamped backup.
    const backups = clearBackups();
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(homeDir, backups[0]), 'utf8'), content);

    // In-place truncate (not delete): the path must still exist so the
    // daemon's O_APPEND fd keeps landing on the same inode.
    assert.ok(fs.existsSync(logFile));
    assert.strictEqual(fs.statSync(logFile).size, 0);
  });

  it('tail viewer shows cleared content and skips NUL sparse-hole bytes', async () => {
    // New writes after the clear (append at fd start) plus a NUL run the
    // Windows stale-offset writer would leave in the middle.
    fs.appendFileSync(logFile, '\0'.repeat(4096) + '\n');
    fs.appendFileSync(logFile, JSON.stringify({ level: 30, time: Date.now(), msg: 'after clear' }) + '\n');

    const res = await app.inject({ method: 'GET', url: '/api/admin/logs?tail=100' });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.exists, true);
    // NUL-only line is dropped; exactly the one post-clear line remains.
    assert.strictEqual(body.lines.length, 1);
    assert.strictEqual(body.lines[0].msg, 'after clear');
  });

  it('prunes old clear-backups beyond three', async () => {
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(homeDir, `ocr.log.clear-2026010${i}-00000${i}.bak`), 'stale');
    }
    fs.writeFileSync(logFile, 'repopulate\n');
    const res = await app.inject({ method: 'POST', url: '/api/admin/logs/clear' });
    assert.strictEqual(res.json().cleared, true);
    // 4 seeded + 1 fresh = 5, capped at 3 most recent by name order.
    const backups = clearBackups().sort();
    assert.strictEqual(backups.length, 3);
    assert.ok(backups[backups.length - 1] > 'ocr.log.clear-20260104-000004.bak');
  });
});
