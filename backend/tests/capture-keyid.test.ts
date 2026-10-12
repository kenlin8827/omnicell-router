/**
 * API-key attribution on the capture event stream (per-application request
 * logs + retrieval). Pins the contract added for "which application drove
 * this captured request":
 *   • every HttpExchangeEvent of a key-authenticated turn carries
 *     apiKey = { id, name } (the non-secret half of ApiKeyConfig);
 *   • the raw token value NEVER reaches the archive;
 *   • master-key (adminApiKey) access carries no attribution (field absent);
 *   • listSessions surfaces the attribution per archive and filters by it;
 *   • the lightweight session trajectory (ExecutionTrace via
 *     /api/admin/traces) and /api/admin/sessions expose the same identity.
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

const CLIENT_KEY = 'sk-ocr-keyattr-test-0123456789abcdef';
const CLIENT_KEY_ID = 'key-keyattr-fixture';
const CLIENT_KEY_NAME = 'KeyAttr Fixture App';
// Second key — rotation/mixed-session coverage: a session that switches key
// mid-way must stay findable under BOTH identities.
const CLIENT_KEY2 = 'sk-ocr-keyattr-test2-fedcba9876543210';
const CLIENT_KEY2_ID = 'key-keyattr-fixture-2';
const CLIENT_KEY2_NAME = 'KeyAttr Fixture App Two';
const MASTER_KEY = 'sk-ocr-keyattr-master';

let tmp: string;
let app: FastifyInstance;
// Date dir pinned once for the whole suite: writers key archives by the
// request-time date, so computing the dir per-read would race midnight (the
// reviewer P2). A suite run that itself crosses midnight is the accepted
// ceiling (test-isolated runner restarts per file).
let dateDir: string;

function readAllLines(): string[] {
  const dir = path.join(tmp, dateDir);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      out.push(line);
    }
  }
  return out;
}

function readEvents(): any[] {
  return readAllLines().map(l => JSON.parse(l)).filter(e => e.eventType === 'http-exchange');
}

function eventsFor(marker: string): any[] {
  return readEvents().filter(e => JSON.stringify(e.wire ?? {}).includes(marker));
}

async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`capture events did not settle within ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('capture-keyid (API-key attribution on request logs)', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-keyattr-'));
    dateDir = CaptureRecorder.localDateDir(new Date());
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    config.adminApiKey = MASTER_KEY;
    config.apiKeys = [
      {
        id: CLIENT_KEY_ID,
        name: CLIENT_KEY_NAME,
        key: CLIENT_KEY,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: CLIENT_KEY2_ID,
        name: CLIENT_KEY2_NAME,
        key: CLIENT_KEY2,
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

  it('key-authenticated turn: every event carries apiKey {id,name}, never the token', async () => {
    const marker = `KEYATTR-${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${CLIENT_KEY}` },
      payload: { model: 'auto', messages: [{ role: 'user', content: marker }] },
    });
    assert.equal(res.statusCode, 200);

    await waitUntil(() => eventsFor(marker).length >= 2);
    const events = eventsFor(marker);
    assert.ok(events.length >= 2, 'client request + response events exist for the turn');
    for (const ev of events) {
      assert.deepEqual(ev.apiKey, { id: CLIENT_KEY_ID, name: CLIENT_KEY_NAME }, `${ev.direction}/${ev.phase} event attributed`);
    }

    // Credential hygiene: the token value itself must never hit the disk —
    // neither as a raw header value nor anywhere inside the event JSON.
    for (const line of readAllLines()) {
      assert.ok(!line.includes(CLIENT_KEY), 'raw client token never persisted in archive');
    }
    const reqEv = events.find(e => e.direction === 'client' && e.phase === 'request')!;
    assert.equal(reqEv.wire.requestHeaders['authorization'], '[REDACTED]', 'authorization header stays redacted');
  });

  it('master-key access: events carry no apiKey attribution', async () => {
    const marker = `KEYATTR-MASTER-${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: { model: 'auto', messages: [{ role: 'user', content: marker }] },
    });
    assert.equal(res.statusCode, 200);

    await waitUntil(() => eventsFor(marker).length >= 2);
    for (const ev of eventsFor(marker)) {
      assert.equal(ev.apiKey, undefined, 'master-key leg stays unattributed (no client key entry)');
    }
  });

  it('mixed-key session: per-event attribution stays exact, row aggregates, retrieval matches both', async () => {
    const sid = `keyattr-mixed-${Date.now()}`;
    const m1 = `KEYATTR-M1-${Date.now()}`;
    const m2 = `KEYATTR-M2-${Date.now()}`;
    // Same explicit session id, two different keys — the rotation scenario.
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${CLIENT_KEY}`, 'x-session-id': sid },
      payload: { model: 'auto', messages: [{ role: 'user', content: m1 }] },
    });
    assert.equal(r1.statusCode, 200);
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${CLIENT_KEY2}`, 'x-session-id': sid },
      payload: { model: 'auto', messages: [{ role: 'user', content: m2 }] },
    });
    assert.equal(r2.statusCode, 200);

    await waitUntil(() => eventsFor(m1).length >= 2 && eventsFor(m2).length >= 2);
    // The source of truth stays per-turn exact — no first-key freezing.
    for (const ev of eventsFor(m1)) assert.equal(ev.apiKey?.id, CLIENT_KEY_ID, 'turn 1 events -> key 1');
    for (const ev of eventsFor(m2)) assert.equal(ev.apiKey?.id, CLIENT_KEY2_ID, 'turn 2 events -> key 2');
    // Credential hygiene holds for the second key too.
    for (const line of readAllLines()) assert.ok(!line.includes(CLIENT_KEY2), 'raw key2 token never persisted');

    const recorder = new CaptureRecorder({
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 64,
      maxBodyBytes: 65536,
    });
    try {
      const row = recorder.listSessions(dateDir).find(r => r.sessionId === sid);
      assert.ok(row, 'mixed-key archive row exists');
      assert.equal(row!.apiKeys?.[0].id, CLIENT_KEY_ID, 'first element = display anchor');
      assert.deepEqual(
        (row!.apiKeys ?? []).map(k => k.id).sort(),
        [CLIENT_KEY_ID, CLIENT_KEY2_ID].sort(),
        'distinct key set aggregates both'
      );
      // Membership retrieval: the SECOND key finds the session too — the
      // first-wins-only filter would have missed it.
      assert.ok(recorder.listSessions(dateDir, CLIENT_KEY2_ID).some(r => r.sessionId === sid));
      assert.ok(recorder.listSessions(dateDir, 'app two').some(r => r.sessionId === sid));
    } finally {
      recorder.stop();
    }

    // Sessions route: same membership semantics over the trace-derived set.
    const sres = await app.inject({
      method: 'GET',
      url: `/api/admin/sessions?apiKey=${encodeURIComponent(CLIENT_KEY2_ID)}`,
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    const srows = ((await sres.json()).data ?? []) as any[];
    assert.ok(srows.some(r => r.id === sid), '/api/admin/sessions apiKey filter matches by membership');
  });

  it('listSessions: surfaces apiKey on the row and filters by id / name', async () => {
    const date = dateDir;
    const recorder = new CaptureRecorder({
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 64,
      maxBodyBytes: 65536,
    });
    try {
      const rows = recorder.listSessions(date);
      const attributed = rows.filter(r => r.apiKeys?.some(k => k.id === CLIENT_KEY_ID));
      assert.ok(attributed.length >= 1, 'key-authenticated archive row carries the identity');
      assert.equal(attributed[0].apiKeys![0].name, CLIENT_KEY_NAME);

      // Exact-id filter and case-insensitive name substring both select it.
      assert.ok(recorder.listSessions(date, CLIENT_KEY_ID).some(r => r.apiKeys?.some(k => k.id === CLIENT_KEY_ID)));
      assert.ok(recorder.listSessions(date, 'keyattr fixture').some(r => r.apiKeys?.some(k => k.id === CLIENT_KEY_ID)));
      // A key nobody used yields an empty list (not an error).
      assert.equal(recorder.listSessions(date, 'key-does-not-exist').length, 0);
    } finally {
      // stop() unref'd would still be fine, but a failed assert must not
      // leave the hourly sweep timer running (failure would turn into hang).
      recorder.stop();
    }
  });

  it('console API: sessions list exposes the identity; capture sessions route filters by ?apiKey=', async () => {
    // /api/admin/* accepts the master adminApiKey as Bearer credential.
    const adminHeaders = { authorization: `Bearer ${MASTER_KEY}` };

    const tracesRes = await app.inject({ method: 'GET', url: '/api/admin/traces?limit=100', headers: adminHeaders });
    assert.equal(tracesRes.statusCode, 200);
    const traces = (await tracesRes.json()).data as any[];
    const attributedTrace = traces.find(t => t.apiKey?.id === CLIENT_KEY_ID);
    assert.ok(attributedTrace, 'ExecutionTrace (session trajectory) carries the key identity');

    const date = dateDir;
    const allRes = await app.inject({ method: 'GET', url: `/api/admin/capture/${date}/sessions`, headers: adminHeaders });
    assert.equal(allRes.statusCode, 200);
    const all = (await allRes.json()).sessions as any[];
    assert.ok(all.some(s => s.apiKeys?.some(k => k.id === CLIENT_KEY_ID)), 'sessions row exposes apiKeys');

    const filteredRes = await app.inject({
      method: 'GET',
      url: `/api/admin/capture/${date}/sessions?apiKey=${encodeURIComponent(CLIENT_KEY_ID)}`,
      headers: adminHeaders,
    });
    const filtered = (await filteredRes.json()).sessions as any[];
    assert.ok(filtered.length >= 1);
    assert.ok(filtered.every(s => s.apiKeys?.some(k => k.id === CLIENT_KEY_ID)), 'every returned row contains the requested key (mixed-key rows included)');

    const sessionsRes = await app.inject({ method: 'GET', url: '/api/admin/sessions', headers: adminHeaders });
    assert.equal(sessionsRes.statusCode, 200);
    const body = await sessionsRes.json();
    const sessions = (body.data ?? body.sessions ?? []) as any[];
    assert.ok(sessions.some(s => s.apiKeys?.some(k => k.id === CLIENT_KEY_ID)), '/api/admin/sessions rows carry the identities');

    // Per-application selector on the sessions route — same semantics as the
    // capture sessions route (exact key id).
    const filteredSessionsRes = await app.inject({
      method: 'GET',
      url: `/api/admin/sessions?apiKey=${encodeURIComponent(CLIENT_KEY_ID)}`,
      headers: adminHeaders,
    });
    assert.equal(filteredSessionsRes.statusCode, 200);
    const filteredBody = await filteredSessionsRes.json();
    const filteredRows = (filteredBody.data ?? []) as any[];
    assert.ok(filteredRows.length >= 1, 'apiKey filter keeps the attributed sessions');
    assert.ok(filteredRows.every(s => s.apiKeys?.some(k => k.id === CLIENT_KEY_ID)), 'apiKey filter drops every other row');
  });
});
