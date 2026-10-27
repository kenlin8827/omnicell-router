import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import {
  RateLimiter,
  getRateLimiter,
  setRateLimiterForTests,
  apiKeySubject,
} from '../src/ratelimit/rate-limiter.js';
import { openRateLimitWindowStore } from '../src/ratelimit/window-store.js';
import type { RouterConfig } from '../src/config/types.js';

/**
 * Integration tests for the durable window checkpoints (rateLimit.persist):
 * the REAL bun:sqlite store (window-store.ts) — open/DDL, save/loadAll/
 * deleteStale round-trip, close — plus the engine wiring that the engine-level
 * fake-store tests cannot see: boot-order rehydration, checkpoint GC of
 * reset rows, and the POST /api/admin/ratelimit/windows/reset admin route.
 * The isolated runner points OCR_HOME at a sandbox; the store itself gets a
 * throwaway traces dir so it never touches the sandbox's own traces.db.
 */
describe('rate-limit window store (real SQLite round-trip)', () => {
  const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rlwin-'));

  after(() => {
    try {
      // Both dirs: the store fixtures AND the engine-wiring test's own
      // `${tracesDir}-engine` (created by openRateLimitWindowStore).
      fs.rmSync(tracesDir, { recursive: true, force: true });
      fs.rmSync(tracesDir + '-engine', { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('creates the table on open and round-trips rows through save/loadAll', async () => {
    const store = await openRateLimitWindowStore(tracesDir);
    assert.ok(store, 'bun:sqlite available in the bun runner');
    store.save('apikey:k1|60000|requests', '[[1700000000000,1]]');
    store.save('apikey:k1|86400000|tokens', '[[1700000000000,42]]');
    // Upsert semantics: a re-checkpoint REPLACES the row.
    store.save('apikey:k1|60000|requests', '[[1700000000001,2]]');
    const rows = store.loadAll();
    assert.strictEqual(rows.length, 2);
    const byKey = new Map(rows.map((r) => [r.key, r.data]));
    assert.strictEqual(byKey.get('apikey:k1|60000|requests'), '[[1700000000001,2]]');
    assert.strictEqual(byKey.get('apikey:k1|86400000|tokens'), '[[1700000000000,42]]');
    store.close();

    // A fresh handle on the same file sees the same rows (WAL durability).
    const reopened = await openRateLimitWindowStore(tracesDir);
    assert.ok(reopened);
    assert.strictEqual(reopened.loadAll().length, 2);
    reopened.close();
    assert.ok(fs.existsSync(path.join(tracesDir, 'traces.db')));
  });

  it('deleteStale removes exactly the rows whose key is not in the keep list', async () => {
    const store = (await openRateLimitWindowStore(tracesDir))!;
    store.deleteStale(['apikey:k1|60000|requests']);
    const keys = store.loadAll().map((r) => r.key);
    assert.deepEqual(keys.sort(), ['apikey:k1|60000|requests']);
    store.close();
  });

  it('engine wiring: reload-then-attach rehydrates, checkpoint preserves, reset GCs the row', async () => {
    // The boot-order contract (review CRITICAL-1 regression pin): the
    // constraint table MUST be armed BEFORE attachWindowStore — otherwise
    // every persisted row is skipped at rehydrate and the first checkpoint's
    // deleteStale([]) wipes them all.
    const engine = new RateLimiter();
    const config = {
      apiKeys: [{ id: 'w1', limits: [{ window: '1m', requests: 100 }] }],
    } as unknown as RouterConfig;
    engine.reload(config);

    const store = (await openRateLimitWindowStore(tracesDir + '-engine'))!;
    // Seed a persisted row the way a previous lifetime's checkpoint would
    // (wall-clock pairs): one live event for the armed constraint.
    store.save(`${apiKeySubject('w1')}|60000|requests`, JSON.stringify([[Date.now(), 7]]));

    const rehydrated = engine.attachWindowStore(store);
    assert.strictEqual(rehydrated, 1, 'the armed constraint rehydrates its row');

    // The rehydrated history binds: it counts into the live sum.
    const snap = engine.snapshot().find((w) => w.subject === apiKeySubject('w1'));
    assert.ok(snap);
    assert.ok(snap.used >= 7, 'rehydrated event counts into the live sum');

    // A checkpoint right after rehydration must NOT delete the live rows.
    engine.checkpoint();
    assert.strictEqual(store.loadAll().length, 1, 'checkpoint keeps the rehydrated row');

    // resetWindows → the next checkpoint GCs the cleared rows (ADR-0004 §7).
    assert.strictEqual(engine.resetWindows(apiKeySubject('w1')), 1);
    engine.checkpoint();
    assert.strictEqual(store.loadAll().length, 0, 'cleared rows are garbage-collected');

    engine.closeWindowStore();
    store.close();
  });
});

describe('POST /api/admin/ratelimit/windows/reset (admin escape hatch)', () => {
  const baseConfig = loadConfig();
  baseConfig.host = '127.0.0.1';
  baseConfig.webAuth = { enabled: false };
  baseConfig.apiKeys = [
    { id: 'rlreset', key: 'sk-rlreset', limits: [{ window: '1m', requests: 1 }] },
  ] as never;
  const { app } = createServer(baseConfig, true);

  const original = getRateLimiter();
  const engine = new RateLimiter();
  engine.reload({
    apiKeys: [{ id: 'rlreset', limits: [{ window: '1m', requests: 1 }] }],
  } as unknown as RouterConfig);

  before(() => {
    setRateLimiterForTests(engine);
  });
  after(() => {
    setRateLimiterForTests(original);
  });

  it('400s without a subject', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/ratelimit/windows/reset', payload: {} });
    assert.strictEqual(res.statusCode, 400);
  });

  it('404s for a subject with no tracked window', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/ratelimit/windows/reset',
      payload: { subject: 'apikey:nope' },
    });
    assert.strictEqual(res.statusCode, 404);
  });

  it('clears the live window so a stuck budget reopens at once', async () => {
    const subject = apiKeySubject('rlreset');
    const t0 = 1_700_000_000_000;
    assert.strictEqual(engine.tryDispatch(subject, t0).allowed, true);
    const denied = engine.tryDispatch(subject, t0 + 1);
    assert.ok(!denied.allowed, 'the requests:1 cap binds before the reset');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/ratelimit/windows/reset',
      payload: { subject },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().reset, 1);

    const reopened = engine.tryDispatch(subject, t0 + 2);
    assert.strictEqual(reopened.allowed, true, 'the reset window admits again');
    // Rule scoping: a reset for an unknown rule label of a KNOWN subject is 404.
    const scoped = await app.inject({
      method: 'POST',
      url: '/api/admin/ratelimit/windows/reset',
      payload: { subject, rule: '1h/requests' },
    });
    assert.strictEqual(scoped.statusCode, 404);
  });
});
