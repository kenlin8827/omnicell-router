import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceTracker, type ExecutionTrace } from '../src/trace/tracker.js';

let seq = 0;
const mkTrace = (over: { sessionId: string; timestamp: number } & Partial<ExecutionTrace>): ExecutionTrace => ({
  traceId: `trace_persist_test_${++seq}`,
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
    layerUsed: 'layer1',
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
  });
});
