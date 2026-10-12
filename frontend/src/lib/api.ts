// Mirrors backend FinOpsStats (backend/src/metrics/finops-tracker.ts getStats)
export interface GatewayMetrics {
  totalRequests: number;
  fallbackCount: number;
  tierDistribution: {
    lite: { count: number; pct: number };
    plus: { count: number; pct: number };
    pro: { count: number; pct: number };
    ultra: { count: number; pct: number };
  };
  tokens: {
    totalPromptTokens: number;
    totalCachedPromptTokens: number;
    totalCompletionTokens: number;
    totalReasoningTokens: number;
  };
  economics: {
    actualCostUsd: number;
    baselineCostUsd: number;
    totalSavingsUsd: number;
    savingsPct: number;
  };
  latency: {
    avgMs: number;
    liteAvgMs: number;
    plusAvgMs: number;
    proAvgMs: number;
    ultraAvgMs: number;
  };
}

export interface ClientStatus {
  name: string;
  displayName: string;
  configPath: string;
  exists: boolean;
  hooked: boolean;
  targetProvider: string;
  backupExists: boolean;
  /** Extra concrete models exposed in the client's model switcher (opencode) */
  extraModels?: string[];
  /** This client's model slots; value undefined = auto (intelligent routing).
   *  Optional: legacy backend responses (pre-modelSlots) omit the field entirely. */
  modelSlots?: { key: string; value?: string; default?: string }[];
}

// Mirrors backend CircuitBreakerSnapshot (backend/src/resilience/types.ts)
export interface BreakerInfo {
  modelId: string;
  provider: string;
  tier?: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  reason?: string;
  category?: string;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  trippedAt?: number;
  cooldownUntil?: number;
  remainingCooldownMs: number;
  currentCooldownMs: number;
  halfOpenProbes: number;
}

// Masked provider entry from /api/admin/status (ProviderConfig with apiKey masked)
export interface MaskedProviderStatus {
  name: string;
  type: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  apiKey: string; // "xxxx••••xxxx", empty string when unset
  rawKeyConfigured: boolean;
  organization?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

// Mirrors backend /api/admin/status payload exactly (backend/src/routes/console.ts handleStatus)
export interface GatewayStatusResponse {
  status: string;
  timestamp: string;
  /** Actual gateway listening port (config.yaml `port`). */
  port: number;
  metrics: GatewayMetrics;
  circuitBreakers: {
    total: number;
    healthy: number;
    tripped: number;
    halfOpen: number;
    breakers: BreakerInfo[];
  };
  clients: ClientStatus[];
  providers: MaskedProviderStatus[];
  registeredModelsCount: number;
  /** Inbound forward-proxy runtime status (backend forward-proxy/status.ts). */
  forwardProxy?: {
    enabled: boolean;
    running: boolean;
    port?: number;
    host?: string;
    startedAt?: number;
    error?: string;
  };
}

/**
 * Structured arguments for a localized routing reason — the optional
 * `reasonParams` the gateway emits beside `reason`. Values arrive ready to be
 * substituted into `{key}` slots; `cached: true` marks a reused decision.
 */
export type ReasonParams = Record<string, string | number | boolean>;

// Mirrors backend ExecutionTrace (backend/src/trace/tracker.ts) returned by /api/admin/traces
export interface TraceRecord {
  traceId: string;
  sessionId: string;
  turnNumber: number;
  timestamp: number;
  /** Client API-key identity (application) that drove this turn, when known. */
  apiKey?: CaptureKeyIdentity;
  request: {
    model: string;
    userPromptSummary: string;
    messageCount: number;
    hasSystemPrompt: boolean;
    hasToolsOrSchema: boolean;
  };
  routing: {
    layerUsed: 'layer0' | 'layer1' | 'layer2';
    targetTier: 'lite' | 'plus' | 'pro' | 'ultra';
    confidence: number;
    reason: string;
    /** Machine-readable reason vocabulary (see frontend/src/lib/reason.ts). Absent on legacy trace rows. */
    reasonCode?: string;
    reasonParams?: ReasonParams;
    sessionRatchetApplied: boolean;
  };
  execution: {
    modelUsed: string;
    provider: string;
    tierUsed: 'lite' | 'plus' | 'pro' | 'ultra';
    latencyMs: number;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    failoverOccurred?: boolean;
    failoverAttempts?: number;
    failoverPath?: string[];
    inplaceRetries?: number;
  };
  finops: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    costUsd: number;
    savedCostUsd: number;
  };
}

// Mirrors backend capture types (backend/src/capture/recorder.ts)

/**
 * Stable identity of a client API key (mirrors backend CaptureKeyIdentity):
 * id + application name only, never the token value.
 */
export interface CaptureKeyIdentity {
  id: string;
  name: string;
}

export interface CaptureStatus {
  enabled: boolean;
  dir: string;
  retentionDays: number;
  maxTotalMB: number;
  maxBodyBytes: number;
  totalBytes: number;
  dateCount: number;
}

export interface CaptureDateRow {
  date: string; // YYYY-MM-DD
  sessions: number;
  bytes: number;
}

export interface CaptureSessionRow {
  file: string;
  sessionId: string;
  bytes: number;
  mtimeMs: number;
  turns: number;
  failed: number;
  lastStatus?: 'ok' | 'error';
  /** First user-message text of the session (backend-extracted, capped) */
  preview?: string;
  /** DISTINCT client API-key identities (applications) behind this archive,
   *  in write order — first element is the display anchor; more than one
   *  entry means the app rotated keys mid-session. */
  apiKeys?: CaptureKeyIdentity[];
}

/** One archive hit for a session id: coordinates only (date dir + file name) */
export interface CaptureSessionMatch {
  date: string;
  file: string;
}

/**
 * HTTP-level observation of the SUCCESSFUL outbound call (mirrors
 * backend UpstreamHttpRecord): URL, status, safe response-header subset,
 * TTFB, total duration, attempt index, wire kind. Absent when no
 * outbound HTTP attempt landed successfully.
 */
export interface UpstreamHttpRecord {
  url: string;
  method: string;
  status: number;
  responseHeaders?: {
    retryAfter?: string;
    requestId?: string;
    contentType?: string;
    ratelimit?: {
      limit?: string;
      remaining?: string;
      reset?: string;
    };
  };
  ttfbMs: number | null;
  durationMs: number;
  attemptIndex: number;
  wireKind: 'openai' | 'anthropic' | 'google' | 'responses' | 'opencode-proxy';
}

export interface CaptureRecord {
  id: string;
  ts: number;
  sessionId: string;
  status: 'ok' | 'error';
  model: string;
  request?: unknown;
  /** Real outbound wire body (provider-translated, upstreamModel substituted). */
  upstreamRequest?: unknown;
  /** HTTP-level capture of the successful outbound call (last-write-wins). */
  upstreamHttp?: UpstreamHttpRecord;
  /** Upstream error payload (status + parsed body) when a candidate call failed */
  upstreamError?: unknown;
  response?: unknown;
  error?: string;
  routing?: {
    tierUsed?: string;
    layerUsed?: string;
    modelUsed?: string;
    provider?: string;
    fallbackOccurred?: boolean;
    failoverPath?: string[];
  };
  usage?: unknown;
  latencyMs?: number;
  truncated?: boolean;
}

/**
 * One HTTP-exchange event (mirrors backend HttpExchangeEvent). The capture
 * pipeline emits 2-4 events per inference turn, all sharing the same
 * `traceId` (OpenTelemetry semantics):
 *   - direction='client',   phase='request'  — the inbound HTTP request
 *   - direction='client',   phase='response' — gateway → client response
 *   - direction='upstream', phase='request'  — gateway → provider request
 *   - direction='upstream', phase='response' — provider → gateway response
 *
 * Each req/resp pair shares one `spanId`. Console readers join the four
 * events by `traceId`.
 */
export interface WireBody {
  /** Non-UTF-8 payloads fall back to hex (mirrors backend WireBody). */
  hex: string;
}

export interface RawWireCapture {
  requestLine: string;
  requestHeaders: Record<string, string>;
  requestBody: string | WireBody;
  responseLine: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string | WireBody;
}

export interface HttpExchangeEvent {
  id: string;
  ts: number;
  eventType: 'http-exchange';
  direction: 'client' | 'upstream';
  phase: 'request' | 'response';
  spanId: string;
  traceId: string;
  sessionId: string;
  model: string;
  status: 'ok' | 'error' | 'pending';
  wire: RawWireCapture;
  routing?: {
    tierUsed?: string;
    layerUsed?: string;
    modelUsed?: string;
    provider?: string;
    fallbackOccurred?: boolean;
    failoverPath?: string[];
  };
  /** Client API-key identity of the owning turn (id + app name, never the token). */
  apiKey?: CaptureKeyIdentity;
  error?: string;
  /** Redacted proxy origin when the upstream call went through a proxy (upstream events only). */
  proxy?: string;
  truncated?: boolean;
}

export interface CaptureTurn {
  traceId: string;
  sessionId: string;
  model: string;
  clientRequest?: HttpExchangeEvent;
  gatewayResponse?: HttpExchangeEvent;
  upstreamRequest?: HttpExchangeEvent;
  upstreamResponse?: HttpExchangeEvent;
  error?: string;
  gatewayLatencyMs?: number;
  upstreamLatencyMs?: number;
}

// Mirrors backend ConversationSession (backend/src/session/session-manager.ts) + traceCount
export interface SessionRecord {
  id: string;
  maxTier: 'lite' | 'plus' | 'pro' | 'ultra';
  pinnedModel: string;
  pinnedProvider: string;
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  historyTiers: string[];
  traceCount: number;
  /** Requests whose model differs from the previous request (chronological).
   *  Optional: absent when the frontend is served by a pre-aggregates backend. */
  switchCount?: number;
  /** Requests with a prompt-cache hit (cachedPromptTokens > 0). Optional as above. */
  cacheHits?: number;
  /** Cumulative saved cost across the session's traces (USD). Optional as above. */
  savedCostUsd?: number;
  /** First user prompt of the session (backend-capped summary). */
  firstUserMessage?: string;
  /** Distinct client API-key identities (applications) seen on this
   *  session's traces, write order — first element is the display anchor. */
  apiKeys?: CaptureKeyIdentity[];
}

// Mirrors backend CacheStatsSummary (backend/src/trace/tracker.ts getCacheStats)
export interface CacheStatsModelRow {
  model: string;
  provider: string;
  requests: number;
  cachedRequests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  costUsd: number;
  savedCostUsd: number;
}

export interface CacheStatsHourBucket {
  hourTs: number;
  requests: number;
  cachedRequests: number;
  promptTokens: number;
  cachedPromptTokens: number;
}

export interface CacheStatsSummary {
  windowTraces: number;
  totalRequests: number;
  cachedRequests: number;
  requestHitRatio: number;
  promptTokens: number;
  cachedPromptTokens: number;
  tokenHitRatio: number;
  costUsd: number;
  savedCostUsd: number;
  models: CacheStatsModelRow[];
  hourly: CacheStatsHourBucket[];
}

// Mirrors backend RoutingCacheStats (backend/src/router/decision-cache.ts)
export interface RoutingCacheStats {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  ttlSeconds: number;
  hits: number;
  misses: number;
  hitRatio: number;
}

export interface CacheStatsResponse {
  status: string;
  stats: CacheStatsSummary;
  routingCache: RoutingCacheStats;
}

export interface TierPoolModel {
  id: string;
  provider: string;
  upstreamModel?: string;
  priority?: number;
  isDefaultInTier: boolean;
  inputPrice?: number;
  outputPrice?: number;
  healthy: boolean;
  weight: number;
}

export interface TierPoolInfo {
  pool: TierPoolModel[];
  excluded: { id: string; reason: string }[];
}

export interface TierPoolsResponse {
  status: string;
  pools: Record<string, TierPoolInfo>;
  /** resolved member lists (post-sanitize) — the routing source of truth */
  members?: Record<string, TierMemberRule[]>;
}

/** tier member rule — mirrors backend config/types.ts TierMemberRule. */
export interface TierMemberRule {
  pattern: string;
  weight?: number;
  /** thinking-level translation (client requested → upstream); '' / missing = passthrough */
  effortMap?: Record<string, string>;
}

/** Dry-run save-check warnings overlap across tiers / orphan rules. */
export interface TierCheckWarning {
  kind: 'overlap' | 'orphan';
  tiers?: string[];
  count?: number;
  sampleIds?: string[];
  tier?: string;
  pattern?: string;
}

export interface ComboMemberView {
  id: string;
  weight: number;
  registered: boolean;
  provider?: string;
  tier?: string;
  inputPrice?: number;
  outputPrice?: number;
  breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | string;
}

export interface ComboView {
  id: string;
  active?: boolean;
  selection: 'priority' | 'weighted' | 'round_robin' | string;
  members: ComboMemberView[];
  note?: string;
}

export interface CombosResponse {
  status: string;
  combos: ComboView[];
}

export interface LogLine {
  raw: string;
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  levelNum?: number;
  time?: number;
  msg?: string;
}

export interface LogsResponse {
  status: string;
  file: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  lines: LogLine[];
}

export type TierName = 'lite' | 'plus' | 'pro' | 'ultra';
export type FlywheelLabelSource = 'human' | 'runtime_fallback' | 'observed_execution' | 'unlabeled';

export interface FlywheelSummary {
  total: number;
  trainable: number;
  synthetic: number;
  humanLabeled: number;
  unlabeled: number;
  trainableByTier: Record<string, number>;
  sourceDistribution: Record<string, number>;
  datasetPath: string;
  labelsPath: string;
  fileBytes: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  tiers: TierName[];
}

export interface FlywheelSample {
  id: string;
  timestamp: string;
  userPrompt: string;
  tokenCount: number;
  featureVector: number[] | null;
  decision: {
    targetTier: TierName;
    confidence: number;
    layerUsed: 'layer0' | 'layer1' | 'layer2';
    reason: string;
    /** Machine-readable reason vocabulary; absent on samples recorded before the field existed. */
    reasonCode?: string;
    reasonParams?: ReasonParams;
  };
  execution: {
    tierUsed: TierName;
    modelUsed: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    costUsd: number;
    latencyMs: number;
    isSynthetic: boolean;
  };
  label: {
    tier: TierName | null;
    source: FlywheelLabelSource;
    confidence: number;
    overridden: boolean;
    isNegativeForLite: boolean;
    updatedAt?: string;
  };
  trainable: boolean;
}

export interface FlywheelTrainingReport {
  trainedSamples: number;
  skipped: Record<string, number>;
  classDistribution: Record<string, number>;
  finalLoss: number;
  accuracy: number;
  epochs: number;
  lr: number;
  l2: number;
  balanced: boolean;
  durationMs: number;
  modelPath: string;
}

export interface FlywheelTrainingState {
  status: 'idle' | 'training' | 'success' | 'failed';
  lastStartedAt: string | null;
  lastTrainedAt: string | null;
  lastDurationMs: number | null;
  lastResult: FlywheelTrainingReport | null;
  error: string | null;
  model: {
    modelPath: string;
    exists: boolean;
    isBaseModel: boolean;
    sampleCount: number;
    lastTrainedAt: string | null;
    featureDimensions: number;
    classes: string[];
    routingConsumesModel: boolean;
    previousModelPath: string;
    previousModelExists: boolean;
  };
}

async function throwFor(res: Response): Promise<never> {
  const err = await res.json().catch(() => ({}));
  throw new Error(err?.error || err?.message || `HTTP ${res.status}`);
}

export const api = {
  async getStatus(): Promise<GatewayStatusResponse> {
    const res = await fetch('/api/admin/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getFlywheelStats(): Promise<FlywheelSummary> {
    const res = await fetch('/api/admin/flywheel/stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getFlywheelSamples(params: {
    limit?: number;
    offset?: number;
    tier?: string;
    source?: string;
    includeSynthetic?: boolean;
    trainableOnly?: boolean;
    search?: string;
  }): Promise<{ rows: FlywheelSample[]; total: number; offset: number; limit: number }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const res = await fetch(`/api/admin/flywheel/samples?${qs.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async setFlywheelLabel(id: string, tier: TierName | null): Promise<void> {
    const res = await fetch(`/api/admin/flywheel/samples/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    });
    if (!res.ok) await throwFor(res);
  },

  async getFlywheelTraining(): Promise<FlywheelTrainingState> {
    const res = await fetch('/api/admin/flywheel/training');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async rollbackFlywheelModel(): Promise<{ ok: boolean; model: FlywheelTrainingState['model'] }> {
    const res = await fetch('/api/admin/flywheel/model/rollback', { method: 'POST' });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  async startFlywheelTraining(options: {
    epochs?: number;
    balanceClasses?: boolean;
    minLabelSource?: string;
  }): Promise<{ started: boolean; state: FlywheelTrainingState; report?: FlywheelTrainingReport }> {
    const res = await fetch('/api/admin/flywheel/training', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  async clearFlywheelLabels(): Promise<{ cleared: number }> {
    const res = await fetch('/api/admin/flywheel/labels', { method: 'DELETE' });
    if (!res.ok) await throwFor(res);
    return res.json();
  },

  async getConfig(): Promise<any> {
    const res = await fetch('/api/admin/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // Unwrap the { status, config } envelope — consumers want the RouterConfig
    // object itself (SettingsPage/AutoPage save it back via saveConfig).
    return body?.config ?? body;
  },

  async saveConfig(config: any): Promise<{ status: string; message: string }> {
    const res = await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async getTierPools(): Promise<TierPoolsResponse> {
    const res = await fetch('/api/admin/tier-pools');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Ephemeral pool preview computed from (unsaved) tier-policy form state. */
  async previewTierPools(tiers: unknown): Promise<TierPoolsResponse> {
    const res = await fetch('/api/admin/tier-pools/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Live (committed) pool snapshot — the registry's m.tier after the last applyTierConfigNow. */
  async getLiveTierPools(): Promise<TierPoolsResponse> {
    const res = await fetch('/api/admin/tier-pools/live');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Dry-run validation of a DRAFT tiers config (non-blocking warnings: overlap / orphan). */
  async checkTiers(tiers: unknown): Promise<{ status: string; warnings: TierCheckWarning[] }> {
    const res = await fetch('/api/admin/tiers/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getCombos(): Promise<CombosResponse> {
    const res = await fetch('/api/admin/combos');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Cache-page aggregate stats. Optional `sinceMs` (inclusive lower bound on
   * `trace.timestamp`, epoch ms) narrows the totals / per-model / hourly
   * series to a window; `undefined` requests the legacy 24-hour view.
   */
  async getCacheStats(sinceMs?: number): Promise<CacheStatsResponse> {
    const qs = sinceMs !== undefined ? `?since=${Math.floor(sinceMs)}` : '';
    const res = await fetch(`/api/admin/cache-stats${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getRawYaml(): Promise<{ status: string; yaml: string }> {
    const res = await fetch('/api/admin/config/raw');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async saveRawYaml(yaml: string): Promise<{ status: string; message: string }> {
    const res = await fetch('/api/admin/config/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async toggleClient(
    client: string,
    action: 'setup' | 'teardown',
    payload?: {
      models?: Record<string, string>;
      apiKey?: string;
      contextWindow?: number;
      extraModels?: string[];
    }
  ): Promise<{ status: string; message: string }> {
    const res = await fetch(`/api/admin/client/${client}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /** All models the gateway can route to: virtual (auto/auto-lite/…) + registered.
   *  Reads the console endpoint — /v1/models requires a key like every surface. */
  async listGatewayModels(): Promise<{ id: string; owned_by: string; tier?: string }[]> {
    const res = await fetch('/api/admin/gateway-models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json?.models || []).map((m: any) => ({
      id: m.id,
      owned_by: m.owned_by || '',
      tier: m.tier || undefined,
    }));
  },

  async resetBreakers(model?: string): Promise<{ status: string; message?: string }> {
    const res = await fetch('/api/admin/health/circuit-breakers/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
    });
    return res.json();
  },

  async tripBreaker(
    model: string,
    options?: { reason?: string; cooldownMs?: number }
  ): Promise<{ status: string; message?: string }> {
    const res = await fetch('/api/admin/health/circuit-breakers/trip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...options }),
    });
    return res.json();
  },

  async restartGateway(): Promise<{ status: string; message?: string }> {
    const res = await fetch('/api/admin/restart', { method: 'POST' });
    return res.json();
  },

  async getSessions(
    limit?: number,
    offset = 0,
    q?: string,
    apiKey?: string
  ): Promise<{ sessions: SessionRecord[]; total: number }> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    if (q) qs.set('q', q);
    if (apiKey) qs.set('apiKey', apiKey);
    const res = await fetch(`/api/admin/sessions?${qs.toString()}`);
    if (!res.ok) return { sessions: [], total: 0 };
    const json = await res.json();
    // /api/admin/sessions responds { object, total, limit?, offset, data }
    return { sessions: json.data || [], total: json.total || 0 };
  },

  /** Full chronological trajectory of one session — source for the switch timeline. */
  async getSessionTraces(sessionId: string): Promise<TraceRecord[]> {
    const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}/traces`);
    if (!res.ok) return [];
    const json = await res.json();
    // /api/admin/sessions/:id/traces responds { object, sessionId, total, data }
    return json.data || [];
  },

  /**
   * Clear ALL sessions (console maintenance surface — browser pages cannot
   * present API keys, so destructive ops go through /api/admin).
   */
  async clearSessions(): Promise<{ status: string; sessionsCleared?: number; tracesCleared?: number; message?: string }> {
    const res = await fetch('/api/admin/sessions/clear', { method: 'POST' });
    return res.json();
  },

  /** Delete one session (live state + traces, including reconstructed history). */
  async deleteSession(sessionId: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    return res.json();
  },

  async getLogs(tail = 500, level?: string, q?: string): Promise<LogsResponse> {
    const qs = new URLSearchParams();
    qs.set('tail', String(tail));
    if (level) qs.set('level', level);
    if (q) qs.set('q', q);
    const res = await fetch(`/api/admin/logs?${qs.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getApiKeys(): Promise<{ status: string; keys: ApiKeyItem[] }> {
    const res = await fetch('/api/admin/api-keys');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async createApiKey(payload: {
    name: string;
    key?: string;
    expiresAt?: string;
    description?: string;
    modelAccess?: ApiKeyModelAccess;
  }): Promise<{ success: boolean; data?: ApiKeyItem; error?: string }> {
    const res = await fetch('/api/admin/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  },

  async updateApiKey(
    id: string,
    updates: Partial<Omit<ApiKeyItem, 'modelAccess'>> & { modelAccess?: ApiKeyModelAccess | null }
  ): Promise<{ success: boolean; data?: ApiKeyItem; error?: string }> {
    const res = await fetch(`/api/admin/api-keys/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    return res.json();
  },

  async deleteApiKey(id: string): Promise<{ success: boolean; error?: string }> {
    const res = await fetch(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
    return res.json();
  },

  // ── Console webAuth ────────────────────────────────────────────────────────

  /** Session probe — App boot gate: does the console need a login? */
  async getAuthSession(): Promise<AuthSessionResponse> {
    const res = await fetch('/api/admin/auth/session');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async login(username: string, password: string): Promise<{ status?: string; success?: boolean; message?: string }> {
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.message || `HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return body;
  },

  async logout(): Promise<{ status: string }> {
    const res = await fetch('/api/admin/auth/logout', { method: 'POST' });
    return res.json();
  },

  async getWebAuthConfig(): Promise<{ status: string; webAuth: WebAuthConfigView }> {
    const res = await fetch('/api/admin/auth/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async updateWebAuthConfig(
    payload: { enabled?: boolean; username?: string; password?: string }
  ): Promise<{ status: string; webAuth: WebAuthStatus; message?: string }> {
    const res = await fetch('/api/admin/auth/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.message || `HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return body;
  },

  /** Effective model view for one key — what it can see & use right now. */
  async getKeyModels(
    id: string
  ): Promise<{
    status: string;
    mode: 'none' | 'allow' | 'deny';
    policyModels: string[];
    models: { id: string; provider: string; tier: string; virtual: boolean; allowed: boolean }[];
  }> {
    const res = await fetch(`/api/admin/api-keys/${encodeURIComponent(id)}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /* ------------------------------------------------------------------ *
   * Request-capture archive (full bodies, opt-in; /api/admin/capture/*)
   * ------------------------------------------------------------------ */

  async getCaptureStatus(): Promise<CaptureStatus> {
    const res = await fetch('/api/admin/capture/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getCaptureDates(): Promise<CaptureDateRow[]> {
    const res = await fetch('/api/admin/capture/dates');
    if (!res.ok) return [];
    const json = await res.json();
    return json.dates || [];
  },

  async getCaptureSessions(date: string, apiKey?: string): Promise<CaptureSessionRow[]> {
    const qs = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : '';
    const res = await fetch(`/api/admin/capture/${encodeURIComponent(date)}/sessions${qs}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.sessions || [];
  },

  /** Locate a session's archive(s) across all dates by raw session id. */
  async findCaptureSessions(sessionId: string): Promise<CaptureSessionMatch[]> {
    const qs = new URLSearchParams({ id: sessionId });
    const res = await fetch(`/api/admin/capture/find-session?${qs.toString()}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.matches || [];
  },

  async getCaptureEvents(
    date: string,
    file: string,
    limit = 500
  ): Promise<{
    events: HttpExchangeEvent[];
    turns: CaptureTurn[];
    totalLines: number;
    fileTruncated: boolean;
  }> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}/events?limit=${limit}`
    );
    if (!res.ok) return { events: [], turns: [], totalLines: 0, fileTruncated: false };
    return res.json();
  },

  async getCaptureRecords(
    date: string,
    file: string,
    limit = 200
  ): Promise<{ records: CaptureRecord[]; totalLines: number; fileTruncated: boolean }> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}?limit=${limit}`
    );
    if (!res.ok) return { records: [], totalLines: 0, fileTruncated: false };
    return res.json();
  },

  /** JSONL download of one session archive; `exclude` strips body fields, metadata always kept. */
  async exportCaptureArchive(date: string, file: string, exclude?: string[]): Promise<Blob> {
    const params = new URLSearchParams({ format: 'raw' });
    if (exclude && exclude.length > 0) params.set('exclude', exclude.join(','));
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}?${params.toString()}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },

  async deleteCaptureDate(date: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(`/api/admin/capture/${encodeURIComponent(date)}`, { method: 'DELETE' });
    return res.json();
  },

  async deleteCaptureSession(date: string, file: string): Promise<{ status: string; message?: string }> {
    const res = await fetch(
      `/api/admin/capture/${encodeURIComponent(date)}/${encodeURIComponent(file)}`,
      { method: 'DELETE' }
    );
    return res.json();
  },
};

export interface ApiKeyModelAccess {
  mode: 'allow' | 'deny';
  models: string[];
}

export interface ApiKeyItem {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  createdAt: string;
  expiresAt?: string;
  description?: string;
  modelAccess?: ApiKeyModelAccess;
}

// ---------------------------------------------------------------------------
// Console webAuth (username/password login for /admin)
// Mirrors backend GET /api/admin/auth/config (passwordHash never leaves the server)
// ---------------------------------------------------------------------------

export interface WebAuthStatus {
  active: boolean; // console requires login (enabled or forced by non-loopback bind)
  forced: boolean; // forced on because the gateway binds a non-loopback host
  enabled: boolean; // explicit config toggle
}

export interface AuthSessionResponse {
  status: string;
  webAuth: WebAuthStatus;
  authenticated: boolean;
}

export interface WebAuthConfigView extends WebAuthStatus {
  username: string;
  hasPassword: boolean;
  host: string;
}

// ---------------------------------------------------------------------------
// OpenCode-native provider management (opencode.jsonc `provider` + auth.json)
// ---------------------------------------------------------------------------

export interface OpenCodeProviderView {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  models: string[];
  custom: boolean;
  logo?: string;
  priceFrom?: number;
  modelsCount?: number;
  auth: {
    connected: boolean;
    type?: 'api' | 'oauth' | 'wellknown';
    keyMasked?: string;
    expires?: number;
    inline?: boolean;
  };
}

export interface OpenCodeCatalogProvider {
  id: string;
  name: string;
  logo?: string;
  npm?: string;
  api?: string;
  baseURL?: string;
  doc?: string;
  env?: string[];
  custom: boolean;
  connected: boolean;
  sources: string[];
  modelCount: number;
  priceFrom?: number;
}

/** One remote catalog source (config def + live sync state) — mirrors backend CatalogSourceView. */
export interface CatalogSourceView {
  id: string;
  type: 'provider-catalog' | 'model-list' | 'openai-compatible' | 'custom';
  url: string;
  enabled: boolean;
  priority: number;
  /** mandatory baseline (models.opencode.ai) — locked against removal/disabling */
  builtin: boolean;
  origin: 'network' | 'cache' | 'stale' | 'none';
  /** last successful sync (epoch ms) */
  fetchedAt?: number;
  lastError?: string;
  records: number;
}

export interface CatalogSourceDataModelRecord {
  id: string;
  name?: string;
  npm?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  defaultEffort?: string;
  reasoningOptions?: { type: string; values?: string[]; min?: number }[];
  variants?: { id: string; effort: string }[];
  interleaved?: { field?: string };
  structured_output?: boolean;
  status?: string;
  description?: string;
  family?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  knowledge?: string;
  canonical_model_id?: string;
  experimental?: Record<string, unknown>;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; input?: number; output?: number };
  /** ocr view only: creating source of this model entry */
  source?: string;
  /** hidden from the model catalog (overrides.json `disabled`) — kept in the
   *  aggregate, excluded from the routing pool at boot */
  disabled?: boolean;
}

/** Full aggregated catalog (catalogRepository.list()) — mirrors backend CatalogProviderRecord. */
export interface OcrCatalogProvider {
  id: string;
  name?: string;
  logo?: string;
  npm?: string;
  baseURL?: string;
  doc?: string;
  env?: string[];
  custom: boolean;
  connected: boolean;
  sources: string[];
  models: CatalogSourceDataModelRecord[];
}

export interface CatalogSourceDataProviderRecord {
  id: string;
  name?: string;
  npm?: string;
  api?: string;
  doc?: string;
  env?: string[];
  models?: CatalogSourceDataModelRecord[];
}

/** Payload behind the console "view data" dialog — mirrors backend sourceData(). */
export interface CatalogSourceDataResponse {
  status: string;
  source: CatalogSourceView;
  fetchedAt?: number;
  providers: CatalogSourceDataProviderRecord[];
  models: CatalogSourceDataModelRecord[];
}

export interface CustomProviderPayload {
  id: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyInline?: boolean;
  headers?: Record<string, string>;
  models?: Record<string, any>;
  options?: Record<string, any>;
}

/** Result of the one-shot provider/model connectivity probe (POST .../test). */
export interface TestProviderResult {
  status: string;
  ok: boolean;
  kind?: 'openai' | 'anthropic' | 'google' | 'responses' | 'unroutable';
  model?: string;
  latencyMs?: number;
  error?: string;
  authHint?: boolean;
}

export interface OpenCodeModelView {
  providerId: string;
  providerName?: string;
  logo?: string;
  custom: boolean;
  connected: boolean;
  id: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
  /** def-level `disabled` — hidden from the model catalog (row toggle action). */
  disabled?: boolean;
  source: string;
}

function ocJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    return res
      .json()
      .catch(() => ({}))
      .then((e: any) => {
        throw new Error(e?.error || e?.message || `HTTP ${res.status}`);
      }) as Promise<T>;
  }
  return res.json();
}

export const opencodeApi = {
  async listProviders(): Promise<{
    status: string;
    configPath: string;
    authPath: string;
    providers: OpenCodeProviderView[];
  }> {
    return ocJson(await fetch('/api/admin/opencode/providers'));
  },

  async catalog(refresh = false): Promise<{ status: string; source: string; providers: OpenCodeCatalogProvider[] }> {
    return ocJson(await fetch(`/api/admin/opencode/catalog${refresh ? '?refresh=1' : ''}`));
  },

  async catalogSources(): Promise<{ status: string; syncIntervalMs: number; sources: CatalogSourceView[] }> {
    return ocJson(await fetch('/api/admin/catalog/sources'));
  },

  async setCatalogSyncInterval(intervalMs: number): Promise<{ status: string; syncIntervalMs: number }> {
    return ocJson(
      await fetch('/api/admin/catalog/sync-interval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMs }),
      })
    );
  },

  async catalogSourceData(id: string): Promise<CatalogSourceDataResponse> {
    return ocJson(await fetch(`/api/admin/catalog/sources/${encodeURIComponent(id)}/data`));
  },

  async addCatalogSource(payload: {
    id: string;
    type: string;
    url: string;
    priority?: number;
    enabled?: boolean;
    map?: Record<string, any>;
  }): Promise<{ status: string; source: CatalogSourceView }> {
    return ocJson(
      await fetch('/api/admin/catalog/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  async toggleCatalogSource(id: string, enabled: boolean): Promise<{ status: string; source: CatalogSourceView }> {
    return ocJson(
      await fetch(`/api/admin/catalog/sources/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
    );
  },

  async removeCatalogSource(id: string): Promise<{ status: string }> {
    return ocJson(await fetch(`/api/admin/catalog/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },

  async refreshCatalogSource(id: string): Promise<{ status: string; source: CatalogSourceView }> {
    return ocJson(await fetch(`/api/admin/catalog/sources/${encodeURIComponent(id)}/refresh`, { method: 'POST' }));
  },

  async refreshAllCatalogSources(): Promise<{ status: string; sources: CatalogSourceView[] }> {
    return ocJson(await fetch('/api/admin/catalog/sources/refresh', { method: 'POST' }));
  },

  async lockedCatalogModels(): Promise<{ status: string; lockedModels: string[] }> {
    return ocJson(await fetch('/api/admin/catalog/locked-models'));
  },

  async ocrCatalog(): Promise<{ status: string; providers: OcrCatalogProvider[] }> {
    return ocJson(await fetch('/api/admin/catalog/ocr'));
  },

  async getCatalogOverride(providerId: string, modelId: string): Promise<{ status: string; entry: Record<string, any> | null }> {
    const qs = new URLSearchParams({ providerId, modelId });
    return ocJson(await fetch(`/api/admin/catalog/override?${qs.toString()}`));
  },

  async putCatalogOverride(
    providerId: string,
    modelId: string,
    entry: Record<string, any>
  ): Promise<{ status: string }> {
    return ocJson(
      await fetch('/api/admin/catalog/override', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, modelId, entry }),
      })
    );
  },

  async removeCatalogOverride(providerId: string, modelId: string): Promise<{ status: string }> {
    const qs = new URLSearchParams({ providerId, modelId });
    return ocJson(await fetch(`/api/admin/catalog/override?${qs.toString()}`, { method: 'DELETE' }));
  },

  async toggleCatalogModelLock(id: string, locked: boolean): Promise<{ status: string; lockedModels: string[] }> {
    return ocJson(
      await fetch('/api/admin/catalog/locked-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, locked }),
      })
    );
  },

  async listModels(params?: { provider?: string; connected?: boolean }): Promise<{
    status: string;
    source: string;
    total: number;
    models: OpenCodeModelView[];
  }> {
    const qs = new URLSearchParams();
    if (params?.provider) qs.set('provider', params.provider);
    if (params?.connected) qs.set('connected', '1');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return ocJson(await fetch(`/api/admin/opencode/models${suffix}`));
  },

  async createProvider(payload: CustomProviderPayload): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch('/api/admin/opencode/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  async updateProvider(id: string, payload: Partial<CustomProviderPayload>): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  },

  async connectProvider(id: string, apiKey: string, baseURL?: string): Promise<{ status: string; success: boolean; message?: string }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, baseURL }),
      })
    );
  },

  /** One-shot upstream connectivity probe — optional overrides enable test-before-save. */
  async testProvider(
    id: string,
    payload?: { modelId?: string; apiKey?: string; baseURL?: string }
  ): Promise<TestProviderResult> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
    );
  },

  async deleteProvider(id: string, purgeAuth = false): Promise<{ status: string; success: boolean; message?: string }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}${purgeAuth ? '?purgeAuth=1' : ''}`, {
        method: 'DELETE',
      })
    );
  },

  // -- Per-provider model maintenance (config-defined providers only) ----

  async listProviderModels(id: string): Promise<{ status: string; id: string; models: Record<string, any> }> {
    return ocJson(await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models`));
  },

  async addProviderModel(
    id: string,
    model: {
      id: string;
      name?: string;
      modelID?: string;
      disabled?: boolean;
      capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
      settings?: Record<string, any>;
      headersText?: string;
      bodyText?: string;
      compatibility?: { reasoningField?: string };
      variants?: { id: string; settings?: Record<string, any> }[];
      reasoning?: boolean;
      toolCall?: boolean;
      attachment?: boolean;
      temperature?: boolean;
      modalities?: { input?: string[]; output?: string[] };
      contextLimit?: number;
      outputLimit?: number;
      cost?: Record<string, number>;
      definition?: Record<string, any>;
    }
  ): Promise<{ status: string; success: boolean; model: string }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      })
    );
  },

  async updateProviderModel(
    id: string,
    modelId: string,
    patch: {
      name?: string;
      modelID?: string;
      disabled?: boolean;
      capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
      settings?: Record<string, any>;
      headersText?: string;
      bodyText?: string;
      compatibility?: { reasoningField?: string };
      variants?: { id: string; settings?: Record<string, any> }[];
      reasoning?: boolean;
      toolCall?: boolean;
      attachment?: boolean;
      temperature?: boolean;
      modalities?: { input?: string[]; output?: string[] };
      contextLimit?: number;
      outputLimit?: number;
      newId?: string;
      cost?: Record<string, number>;
      definition?: Record<string, any>;
    }
  ): Promise<{ status: string; success: boolean; model: string }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    );
  },

  async deleteProviderModel(id: string, modelId: string): Promise<{ status: string; success: boolean }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, {
        method: 'DELETE',
      })
    );
  },

  async pullProviderModels(
    id: string,
    opts: { pattern?: string; dryRun?: boolean; live?: boolean } = {}
  ): Promise<{
    status: string;
    live?: boolean;
    matched?: number;
    pullable?: number;
    pulled?: number;
    skipped?: number;
    success?: boolean;
    hint?: string;
    models: OpenCodeModelView[] | string[];
  }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      })
    );
  },

  async clearProviderModels(id: string, pattern?: string): Promise<{ status: string; success: boolean; removed?: number }> {
    return ocJson(
      await fetch(`/api/admin/opencode/providers/${encodeURIComponent(id)}/models/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern }),
      })
    );
  },
};
