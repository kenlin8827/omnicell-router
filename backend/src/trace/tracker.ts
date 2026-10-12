import path from 'node:path';
import { ReasonParams, TierLevel } from '../types/router.js';
import { getOcrHomeDir } from '../cli/paths.js';
import type { TracePersistConfig } from '../config/types.js';
import type { CaptureKeyIdentity } from '../capture/recorder.js';
import { openTraceStore, type TraceStore } from './persist.js';

export interface ExecutionTrace {
  traceId: string;
  sessionId: string;
  turnNumber: number;
  timestamp: number;
  /**
   * Client API-key identity (`config.apiKeys` entry) that authenticated this
   * turn — id + application name only, never the token value. Undefined for
   * master-key access, MITM-tunnel turns, and traces replayed from disk
   * before this field existed.
   */
  apiKey?: CaptureKeyIdentity;
  request: {
    model: string;
    userPromptSummary: string;
    messageCount: number;
    hasSystemPrompt: boolean;
    hasToolsOrSchema: boolean;
    /**
     * Non-sensitive subset of inbound request headers. Three categories:
     *   - userAgent / acceptLanguage: client fingerprint.
     *   - requestId: cross-service correlation id (x-request-id /
     *     x-trace-id / x-correlation-id / request-id / traceparent), lets
     *     console traces be joined with upstream logs / reverse proxies.
     * Authorization / x-api-key / cookies / any other credential-bearing
     * header are intentionally omitted. `undefined` when the inbound wire
     * did not expose headers (e.g. internal calls). Forgiving forward-
     * compat: traces replayed from disk before this field existed
     * deserialize with `clientHeaders === undefined`.
     */
    clientHeaders?: {
      userAgent?: string;
      acceptLanguage?: string;
      requestId?: string;
    };
  };
  routing: {
    layerUsed: 'layer0' | 'layer1' | 'layer2';
    targetTier: TierLevel;
    confidence: number;
    reason: string;
    reasonCode?: string;
    reasonParams?: ReasonParams;
    sessionRatchetApplied: boolean;
    sessionLookupType?: string;
  };
  execution: {
    modelUsed: string;
    provider: string;
    tierUsed: TierLevel;
    latencyMs: number;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    failoverOccurred?: boolean;
    failoverAttempts?: number;
    failoverPath?: string[];
    inplaceRetries?: number;
  };
  finops: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    /**
     * Actual USD cost of this request, computed at request time with the
     * catalog pricing that was current then. The only cost figure stored —
     * derived comparisons (baseline/savings) are intentionally not recorded.
     */
    costUsd: number;
  };
}

/** Per-API-key token usage row (also used for the anonymous bucket). */
export interface KeyUsageRow {
  id: string;
  name: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMsSum: number;
  /** Sum of the per-request actual costs (USD) — data-only, not rendered yet. */
  costUsd: number;
}

export interface UsageStatsSummary {
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    avgLatencyMs: number;
    costUsd: number;
  };
  keys: KeyUsageRow[];
}

export class TraceTracker {
  private traces = new Map<string, ExecutionTrace>(); // traceId -> trace
  private sessionTraceIndex = new Map<string, string[]>(); // sessionId -> traceId[]
  private traceOrder: string[] = []; // Ring buffer order for LRU eviction
  private readonly maxTraces: number;
  // Durable layer (optional): write-through SQLite + boot replay + aged sweep.
  private store?: TraceStore;
  private storeWanted = false;
  private retentionDays = 7;
  private maxTotalBytes = 100 * 1024 * 1024;
  private pending: ExecutionTrace[] = []; // recorded before the store finished opening
  private sweepTimer?: ReturnType<typeof setInterval>;
  /** Resolves once the persistent store is open and boot-replayed (or skipped). */
  readonly whenReady: Promise<void>;

  constructor(maxTraces = 5000, persist?: TracePersistConfig) {
    this.maxTraces = maxTraces;
    this.storeWanted = Boolean(persist?.enabled);
    this.retentionDays = persist?.retentionDays ?? 7;
    this.maxTotalBytes = (persist?.maxTotalMB ?? 100) * 1024 * 1024;
    this.whenReady = this.initPersist(persist).catch(() => {});
  }

  private async initPersist(persist?: TracePersistConfig): Promise<void> {
    if (!this.storeWanted) return;
    const dir = persist?.dir || path.join(getOcrHomeDir(), 'traces');
    const store = await openTraceStore(dir);
    if (!store) return; // runtime lacks bun:sqlite — memory-only mode
    this.store = store;
    // Boot replay: newest-last so the LRU ring keeps the most recent window.
    for (const t of store.loadRecent(this.maxTraces)) this.insertMemory(t);
    for (const t of this.pending.splice(0)) store.insert(t);
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), 3_600_000);
    this.sweepTimer.unref?.();
  }

  /**
   * Record a new request trajectory entry (write-through to the durable
   * store when persistence is enabled).
   */
  public record(trace: ExecutionTrace): void {
    this.insertMemory(trace);
    if (this.store) {
      this.store.insert(trace);
    } else if (this.storeWanted) {
      // Store still opening — buffer and flush on ready (bounded like the ring).
      this.pending.push(trace);
      if (this.pending.length > this.maxTraces) this.pending.shift();
    }
  }

  /** Memory-only insert: LRU ring eviction + indexes. Used for boot replay. */
  private insertMemory(trace: ExecutionTrace): void {
    // 1. If buffer reached max capacity, evict oldest
    while (this.traceOrder.length >= this.maxTraces) {
      const oldestId = this.traceOrder.shift();
      if (!oldestId) break;
      const oldestTrace = this.traces.get(oldestId);
      if (oldestTrace) {
        const list = this.sessionTraceIndex.get(oldestTrace.sessionId);
        if (list) {
          const idx = list.indexOf(oldestId);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) this.sessionTraceIndex.delete(oldestTrace.sessionId);
        }
        this.traces.delete(oldestId);
      }
    }

    // 2. Insert new trace
    this.traces.set(trace.traceId, trace);
    this.traceOrder.push(trace.traceId);

    // 3. Index by sessionId
    const sessionList = this.sessionTraceIndex.get(trace.sessionId) || [];
    sessionList.push(trace.traceId);
    this.sessionTraceIndex.set(trace.sessionId, sessionList);
  }

  /**
   * Get all traces belonging to a specific session in chronological order
   */
  public getTracesBySession(sessionId: string): ExecutionTrace[] {
    const traceIds = this.sessionTraceIndex.get(sessionId) || [];
    return traceIds
      .map(id => this.traces.get(id))
      .filter((t): t is ExecutionTrace => Boolean(t));
  }

  /**
   * Get a single trace by its trace ID
   */
  public getTrace(traceId: string): ExecutionTrace | undefined {
    return this.traces.get(traceId);
  }

  /**
   * Query recent traces with optional session filtering, time-window filter
   * (inclusive lower bound `sinceTs` on `trace.timestamp`, epoch ms) and
   * pagination. The time-window filter is applied AFTER the index-based
   * candidate selection but BEFORE pagination so `total` reflects the
   * window size and the page slice stays consistent. When `sinceTs` is
   * undefined (the default) the whole in-memory ring is returned.
   */
  public getRecentTraces(options?: {
    sessionId?: string;
    limit?: number;
    offset?: number;
    sinceTs?: number;
  }): { total: number; data: ExecutionTrace[] } {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const sinceTs = options?.sinceTs;

    let traceIds: string[];
    if (options?.sessionId) {
      traceIds = [...(this.sessionTraceIndex.get(options.sessionId) || [])].reverse();
    } else {
      // Reverse order (most recent first)
      traceIds = [...this.traceOrder].reverse();
    }

    // Window filter: apply BEFORE pagination so `total` matches the
    // filtered set. `t.timestamp` is set by the orchestrator at record time.
    if (typeof sinceTs === 'number') {
      traceIds = traceIds.filter(id => {
        const t = this.traces.get(id);
        return t ? t.timestamp >= sinceTs : false;
      });
    }

    const total = traceIds.length;
    const pagedIds = traceIds.slice(offset, offset + limit);
    const data = pagedIds
      .map(id => this.traces.get(id))
      .filter((t): t is ExecutionTrace => Boolean(t));

    return { total, data };
  }

  /**
   * Aggregate raw token usage over the in-memory trace ring buffer, grouped
   * by client API key (id + name; turns without key attribution share the
   * anonymous bucket). `sinceTs` (epoch ms, inclusive lower bound on
   * `trace.timestamp`) narrows the window; undefined covers the whole ring.
   * Sums of recorded per-request values only — no derived metrics.
   */
  public getUsageStats(options?: { sinceTs?: number }): UsageStatsSummary {
    const sinceTs = typeof options?.sinceTs === 'number' ? options.sinceTs : undefined;
    const byKey = new Map<string, KeyUsageRow>();
    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let latencyMsSum = 0;
    let costUsdSum = 0;

    for (const t of this.traces.values()) {
      if (sinceTs !== undefined && t.timestamp < sinceTs) continue;
      const f = t.finops;
      requests++;
      inputTokens += f.inputTokens;
      outputTokens += f.outputTokens;
      cachedTokens += f.cachedTokens;
      latencyMsSum += t.execution.latencyMs;
      costUsdSum += f.costUsd;

      const keyId = t.apiKey?.id ?? '';
      let row = byKey.get(keyId);
      if (!row) {
        row = {
          id: keyId,
          name: t.apiKey?.name ?? 'Anonymous',
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          latencyMsSum: 0,
          costUsd: 0,
        };
        byKey.set(keyId, row);
      }
      row.requests++;
      row.inputTokens += f.inputTokens;
      row.outputTokens += f.outputTokens;
      row.cachedTokens += f.cachedTokens;
      row.latencyMsSum += t.execution.latencyMs;
      row.costUsd += f.costUsd;
    }

    return {
      totals: {
        requests,
        inputTokens,
        outputTokens,
        cachedTokens,
        avgLatencyMs: requests > 0 ? Math.round(latencyMsSum / requests) : 0,
        costUsd: Number(costUsdSum.toFixed(6)),
      },
      keys: [...byKey.values()].sort((a, b) => b.inputTokens - a.inputTokens),
    };
  }

  /**
   * Per-session aggregates for the console's session table, computed in one
   * pass over the session's chronological traces: request count, model
   * switches (adjacent modelUsed changes), cumulative token consumption
   * (input / output / cached) and cumulative recorded cost.
   */
  public getSessionAggregates(sessionId: string): {
    traceCount: number;
    switchCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  } {
    const traces = this.getTracesBySession(sessionId);
    let switchCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let costUsd = 0;
    let prevModel: string | null = null;
    for (const t of traces) {
      if (prevModel !== null && t.execution.modelUsed !== prevModel) switchCount++;
      prevModel = t.execution.modelUsed;
      inputTokens += t.finops.inputTokens;
      outputTokens += t.finops.outputTokens;
      cachedTokens += t.finops.cachedTokens;
      costUsd += t.finops.costUsd;
    }
    return {
      traceCount: traces.length,
      switchCount,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: Number(costUsd.toFixed(6)),
    };
  }

  /**
   * Remove traces for a specific session (memory + durable store)
   */
  public deleteBySession(sessionId: string): void {
    const traceIds = this.sessionTraceIndex.get(sessionId) || [];
    for (const id of traceIds) {
      this.traces.delete(id);
      const idx = this.traceOrder.indexOf(id);
      if (idx !== -1) this.traceOrder.splice(idx, 1);
    }
    this.sessionTraceIndex.delete(sessionId);
    this.store?.deleteBySession(sessionId);
  }

  /** Distinct session ids known to the tracker (live + boot-replayed). */
  public getSessionIds(): string[] {
    return [...this.sessionTraceIndex.keys()];
  }

  public isPersisted(): boolean {
    return Boolean(this.store);
  }

  /** Aged retention sweep: delete-by-age first, then oldest-first size trim. */
  private sweep(): void {
    this.store?.sweep(this.retentionDays * 86_400_000, this.maxTotalBytes);
  }

  public close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.store?.close();
    this.store = undefined;
  }

  /**
   * Clear all traces in memory
   */
  public clear(): void {
    this.traces.clear();
    this.sessionTraceIndex.clear();
    this.traceOrder = [];
  }

  /**
   * Clear every trace — in memory AND the durable store (console
   * "clear sessions"). Returns what was removed so the UI can confirm.
   */
  public clearAll(): { sessions: number; traces: number } {
    const stats = { sessions: this.sessionTraceIndex.size, traces: this.traces.size };
    this.clear();
    this.store?.clearAll();
    return stats;
  }
}
