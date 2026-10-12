import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { openFinOpsStore } from '../src/trace/persist.js';

const recordArgs = (over: Partial<Parameters<FinOpsTracker['record']>[0]> = {}) => ({
  tier: 'lite' as const,
  fallbackOccurred: false,
  inputTokens: 100,
  cachedTokens: 25,
  outputTokens: 50,
  reasoningTokens: 0,
  latencyMs: 200,
  ...over,
});

/** Best-effort cleanup; the test process keeps handles open until the next
 *  `close()` so we retry the rm a few times to dodge Windows file locks. */
async function cleanup(dir: string, stores: Array<Awaited<ReturnType<typeof openFinOpsStore>>>) {
  for (const s of stores) {
    try {
      s?.close();
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
  console.warn(`[finops-tracker.test] temp dir cleanup skipped (locked): ${dir}`);
}

describe('FinOpsTracker cumulative persistence (only totalRequests + fallbackCount survive restart)', () => {
  it('bumpRequestCount writes totalRequests always and fallbackCount only on fallback', async () => {
    let Database: typeof import('bun:sqlite').Database;
    try {
      Database = (await import('bun:sqlite')).Database;
    } catch {
      return; // node runtime without bun:sqlite — nothing to assert
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-finops-'));
    const stores: Array<Awaited<ReturnType<typeof openFinOpsStore>>> = [];
    try {
      const store = await openFinOpsStore(dir);
      if (!store) return;
      stores.push(store);

      const tracker = new FinOpsTracker(store);
      tracker.hydrate();
      tracker.record(recordArgs({ tier: 'lite' }));
      tracker.record(recordArgs({ tier: 'plus', fallbackOccurred: true }));
      tracker.record(recordArgs({ tier: 'pro' }));

      // Read the raw row set out-of-band. We expect EXACTLY two rows in
      // finops_totals: totalRequests=3, fallbackCount=1. The other
      // (process-local) fields are intentionally not persisted.
      const db = new Database(path.join(dir, 'traces.db'));
      const rows = db.query('SELECT key, value FROM finops_totals').all() as { key: string; value: number }[];
      assert.equal(rows.length, 2, 'only totalRequests + fallbackCount are persisted');
      const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
      assert.equal(byKey['totalRequests'], 3, 'three records → totalRequests=3');
      assert.equal(byKey['fallbackCount'], 1, 'one fallbackOccurred');

      // finops_meta has since + lastWriteTs
      const meta = db.query("SELECT key, value FROM finops_meta").all() as { key: string; value: string }[];
      const metaByKey = Object.fromEntries(meta.map(r => [r.key, r.value]));
      assert.ok(metaByKey['lastWriteTs'], 'lastWriteTs was written');
      assert.ok(metaByKey['since'], 'since was set at construction time');
      db.close();
    } finally {
      await cleanup(dir, stores);
    }
  });

  it('totalRequests + fallbackCount survive a tracker restart; process-local fields reset to zero', async () => {
    let Database: typeof import('bun:sqlite').Database;
    try {
      Database = (await import('bun:sqlite')).Database;
    } catch {
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-finops-'));
    const stores: Array<Awaited<ReturnType<typeof openFinOpsStore>>> = [];
    try {
      // --- "first process lifetime" ---
      const store1 = await openFinOpsStore(dir);
      assert.ok(store1, 'store1 must open in bun runtime');
      stores.push(store1);
      const t1 = new FinOpsTracker(store1);
      t1.hydrate();
      t1.record(recordArgs({ tier: 'lite', latencyMs: 50, inputTokens: 10 }));
      t1.record(recordArgs({ tier: 'plus', latencyMs: 150, inputTokens: 20, fallbackOccurred: true }));
      t1.record(recordArgs({ tier: 'pro', inputTokens: 30 }));
      const beforeStats = t1.getStats();
      assert.equal(beforeStats.totalRequests, 3);
      assert.equal(beforeStats.fallbackCount, 1);
      // Process-local fields are populated for the live process.
      assert.equal(beforeStats.tokens.totalInputTokens, 60);

      // Persist the writes before closing.
      store1.close();

      // --- "second process lifetime" ---
      const store2 = await openFinOpsStore(dir);
      assert.ok(store2);
      stores.push(store2);
      const t2 = new FinOpsTracker(store2);
      t2.hydrate();
      const afterStats = t2.getStats();

      // The two cumulative counters MUST survive restart.
      assert.equal(afterStats.totalRequests, 3, 'totalRequests restored from disk');
      assert.equal(afterStats.fallbackCount, 1, 'fallbackCount restored from disk');
      assert.equal(afterStats.persistence.persistent, true);
      assert.equal(afterStats.persistence.since, beforeStats.persistence.since, 'since preserved across restart');
      assert.ok(afterStats.persistence.lastWriteTs, 'lastWriteTs preserved');

      // Process-local fields intentionally reset to zero on restart.
      assert.equal(afterStats.tokens.totalInputTokens, 0, 'process-local prompt tokens reset');
      assert.equal(afterStats.tokens.totalOutputTokens, 0);
      assert.equal(afterStats.tokens.totalCachedTokens, 0);
      assert.equal(afterStats.tierDistribution.lite.count, 0);
      assert.equal(afterStats.tierDistribution.plus.count, 0);
      assert.equal(afterStats.tierDistribution.pro.count, 0);
      assert.equal(afterStats.tierDistribution.ultra.count, 0);
      assert.equal(afterStats.latency.avgMs, 0);
      assert.equal(afterStats.latency.liteAvgMs, 0);

      // A new record after hydration must ADD to the restored counters
      // (not overwrite them) and also start accumulating process-local
      // fields from zero — this is the contract.
      t2.record(recordArgs({ tier: 'lite', latencyMs: 25, inputTokens: 5 }));
      assert.equal(t2.getStats().totalRequests, 4, 'cumulative counter advances after restart');
      assert.equal(t2.getStats().fallbackCount, 1, 'fallbackCount unchanged for non-fallback record');
      assert.equal(t2.getStats().tokens.totalInputTokens, 5, 'process-local starts fresh');
    } finally {
      await cleanup(dir, stores);
    }
  });

  it('reset() clears both on-disk counters in one transaction (no zombie count)', async () => {
    let Database: typeof import('bun:sqlite').Database;
    try {
      Database = (await import('bun:sqlite')).Database;
    } catch {
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-finops-'));
    const stores: Array<Awaited<ReturnType<typeof openFinOpsStore>>> = [];
    try {
      const store = await openFinOpsStore(dir);
      assert.ok(store);
      stores.push(store);
      const tracker = new FinOpsTracker(store);
      tracker.hydrate();
      tracker.record(recordArgs());
      tracker.record(recordArgs({ fallbackOccurred: true }));
      assert.equal(tracker.getStats().totalRequests, 2);
      assert.equal(tracker.getStats().fallbackCount, 1);

      tracker.reset();
      assert.equal(tracker.getStats().totalRequests, 0, 'memory cleared');
      assert.equal(tracker.getStats().fallbackCount, 0, 'memory cleared');
      assert.equal(tracker.getStats().persistence.lastWriteTs, null, 'lastWriteTs cleared');
      const newSince = tracker.getStats().persistence.since;
      assert.ok(newSince > 0, 'since bumped to a fresh timestamp');

      // Confirm the on-disk rows are gone (no zombie count after restart).
      const db = new Database(path.join(dir, 'traces.db'));
      const rows = db.query('SELECT key, value FROM finops_totals').all() as { key: string; value: number }[];
      assert.equal(rows.length, 0, 'finops_totals must be empty after reset');
      const meta = db.query("SELECT value FROM finops_meta WHERE key = 'lastWriteTs'").all() as { value: string }[];
      assert.equal(meta.length, 0, 'lastWriteTs row must be removed after reset');
      const sinceRow = db.query("SELECT value FROM finops_meta WHERE key = 'since'").all() as { value: string }[];
      assert.equal(sinceRow.length, 1, 'since row must remain (updated to reset time)');
      db.close();

      // Boot a fresh tracker against the same file: counters must be zero,
      // not the pre-reset total. This is the regression we are guarding
      // against — "reset only cleared memory, disk rows revived on restart".
      store.close();
      const store2 = await openFinOpsStore(dir);
      stores.push(store2);
      const t2 = new FinOpsTracker(store2);
      t2.hydrate();
      assert.equal(t2.getStats().totalRequests, 0, 'no zombie count after reset + restart');
      assert.equal(t2.getStats().fallbackCount, 0);
      assert.equal(t2.getStats().persistence.since, newSince, 'since preserved across reset/restart');
    } finally {
      await cleanup(dir, stores);
    }
  });

  it('record() is fail-open when the store throws (memory state still advances)', () => {
    // Hand-rolled broken store: every method throws. The real `openFinOpsStore`
    // wraps its own writes in try/catch, but the tracker itself must also be
    // robust to a misbehaving store implementation — `record()` must never
    // propagate a write failure into the inference hot path.
    const broken = {
      hydrate: () => ({ totals: {}, meta: { since: 0, lastWriteTs: null } }),
      bumpRequestCount: () => {
        throw new Error('simulated write failure');
      },
      reset: () => {
        throw new Error('simulated reset failure');
      },
      close: () => {},
    };
    const tracker = new FinOpsTracker(broken as any);
    tracker.hydrate();
    assert.doesNotThrow(() => tracker.record(recordArgs()), 'record() must not throw on store failure');
    assert.equal(tracker.getStats().totalRequests, 1, 'memory state advances regardless of store failure');
    assert.equal(tracker.getStats().persistence.persistent, true, 'tracker still considers itself persisted after successful hydrate');
    assert.doesNotThrow(() => tracker.reset(), 'reset() must not throw on store failure');
    assert.equal(tracker.getStats().totalRequests, 0, 'reset() cleared memory even when store threw');
  });

  it('tracker without a store stays in legacy memory-only mode', () => {
    const tracker = new FinOpsTracker(null);
    tracker.record(recordArgs());
    tracker.record(recordArgs({ fallbackOccurred: true }));
    const stats = tracker.getStats();
    assert.equal(stats.totalRequests, 2);
    assert.equal(stats.fallbackCount, 1);
    assert.equal(stats.persistence.persistent, false, 'no store → not persistent');
    assert.equal(stats.persistence.since, 0);
    assert.equal(stats.persistence.lastWriteTs, null);
    tracker.reset();
    assert.equal(tracker.getStats().totalRequests, 0, 'legacy reset still works');
  });
});
