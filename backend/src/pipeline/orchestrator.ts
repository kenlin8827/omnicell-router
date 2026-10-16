import crypto from 'node:crypto';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { ExecutionResult, ReasoningEffort, EFFORT_LADDER, RoutingDecision, TIER_RANK, TierLevel, downgradeReasoning } from '../types/router.js';
import { ClassifierConfig, FlywheelConfig, ModelRegistration, RouterConfig } from '../config/types.js';
import { PromptOptimizer } from './prompt-optimizer.js';
import { applyCompression } from '../compression/index.js';
import { RouterEngine, routingModeForceTier } from '../router/index.js';
import { SchemaAssertion } from '../validator/schema-assertion.js';
import { FallbackContextBuilder } from '../validator/parser.js';
import { ProviderRegistry } from '../providers/registry.js';
import { applyEffortMap } from '../providers/member-match.js';
import { FinOpsTracker } from '../metrics/finops-tracker.js';
import { computeRequestCost } from '../metrics/request-cost.js';
import { getRateLimiter, accountSubject, apiKeySubject, type Countable } from '../ratelimit/rate-limiter.js';

/**
 * A cap-override decision pending ledger emission (orchestrator pool gate):
 * recorded only AFTER the breaker gate confirms the call actually proceeds.
 */
interface ForcedPassRecord {
  subject: string;
  rule: string;
  limitedBy: Countable;
  retryAfterMs: number;
  /** Always present at construction (limitSubject existing implies limitPrefix) —
   *  optional only because TS cannot see that derivation link. */
  keyHashPrefix?: string;
  note: string;
  noteCode: RateLimitNoteCode;
}
import { recordRateLimitEvent, type RateLimitNoteCode } from '../ratelimit/event-log.js';
import { FlywheelCollector } from '../flywheel/collector.js';
import { SessionManager, SessionResolveResult } from '../session/session-manager.js';
import { TraceTracker } from '../trace/tracker.js';
import { CaptureRecorder } from '../capture/recorder.js';
import type { UpstreamEventContext } from '../providers/base.js';
import { emitClientRequest, captureKeyIdentity, setClientExchangeContext, type CaptureClientRequest, type ClientExchangeContext } from '../observability/http-exchange.js';
import { resolveTraceId } from '../observability/trace-id.js';
import { getWarnThrottle } from '../observability/warn-throttle.js';
import { ActiveHealthProber, CircuitBreakerManager, ErrorClassifier } from '../resilience/index.js';
import { ModelAccessConfig, isModelAllowed } from '../auth/model-access.js';
import {
  DEFAULT_ACCOUNT_AFFINITY_CACHE_TTL_MS,
  selectAccount,
  type AccountSelection,
} from './account-selection.js';

export interface ProcessContext {
  clientIp?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Inbound wire that produced this request — recorded as session birth metadata. */
  wire?: 'chat' | 'anthropic' | 'responses';
  /**
   * Per-key model access policy (from the validated client API key). When set,
   * every candidate model entering the execution pool is filtered through it —
   * this is what keeps `auto` routing, tier escalation and failover from ever
   * serving a model the key is not allowed to use. Undefined = unrestricted.
   */
  modelAccess?: ModelAccessConfig;
  /**
   * Raw Fastify request, used by the capture pipeline to record the inbound
   * request event (method / url / sanitized headers / body) synchronously
   * at process() entry — independent of any response. Optional so legacy
   * callers and unit tests can pass plain headers without a request object.
   */
  fastifyRequest?: import('fastify').FastifyRequest;
  /**
   * Transport observation for non-Fastify entry points (the MITM
   * forward-proxy interceptor): the ORIGINAL client request line + headers.
   * Ignored when `fastifyRequest` is present; recorded into the capture's
   * inbound http-exchange exactly like the Fastify leg.
   */
  clientRequest?: CaptureClientRequest;
  /**
   * Hands the client-exchange context to entry points with no Fastify
   * response lifecycle (the MITM interceptor), so THEY can finalize the
   * capture's gateway-response event when the raw response finishes.
   * Fastify paths finalize inside the Fastify transport adapter's terminal
   * sends instead and never provide this callback.
   */
  onClientExchange?: (ctx: ClientExchangeContext) => void;
}

/** Deep-enough message copy for capture snapshots (content parts cloned). */
function snapshotMessages(messages: any[]): any[] {
  return messages.map((m: any) => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content.map((p: any) => ({ ...p })) : m.content,
  }));
}

/**
 * Pull a non-sensitive subset of inbound headers for the trace's
 * `clientHeaders` field. Three categories:
 *   - user-agent / accept-language — client fingerprint.
 *   - request id (x-request-id / x-trace-id / x-correlation-id / request-id /
 *     traceparent) — cross-service correlation, NOT a credential.
 * Authorization / x-api-key / cookies / anything else are intentionally
 * omitted (raw headers carry API keys). Fastify surfaces headers as
 * `string | string[] | undefined`; arrays collapse to their first value to
 * keep the field scalar. Returns undefined when nothing matched so the
 * trace stays compact for the common no-headers path.
 */
const REQUEST_ID_KEYS = ['x-request-id', 'x-trace-id', 'x-correlation-id', 'request-id', 'traceparent'];

/**
 * Pull the upstream target host from an inbound header map. On the MITM
 * forward-proxy path this is the ORIGINAL destination (the API host the
 * client dialed — `clientRequest.headers.host` survives TLS termination),
 * which pins bare-name model resolution to the right provider. The native
 * /v1 leg is deliberately excluded from this call: there `headers.host` is
 * whatever the client SENT, so a forged Host must not steer resolution.
 * Handles Fastify's `string | string[] | undefined` header surface and case
 * variants.
 */
function pickHeaderHost(
  headers?: Record<string, string | string[] | undefined>
): string | undefined {
  if (!headers) return undefined;
  const raw = headers.host ?? headers.Host;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function extractClientHeaders(
  headers?: Record<string, string | string[] | undefined>
): { userAgent?: string; acceptLanguage?: string; requestId?: string } | undefined {
  if (!headers) return undefined;
  const pick = (key: string): string | undefined => {
    const v = headers[key] ?? headers[key.toLowerCase()];
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v[0];
    return v;
  };
  const ua = pick('user-agent');
  const al = pick('accept-language');
  let rid: string | undefined;
  for (const k of REQUEST_ID_KEYS) {
    rid = pick(k);
    if (rid) break;
  }
  if (ua === undefined && al === undefined && rid === undefined) return undefined;
  return {
    ...(ua !== undefined ? { userAgent: ua } : {}),
    ...(al !== undefined ? { acceptLanguage: al } : {}),
    ...(rid !== undefined ? { requestId: rid } : {}),
  };
}

export class PipelineOrchestrator {
  private config: RouterConfig;
  private registry: ProviderRegistry;
  private tracker: FinOpsTracker;
  private flywheel: FlywheelCollector;
  private sessionManager: SessionManager;
  private traceTracker: TraceTracker;
  private captureRecorder: CaptureRecorder;
  private healthProber?: ActiveHealthProber;

  constructor(
    config: RouterConfig,
    registry: ProviderRegistry,
    tracker: FinOpsTracker,
    sessionManager?: SessionManager
  ) {
    this.config = config;
    this.registry = registry;
    this.tracker = tracker;
    this.flywheel = new FlywheelCollector(config.flywheel);
    this.sessionManager = sessionManager || new SessionManager(config.session);
    this.traceTracker = new TraceTracker(5000, config.tracePersist);
    this.captureRecorder = new CaptureRecorder(config.requestCapture);

    if (config.circuitBreaker?.activeProbing?.enabled) {
      this.healthProber = new ActiveHealthProber(
        this.registry.getCircuitBreakerManager(),
        this.registry,
        config.circuitBreaker.activeProbing.intervalMs
      );
    }
  }

  public getTracker(): FinOpsTracker {
    return this.tracker;
  }

  public getFlywheel(): FlywheelCollector {
    return this.flywheel;
  }

  /**
   * The routing config snapshot this orchestrator was built with. Exposed so
   * the flywheel training route can resolve the same Layer 1 model path the
   * classifier actually loads, instead of guessing a second path.
   */
  public getClassifierConfig(): ClassifierConfig | undefined {
    return this.config.classifier;
  }

  public getFlywheelConfig(): FlywheelConfig | undefined {
    return this.config.flywheel;
  }

  public getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  public getTraceTracker(): TraceTracker {
    return this.traceTracker;
  }

  public getCaptureRecorder(): CaptureRecorder {
    return this.captureRecorder;
  }

  public getRegistry(): ProviderRegistry {
    return this.registry;
  }

  public getCircuitBreakerManager(): CircuitBreakerManager {
    return this.registry.getCircuitBreakerManager();
  }

  public startProber(): void {
    if (this.healthProber) this.healthProber.start();
  }

  public stopProber(): void {
    if (this.healthProber) this.healthProber.stop();
  }

  /**
   * Public entry point — thin capture wrapper around processInternal.
   *
   * Records the full request/response into the opt-in CaptureRecorder audit
   * log on BOTH the success and the failure path (debugging failed requests
   * is the primary use case). Implemented as a wrapper instead of an inline
   * hook so processInternal stays untouched: the session-id resolution and
   * the PRE-compression message snapshot are rebuilt here with the same pure
   * functions (PromptOptimizer.normalizeMessages / resolveSessionId) — both
   * are deterministic and run in the same synchronous segment, so the wrapper
   * snapshot is byte-identical to what processInternal sees before
   * applyCompression mutates the request. Request headers are captured in
   * SANITIZED form (credential values masked per the deny-list in
   * observability/http-exchange.ts), never raw.
   */
  public async process(
    request: ChatCompletionRequest,
    context?: ProcessContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const captureEnabled = this.captureRecorder.isEnabled();

    // Capture pipeline state — see observability/http-exchange.ts and
    // observability/upstream-events.ts for the wire emit contract. The
    // `traceId` shared across all four events is sourced from the inbound
    // request on BOTH legs (W3C `traceparent`, `x-request-id`, ...) so the
    // gateway stays transparent in distributed traces: the Fastify leg reads
    // its own request headers, the MITM leg the original clientRequest
    // headers, then plain `headers` (legacy/test callers). Only when NO
    // header source exists at all do we mint a fresh 32-hex id
    // (OpenTelemetry compliant).
    const traceHeaders =
      context?.fastifyRequest?.headers ?? context?.clientRequest?.headers ?? context?.headers;
    const traceResolution = traceHeaders
      ? resolveTraceId({ headers: traceHeaders }, 'client-or-mint')
      : { traceId: crypto.randomUUID().replace(/-/g, '').slice(0, 32), source: 'minted' as const };
    const captureOutTraceId = traceResolution.traceId;

    let captureSessionId = '';
    let preResolvedSession: SessionResolveResult | undefined;
    let upstreamEventContext: UpstreamEventContext | undefined;
    if (captureEnabled) {
      const normalizedMessages = PromptOptimizer.normalizeMessages(request);
      const snapshotRequest: ChatCompletionRequest = { ...request, messages: normalizedMessages };
      // Resolve ONCE here and hand the result to processInternal: cold-start
      // IDs carry fresh random entropy, so a second resolve of the same
      // request would mint a different ID and split capture from routing.
      preResolvedSession = this.sessionManager.resolveSessionId(
        snapshotRequest,
        context?.clientIp,
        context?.headers
      );
      captureSessionId = preResolvedSession.sessionId;
      // CLIENT REQUEST event fires synchronously here — independent of any
      // response. Even if the upstream call hangs / times out / the handler
      // throws, the client request event is already on disk.
      // (GATEWAY RESPONSE event is emitted by the transport adapter that
      // owns this leg: the Fastify transport finalizes at its terminal send
      // using the ctx attached back onto req; the MITM interceptor uses the
      // ctx handed to it via onClientExchange.)
      const clientExchangeCtx = emitClientRequest({
        recorder: this.captureRecorder,
        req: context?.fastifyRequest ?? context?.clientRequest,
        body: snapshotRequest,
        sessionId: captureSessionId,
        traceId: captureOutTraceId,
        model: request.model || 'auto',
      });
      if (context?.fastifyRequest) {
        setClientExchangeContext(context.fastifyRequest, clientExchangeCtx);
      } else if (context?.onClientExchange) {
        context.onClientExchange(clientExchangeCtx);
      }
      upstreamEventContext = {
        recorder: this.captureRecorder,
        sessionId: captureSessionId,
        traceId: captureOutTraceId,
        model: request.model || 'auto',
        // Key attribution: the Fastify leg carries authInfo (attached by the
        // auth preHandler); MITM / master-key legs resolve to undefined and
        // their events simply omit the field — same as before this existed.
        apiKey: captureKeyIdentity(context?.fastifyRequest),
      };
    }

    return await this.processInternal(request, context, preResolvedSession, upstreamEventContext, captureOutTraceId);
  }

  /**
   * Complete orchestration workflow:
   * 1. Prompt normalization (canonical order)
   * 2. Zero-header session identification & prefix fingerprinting
   * 3. Multi-Layer hierarchical routing (Layer 0 -> Layer 1 -> Layer 2)
   * 4. Monotonic Ratchet session state enforcement + Session-Pin Eviction
   * 5. Execution with Circuit Breaker, Transparent Failover & Schema Assertion
   * 6. FinOps accounting
   * 7. Active learning data flywheel logging
   * 8. Post-turn prefix fingerprint registration
   */
  private async processInternal(
    request: ChatCompletionRequest,
    context?: ProcessContext,
    preResolvedSession?: SessionResolveResult,
    upstreamEventContext?: UpstreamEventContext,
    traceId?: string
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    // 1. Optimize message prefix order & resolve virtual routing models
    const normalizedMessages = PromptOptimizer.normalizeMessages(request);
    const normalizedRequest: ChatCompletionRequest = {
      ...request,
      messages: normalizedMessages,
    };

    let explicitModel: ModelRegistration | undefined;
    let variantUsed: string | undefined;
    // Routing-name matching trims once. `request.model` itself stays verbatim
    // end-to-end (surface contract: wire/capture bytes and the forwarded copy
    // are never rewritten) — this restores the trim tolerance the old inline
    // /v1/chat handler had before dispatch, and gives both legs (Fastify +
    // MITM, which historically never trimmed) identical matching semantics.
    const modelName = (request.model ?? '').trim();
    if (modelName === 'auto-lite') {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: 'lite' };
    } else if (modelName === 'auto-plus') {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: 'plus' };
    } else if (modelName === 'auto-pro') {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: 'pro' };
    } else if (modelName === 'auto-ultra') {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: 'ultra' };
    } else if (modelName && modelName !== 'auto') {
      const specific = this.registry.getModel(modelName);
      if (specific) {
        // Exact-model pass-through: the client named a REGISTERED model id
        // (e.g. pinned via the Client Hub model slots). Route to exactly
        // this model — not merely its tier. Resilience is preserved: if its
        // breaker is tripped, executeCandidatePool drops it and fails over
        // within the tier.
        explicitModel = specific;
        normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: specific.tier };
      } else {
        const variantRef = this.registry.resolveVariantRef(modelName);
        if (variantRef) {
          // Variant request (sibling id `base-variant` or `base#variant`):
          // route to the BASE model exactly and pin the variant's effort as
          // if the client had asked for that level. The variant choice is
          // the more explicit signal, so it wins over any client-sent
          // `reasoning_effort`; the effort-matching block below still
          // applies its downgrade/honesty contract.
          explicitModel = variantRef.base;
          variantUsed = variantRef.variant.id;
          normalizedRequest.reasoning_effort = variantRef.variant.reasoningEffort;
          normalizedRequest.model = variantRef.base.id;
          normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: variantRef.base.tier };
        } else if (modelName.includes('#')) {
          // `#variant` is explicit syntax — a typo must fail loud instead of
          // silently classifier-routing (invisible model drift is exactly
          // the failure mode variant ids exist to prevent).
          const hash = modelName.indexOf('#');
          throw Object.assign(
            new Error(
              `Variant '${modelName.slice(hash + 1)}' not found for model '${modelName.slice(0, hash)}'`
            ),
            { statusCode: 404 }
          );
        } else {
          // Bare upstream name (no provider prefix — clients that address a
          // model the way its own catalog names it, e.g. `qwen3.8-flash`).
          // The full-id lookup above missed, but a registered model may still
          // carry this exact name as its upstreamModel: resolve to it so the
          // client's explicit choice is honored instead of silently
          // classifier-routing. Provider pinning reads ONLY the MITM leg's
          // clientRequest headers — after TLS termination its `host` is the
          // ORIGINAL host the client dialed (the design intent of the pin).
          // The native /v1 leg never pins: its `headers.host` is client-
          // controlled (a forged Host could steer resolution to a same-named
          // sibling provider) and the gateway's own host matches no provider
          // baseUrl anyway. Cheapest-hit-first ordering picks the primary
          // otherwise. Same-name siblings stay reachable via the tier's
          // failover pool. Unresolved names keep the classifier contract
          // (intelligent-routing product behavior).
          const bareHits = this.registry.getModelsByUpstreamName(
            modelName,
            pickHeaderHost(context?.clientRequest?.headers)
          );
          if (bareHits.length > 0) {
            explicitModel = bareHits[0];
            normalizedRequest.router_options = {
              ...normalizedRequest.router_options,
              force_tier: explicitModel.tier,
            };
          }
        }
        // Other unregistered names (e.g. native `claude-opus-*` after a /model
        // switch inside Claude Code) are left untouched — the classifier
        // decides, which IS the intelligent-routing product behavior.
      }
    }

    // 1A. Custom model combo: the client named a configured combo id — the
    // combo's member list IS the candidate pool. Classifier tier routing,
    // session ratchet and schema-assertion escalation are all bypassed
    // (explicit user composition wins, mirroring the exact-model
    // pass-through above).
    const comboByName =
      !explicitModel && modelName && this.registry.isCombo(modelName)
        ? modelName
        : undefined;
    if (comboByName && this.registry.resolveCombo(comboByName).length === 0) {
      // Fail fast instead of silently degrading to classifier routing: the
      // combo is still advertised via /v1/models, so routing it as `auto`
      // would be invisible billing/model drift.
      throw new Error(
        `Combo '${comboByName}' has no registered member models — check that every id in config.combos exists in config.models.`
      );
    }
    const comboId = comboByName ?? undefined;

    // Defense in depth: an explicitly named model outside the key's model
    // policy fails loud here (HTTP routes entry-check this too; direct
    // orchestrator callers might not). `tier` is passed so TIER-level deny
    // entries (auto-lite/auto-plus/...) match here exactly as they do in the
    // execution pool filter (executeCandidatePool) — a tier-denied explicit
    // model must not slip through the bare-name/variant resolution paths.
    if (
      explicitModel &&
      context?.modelAccess &&
      !isModelAllowed(explicitModel.id, context.modelAccess, explicitModel.tier)
    ) {
      throw Object.assign(
        new Error(`API key model policy denies model '${explicitModel.id}'`),
        { statusCode: 403 }
      );
    }

    // 1B. Global routing mode (config.routing.mode) — cost/quality force the tier
    // for auto/default requests; explicit client choices always win.
    const modeTier = routingModeForceTier(
      normalizedRequest.model,
      normalizedRequest.router_options,
      this.config.routing?.mode
    );
    if (modeTier) {
      normalizedRequest.router_options = { ...normalizedRequest.router_options, force_tier: modeTier };
    }

    // 2. Identify / track conversation session (zero-header layered resolution).
    // Reuse the capture-time resolve when present: both call sites normalize
    // identically, and one request must yield exactly one session ID.
    const sessionResolve = preResolvedSession ??
      this.sessionManager.resolveSessionId(
        normalizedRequest,
        context?.clientIp,
        context?.headers
      );
    const sessionId = sessionResolve.sessionId;

    // 2B. Token-saver compression (toolOutput tool-output compression → headroom
    // sidecar → outputStyle injection). All stages fail open. Snapshot the
    // PRE-compression
    // messages for the post-turn prefix fingerprint: the client always sends
    // uncompressed bytes, so the session chain must be indexed on the original
    // content — matching registerCompletedTurn below against compressed bytes
    // would break zero-header session resolution from the next turn onward.
    // (The upstream-facing compressed prefix stays byte-stable across turns
    // because the tool-output compressors are deterministic and headroom
    // runs in session mode.)
    const fingerprintMessages = normalizedRequest.messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(p => ({ ...p })) : m.content,
    }));
    await applyCompression(normalizedRequest, this.config.compression, sessionId);

    // 3. Multi-Layer Hierarchical Router (Layer 1 Local CPU -> Layer 2 System One decision)
    // Combo requests bypass the classifier entirely: the combo id IS the
    // explicit routing decision; targetTier here is a placeholder — the
    // executed member's real tier overwrites it after the pool run.
    const initialDecision: RoutingDecision = comboId
      ? {
          targetTier: 'plus',
          confidence: 1.0,
          reason: `Using custom combo '${comboId}' — your chosen models, no automatic routing`,
          reasonCode: 'combo',
          reasonParams: { combo: comboId },
          layerUsed: 'layer0',
          needsSchemaValidation: false,
          features: {
            tokenCountEstimate: 0,
            hasCode: false,
            hasMathOrProof: false,
            hasMultiTurn: false,
            hasToolsOrSchema: false,
            complexityScore: 0,
          },
        }
      : await RouterEngine.routeAsync(
          normalizedRequest,
          this.config.classifier,
          this.registry,
          this.config.systemone?.defaultModel,
          // Judge-call capture identity: the outer turn's trace/session (only
          // exists while the capture master is on). The LAYER 2 JUDGE applies
          // the surface-master chain (systemone.enabled master × l2Decision-
          // Enabled sub) — when off it
          // passes nothing further, so this arg alone changes nothing today.
          upstreamEventContext
        );

    // 4. Apply Monotonic Session Ratchet — three session-interaction modes,
    // resolved once here (the unified policy seam for all entry modes):
    // - 'ratchet'  : auto routing — full monotonic ratchet (upgrade allowed,
    //                downgrade intercepted, pin honored)
    // - 'explicit' : client named a registered model — turn recorded and a
    //                higher tier still escalates the ceiling, but the session
    //                NEVER rewrites the proposed tier (explicit user choice
    //                always wins)
    // - 'bypass'   : combo — no pin read/write, no ceiling raise, the combo
    //                composition IS the decision
    const sessionMode: 'ratchet' | 'explicit' | 'bypass' = comboId
      ? 'bypass'
      : explicitModel
        ? 'explicit'
        : 'ratchet';
    let decision: RoutingDecision;
    let ratchetApplied = false;
    let sessionTurnCount: number;
    if (sessionMode === 'bypass') {
      decision = { ...initialDecision, sessionId, sessionRatchetApplied: false, sessionLookupType: sessionResolve.lookupType };
      sessionTurnCount = (this.sessionManager.getSession(sessionId)?.turnCount ?? 0) + 1;
    } else {
      const ratchetResult = this.sessionManager.applyRatchet(
        sessionId,
        initialDecision,
        (tier) => this.registry.getModelForTier(tier),
        { allowIntercept: sessionMode === 'ratchet' }
      );
      decision = ratchetResult.finalDecision;
      decision.sessionId = sessionId;
      decision.sessionRatchetApplied = ratchetResult.ratchetApplied;
      decision.sessionLookupType = sessionResolve.lookupType;
      ratchetApplied = ratchetResult.ratchetApplied;
      sessionTurnCount = ratchetResult.session.turnCount;
    }

    // Birth metadata: attach once per session (first-write-wins inside the
    // manager), recording the inbound wire, the layer that resolved the id,
    // the client ip and a first-message snippet for UI identification.
    const bornSession = this.sessionManager.getSession(sessionId);
    if (bornSession && bornSession.turnCount === 1) {
      const firstUser = normalizedRequest.messages.find((m) => m.role === 'user');
      this.sessionManager.attachOrigin(
        sessionId,
        { wire: context?.wire, lookupType: sessionResolve.lookupType },
        context?.clientIp,
        typeof firstUser?.content === 'string' ? firstUser.content : undefined
      );
    }

    let actualTier = decision.targetTier;

    // 4B. Session-Pin Eviction (ratchet mode only — explicit/combo requests
    // have no session pin): when the pinned model is evicted by config intent
    // or by health, hard-switch the session onto a healthy actualTier landing
    // (with write-back). Two orthogonal forces — see the inline contract.
    const cbManager = this.registry.getCircuitBreakerManager();
    let preferredModel: ModelRegistration | null = null;
    if (sessionMode === 'ratchet') {
      const pinnedId = this.sessionManager.getSession(sessionId)?.pinnedModel;
      preferredModel = pinnedId ? this.registry.getModel(pinnedId) ?? null : null;
      // Session-pin eviction — the unified hard-switch seam. A pin is evicted
      // by exactly two orthogonal forces, checked here (before pool assembly)
      // so every execution branch (direct AND the lite-lead cascade below,
      // which ignores the pin for its own turn) inherits the repaired binding:
      //   CONFIG (operator intent): the model no longer joins the pool its
      //   live member lists give it — the id is gone from the registry
      //   (removed from config.models; the unresolvable-pin / zombie case,
      //   which pre-fix silently re-fell back through the getModelForTier
      //   head below every turn without ever writing the pin back), it reads
      //   `unclassified` (removed from every tier member list / no glob
      //   claims it any more), or the global denylist (tiers.exclude) vetoes
      //   it. A model MOVED to another tier is NOT evicted: reclassifyTiers
      //   rewrites m.tier in place, so it still joins "its own" tier's pool.
      //   Hand-configured models (no tierMatch) are reclassification-immune —
      //   member-list edits never evict them; only the denylist or a registry
      //   removal can. Checked with healthyOnly=false so health never
      //   masquerades as config intent (and vice versa below).
      //   HEALTH (runtime reality, model CAPABILITY view —
      //   registry.modelHealthView): evict ONLY at 'unavailable' — the
      //   model breaker hard-OPEN, or every credential pair out of service
      //   as hard-OPEN / account-SUSPECT / operator-DISABLED, so a full
      //   account takedown evicts the pin even though the model stays
      //   configured. PARTIAL disablement is not eviction: the account
      //   dimension handles it (FORCED rebind in account-selection).
      //   'recovering' (a canary trial in flight — slot free OR busy) is
      //   NEVER eviction: the peek view pool filters use reads a busy canary
      //   as unavailable, and moving a pin off a model one probe from
      //   closing back would burn its KV cache with no switch-back. The view
      //   folds shadow the way the verdict contract does — a shadowed
      //   automatic trip still SERVES (accounting only), so it never reads
      //   out; MANUAL trips and takedowns stay verbatim. The landing guard
      //   below intentionally keeps the stricter-on-entry peek
      //   read: leave a pin only when it is really gone, and never land a
      //   session on a model that cannot serve now.
      const configEvicted =
        pinnedId !== undefined &&
        (preferredModel === null ||
          !this.registry.getCandidateModelsForTier(preferredModel.tier, false).some((m) => m.id === pinnedId));
      const healthEvicted = preferredModel !== null && this.registry.modelHealthView(preferredModel) === 'unavailable';
      if (pinnedId && (configEvicted || healthEvicted)) {
        const healthyReplacement = this.registry.getModelForTier(actualTier, true);
        // Guard: getModelForTier degrades across tiers when the whole tier is
        // down — a cross-tier landing is legitimate (the registry logs it with
        // reason=empty-pool) and repinModel moves the model pin only, never
        // maxTier; landing onto a known-unhealthy model never is. When no
        // healthy landing exists the session keeps serving on the evicted pin
        // — safe fail: an emptied tier must not strand every bound session —
        // and the eviction is re-evaluated (and retried) next turn.
        if (
          healthyReplacement &&
          healthyReplacement.id !== pinnedId &&
          this.registry.modelAvailable(healthyReplacement).available
        ) {
          this.sessionManager.repinModel(sessionId, healthyReplacement);
          preferredModel = healthyReplacement;
          // Observability: repin attribution rides in reasonParams — this
          // turn's reasonCode belongs to applyRatchet's session.* vocabulary
          // and must not be overwritten. `repin` names the force (config vs
          // health) and from/to let the trace attribute the KV-cache burn.
          decision.reasonParams = {
            ...(decision.reasonParams ?? {}),
            repin: configEvicted ? 'config' : 'health',
            repinFrom: pinnedId,
            repinTo: healthyReplacement.id,
          };
          // Account continuity rides here rather than mutating the binding:
          // the repinned model flows into executeCandidatePool, whose per-
          // candidate selection KEEPS the session binding when the bound
          // prefix exists in the new provider's chain (prefer continuity —
          // same key material, same cache economics), and otherwise treats it
          // as stale and re-spreads with a FORCED rebind persisted after the
          // first success. Explicitly rebinding here to the new chain head
          // would pick an account the model was never verified against.
        }
      }
    }

    let finalResponse: ChatCompletionResponse;
    let actualModel: ModelRegistration = preferredModel || this.registry.getModelForTier(actualTier, true);
    // Reasoning-effort matching. `requestedEffort` is the
    // literal value the client sent (undefined if the field was omitted —
    // distinct from `'none'`, which is the client EXPLICITLY asking for no
    // thinking). `actualEffort` is what we actually served: undefined when the
    // client didn't ask at all, `'none'` for explicit no-thinking, or the
    // (translated, possibly downgraded) level. Member rules' inline
    // `effortMap` applies per model — `effortMap[requested] ?? requested`,
    // then capability-clamped; `none` participates too (a none→high rule
    // makes no-effort requests think). The written-back value is what the
    // provider builders construct the upstream payload from; `reasoningDegraded`
    // is surfaced via `X-OCR-Thinking-Actual` / `X-OCR-Thinking-Degraded`.
    // Model-default effort pin: the client omitted `reasoning_effort`
    // entirely (explicit values — 'none' included — always win) and the
    // selected model declares a default → pin it as the requested level so
    // every downstream step (effort matching, payload thinking block,
    // X-OCR-Thinking-* observability) treats it as a normal request.
    if (normalizedRequest.reasoning_effort === undefined && actualModel.defaultEffort) {
      normalizedRequest.reasoning_effort = actualModel.defaultEffort;
    }
    const requestedEffort: ReasoningEffort | undefined = normalizedRequest.reasoning_effort;
    let actualEffort: ReasoningEffort | undefined;
    let reasoningDegraded = false;
    const effortPick = (() => {
      // Skip effort-based pick when the request is an explicit model choice
      // OR a combo — both are pinned by the caller and must not be re-routed
      // (the preferredModel branch below still translates/clamps THEIR map).
      if (preferredModel || comboId) return null;
      if (requestedEffort === undefined || requestedEffort === 'none') {
        // No explicit level asked — still engage when a member rule
        // maps `none` to a real level (e.g. none→high) — the pick becomes
        // effort-aware. Otherwise leave the default tier pick alone.
        const mapped = this.registry.pickModelForEffort(actualTier, 'none', true);
        return mapped && mapped.actualEffort !== 'none' ? mapped : null;
      }
      return this.registry.pickModelForEffort(actualTier, requestedEffort, true);
    })();
    if (effortPick) {
      actualModel = effortPick.model;
      actualEffort = effortPick.actualEffort;
      reasoningDegraded = effortPick.degraded;
      // Write the resolved effort back so provider builders construct the
      // correct upstream payload (Anthropic budget_tokens, Gemini
      // thinkingBudget, Responses thinkingEffort, etc.).
      if (actualEffort !== requestedEffort) {
        normalizedRequest.reasoning_effort = actualEffort;
      }
    } else if (preferredModel) {
      // Explicit model choice / session pin: never re-route, but translate by
      // the model's effortMap first (none included), then clamp to what it
      // can serve and write back the truth.
      const target = applyEffortMap(preferredModel.effortMap, requestedEffort ?? 'none');
      if (target === 'none') {
        actualEffort = requestedEffort; // nothing in play — mirror exactly
      } else {
        const supported = preferredModel.supportedReasoningEfforts
          ?? (preferredModel.supportsReasoningEffort
            ? EFFORT_LADDER
            : []);
        const recomputed = downgradeReasoning(target, supported);
        actualEffort = recomputed;
        reasoningDegraded =
          EFFORT_LADDER.indexOf(recomputed) < EFFORT_LADDER.indexOf(requestedEffort ?? 'none');
        if (recomputed !== requestedEffort) {
          normalizedRequest.reasoning_effort = recomputed;
        }
      }
    } else {
      // No effort in play (no pick and no pinned model): mirror the client.
      actualEffort = requestedEffort;
    }
    let fallbackOccurred = false;
    let fallbackReason: string | undefined = undefined;
    let failoverOccurred = false;
    let failoverAttempts = 1;
    let failoverPath: string[] = [];
    let inplaceRetries = 0;
    // the account (keyHash prefix) that actually served;
    // undefined = legacy no-prefix path (chain-less provider or single key).
    let servedAccountPrefix: string | undefined = undefined;

    // 5. Execution with Cascading Fallback & Schema Assertion
    // (lite-lead cascade is skipped for explicit model choices and combos —
    // the client named exactly what to run and must not be silently rerouted)
    const retryConfig = this.config.retry;
    const failoverEnabled = retryConfig?.enabled !== false && retryConfig?.failover?.enabled !== false;
    const maxFailoverCandidates = failoverEnabled ? (retryConfig?.failover?.maxAttempts ?? 2) : 1;
    const tierCrossPolicy = retryConfig?.failover?.tierCrossPolicy ?? 'allow_escalate';

    if (decision.needsSchemaValidation && this.config.fallback.enabled && !request.router_options?.disable_fallback && !explicitModel && !comboId) {
      // 5A: Lite Tier lead - Deploy Lite Tier first with resilience
      const litePool = this.registry.getCandidateModelsForTier('lite', true);
      const liteResult = await this.executeCandidatePool(
        normalizedRequest,
        {
          chain: litePool.length > 0 ? litePool : this.registry.getCandidateModelsForTier('lite', false),
          tier: 'lite',
          allowEscalate: tierCrossPolicy === 'allow_escalate',
          attemptCap: maxFailoverCandidates,
          modelAccess: context?.modelAccess,
          requestedEffort,
          sessionId,
        },
        upstreamEventContext
      );

      let liteRes: ChatCompletionResponse | null = null;
      let assertionPassed = false;
      let assertionError = '';

      if (liteResult.success && liteResult.response) {
        liteRes = liteResult.response;
        const content = liteRes.choices[0]?.message?.content || '';

        // Local static AST / Schema assertion (Zero extra LLM cost!)
        const validation = SchemaAssertion.validate(content, normalizedRequest.response_format);
        if (validation.valid) {
          assertionPassed = true;
          finalResponse = liteRes;
          actualTier = 'lite';
          actualModel = liteResult.modelUsed!;
          // Same post-execution recompute as the direct path — lite failover
          // may have served a model whose translation/capability differs from
          // the tier-pick prediction (helper: map → clamp → mirror).
          {
            const r = this.resolveServedEffort(actualModel, requestedEffort);
            actualEffort = r.actualEffort;
            reasoningDegraded = r.degraded;
          }
          failoverOccurred = liteResult.failoverOccurred;
          failoverAttempts = liteResult.failoverAttempts;
          failoverPath = liteResult.failoverPath;
          inplaceRetries += liteResult.inplaceRetries;
          servedAccountPrefix = liteResult.servedAccountPrefix;
        } else {
          assertionError = validation.error || 'Schema validation assertion failed';
        }
      } else {
        assertionError = `Lite Tier Execution Error: ${liteResult.lastError?.message}`;
      }

      // 5B: Plus fallback - If Lite Tier failed assertion or execution, silent escalation
      if (!assertionPassed) {
        fallbackOccurred = true;
        fallbackReason = assertionError;
        const escalateTier = this.config.fallback.escalateTier || 'plus';

        const failedContent = liteRes?.choices[0]?.message?.content || '';
        const fallbackReq = FallbackContextBuilder.buildEscalationRequest(
          normalizedRequest,
          failedContent,
          assertionError,
          escalateTier
        );

        const plusResult = await this.executeCandidatePool(
          fallbackReq,
          {
            chain: this.registry.getCandidateModelsForTier(escalateTier, true),
            tier: escalateTier,
            allowEscalate: false,
            attemptCap: maxFailoverCandidates,
            modelAccess: context?.modelAccess,
            requestedEffort,
            sessionId,
          },
          upstreamEventContext
        );

        if (!plusResult.success || !plusResult.response) {
          if (plusResult.policyDenied) {
            throw Object.assign(
              new Error(`API key model policy denies every '${escalateTier}' candidate model for fallback`),
              { statusCode: 403 }
            );
          }
          throw plusResult.lastError || new Error(`Plus escalation failed for tier '${escalateTier}'`);
        }

        finalResponse = plusResult.response;
        actualTier = escalateTier;
        actualModel = plusResult.modelUsed!;
        // Recompute effort against the actually-served model (same contract
        // as the direct path).
        {
          const r = this.resolveServedEffort(actualModel, requestedEffort);
          actualEffort = r.actualEffort;
          reasoningDegraded = r.degraded;
        }
        failoverOccurred = plusResult.failoverOccurred;
        failoverAttempts = plusResult.failoverAttempts;
        failoverPath = plusResult.failoverPath;
        inplaceRetries += plusResult.inplaceRetries;
        servedAccountPrefix = plusResult.servedAccountPrefix;
      }
    } else {
      // Unified candidate-chain resolution for the direct path. One shape for
      // all entry modes: chain[0] = leader, rest = failover order; escalation
      // and attempt-cap are explicit policy fields (see executeCandidatePool).
      let chain: ModelRegistration[];
      let attemptCap: number;
      let allowEscalate: boolean;
      let poolLabel: string | undefined;

      if (comboId) {
        // Combo: the configured member list IS the chain — leader chosen by
        // the combo's selection strategy (registry.pickComboLeader, breaker-
        // aware), the rest follow config order. No cross-tier escalation: the
        // user's composition is authoritative. Cap = full chain length so
        // long combos are never truncated by retry.failover.maxAttempts.
        const members = this.registry.resolveCombo(comboId);
        const leader = members.length > 0 ? this.registry.pickComboLeader(comboId, members) : undefined;
        chain = leader ? [leader, ...members.filter(m => m.id !== leader.id)] : members;
        attemptCap = Math.max(1, chain.length);
        allowEscalate = false;
        poolLabel = `combo '${comboId}'`;
      } else {
        // Auto & explicit: tier pool (peek-filtered; fall back to the full
        // pool when everything is tripped — the loop force-tries the last
        // candidate). Head = pinned model (auto, post-eviction) or the
        // explicit model, so KV-cache affinity is preserved.
        let pool = this.registry.getCandidateModelsForTier(actualTier, true);
        if (pool.length === 0) pool = this.registry.getCandidateModelsForTier(actualTier, false);
        // Bare-auto under a model-access policy: the classifier may land in a
        // tier that holds no admissible model (allow: none whitelisted in that
        // tier; deny: every model of that tier tier-denied) — widen the pool
        // to every allowed model across tiers (chosen tier first, then by
        // tier proximity) instead of failing with a policy 403. "auto"
        // promises SOME allowed model, not a specific tier.
        const accessPolicy = context?.modelAccess;
        const isBareAuto = !normalizedRequest.model || normalizedRequest.model === 'auto' || normalizedRequest.model === 'default';
        if (accessPolicy && isBareAuto && !explicitModel && !comboId) {
          const rank = TIER_RANK;
          const widened = this.registry
            .getAllModels()
            .filter((m) => isModelAllowed(m.id, accessPolicy, m.tier))
            .sort(
              (a, b) =>
                Math.abs((rank[a.tier] ?? 9) - (rank[actualTier] ?? 9)) - Math.abs((rank[b.tier] ?? 9) - (rank[actualTier] ?? 9)) ||
                (rank[a.tier] ?? 9) - (rank[b.tier] ?? 9)
            );
          if (widened.length > 0) pool = widened;
        }
        const head = explicitModel ?? preferredModel;
        chain = head ? [head, ...pool.filter(m => m.id !== head.id)] : pool;
        // Auto keeps the configured failover budget; explicit/combo are
        // bounded by their own chain length (failover.maxAttempts governs
        // auto routing only). Cross-tier escalation is an auto-routing
        // policy — an explicit model fails over within its tier by contract.
        attemptCap = explicitModel ? Math.max(1, chain.length) : maxFailoverCandidates;
        allowEscalate = !explicitModel && tierCrossPolicy === 'allow_escalate' && actualTier === 'lite';
      }

      // Standard Direct Model Execution with Multi-Model Failover & Circuit Breaker
      const execResult = await this.executeCandidatePool(
        normalizedRequest,
        { chain, tier: actualTier, allowEscalate, attemptCap, label: poolLabel, modelAccess: context?.modelAccess, requestedEffort, sessionId },
        upstreamEventContext
      );

      if (!execResult.success || !execResult.response) {
        if (execResult.policyDenied) {
          throw Object.assign(
            new Error(
              `API key model policy (${context?.modelAccess?.mode}) admits no candidate model for this request`
            ),
            { statusCode: 403 }
          );
        }
        throw execResult.lastError || new Error(`Execution failed for tier '${actualTier}'`);
      }

      finalResponse = execResult.response;
      actualModel = execResult.modelUsed!;
      actualTier = execResult.tierUsed!;
      // Recompute `actualEffort` against the model that ACTUALLY served the
      // request — failover may have shifted to a different model than the
      // one `pickModelForEffort` originally picked, with a different effort
      // translation/ceiling. The header / ExecutionResult must reflect reality.
      {
        const r = this.resolveServedEffort(actualModel, requestedEffort);
        actualEffort = r.actualEffort;
        reasoningDegraded = r.degraded;
      }
      failoverOccurred = execResult.failoverOccurred;
      failoverAttempts = execResult.failoverAttempts;
      failoverPath = execResult.failoverPath;
      inplaceRetries = execResult.inplaceRetries;
      servedAccountPrefix = execResult.servedAccountPrefix;

      // Explicit-mode pin write-back: when the explicitly named model itself
      // served the request at the session's current ceiling tier, migrate the
      // session pin onto it — keeps the pin coherent with actually-used
      // models (KV-cache locality) without ever rewriting the client's choice.
      if (
        explicitModel &&
        execResult.modelUsed?.id === explicitModel.id &&
        sessionMode === 'explicit'
      ) {
        const sess = this.sessionManager.getSession(sessionId);
        if (sess && sess.maxTier === explicitModel.tier && sess.pinnedModel !== explicitModel.id) {
          this.sessionManager.repinModel(sessionId, explicitModel);
        }
      }
    }

    // 6. Post-Turn Registration: Register completed turn prefix fingerprint for zero-header tracking
    // Uses the PRE-compression snapshot (see 2B): clients always resend
    // uncompressed bytes, so the chain must be indexed on original content.
    // Account affinity needs nothing here: executeCandidatePool already
    // persisted the bind/rebind right after the successful call (:894 would
    // only ever see a still-unbound session when no multi-account chain was
    // in play — nothing to bind).
    const assistantContent = finalResponse!.choices[0]?.message?.content || '';
    this.sessionManager.registerCompletedTurn(
      sessionId,
      fingerprintMessages,
      assistantContent,
      context?.clientIp
    );

    // 7. Post-turn observability
    const latencyMs = Date.now() - startTime;

    // Thinking-level observability. Two cases that warrant a warn:
    //   1. Client asked for thinking but the actually-served model can't do
    //      thinking at all — payload builder silently dropped the fields.
    //   2. Client asked for `requested` effort but the served model can only
    //      reach `actualEffort` (downgraded). This is by design (per
    //      operator policy 2026-10), but a separate warn + response header
    //      keeps the client honest about what they got.
    // `wantsThinking` = the client actually wants the model to think, which
    // means they sent a real level (low..max) or an explicit `max_thinking_tokens`.
    // `'none'` is a real effort value meaning "no thinking" — NOT a request
    // for thinking that the model failed to honor. An omitted field is also
    // not a request for thinking (model uses its own default).
    const wantsThinking =
      (normalizedRequest.reasoning_effort != null &&
        normalizedRequest.reasoning_effort !== 'none') ||
      (typeof normalizedRequest.max_thinking_tokens === 'number' && normalizedRequest.max_thinking_tokens > 0);
    // 5-level default: `none` is a client toggle, not a capability.
    const modelEfforts = actualModel.supportedReasoningEfforts
      ?? (actualModel.supportsReasoningEffort ? EFFORT_LADDER : []);
    const supportsAnyThinking = modelEfforts.some((e) => e !== 'none');
    // Both warn paths go through the dedup + rate-limit warn throttle: at
    // QPS a misconfigured pool would otherwise print one warn per request.
    // Key = (condition, model, requested-effort) so operators can pin the
    // exact (model × asked-effort) tuple from a single line, and repeat
    // counts fold into the first line so persistent misconfig is visible
    // without becoming noise.
    const throttle = getWarnThrottle();
    if (wantsThinking && !supportsAnyThinking) {
      const key = `no-capability|${actualModel.id}|${actualModel.wire ?? 'openai'}`;
      throttle.warn(
        key,
        `[ocr] thinking-level request served by '${actualModel.id}' (${actualModel.wire ?? 'openai'} wire) — ` +
          `model has no thinking-effort capability, thinking controls were silently dropped.`
      );
    }
    if (
      reasoningDegraded &&
      requestedEffort !== undefined &&
      actualEffort !== undefined &&
      requestedEffort !== actualEffort
    ) {
      const requestedRank = EFFORT_LADDER.indexOf(requestedEffort);
      const actualRank = EFFORT_LADDER.indexOf(actualEffort);
      const gap = requestedRank - actualRank;
      const key = `downgrade|${actualModel.id}|${requestedEffort}->${actualEffort}`;
      throttle.warn(
        key,
        `[ocr] thinking effort downgraded: client requested '${requestedEffort}', ` +
          `served '${actualEffort}' on model '${actualModel.id}' (gap=${gap} levels, ` +
          `model supports [${modelEfforts.join(', ') || 'none'}])`
      );
    }

    const cachedTokens = PromptOptimizer.extractCachedTokens(finalResponse!.usage);
    this.tracker.record({
      tier: actualTier,
      fallbackOccurred,
      inputTokens: finalResponse!.usage?.prompt_tokens || 0,
      cachedTokens: cachedTokens,
      outputTokens: finalResponse!.usage?.completion_tokens || 0,
      reasoningTokens: finalResponse!.usage?.completion_tokens_details?.reasoning_tokens || 0,
      latencyMs,
    });

    // 7b. Sliding-window accounting (ratelimit engine). A completed
    // generation is ONE terminal fact recorded exactly here — success is the
    // only path that produces usage, and the request slots were already
    // consumed at the gates (inbound: auth preHandler, outbound: dispatch
    // above), so failed turns carry usage: 0 without a second ledger write.
    // Tokens = prompt + completion (cached ⊂ prompt, reasoning ⊂ completion);
    // cost = the same request-time pricing snapshot the trace row records.
    const rlUsage = {
      tokens: (finalResponse!.usage?.prompt_tokens || 0) + (finalResponse!.usage?.completion_tokens || 0),
      costUsd: computeRequestCost(finalResponse!.usage, actualModel.pricing),
    };
    let usageAccountPrefix: string | undefined;
    {
      const rl = getRateLimiter();
      const clientKeyId = captureKeyIdentity(context?.fastifyRequest)?.id;
      if (clientKeyId) rl.recordUsage(apiKeySubject(clientKeyId), rlUsage);
      // The account that SERVED (same chain-head degeneracy as the pool gate,
      // so single-credential providers carry usage too). `servedUsagePrefix`
      // also feeds the trace record below (execution.accountKeyHashPrefix):
      // one credential attribution, two consumers (ratelimit subject + quota
      // pairing).
      const servedUsagePrefix =
        servedAccountPrefix ?? this.registry.getCredentialChain(actualModel.provider)?.[0]?.keyHashPrefix;
      if (servedUsagePrefix) rl.recordUsage(accountSubject(actualModel.provider, servedUsagePrefix), rlUsage);
      usageAccountPrefix = servedUsagePrefix;
    }

    // 8. Active Learning Data Flywheel Collection
    await this.flywheel.record({
      requestId: finalResponse!.id || `req_${Date.now()}`,
      request: normalizedRequest,
      decision,
      tierUsed: actualTier,
      modelUsed: actualModel.id,
      fallbackOccurred,
      fallbackReason,
      latencyMs,
    });

    // 9. Session Trajectory Recording — the traceId is shared with the
    // capture event stream (the OTel traceId sourced from the client request
    // — see resolveTraceId). One id now joins capture events and the trace
    // record, so a console reader can pull both streams by traceId.
    const sharedTraceId = traceId ?? 'unknown';
    const lastUserMsg = normalizedRequest.messages.filter(m => m.role === 'user').pop();
    const userPromptSummary = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content.slice(0, 200)
      : Array.isArray(lastUserMsg?.content)
        ? (lastUserMsg.content.map(p => (p as any).text || '').join(' ')).slice(0, 200)
        : '';

    this.traceTracker.record({
      traceId: sharedTraceId,
      sessionId,
      turnNumber: sessionTurnCount,
      timestamp: startTime,
      // Key attribution on the lightweight session trajectory as well (works
      // even with capture disabled): which application's key drove this turn.
      apiKey: captureKeyIdentity(context?.fastifyRequest),
      request: {
        model: request.model || 'auto',
        userPromptSummary,
        messageCount: normalizedRequest.messages.length,
        hasSystemPrompt: normalizedRequest.messages.some(m => m.role === 'system'),
        hasToolsOrSchema: Boolean(decision.needsSchemaValidation),
        clientHeaders: extractClientHeaders(context?.headers),
      },
      routing: {
        layerUsed: (decision.layerUsed || 'layer0') as any,
        targetTier: actualTier,
        confidence: decision.confidence,
        reason: decision.reason,
        reasonCode: decision.reasonCode,
        reasonParams: decision.reasonParams,
        sessionRatchetApplied: ratchetApplied,
        sessionLookupType: sessionResolve.lookupType,
      },
      execution: {
        modelUsed: actualModel.id,
        provider: actualModel.provider,
        accountKeyHashPrefix: usageAccountPrefix,
        tierUsed: actualTier,
        latencyMs,
        fallbackOccurred,
        fallbackReason,
        failoverOccurred,
        failoverAttempts,
        failoverPath,
        inplaceRetries,
      },
      finops: {
        inputTokens: finalResponse!.usage?.prompt_tokens || 0,
        outputTokens: finalResponse!.usage?.completion_tokens || 0,
        cachedTokens: cachedTokens,
        costUsd: rlUsage.costUsd,
      },
    });

    const breakerState = cbManager.getBreaker(actualModel.id)?.getState() || 'CLOSED';
    // additive keys only — older readers keep reading
    // breakerState alone: when the turn ran in pair mode, expose the serving
    // credential's pair snapshot and the model's availability aggregate.
    const scopedBreakerSnap = servedAccountPrefix ? cbManager.getPairBreaker(actualModel.id, servedAccountPrefix)?.getSnapshot() : undefined;
    const modelAvailability = servedAccountPrefix ? this.registry.modelAvailable(actualModel) : undefined;

    return {
      response: finalResponse!,
      tierUsed: actualTier,
      modelUsed: actualModel.id,
      layerUsed: decision.layerUsed || 'layer0',
      fallbackOccurred,
      fallbackReason,
      failoverOccurred,
      failoverAttempts,
      failoverPath,
      inplaceRetries,
      breakerState,
      servedAccountPrefix,
      scopedBreakerSnap,
      modelAvailability,
      sessionId,
      sessionRatchetApplied: ratchetApplied,
      sessionLookupType: sessionResolve.lookupType,
      traceId: sharedTraceId,
      latencyMs,
      // Reasoning-effort observability — server.ts reads these to set
      // X-OCR-Thinking-{Requested,Actual,Degraded} headers so the client
      // can see whether they got the level they asked for.
      requestedEffort,
      actualEffort,
      reasoningDegraded,
      // Variant observability — route handlers read this to set the
      // X-OCR-Variant header (sibling `base-variant` / `base#variant`).
      variantUsed,
    };
  }

  /**
   * Post-execution contract: translate the client ask through the
   * SERVED model's effortMap (`none` included), clamp to its declared
   * capability, and mirror the client exactly when nothing is in play.
   * `degraded` compares the final value against what the client asked
   * (`undefined` / `'none'` count as the none level).
   */
  private resolveServedEffort(
    model: ModelRegistration,
    requestedEffort: ReasoningEffort | undefined
  ): { actualEffort: ReasoningEffort | undefined; degraded: boolean } {
    const ask = requestedEffort ?? 'none';
    const target = applyEffortMap(model.effortMap, ask);
    if (target === 'none' && ask === 'none') return { actualEffort: requestedEffort, degraded: false };
    const supported = model.supportedReasoningEfforts ?? (model.supportsReasoningEffort ? EFFORT_LADDER : []);
    const actual = target === 'none' ? 'none' : downgradeReasoning(target, supported);
    return {
      actualEffort: actual,
      degraded: EFFORT_LADDER.indexOf(actual) < EFFORT_LADDER.indexOf(ask),
    };
  }

  /**
   * Resilient candidate-chain executor — the single
   * execution path shared by ALL entry modes (auto / explicit model / combo /
   * schema-assertion cascade). Callers resolve a candidate chain + policy
   * fields; this function only runs the loop.
   *
   * Chain contract: chain[0] is the leader (pinned model / explicit model /
   * combo leader), the rest follow failover order. When `allowEscalate` is
   * set (auto lite-tier only), healthy plus-tier models are appended as a
   * cross-tier escalation tail — Strict Anti-Downgrade: plus chains never
   * get lite models appended.
   *
   * Two-Tier Cost-Aware Resilience Architecture:
   * 1. In-Place Retry (Preserve Upstream KV Prompt Cache, Prevent 10x Cost Invalidation):
   *    Transient 5xx / timeouts trigger a fast in-place retry on the SAME candidate model
   *    with backoff + jitter. If the transient blip recovers, 100% of KV cache is retained!
   *    Hard errors (402 Quota Exhausted, 401 Auth) skip in-place retry instantly (0 wasted retries).
   *
   * 2. Hierarchical Failover: proceed across the chain while an untried
   *    candidate remains; the LAST candidate is always force-tried (a breaker
   *    rejection costs nothing upstream — when the whole chain is down this is
   *    the last-resort attempt). `attemptCap` bounds real attempts: the
   *    configured retry.failover.maxAttempts for auto routing, the full chain
   *    length for explicit/combo chains.
   *
   * Breaker gate: canExecuteScoped() here is the ONLY probe-consuming check in
   * the request path — every selection/filtering site uses the non-consuming
   * peek, so HALF_OPEN canary quota is never starved by lookups. Without a
   * selected credential the gate degenerates to the old model-level canExecute.
   *
   * each candidate is served through
   * the session's bound credential (keep while healthy), a FORCED failover
   * move (rebind persisted only after the new account serves), or the
   * deterministic new-session spread. Chain-less / single-credential
   * providers run the exact pre-P3 no-prefix path.
   */
  private async executeCandidatePool(
    request: ChatCompletionRequest,
    opts: {
      chain: ModelRegistration[];
      tier: TierLevel;
      allowEscalate: boolean;
      attemptCap: number;
      label?: string;
      /** Per-key model access policy — candidates outside it are dropped before the loop. */
      modelAccess?: ModelAccessConfig;
      /**
       * The client's ORIGINAL effort ask (undefined = omitted).
       * Each candidate serves through its own effortMap translated from this
       * value and clamped by its declared capability — the request copy
       * executed per candidate carries exactly what gets sent upstream.
       */
      requestedEffort?: ReasoningEffort;
      /**
       * Conversation session for account affinity. Every
       * orchestrator request path passes it; absent = no selection at all (the
       * pre-P3 execution path, kept for non-conversational callers).
       */
      sessionId?: string;
    },
    upstreamEventContext?: UpstreamEventContext
  ): Promise<{
    success: boolean;
    response?: ChatCompletionResponse;
    modelUsed?: ModelRegistration;
    tierUsed?: TierLevel;
    failoverOccurred: boolean;
    failoverAttempts: number;
    failoverPath: string[];
    inplaceRetries: number;
    lastError?: any;
    /** True when the key's model policy left zero admissible candidates. */
    policyDenied?: boolean;
    /** Display-safe keyHash prefix of the account that served (undefined = baked-key path). */
    servedAccountPrefix?: string;
  }> {
    const { tier, allowEscalate, attemptCap, label } = opts;
    const cbManager = this.registry.getCircuitBreakerManager();
    const retryConfig = this.config.retry;
    const inplaceConfig = retryConfig?.inplace;

    const inplaceEnabled = retryConfig?.enabled !== false && inplaceConfig?.enabled !== false;
    const maxInplaceAttempts = inplaceEnabled ? (inplaceConfig?.maxAttempts ?? 1) : 0;
    const backoffMs = inplaceConfig?.backoffMs ?? 200;
    const jitterMs = inplaceConfig?.jitterMs ?? 100;

    // 1. Candidate list = resolved chain (+ cross-tier escalation tail when allowed),
    //    filtered through the key's model-access policy. This is the enforcement
    //    choke point: auto routing, explicit models, combos, schema-assertion
    //    escalation and failover all execute through this pool, so filtering here
    //    covers every entry mode — including tier escalation into denied models.
    let candidateList = [...opts.chain];
    if (allowEscalate) {
      for (const m of this.registry.getCandidateModelsForTier('plus', true)) {
        if (!candidateList.some(c => c.id === m.id)) candidateList.push(m);
      }
    }
    if (opts.modelAccess) {
      candidateList = candidateList.filter((m) => isModelAllowed(m.id, opts.modelAccess, m.tier));
      if (candidateList.length === 0) {
        return {
          success: false,
          failoverOccurred: false,
          failoverAttempts: 0,
          failoverPath: [],
          inplaceRetries: 0,
          lastError: new Error(
            `API key model policy (${opts.modelAccess.mode}) admits none of the ${opts.label ? ` '${opts.label}'` : ` tier '${tier}'`} candidate models`
          ),
          policyDenied: true,
        };
      }
    }

    let lastError: any = null;
    let failoverAttempts = 0;
    let totalInplaceRetries = 0;
    const failoverPath: string[] = [];

    // the affinity session is resolved once (live map
    // object; a bind persisted by THIS call only happens right before the
    // success return, so candidates never read a mid-turn move).
    const affinitySession = opts.sessionId ? this.sessionManager.getSession(opts.sessionId) : undefined;
    const affinityWindowMs =
      this.config.circuitBreaker?.accountAffinity?.cacheTtlMs ?? DEFAULT_ACCOUNT_AFFINITY_CACHE_TTL_MS;

    for (let ci = 0; ci < candidateList.length; ci++) {
      const candidate = candidateList[ci];

      if (failoverAttempts >= attemptCap) {
        break;
      }

      // Per-candidate account selection (Decision 7). The chain belongs to the
      // CANDIDATE's provider — a model failover that crosses providers
      // re-spreads on the new chain (a binding the new provider does not know
      // counts as stale and is force-rebound after the new account serves).
      // No session / no chain / single credential => the prefix stays
      // undefined and every call below degenerates to the pre-P3 model path.
      // The registry's unknown-selector throw is unreachable from here: the
      // resolver only ever returns entries of the live chain (stale-binding
      // recovery happens at this boundary, never as a 500).
      const selection: AccountSelection = opts.sessionId
        ? selectAccount(
            affinitySession,
            candidate,
            this.registry.getCredentialChain(candidate.provider),
            cbManager,
            {
              sessionId: opts.sessionId,
              affinityWindowMs,
              // Rate-limit shaping input (see AccountSelectionCtx.spreadCapped):
              // a peek per chain member, map lookups only — no state consumed.
              spreadCapped: (prefix) =>
                !getRateLimiter().peek(accountSubject(candidate.provider, prefix)).allowed,
              // A capped member the slack filter actually excluded from the
              // landing is a TRIGGERED outbound cap — record it where the
              // shaping lands (never for a kept binding, never on the
              // all-capped re-open).
              onSpreadCapped: (prefix) => {
                const subject = accountSubject(candidate.provider, prefix);
                const verdict = getRateLimiter().peek(subject);
                if (verdict.allowed) return; // defensive — the filter just said capped
                recordRateLimitEvent({
                  direction: 'outbound',
                  kind: 'shaped',
                  subject,
                  rule: verdict.rule,
                  limitedBy: verdict.limitedBy,
                  retryAfterMs: verdict.retryAfterMs,
                  provider: candidate.provider,
                  keyHashPrefix: prefix,
                  note: 'spread selection',
                  noteCode: 'spread',
                });
              },
            }
          )
        : { forcedMove: false, reason: 'no-chain' };
      const accountPrefix = selection.credential?.keyHashPrefix;

      // Operator takedown is absolute — an ADMINISTRATIVE refusal, not a health
      // guess, so it suppresses even the last-candidate force (that force exists
      // to retry through uncertain breaker state; there is nothing uncertain
      // here). Without this the undefined prefix would fall through to the
      // boot-baked key of a credential the operator just parked.
      if (selection.reason === 'all-disabled') {
        lastError = new Error(
          `Every credential of provider '${candidate.provider}' is disabled — taking one down requires re-enabling it in the console`
        );
        continue;
      }

      // Outbound sliding-window gate (`accounts:` overlay) — evaluated BEFORE the
      // breaker gate so an at-cap credential never burns a half-open canary.
      // The chain head stands in when the selector degenerated (single-credential
      // / sessionless paths — the head IS the boot-baked credential registry.execute
      // serves with, registry invariant), so caps fire on one-key providers too.
      // NON-CONSUMING peek: the request slot is taken below only when the call
      // actually proceeds.
      const limitPrefix =
        accountPrefix ?? this.registry.getCredentialChain(candidate.provider)?.[0]?.keyHashPrefix;
      const limitSubject = limitPrefix ? accountSubject(candidate.provider, limitPrefix) : undefined;
      // Deferred cap-override ledger entry for THIS candidate — set at the
      // rate gate, emitted only after the breaker gate confirms the call
      // proceeds (MINOR-3: no "forced" for a call that never went out).
      let forcedPass: ForcedPassRecord | undefined;
      if (limitSubject) {
        const cap = getRateLimiter().peek(limitSubject);
        // KEEP-BOUND IRON LAW: a conversation already bound to this account is
        // never moved off it by a local cap (selection.credential set with no
        // pending bind = the keep branch). Rebinding burns the upstream prompt
        // cache over a shaping hint; cap ≠ failure — the provider's own 429 is
        // the real signal and still flows through the breaker chain unchanged.
        const keepBound = selection.credential !== undefined && selection.bind === undefined;
        if (!cap.allowed && !keepBound && ci < candidateList.length - 1) {
          recordRateLimitEvent({
            direction: 'outbound',
            kind: 'skipped',
            subject: limitSubject,
            rule: cap.rule,
            limitedBy: cap.limitedBy,
            retryAfterMs: cap.retryAfterMs,
            provider: candidate.provider,
            keyHashPrefix: limitPrefix,
            model: candidate.id,
            note: 'failover to next candidate',
            noteCode: 'failover',
          });
          lastError = new Error(
            `Account '${limitPrefix}' rate-limited (${cap.rule}, retry in ${Math.ceil(cap.retryAfterMs / 1000)}s)`
          );
          continue;
        }
        if (!cap.allowed) {
          // At cap but the gate would let the call through anyway — the two
          // policy force-overs (keep-bound session / last candidate). The
          // event is DEFERRED (recorded only once the breaker gate also lets
          // the call proceed): a cap-forced candidate that the breaker then
          // skips must not show a "forced through" in the ledger for a call
          // that never went out (review MINOR-3 — dispatch() below is already
          // post-gate, the window stays honest).
          forcedPass = {
            subject: limitSubject,
            rule: cap.rule,
            limitedBy: cap.limitedBy,
            retryAfterMs: cap.retryAfterMs,
            keyHashPrefix: limitPrefix,
            note: keepBound ? 'keep-bound session' : 'last candidate',
            noteCode: keepBound ? 'keep-bound' : 'last-candidate',
          };
        }
      }

      // Execution gate — position-based skip: drop an unavailable candidate
      // while an untried one remains AFTER it; the last candidate is always
      // attempted (the pool builder already exhausted healthy-only options,
      // and a rejected upstream call is free). With a selected account this is
      // the scoped gate (model peek + pair canary consume); without one (single
      // chain, chain-less, or 'all-unhealthy') it is exactly the old
      // model-level canExecute — the last-candidate force semantics are
      // preserved for every reason the selector returned undefined.
      const check = cbManager.canExecuteScoped(candidate.id, accountPrefix);
      if (!check.allowed && ci < candidateList.length - 1) {
        continue;
      }

      failoverAttempts++;
      failoverPath.push(candidate.id);

      // Consume the outbound request slot now that the call proceeds —
      // forced passes (last candidate / keep-bound at cap) included: the window
      // must reflect what was actually dispatched upstream.
      if (limitSubject) getRateLimiter().dispatch(limitSubject);
      if (forcedPass) {
        recordRateLimitEvent({
          direction: 'outbound',
          kind: 'forced',
          subject: forcedPass.subject,
          rule: forcedPass.rule,
          limitedBy: forcedPass.limitedBy,
          retryAfterMs: forcedPass.retryAfterMs,
          provider: candidate.provider,
          keyHashPrefix: forcedPass.keyHashPrefix,
          model: candidate.id,
          note: forcedPass.note,
          noteCode: forcedPass.noteCode,
        });
      }

      // per-candidate effort translation. Each chain member serves
      // through ITS OWN effortMap (`none` included), clamped by its declared
      // capability — the request copy carries exactly what gets sent (a
      // byte-identical request when nothing is in play).
      let candidateReq = request;
      {
        const ask = opts.requestedEffort ?? 'none';
        const target = applyEffortMap(candidate.effortMap, ask);
        if (!(target === 'none' && ask === 'none')) {
          const supported =
            candidate.supportedReasoningEfforts ?? (candidate.supportsReasoningEffort ? EFFORT_LADDER : []);
          const candidateEffort = target === 'none' ? 'none' : downgradeReasoning(target, supported);
          if (candidateEffort !== request.reasoning_effort) {
            candidateReq = { ...request, reasoning_effort: candidateEffort };
          }
        }
      }

      // In-place retry loop on the SAME candidate model
      let candidateSucceeded = false;
      let candidateResponse: ChatCompletionResponse | undefined = undefined;

      for (let attempt = 0; attempt <= maxInplaceAttempts; attempt++) {
        try {
          candidateResponse = await this.registry.execute(
            candidateReq,
            candidate,
            upstreamEventContext,
            accountPrefix
          );
          // Scope-aware success: undefined prefix degenerates to the exact
          // model recordSuccess of the pre-P3 path.
          cbManager.recordSuccessScoped(candidate.id, accountPrefix, candidate.provider);
          candidateSucceeded = true;
          break; // successfully executed on this candidate!
        } catch (err: any) {
          lastError = err;
          const diagnosis = ErrorClassifier.classify(
            err,
            candidate.id,
            candidate.provider,
            this.config.circuitBreaker,
            this.config.retry
          );
          // The classifier already read the registry-stamped usedCredentialKeyHashPrefix
          // (tripScope + accountSuspect); this call expands the verdict over the
          // diagnosed blast radius when a prefix attributes it, and routes the
          // bare model breaker when not (today's semantics).
          cbManager.recordFailureScoped(candidate.id, diagnosis, candidate.provider, accountPrefix);

          // 1. Client error (400 Bad Request, context length exceeded) -> NEVER retriable, fail immediately
          if (!diagnosis.isRetriable) {
            return {
              success: false,
              failoverOccurred: false,
              failoverAttempts,
              failoverPath,
              inplaceRetries: totalInplaceRetries,
              lastError: err,
            };
          }

          // 2. Can we in-place retry on the SAME candidate model to preserve KV Cache?
          if (diagnosis.isInPlaceRetriable && attempt < maxInplaceAttempts) {
            let sleepMs = backoffMs + Math.random() * jitterMs;
            if (diagnosis.networkCause === 'RATE_LIMIT_BURST' && diagnosis.retryAfterSeconds) {
              sleepMs = Math.max(sleepMs, diagnosis.retryAfterSeconds * 1000);
            }
            await new Promise(resolve => setTimeout(resolve, sleepMs));
            totalInplaceRetries++;
            continue; // retry in-place on this model!
          }

          // 3. In-place retry not applicable (402, long 429, excluded cause, or maxAttempts reached)
          // Break out of in-place loop to failover to next candidate model!
          break;
        }
      }

      if (candidateSucceeded && candidateResponse) {
        // Decision 7 persistence point — the affinity mutation is written ONLY
        // after the chosen account actually served (a speculative bind/rebind
        // would strand the session on an account that never answered):
        //   forced=false -> first-write-wins bind of a fresh session
        //   forced=true  -> rebind after a FORCED failover move (bound pair breaker
        //                   OPEN/SUSPECT, expired window, or stale prefix).
        if (opts.sessionId && selection.bind) {
          if (selection.bind.forced) {
            this.sessionManager.rebindAccount(opts.sessionId, selection.bind.keyHashPrefix);
          } else {
            this.sessionManager.bindAccount(opts.sessionId, selection.bind.keyHashPrefix);
          }
        }
        // The provider published its real wire body through the capture sink
        // before returning — captureOut.upstreamRequest holds the SUCCESSFUL
        // attempt's payload (last write wins across retries).
        return {
          success: true,
          response: candidateResponse,
          modelUsed: candidate,
          tierUsed: candidate.tier,
          failoverOccurred: failoverAttempts > 1,
          failoverAttempts,
          failoverPath,
          inplaceRetries: totalInplaceRetries,
          servedAccountPrefix: accountPrefix,
        };
      }
    }

    // Pool exhausted — record the request that was actually sent to the last
    // attempted candidate (all candidates receive the same request), so failed
    // turns still carry the outbound view for debugging. Zero-attempt failures
    // (empty pool / every candidate skipped by breaker) never wrote anything
    // upstream, so no snapshot is recorded for them.
    return {
      success: false,
      failoverOccurred: failoverAttempts > 1,
      failoverAttempts,
      failoverPath,
      inplaceRetries: totalInplaceRetries,
      lastError: lastError || new Error(`No available models for ${label ?? `tier '${tier}'`}`),
    };
  }
}

