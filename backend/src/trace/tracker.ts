import path from 'node:path';
import { ReasoningEffort, EffortSource, ReasonParams, TierLevel } from '../types/router.js';
import { getEnvPaths } from '../config/env.js';
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
    layerUsed: 'layer0' | 'entry' | 'layer2';
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
    /**
     * Display-safe sha256 prefix of the credential that SERVED this turn
     * (same chain-head degeneracy as the ratelimit credential subject, so a
     * single-credential provider carries attribution too). Quota tracking
     * aggregates per (provider × prefix) on this field. Forgiving
     * forward-compat: traces replayed from disk before this field existed
     * deserialize with `credentialKeyHashPrefix === undefined`.
     */
    credentialKeyHashPrefix?: string;
    tierUsed: TierLevel;
    latencyMs: number;
    /**
     * Time to first token, user-perceived: process start → the committed
     * attempt's first forwarded upstream chunk. Includes routing, queueing,
     * prefill AND any failed attempt that preceded the commit. Undefined for
     * turns that never streamed (buffered execution / relay off) — the
     * console renders '—' rather than inventing a number.
     */
    ttftMs?: number;
    /**
     * Decode window: first forwarded chunk → stream fully drained. The
     * denominator of the console's decode-TPS (output tokens ÷ genMs),
     * matching the industry split where throughput excludes TTFT. Undefined
     * alongside ttftMs for non-streamed turns.
     */
    genMs?: number;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    failoverOccurred?: boolean;
    failoverAttempts?: number;
    failoverPath?: string[];
    inplaceRetries?: number;
    /**
     * Thinking-effort observability (mirrors ExecutionResult):
     * `requestedEffort` = the level the client sent (undefined = the field
     * was omitted — distinct from the real 'none' value); `actualEffort` =
     * what the gateway actually served after effortMap translation +
     * capability clamp; `reasoningDegraded` = served-rank < asked-rank.
     * Forgiving forward-compat: traces replayed from disk before these
     * fields existed deserialize with all three undefined.
     */
    requestedEffort?: ReasoningEffort;
    actualEffort?: ReasoningEffort;
    reasoningDegraded?: boolean;
    /**
     * WHO authored the effective ask (ADR-0012): 'client' = the request's
     * own field; 'judge' / 'entry' / 'escalation' / 'default' are gateway
     * decisions injected after the client value was snapshotted. Same
     * forward-compat rule as the siblings: absent on pre-field rows.
     */
    effortSource?: EffortSource;
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

/**
 * Per-pair (provider × served-credential) usage row — the credential-side
 * counterpart of KeyUsageRow. Quota tracking's aggregation base
 * (GROUP BY provider + keyHashPrefix); turns without credential
 * attribution are skipped, never pooled into an anonymous bucket.
 */
export interface CredentialPairUsageRow {
  provider: string;
  keyHashPrefix: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
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
  /**
   * Output tokens summed over STREAMED turns only (genMs present) — the
   * numerator paired with genMsSum for the decode-TPS aggregate.
   */
  genOutputTokens: number;
  /** Summed decode window (ms) over the same streamed turns; 0 = no data. */
  genMsSum: number;
}

export interface UsageStatsSummary {
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    avgLatencyMs: number;
    costUsd: number;
    /** Same streamed-turns-only pairing as KeyUsageRow, window-wide. */
    genOutputTokens: number;
    genMsSum: number;
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
    const dir = persist?.dir || getEnvPaths().tracesDir;
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
   * Query recent traces with optional session filtering, model filtering
   * (exact match on `execution.modelUsed`, the resolved physical model id),
   * time-window filter (inclusive lower bound `sinceTs` on `trace.timestamp`,
   * epoch ms) and pagination. The window/model filters are applied AFTER the
   * index-based candidate selection but BEFORE pagination so `total` reflects
   * the filtered size and the page slice stays consistent. When `sinceTs` is
   * undefined (the default) the whole in-memory ring is returned.
   */
  public getRecentTraces(options?: {
    sessionId?: string;
    modelId?: string;
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

    // Model filter: same placement as the window filter — `total` and the
    // page slice must describe the model-scoped population.
    if (options?.modelId) {
      const modelId = options.modelId;
      traceIds = traceIds.filter(id => {
        const t = this.traces.get(id);
        return t ? t.execution.modelUsed === modelId : false;
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
    let genOutputTokens = 0;
    let genMsSum = 0;

    for (const t of this.traces.values()) {
      if (sinceTs !== undefined && t.timestamp < sinceTs) continue;
      const f = t.finops;
      requests++;
      inputTokens += f.inputTokens;
      outputTokens += f.outputTokens;
      cachedTokens += f.cachedTokens;
      latencyMsSum += t.execution.latencyMs;
      costUsdSum += f.costUsd;
      // Decode-TPS pairing: accumulate BOTH sides only when the turn streamed,
      // so the quotient never mixes a streamed numerator into a full-window
      // denominator (that would be the effective-rate confusion again).
      if (typeof t.execution.genMs === 'number') {
        genOutputTokens += f.outputTokens;
        genMsSum += t.execution.genMs;
      }

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
          genOutputTokens: 0,
          genMsSum: 0,
        };
        byKey.set(keyId, row);
      }
      row.requests++;
      row.inputTokens += f.inputTokens;
      row.outputTokens += f.outputTokens;
      row.cachedTokens += f.cachedTokens;
      row.latencyMsSum += t.execution.latencyMs;
      row.costUsd += f.costUsd;
      if (typeof t.execution.genMs === 'number') {
        row.genOutputTokens += f.outputTokens;
        row.genMsSum += t.execution.genMs;
      }
    }

    return {
      totals: {
        requests,
        inputTokens,
        outputTokens,
        cachedTokens,
        avgLatencyMs: requests > 0 ? Math.round(latencyMsSum / requests) : 0,
        costUsd: Number(costUsdSum.toFixed(6)),
        genOutputTokens,
        genMsSum,
      },
      keys: [...byKey.values()].sort((a, b) => b.inputTokens - a.inputTokens),
    };
  }

  /**
   * Aggregate raw token usage over the in-memory trace ring buffer grouped by
   * the SERVED credential pair (provider × keyHashPrefix) — the quota
   * tracking foundation. Turns without credential attribution (chain-less
   * providers) are skipped: the per-pair view only
   * speaks for rows it can actually name. `sinceTs` narrows the window the
   * same way as getUsageStats.
   */
  public getCredentialPairUsageStats(options?: { sinceTs?: number }): CredentialPairUsageRow[] {
    const sinceTs = typeof options?.sinceTs === 'number' ? options.sinceTs : undefined;
    const byPair = new Map<string, CredentialPairUsageRow>();
    for (const t of this.traces.values()) {
      if (sinceTs !== undefined && t.timestamp < sinceTs) continue;
      const prefix = t.execution.credentialKeyHashPrefix;
      if (!prefix) continue;
      const id = `${t.execution.provider}#${prefix}`;
      let row = byPair.get(id);
      if (!row) {
        row = {
          provider: t.execution.provider,
          keyHashPrefix: prefix,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
        };
        byPair.set(id, row);
      }
      row.requests++;
      row.inputTokens += t.finops.inputTokens;
      row.outputTokens += t.finops.outputTokens;
      row.cachedTokens += t.finops.cachedTokens;
      row.costUsd = Number((row.costUsd + t.finops.costUsd).toFixed(6));
    }
    return [...byPair.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.keyHashPrefix.localeCompare(b.keyHashPrefix)
    );
  }

  /**
   * Per-session aggregates for the console's session table, computed in one
   * pass over the session's chronological traces: request count, model
   * switches (adjacent modelUsed changes), cumulative token consumption
   * (input / output / cached), cumulative recorded cost, the summed
   * end-to-end latency, and the decode-TPS pairing (genOutputTokens over
   * genMsSum) accumulated ONLY over streamed traces — a session mixing
   * streamed and buffered turns still yields a pure decode rate, never a
   * blended one.
   */
  public getSessionAggregates(sessionId: string): {
    traceCount: number;
    switchCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
    totalLatencyMs: number;
    genOutputTokens: number;
    genMsSum: number;
    /**
     * Latest turn's thinking-effort snapshot (with ADR-0012 provenance),
     * lifted from the chronologically last trace. Display-only: effort
     * floats per turn and is NEVER a session-level lock — the console shows
     * it as a tooltip sample, worded as "last turn". All four absent when
     * the session has no traces or the last trace predates the fields.
     */
    lastRequestedEffort?: ReasoningEffort;
    lastActualEffort?: ReasoningEffort;
    lastEffortSource?: EffortSource;
    lastReasoningDegraded?: boolean;
  } {
    const traces = this.getTracesBySession(sessionId);
    let switchCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let costUsd = 0;
    let totalLatencyMs = 0;
    let genOutputTokens = 0;
    let genMsSum = 0;
    let prevModel: string | null = null;
    for (const t of traces) {
      if (prevModel !== null && t.execution.modelUsed !== prevModel) switchCount++;
      prevModel = t.execution.modelUsed;
      inputTokens += t.finops.inputTokens;
      outputTokens += t.finops.outputTokens;
      cachedTokens += t.finops.cachedTokens;
      costUsd += t.finops.costUsd;
      totalLatencyMs += t.execution.latencyMs;
      if (typeof t.execution.genMs === 'number') {
        genOutputTokens += t.finops.outputTokens;
        genMsSum += t.execution.genMs;
      }
    }
    const last = traces[traces.length - 1];
    return {
      traceCount: traces.length,
      switchCount,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: Number(costUsd.toFixed(6)),
      totalLatencyMs,
      genOutputTokens,
      genMsSum,
      lastRequestedEffort: last?.execution.requestedEffort,
      lastActualEffort: last?.execution.actualEffort,
      lastEffortSource: last?.execution.effortSource,
      lastReasoningDegraded: last?.execution.reasoningDegraded,
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
