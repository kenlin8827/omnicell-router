import { TierLevel } from '../types/router.js';
import type { FinOpsStore } from '../trace/persist.js';

export interface FinOpsStats {
  totalRequests: number;
  fallbackCount: number;
  tierDistribution: {
    lite: { count: number; pct: number };
    plus: { count: number; pct: number };
    pro: { count: number; pct: number };
    ultra: { count: number; pct: number };
  };
  tokens: {
    totalInputTokens: number;
    totalCachedTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
  };
  latency: {
    avgMs: number;
    liteAvgMs: number;
    plusAvgMs: number;
    proAvgMs: number;
    ultraAvgMs: number;
  };
  /**
   * Persistence telemetry for the two cumulative counters that survive
   * restart (`totalRequests`, `fallbackCount`). `persistent=false` means
   * the cumulative numbers in this snapshot live only in the current
   * process — a restart will reset them to zero. `since` is the epoch
   * ms when the current cumulative window started (updates on every
   * reset and on the first record after construction). `lastWriteTs` is
   * the wall-clock ts of the last successful persist write; `null` until
   * the first record. The console uses this trio to surface the
   * "accumulated since X" banner and to detect silent write failure
   * (`now - lastWriteTs > N`).
   *
   * All OTHER fields on this snapshot (tier distribution, tokens,
   * latency) are process-local and reset to zero on restart. They are
   * the "current session" view; the persistent cumulative window is
   * represented by `totalRequests` + `fallbackCount` only.
   */
  persistence: {
    persistent: boolean;
    since: number;
    lastWriteTs: number | null;
  };
}

/**
 * Keys persisted in `finops_totals`. Only the two cumulative counters
 * that must survive restart — every other FinOps field is process-local.
 */
const TOTAL_KEY_TOTAL_REQUESTS = 'totalRequests';
const TOTAL_KEY_FALLBACK_COUNT = 'fallbackCount';

export class FinOpsTracker {
  // Cumulative counters that survive process restart.
  private totalRequests = 0;
  private fallbackCount = 0;

  // Process-local accumulators. Reset to zero on restart by design — the
  // console treats them as "since process start" and the persistent
  // cumulative window is the (totalRequests, fallbackCount) pair only.
  private tierCounts: Record<TierLevel, number> = {
    lite: 0,
    plus: 0,
    pro: 0,
    ultra: 0,
  };

  private tierLatencySum: Record<TierLevel, number> = {
    lite: 0,
    plus: 0,
    pro: 0,
    ultra: 0,
  };

  private inputTokens = 0;
  private cachedTokens = 0;
  private outputTokens = 0;
  private reasoningTokens = 0;

  private readonly store: FinOpsStore | null;
  private persistenceSince = 0;
  private lastWriteTs: number | null = null;
  /** `true` once `hydrate()` has run (or after first record). */
  private persistenceActive = false;

  /**
   * @param store optional durable FinOps store; pass `null`/omit for the
   *   legacy in-memory-only behavior. Call `hydrate()` once after
   *   construction to load the persisted snapshot before the first
   *   `record()`.
   */
  constructor(store: FinOpsStore | null = null) {
    this.store = store;
    this.persistenceSince = store ? Date.now() : 0;
  }

  /**
   * Pull the persisted counters from disk into memory. Must be called
   * before the first `record()` if a store is attached. Safe to call
   * with a null store (no-op).
   */
  public hydrate(): void {
    if (!this.store) {
      this.persistenceActive = false;
      return;
    }
    let snapshot: ReturnType<FinOpsStore['hydrate']>;
    try {
      snapshot = this.store.hydrate();
    } catch {
      snapshot = { totals: {}, meta: { since: 0, lastWriteTs: null } };
    }
    // Only the two cumulative counters are read back; the rest of the
    // snapshot is intentionally not persisted (process-local by design).
    this.totalRequests = Number(snapshot.totals[TOTAL_KEY_TOTAL_REQUESTS] ?? 0) || 0;
    this.fallbackCount = Number(snapshot.totals[TOTAL_KEY_FALLBACK_COUNT] ?? 0) || 0;
    // `since` from store wins (tracks the most recent reset or first-record
    // mark). Fall back to construction time when the store has no record.
    this.persistenceSince = snapshot.meta.since || this.persistenceSince;
    this.lastWriteTs = snapshot.meta.lastWriteTs;
    this.persistenceActive = true;
  }

  public record(params: {
    tier: TierLevel;
    fallbackOccurred: boolean;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    latencyMs: number;
  }): void {
    this.totalRequests++;
    if (params.fallbackOccurred) {
      this.fallbackCount++;
    }

    this.tierCounts[params.tier]++;
    this.tierLatencySum[params.tier] += params.latencyMs;

    this.inputTokens += params.inputTokens;
    this.cachedTokens += params.cachedTokens;
    this.outputTokens += params.outputTokens;
    this.reasoningTokens += params.reasoningTokens || 0;

    // Persistence: persist only the two cumulative counters. The real
    // `openFinOpsStore` wraps its own writes in try/catch (fail-open),
    // but we add a second layer of defense here in case a custom store
    // implementation misbehaves — `record()` is on the inference hot
    // path and a thrown error here would break every request.
    if (this.store) {
      const now = Date.now();
      try {
        this.store.bumpRequestCount(params.fallbackOccurred, now);
      } catch {
        // swallow — memory state is the source of truth, a failed
        // persist write just means the next restart will undercount
        // by however many requests slipped through.
      }
      this.lastWriteTs = now;
      this.persistenceActive = true;
    }
  }

  public getStats(): FinOpsStats {
    const total = this.totalRequests || 1;
    const liteCount = this.tierCounts.lite;
    const plusCount = this.tierCounts.plus;
    const proCount = this.tierCounts.pro;
    const ultraCount = this.tierCounts.ultra;

    const totalLatency =
      this.tierLatencySum.lite + this.tierLatencySum.plus + this.tierLatencySum.pro + this.tierLatencySum.ultra;

    return {
      totalRequests: this.totalRequests,
      fallbackCount: this.fallbackCount,
      tierDistribution: {
        lite: {
          count: liteCount,
          pct: Number(((liteCount / total) * 100).toFixed(2)),
        },
        plus: {
          count: plusCount,
          pct: Number(((plusCount / total) * 100).toFixed(2)),
        },
        pro: {
          count: proCount,
          pct: Number(((proCount / total) * 100).toFixed(2)),
        },
        ultra: {
          count: ultraCount,
          pct: Number(((ultraCount / total) * 100).toFixed(2)),
        },
      },
      tokens: {
        totalInputTokens: this.inputTokens,
        totalCachedTokens: this.cachedTokens,
        totalOutputTokens: this.outputTokens,
        totalReasoningTokens: this.reasoningTokens,
      },
      latency: {
        avgMs: this.totalRequests > 0 ? Math.round(totalLatency / this.totalRequests) : 0,
        liteAvgMs: liteCount > 0 ? Math.round(this.tierLatencySum.lite / liteCount) : 0,
        plusAvgMs: plusCount > 0 ? Math.round(this.tierLatencySum.plus / plusCount) : 0,
        proAvgMs: proCount > 0 ? Math.round(this.tierLatencySum.pro / proCount) : 0,
        ultraAvgMs: ultraCount > 0 ? Math.round(this.tierLatencySum.ultra / ultraCount) : 0,
      },
      persistence: {
        persistent: this.persistenceActive,
        since: this.persistenceSince,
        lastWriteTs: this.lastWriteTs,
      },
    };
  }

  /**
   * Zero every counter and (when a store is attached) wipe the on-disk
   * totals table in the same transaction. `since` is bumped to now and
   * `lastWriteTs` cleared — the next record after reset will show
   * `since === lastWriteTs`.
   */
  public reset(): void {
    this.totalRequests = 0;
    this.fallbackCount = 0;
    this.tierCounts = { lite: 0, plus: 0, pro: 0, ultra: 0 };
    this.tierLatencySum = { lite: 0, plus: 0, pro: 0, ultra: 0 };
    this.inputTokens = 0;
    this.cachedTokens = 0;
    this.outputTokens = 0;
    this.reasoningTokens = 0;
    if (this.store) {
      this.persistenceSince = Date.now();
      this.lastWriteTs = null;
      try {
        this.store.reset(this.persistenceSince);
      } catch {
        // swallow — memory state already cleared, a failed disk wipe
        // just means the on-disk values will be restored on next boot.
      }
    }
  }
}
