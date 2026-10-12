/**
 * Cascade-delete pins for DELETE /api/admin/sessions/:id.
 *
 * Contract:
 *   • The delete also removes the session's request-capture archives across
 *     ALL date dirs (the orphan source when a session goes but its JSONL
 *     survives until the daily retention sweep).
 *   • Response stays backward compatible — legacy fields untouched, the new
 *     `capturesDeleted` count is additive only.
 *   • Disabled / absent capture surface must not error the delete: the
 *     recorder's readdir reads fail open, so the cascade is a safe no-op.
 *   • The hash output namespace is reserved (HASH_NAME_RE): a literal
 *     `h_<16hex>` session id can never alias another session's hashed
 *     archive — lowercase, and uppercase on case-insensitive filesystems.
 *   • Read naming equals write naming for ANY id (no trim/length cap in
 *     findBySession), so >512-char hashed archives still cascade-delete
 *     instead of silently reporting capturesDeleted=0.
 *
 * Fixture conventions mirror capture-http.test.ts: loadConfig() in the
 * isolated runner returns the sandbox placeholder config, capture points at
 * a mkdtemp dir, inject drives a mock turn, waitUntil settles the async
 * appendFile writes before the cascade assertion.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CaptureRecorder } from '../src/capture/recorder.js';

const TEST_KEY = 'sk-ocr-capture-cascade-test';
const SESSION_ID = 'sess_cascade_delete';

let tmp: string;
let app: FastifyInstance;

function countLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`capture events did not settle within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Seed one hand-written archive into a date dir; returns its path. */
function seedArchive(dir: string, sessionId: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${CaptureRecorder.sessionFileName(sessionId)}`);
  const line = JSON.stringify({
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'request',
    sessionId,
    wire: { requestLine: 'POST /v1/chat/completions HTTP/1.1', requestBody: '{"seed":"cascade-fixture"}' },
  });
  fs.writeFileSync(file, line + '\n', 'utf8');
  return file;
}

async function runMockTurn(instance: FastifyInstance, sessionId: string): Promise<void> {
  const res = await instance.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${TEST_KEY}`, 'x-session-id': sessionId },
    payload: { model: 'auto', messages: [{ role: 'user', content: `CASCADE ${sessionId}` }] },
  });
  assert.equal(res.statusCode, 200);
}

describe('capture-cascade (DELETE /api/admin/sessions/:id)', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-cascade-'));
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    config.apiKeys = [
      {
        id: 'key-capture-cascade',
        name: 'capture-cascade fixture',
        key: TEST_KEY,
        role: 'user',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ];
    config.requestCapture = { enabled: true, dir: tmp, retentionDays: 7, maxTotalMB: 64, maxBodyBytes: 65536 };
    app = createServer(config, true).app; // mockMode
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('cascades archive deletes across date dirs and reports capturesDeleted', async () => {
    const todayDir = path.join(tmp, CaptureRecorder.localDateDir(new Date()));
    const oldDir = path.join(tmp, CaptureRecorder.localDateDir(new Date(Date.now() - 86_400_000)));
    // Second archive in an older date dir — findBySession scans all dates.
    const oldFile = seedArchive(oldDir, SESSION_ID);

    // A mock turn creates the live session + traces and makes the capture
    // transport append this session's archive under today's dir.
    await runMockTurn(app, SESSION_ID);
    const todayFile = path.join(todayDir, `${SESSION_ID}.jsonl`);
    await waitUntil(() => countLines(todayFile) >= 2); // request+response events
    // Settle window so a late event cannot recreate the file after DELETE.
    await new Promise((r) => setTimeout(r, 150));

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/sessions/${SESSION_ID}` });
    assert.equal(del.statusCode, 200);
    const body = del.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.capturesDeleted, 2, 'today + older-date archives both removed');
    // Backward compat: the pre-cascade response contract survives untouched.
    assert.match(body.message, /successfully cleared/);
    assert.ok(!fs.existsSync(todayFile), 'today archive removed');
    assert.ok(!fs.existsSync(oldFile), 'cross-date archive removed');

    // Session is gone end to end — deleting again is the pre-existing 404.
    const again = await app.inject({ method: 'DELETE', url: `/api/admin/sessions/${SESSION_ID}` });
    assert.equal(again.statusCode, 404);
  });

  it('disabled capture: delete still succeeds, capturesDeleted=0 (safe skip)', async () => {
    const tmpOff = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-cascade-off-'));
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    config.apiKeys = [
      {
        id: 'key-capture-cascade-off',
        name: 'capture-cascade off fixture',
        key: TEST_KEY,
        role: 'user',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ];
    // Master switch off: recorder exists but archives are absent — the
    // cascade must fail open, never 500 the delete.
    config.requestCapture = { enabled: false, dir: tmpOff, retentionDays: 7 };
    const appOff = createServer(config, true).app;
    try {
      await runMockTurn(appOff, 'sess_cascade_off');
      // Remove the rootDir entirely — capture is disabled so nothing was
      // written, but deleting the dir pins the contract that a genuinely
      // absent archive root makes listDates fail open ([]): the cascade
      // must report capturesDeleted=0, never 500 the session delete.
      fs.rmSync(tmpOff, { recursive: true, force: true });
      const del = await appOff.inject({ method: 'DELETE', url: '/api/admin/sessions/sess_cascade_off' });
      assert.equal(del.statusCode, 200);
      const body = del.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.capturesDeleted, 0, 'disabled + absent capture dir → cascade is a silent no-op');
    } finally {
      await appOff.close();
      fs.rmSync(tmpOff, { recursive: true, force: true });
    }
  });

  it('literal h_<16hex> attacker id cannot alias a victim hashed archive (lowercase)', async () => {
    const todayDir = path.join(tmp, CaptureRecorder.localDateDir(new Date()));
    // Victim: unsafe id → hashed archive name h_<d>.jsonl.
    const victimUnsafe = '{"session_id":"victim-cascade","nonce":"p2-alias"}';
    const victimName = CaptureRecorder.sessionFileName(victimUnsafe);
    assert.match(victimName, /^h_[0-9a-f]{16}\.jsonl$/, 'victim archive is hash-named');
    const victimFile = seedArchive(todayDir, victimUnsafe);
    // Attacker: literal id equal to the victim's hash output (minus suffix).
    // Old pass-through naming resolved this to victimName exactly — cross-
    // session delete. The reserved-prefix guard must hash-of-hash instead.
    const attackerId = victimName.slice(0, -'.jsonl'.length);
    const attackerName = CaptureRecorder.sessionFileName(attackerId);
    assert.notEqual(attackerName, victimName, 'reserved hash namespace: no alias');
    const attackerFile = path.join(todayDir, attackerName);

    await runMockTurn(app, attackerId);
    await waitUntil(() => countLines(attackerFile) >= 2); // request+response events
    await new Promise((r) => setTimeout(r, 150)); // settle: no late event recreates the file

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/sessions/${attackerId}` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().capturesDeleted, 1, 'only the attacker own archive cascades');
    assert.ok(!fs.existsSync(attackerFile), 'attacker archive removed');
    assert.ok(fs.existsSync(victimFile), 'victim hashed archive survives the attacker cascade');
  });

  it('uppercase h_<HEX> literal id is forced through the hash branch too', () => {
    // The verbatim branch would name this file H_ABCDEF0123456789.jsonl —
    // the SAME file as the digest-named h_abcdef0123456789.jsonl on
    // case-insensitive filesystems (Windows/macOS). Case-insensitive guard
    // forces both spellings through the hash branch.
    const upper = 'h_ABCDEF0123456789';
    const lower = 'h_abcdef0123456789';
    for (const id of [upper, lower]) {
      const name = CaptureRecorder.sessionFileName(id);
      assert.notEqual(name, `${id}.jsonl`, `${id} must not pass through verbatim`);
      assert.match(name, /^h_[0-9a-f]{16}\.jsonl$/, 'hash-of-hash output is lowercase digest');
    }
    assert.notEqual(
      CaptureRecorder.sessionFileName(upper),
      `${lower}.jsonl`,
      'uppercase literal must not resolve to the lowercase hash name either'
    );
  });

  it('session id over 512 chars: findBySession resolves + deleteSession removes (cascade loop intact)', async () => {
    // Old findBySession bailed silently on length>512 while the write path
    // happily created the hashed archive — cascade missed with no warn.
    // Single-normalization fix: findBySession calls sessionFileName verbatim.
    // (The HTTP DELETE route cannot carry this id end-to-end: Fastify's
    // router rejects :id over maxParamLength=100 with a loud 414 before any
    // handler runs. The recorder-level findBySession→deleteSession loop,
    // exactly what server.ts cascades, is pinned here instead.)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-longid-'));
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 365, maxTotalMB: 512, maxBodyBytes: 1024 });
      const longId = `sess_${'x'.repeat(600)}`; // >512 chars, unsafe by length → hashed name
      await rec.record({ sessionId: longId, status: 'ok', model: 'auto', request: {} });
      const matches = rec.findBySession(longId);
      assert.equal(matches.length, 1, 'long hashed archive is found, not silently skipped');
      const file = path.join(dir, matches[0].date, matches[0].file);
      assert.ok(fs.existsSync(file));
      assert.equal(rec.deleteSession(matches[0].date, matches[0].file), true);
      assert.ok(!fs.existsSync(file), 'cascade deleteSession removes it');
      rec.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
