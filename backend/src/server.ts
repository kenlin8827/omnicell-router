import { registerConsoleRoutes, validateApiKey } from './routes/console.js';
import { isWebAuthActive, isAdminAuthEndpoint, parseSessionCookie, verifySessionToken } from './auth/web-auth.js';
import { getModelAccessPolicy, isModelAllowed, isAutoEntryUsable } from './auth/model-access.js';
import { registerRuntimeConfigRef } from './config/index.js';
import { registerFlywheelRoutes } from './routes/flywheel.js';
import { SURFACES } from './surfaces/table.js';
import { createFastifyTransport } from './surfaces/transport-fastify.js';
import { dispatchSurface } from './surfaces/dispatch.js';
import fastify, { FastifyInstance, LogController } from 'fastify';
import cors from '@fastify/cors';
import { RouterConfig } from './config/types.js';
import { loadConfig } from './config/index.js';
import { PipelineOrchestrator } from './pipeline/orchestrator.js';
import { ProviderRegistry } from './providers/registry.js';
import { FinOpsTracker } from './metrics/finops-tracker.js';
import { APP_VERSION } from './version.js';
import { TraceTracker, type ExecutionTrace } from './trace/tracker.js';

const TIER_RANK: Record<string, number> = { lite: 1, plus: 2, pro: 3, ultra: 4 };

/**
 * Rebuild a console session row from persisted traces alone (seen after a
 * gateway restart, when the live session-manager state is gone but the trace
 * store survived). Derived values are observability reconstructions — the
 * routing state itself (pin/ratchet) starts fresh by design.
 */
function reconstructSessionFromTraces(traceTracker: TraceTracker, id: string) {
  const traces = traceTracker.getTracesBySession(id);
  const first = traces[0];
  const last = traces[traces.length - 1];
  const maxTier = traces.reduce<ExecutionTrace['routing']['targetTier']>(
    (acc, t) => ((TIER_RANK[t.routing.targetTier] ?? 0) > (TIER_RANK[acc] ?? 0) ? t.routing.targetTier : acc),
    'lite'
  );
  return {
    id,
    maxTier,
    pinnedModel: last?.execution.modelUsed ?? '',
    pinnedProvider: last?.execution.provider ?? '',
    createdAt: first?.timestamp ?? 0,
    lastActiveAt: last?.timestamp ?? 0,
    turnCount: traces.length,
    historyTiers: traces.map(t => t.routing.targetTier),
    firstUserMessage: first?.request.userPromptSummary,
    ...traceTracker.getSessionAggregates(id),
  };
}

export function createServer(
  config: RouterConfig,
  mockMode = false,
  customRegistry?: ProviderRegistry,
  customOrchestrator?: PipelineOrchestrator
): {
  app: FastifyInstance;
  orchestrator: PipelineOrchestrator;
  registry: ProviderRegistry;
  tracker: FinOpsTracker;
} {
  // disableRequestLogging: Fastify's built-in per-request lifecycle logs
  // ("incoming request" / "request completed" at info) are pure noise here —
  // every UI poll of /health + /api/* produced a pair, drowning ocr.log.
  // Request/response observability lives in /v1/traces + capture instead.
  // The hook below keeps 5xx visibility: disabling request logging also
  // suppresses Fastify's own 'request errored' / defaultErrorLog output.
  // NB: passed via the logController option — the top-level
  // disableRequestLogging flag is deprecated (FSTDEP023, removed in fastify@6).
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.addHook('onError', async (req, _reply, err) => {
    req.log.error(err, 'request errored');
  });

  const registry = customRegistry || new ProviderRegistry(config, mockMode);
  // Key writes (UI / API) sync this snapshot so the auth preHandler — which
  // prefers config.apiKeys over a disk re-read — sees edits immediately.
  registerRuntimeConfigRef(config);
  const tracker = customOrchestrator?.getTracker() || new FinOpsTracker();
  const orchestrator =
    customOrchestrator || new PipelineOrchestrator(config, registry, tracker);

  // Register CORS to allow any web frontend (Chatbox, NextChat, OpenWebUI)
  app.register(cors, { origin: true });

  // Client-exchange capture lives in the two transport adapters: the Fastify
  // transport stashes + finalizes inside sendJson/beginSse/endSse and owns
  // the close→499 abort listener per request; the node-http (MITM) transport
  // finalizes synchronously after its terminal send. The pre-refactor
  // server-level capture hooks are gone — finalization follows the
  // terminal-send discipline, not a global lifecycle event. (Caveat kept
  // from back then: if capture is toggled off mid-flight, the REQUEST event
  // may be on disk while the RESPONSE event never is — the request event is
  // the source of truth; the response event is best-effort.)

  // Register console dashboard and management routes
  registerConsoleRoutes(app, registry, orchestrator);

  // All protocol endpoints — chat, anthropic, responses, systemone — register
  // through the SURFACES table loop below; there is no per-wire route code
  // left in this file.

  // Flywheel console: dataset browsing, operator relabelling, manual training
  registerFlywheelRoutes(app, orchestrator);

  // Authentication hook: validates adminApiKey (master) or client API keys (apiKeys)
  const resolveActiveAuthConfig = () => {
    const diskConfig = loadConfig();
    const activeKeys =
      config.apiKeys !== undefined && config.apiKeys.length > 0
        ? config.apiKeys
        : diskConfig.apiKeys || config.apiKeys || [];
    const adminKey = config.adminApiKey !== undefined ? config.adminApiKey : diskConfig.adminApiKey;
    return { activeKeys, adminKey };
  };

  /** /v1/models + /v1/models/:model — the anonymous-tolerant models surface. */
  const isModelsSurface = (rawUrl: string): boolean =>
    rawUrl === '/v1/models' || rawUrl.startsWith('/v1/models/');

  app.addHook('preHandler', async (req, reply) => {
    const { activeKeys, adminKey } = resolveActiveAuthConfig();
    const rawUrl = req.url.split('?')[0];

    // Console webAuth gate — independent of the inference-surface API-key
    // auth below. When active, /api/admin/* (except the auth endpoints
    // themselves) requires a login session cookie OR the master adminApiKey
    // as Bearer/x-api-key (programmatic access). The SPA HTML + hashed
    // assets under /admin* stay open — the login view lives client-side.
    if (rawUrl.startsWith('/api/admin/') && !isAdminAuthEndpoint(rawUrl) && isWebAuthActive(config)) {
      const cookieToken = parseSessionCookie(req.headers.cookie);
      let consoleAuthed = verifySessionToken(cookieToken);
      if (!consoleAuthed) {
        const authHeader = req.headers.authorization;
        const xApiKeyHeader = req.headers['x-api-key'] as string | undefined;
        const bearer = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : '') || xApiKeyHeader?.trim() || '';
        consoleAuthed = Boolean(adminKey && bearer && bearer === adminKey);
      }
      if (!consoleAuthed) {
        // Deterministic abort: reply.hijack() flips `reply.sent` synchronously
        // (fastify v5's getter = hijacked || raw.writableEnded; a plain
        // reply.send() finalizes a tick later, so the lifecycle races into
        // the route handler — "Reply was already sent" + double response).
        // We then own the response via reply.raw; shape matches the API
        // error envelope used across the gateway.
        reply.hijack();
        reply.raw.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        reply.raw.end(JSON.stringify({
          error: {
            message: 'Console authentication required. Log in at /admin/ or present the master adminApiKey.',
            type: 'authentication_error',
            code: 'console_auth_required',
          },
        }));
        return;
      }
    }

    const isAuthEnabled = Boolean(adminKey || (activeKeys && activeKeys.length > 0));
    if (!isAuthEnabled) return;

    const activeConfig: RouterConfig = {
      ...config,
      adminApiKey: adminKey,
      apiKeys: activeKeys,
    };

    // Whitelist routes: health probe, console entry redirect, and the whole
    // /admin* management surface — pages + hashed assets + backing API all
    // live under it (wildcard-served pages in console.ts; observability
    // endpoints were moved out of /v1 into /api/admin so the client protocol
    // namespace stays pure and needs no per-endpoint auth special cases).
    // `/` only 301-redirects to /admin/.
    // Inference endpoints (/v1/chat/completions, /v1/messages) stay
    // auth-protected: /v1 is the client protocol surface.
    if (
      rawUrl === '/' ||
      rawUrl === '/admin' ||
      rawUrl.startsWith('/admin/') ||
      rawUrl.startsWith('/api/admin/') ||
      rawUrl === '/health'
      // NOTE: /v1/models is NOT whitelisted — the preHandler enforces its
      // three-tier auth itself (anonymous → full listing, invalid key → 401,
      // valid key → policy-filtered view) and the handlers read the policy
      // off req.authInfo.
    ) {
      return;
    }

    // Extract token from Authorization header or x-api-key header
    const authHeader = req.headers.authorization;
    const xApiKeyHeader = req.headers['x-api-key'] as string | undefined;
    const token = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : '') || xApiKeyHeader?.trim() || '';

    if (!token) {
      // Models surface: anonymous catalog browsing stays open from ANY source
      // (low-sensitivity metadata; the money is behind the inference gateways,
      // which still require a key). A PRESENTED key must still be valid.
      if (isModelsSurface(rawUrl)) return;
      return reply.status(401).send({
        error: {
          message: 'Missing API Key. Please provide Authorization: Bearer <key> or x-api-key header.',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
    }

    const validation = validateApiKey(token, activeConfig);

    if (!validation.valid) {
      // A PRESENTED key must be valid even on the models surface — a wrong
      // key must never silently widen what the caller sees.
      return reply.status(401).send({
        error: {
          message: validation.error || 'Invalid or disabled API Key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }

    // Attach client identity onto request for tracing and logging
    (req as any).authInfo = validation;
  });

  // 1. Health check (Enriched with Circuit Breaker status)
  app.get('/health', async () => {
    const cbSummary = registry.getCircuitBreakerManager().getSummary();
    const isDegraded = cbSummary.tripped > 0;
    return {
      status: isDegraded ? (cbSummary.healthy === 0 ? 'outage' : 'degraded') : 'ok',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      modelsRegistered: registry.getAllModels().length,
      circuitBreakers: {
        total: cbSummary.total,
        healthy: cbSummary.healthy,
        tripped: cbSummary.tripped,
        halfOpen: cbSummary.halfOpen,
      },
    };
  });

  // 1B. Circuit Breakers Inspection Endpoint
  app.get('/api/admin/health/circuit-breakers', async () => {
    return registry.getCircuitBreakerManager().getSummary();
  });

  // 1C. Reset Tripped Circuit Breakers (Admin recovery after quota top-up)
  app.post('/api/admin/health/circuit-breakers/reset', async (req) => {
    const query = req.query as { model?: string };
    const body = req.body as { model?: string } | undefined;
    const targetModel = query?.model || body?.model;
    const result = registry.getCircuitBreakerManager().reset(targetModel);
    return {
      status: 'ok',
      ...result,
    };
  });

  // 1D. Manually trip a model's circuit breaker (admin takes a model out of rotation from the console)
  app.post('/api/admin/health/circuit-breakers/trip', async (req, reply) => {
    const query = req.query as { model?: string };
    const body = (req.body || {}) as { model?: string; reason?: string; cooldownMs?: number };
    const targetModel = query?.model || body?.model;
    if (!targetModel) {
      return reply.status(400).send({ status: 'error', message: 'Model id is required (?model= or body.model)' });
    }
    const result = registry.getCircuitBreakerManager().trip(targetModel, {
      reason: body.reason,
      cooldownMs: typeof body.cooldownMs === 'number' ? body.cooldownMs : undefined,
    });
    return { status: 'ok', model: targetModel, ...result };
  });

  // 2. OpenAI-compatible Models list
  // Optional-auth visibility: with a VALID client key the listing is filtered
  // through that key's model-access policy; anonymous/invalid tokens keep the
  // legacy full listing (probe compatibility, keyless deployments).
  app.get('/v1/models', async (req, reply) => {
    // Policy comes from the preHandler-attached authInfo (undefined when
    // anonymous → legacy full listing; 401 for invalid keys already handled).
    const policy = getModelAccessPolicy((req as any).authInfo?.keyConfig);
    const virtualModels = [
      { id: 'auto', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Intelligent multi-tier cascading auto-router (Recommended Default)' },
      { id: 'auto-lite', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Force Lite & low-cost layer (~$0.2/M)' },
      { id: 'auto-plus', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Force Plus workhorse layer (~$3-$15/M)' },
      { id: 'auto-pro', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Force Pro thinking-effort specialist tier (~$3-$8/M)' },
      { id: 'auto-ultra', object: 'model', created: 1700000000, owned_by: 'opencode-router', description: 'Force Ultra frontier-tier layer (~$60+/M)' },
    ];

    const registered = registry.getAllModels().map(m => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: m.provider,
      metadata: {
        tier: m.tier,
        pricing: m.pricing,
      },
    }));

    // Custom model combos: user-composed virtual models (config.combos),
    // routable exactly like the auto-* virtual models above.
    const comboModels = registry.getCombos().map(c => ({
      id: c.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'opencode-router',
      description: `Custom model combo (${c.models.length} members, ${c.selection || 'priority'} selection)`,
    }));

    // Model variant siblings: `base-variant` ids that resolve to the base
    // model with the variant's reasoning effort pinned (registry-built from
    // boot-direct variants — see providers/registry.ts resolveVariantRef).
    const variantModels = registry.getVariantExposures().map(({ id, base, variant }) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: base.provider,
      description: `Variant '${variant.id}' of ${base.id} (reasoningEffort=${variant.reasoningEffort})`,
      metadata: {
        tier: base.tier,
        pricing: base.pricing,
        parent: base.id,
        variant: { id: variant.id, reasoningEffort: variant.reasoningEffort },
      },
    }));

    let data = [...virtualModels, ...comboModels, ...registered, ...variantModels];
    if (policy) {
      // Variant ids inherit their base model's verdict via metadata.parent
      // (checked first — a base provider could theoretically be named
      // 'opencode-router'). Virtual auto* ids stay visible only while at least
      // one registered model is routable under the policy (otherwise they are
      // dead entries). Combos pass only when EVERY member is allowed —
      // mirrors the inference entry gate (no silent composition change).
      const all = registry.getAllModels();
      const tierAllowed = (t: string) => all.some((m) => m.tier === t && isModelAllowed(m.id, policy, m.tier));
      data = data.filter((m: any) => {
        if (m.metadata?.parent) return isModelAllowed(m.metadata.parent, policy, m.metadata?.tier);
        if (registry.isCombo(m.id)) {
          return registry.resolveCombo(m.id).every((mem) => isModelAllowed(mem.id, policy, mem.tier));
        }
        if (m.owned_by === 'opencode-router') {
          // Virtual auto* rows honor runtime viability: bare `auto` needs an
          // allowed model in ANY tier, auto-X in tier X — in BOTH modes.
          return isAutoEntryUsable(m.id, policy, tierAllowed);
        }
        return isModelAllowed(m.id, policy, m.metadata?.tier);
      });
    }

    return {
      object: 'list',
      data,
    };
  });

  // 2B. Single model lookup (OpenAI standard)
  app.get('/v1/models/:model', async (req, reply) => {
    const { model } = req.params as { model: string };
    const policy = getModelAccessPolicy((req as any).authInfo?.keyConfig);
    const all = registry.getAllModels();
    const specific = all.find(m => m.id === model);
    // Variant sibling / `#variant` ids resolve to their base model — the same
    // resolution the request path applies, so a client validating a variant
    // id it got from the list (or typed) keeps working.
    const variantRef = specific ? null : registry.resolveVariantRef(model);
    const found = specific ||
      variantRef ||
      ['auto', 'auto-lite', 'auto-plus', 'auto-pro', 'auto-ultra'].includes(model) ||
      registry.isCombo(model);

    if (!found) {
      return reply.status(404).send({
        error: { message: `Model '${model}' not found`, type: 'invalid_request_error' },
      });
    }

    // Restricted key: hide denied models behind the same 404 — existence is
    // not leaked to keys the model is not visible to. Variant ids inherit
    // their base model's verdict; combos pass only when EVERY member does;
    // virtual auto* ids honor the same runtime viability as the listing.
    if (policy) {
      const isVirtual = model === 'auto' || model.startsWith('auto-');
      const tierAllowed = (t: string) => all.some((m) => m.tier === t && isModelAllowed(m.id, policy, m.tier));
      const allowed = registry.isCombo(model)
        ? registry.resolveCombo(model).every((mem) => isModelAllowed(mem.id, policy, mem.tier))
        : variantRef
          ? isModelAllowed(variantRef.base.id, policy, variantRef.base.tier)
          : isVirtual
            ? isAutoEntryUsable(model, policy, tierAllowed)
            : isModelAllowed(model, policy, specific?.tier);
      if (!allowed) {
        return reply.status(404).send({
          error: { message: `Model '${model}' not found`, type: 'invalid_request_error' },
        });
      }
    }

    return {
      id: model,
      object: 'model',
      created: 1700000000,
      owned_by: specific ? specific.provider : variantRef ? variantRef.base.provider : 'opencode-router',
      ...(variantRef
        ? {
            metadata: {
              parent: variantRef.base.id,
              variant: { id: variantRef.variant.id, reasoningEffort: variantRef.variant.reasoningEffort },
            },
          }
        : {}),
    };
  });

  // 3. FinOps Economics & Analytics Dashboard
  app.get('/api/admin/metrics', async () => {
    return orchestrator.getTracker().getStats();
  });

  // Reset metrics
  app.post('/api/admin/metrics/reset', async () => {
    orchestrator.getTracker().reset();
    return { status: 'ok', message: 'Metrics reset successfully' };
  });

  // Flywheel console endpoints (dataset inspection, relabelling, training) are
  // registered in routes/flywheel.ts — see registerFlywheelRoutes below.

  // 3C. Active Conversation Sessions Inspection (optional limit/offset pagination)
  app.get('/api/admin/sessions', async (req) => {
    const query = req.query as { limit?: string; offset?: string; q?: string };
    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const q = (query.q || '').trim().toLowerCase();

    const traceTracker = orchestrator.getTraceTracker();
    // Live sessions carry the authoritative routing state (pin/ratchet);
    // sessions that only exist in the persisted trace store (e.g. after a
    // gateway restart) are reconstructed from their traces so console
    // history survives. Live wins on id collision.
    const live = (orchestrator.getSessionManager()?.getAllSessions() || []).map(s => ({
      ...s,
      ...traceTracker.getSessionAggregates(s.id),
    }));
    const liveIds = new Set(live.map(s => s.id));
    const reconstructed = traceTracker
      .getSessionIds()
      .filter(id => !liveIds.has(id))
      .map(id => reconstructSessionFromTraces(traceTracker, id));
    // Most recently active first — stable ordering for pagination. `q`
    // filters (case-insensitive substring) across session id, pinned model
    // and first user message, applied BEFORE pagination.
    const all = [...live, ...reconstructed]
      .filter(
        s =>
          !q ||
          s.id.toLowerCase().includes(q) ||
          String(s.pinnedModel || '')
            .toLowerCase()
            .includes(q) ||
          String(s.firstUserMessage || '')
            .toLowerCase()
            .includes(q)
      )
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const data = limit === undefined ? all.slice(offset) : all.slice(offset, offset + limit);

    return {
      object: 'list',
      total: all.length,
      ...(limit !== undefined ? { limit } : {}),
      offset,
      data,
    };
  });

  // 3D. Single Session Details Query
  app.get('/api/admin/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = orchestrator.getSessionManager()?.getSession(id);
    if (!session) {
      return reply.status(404).send({
        error: {
          message: `Session '${id}' not found`,
          type: 'invalid_request_error',
        },
      });
    }

    const traces = orchestrator.getTraceTracker().getTracesBySession(id);
    return {
      object: 'session',
      ...session,
      traceCount: traces.length,
      recentTraces: traces.slice(-5),
    };
  });

  // 3E. Delete / Reset Single Session
  app.delete('/api/admin/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sessionMgr = orchestrator.getSessionManager();
    const existed = sessionMgr?.deleteSession(id) ?? false;
    const tracker = orchestrator.getTraceTracker();
    // The session may exist only as reconstructed trace history (e.g. after a
    // gateway restart) — deleting its traces is still a successful delete.
    const hadTraces = tracker.getSessionIds().includes(id);
    tracker.deleteBySession(id);

    if (!existed && !hadTraces) {
      return reply.status(404).send({
        error: {
          message: `Session '${id}' not found`,
          type: 'invalid_request_error',
        },
      });
    }

    return {
      status: 'ok',
      message: `Session '${id}' and its traces have been successfully cleared`,
    };
  });

  // 3F. Query Trajectory / Traces by Session ID
  app.get('/api/admin/sessions/:id/traces', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = orchestrator.getSessionManager()?.getSession(id);
    const traces = orchestrator.getTraceTracker().getTracesBySession(id);
    
    // Return empty list or session trajectory
    return {
      object: 'list',
      sessionId: id,
      sessionExists: Boolean(session),
      total: traces.length,
      data: traces,
    };
  });

  // 3G. Global Request Trajectory Queries (with optional session_id filter, time-window & pagination)
  app.get('/api/admin/traces', async (req) => {
    const query = req.query as { session_id?: string; limit?: string; offset?: string; since?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    // `since` is an inclusive lower-bound epoch-ms timestamp. Garbage /
    // negative / future values are clamped to undefined so the tracker
    // returns the whole in-memory window instead of an empty list — same
    // default behavior as before this parameter existed.
    const sinceRaw = query.since ? Number(query.since) : NaN;
    const sinceTs = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;

    const result = orchestrator.getTraceTracker().getRecentTraces({
      sessionId: query.session_id,
      limit,
      offset,
      sinceTs,
    });

    return {
      object: 'list',
      total: result.total,
      limit,
      offset,
      ...(sinceTs !== undefined ? { since: sinceTs } : {}),
      data: result.data,
    };
  });

  // 3H. Query Single Execution Trace by traceId
  app.get('/api/admin/traces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const trace = orchestrator.getTraceTracker().getTrace(id);
    if (!trace) {
      return reply.status(404).send({
        error: {
          message: `Trace '${id}' not found`,
          type: 'invalid_request_error',
        },
      });
    }
    return {
      object: 'trace',
      ...trace,
    };
  });

  // 4. Table-registered protocol surfaces (backend/src/surfaces/). ALL FOUR
  //    wires — chat / anthropic / responses / systemone — live in SURFACES:
  //    this loop registers the Fastify leg and the MITM interceptor detects
  //    + dispatches through the same table. Capture finalization is owned by
  //    the two transport adapters under the terminal-send discipline (the
  //    former server-level capture hooks are deleted). `return reply` mirrors
  //    the old handler's terminal pattern — the Fastify transport has already
  //    sent via reply / reply.raw.
  for (const surface of SURFACES) {
    app.post(surface.routePath, async (req, reply) => {
      const t = createFastifyTransport(req, reply, orchestrator);
      await dispatchSurface(t, surface, orchestrator, req.body);
      return reply;
    });
  }

  return { app, orchestrator, registry, tracker };
}
