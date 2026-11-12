import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { TraceTracker, type ExecutionTrace } from '../src/trace/tracker.js';

let seq = 0;
const mkTrace = (over: { sessionId: string; timestamp: number } & Partial<ExecutionTrace>): ExecutionTrace => ({
  requestId: `trace_persist_test_${++seq}`,
  sessionId: over.sessionId,
  turnNumber: 1,
  timestamp: over.timestamp,
  request: {
    model: 'auto',
    userPromptSummary: 'hello',
    messageCount: 1,
    hasSystemPrompt: false,
    hasToolsOrSchema: false,
  },
  routing: {
    layerUsed: 'layer0',
    targetTier: 'lite',
    confidence: 0.5,
    reason: 'test',
    sessionRatchetApplied: false,
  },
  execution: {
    modelUsed: 'm-1',
    provider: 'p-1',
    tierUsed: 'lite',
    latencyMs: 10,
    fallbackOccurred: false,
  },
  finops: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0.001 },
  ...over,
});

const PERSIST = { enabled: true, retentionDays: 7, maxTotalMB: 50 };

/** Close all connections, then best-effort remove the temp dir (Windows may hold locks briefly). */
async function cleanup(dir: string, trackers: TraceTracker[]): Promise<void> {
  for (const t of trackers) {
    try {
      t.close();
    } catch {
      // already closed
    }
  }
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  console.warn(`[trace-persistence.test] temp dir cleanup skipped (locked): ${dir}`);
}

describe('TraceTracker SQLite persistence (write-through + boot replay)', () => {
  it('traces survive a tracker restart; deleteBySession also purges disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-traces-'));
    const opened: TraceTracker[] = [];
    try {
      // Tracker A: the "first process lifetime". Boot replay must happen at
      // construction, so every later tracker is created lazily AFTER the
      // records it is supposed to see (production opens exactly one tracker).
      const a = new TraceTracker(100, { ...PERSIST, dir });
      opened.push(a);
      await a.whenReady;
      if (!a.isPersisted()) return; // runtime without bun:sqlite — nothing to assert

      // NOTE: timestamps must be near "now" — the boot sweep applies the
      // 7-day retention, so epoch-near-zero stamps would be legitimately
      // swept (that is the cleanup mechanism working, not a bug).
      const now = Date.now();
      a.record(mkTrace({ sessionId: 's1', timestamp: now - 2000 }));
      a.record(
        mkTrace({
          sessionId: 's1',
          timestamp: now - 1000,
          execution: { modelUsed: 'm-2', provider: 'p-2', tierUsed: 'lite', latencyMs: 10, fallbackOccurred: false },
        })
      );
      a.record(mkTrace({ sessionId: 's2', timestamp: now }));

      // Tracker B: "the gateway restarted" — replays A's rows from disk.
      const b = new TraceTracker(100, { ...PERSIST, dir });
      opened.push(b);
      await b.whenReady;
      assert.equal(b.getTracesBySession('s1').length, 2, 'boot replay should restore s1 traces');
      assert.equal(b.getSessionAggregates('s1').traceCount, 2);
      assert.equal(b.getSessionAggregates('s1').switchCount, 1, 'model change m-1 -> m-2 counts as a switch');
      assert.deepEqual([...b.getSessionIds()].sort(), ['s1', 's2']);

      b.deleteBySession('s1');
      assert.equal(b.getTracesBySession('s1').length, 0, 'memory cleared');

      // Tracker C: boots from the post-delete store.
      const c = new TraceTracker(100, { ...PERSIST, dir });
      opened.push(c);
      await c.whenReady;
      assert.deepEqual([...c.getSessionIds()].sort(), ['s2'], 'deleted session must not survive on disk');
      assert.equal(c.getTracesBySession('s1').length, 0);
    } finally {
      await cleanup(dir, opened);
    }
  });

  it('thinking-effort observability fields survive the disk round-trip', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-traces-'));
    const opened: TraceTracker[] = [];
    try {
      const a = new TraceTracker(100, { ...PERSIST, dir });
      opened.push(a);
      await a.whenReady;
      if (!a.isPersisted()) return; // runtime without bun:sqlite — nothing to assert

      a.record(
        mkTrace({
          sessionId: 'effort-s',
          timestamp: Date.now(),
          execution: {
            modelUsed: 'm-1',
            provider: 'p-1',
            tierUsed: 'pro',
            latencyMs: 10,
            fallbackOccurred: false,
            requestedEffort: 'xhigh',
            actualEffort: 'high',
            reasoningDegraded: true,
            effortSource: 'l2-decision',
          },
        })
      );

      // Tracker B: "the gateway restarted" — the replayed trace must carry
      // the effort columns verbatim (the store keeps the whole JSON blob).
      const b = new TraceTracker(100, { ...PERSIST, dir });
      opened.push(b);
      await b.whenReady;
      const [tr] = b.getTracesBySession('effort-s');
      assert.ok(tr, 'boot replay should restore the trace');
      assert.strictEqual(tr.execution.requestedEffort, 'xhigh');
      assert.strictEqual(tr.execution.actualEffort, 'high');
      assert.strictEqual(tr.execution.reasoningDegraded, true);
      assert.strictEqual(tr.execution.effortSource, 'l2-decision');
    } finally {
      await cleanup(dir, opened);
    }
  });

  it('retention sweep drops rows older than the cutoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-traces-'));
    const opened: TraceTracker[] = [];
    try {
      const a = new TraceTracker(100, { ...PERSIST, retentionDays: 1, dir });
      opened.push(a);
      await a.whenReady;
      if (!a.isPersisted()) return;

      a.record(mkTrace({ sessionId: 'old', timestamp: Date.now() - 10 * 86_400_000 }));
      a.record(mkTrace({ sessionId: 'fresh', timestamp: Date.now() }));

      // B boots after the records: replays both, then its init sweep deletes
      // the aged-out row. C boots from the post-sweep store.
      const b = new TraceTracker(100, { ...PERSIST, retentionDays: 1, dir });
      opened.push(b);
      await b.whenReady;
      const c = new TraceTracker(100, { ...PERSIST, retentionDays: 1, dir });
      opened.push(c);
      await c.whenReady;
      assert.deepEqual([...c.getSessionIds()].sort(), ['fresh'], 'aged-out rows must be swept from disk');
    } finally {
      await cleanup(dir, opened);
    }
  });
});

describe('TraceTracker.getUsageStats / getSessionAggregates — raw token aggregates', () => {
  it('groups by API key, buckets unattributed turns as anonymous, and honors sinceTs', () => {
    const tracker = new TraceTracker(500); // memory-only
    const now = Date.now();
    tracker.record(
      mkTrace({
        sessionId: 's1',
        timestamp: now - 1000,
        apiKey: { id: 'k1', name: 'App One' },
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 20, fallbackOccurred: false },
        finops: { inputTokens: 100, outputTokens: 10, cachedTokens: 40, costUsd: 0.002 },
      })
    );
    tracker.record(
      mkTrace({
        sessionId: 's1',
        timestamp: now - 500,
        apiKey: { id: 'k1', name: 'App One' },
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 30, fallbackOccurred: false },
        finops: { inputTokens: 50, outputTokens: 5, cachedTokens: 0, costUsd: 0.001 },
      })
    );
    tracker.record(
      mkTrace({
        sessionId: 's2',
        timestamp: now,
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'plus', latencyMs: 10, fallbackOccurred: false },
        finops: { inputTokens: 25, outputTokens: 2, cachedTokens: 0, costUsd: 0.0005 },
      })
    );
    tracker.record(
      mkTrace({
        sessionId: 's3',
        timestamp: now - 2 * 3_600_000, // 2h ago — outside the narrow window below
        apiKey: { id: 'k9', name: 'Old App' },
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 5, fallbackOccurred: false },
        finops: { inputTokens: 7, outputTokens: 1, cachedTokens: 0, costUsd: 0.0001 },
      })
    );

    const full = tracker.getUsageStats();
    assert.equal(full.totals.requests, 4);
    assert.equal(full.totals.inputTokens, 182);
    assert.equal(full.totals.cachedTokens, 40);
    assert.equal(full.totals.avgLatencyMs, Math.round(65 / 4));
    assert.equal(full.totals.costUsd, 0.0036);
    const k1 = full.keys.find((r) => r.id === 'k1');
    assert.ok(k1);
    assert.equal(k1.requests, 2);
    assert.equal(k1.inputTokens, 150);
    assert.equal(k1.latencyMsSum, 50);
    const anon = full.keys.find((r) => r.id === '');
    assert.ok(anon, 'unattributed turns must share the anonymous bucket');
    assert.equal(anon.requests, 1);

    const windowed = tracker.getUsageStats({ sinceTs: now - 3_600_000 });
    assert.equal(windowed.totals.requests, 3, 'sinceTs must drop older traces');
    assert.equal(windowed.keys.find((r) => r.id === 'k9'), undefined);

    const agg = tracker.getSessionAggregates('s1');
    assert.equal(agg.traceCount, 2);
    assert.equal(agg.inputTokens, 150);
    assert.equal(agg.outputTokens, 15);
    assert.equal(agg.cachedTokens, 40);
    assert.equal(agg.costUsd, 0.003);
    assert.equal(agg.totalLatencyMs, 50, '20ms + 30ms summed across the session traces');
    assert.equal(agg.ttftSamples, 0, 'buffered fixtures carry no ttftMs');
    assert.equal(agg.ttftP50Ms, undefined, 'no samples, no percentile — the console renders "—"');
    assert.equal(agg.ttftP95Ms, undefined);
    assert.equal(agg.genMsSum, 0);
    assert.equal(agg.genOutputTokens, 0);
  });

  it('sums TTFT / decode windows only over streamed turns', () => {
    const tracker = new TraceTracker(500);
    const now = Date.now();
    tracker.record(
      mkTrace({
        sessionId: 'streamed',
        timestamp: now - 200,
        execution: {
          modelUsed: 'm',
          provider: 'p',
          tierUsed: 'lite',
          latencyMs: 120,
          fallbackOccurred: false,
          ttftMs: 40,
          genMs: 80,
        },
        finops: { inputTokens: 10, outputTokens: 20, cachedTokens: 0, costUsd: 0 },
      })
    );
    tracker.record(
      mkTrace({
        sessionId: 'streamed',
        timestamp: now - 100,
        execution: {
          modelUsed: 'm',
          provider: 'p',
          tierUsed: 'lite',
          latencyMs: 200,
          fallbackOccurred: false,
          ttftMs: 60,
          genMs: 140,
        },
        finops: { inputTokens: 10, outputTokens: 30, cachedTokens: 0, costUsd: 0 },
      })
    );
    // Buffered turn: no ttft/gen — must not dilute the streamed averages.
    tracker.record(
      mkTrace({
        sessionId: 'streamed',
        timestamp: now,
        execution: {
          modelUsed: 'm',
          provider: 'p',
          tierUsed: 'lite',
          latencyMs: 50,
          fallbackOccurred: false,
        },
        finops: { inputTokens: 5, outputTokens: 5, cachedTokens: 0, costUsd: 0 },
      })
    );

    const agg = tracker.getSessionAggregates('streamed');
    assert.equal(agg.ttftSamples, 2, 'only the two streamed turns carry a ttftMs');
    assert.equal(agg.ttftP50Ms, 50, 'median of [40, 60]');
    assert.equal(agg.ttftP95Ms, 59, 'linear interpolation toward the tail');
    assert.equal(agg.genMsSum, 220);
    assert.equal(agg.genOutputTokens, 50, 'only the two streamed turns contribute output to output speed');
    assert.equal(agg.totalLatencyMs, 370);
  });

  it('TTFT percentiles surface the tail instead of being dragged by a mean', () => {
    const tracker = new TraceTracker(500);
    const now = Date.now();
    // Nine ordinary turns plus one cold start: the mean would land near 3.6s,
    // a value NO turn experienced, while P50 stays at the typical 200ms.
    [200, 210, 220, 230, 240, 250, 260, 270, 280].forEach((ttftMs, i) => {
      tracker.record(
        mkTrace({
          sessionId: 'tail',
          timestamp: now - 10_000 + i,
          execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: ttftMs + 50, fallbackOccurred: false, ttftMs, genMs: 50 },
          finops: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0 },
        })
      );
    });
    tracker.record(
      mkTrace({
        sessionId: 'tail',
        timestamp: now,
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 31_000, fallbackOccurred: false, ttftMs: 30_000, genMs: 1000 },
        finops: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0 },
      })
    );

    const agg = tracker.getSessionAggregates('tail');
    assert.equal(agg.ttftSamples, 10);
    assert.ok(agg.ttftP50Ms! < 300, `P50 stays at the typical turn, got ${agg.ttftP50Ms}`);
    assert.ok(agg.ttftP95Ms! > 10_000, `P95 surfaces the cold start, got ${agg.ttftP95Ms}`);
  });

  it('stallRatio weighs every felt pause against the whole decode window', () => {
    const tracker = new TraceTracker(500);
    const now = Date.now();
    // Nine measured-smooth turns (no gap reached 1 s) plus one turn that froze
    // for 8 s inside a 8.8 s decode window. A maximum would report 8000 ms and
    // ignore that 8/10.6 s of the session's streaming time was healthy; the
    // ratio reports the actual stalled fraction.
    Array.from({ length: 9 }, (_, i) => i).forEach((i) => {
      tracker.record(
        mkTrace({
          sessionId: 'freeze',
          timestamp: now - 5000 + i,
          execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 400, fallbackOccurred: false, ttftMs: 200, genMs: 200, stalledMs: 0 },
          finops: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0 },
        })
      );
    });
    tracker.record(
      mkTrace({
        sessionId: 'freeze',
        timestamp: now,
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 9000, fallbackOccurred: false, ttftMs: 200, genMs: 8800, stalledMs: 8000 },
        finops: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0 },
      })
    );
    // A buffered turn carries no stalledMs/genMs pair — it must neither clear
    // nor dilute the ratio.
    tracker.record(
      mkTrace({
        sessionId: 'freeze',
        timestamp: now + 1,
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 50, fallbackOccurred: false },
        finops: { inputTokens: 5, outputTokens: 5, cachedTokens: 0, costUsd: 0 },
      })
    );

    const agg = tracker.getSessionAggregates('freeze');
    const expected = 8000 / (9 * 200 + 8800);
    assert.ok(
      typeof agg.stallRatio === 'number' && Math.abs(agg.stallRatio - expected) < 1e-9,
      `stall ratio must be 8000 summed ms over 10600 summed decode ms, got ${agg.stallRatio}`
    );
  });

  it('stallRatio is undefined without a measured gap, and 0 when measured smooth', () => {
    const tracker = new TraceTracker(500);
    tracker.record(
      mkTrace({
        sessionId: 'nosilent',
        timestamp: Date.now(),
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 100, fallbackOccurred: false, ttftMs: 50, genMs: 50 },
        finops: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0 },
      })
    );
    // A single visible chunk yields no gap — '—', never 0.
    assert.equal(tracker.getSessionAggregates('nosilent').stallRatio, undefined);
    // A measured stream whose gaps all stayed under 1 s is a real 0 — smooth,
    // not unmeasured.
    tracker.record(
      mkTrace({
        sessionId: 'nosilent',
        timestamp: Date.now() + 1,
        execution: { modelUsed: 'm', provider: 'p', tierUsed: 'lite', latencyMs: 300, fallbackOccurred: false, ttftMs: 50, genMs: 250, stalledMs: 0 },
        finops: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0 },
      })
    );
    assert.equal(tracker.getSessionAggregates('nosilent').stallRatio, 0);
  });
});

describe('traces.db v1 → v2 migration (ADR-0021)', () => {
  it('re-keys legacy trace-id rows under the same value and keeps them readable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-traces-mig-'));
    const legacyTraceId = 'a'.repeat(32);
    // v1 shape: primary key was the CALLER's trace id, no request column.
    const db = new Database(path.join(dir, 'traces.db'), { create: true });
    db.run(`CREATE TABLE traces (
      trace_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    const legacyRow = mkTrace({ sessionId: 'sess_legacy', timestamp: 1000 });
    const legacyJson = { ...legacyRow } as Record<string, unknown>;
    delete legacyJson.requestId;
    legacyJson.traceId = legacyTraceId;
    db.run('INSERT INTO traces (trace_id, session_id, ts, data) VALUES (?, ?, ?, ?)', [
      legacyTraceId,
      'sess_legacy',
      1000,
      JSON.stringify(legacyJson),
    ]);
    db.close();

    const reopened: TraceTracker[] = [];
    try {
      const tracker = new TraceTracker(10, { ...PERSIST, dir });
      reopened.push(tracker);
      await tracker.whenReady;
      const rows = tracker.getTracesBySession('sess_legacy');
      assert.equal(rows.length, 1, 'the legacy row is replayed');
      assert.equal(rows[0].requestId, legacyTraceId, 'key = its old (unique) trace id');
      assert.equal(tracker.getTrace(legacyTraceId)?.sessionId, 'sess_legacy');
      // A NEW write keeps both rows distinct even when a caller reuses that value.
      tracker.record(mkTrace({ sessionId: 'sess_legacy', timestamp: 2000, clientRequestId: legacyTraceId }));
      assert.equal(tracker.getTracesBySession('sess_legacy').length, 2);
    } finally {
      await cleanup(dir, reopened);
    }
  });

  it('reads a NEWER file version as-is instead of down-migrating it', async () => {
    // A downgraded binary must never rewrite a file a newer build owns: the
    // row shape it needs (`data` JSON) is stable, so it replays and keeps
    // writing. Guard: version > DB_VERSION skips the migration branch.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-traces-newer-'));
    const seeded = mkTrace({ sessionId: 'sess_newer', timestamp: 1000 });
    const seed = new Database(path.join(dir, 'traces.db'), { create: true });
    seed.run(`CREATE TABLE traces (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL,
      future_column TEXT
    )`);
    seed.run('INSERT INTO traces (request_id, session_id, ts, data, future_column) VALUES (?, ?, ?, ?, ?)', [
      seeded.requestId,
      'sess_newer',
      1000,
      JSON.stringify(seeded),
      'keep-me',
    ]);
    seed.run('PRAGMA user_version = 99');
    seed.close();

    const reopened: TraceTracker[] = [];
    try {
      const tracker = new TraceTracker(10, { ...PERSIST, dir });
      reopened.push(tracker);
      await tracker.whenReady;
      assert.equal(tracker.getTrace(seeded.requestId)?.sessionId, 'sess_newer');
      // Still writable, and the unknown column survives (no rebuild happened).
      tracker.record(mkTrace({ sessionId: 'sess_newer', timestamp: 2000 }));
      const check = new Database(path.join(dir, 'traces.db'), { create: true });
      // bun:sqlite returns untyped rows; these two pragmas are the only
      // untrusted reads here and both are asserted below.
      const info = check.query('PRAGMA table_info(traces)').all() as Array<{ name: string }>;
      const versionRow = check.query('PRAGMA user_version').get() as { user_version?: number } | null;
      const version = Number(versionRow?.user_version);
      check.close();
      assert.ok(info.some(c => c.name === 'future_column'), 'schema untouched');
      assert.equal(version, 99, 'user_version untouched');
    } finally {
      await cleanup(dir, reopened);
    }
  });

  it('rebuilds a v2-numbered file whose SHAPE is wrong (request_id PK + NOT NULL trace_id)', async () => {
    // Observed in a real deployment: an intermediate build left this shape
    // behind. The version said 2, so a version-only gate skipped the rebuild
    // and every later write failed the `trace_id NOT NULL` constraint — a
    // silent no-op for the whole trace store. The gate now checks the shape.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-traces-mixed-'));
    // Recent ts: the boot sweep deletes rows older than the retention window,
    // and this test is about the SHAPE migration, not retention.
    const seededAt = Date.now();
    const mixed = mkTrace({ sessionId: 'sess_mixed', timestamp: seededAt, requestId: 'req_keep_me' });
    const seed = new Database(path.join(dir, 'traces.db'), { create: true });
    seed.run(`CREATE TABLE traces (
      request_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    seed.run('INSERT INTO traces (request_id, trace_id, session_id, ts, data) VALUES (?, ?, ?, ?, ?)', [
      'req_keep_me',
      'b'.repeat(32),
      'sess_mixed',
      seededAt,
      JSON.stringify(mixed),
    ]);
    seed.run('PRAGMA user_version = 2');
    seed.close();

    const reopened: TraceTracker[] = [];
    try {
      const tracker = new TraceTracker(10, { ...PERSIST, dir });
      reopened.push(tracker);
      await tracker.whenReady;
      // The gateway key survives; the caller value does NOT replace it.
      assert.equal(tracker.getTrace('req_keep_me')?.sessionId, 'sess_mixed');
      // And new writes now land (they were silently dropped before).
      tracker.record(mkTrace({ sessionId: 'sess_mixed', timestamp: 2000 }));
      const check = new Database(path.join(dir, 'traces.db'), { create: true });
      const info = check.query('PRAGMA table_info(traces)').all() as Array<{ name: string; pk: number }>;
      const count = check.query('SELECT COUNT(*) AS c FROM traces').get() as { c: number };
      check.close();
      assert.deepEqual(info.map(c => c.name), ['request_id', 'session_id', 'ts', 'data']);
      assert.equal(info.find(c => c.name === 'request_id')?.pk, 1);
      assert.equal(count.c, 2, 'the migrated row plus the new one');
    } finally {
      await cleanup(dir, reopened);
    }
  });

});
