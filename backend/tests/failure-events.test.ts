import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootServer, makeConfig as seamMakeConfig } from './helpers/systemone-seam.js';
// This suite always runs with the Layer 2 micro-classifier disabled —
// pin it once instead of threading the option through every call site.
const makeConfig = (providers: any[], models: any[], systemone?: any): RouterConfig =>
  seamMakeConfig(providers, models, { systemone, disableLayer2Classifier: true });
import { RouterConfig } from '../src/config/types.js';
import { Layer2Decision } from '../src/router/layer2-decision.js';
import {
  FailureEventLog,
  getFailureEventLog,
  openFailureEventStore,
  setFailureEventLogForTests,
  type FailureEvent,
} from '../src/observability/failure-events.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

// ---------------------------------------------------------------------------
// The failure_events ledger (observability plane): one event per failed
// upstream MODEL CALL, from the serving pool and the routing decision layer. These
// tests pin the ring/coalescing mechanics, the durable mirror (boot replay),
// BOTH emitters through their real code paths, and the admin read endpoint.
// ---------------------------------------------------------------------------

const originalCwd = process.cwd();
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-failures-'));
const sandbox = path.join(sandboxRoot, 'plain');
fs.mkdirSync(sandbox);
// Config + state resolve from OCR_HOME (never the cwd) — isolate a throwaway
// home whose bootstrap `default` env holds the placeholder config.
process.env.OCR_HOME = path.join(sandboxRoot, 'home');
process.env.OCR_ENV = 'default';
const ENV_DIR = path.join(process.env.OCR_HOME, 'envs', 'default');
fs.mkdirSync(ENV_DIR, { recursive: true });
fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'), 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n');
fs.writeFileSync(path.join(ENV_DIR, 'env.json'), JSON.stringify({ name: 'default', type: 'regular', schemaVersion: 1 }));
process.chdir(sandbox);
// Dead-port / localhost upstreams must fail by connection, never through a
// system proxy (HTTP(S)_PROXY would route 127.0.0.1 targets outward).
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

afterAll(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

let originalLog: FailureEventLog | undefined;

beforeEach(() => {
  // Fresh memory-only ring per test; the durable store is attached by boot
  // (index.ts) only — server instances in tests stay memory-only by design.
  originalLog = setFailureEventLogForTests(new FailureEventLog());
  Layer2Decision.clearDecisionCache();
});

afterEach(() => {
  Layer2Decision.clearDecisionCache();
});

afterAll(() => {
  setFailureEventLogForTests(originalLog);
});

describe('FailureEventLog — ring, coalescing, filters', () => {
  test('repeats of the same model+provider+errorClass+role fold into one row', () => {
    const log = new FailureEventLog();
    const base = { model: 'm1', provider: 'p', errorClass: 'RATE_LIMITED' as const, status: 429, message: 'rate', role: 'serving' as const };
    log.record({ ...base, sessionId: 's1' }, 1000);
    log.record({ ...base, sessionId: 's2' }, 2000); // repeat — coalesces
    log.record({ ...base, errorClass: 'QUOTA_EXHAUSTED', status: 402, message: 'quota', sessionId: 's3' }, 3000);
    log.record({ ...base, role: 'l2-decision' }, 3500); // different role — own row
    log.record({ ...base }, 11_500); // outside the 10s window — own row

    const rows = log.list(); // newest first
    expect(rows.length).toBe(4);
    const serving = rows.filter((r) => r.role === 'serving' && r.errorClass === 'RATE_LIMITED');
    expect(serving.length).toBe(2);
    const coalesced = serving.find((r) => r.count === 2)!;
    expect(coalesced.ts).toBe(1000); // first occurrence owns ts
    expect(coalesced.lastTs).toBe(2000); // repeat moved lastTs
    expect(coalesced.sessionId).toBe('s1'); // first occurrence owns the attribute
    expect(coalesced.count).toBe(2);
  });

  test('list() narrows by model / provider / errorClass / role and caps by limit', () => {
    const log = new FailureEventLog();
    log.record({ model: 'm1', provider: 'p1', errorClass: 'RATE_LIMITED', status: 429, message: 'a', role: 'serving' }, 1000);
    log.record({ model: 'm2', provider: 'p1', errorClass: 'TIMEOUT', message: 'b', role: 'l2-decision' }, 2000);
    log.record({ model: 'm1', provider: 'p2', errorClass: 'TIMEOUT', message: 'c', role: 'l2-decision' }, 3000);

    expect(log.list().length).toBe(3);
    expect(log.list({ model: 'm1' }).length).toBe(2);
    expect(log.list({ role: 'l2-decision' }).length).toBe(2);
    expect(log.list({ errorClass: 'TIMEOUT' }).map((r) => r.model)).toEqual(['m1', 'm2']); // newest first
    expect(log.list({ model: 'm1', role: 'l2-decision', limit: 1 }).map((r) => r.model)).toEqual(['m1']);
  });

  test('oversized error text is truncated to a bounded observation', () => {
    const log = new FailureEventLog();
    log.record({ model: 'm', provider: 'p', errorClass: 'UNKNOWN', message: 'x'.repeat(5000), role: 'serving' });
    const row = log.list()[0];
    expect(row.message.length).toBe(401); // 400 chars + ellipsis
    expect(row.message.endsWith('…')).toBe(true);
  });

  test('the ring holds at most 500 rows (oldest evicted)', () => {
    const log = new FailureEventLog();
    for (let i = 0; i < 505; i++) {
      log.record({ model: `m${i}`, provider: 'p', errorClass: 'UNKNOWN', message: 'x', role: 'serving' }, 1000 + i);
    }
    expect(log.list().length).toBe(500);
    expect(log.list()[0].model).toBe('m504'); // newest survives
    expect(log.list({ limit: 3 }).length).toBe(3);
  });

  test('clear() empties the ring', () => {
    const log = new FailureEventLog();
    log.record({ model: 'm', provider: 'p', errorClass: 'UNKNOWN', message: 'x', role: 'serving' });
    log.clear();
    expect(log.list()).toEqual([]);
  });

  test('remove() deletes ONE row; unknown ids report false', () => {
    const log = new FailureEventLog();
    log.record({ model: 'm1', provider: 'p', errorClass: 'RATE_LIMITED', status: 429, message: 'a', role: 'serving' }, 1000);
    log.record({ model: 'm2', provider: 'p', errorClass: 'TIMEOUT', message: 'b', role: 'l2-decision' }, 2000);
    const rows = log.list(); // newest first
    const victim = rows[0];
    expect(log.remove(victim.id)).toBe(true);
    const after = log.list();
    expect(after.length).toBe(1);
    expect(after[0].model).toBe('m1');
    expect(log.remove('no-such-id')).toBe(false);
  });
});

describe('FailureEventLog durable mirror (traces.db, independent handle)', () => {
  test('rows survive a fresh attach over the same directory (boot replay)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-failstore-'));
    let store: Awaited<ReturnType<typeof openFailureEventStore>> = null;
    let store2: Awaited<ReturnType<typeof openFailureEventStore>> = null;
    let store3: Awaited<ReturnType<typeof openFailureEventStore>> = null;
    try {
      store = await openFailureEventStore(dir);
      expect(store).not.toBeNull();
      const log = new FailureEventLog();
      log.attachStore(store!);
      log.record({ model: 'm1', provider: 'p', errorClass: 'RATE_LIMITED', status: 429, message: 'a', role: 'serving' }, 1000);
      log.record({ model: 'm1', provider: 'p', errorClass: 'RATE_LIMITED', status: 429, message: 'a', role: 'serving' }, 2000); // coalesces to ×2
      log.record({ model: 'm2', provider: 'p', errorClass: 'TIMEOUT', message: 'b', role: 'l2-decision' }, 3000);

      // A fresh log + fresh handle over the SAME dir — the boot-replay shape.
      store2 = await openFailureEventStore(dir);
      const log2 = new FailureEventLog();
      const replayed = log2.attachStore(store2!);
      expect(replayed).toBe(2);
      const rows = log2.list();
      expect(rows.map((r) => r.model)).toEqual(['m2', 'm1']); // newest first
      const m1 = rows.find((r) => r.model === 'm1')!;
      expect(m1.count).toBe(2); // the coalesced count survives the round-trip
      expect(m1.status).toBe(429);

      // clear() wipes ring AND mirror.
      log2.clear();
      store3 = await openFailureEventStore(dir);
      const log3 = new FailureEventLog();
      expect(log3.attachStore(store3!)).toBe(0);

      // remove() takes the mirror row with the ring row.
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-failstore-rm-'));
      try {
        const rmStore1 = await openFailureEventStore(dir2);
        const rmLog1 = new FailureEventLog();
        rmLog1.attachStore(rmStore1!);
        rmLog1.record({ model: 'k1', provider: 'p', errorClass: 'UNKNOWN', message: 'x', role: 'serving' }, 1000);
        rmLog1.record({ model: 'k2', provider: 'p', errorClass: 'UNKNOWN', message: 'y', role: 'serving' }, 2000);
        const victim = rmLog1.list()[0];
        expect(rmLog1.remove(victim.id)).toBe(true);

        const rmStore2 = await openFailureEventStore(dir2);
        const rmLog2 = new FailureEventLog();
        expect(rmLog2.attachStore(rmStore2!)).toBe(1);
        expect(rmLog2.list()[0].model).toBe('k1'); // only the survivor replays
        rmStore2?.close();
      } finally {
        // covered by the shared rm retry below (dir2 handled inline)
        for (let i = 0; i < 5; i++) {
          try {
            fs.rmSync(dir2, { recursive: true, force: true });
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }
    } finally {
      store?.close();
      store2?.close();
      store3?.close();
      // Windows can hold the WAL files briefly after close — retry the rm.
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  });
});

describe('Serving emitter — a real candidate-pool failure lands in the ledger', () => {
  test('upstream 429 on every attempt → one coalesced role=serving row', async () => {
    const upstream = serve({
      port: 0,
      async fetch() {
        // Short Retry-After (≤ the 2s in-place threshold) makes the 429
        // burst-class retriable: one in-place retry follows the first
        // attempt, and both coalesce into one ledger row.
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'rl', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [{ id: 'rl/m1', provider: 'rl', upstreamModel: 'm1', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { orchestrator } = bootServer(config);
      const req: ChatCompletionRequest = { model: 'rl/m1', messages: [{ role: 'user', content: 'hello' }] };
      // The chain has exactly one candidate: the attempt fails, the in-place
      // retry fails too, then the pool exhausts and process() throws.
      await expect(orchestrator.process(req)).rejects.toBeTruthy();

      const rows = getFailureEventLog().list();
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.role).toBe('serving');
      expect(row.model).toBe('rl/m1');
      expect(row.provider).toBe('rl');
      expect(row.errorClass).toBe('RATE_LIMITED');
      expect(row.status).toBe(429);
      expect(row.count).toBe(2); // in-place retry coalesced into the same row
    } finally {
      upstream.stop(true);
    }
  });
});

describe('Decision emitter — wire failure and deadline land as role=l2-decision rows', () => {
  test('upstream 500 → classified decision layer row carrying the triggering session', async () => {
    const upstream = serve({
      port: 0,
      async fetch() {
        return new Response('boom', { status: 500 });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-fail', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [{ id: 'l2-fail/jev', provider: 'l2-fail', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { registry } = bootServer(config);
      const result = await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: 'Prove Fermat.' }] },
        { enabled: true, model: 'l2-fail/jev', timeoutMs: 5000 },
        registry,
        undefined,
        undefined,
        'sess-l2dec-1'
      );
      expect(result).toBeNull();

      const rows = getFailureEventLog().list();
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.role).toBe('l2-decision');
      expect(row.model).toBe('l2-fail/jev');
      expect(row.provider).toBe('l2-fail');
      expect(row.errorClass).toBe('SERVICE_UNAVAILABLE');
      expect(row.status).toBe(500);
      expect(row.sessionId).toBe('sess-l2dec-1');
      expect(row.message).toContain('500');
    } finally {
      upstream.stop(true);
    }
  });

  test('deadline owns the observation: TIMEOUT row, and the late rejection never double-records', async () => {
    const upstream = serve({
      port: 0,
      async fetch() {
        // Valid answer, but slower than the decision layer deadline — the race fires
        // TIMEOUT first and the abandoned call rejects later.
        await new Promise((r) => setTimeout(r, 400));
        return Response.json({ answers: { tier: { type: 'choice', choice: 'ultra', confidence: 0.99 } } });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-slow', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test', timeoutMs: 60_000 }],
        [{ id: 'l2-slow/jev', provider: 'l2-slow', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { registry } = bootServer(config);
      const result = await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: 'Prove Fermat.' }] },
        { enabled: true, model: 'l2-slow/jev', timeoutMs: 150 },
        registry,
        undefined,
        undefined,
        'sess-l2dec-2'
      );
      expect(result).toBeNull();

      // Let the late rejection land (the upstream answers at ~400ms).
      await new Promise((r) => setTimeout(r, 800));

      const rows = getFailureEventLog().list();
      expect(rows.length).toBe(1); // exactly one observation for one abandoned call
      const row = rows[0];
      expect(row.role).toBe('l2-decision');
      expect(row.errorClass).toBe('TIMEOUT');
      expect(row.status).toBeUndefined(); // no HTTP response ever arrived
      expect(row.sessionId).toBe('sess-l2dec-2');
      expect(row.message).toContain('timeout');
    } finally {
      upstream.stop(true);
    }
  });
});

describe('GET /api/admin/failure-events — equality filters, newest first', () => {
  test('the endpoint narrows server-side and reflects the live ring', async () => {
    const upstream = serve({
      port: 0,
      async fetch() {
        return new Response('boom', { status: 500 });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-ep', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [{ id: 'l2-ep/jev', provider: 'l2-ep', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { app, registry } = bootServer(config);

      const log = getFailureEventLog();
      log.record({ model: 'a/m1', provider: 'a', errorClass: 'RATE_LIMITED', status: 429, message: 'x', role: 'serving' }, 1000);
      log.record({ model: 'b/m2', provider: 'b', errorClass: 'TIMEOUT', message: 'y', role: 'l2-decision' }, 2000);
      log.record({ model: 'c/m3', provider: 'c', errorClass: 'TIMEOUT', message: 'z', role: 'l2-decision' }, 3000);

      const all = await app.inject({ method: 'GET', url: '/api/admin/failure-events' });
      expect(all.statusCode).toBe(200);
      expect(all.json().events.length).toBe(3);
      expect(all.json().events[0].model).toBe('c/m3'); // newest first

      const filtered = await app.inject({ method: 'GET', url: '/api/admin/failure-events?role=l2-decision&errorClass=TIMEOUT&limit=1' });
      expect(filtered.statusCode).toBe(200);
      const events = filtered.json().events;
      expect(events.length).toBe(1);
      expect(events[0].model).toBe('c/m3');

      // Sanity: the decision layer path feeds the same ring (real emission, not seeding).
      await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: 'Prove Fermat.' }] },
        { enabled: true, model: 'l2-ep/jev', timeoutMs: 5000 },
        registry
      );
      const after = await app.inject({ method: 'GET', url: '/api/admin/failure-events?provider=l2-ep' });
      expect(after.json().events.length).toBe(1);
      expect(after.json().events[0].role).toBe('l2-decision');
      expect(after.json().events[0].errorClass).toBe('SERVICE_UNAVAILABLE');

      // Single-event DELETE: the seeded row disappears; unknown ids report
      // removed:false (route-entries delete contract).
      const seeded = all.json().events.find((e: FailureEvent) => e.model === 'b/m2')!;
      const del = await app.inject({ method: 'DELETE', url: `/api/admin/failure-events/${encodeURIComponent(seeded.id)}` });
      expect(del.statusCode).toBe(200);
      expect(del.json().removed).toBe(true);
      const afterDel = await app.inject({ method: 'GET', url: '/api/admin/failure-events' });
      expect(afterDel.json().events.some((e: FailureEvent) => e.id === seeded.id)).toBe(false);
      const delUnknown = await app.inject({ method: 'DELETE', url: '/api/admin/failure-events/no-such-id' });
      expect(delUnknown.json().removed).toBe(false);
    } finally {
      upstream.stop(true);
    }
  });
});
