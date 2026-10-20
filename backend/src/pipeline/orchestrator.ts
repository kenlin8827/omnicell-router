import crypto from 'node:crypto';
import path from 'node:path';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { ExecutionResult, ReasoningEffort, EFFORT_LADDER, RoutingDecision, TIER_RANK, TierLevel, downgradeReasoning } from '../types/router.js';
import { ModelRegistration, RouterConfig } from '../config/types.js';
import { PromptOptimizer } from './prompt-optimizer.js';
import { applyCompression } from '../compression/index.js';
import { RouterEngine, routingModeForceTier } from '../router/index.js';
import { hasToolsOrSchema } from '../router/request-traits.js';
import {
  getRouteEntryStore,
  routeEntriesGate,
  promptHashOf,
  normalizePrompt,
  L2_CONFIDENT_THRESHOLD,
} from '../router/route-entries.js';
import { detectRetry, planEscalation, RETRY_MIN_PROMPT_CHARS } from '../router/retry-escalation.js';
import { appendRoutingLedger } from '../router/routing-ledger.js';
import { SchemaAssertion } from '../validator/schema-assertion.js';
import { FallbackContextBuilder } from '../validator/parser.js';
import { ProviderRegistry } from '../providers/registry.js';
import { applyEffortMap } from '../providers/member-match.js';
import { FinOpsTracker } from '../metrics/finops-tracker.js';
import { computeRequestCost } from '../metrics/request-cost.js';
import { getRateLimiter, credentialSubject, apiKeySubject, type Countable } from '../ratelimit/rate-limiter.js';

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
import { SessionManager, SessionResolveResult } from '../session/session-manager.js';
import { getEnvPaths } from '../config/env.js';
import { TraceTracker } from '../trace/tracker.js';
import { CaptureRecorder } from '../capture/recorder.js';
import type { UpstreamEventContext } from '../providers/base.js';
import type { StreamRelay, StreamRoutingFacts } from '../utils/chat-stream.js';
import { emitClientRequest, captureKeyIdentity, setClientExchangeContext, type CaptureClientRequest, type ClientExchangeContext } from '../observability/http-exchange.js';
import { resolveTraceId } from '../observability/trace-id.js';
import { getWarnThrottle } from '../observability/warn-throttle.js';
import { ActiveHealthProber, CircuitBreakerManager, ErrorClassifier } from '../resilience/index.js';
import { ModelAccessConfig, isModelAllowed, isModelAllowedInTiers } from '../auth/model-access.js';
import {
  DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS,
  selectCredential,
  type CredentialSelection,
} from './credential-selection.js';

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
    // Session continuity state (anchors + conversation keys) rides a
    // per-environment snapshot so a gateway restart no longer splits
    // zero-header clients. The file holds content hashes only — no plaintext.
    this.sessionManager =
      sessionManager ||
      new SessionManager(config.session, path.join(getEnvPaths().dataDir, 'sessions.json'));
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

  /**
   * Auto-request routing with the experience table in front of the judge
   * (ADR-0011): an entry hit short-circuits L2 entirely — the table IS a
   * prior judgment. Explicit request tiers (`force_tier`, incl. the
   * mode-forced ones resolved in 1B) skip the table: an explicit choice is a
   * layer0 decision by definition. On an L2 judgment the router behaves
   * exactly as before (judge → plus baseline).
   */
  private async routeAutoDecision(
    request: ChatCompletionRequest,
    judgeCapture: UpstreamEventContext | undefined,
    sessionId: string,
    promptHash: string | undefined
  ): Promise<RoutingDecision> {
    const gate = routeEntriesGate();
    if (gate.enabled !== false && promptHash && !request.router_options?.force_tier) {
      const entry = getRouteEntryStore().hit(promptHash, sessionId);
      if (entry) {
        // The entry's effort is part of the experience; a client-explicit
        // effort always outranks it.
        if (entry.effort && request.reasoning_effort === undefined) {
          request.reasoning_effort = entry.effort;
        }
        appendRoutingLedger({
          kind: 'entry_hit',
          sessionId,
          promptHash,
          detail: { tier: entry.tier, source: entry.source, hits: entry.hitCount },
        });
        return {
          targetTier: entry.tier,
          confidence: entry.confidence,
          reason: `Experience table hit — this prompt previously served at ${entry.tier}`,
          reasonCode: 'entry.hit',
          reasonParams: { tier: entry.tier, source: entry.source, hits: entry.hitCount },
          layerUsed: 'entry',
          needsSchemaValidation: hasToolsOrSchema(request),
        };
      }
    }
    return RouterEngine.routeAsync(
      request,
      this.config.classifier,
      this.registry,
      this.config.systemone?.defaultModel,
      // Judge-call capture identity: the outer turn's trace/session (only
      // exists while the capture master is on). The LAYER 2 JUDGE applies
      // the surface-master chain (systemone.enabled master × l2Decision-
      // Enabled sub) — when off it
      // passes nothing further, so this arg alone changes nothing today.
      judgeCapture
    );
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
    context?: ProcessContext,
    /**
     * Progressive-output relay (see utils/chat-stream). Offered by a transport
     * that can flush SSE bytes as they arrive. The orchestrator USES it only
     * where streaming is legal — same candidate pool, no schema-assertion
     * cascade, a wire with a streaming executor, mock mode off — and silently
     * leaves it unused otherwise, which is always safe because nothing has been
     * written to the client before the first forwarded chunk.
     */
    relay?: StreamRelay
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
      const keyIdentity = captureKeyIdentity(context?.fastifyRequest ?? context?.clientRequest);
      // Resolve ONCE here and hand the result to processInternal: cold-start
      // IDs carry fresh random entropy, so a second resolve of the same
      // request would mint a different ID and split capture from routing.
      preResolvedSession = this.sessionManager.resolveSessionId(snapshotRequest, {
        keyId: keyIdentity?.id,
        headers: context?.headers,
      });
      captureSessionId = preResolvedSession.sessionId;
      // Deterministic conversation key stamped onto EVERY event of the turn:
      // the capture archive can regroup turns even when the volatile session
      // id shifts (content-addressed, never a credential, mirrors the
      // session-manager resolution input exactly).
      const conversationKey = SessionManager.conversationKey(
        snapshotRequest.messages || [],
        keyIdentity?.id
      ) ?? undefined;
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
        conversationKey,
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
        apiKey: keyIdentity,
        conversationKey,
      };
    }

    return await this.processInternal(
      request,
      context,
      preResolvedSession,
      upstreamEventContext,
      captureOutTraceId,
      relay
    );
  }

  /**
   * Complete orchestration workflow:
   * 1. Prompt normalization (canonical order)
   * 2. Zero-header session identification & prefix fingerprinting
   * 3. Multi-Layer hierarchical routing (Layer 0 -> Layer 2)
   * 4. Monotonic Ratchet session state enforcement + Session-Pin Eviction
   * 5. Execution with Circuit Breaker, Transparent Failover & Schema Assertion
   * 6. FinOps accounting
   * 7. Post-turn prefix fingerprint registration
   */
  private async processInternal(
    request: ChatCompletionRequest,
    context?: ProcessContext,
    preResolvedSession?: SessionResolveResult,
    upstreamEventContext?: UpstreamEventContext,
    traceId?: string,
    relay?: StreamRelay
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
          // A live combo id claims this name for the gateway: the combo fork
          // below is the advertised meaning (/v1/models lists the id as a
          // virtual model), and resolving the same name to one physical
          // same-named member would be the single-model billing/model drift
          // the combo fail-fast contract exists to forbid. The physical
          // models stay addressable by their full provider-prefixed id.
          if (bareHits.length > 0 && !this.registry.isCombo(modelName)) {
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
    if (comboByName && this.registry.isComboDisabled(comboByName)) {
      // Fail fast like the empty-member case below: the combo is hidden from
      // /v1/models, so an in-flight client naming it must get a loud 404 —
      // routing it as `auto` would be invisible billing/model drift.
      throw Object.assign(
        new Error(
          `Combo '${comboByName}' is disabled — re-enable it in the console or choose another model.`
        ),
        { statusCode: 404 }
      );
    }
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
    // orchestrator callers might not). The model's FULL membership set is
    // passed so TIER-level entries (auto-lite/auto-plus/...) match exactly
    // as they do in the execution pool filter (executeCandidatePool) — a
    // tier-denied explicit model must not slip through the bare-name/variant
    // resolution paths, and a multi-pool model is admitted when any of its
    // memberships passes.
    if (
      explicitModel &&
      context?.modelAccess &&
      !isModelAllowedInTiers(explicitModel.id, context.modelAccess, this.registry.tiersOf(explicitModel))
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
      this.sessionManager.resolveSessionId(normalizedRequest, {
        keyId: captureKeyIdentity(context?.fastifyRequest ?? context?.clientRequest)?.id,
        headers: context?.headers,
      });
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

    // 2C. Route-entry experience + retry detection (ADR-0011). One normalized
    // prompt hash feeds everything downstream: the experience-table lookup,
    // the repeated-prompt ladder and the ledger. Detection gates on the
    // ≥20-char floor (single-word re-sends are noise); correction observation
    // runs at detection time because it reads the PREVIOUS turn's state
    // before this turn overwrites it.
    const routeGate = routeEntriesGate();
    const routeEntriesOn = routeGate.enabled !== false;
    const lastUserMsgEarly = normalizedRequest.messages.filter((m) => m.role === 'user').pop();
    const lastUserText = typeof lastUserMsgEarly?.content === 'string'
      ? lastUserMsgEarly.content
      : Array.isArray(lastUserMsgEarly?.content)
        ? (lastUserMsgEarly.content.map((p) => (p as any).text || '').join(' ')).trim()
        : '';
    const normalizedPrompt = normalizePrompt(lastUserText ?? '');
    const promptHash = routeEntriesOn && normalizedPrompt ? promptHashOf(normalizedPrompt) : undefined;
    const prevRetryState = this.sessionManager.getSession(sessionId)?.retry;
    const detection =
      routeEntriesOn && normalizedPrompt.length >= RETRY_MIN_PROMPT_CHARS
        ? detectRetry(prevRetryState, promptHash)
        : { isRetry: false, attempt: 0 };
    if (detection.isRetry) {
      appendRoutingLedger({ kind: 'retry_detected', sessionId, promptHash, detail: { attempt: detection.attempt } });
    }
    // Correction write-back: the previous turn escalated, succeeded, and the
    // user moved on to a DIFFERENT prompt — that is the strongest "the
    // escalation worked" signal available (satisfied-and-left never writes
    // back: accepted bounded loss). Human rows are immune inside the store.
    if (
      routeEntriesOn &&
      prevRetryState?.escalated &&
      prevRetryState.lastOutcomeOk === true &&
      prevRetryState.lastPromptHash &&
      promptHash !== prevRetryState.lastPromptHash
    ) {
      getRouteEntryStore().upsert(
        {
          promptHash: prevRetryState.lastPromptHash,
          tier: prevRetryState.lastTierUsed ?? 'plus',
          effort: prevRetryState.lastEffortUsed,
          source: 'correction',
          confidence: 1.0,
          snippet: undefined,
        },
        sessionId
      );
      appendRoutingLedger({
        kind: 'correction',
        sessionId,
        promptHash: prevRetryState.lastPromptHash,
        detail: { tier: prevRetryState.lastTierUsed, effort: prevRetryState.lastEffortUsed },
      });
    }

    // 3. Multi-Layer Hierarchical Router (Layer 0 rules -> experience table ->
    // Layer 2 System One decision -> plus baseline)
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
        }
      : await this.routeAutoDecision(normalizedRequest, upstreamEventContext, sessionId, promptHash);

    // 3B. Retry-escalation proposal (ADR-0011): the repeated-prompt ladder
    // rides ON TOP of the base decision BEFORE the ratchet validates it — a
    // tier step flows through the normal monotonic-ratchet path (upgrade =
    // sanctioned re-pin), an effort step is written into the request's
    // reasoning_effort and clamped by the existing effort machinery. Explicit
    // choices are never escalated (force_tier / named model / combo): the
    // client (or the mode lever) already decided.
    let appliedEscalation = false;
    if (
      routeEntriesOn &&
      routeGate.escalateOnRetry !== false &&
      detection.isRetry &&
      promptHash &&
      !comboId &&
      !explicitModel &&
      !normalizedRequest.router_options?.force_tier
    ) {
      const pinned = (() => {
        const pinnedId = this.sessionManager.getSession(sessionId)?.pinnedModel;
        return pinnedId ? this.registry.getModel(pinnedId) : undefined;
      })();
      const supported = pinned
        ? pinned.supportedReasoningEfforts ?? (pinned.supportsReasoningEffort ? EFFORT_LADDER : undefined)
        : undefined;
      const plan = planEscalation({
        attempt: detection.attempt,
        lastTierUsed: prevRetryState?.lastTierUsed ?? initialDecision.targetTier,
        lastEffortUsed: prevRetryState?.lastEffortUsed,
        pinnedSupportedEfforts: supported,
      });
      if (plan.action === 'effort' && plan.effort) {
        // Same tier, deeper thinking. normalizedRequest.reasoning_effort is
        // read by the effort machinery BELOW — this write must land first.
        normalizedRequest.reasoning_effort = plan.effort;
        initialDecision.reasonParams = { ...(initialDecision.reasonParams ?? {}), retry: 'effort', ...plan.reasonParams };
        appliedEscalation = true;
      } else if (plan.action === 'tier' && plan.tier && (TIER_RANK[plan.tier] ?? 0) > (TIER_RANK[initialDecision.targetTier] ?? 0)) {
        initialDecision.targetTier = plan.tier;
        initialDecision.reason = plan.reason;
        initialDecision.reasonCode = plan.reasonCode;
        initialDecision.reasonParams = { ...(initialDecision.reasonParams ?? {}), retry: 'tier', ...plan.reasonParams };
        appliedEscalation = true;
      }
      if (appliedEscalation) {
        appendRoutingLedger({
          kind: 'escalation',
          sessionId,
          promptHash,
          detail: { action: plan.action, tier: plan.tier, effort: plan.effort, attempt: detection.attempt },
        });
      }
    }

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
      // Bypass never mints a session entity, so getSession reads undefined
      // every turn and stamped every combo request #1 in the console's
      // request-detail table. Dedicated counter instead — display-only
      // bookkeeping, no pin/tier state (ADR-0002).
      sessionTurnCount = this.sessionManager.recordBypassTurn(sessionId);
    } else {
      const ratchetResult = this.sessionManager.applyRatchet(
        sessionId,
        initialDecision,
        // Tier representative for session bookkeeping (pin birth). An
        // explicitly named model IS the representative of its own turn —
        // consulting the pool for it would hard-throw in a pool-less
        // deployment where every registered model is unclassified, even
        // though the request itself is directly callable by design. Bare
        // `auto` keeps resolving through the pool (its empty-pool throw is
        // the honest "add tier members" answer).
        (tier) => explicitModel ?? this.registry.getModelForTier(tier),
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
      //   it. A model MOVED to another tier is NOT evicted: the new tier's
      //   member list claims it, so it still joins that pool (multi-membership
      //   included — eviction fires only when NO pool claims the id).
      //   Hand-configured models (no tierMatch) are reclassification-immune —
      //   member-list edits never evict them; only the denylist or a registry
      //   removal can. Checked with healthyOnly=false so health never
      //   masquerades as config intent (and vice versa below).
      //   HEALTH (runtime reality, model CAPABILITY view —
      //   registry.modelHealthView): evict ONLY at 'unavailable' — the
      //   model breaker hard-OPEN, or every credential pair out of service
      //   as hard-OPEN / credential-SUSPECT / operator-DISABLED, so a full
      //   credential takedown evicts the pin even though the model stays
      //   configured. PARTIAL disablement is not eviction: the credential
      //   dimension handles it (FORCED rebind in credential-selection).
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
          // Credential continuity rides here rather than mutating the binding:
          // the repinned model flows into executeCandidatePool, whose per-
          // candidate selection KEEPS the session binding when the bound
          // prefix exists in the new provider's chain (prefer continuity —
          // same key material, same cache economics), and otherwise treats it
          // as stale and re-spreads with a FORCED rebind persisted after the
          // first success. Explicitly rebinding here to the new chain head
          // would pick an credential the model was never verified against.
        }
      }
    }

    let finalResponse: ChatCompletionResponse;
    // Pre-execution placeholder for the effort machinery below. Placeholder
    // resolution must not consult the tier pool when the request already
    // carries its own model: a combo is the sanctioned way to address
    // pool-less models, and an explicitly named model stays directly
    // callable by design — when every registered model is unclassified the
    // tier lookup hard-throws and would kill both (and the placeholder is
    // overwritten by the executed member after the pool run regardless).
    // The combo's first resolved member is the honestest combo placeholder;
    // the zero-member case fails fast above, so index 0 exists whenever
    // comboId is set. Bare `auto` still resolves through the pool — its
    // empty-pool throw is the honest "add members on the /tiers page" answer.
    let actualModel: ModelRegistration =
      preferredModel ||
      (comboId ? this.registry.resolveCombo(comboId)[0] : undefined) ||
      explicitModel ||
      this.registry.getModelForTier(actualTier, true);
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
      // NOTE: an explicit choice leaves preferredModel null (pins are a
      // ratchet-mode concept) — explicitModel must be checked here too, or
      // the pick consults the tier pool and hard-throws in a pool-less
      // deployment where nothing is classified.
      if (preferredModel || explicitModel || comboId) return null;
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
      // the model's pool effortMap first (none included), then clamp to what
      // it can serve and write back the truth.
      const target = applyEffortMap(this.registry.effortMapFor(preferredModel, actualTier), requestedEffort ?? 'none');
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
    // the credential (keyHash prefix) that actually served;
    // undefined = legacy no-prefix path (chain-less provider or single key).
    let servedCredentialPrefix: string | undefined = undefined;
    // Streaming decode timing of the committed attempt (pool stamps, converted
    // to ttftMs/genMs below). Two relay-less turns remain: the cascade's lite
    // lead (its output may be discarded wholesale on assertion failure, so no
    // byte may commit) and lite-success cascade turns — their timing stays
    // undefined and the console renders '—'. The escalation leg's response IS
    // the final answer (no re-assertion follows), so it streams exactly like
    // the direct path and stamps timing the same way.
    let poolTiming: { firstChunkAt: number; streamEndAt: number } | undefined = undefined;

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
            const r = this.resolveServedEffort(actualModel, requestedEffort, actualTier);
            actualEffort = r.actualEffort;
            reasoningDegraded = r.degraded;
          }
          failoverOccurred = liteResult.failoverOccurred;
          failoverAttempts = liteResult.failoverAttempts;
          failoverPath = liteResult.failoverPath;
          inplaceRetries += liteResult.inplaceRetries;
          servedCredentialPrefix = liteResult.servedCredentialPrefix;
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
            // The escalation response is final (no re-assertion below), so it
            // streams under the same commit-point contract as the direct path.
            relay: this.config.streaming?.enabled === false ? undefined : relay,
            streamRouting: {
              layerUsed: decision.layerUsed || 'layer0',
              sessionId,
              sessionRatchetApplied: ratchetApplied,
              sessionLookupType: sessionResolve.lookupType,
              traceId: traceId ?? 'unknown',
              requestedEffort,
              variantUsed,
            },
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
          const r = this.resolveServedEffort(actualModel, requestedEffort, actualTier);
          actualEffort = r.actualEffort;
          reasoningDegraded = r.degraded;
        }
        failoverOccurred = plusResult.failoverOccurred;
        failoverAttempts = plusResult.failoverAttempts;
        failoverPath = plusResult.failoverPath;
        inplaceRetries += plusResult.inplaceRetries;
        servedCredentialPrefix = plusResult.servedCredentialPrefix;
        poolTiming = plusResult.timing;
      }
    } else {
      // Unified candidate-chain resolution for the direct path. One shape for
      // all entry modes: chain[0] = leader, rest = failover order; escalation
      // and attempt-cap are explicit policy fields (see executeCandidatePool).
      let chain: ModelRegistration[];
      let attemptCap: number;
      let allowEscalate: boolean;
      let poolLabel: string | undefined;
      let accessTierMode: 'pool' | 'member-home' = 'pool';

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
        // Members are judged by their own home tier for model access / effort
        // translation — the composition spans tiers by design.
        accessTierMode = 'member-home';
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
          // Multi-membership admit: allowed when the id or ANY membership
          // tier passes (allow mode); denied when the id or ANY membership
          // tier is denied (deny mode).
          const widened = this.registry
            .getAllModels()
            .filter((m) => isModelAllowedInTiers(m.id, accessPolicy, this.registry.tiersOf(m)))
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
        {
          chain,
          tier: actualTier,
          accessTierMode,
          allowEscalate,
          attemptCap,
          label: poolLabel,
          modelAccess: context?.modelAccess,
          requestedEffort,
          sessionId,
          // Streaming here and on the cascade's escalation leg (whose response
          // is final). The cascade's LITE lead stays relay-less: it must inspect
          // the full `message.content` before its verdict, and that verdict can
          // re-ask the whole turn on a bigger tier — relaying it would commit
          // output the cascade is about to throw away.
          relay: this.config.streaming?.enabled === false ? undefined : relay,
          streamRouting: {
            layerUsed: decision.layerUsed || 'layer0',
            sessionId,
            sessionRatchetApplied: ratchetApplied,
            sessionLookupType: sessionResolve.lookupType,
            traceId: traceId ?? 'unknown',
            requestedEffort,
            variantUsed,
          },
        },
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
      poolTiming = execResult.timing;
      // Recompute `actualEffort` against the model that ACTUALLY served the
      // request — failover may have shifted to a different model than the
      // one `pickModelForEffort` originally picked, with a different effort
      // translation/ceiling. The header / ExecutionResult must reflect reality.
      {
        const r = this.resolveServedEffort(actualModel, requestedEffort, actualTier);
        actualEffort = r.actualEffort;
        reasoningDegraded = r.degraded;
      }
      failoverOccurred = execResult.failoverOccurred;
      failoverAttempts = execResult.failoverAttempts;
      failoverPath = execResult.failoverPath;
      inplaceRetries = execResult.inplaceRetries;
      servedCredentialPrefix = execResult.servedCredentialPrefix;

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
    // The assistant echo keeps tool_calls — the canonical serializer absorbs
    // the client's resend drift (dropped `type`, re-compacted argument JSON),
    // and a content-only registration made every tool-call boundary of an
    // agent loop unmatchable.
    // Credential affinity needs nothing here: executeCandidatePool already
    // persisted the bind/rebind right after the successful call (this point
    // would only ever see a still-unbound session when no multi-credential chain
    // was in play — nothing to bind).
    this.sessionManager.registerCompletedTurn(
      sessionId,
      fingerprintMessages,
      finalResponse!.choices[0]?.message ?? ''
    );

    // 7. Post-turn observability
    const latencyMs = Date.now() - startTime;

    // Streaming decode timing (industry TTFT/TPS split), from the committed
    // attempt's stamps: ttftMs = process start → first forwarded chunk (the
    // user-perceived time to first token — routing, queueing, prefill AND any
    // failed attempt that preceded the commit all belong here), genMs = first
    // chunk → fully drained stream (the decode window that console decode-TPS
    // divides by). Both undefined when the turn never streamed (buffered
    // execution, relay off, or a relay whose wire had no streaming executor).
    const ttftMs = poolTiming ? poolTiming.firstChunkAt - startTime : undefined;
    const genMs = poolTiming ? poolTiming.streamEndAt - poolTiming.firstChunkAt : undefined;

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
    let usageCredentialPrefix: string | undefined;
    {
      const rl = getRateLimiter();
      const clientKeyId = captureKeyIdentity(context?.fastifyRequest)?.id;
      if (clientKeyId) rl.recordUsage(apiKeySubject(clientKeyId), rlUsage);
      // The credential that SERVED (same chain-head degeneracy as the pool gate,
      // so single-credential providers carry usage too). `servedUsagePrefix`
      // also feeds the trace record below (execution.credentialKeyHashPrefix):
      // one credential attribution, two consumers (ratelimit subject + quota
      // pairing).
      const servedUsagePrefix =
        servedCredentialPrefix ?? this.registry.getCredentialChain(actualModel.provider)?.[0]?.keyHashPrefix;
      if (servedUsagePrefix) rl.recordUsage(credentialSubject(actualModel.provider, servedUsagePrefix), rlUsage);
      usageCredentialPrefix = servedUsagePrefix;
    }

    // 7B. Experience-table writes + retry-state bookkeeping (ADR-0011) —
    // post-success only: a failed turn leaves no trace in either, so a
    // technical resend never reads as a repeated prompt. The l2_confident
    // write records what ACTUALLY served (failover/cascade truth), skipping
    // schema-cascade turns where the lite lead owns the tier decision.
    if (routeEntriesOn && promptHash) {
      const entryStore = getRouteEntryStore();
      if (
        decision.layerUsed === 'layer2' &&
        (decision.confidence ?? 0) >= L2_CONFIDENT_THRESHOLD &&
        !decision.needsSchemaValidation
      ) {
        entryStore.upsert(
          {
            promptHash,
            tier: actualTier,
            effort: actualEffort,
            source: 'l2_confident',
            confidence: decision.confidence,
            snippet: lastUserText ? lastUserText.slice(0, 200) : undefined, // same 200-char display-aid precedent as session attachOrigin
          },
          sessionId
        );
        appendRoutingLedger({
          kind: 'entry_write',
          sessionId,
          promptHash,
          detail: { source: 'l2_confident', tier: actualTier, confidence: decision.confidence },
        });
      }
      this.sessionManager.recordTurnOutcome(sessionId, {
        promptHash,
        tierUsed: actualTier,
        effortUsed: actualEffort,
        escalated: appliedEscalation,
        retryCount: detection.attempt,
      });
    }

    // 8. Session Trajectory Recording — the traceId is shared with the
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
        credentialKeyHashPrefix: usageCredentialPrefix,
        tierUsed: actualTier,
        latencyMs,
        ttftMs,
        genMs,
        fallbackOccurred,
        fallbackReason,
        failoverOccurred,
        failoverAttempts,
        failoverPath,
        inplaceRetries,
        // Thinking-effort observability — the same values ExecutionResult
        // carries onto the X-OCR-Thinking-* headers; recorded per turn so
        // the console's session detail can show requested vs served levels.
        requestedEffort,
        actualEffort,
        reasoningDegraded,
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
    const scopedBreakerSnap = servedCredentialPrefix ? cbManager.getPairBreaker(actualModel.id, servedCredentialPrefix)?.getSnapshot() : undefined;
    const modelAvailability = servedCredentialPrefix ? this.registry.modelAvailable(actualModel) : undefined;

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
      servedCredentialPrefix,
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
   * SERVED model's effort translation for the pool it served from
   * (`none` included), clamp to its declared capability, and mirror the
   * client exactly when nothing is in play. `degraded` compares the final
   * value against what the client asked (`undefined` / `'none'` count as the
   * none level).
   */
  private resolveServedEffort(
    model: ModelRegistration,
    requestedEffort: ReasoningEffort | undefined,
    servedTier: TierLevel
  ): { actualEffort: ReasoningEffort | undefined; degraded: boolean } {
    const ask = requestedEffort ?? 'none';
    const target = applyEffortMap(this.registry.effortMapFor(model, servedTier), ask);
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
   * move (rebind persisted only after the new credential serves), or the
   * deterministic new-session spread. Chain-less / single-credential
   * providers run the exact pre-P3 no-prefix path.
   */
  private async executeCandidatePool(
    request: ChatCompletionRequest,
    opts: {
      chain: ModelRegistration[];
      tier: TierLevel;
      /**
       * How each chain entry derives its model-access tier and effort
       * translation: 'pool' (default) = every entry is judged against THIS
       * tier — virtual auto-* access rules apply pool-wide and the pool's
       * claiming rule supplies the effortMap. 'member-home' = each member is
       * judged by its OWN home tier with its home translation (combo chains:
       * the composition spans tiers by design).
       */
      accessTierMode?: 'pool' | 'member-home';
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
       * Conversation session for credential affinity. Every
       * orchestrator request path passes it; absent = no selection at all (the
       * pre-P3 execution path, kept for non-conversational callers).
       */
      sessionId?: string;
      /**
       * Progressive-output relay from `process()`, already gated for
       * eligibility (config switch, non-assertion path). Present = the client
       * may receive upstream frames as they arrive.
       */
      relay?: StreamRelay;
      /**
       * Routing facts staged to the relay for each candidate attempt, so the
       * transport can flush the X-OCR routing headers with the first forwarded
       * chunk (the candidate is only known inside the pool).
       */
      streamRouting?: StreamRoutingFacts;
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
    /** Display-safe keyHash prefix of the credential that served (undefined = baked-key path). */
    servedCredentialPrefix?: string;
    /**
     * Wall-clock stamps (epoch ms) of the committed attempt's stream, present
     * only when that attempt streamed through the relay: firstChunkAt = first
     * forwarded chunk, streamEndAt = stream fully drained. The orchestrator
     * converts them into the trace's ttftMs/genMs (industry TTFT/TPS split).
     */
    timing?: { firstChunkAt: number; streamEndAt: number };
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
    //    Each entry carries its ACCESS tier (pool tier vs member home tier, see
    //    accessTierMode) and the effort translation that applies to it — a model
    //    holding membership in several tiers translates per serving pool.
    const accessTierOf = (m: ModelRegistration): TierLevel =>
      opts.accessTierMode === 'member-home' ? m.tier : tier;
    let candidateList = opts.chain.map((m) => ({
      model: m,
      accessTier: accessTierOf(m),
      effortMap: this.registry.effortMapFor(m, accessTierOf(m)),
    }));
    if (allowEscalate) {
      for (const m of this.registry.getCandidateModelsForTier('plus', true)) {
        if (!candidateList.some(c => c.model.id === m.id))
          candidateList.push({ model: m, accessTier: 'plus' as TierLevel, effortMap: this.registry.effortMapFor(m, 'plus') });
      }
    }
    if (opts.modelAccess) {
      candidateList = candidateList.filter((e) => isModelAllowed(e.model.id, opts.modelAccess, e.accessTier));
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
      this.config.circuitBreaker?.credentialAffinity?.cacheTtlMs ?? DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS;

    for (let ci = 0; ci < candidateList.length; ci++) {
      const { model: candidate, accessTier: candidateAccessTier, effortMap: candidateEffortMap } = candidateList[ci];

      if (failoverAttempts >= attemptCap) {
        break;
      }

      // Per-candidate credential selection (Decision 7). The chain belongs to the
      // CANDIDATE's provider — a model failover that crosses providers
      // re-spreads on the new chain (a binding the new provider does not know
      // counts as stale and is force-rebound after the new credential serves).
      // No session / no chain / single credential => the prefix stays
      // undefined and every call below degenerates to the pre-P3 model path.
      // The registry's unknown-selector throw is unreachable from here: the
      // resolver only ever returns entries of the live chain (stale-binding
      // recovery happens at this boundary, never as a 500).
      const selection: CredentialSelection = opts.sessionId
        ? selectCredential(
            affinitySession,
            candidate,
            this.registry.getCredentialChain(candidate.provider),
            cbManager,
            {
              sessionId: opts.sessionId,
              affinityWindowMs,
              // Rate-limit shaping input (see CredentialSelectionCtx.spreadCapped):
              // a peek per chain member, map lookups only — no state consumed.
              spreadCapped: (prefix) =>
                !getRateLimiter().peek(credentialSubject(candidate.provider, prefix)).allowed,
              // A capped member the slack filter actually excluded from the
              // landing is a TRIGGERED outbound cap — record it where the
              // shaping lands (never for a kept binding, never on the
              // all-capped re-open).
              onSpreadCapped: (prefix) => {
                const subject = credentialSubject(candidate.provider, prefix);
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
      const credentialPrefix = selection.credential?.keyHashPrefix;

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

      // Outbound sliding-window gate (`credentials:` overlay) — evaluated BEFORE the
      // breaker gate so an at-cap credential never burns a half-open canary.
      // The chain head stands in when the selector degenerated (single-credential
      // / sessionless paths — the head IS the boot-baked credential registry.execute
      // serves with, registry invariant), so caps fire on one-key providers too.
      // NON-CONSUMING peek: the request slot is taken below only when the call
      // actually proceeds.
      const limitPrefix =
        credentialPrefix ?? this.registry.getCredentialChain(candidate.provider)?.[0]?.keyHashPrefix;
      const limitSubject = limitPrefix ? credentialSubject(candidate.provider, limitPrefix) : undefined;
      // Deferred cap-override ledger entry for THIS candidate — set at the
      // rate gate, emitted only after the breaker gate confirms the call
      // proceeds (MINOR-3: no "forced" for a call that never went out).
      let forcedPass: ForcedPassRecord | undefined;
      if (limitSubject) {
        const cap = getRateLimiter().peek(limitSubject);
        // KEEP-BOUND IRON LAW: a conversation already bound to this credential is
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
            `Credential '${limitPrefix}' rate-limited (${cap.rule}, retry in ${Math.ceil(cap.retryAfterMs / 1000)}s)`
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
      // and a rejected upstream call is free). With a selected credential this is
      // the scoped gate (model peek + pair canary consume); without one (single
      // chain, chain-less, or 'all-unhealthy') it is exactly the old
      // model-level canExecute — the last-candidate force semantics are
      // preserved for every reason the selector returned undefined.
      const check = cbManager.canExecuteScoped(candidate.id, credentialPrefix);
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
        const target = applyEffortMap(candidateEffortMap, ask);
        if (!(target === 'none' && ask === 'none')) {
          const supported =
            candidate.supportedReasoningEfforts ?? (candidate.supportsReasoningEffort ? EFFORT_LADDER : []);
          const candidateEffort = target === 'none' ? 'none' : downgradeReasoning(target, supported);
          if (candidateEffort !== request.reasoning_effort) {
            candidateReq = { ...request, reasoning_effort: candidateEffort };
          }
        }
      }

      // Stage this attempt's routing facts BEFORE the call: a relay that gets
      // bytes flushes them with the first forwarded chunk, and only an attempt
      // that actually proceeds can commit any (earlier attempts never got that
      // far, and each later attempt simply overwrites the staged set).
      if (opts.relay) {
        opts.relay.stageRouting({ ...opts.streamRouting, modelUsed: candidate.id, tierUsed: candidateAccessTier });
      }

      // In-place retry loop on the SAME candidate model
      let candidateSucceeded = false;
      let candidateResponse: ChatCompletionResponse | undefined = undefined;
      // Streaming decode timing, per candidate attempt: `firstChunkAt` stamps
      // the first chunk THIS attempt forwards, `streamEndAt` when
      // registry.execute resolves — the SSE body is fully drained by then.
      // The variables need no per-retry reset: any forwarded content chunk has
      // already committed the caller's relay, so a failure after that returns
      // before an in-place retry could run — a retrying attempt always starts
      // with both stamps unset. The wrapper delegates to the caller's relay
      // verbatim; the `committed` getter stays on the ORIGINAL relay (the
      // bytes-to-client boundary).
      let firstChunkAt: number | undefined;
      let streamEndAt: number | undefined;
      const timingRelay: StreamRelay | undefined = opts.relay
        ? {
            stageRouting: (facts) => opts.relay!.stageRouting(facts),
            onChunk: (chunk) => {
              firstChunkAt ??= Date.now();
              opts.relay!.onChunk(chunk);
            },
            get committed() {
              return opts.relay!.committed;
            },
          }
        : undefined;

      for (let attempt = 0; attempt <= maxInplaceAttempts; attempt++) {
        try {
          candidateResponse = await this.registry.execute(
            candidateReq,
            candidate,
            upstreamEventContext,
            credentialPrefix,
            timingRelay
          );
          if (firstChunkAt !== undefined) streamEndAt = Date.now();
          // Scope-aware success: undefined prefix degenerates to the exact
          // model recordSuccess of the pre-P3 path.
          cbManager.recordSuccessScoped(candidate.id, credentialPrefix, candidate.provider);
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
          // (tripScope + credentialSuspect); this call expands the verdict over the
          // diagnosed blast radius when a prefix attributes it, and routes the
          // bare model breaker when not (today's semantics).
          cbManager.recordFailureScoped(candidate.id, diagnosis, candidate.provider, credentialPrefix);

          // COMMIT POINT: bytes already reached the client on this attempt.
          // Neither an in-place retry nor a failover is legal any more — either
          // re-issues the generation, and the client would consume a second copy
          // of a turn it has already seen part of. Stop the pool here; the
          // transport closes the SSE stream without [DONE] (see StreamRelay).
          if (opts.relay?.committed) {
            return {
              success: false,
              failoverOccurred: failoverAttempts > 1,
              failoverAttempts,
              failoverPath,
              inplaceRetries: totalInplaceRetries,
              lastError: err,
            };
          }

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
        // after the chosen credential actually served (a speculative bind/rebind
        // would strand the session on an credential that never answered):
        //   forced=false -> first-write-wins bind of a fresh session
        //   forced=true  -> rebind after a FORCED failover move (bound pair breaker
        //                   OPEN/SUSPECT, expired window, or stale prefix).
        if (opts.sessionId && selection.bind) {
          if (selection.bind.forced) {
            this.sessionManager.rebindCredential(opts.sessionId, selection.bind.keyHashPrefix);
          } else {
            this.sessionManager.bindCredential(opts.sessionId, selection.bind.keyHashPrefix);
          }
        }
        // The provider published its real wire body through the capture sink
        // before returning — captureOut.upstreamRequest holds the SUCCESSFUL
        // attempt's payload (last write wins across retries).
        return {
          success: true,
          response: candidateResponse,
          modelUsed: candidate,
          tierUsed: candidateAccessTier,
          failoverOccurred: failoverAttempts > 1,
          failoverAttempts,
          failoverPath,
          inplaceRetries: totalInplaceRetries,
          servedCredentialPrefix: credentialPrefix,
          timing:
            firstChunkAt !== undefined && streamEndAt !== undefined
              ? { firstChunkAt, streamEndAt }
              : undefined,
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

