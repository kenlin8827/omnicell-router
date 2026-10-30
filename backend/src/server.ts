import { registerConsoleRoutes, validateApiKey } from './routes/console.js';
import { isWebAuthActive, isAdminAuthEndpoint, parseSessionCookie, verifySessionToken } from './auth/web-auth.js';
import { getModelAccessPolicy, isModelAllowed, isAutoEntryUsable } from './auth/model-access.js';
import {
  registerRuntimeConfigRef,
  loadConfig,
  DEFAULT_INBOUND_GRACE_MS,
  MAX_INBOUND_GRACE_MS,
  MAX_GRACE_SLEEPERS,
} from './config/index.js';
import { getRateLimiter, apiKeySubject } from './ratelimit/rate-limiter.js';
import { getRateLimitEventLog, recordRateLimitEvent } from './ratelimit/event-log.js';
import { getFailureEventLog } from './observability/failure-events.js';
import { registerEnvironmentRoutes } from './routes/environments.js';
import { registerHarnessRoutes } from './routes/harness.js';
import { SURFACES } from './surfaces/table.js';
import { createFastifyTransport } from './surfaces/transport-fastify.js';
import { dispatchSurface } from './surfaces/dispatch.js';
import fastify, { FastifyInstance, LogController } from 'fastify';
import cors from '@fastify/cors';
import { RouterConfig, ProviderConfig } from './config/types.js';
import { PipelineOrchestrator } from './pipeline/orchestrator.js';
import { ProviderRegistry } from './providers/registry.js';
import { FinOpsTracker } from './metrics/finops-tracker.js';
import { APP_VERSION } from './version.js';
import { TraceTracker, type ExecutionTrace } from './trace/tracker.js';
import { setGatewayMetaDeps } from './cli/clients/model-meta.js';
import {
  comboEnvelope,
  findMemberCatalogRecords,
  modelsDevBlock,
  tierAliasEnvelope,
  virtualModelsDevBlock,
  type VirtualEnvelope,
} from './providers/virtual-meta.js';
import { modelSupportsEfforts } from './types/router.js';
import { isInternalSessionId } from './session/session-manager.js';
import {
  currentModelOf,
  deriveSessionEntryMode,
  projectSessionEntity,
  promptTurnsOf,
  sessionTitleOf,
  type SessionRow,
} from './session/session-row.js';
import type { TripScope } from './resilience/types.js';
import type { CaptureKeyIdentity } from './capture/recorder.js';

const TIER_RANK: Record<string, number> = { lite: 1, plus: 2, pro: 3, ultra: 4 };

/**
 * Live inbound grace-wait sleepers (see MAX_GRACE_SLEEPERS). Bun is
 * single-threaded and the increment/decrement happen in one synchronous
 * region around the awaited sleep — no interleaving hazard.
 */
let graceSleepers = 0;

/**
 * Rebuild a console session row from persisted traces alone (seen after a
 * gateway restart, when the live session-manager state is gone but the trace
 * store survived). Derived values are observability reconstructions — the
 * routing state itself (pin/ratchet) starts fresh by design, so the row is the
 * execution view (`currentModel`), never a fabricated pin (ADR-0002 §3).
 */
function reconstructSessionFromTraces(traceTracker: TraceTracker, id: string): SessionRow {
  const traces = traceTracker.getTracesBySession(id);
  const first = traces[0];
  const last = traces[traces.length - 1];
  const maxTier = traces.reduce<ExecutionTrace['routing']['targetTier']>(
    (acc, t) => ((TIER_RANK[t.routing.targetTier] ?? 0) > (TIER_RANK[acc] ?? 0) ? t.routing.targetTier : acc),
    'lite'
  );
  const keyList = distinctTraceKeys(traces);
  const uaList = distinctTraceUserAgents(traces);
  return {
    id,
    // The id IS the marker (see isInternalSessionId) — traces key on it, so
    // this survives restarts on the reconstruction path exactly like live.
    internal: isInternalSessionId(id),
    maxTier,
    entryMode: deriveSessionEntryMode(traces),
    ...currentModelOf(traces),
    // Title from the birth trace: this row has no entity, so the trace is the
    // only place the opening prompt survived (ADR-0002 §3).
    firstUserMessage: sessionTitleOf(traces),
    createdAt: first?.timestamp ?? 0,
    lastActiveAt: last?.timestamp ?? 0,
    // User-prompt turns, not raw requests (traceCount below is the requests
    // number — the entity/ratchet turnCount would equal it on every row).
    turnCount: promptTurnsOf(traces),
    historyTiers: traces.map(t => t.routing.targetTier),
    // DISTINCT client API-key identities seen on this session's traces, in
    // write order (first element = display anchor). Only appears once key
    // attribution exists; a rotated-key session lists every contributor.
    apiKeys: keyList.length ? keyList : undefined,
    // DISTINCT client User-Agent strings (write order) — console display only.
    clients: uaList.length ? uaList : undefined,
    ...traceTracker.getSessionAggregates(id),
  };
}

/** Distinct client API-key identities across a session's traces (write order). */
function distinctTraceKeys(traces: ExecutionTrace[]): CaptureKeyIdentity[] {
  const m = new Map<string, CaptureKeyIdentity>();
  for (const t of traces) {
    if (t.apiKey && !m.has(t.apiKey.id)) m.set(t.apiKey.id, t.apiKey);
  }
  return [...m.values()];
}

/**
 * Distinct client User-Agent strings across a session's traces (write order,
 * first element = display anchor). Display-only client fingerprint — the UA
 * is forgeable and is deliberately NOT an identity/routing input (ADR-0002
 * §1 resolves identity zero-header, anchored on the API-key application).
 */
function distinctTraceUserAgents(traces: ExecutionTrace[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const t of traces) {
    const ua = t.request.clientHeaders?.userAgent;
    if (ua && !seen.has(ua)) {
      seen.add(ua);
      list.push(ua);
    }
  }
  return list;
}

/**
 * Security P2-3 — drive-by CSRF verdict for state-changing /api/admin/* calls
 * while webAuth is INACTIVE (cors origin:true + no session gate means any web
 * page could POST/XHR at the admin surface):
 *   - NO Origin/Referer (CLI, curl, local processes) -> untouched (null).
 *   - Origin hostname loopback, or equal to the request Host -> allowed.
 *   - Anything else -> blocked with a machine-readable reason.
 * Residual risk (accepted, narrow fix): a page served from another loopback
 * port can still target this gateway — the full story is the webAuth gate.
 */
// Strict loopback test for ATTACKER-CONTROLLED hostnames (Origin/Referer).
// Deliberately NOT web-auth.ts's isLoopbackHost(): that helper classifies BIND
// hosts, where its startsWith('127.') prefix is harmless; here the attacker owns
// the whole '127.0.0.1.evil.test' domain and a prefix match lets the drive-by
// through. WHATWG URL parsing (new URL, below) already canonicalizes IPv4
// shorthands — 'http://127.1' and 'http://0x7f000001' both yield hostname
// '127.0.0.1' — so any surviving multi-label hostname is a DNS name, never
// loopback. Allowed: 'localhost', the '::1' literal (brackets stripped by the
// caller), and a fully-valid dotted quad inside 127.0.0.0/8.
const LOOPBACK_V4 = /^127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){2}$/;
function isExactLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || LOOPBACK_V4.test(h);
}

function crossOriginAdminVerdict(origin: string, requestHost: string | undefined): 'cross_origin_admin_request' | 'malformed_origin' | null {
  let host = '';
  try {
    host = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    // Unparsable Origin on a state-changing admin call — fail loud, fail closed.
    return 'malformed_origin';
  }
  if (isExactLoopbackHost(host)) return null;
  const reqHost = (requestHost || '').split(',')[0].split(':')[0].toLowerCase().trim();
  if (reqHost && host === reqHost) return null;
  return 'cross_origin_admin_request';
}

/**
 * Router-canonical PATH for every gate in the preHandler below. find-my-way
 * decodeURI's the request target ONCE (path portion only — it splits on the
 * first '?'/'#', and encoded reserved sequences like %2f/%23 survive, see
 * node_modules/find-my-way/lib/url-sanitizer.js safeDecodeURI) BEFORE matching,
 * so a raw req.url prefix check is bypassable: '/%61pi/admin/…' routes to the
 * real admin handler while rawUrl.startsWith('/api/admin/') misses it. find-my-
 * way also accepts proxy-form absolute targets ('http://host/a/b') and routes
 * their post-authority path (index.js getPathFromAbsoluteUrl) — mirrored below.
 * A malformed encoding ('%ZZ') throws URIError; fastify rejects such targets
 * with 400 FST_ERR_BAD_URL before any hook runs (probe-verified), so the null
 * branch is defense-in-depth: the gate cannot PROVE the target is not
 * admin-shaped, so it returns null and callers treat null as ADMIN /
 * non-models / non-whitelisted — fail closed at every site.
 * Chosen over req.routeOptions.url: that is only meaningful for MATCHED routes
 * (four-oh-four context would leak through), and today's gates intentionally
 * cover admin-shaped paths that never route (deny-before-404, e.g. the webAuth
 * gate on /api/admin/<unknown>). Decoding with the router's exact semantics
 * keeps the string predicate provably in step with what find-my-way matched.
 */
// Exported for tests (server-admin-csrf.test.ts): this mirrors find-my-way's
// pre-route URL handling, and its edge cases (proxy-form targets, bad URIs)
// deserve direct pinning, not only via HTTP injection.
export function canonicalPath(rawUrl: string): string | null {
  let bare = rawUrl.split('#')[0].split('?')[0];
  if (!bare.startsWith('/')) {
    const absolute = /^https?:\/\/[^/?#]+(\/.*)?$/i.exec(bare);
    if (!absolute) return null; // proxy-form junk, '*', unparseable → fail closed
    bare = absolute[1] ?? '/'; // authority-only target routes as '/'
  }
  try {
    return decodeURI(bare);
  } catch {
    return null;
  }
}

export function createServer(
  config: RouterConfig,
  mockMode = false,
  customRegistry?: ProviderRegistry,
  customOrchestrator?: PipelineOrchestrator,
  /** Extra provider configs for the bootstrapped registry (test seam only —
   *  production chat providers enter via `registerProvider` post-boot). */
  providerConfigs: ProviderConfig[] = []
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

  const registry = customRegistry || new ProviderRegistry(config, mockMode, providerConfigs);
  // Client-hook metadata seam: adapters that write rich model records (pi's
  // models.json) resolve per-model truth (effort support, pricing, limits)
  // from the live registry + catalog. Re-injected per createServer — last
  // boot wins; the standalone CLI never injects and falls back to bare entries.
  setGatewayMetaDeps(() => ({
    registry,
    catalogList: async () => (await import('./opencode/catalog/repository.js')).catalogRepository.list(),
  }));
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

  // Environment administration (book-sets): list/create/rename/trash/switch/
  // reset/export/import. Under /api/admin/* → covered by the webAuth gate.
  registerEnvironmentRoutes(app);

  // Authentication hook: validates the adminKey (master) or client API keys
  const resolveActiveAuthConfig = () => {
    const diskConfig = loadConfig();
    const activeKeys =
      config.apiKeys !== undefined && config.apiKeys.length > 0
        ? config.apiKeys
        : diskConfig.apiKeys || config.apiKeys || [];
    const adminKey = config.adminKey !== undefined ? config.adminKey : diskConfig.adminKey;
    // Inbound grace budget, same boot-snapshot-first doctrine as the keys:
    // loadConfig has already resolved + clamped). Re-defensive-clamped here so
    // hand-built configs (tests) cannot smuggle junk into the sleep math.
    const grace = config.rateLimit?.inboundGraceMs ?? diskConfig.rateLimit?.inboundGraceMs;
    const inboundGraceMs =
      typeof grace === 'number' && Number.isFinite(grace)
        ? Math.min(Math.max(0, Math.floor(grace)), MAX_INBOUND_GRACE_MS)
        : DEFAULT_INBOUND_GRACE_MS;
    return { activeKeys, adminKey, inboundGraceMs };
  };

  /** /v1/models + /v1/models/:model + /v1/catalog.json — the anonymous-tolerant
   *  models surfaces (optional auth: a VALID key narrows the listing, an
   *  absent/invalid one keeps the legacy behavior of its route). */
  const isModelsSurface = (path: string | null): boolean =>
    path !== null &&
    (path === '/v1/models' || path.startsWith('/v1/models/') || path === '/v1/catalog.json');

  /**
   * Inbound limits meter exactly the protocol surfaces — the routePath set of
   * the SURFACES table (chat, anthropic, responses, systemone), so a new wire
   * joins the metered set by the same single-table registration. The models
   * listing and the admin plane are NOT metered.
   */
  const INFERENCE_ROUTE_PATHS: ReadonlySet<string> = new Set(SURFACES.map((s) => s.routePath));

  // Load the rate-limit rule table from the same auth view the preHandler
  // uses (boot snapshot with the disk fallback resolveActiveAuthConfig does).
  // Thereafter every config save re-syncs it in-place (config/index.ts
  // saveConfig / saveRawConfig — the single choke points for all writers).
  {
    const bootAuth = resolveActiveAuthConfig();
    getRateLimiter().reload({ ...config, apiKeys: bootAuth.activeKeys });
  }

  app.addHook('preHandler', async (req, reply) => {
    const { activeKeys, adminKey, inboundGraceMs } = resolveActiveAuthConfig();
    // Canonical router view of req.url (see canonicalPath): EVERY gate below
    // tests this, never the raw string — '%61pi'-style encodings and proxy-
    // form targets route normally but hide from raw prefix checks.
    const path = canonicalPath(req.url);
    // null (URIError / unparseable target) fails closed AS admin: it can never
    // reach a handler either way (find-my-way 404s it), so admin-shaped
    // treatment is the strictest choice at every gate below.
    const isAdminSurface = path === null || path.startsWith('/api/admin/');

    // Security P2-3: webAuth-inactive admin writes must be same-host or
    // loopback-origin (keyless CLI/curl/local carry no Origin and pass).
    // When webAuth is ACTIVE the session gate below already refuses
    // cookie-less cross-origin writes (401) — nothing to add there.
    if (req.method !== 'GET' && isAdminSurface && !isWebAuthActive(config)) {
      const originHeader = (req.headers.origin as string | undefined) || (req.headers.referer as string | undefined);
      if (originHeader) {
        const verdict = crossOriginAdminVerdict(originHeader, req.headers.host);
        if (verdict) {
          // Deterministic abort via hijack (same precedent as the webAuth
          // gate below): a plain reply.send() finalizes a tick later and the
          // route lifecycle races it under inject ("Reply was already sent").
          reply.hijack();
          reply.raw.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          reply.raw.end(
            JSON.stringify({
              error: 'cross_origin_admin_request',
              reasonCode: verdict,
              message: `State-changing /api/admin/* requests must carry no Origin, a loopback Origin, or an Origin matching this host (got '${originHeader}').`,
            })
          );
          return;
        }
      }
    }

    // Console webAuth gate — independent of the inference-surface API-key
    // auth below. When active, /api/admin/* (except the auth endpoints
    // themselves) requires a login session cookie OR the adminKey (client.adminKey
    // on disk) as Bearer/x-api-key (programmatic access). The SPA HTML + hashed
    // assets under /admin* stay open — the login view lives client-side.
    if (isAdminSurface && !(path !== null && isAdminAuthEndpoint(path)) && isWebAuthActive(config)) {
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
            message: 'Console authentication required. Log in at /admin/ or present the adminKey (client.adminKey).',
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
      adminKey,
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
      path !== null && (
        path === '/' ||
        path === '/admin' ||
        path === '/health' ||
        path.startsWith('/admin/') ||
        path.startsWith('/api/admin/')
      )
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
      if (isModelsSurface(path)) return;
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

    // ── Inbound sliding-window enforcement (apiKeys[].limits) ───────────────
    // The client key's window caps are a CONTRACT with the caller, enforced at
    // the gate: an over-limit request never enters the pipeline and never
    // consumes a request slot (a counted denial would let a retry storm push
    // its own lockout past the window). Only the four inference wires are
    // metered — /v1/models browsing and the admin plane answer freely. A
    // keyless caller (no apiKeys match) has no keyConfig → no subject → never metered.
    // A denial is answered 429 + `Retry-After` (requests/tokens/cost budget
    // alike — a cost window re-opens by time too, and 402 tells client SDKs
    // "don't retry", which is the wrong contract for a sliding budget), with
    // ONE exception, the bounded grace wait (rateLimit.inboundGraceMs): when
    // the denial's retryAfterMs fits the grace budget the gate sleeps it out
    // and re-checks the window exactly ONCE, absorbing sub-second bursts
    // (mirror of the outbound in-place retry for short upstream caps —
    // RATE_LIMIT_BURST in the orchestrator). Invariants: admission count per
    // window is UNCHANGED (the wait only defers the request; the slot it
    // consumes is one that just expired); never a loop (a still-full window
    // after the re-check fast-fails like any denial, so a retry storm cannot
    // park sockets); the window still answers with fresh numbers (a slept
    // request may have lost the freed slot to a peer — Retry-After comes from
    // the POST-GRACE verdict, never the pre-sleep one); and an aborted client
    // is never re-checked (it would burn the freed slot for a dead request).
    if (validation.keyConfig && path !== null && INFERENCE_ROUTE_PATHS.has(path)) {
      const subject = apiKeySubject(validation.keyConfig.id);
      const rl = getRateLimiter();
      // Admission-time prompt estimate for the token pre-reservation: the
      // request body is parsed by the time the preHandler runs, so a rough
      // chars/4 read bounds what the turn CAN consume before the upstream
      // publishes real usage. A large request can no longer blow through a
      // token cap on account of usage it has not produced YET. No body / no
      // token constraints → estimate 0 → the reservation degenerates away.
      let tokenEstimate = 0;
      try {
        const body = (req as unknown as { body?: unknown }).body;
        if (body !== undefined && body !== null && !(body instanceof Buffer)) {
          tokenEstimate = Math.ceil(JSON.stringify(body).length / 4);
        }
      } catch {
        tokenEstimate = 0; // estimation must never gate a request by itself failing
      }
      let verdict = tokenEstimate > 0 ? rl.tryDispatchWithEstimate(subject, tokenEstimate) : rl.tryDispatch(subject);
      // Admitted (first pass or grace re-check): reconcile the token
      // pre-reservation exactly once per request, when the response stream
      // settles. By then the orchestrator's success terminal has recorded
      // ACTUAL usage — order-independent (release subtracts the estimate,
      // recordUsage adds the real tokens, the window nets to actual either
      // way). A failed/aborted turn releases its estimate with nothing
      // added: no usage was produced. Registration is keyed on the FINAL
      // verdict AFTER the grace block below (not the first pass): the grace
      // path is denied first-pass with no reservation placed, then re-reserves
      // on re-check — releasing the first-pass state there would leak the
      // recheck reservation, which does NOT age out (it is not an event; only
      // release() lowers it). One registration total, at the single point
      // below after the grace block resolves the final verdict.
      if (!verdict.allowed) {
        let sleptMs = 0;
        // Client-liveness for the grace wait. NEVER `req.raw.destroyed`: in
        // Bun an IncomingMessage auto-destroys shortly after the body reaches
        // EOF, so a perfectly LIVE request reads as destroyed once the grace
        // sleep crosses a macrotask — the woken gate hijacked the reply and
        // hung the live client (inject tests can't see it: mock req.raw never
        // destroys; the abort test can't see it: a gone client is also
        // "destroyed"). `aborted`/`socket.destroyed` are not dependable
        // cross-runtime either. The RESPONSE stream is the honest signal: it
        // only closes before `writableEnded` when the connection truly died.
        let clientGone = false;
        reply.raw.once('close', () => {
          if (!reply.raw.writableEnded) clientGone = true;
        });
        if (
          inboundGraceMs > 0 &&
          verdict.retryAfterMs <= inboundGraceMs &&
          !clientGone &&
          graceSleepers < MAX_GRACE_SLEEPERS
        ) {
          // setTimeout can fire a hair BEFORE the log entry expires
          // (msUntilBelow prunes at ts <= now-windowMs), so the re-check needs
          // slack — without it a correctly-timed grace sleep can still wake
          // into a still-full window. The jitter also de-synchronizes sleepers
          // racing one freed slot, but correctness only needs the floor.
          sleptMs = verdict.retryAfterMs + 5 + Math.floor(Math.random() * 25);
          graceSleepers++;
          try {
            await new Promise((resolve) => setTimeout(resolve, sleptMs));
          } finally {
            graceSleepers--;
          }
          if (!clientGone) {
            // Re-check WITH the estimate: the re-admission must re-reserve the
            // token pre-occupancy the first (denied) pass never placed.
            const recheck =
              tokenEstimate > 0 ? rl.tryDispatchWithEstimate(subject, tokenEstimate) : rl.tryDispatch(subject);
            if (recheck.allowed) {
              req.log.info(
                `[ratelimit] key '${validation.keyConfig!.name}' grace-admitted after ${sleptMs}ms wait (${verdict.rule})`
              );
              recordRateLimitEvent({
                direction: 'inbound',
                kind: 'grace-admitted',
                subject,
                rule: verdict.rule,
                limitedBy: verdict.limitedBy,
                retryAfterMs: 0, // waited out — the window reopened within grace
                apiKeyName: validation.keyConfig.name,
                note: `grace wait ${sleptMs}ms`,
                noteCode: 'grace-wait',
                noteParams: { ms: sleptMs },
              });
            }
            verdict = recheck;
          }
        }
        if (!verdict.allowed) {
          if (sleptMs > 0 && clientGone) {
            // Client walked away during the grace wait: the verdict stands as
            // a denial (the request must NOT fall through to the handler),
            // but there is no socket to deliver it to — hijack without
            // writing beats writing into a dead stream.
            reply.hijack();
            return reply;
          }
          // Retry-After from THIS verdict — post-grace when a sleep happened
          // (the slot may have gone to a peer), first-pass otherwise.
          const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
          recordRateLimitEvent({
            direction: 'inbound',
            kind: 'denied',
            subject,
            rule: verdict.rule,
            limitedBy: verdict.limitedBy,
            retryAfterMs: verdict.retryAfterMs,
            apiKeyName: validation.keyConfig.name,
            note: sleptMs > 0 ? `grace wait ${sleptMs}ms exhausted` : undefined,
            noteCode: sleptMs > 0 ? 'grace-exhausted' : undefined,
            noteParams: sleptMs > 0 ? { ms: sleptMs } : undefined,
          });
          req.log.info(
            `[ratelimit] key '${validation.keyConfig!.name}' denied by ${verdict.rule} — retry after ${retryAfterSec}s${sleptMs > 0 ? ` (grace wait ${sleptMs}ms exhausted)` : ''}`
          );
          if (sleptMs > 0) {
            // Deterministic abort — a plain reply.send() finalizes a tick later
            // and the route lifecycle races it after an awaited hook ("Reply was
            // already sent" + ERR_HTTP_HEADERS_SENT from the handler). Same
            // precedent as the cross-origin/webAuth gates above; the fast-fail
            // (no-await) path below keeps the hook-returns-reply form it always
            // used successfully.
            reply.hijack();
            reply.raw.writeHead(429, {
              'content-type': 'application/json; charset=utf-8',
              'retry-after': String(retryAfterSec),
              // IETF draft-ietf-httpapi-ratelimit-headers: machine-readable cap
              // state so well-behaved clients back off BEFORE the next 429.
              'ratelimit-limit': String(verdict.limit),
              'ratelimit-remaining': '0',
              'ratelimit-reset': String(retryAfterSec),
            });
            reply.raw.end(
              JSON.stringify({
                error: {
                  message: `Rate limit exceeded (${verdict.rule}); retry after ${retryAfterSec}s`,
                  type: 'rate_limit_error',
                  code: 'rate_limit_exceeded',
                  param: verdict.limitedBy,
                },
              })
            );
            return;
          }
          reply.header('Retry-After', String(retryAfterSec));
          reply.header('RateLimit-Limit', String(verdict.limit));
          reply.header('RateLimit-Remaining', '0');
          reply.header('RateLimit-Reset', String(retryAfterSec));
          return reply.status(429).send({
            error: {
              message: `Rate limit exceeded (${verdict.rule}); retry after ${retryAfterSec}s`,
              type: 'rate_limit_error',
              code: 'rate_limit_exceeded',
              param: verdict.limitedBy,
            },
          });
        }
      }
      // Single release-registration point, keyed on the FINAL verdict (either
      // the first pass or a grace re-check). A live reservation exists here iff
      // the request was admitted WITH an estimate; a denied request placed no
      // reservation (or released none) and must not register.
      if (verdict.allowed && tokenEstimate > 0) {
        const estimate = tokenEstimate;
        reply.raw.once('close', () => rl.releaseEstimate(subject, estimate));
      }
    }
  });

  // 1. Health check (Enriched with Circuit Breaker status)
  app.get('/health', async () => {
    const cbSummary = registry.getCircuitBreakerManager().getSummary();
    // Degraded reads the CAPABILITY fold (ADR-0004 §4), not the worst-state
    // fold: one cooling credential of a five-key chain must not mark the
    // whole gateway degraded while every model still serves.
    const anyOut = registry.getAllModels().some((m) => registry.modelHealthView(m) === 'unavailable');
    const isDegraded = anyOut;
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

  // 1B'. Rate-Limiter Snapshot — every armed window with its live sum, so an
  // operator can verify a cap is armed (and see headroom) without reading
  // code. Subjects carry only key ids / sha256 prefixes (display-safe
  // identities), never key material.
  app.get('/api/admin/ratelimit', async () => {
    return { status: 'ok', windows: getRateLimiter().snapshot() };
  });

  // 1B''. Rate-Limiter Event Log — every triggered cap from both directions
  // (inbound deny/grace, outbound skip/force/shape), newest first, coalesced
  // repeats, bounded ring. Same display-safe identities as the snapshot; the
  // ledger survives restarts via its SQLite mirror (rateLimit.persist), like
  // the window checkpoints.
  app.get('/api/admin/ratelimit/events', async () => {
    return { status: 'ok', events: getRateLimitEventLog().list() };
  });

  // 1B'''. Wipe the event ledger — ring AND its durable mirror (history
  // cleanup only: windows, armed rules and breaker state are untouched).
  // Same contract as POST /api/admin/logs/clear.
  app.post('/api/admin/ratelimit/events/clear', async () => {
    getRateLimitEventLog().clear();
    return { status: 'ok', cleared: true };
  });

  // 1B⁗'. Reset the live window(s) of ONE subject — administrative escape
  // hatch: clears the sliding-window history so a stuck budget reopens
  // immediately. Scoped per subject (optionally one rule label "1m/requests")
  // BY DESIGN — no global wipe, since a one-button "reset everything" would
  // void inbound key budgets. Armed rules are untouched; the next checkpoint
  // GCs the cleared rows from the durable store.
  app.post('/api/admin/ratelimit/windows/reset', async (req, reply) => {
    const body = (req.body || {}) as { subject?: string; rule?: string };
    const query = req.query as { subject?: string; rule?: string };
    const subject = (body.subject || query.subject || '').trim();
    const rule = (body.rule || query.rule || '').trim() || undefined;
    if (!subject) {
      return reply.status(400).send({
        status: 'error',
        message: "subject is required (e.g. 'apikey:<id>' or 'credential:<provider>:<prefix>')",
      });
    }
    const reset = getRateLimiter().resetWindows(subject, rule);
    if (reset === 0) {
      return reply
        .status(404)
        .send({ status: 'error', message: `no tracked window for subject '${subject}'${rule ? ` rule '${rule}'` : ''}` });
    }
    req.log.info({ subject, rule, reset }, 'rate-limit windows reset by admin');
    return { status: 'ok', subject, ...(rule ? { rule } : {}), reset };
  });

  // 1B⁗. Failure-event ledger — every failed upstream MODEL CALL (serving
  // pool attempts + decision layer wire calls), newest first, coalesced repeats,
  // bounded ring + traces.db mirror (survives restarts). Optional equality
  // filters narrow server-side; display-only plane, never gates routing.
  app.get('/api/admin/failure-events', async (req) => {
    const query = req.query as { model?: string; provider?: string; errorClass?: string; role?: string; limit?: string };
    const limit = query.limit !== undefined ? Math.min(Math.max(parseInt(query.limit, 10) || 200, 0), 500) : 200;
    const events = getFailureEventLog().list({
      model: query.model || undefined,
      provider: query.provider || undefined,
      errorClass: query.errorClass || undefined,
      role: query.role || undefined,
      limit,
    });
    return { status: 'ok', events };
  });

  // Wipe the failure ledger — ring AND its durable mirror (history cleanup
  // only; breaker state, rules and windows untouched). Same contract as
  // POST /api/admin/ratelimit/events/clear.
  app.post('/api/admin/failure-events/clear', async () => {
    getFailureEventLog().clear();
    return { status: 'ok', cleared: true };
  });

  // Delete ONE failure event by id — ring row + durable mirror row go
  // together (a coalesced ×N observation is one row and dies whole). Same
  // response contract as DELETE /api/admin/route-entries/:hash.
  app.delete('/api/admin/failure-events/:id', async (req) => {
    const { id } = req.params as { id: string };
    const removed = getFailureEventLog().remove(id);
    return { status: 'ok', removed };
  });

  // Harness domain (ADR-0015) — source registry, host catalog, inventory, market browse/detail,
  // install + remove writers, and the derived-translation store.
  registerHarnessRoutes(app);

  // 1C. Reset Tripped Circuit Breakers (Admin recovery after quota top-up)
  // optional `scope` (default 'model' = legacy behavior):
  //   model   -> every tuple breaker of the model (modelId); no model = reset everything
  //   credential -> every tuple breaker of one credential (keyHash prefix)
  //   pair    -> one (model, credential) tuple breaker
  // Resetting an credential never lifts its SUSPECT flag — that is administrative
  // state and needs 1E (or a console reconnect / Push).
  app.post('/api/admin/health/circuit-breakers/reset', async (req, reply) => {
    const query = req.query as { model?: string; credential?: string; scope?: string };
    const body = (req.body || {}) as { model?: string; credential?: string; scope?: string };
    const targetModel = query?.model || body?.model;
    const credential = query?.credential || body?.credential;
    // No model AND no credential = the legacy BULK reset (every tuple breaker);
    // with no target there is no scope to validate — everything resets.
    const scopeRaw: string | undefined =
      body?.scope || query?.scope || (targetModel || credential ? 'model' : undefined);
    const cbManager = registry.getCircuitBreakerManager();

    if (scopeRaw !== undefined && scopeRaw !== 'model' && scopeRaw !== 'credential' && scopeRaw !== 'pair') {
      return reply.status(400).send({
        status: 'error',
        message: `Unknown scope '${scopeRaw}' (expected 'model', 'credential' or 'pair')`,
      });
    }
    if (scopeRaw === 'credential' && !credential) {
      return reply.status(400).send({
        status: 'error',
        message: `scope 'credential' requires an credential (keyHash prefix)`,
      });
    }
    if (scopeRaw === 'pair' && (!targetModel || !credential)) {
      return reply.status(400).send({ status: 'error', message: "scope 'pair' requires a model and an credential" });
    }

    // No scope (no target) = bulk reset of every tuple breaker.
    if (scopeRaw === undefined) {
      const result = cbManager.reset();
      return { status: 'ok', scope: 'all' as const, ...result };
    }

    const scope = scopeRaw as TripScope;
    const result = cbManager.resetByScope(scope, {
      modelId: targetModel,
      keyHashPrefix: credential,
      providerId: targetModel ? registry.getModel(targetModel)?.provider : undefined,
    });
    return { status: 'ok', scope, model: targetModel, credential, ...result };
  });

  // 1D. Manually trip a circuit breaker (admin takes a model, one credential,
  // or one (model, credential) pair out of rotation from the console).
  // Legacy body {model, reason?, cooldownMs?} is scope 'model' = today's trip.
  app.post('/api/admin/health/circuit-breakers/trip', async (req, reply) => {
    const query = req.query as { model?: string; credential?: string; scope?: string };
    const body = (req.body || {}) as {
      model?: string;
      reason?: string;
      cooldownMs?: number;
      scope?: string;
      credential?: string;
    };
    const targetModel = query?.model || body?.model;
    const credential = query?.credential || body?.credential;
    const scopeRaw = body?.scope || query?.scope || 'model';
    const cbManager = registry.getCircuitBreakerManager();

    if (scopeRaw !== 'model' && scopeRaw !== 'credential' && scopeRaw !== 'pair') {
      return reply.status(400).send({
        status: 'error',
        message: `Unknown scope '${scopeRaw}' (expected 'model', 'credential' or 'pair')`,
      });
    }
    if (scopeRaw === 'model' && !targetModel) {
      return reply.status(400).send({ status: 'error', message: 'Model id is required (?model= or body.model)' });
    }
    if (scopeRaw !== 'model' && !credential) {
      return reply.status(400).send({
        status: 'error',
        message: `scope '${scopeRaw}' requires an credential (keyHash prefix)`,
      });
    }
    if (scopeRaw === 'pair' && !targetModel) {
      return reply.status(400).send({ status: 'error', message: "scope 'pair' requires a model" });
    }

    const scope = scopeRaw as TripScope;
    // A manual trip is a temporary takedown with a cooldown; it NEVER marks
    // SUSPECT (that is the administrative state an auth failure earns).
    const result = cbManager.tripByScope(
      scope,
      {
        modelId: targetModel,
        keyHashPrefix: credential,
        providerId: targetModel ? registry.getModel(targetModel)?.provider : undefined,
        // Model-scope takedown spans the FULL credential chain — without it a
        // healthy chained model with no prior failures would trip only the
        // sentinel tuple and keep serving on every chain credential.
        chainPrefixes:
          scope === 'model' && targetModel
            ? registry.getCredentialChain(registry.getModel(targetModel)?.provider ?? '')?.map((c) => c.keyHashPrefix)
            : undefined,
      },
      { reason: body.reason, cooldownMs: typeof body.cooldownMs === 'number' ? body.cooldownMs : undefined }
    );
    if (result.affected === 0) {
      return reply.status(400).send({ status: 'error', scope, model: targetModel, credential, message: result.message });
    }
    return { status: 'ok', scope, model: targetModel, credential, ...result };
  });

  // 1E. Clear an credential's SUSPECT flag. The flag is set
  // by a confirmed-bad credential and never decays on its own; the console's
  // reconnect/Push paths clear it implicitly, this is the explicit admin door.
  app.post('/api/admin/health/suspect-credentials/clear', async (req, reply) => {
    const query = req.query as { provider?: string; credential?: string };
    const body = (req.body || {}) as { provider?: string; credential?: string };
    const providerId = body.provider || query.provider;
    const credential = body.credential || query.credential;
    if (!providerId || !credential) {
      return reply
        .status(400)
        .send({ status: 'error', message: 'Both provider and credential (keyHash prefix) are required' });
    }
    const cleared = registry.getCircuitBreakerManager().getCredentialStateStore().clear(providerId, credential);
    return { status: 'ok', provider: providerId, credential, cleared };
  });

  // 2. Model catalog — TWO shapes over the SAME filtered data:
  //
  // GET /v1/models — OpenAI-compatible models.list ({object:'list',
  // data:[{id, object, created, owned_by, metadata}]}): the surface generic
  // OpenAI SDKs and chat clients hard-code. Row ids are the gateway-visible
  // modelRef vocabulary (registered id / variant sibling id / auto* alias /
  // combo id); the full models.dev capability block (plus the namespaced
  // `ocr` routing plugins) rides under each row's `metadata`.
  //
  // GET /v1/catalog.json — models.dev-shaped provider map (aligned with
  // https://models.opencode.ai/api.json): body keyed by provider id, each
  // provider carrying `models` as a model-id keyed map of capability blocks
  // (snake_case: reasoning/tool_call/modalities/limit/cost/reasoning_options).
  // Consumers that want provider-grouped capability data (opencode-style
  // clients) read this instead. OCR routing plugins (kind/tier/selection/
  // members/parent/variant) live under each model's `ocr` key:
  //  - concrete models: verbatim passthrough of the catalog record's
  //    capability fields;
  //  - virtual refs (auto*/combos): the member envelope — safe-min limits,
  //    intersection capability flags, leader cost, full effort ladder (the
  //    gateway clamps per request and reports truth via X-OCR-Thinking-*).
  app.get('/v1/models', async (req) => {
    const policy = getModelAccessPolicy((req as any).authInfo?.keyConfig);
    const providers = await catalogProviders(policy);
    const data = Object.entries(providers).flatMap(([pid, p]) =>
      Object.entries(p.models as Record<string, any>).map(([mid, block]) => {
        const ocr = block.ocr as any;
        // Addressable id: virtual aliases/combos are the map key; concrete
        // models use the registered id (`ocr.model`); variants reconstruct
        // the registered sibling id (`parent` + `-variant`).
        const id = ocr?.kind === 'auto' || ocr?.kind === 'tier' || ocr?.kind === 'combo'
          ? mid
          : ocr?.parent && ocr?.variant
            ? `${ocr.parent}-${ocr.variant.id}`
            : (ocr?.model ?? mid);
        return {
          id,
          object: 'model',
          created: 1700000000,
          owned_by: pid,
          metadata: block,
        };
      })
    );
    return { object: 'list', data };
  });

  app.get('/v1/catalog.json', async (req) =>
    catalogProviders(getModelAccessPolicy((req as any).authInfo?.keyConfig))
  );

  const catalogProviders = async (policy: ReturnType<typeof getModelAccessPolicy>) => {
  const listCatalog = async () => (await import('./opencode/catalog/repository.js')).catalogRepository.list();
  // One snapshot per request: each list() call rereads config.yaml from disk,
  // so the anonymous /v1/models + /v1/catalog.json surfaces must not call it
  // per-consumer. The snapshot also keeps every consumer within a request on
  // the same catalog generation.
  const catalogOnce = await listCatalog();
  const listCatalogOnce = async () => catalogOnce;

  // ── Virtual provider ('omnicell-router'): auto*/combos/variants ──
  const virtualModel = async (envPromise: Promise<VirtualEnvelope>, ocr: Record<string, unknown>) => {
    const env = await envPromise;
    return {
      ...(env.memberCount > 0 ? { memberCount: env.memberCount } : {}),
      ...virtualModelsDevBlock(env),
      ocr: { ...ocr, ...(env.memberCount > 0 ? { memberCount: env.memberCount } : {}) },
    };
  };
  const [autoM, liteM, plusM, proM, ultraM] = await Promise.all(
    ['auto', 'lite', 'plus', 'pro', 'ultra'].map((alias) =>
      virtualModel(tierAliasEnvelope(registry, listCatalogOnce, alias), {
        kind: alias === 'auto' ? 'auto' : 'tier',
        ...(alias !== 'auto' ? { tier: alias } : {}),
      })
    )
  );
  const virtualModels: Record<string, unknown> = {
    auto: { id: 'auto', description: 'Intelligent multi-tier cascading auto-router (Recommended Default)', ...autoM },
    lite: { id: 'lite', description: 'Force Lite & low-cost layer (~$0.2/M)', ...liteM },
    plus: { id: 'plus', description: 'Force Plus workhorse layer (~$3-$15/M)', ...plusM },
    pro: { id: 'pro', description: 'Force Pro thinking-effort specialist tier (~$3-$8/M)', ...proM },
    ultra: { id: 'ultra', description: 'Force Ultra frontier-tier layer (~$60+/M)', ...ultraM },
  };
  for (const c of registry.getCombos()) {
    virtualModels[c.id] = {
      id: c.id,
      description: `Custom model combo (${c.models.length} members, ${c.selection || 'priority'} selection)`,
      ...(await virtualModel(comboEnvelope(registry, listCatalogOnce, c), {
        kind: 'combo',
        selection: c.selection || 'priority',
        members: c.models.map((raw) => (typeof raw === 'string' ? raw : raw?.id)).filter(Boolean),
      })),
    };
  }

  // Provider map insertion order is the display order (JSON object keys are
  // ordered): the VIRTUAL provider first — its models are auto alias →
  // tier aliases (ladder order) → combos — then concrete providers in
  // registry order, variants appended after their provider's base models.
  const providers: Record<string, any> = {
    'omnicell-router': {
      id: 'omnicell-router',
      name: 'OmniCellRouter',
      models: virtualModels,
    },
  };

  // ── Concrete providers: catalog passthrough, registry fallback ──
  const allModels = registry.getAllModels();
  const catById = new Map(
    (await findMemberCatalogRecords(allModels.map((m) => m.id), listCatalogOnce)).records.map((c) => [c.id, c])
  );
  const CATALOG_PROVIDER_NAME = new Map(catalogOnce.map((p) => [p.id, p.name]));
  const ensureProvider = (id: string) =>
    (providers[id] ??= { id, ...(CATALOG_PROVIDER_NAME.get(id) ? { name: CATALOG_PROVIDER_NAME.get(id) } : {}), models: {} });
  for (const m of allModels) {
    const provider = ensureProvider(m.provider);
    const cat = catById.get(m.id);
    // A federated upstream whose provider id collides with the virtual
    // provider namespace (a `omnicell-router` def pointing at ANOTHER
    // instance) can register upstreamModel === 'auto'/'lite'/... — writing
    // that key would clobber the virtual alias block and erase the gateway's
    // own cascade entry. The two are different models: key the concrete row
    // by its globally-unique registered id instead, which is also its
    // addressable id (ocr.model), so both entries coexist.
    const key = provider.models[m.upstreamModel] === undefined ? m.upstreamModel : m.id;
    provider.models[key] = {
      id: key,
      ...(cat
        ? modelsDevBlock(cat)
        : {
            reasoning: modelSupportsEfforts(m.supportedReasoningEfforts, m.supportsReasoningEffort),
            cost: { input: m.pricing.input, output: m.pricing.output, cache_read: m.pricing.cacheRead, ...(m.pricing.cacheWrite !== undefined ? { cache_write: m.pricing.cacheWrite } : {}) },
          }),
      ocr: { tier: m.tier, model: m.id },
    };
  }

  // Variant siblings live under their base model's provider as separate
  // model entries (`<upstream>-<variant>` keys): the variant id pins the
  // effort, so the block declares reasoning:false with the single pinned tier.
  for (const { base, variant } of registry.getVariantExposures()) {
    const upstreamBase = base.id.includes('/') ? base.id.split('/').slice(1).join('/') : base.id;
    const provider = ensureProvider(base.provider);
    const cat = catById.get(base.id);
    // Same anti-clobber rule as the concrete loop: if the natural
    // `<upstream>-<variant>` key is taken (virtual alias / sibling model),
    // fall back to the globally-unique registered sibling id.
    const vKey =
      provider.models[`${upstreamBase}-${variant.id}`] === undefined
        ? `${upstreamBase}-${variant.id}`
        : `${base.id}-${variant.id}`;
    provider.models[vKey] = {
      id: vKey,
      ...(cat ? modelsDevBlock(cat) : {}),
      reasoning: false,
      reasoning_options: [{ type: 'effort', values: [variant.reasoningEffort] }],
      ocr: {
        tier: base.tier,
        kind: 'variant',
        parent: base.id,
        variant: { id: variant.id, reasoningEffort: variant.reasoningEffort },
      },
    };
  }

  if (policy) {
    // Same verdicts as before, applied per model entry; providers whose
    // entire model map filters out are dropped (a provider key with an
    // empty models map would be a dead catalog entry).
    const tierAllowed = (t: string) => allModels.some((m) => m.tier === t && isModelAllowed(m.id, policy, m.tier));
    const verdict = (id: string, ocr: any): boolean => {
      if (ocr?.parent) return isModelAllowed(ocr.parent, policy, ocr?.tier);
      if (ocr?.kind === 'combo') {
        return registry.resolveCombo(id).every((mem: any) => isModelAllowed(mem.id, policy, mem.tier));
      }
      if (ocr?.kind === 'auto' || ocr?.kind === 'tier') {
        // Virtual auto* entries honor runtime viability: bare `auto` needs an
        // allowed model in ANY tier, tier aliases in their tier — in BOTH modes.
        return isAutoEntryUsable(id, policy, tierAllowed);
      }
      // Concrete entry — the model key is the upstream name; the policy
      // vocabulary is the full registered id (ocr.model).
      return isModelAllowed(ocr?.model ?? id, policy, ocr?.tier);
    };
    for (const pid of Object.keys(providers)) {
      const models = providers[pid].models as Record<string, any>;
      for (const mid of Object.keys(models)) {
        if (!verdict(mid, models[mid].ocr)) delete models[mid];
      }
      if (Object.keys(models).length === 0) delete providers[pid];
    }
  }

  return providers;
  };

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
      ['auto', 'lite', 'plus', 'pro', 'ultra'].includes(model) ||
      (registry.isCombo(model) && !registry.isComboDisabled(model));

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
      const isVirtual = model === 'auto' || ['lite', 'plus', 'pro', 'ultra'].includes(model);
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
      owned_by: specific ? specific.provider : variantRef ? variantRef.base.provider : 'omnicell-router',
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

  // 3C. Active Conversation Sessions Inspection (optional limit/offset pagination)
  app.get('/api/admin/sessions', async (req) => {
    const query = req.query as { limit?: string; offset?: string; q?: string; apiKey?: string; hideInternal?: string };
    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    // Duplicate params (?q=a&?q=b / ?apiKey=a&apiKey=b) parse to an ARRAY
    // (Fastify 5 behavior, verified) — take the first string instead of
    // crashing on .trim(); mirrors the capture sessions route guard.
    const firstStr = (v: unknown): string =>
      typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
    const q = firstStr(query.q).trim().toLowerCase();
    // Per-application selector (same semantics as the capture sessions route):
    // exact client API-key id OR case-insensitive name substring.
    const ak = firstStr(query.apiKey).trim();
    // Internal (gateway-loopback) rows: hidden unless the caller asks for
    // them. Filtered BEFORE pagination so `total` stays truthful.
    const hideInternal = firstStr(query.hideInternal) !== '0';

    const traceTracker = orchestrator.getTraceTracker();
    // Live sessions (entity + traces) and sessions that exist only in the
    // persisted trace store (e.g. after a gateway restart) are reconstructed
    // so console history survives. Live wins on id collision. Both paths
    // project into the same SessionRow contract (session-row.ts), so a row
    // never carries the live routing state (pin/ratchet).
    const live = (orchestrator.getSessionManager()?.getAllSessions() || []).map((s): SessionRow => {
      const sessTraces = traceTracker.getTracesBySession(s.id);
      const keyList = distinctTraceKeys(sessTraces);
      const uaList = distinctTraceUserAgents(sessTraces);
      return {
        // Whitelisted entity projection (session-row.ts): the entity's
        // pinnedModel/pinnedProvider are routing-internal (ADR-0002) and are
        // deliberately NOT surfaced, so live and trace-reconstructed rows
        // report the same execution view instead of an anchor.
        ...projectSessionEntity(s),
        // Title: the birth-time entity value wins; a live entity created
        // before the field existed falls back to the same trace derivation the
        // reconstructed rows use, so the two shapes cannot disagree.
        firstUserMessage: s.firstUserMessage ?? sessionTitleOf(sessTraces),
        ...currentModelOf(sessTraces),
        // Same trace-derived turns number as reconstructed rows — the entity
        // turnCount counts every request and would equal traceCount.
        turnCount: promptTurnsOf(sessTraces),
        // derived, never stored, so live and trace-reconstructed rows agree.
        internal: isInternalSessionId(s.id),
        // Application attribution from the session's traces — distinct key set
        // in write order (first element = display anchor).
        apiKeys: keyList.length ? keyList : undefined,
        // Client User-Agents (write order) — console display only (forgeable).
        clients: uaList.length ? uaList : undefined,
        // Entry mode is trace-derived for live rows too: the session entity
        // itself does not record how the client addressed its turns.
        entryMode: deriveSessionEntryMode(sessTraces),
        ...traceTracker.getSessionAggregates(s.id),
      };
    });
    const liveIds = new Set(live.map(s => s.id));
    const reconstructed = traceTracker
      .getSessionIds()
      .filter(id => !liveIds.has(id))
      .map(id => reconstructSessionFromTraces(traceTracker, id));
    // Most recently active first — stable ordering for pagination. `q`
    // filters (case-insensitive substring) across session id, current model AND
    // its provider (both are rendered in that column), first user message and
    // every app name, applied BEFORE pagination.
    // `apiKey` (ak) selects by membership in the session's distinct key set.
    const all = [...live, ...reconstructed]
      .filter(s => {
        if (hideInternal && (s as { internal?: boolean }).internal) return false;
        const keys = s.apiKeys ?? [];
        if (ak && !keys.some(k => k.id === ak || k.name.toLowerCase().includes(ak.toLowerCase()))) return false;
        return (
          !q ||
          s.id.toLowerCase().includes(q) ||
          String(s.currentModel || '')
            .toLowerCase()
            .includes(q) ||
          String(s.currentProvider || '')
            .toLowerCase()
            .includes(q) ||
          String(s.firstUserMessage || '')
            .toLowerCase()
            .includes(q) ||
          keys.some(k => k.name.toLowerCase().includes(q))
        );
      })
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
      // Same two projections as the list rows (ADR-0002 §3): the routing pin
      // and the client IP stay inside the gateway, and `currentModel` reuses the
      // list's execution-view derivation so the endpoints cannot disagree.
      ...projectSessionEntity(session),
      // Same turns number as the list rows (server.ts:1206): the entity
      // turnCount counts EVERY request — displayed next to traceCount the two
      // would always be equal.
      turnCount: promptTurnsOf(traces),
      // Same title derivation as the list rows (entity first, birth trace as
      // the fallback) so list and detail cannot disagree.
      firstUserMessage: session.firstUserMessage ?? sessionTitleOf(traces),
      ...currentModelOf(traces),
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

    // Cascade: remove this session's request-capture archives (disk JSONL,
    // possibly spread over several date dirs) so a deleted session leaves no
    // orphan files until the retention sweep. Fails soft — a locked or
    // vanished archive must not turn a successful delete into a 500; warn
    // and let the daily sweep backstop the leftover. No enablement gate:
    // findBySession is a name-only readdir scan that fails open ([] when
    // capture is disabled and the archive dir is absent), and archives left
    // from a since-disabled capture are exactly the orphans this cascade
    // must remove.
    let capturesDeleted = 0;
    try {
      const recorder = orchestrator.getCaptureRecorder();
      for (const match of recorder.findBySession(id)) {
        if (recorder.deleteSession(match.date, match.file)) {
          capturesDeleted++;
        } else {
          req.log.warn(
            { sessionId: id, date: match.date, file: match.file },
            'capture archive not deleted (locked or vanished) — left to retention sweep'
          );
        }
      }
    } catch (err) {
      req.log.warn(err, 'capture cascade delete errored — left to retention sweep');
    }

    return {
      status: 'ok',
      message: `Session '${id}' and its traces have been successfully cleared`,
      capturesDeleted,
    };
  });

  // 3F. Query Trajectory / Traces by Session ID
  app.get('/api/admin/sessions/:id/traces', async (req) => {
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

  // 3G. Global Request Trajectory Queries (with optional session_id / model
  // filter, time-window & pagination). `model` is an exact match on the
  // resolved physical model id recorded in each trace.
  app.get('/api/admin/traces', async (req) => {
    const query = req.query as { session_id?: string; model?: string; limit?: string; offset?: string; since?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const modelId = query.model && query.model.trim() ? query.model.trim() : undefined;
    // `since` is an inclusive lower-bound epoch-ms timestamp. Garbage /
    // negative / future values are clamped to undefined so the tracker
    // returns the whole in-memory window instead of an empty list — same
    // default behavior as before this parameter existed.
    const sinceRaw = query.since ? Number(query.since) : NaN;
    const sinceTs = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;

    const result = orchestrator.getTraceTracker().getRecentTraces({
      sessionId: query.session_id,
      modelId,
      limit,
      offset,
      sinceTs,
    });

    return {
      object: 'list',
      total: result.total,
      limit,
      offset,
      ...(modelId !== undefined ? { model: modelId } : {}),
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
