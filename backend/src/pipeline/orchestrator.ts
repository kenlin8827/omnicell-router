import path from 'node:path';
import type { CanonicalRequest, CanonicalResponse, StreamEvent, InputItem, MessageItem } from '../ir/types.js';
import { EffortSource, ExecutionResult, ReasoningEffort, EFFORT_LADDER, RoutingDecision, TIER_RANK, TierLevel, downgradeReasoning, effortFromThinkingBudget, modelSupportsEfforts } from '../types/router.js';
import { ModelRegistration, RouterConfig } from '../config/types.js';
import { PromptOptimizer } from './prompt-optimizer.js';
import { repairToolCallPairing } from './tool-pairing.js';
import { applyCompression } from '../compression/index.js';
import { RouterEngine, routingModeForceTier } from '../router/index.js';
import { declaresJsonContract, hasToolsOrSchema } from '../router/request-traits.js';
import {
  getRouteEntryStore,
  routeEntriesGate,
  promptHashOf,
  normalizePrompt,
  L2_CONFIDENT_THRESHOLD,
} from '../router/route-entries.js';
import { scanDirectives, scrubWireDirectives, applyTierDirectives, applyEffortDirectives, type DirectiveScan } from './directives.js';
import { directivesGate } from './directive-gate.js';
import { streamingPosture } from './streaming-posture.js';
import { DEFAULT_LAYER2_EFFORT_FLOOR } from '../config/defaults.js';
import { appendRoutingLedger } from '../router/routing-ledger.js';
import { SchemaAssertion } from '../validator/schema-assertion.js';
import { FallbackContextBuilder } from '../validator/parser.js';
import { ProviderRegistry, type AttemptEgress } from '../providers/registry.js';
import { applyEffortMap } from '../providers/member-match.js';
import { FinOpsTracker } from '../metrics/finops-tracker.js';
import { protocolForWire } from '../providers/vocabulary.js';
import { capabilitiesFor } from '../ir/capabilities.js';
import { IrUnsupportedError } from '../ir/errors.js';
import { computeRequestCost } from '../metrics/request-cost.js';
import {
  getRateLimiter,
  credentialSubject,
  apiKeySubject,
  UPSTREAM_429_DEFAULT_COOLDOWN_MS,
  type Countable,
} from '../ratelimit/rate-limiter.js';

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
import { NO_TURN, type TurnIdentity } from '../capture/turn-boundary.js';

/**
 * One inbound request's identity plus its WRITE-TIME turn boundary. `turn` is
 * allocated once, after the final session binding and before the first event;
 * every capture/emitter/trace consumer copies the same object.
 */
interface RequestIdentity {
  requestId: string;
  clientRequestId?: string;
  turn: TurnIdentity;
}
import { SessionManager, SessionResolveResult } from '../session/session-manager.js';
import { getEnvPaths } from '../config/env.js';
import { TraceTracker } from '../trace/tracker.js';
import { CaptureRecorder } from '../capture/recorder.js';
import type { CaptureKeyIdentity } from '../capture/recorder.js';
import { UpstreamEventContext } from '../observability/upstream-events.js';
import type { StreamRelay, StreamRoutingFacts } from '../utils/stream-relay.js';
import { emitClientRequest, captureKeyIdentity, setClientExchangeContext, type CaptureClientRequest, type ClientExchangeContext } from '../observability/http-exchange.js';
import { resolveClientRequestId, mintRequestId } from '../observability/request-identity.js';
import { getWarnThrottle } from '../observability/warn-throttle.js';
import { recordFailureEvent } from '../observability/failure-events.js';
import { redactUpstreamBody } from '../observability/upstream-body-redaction.js';
import { displayPromptText, firstDisplayText } from '../utils/client-envelope.js';
import { harnessProfileOf, type HarnessProfile } from '../utils/harness-profiles.js';
import { ActiveHealthProber, CircuitBreakerManager, ErrorClassifier } from '../resilience/index.js';
import { ModelAccessConfig, isModelAllowed, isModelAllowedInTiers, tierFromVirtualEntry } from '../auth/model-access.js';
import {
  DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS,
  selectCredential,
  type CredentialSelection,
} from './credential-selection.js';

export interface ProcessContext {
  clientIp?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Inbound wire that produced this request — recorded as session birth metadata. */
  wire?: 'openai-chat' | 'anthropic-messages' | 'openai-responses';
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
   * In-process key identity for entry points that authenticate OUTSIDE the
   * Fastify preHandler (gateway-driven completions bound to a console-picked
   * API key). Capture, trace and rate-limit attribution read it first;
   * Fastify and MITM legs leave it undefined and resolve from the request.
   * `id` + `name` only — the token never reaches this context.
   */
  clientKey?: CaptureKeyIdentity;
  /**
   * Hands the client-exchange context to entry points with no Fastify
   * response lifecycle (the MITM interceptor), so THEY can finalize the
   * capture's gateway-response event when the raw response finishes.
   * Fastify paths finalize inside the Fastify transport adapter's terminal
   * sends instead and never provide this callback.
   */
  onClientExchange?: (ctx: ClientExchangeContext) => void;
  /**
   * The response SHAPE the surface actually writes (client `stream === true`
   * after the C-3 normalization, or `streaming.client.mode: always`). The
   * surface owns that decision — the orchestrator only records it on the
   * trace's request block, so the console can tag the inbound leg without
   * re-deriving the posture. Absent on non-chat entry points = not streamed.
   */
  clientStream?: boolean;
  /**
   * Parsed client-protocol body, used only for the inbound capture event.
   * Session identity and execution keep using the scrubbed IR snapshot.
   */
  clientBody?: unknown;
}

/** Key attribution: the in-process binding wins, else the request's authInfo. */
const keyIdentityOf = (ctx?: ProcessContext): CaptureKeyIdentity | undefined =>
  ctx?.clientKey ?? captureKeyIdentity(ctx?.fastifyRequest ?? ctx?.clientRequest);

/**
 * A pause shorter than this reads as normal streaming rhythm; at or above it
 * the screen is visibly frozen. Defines what the stall ratio counts.
 */
const PERCEIVED_STALL_MS = 1000;

/**
 * Accumulate-only relay for `streaming.upstream.mode: stream` on a turn whose
 * client wants JSON. The executor pool drains the upstream SSE body through
 * it, the registry accumulates the chunks into one `CanonicalResponse`,
 * and the surface then sends that JSON. Nothing reaches the client, so
 * `committed` is permanently false: in-place retries and failover stay legal
 * (re-issuing upstream duplicates no output the client has seen).
 */
/**
 * Upstream status code carried on an arbitrary thrown error, if any — `in`
 * narrowing instead of an unchecked cast, since `lastError` is untyped.
 */
function statusCodeOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  return undefined;
}

/**
 * Gateway-authored error for an exhausted candidate pool. The upstream
 * verdict (402/401/429/5xx) is the GATEWAY's routing state, never the
 * client's problem: agent clients auto-retry 429 but hard-stop on 402, so
 * forwarding an upstream "insufficient balance" wastes models that are
 * still healthy. Two shapes:
 *   - `remaining` non-empty → status 429 when the failure class is
 *     routing-fixable (the client's own backoff retry re-peeks the pool and
 *     lands on a healthy model); other classes keep their truthful status
 *     (a 400 is the request's fault — retries cannot fix it);
 *   - `remaining` empty → truthful status, operator-directed message
 *     (breaker cooldowns are 12h for quota — retrying now cannot help).
 * `remaining` is computed by the caller with a FRESH peek, so trips that
 * happened during the run itself are counted.
 */
function routeExhaustedError(
  routeLabel: string,
  failoverPath: string[],
  lastErr: unknown,
  remaining: ModelRegistration[]
): Error {
  const attemptedPath = failoverPath.join(' → ') || 'none attempted';
  const lastMsg = lastErr instanceof Error ? lastErr.message : 'unknown';
  if (remaining.length > 0) {
    const status = statusCodeOf(lastErr) ?? 0;
    const routingFixable = [401, 402, 429].includes(status) || status >= 500;
    return Object.assign(
      new Error(
        `Route exhausted after ${failoverPath.length} candidate(s) on ${routeLabel} (${attemptedPath}) — last upstream error: ${lastMsg}. ${remaining.length} model(s) on this route are still available; a retry routes to one of them automatically.`
      ),
      { statusCode: routingFixable ? 429 : (statusCodeOf(lastErr) ?? 502) }
    );
  }
  return Object.assign(
    new Error(
      `Every model on ${routeLabel} is cooling down (tried: ${attemptedPath}) — last upstream error: ${lastMsg}. Clear the cooldowns in the console breaker panel or add credentials; retrying will not help until then.`
    ),
    { statusCode: statusCodeOf(lastErr) ?? 502 }
  );
}

const UPSTREAM_SINK_RELAY: StreamRelay = {
  stageRouting: () => { },
  onChunk: () => { },
  get committed() {
    return false;
  },
};

/**
 * True when a streamed chunk puts something on the user's screen: assistant
 * text, a tool-call fragment, or reasoning/thinking text. Role-only openers,
 * finish_reason frames and the trailing usage frame leave the screen unchanged,
 * so they must NOT count as progress — otherwise a silent 8-second pause
 * between two real chunks would be papered over by the frames arriving inside
 * it, which is precisely the stall time this metric exists to expose.
 *
 * Reasoning counts because the relay forwards it VERBATIM (stream-relay.ts —
 * "thinking still streams to the client"). Leaving it out charged a reasoning
 * model's whole thinking phase as one giant pause, so the figure measured the
 * effort setting instead of a freeze. Both wire spellings are accepted: the
 * OpenAI-compatible `reasoning_content` convention the catalog declares, and
 * OpenRouter's plain `reasoning` string delta.
 */
function hasVisibleOutput(event: StreamEvent): boolean {
  if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
    return event.text.length > 0;
  }
  if (event.type === 'response.reasoning.delta' || event.type === 'response.reasoning_summary.delta') {
    return event.text.length > 0;
  }
  if (event.type === 'response.function_call.arguments.delta') return event.argumentsDelta.length > 0;
  return event.type === 'response.output_item.added' && event.item.type === 'tool_call';
}

function responseMessageText(response: CanonicalResponse | null | undefined): string {
  if (!response) return '';
  return response.output.map((item) => item.type === 'message'
    ? item.content.map((part) => part.type === 'text' || part.type === 'refusal' ? part.text : '').join('')
    : '').join('');
}

function messageText(message: MessageItem | undefined): string {
  if (!message) return '';
  return message.content.map((part) =>
    part.type === 'text' || part.type === 'refusal' ? part.text : ''
  ).filter(Boolean).join(' ');
}

function lastUserMessage(input: readonly InputItem[]): MessageItem | undefined {
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index]!;
    if (item.type === 'message' && item.role === 'user') return item;
  }
  return undefined;
}

const effortOf = (request: CanonicalRequest): ReasoningEffort | undefined => request.reasoning?.effort;

function setEffort(request: CanonicalRequest, effort: ReasoningEffort): void {
  request.reasoning = { ...request.reasoning, effort };
}

/**
 * Pull a non-sensitive subset of inbound headers for the trace's
 * `clientHeaders` field. Three categories:
 *   - user-agent / accept-language — client fingerprint.
 *   - clientRequestId (x-request-id / x-trace-id / x-correlation-id /
 *     request-id / traceparent) — the caller's correlation value, NOT a
 *     credential and never a key. Authorization / x-api-key / cookies /
 *     anything else are intentionally omitted (raw headers carry API keys).
 *     Fastify surfaces headers as
 * `string | string[] | undefined`; arrays collapse to their first value to
 * keep the field scalar. Returns undefined when nothing matched so the
 * trace stays compact for the common no-headers path.
 */

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

/**
 * First string value of an inbound header (Fastify's surface allows arrays
 * and both case spellings). Display path only — nothing here steers routing.
 */
function pickHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

/**
 * Self-declared human prompt (envelope layer 0): a client that KNOWS which
 * bytes are the human turn states them here instead of asking the gateway to
 * infer it from markup. Adopted verbatim, so a harness whose envelope shape
 * is unguessable is still titled correctly without a profile.
 *
 * Display-only and spoofable by whoever sends it — the value never reaches
 * routing, capture bodies or the upstream request, so the cost of a forged
 * header is one wrong session title.
 */
const PROMPT_HINT_HEADER = 'x-ocr-prompt-hint';

/**
 * Envelope resolution inputs for ONE request: the harness profile scoped from
 * the User-Agent (layer 2, vocabulary) and the self-declared prompt (layer 0,
 * authoritative). Resolved once per request on the display path.
 */
interface EnvelopeHints {
  readonly profile?: HarnessProfile;
  readonly declaredPrompt?: string;
}

/** Display cap every identification aid uses (title, per-turn summary, snippet). */
const DISPLAY_CAP_CHARS = 200;

/** Clip to the display cap with an ellipsis (already-normalized input). */
function clipDisplayText(text: string): string {
  return text.length <= DISPLAY_CAP_CHARS ? text : text.slice(0, DISPLAY_CAP_CHARS - 1) + '…';
}

function envelopeHintsOf(
  headers: Record<string, string | string[] | undefined> | undefined
): EnvelopeHints {
  const declared = pickHeaderValue(headers, PROMPT_HINT_HEADER);
  return {
    profile: harnessProfileOf(pickHeaderValue(headers, 'user-agent')),
    // Declared text is the human's own words: whitespace is flattened for the
    // one-line surfaces, never stripped of markup or truncated mid-tag.
    declaredPrompt: declared ? clipDisplayText(declared.replace(/\s+/g, ' ').trim()) || undefined : undefined,
  };
}

function extractClientHeaders(
  headers?: Record<string, string | string[] | undefined>
): { userAgent?: string; acceptLanguage?: string; clientRequestId?: string } | undefined {
  if (!headers) return undefined;
  const pick = (key: string): string | undefined => {
    const v = headers[key] ?? headers[key.toLowerCase()];
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v[0];
    return v;
  };
  const ua = pick('user-agent');
  const al = pick('accept-language');
  const rid = resolveClientRequestId({ headers }).clientRequestId;
  if (ua === undefined && al === undefined && rid === undefined) return undefined;
  return {
    ...(ua !== undefined ? { userAgent: ua } : {}),
    ...(al !== undefined ? { acceptLanguage: al } : {}),
    ...(rid !== undefined ? { clientRequestId: rid } : {}),
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
   * The pool a model serves from, derived from its HOME tier — the single-tier
   * question "is this pinned model still config-intended?". A model with no
   * home tier serves from NO pool (empty list): every pool filters it out, so
   * a pin on it is config-evicted and falls through to the ordinary
   * replacement path. Callers must not treat the empty list as "tier down";
   * that judgement belongs to `getModelForTier`.
   */
  private poolOfHomedModel(model: ModelRegistration): ModelRegistration[] {
    return model.tier ? this.registry.getCandidateModelsForTier(model.tier, false) : [];
  }

  /**
   * Auto-request routing with the experience table in front of the decision layer
   * (ADR-0011): an entry hit short-circuits L2 entirely — the table IS a
   * prior judgment. Explicit request tiers (`forceTier`, incl. the
   * mode-forced ones resolved in 1B) skip the table: an explicit choice is a
   * layer0 decision by definition. On an L2 judgment the router behaves
   * exactly as before (decision layer → plus baseline).
   */
  private async routeAutoDecision(
    request: CanonicalRequest,
    decisionCapture: UpstreamEventContext | undefined,
    sessionId: string,
    promptHash: string | undefined
  ): Promise<RoutingDecision> {
    const gate = routeEntriesGate();
    if (gate.enabled !== false && promptHash && !request.routerOptions?.forceTier) {
      const entry = getRouteEntryStore().hit(promptHash, sessionId);
      if (entry) {
        // The entry's effort is part of the experience; a client-explicit
        // effort always outranks it.
        if (entry.effort && effortOf(request) === undefined) {
          setEffort(request, entry.effort);
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
          needsSchemaValidation: declaresJsonContract(request),
        };
      }
    }
    return RouterEngine.routeAsync(
      request,
      this.config.classifier,
      this.registry,
      this.config.systemone?.defaultModel,
      // Archive label for the decision wire, present only while capture is on.
      // The conversation id itself is `sessionId` above; the decision leg
      // copies it onto events and does not own the session.
      decisionCapture,
      // Failure attribution: decision layer wire failures land in the failure_events
      // ledger tagged with THIS conversation, whatever the capture switch.
      sessionId
    );
  }

  public startProber(): void {
    if (this.healthProber) this.healthProber.start();
  }

  public stopProber(): void {
    if (this.healthProber) this.healthProber.stop();
  }

  /** The health prober's CLAMPED sweep interval (0 when probing is off). */
  public getProberIntervalMs(): number {
    return this.healthProber?.getIntervalMs() ?? 0;
  }

  /** One-shot allocation of the write-time turn identity (ADR-0024). */
  private allocateTurn(sessionId: string, input: readonly InputItem[]): TurnIdentity {
    // Retained traces seed the counter for sessions that predate the v3
    // snapshot; the counter itself is authoritative once present.
    const seed = this.traceTracker
      .getTracesBySession(sessionId)
      .reduce((max, t) => Math.max(max, t.turnIndex ?? 0), 0);
    const a = this.sessionManager.allocateTurnIndex(sessionId, input, seed);
    return {
      turnIndex: a.turnIndex,
      isPromptStart: a.isPromptStart,
      turnDecision: a.turnDecision,
    };
  }

  /**
   * Public entry point. The admission gate scrubs the chain once, resolves
   * the conversation and allocates its turn, before anything else. The rest
   * of the pipeline uses that scrubbed request and that session. Capture,
   * when on, copies the id into the audit log. When it is off, no context
   * is built and no event is written. Captured headers are sanitized
   * (credential values masked in observability/http-exchange.ts).
   */
  public async process(
    request: CanonicalRequest,
    context?: ProcessContext,
    /**
     * Progressive-output relay (see utils/stream-relay). Offered by a transport
     * that can flush SSE bytes as they arrive. The orchestrator USES it only
     * where streaming is legal — same candidate pool, no schema-assertion
     * cascade, a wire with a streaming executor, mock mode off — and silently
     * leaves it unused otherwise, which is always safe because nothing has been
     * written to the client before the first forwarded chunk.
     */
    relay?: StreamRelay
  ): Promise<ExecutionResult> {
    const captureEnabled = this.captureRecorder.isEnabled();

    // Turn identity (ADR-0021), minted ONCE per request:
    //   - `requestId` — the record key / console row id (ours);
    //   - `clientRequestId` — the caller's correlation value (optional, may
    //     repeat across requests; correlation only, never a key).
    // Headers come from the transport that owns the leg: the Fastify leg
    // reads its own request, the MITM leg the original clientRequest headers,
    // then plain `headers` (in-process/test callers).
    const admissionHeaders =
      context?.headers ?? context?.clientRequest?.headers ?? context?.fastifyRequest?.headers;
    const clientRequest = admissionHeaders ? resolveClientRequestId({ headers: admissionHeaders }) : {};
    const turnIdentity: RequestIdentity = {
      requestId: mintRequestId(),
      ...(clientRequest.clientRequestId ? { clientRequestId: clientRequest.clientRequestId } : {}),
      turn: NO_TURN,
    };

    // Conversation identity is the admission gate's job. Cold-start ids carry
    // fresh entropy, so this resolve is the only one for the request;
    // processInternal reuses it. Capture copies the id onto events and does
    // not resolve a second one.
    const gate = directivesGate();
    const normalizedMessages = PromptOptimizer.normalizeMessages(request);
    const snapshotScan = scanDirectives(
      normalizedMessages,
      gate.enabled ? gate.prefix : null,
      request.instructions,
    );
    if (
      snapshotScan.droppedMessages > 0 &&
      !snapshotScan.input.some((item) => item.type === 'message' && item.role === 'user')
    ) {
      throw Object.assign(
        new Error(`Empty prompt — ${gate.prefix}* directives were the only content in the request`),
        { statusCode: 400 }
      );
    }
    const snapshotRequest: CanonicalRequest = {
      ...request,
      input: snapshotScan.input,
      ...(request.instructions !== undefined ? { instructions: snapshotScan.instructions } : {}),
    };
    // A name the gateway will not serve is not a conversation. These throws
    // happen before the session resolve, so a 404 or a policy 403 does not
    // allocate a turn or claim a session.
    const addressed = this.resolveAddressedModel(snapshotRequest, context);
    const keyIdentity = keyIdentityOf(context);
    const admissionRef = SessionManager.clientRefOf(snapshotRequest);
    const preResolvedSession = this.sessionManager.resolveSessionId(snapshotRequest, {
      keyId: keyIdentity?.id,
      headers: admissionHeaders,
      clientRef: admissionRef ?? undefined,
    });
    const admissionSessionId = preResolvedSession.sessionId;
    // ADR-0024: one turn boundary, after the session is bound, before any
    // event. Retries, failover and the decision leg copy it.
    turnIdentity.turn = this.allocateTurn(admissionSessionId, snapshotRequest.input);

    let upstreamEventContext: UpstreamEventContext | undefined;
    if (captureEnabled) {
      // Content-addressed regroup key for the archive only. Not a session id.
      const conversationKey = SessionManager.conversationKey(
        snapshotRequest.input || [],
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
        apiKey: keyIdentity,
        body: scrubWireDirectives(
          context?.clientBody ?? snapshotRequest,
          gate.enabled ? gate.prefix : null
        ),
        sessionId: admissionSessionId,
        clientRequestId: turnIdentity.clientRequestId,
        requestId: turnIdentity.requestId,
        model: request.model || 'auto',
        conversationKey,
        turn: turnIdentity.turn,
      });
      if (context?.fastifyRequest) {
        setClientExchangeContext(context.fastifyRequest, clientExchangeCtx);
      } else if (context?.onClientExchange) {
        context.onClientExchange(clientExchangeCtx);
      }
      upstreamEventContext = new UpstreamEventContext({
        recorder: this.captureRecorder,
        sessionId: admissionSessionId,
        clientRequestId: turnIdentity.clientRequestId,
        requestId: turnIdentity.requestId,
        model: request.model || 'auto',
        // Key attribution: the Fastify leg carries authInfo (attached by the
        // auth preHandler); MITM / master-key legs resolve to undefined and
        // their events simply omit the field — same as before this existed.
        apiKey: keyIdentity,
        conversationKey,
        turn: turnIdentity.turn,
      });
    }

    // Provider-leg transport (streaming.upstream.mode — ADR-0008 §1):
    //   buffered → never hand a relay to the executor pool (the historical
    //              `streaming.enabled: false` rollback);
    //   stream   → hand the wire a relay even when the CLIENT wants JSON, so
    //              the upstream SSE reader runs and the accumulator builds the
    //              response. The sink never writes a byte, so `committed` stays
    //              false and retries/failover remain legal;
    //   follow   → the client's own relay (or none) — historical behavior.
    return await this.processInternal(
      snapshotRequest,
      snapshotScan,
      addressed,
      context,
      preResolvedSession,
      upstreamEventContext,
      turnIdentity,
      this.resolveUpstreamRelay(relay)
    );
  }

  /**
   * Apply `streaming.upstream.mode` to the surface-supplied relay. The sink
   * relay is a module constant: it carries no per-request state (it forwards
   * nothing and never commits), so one instance serves every accumulated
   * turn.
   */
  private resolveUpstreamRelay(relay: StreamRelay | undefined): StreamRelay | undefined {
    const mode = streamingPosture().upstream;
    if (mode === 'buffered') return undefined;
    if (relay) return relay;
    return mode === 'stream' ? UPSTREAM_SINK_RELAY : undefined;
  }

  /**
   * Names the model the client addressed. Throws 404 for an unknown variant
   * or an unusable combo, and 403 when the key's model policy denies an
   * explicit model. A bare name that matches nothing falls through to the
   * classifier. Mutates `request` with the tier and effort that name implies.
   * Does not resolve a session.
   */
  private resolveAddressedModel(
    request: CanonicalRequest,
    context: ProcessContext | undefined,
  ): { explicitModel?: ModelRegistration; variantUsed?: string; comboId?: string } {
    let explicitModel: ModelRegistration | undefined;
    let variantUsed: string | undefined;
    // Routing-name matching trims once. `request.model` itself stays verbatim
    // end-to-end (surface contract: wire/capture bytes and the forwarded copy
    // are never rewritten) — this restores the trim tolerance the old inline
    // /v1/chat handler had before dispatch, and gives both legs (Fastify +
    // MITM, which historically never trimmed) identical matching semantics.
    const modelName = (request.model ?? '').trim();
    const bareTier = tierFromVirtualEntry(modelName);
    if (bareTier) {
      request.routerOptions = { ...request.routerOptions, forceTier: bareTier };
    } else if (modelName && modelName !== 'auto') {
      const specific = this.registry.getModel(modelName);
      if (specific) {
        // Exact-model pass-through: the client named a REGISTERED model id
        // (e.g. pinned via the Client Hub model slots). Route to exactly
        // this model — not merely its tier. Resilience is preserved: in-place
        // same-model retry and credential re-spread still apply; the model
        // itself is never substituted (ADR-0014).
        explicitModel = specific;
        request.routerOptions = { ...request.routerOptions, forceTier: specific.tier };
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
          setEffort(request, variantRef.variant.reasoningEffort);
          request.model = variantRef.base.id;
          request.routerOptions = { ...request.routerOptions, forceTier: variantRef.base.tier };
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
          // failover pool. A full miss falls through to the classifier —
          // ADR-0026 deleted the unresolved-model policy outright, so every
          // leg resolves a name the same way.
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
            request.routerOptions = {
              ...request.routerOptions,
              forceTier: explicitModel.tier,
            };
          }
          // Nothing matched: no policy, no mapping, no fallback. The name
          // falls through to the classifier exactly like a native /v1 caller's
          // would — ADR-0026 deleted the unresolved-model mechanism outright,
          // so the MITM leg has no special posture of its own. A gateway
          // plugin that wants "this name means that model" maps it BEFORE
          // dispatch (it owns the decrypted wire); the pipeline never guesses.
        }
      }
    }

    // Custom model combo: the client named a configured combo id — the
    // combo's member list IS the candidate pool. Tier-pool routing,
    // session ratchet and schema-assertion escalation are all bypassed
    // (explicit user composition wins, mirroring the exact-model
    // pass-through above).
    const comboByName =
      !explicitModel && modelName && this.registry.isCombo(modelName) ? modelName : undefined;
    if (comboByName && this.registry.isComboDisabled(comboByName)) {
      throw Object.assign(
        new Error(
          `Combo '${comboByName}' is disabled — re-enable it in the console or choose another model.`
        ),
        { statusCode: 404 }
      );
    }
    if (comboByName && this.registry.resolveCombo(comboByName).length === 0) {
      throw Object.assign(
        new Error(
          `Combo '${comboByName}' has no registered member models — sync the member providers' model lists (console provider pull) or fix the ids in config.combos; boot logs name every provider excluded for zero models.`
        ),
        { statusCode: 404 }
      );
    }
    const comboId = comboByName ?? undefined;

    // An explicitly named model outside the key's model policy fails loud
    // here (HTTP routes entry-check this too; direct orchestrator callers
    // might not). The model's FULL membership set is passed so TIER-level
    // entries match the execution pool filter.
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
    return { explicitModel, variantUsed, comboId };
  }

  /**
   * Routing and execution after admission. The request is already scrubbed,
   * the addressed model is already accepted, and the session and turn
   * already exist. A rejected request never reaches this function.
   */
  private async processInternal(
    request: CanonicalRequest,
    directiveScan: DirectiveScan,
    addressed: { explicitModel?: ModelRegistration; variantUsed?: string; comboId?: string },
    context: ProcessContext | undefined,
    preResolvedSession: SessionResolveResult,
    upstreamEventContext: UpstreamEventContext | undefined,
    turnIdentity: RequestIdentity,
    relay?: StreamRelay
  ): Promise<ExecutionResult> {
    const clientRequestId = turnIdentity.clientRequestId;
    const requestId = turnIdentity.requestId;
    const startTime = Date.now();

    // Admission already scrubbed this request (ADR-0011). Routing mutates the copy.
    const normalizedRequest = request;
    const directivePrefix = directivesGate().prefix;

    const { explicitModel, variantUsed, comboId } = addressed;

    // 1B. Global routing mode (config.routing.mode) — cost/quality force the tier
    // for auto/tier-alias requests; explicit client choices always win.
    const modeTier = routingModeForceTier(
      normalizedRequest.model,
      normalizedRequest.routerOptions,
      this.config.routing?.mode
    );
    if (modeTier) {
      normalizedRequest.routerOptions = { ...normalizedRequest.routerOptions, forceTier: modeTier };
    }

    // 2. The admission gate resolved this conversation and allocated its turn.
    // clientRef is read again only so the trace row names the ref that was bound.
    const clientRef = SessionManager.clientRefOf(normalizedRequest);
    const sessionId = preResolvedSession.sessionId;
    const requestTurn = turnIdentity.turn;

    // 2B. Snapshot canonical strings before pairing/compression. Session
    // anchors must describe the bytes the client sent, not a compressed or
    // repaired upstream projection. Serialization avoids a deep content clone.
    const fingerprintItems = SessionManager.serializeInput(normalizedRequest.input);

    // Repair unmatched/duplicate tool results after fingerprinting and before
    // any carrier renders the request. Unchanged histories keep their array.
    const pairing = repairToolCallPairing(normalizedRequest.input);
    if (pairing.input !== normalizedRequest.input) {
      console.log(
        `[pipeline:tool-pairing] repaired history: ${pairing.synthesized} missing repl${pairing.synthesized === 1 ? 'y' : 'ies'}, ` +
        `${pairing.duplicates} duplicate repl${pairing.duplicates === 1 ? 'y' : 'ies'}, ` +
        `${pairing.orphans} orphan repl${pairing.orphans === 1 ? 'y' : 'ies'}`
      );
      normalizedRequest.input = pairing.input;
    }
    await applyCompression(normalizedRequest, this.config.compression, sessionId);

    // 2C. Route-entry experience (ADR-0011). One normalized prompt hash feeds
    // the experience-table lookup and write. Directives were scrubbed above, so
    // a directive-bearing turn hashes exactly like its directive-free twin —
    // no double rows, no prefix drift.
    const routeGate = routeEntriesGate();
    const routeEntriesOn = routeGate.enabled !== false;
    const lastUserText = messageText(lastUserMessage(normalizedRequest.input)).trim();
    const normalizedPrompt = normalizePrompt(lastUserText);
    // A directive-only ("just continue") turn carries no prompt of its own:
    // hashing the previous user message would attribute this turn's outcome to
    // the OLD prompt and let it rewrite that prompt's experience row.
    const promptHash =
      routeEntriesOn && normalizedPrompt && !directiveScan.lastUserDropped
        ? promptHashOf(normalizedPrompt)
        : undefined;

    // 2D. Directive audit: tokens outside the known vocabulary never act, but
    // they must not vanish silently either (a typo reads as "nothing
    // happened" otherwise). Known-but-inapplicable directives are ledgered
    // where their applicability is decided (the explicit-choice gate below).
    const directiveActions = directiveScan.effective.map((h) => h.action);
    for (const unk of directiveScan.unknown) {
      appendRoutingLedger({
        kind: 'directive_unknown',
        sessionId,
        promptHash,
        detail: { token: unk.token, role: unk.role },
      });
    }

    // 3. Multi-Layer Hierarchical Router (Layer 0 rules -> experience table ->
    // Layer 2 System One decision -> plus baseline)
    // Combo requests bypass the classifier entirely: the combo id IS the
    // explicit routing decision; targetTier here is a placeholder — the
    // executed member's real tier overwrites it after the pool run.
    //
    // ADR-0012 honesty snapshot: the CLIENT's wire value is captured before
    // ANY gateway injection (routeAutoDecision's entry hit, the decision layer
    // injection below, the `@ocr-effort-*` directive, model defaultEffort). The
    // local `requestedEffort` read later is the EFFECTIVE ask the machinery
    // served against; `effortSource` says whose ask it was.
    const clientEffort = effortOf(normalizedRequest);
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

    // Explicit-model honesty: the engine's 'forced' code here reflects the
    // forceTier the 1B resolver INJECTED from the named model's registration
    // (full id / variant / bare name) — the client named a model, not a tier.
    // A dedicated code keeps the trace truthful: `tier` stays in params for
    // tooltips, but the console template carries no {tier} slot, so no tier
    // badge is ever inferred from a registration-table lookup.
    if (explicitModel && initialDecision.reasonCode === 'forced') {
      initialDecision.reasonCode = 'explicit.model';
      initialDecision.reason = `Explicit model '${explicitModel.id}' — routed to the named model, no tier judgment`;
      initialDecision.reasonParams = { model: explicitModel.id, ...(explicitModel.tier ? { tier: explicitModel.tier } : {}) };
    }

    // ADR-0012 §1 + ADR-0011 floor: L2-decided effort joins the request
    // exactly like a route-entry hit — only into an omitted field (the
    // decision layer is only ASKED when the client omitted it, so the guard is
    // belt-and-braces), and it is floored at `classifier.layer2.effortFloor`.
    // Automatic machinery never strips thinking below that on its own; the
    // only lever below the floor is the user's `@ocr-effort-down`.
    if (
      !comboId &&
      initialDecision.layerUsed === 'layer2' &&
      initialDecision.effort &&
      effortOf(normalizedRequest) === undefined
    ) {
      const floor = this.config.classifier?.layer2?.effortFloor ?? DEFAULT_LAYER2_EFFORT_FLOOR;
      const floorRank = EFFORT_LADDER.indexOf(floor);
      const servedEffort =
        EFFORT_LADDER.indexOf(initialDecision.effort) < floorRank ? floor : initialDecision.effort;
      setEffort(normalizedRequest, servedEffort);
      initialDecision.reasonParams = {
        ...(initialDecision.reasonParams ?? {}),
        effort: servedEffort,
        ...(initialDecision.effortConfidence !== undefined ? { effortConfidence: initialDecision.effortConfidence } : {}),
      };
      if (servedEffort !== initialDecision.effort) {
        // Floor clamp is the one silent-quality-loss risk in the L2 effort
        // path — ledger it so the operator can see whose judgement landed.
        appendRoutingLedger({
          kind: 'effort_change',
          sessionId,
          promptHash,
          detail: {
            source: 'l2-decision',
            baseline: 'floor',
            from: initialDecision.effort,
            to: servedEffort,
            floor,
          },
        });
      }
    }

    // Provenance (ADR-0012 §2): whoever first filled the field after the
    // snapshot owns the ask. The entry hit mutates the request INSIDE
    // routeAutoDecision; the decision layer injection lands just above.
    // Directive and model-default writes re-attribute at their own sites below.
    let effortSource: EffortSource | undefined =
      clientEffort !== undefined
        ? 'client'
        : effortOf(normalizedRequest) !== undefined
          ? initialDecision.layerUsed === 'entry'
            ? 'entry'
            : 'l2-decision'
          : undefined;

    // 4. Apply Monotonic Session Ratchet — three session-interaction modes,
    // resolved once here (the unified policy seam for all entry modes):
    // - 'ratchet'  : auto routing — full monotonic ratchet (upgrade allowed,
    //                downgrade intercepted, pin honored)
    // - 'explicit' : a client-authored choice — a named model OR a forced
    //                tier (tier aliases / the global mode lever /
    //                router_options.forceTier). Turn recorded, a higher
    //                proposal still escalates the ceiling, but the session
    //                NEVER rewrites the proposal and the pin is neither
    //                read nor followed — a forced lite must serve lite even
    //                mid-conversation at a plus peak (ADR-0014).
    // - 'bypass'   : combo — no pin read/write, no ceiling raise, the combo
    //                composition IS the decision
    const sessionMode: 'ratchet' | 'explicit' | 'bypass' = comboId
      ? 'bypass'
      : explicitModel || normalizedRequest.routerOptions?.forceTier
        ? 'explicit'
        : 'ratchet';
    let decision: RoutingDecision;
    let ratchetApplied = false;
    let sessionRequestCount: number;
    if (sessionMode === 'bypass') {
      decision = { ...initialDecision, sessionId, sessionRatchetApplied: false, sessionLookupType: preResolvedSession.lookupType };
      // Bypass never mints a session entity, so getSession reads undefined
      // every turn and stamped every combo request #1 in the console's
      // request-detail table. Dedicated counter instead — display-only
      // bookkeeping, no pin/tier state (ADR-0002).
      sessionRequestCount = this.sessionManager.recordBypassTurn(sessionId);
    } else {
      const ratchetResult = this.sessionManager.applyRatchet(
        sessionId,
        initialDecision,
        // Tier representative for session bookkeeping (pin birth). An
        // explicitly named model IS the representative of its own turn —
        // consulting the pool for it would hard-throw in a pool-less
        // deployment where no member list claims any registered model, even
        // though the request itself is directly callable by design. Bare
        // `auto` keeps resolving through the pool (its empty-pool throw is
        // the honest "add tier members" answer).
        (tier) => explicitModel ?? this.registry.getModelForTier(tier),
        { allowIntercept: sessionMode === 'ratchet' }
      );
      decision = ratchetResult.finalDecision;
      decision.sessionId = sessionId;
      decision.sessionRatchetApplied = ratchetResult.ratchetApplied;
      decision.sessionLookupType = preResolvedSession.lookupType;
      ratchetApplied = ratchetResult.ratchetApplied;
      sessionRequestCount = ratchetResult.session.requestCount;
    }

    // Traces already recorded for this session (this turn's trace is written
    // in step 8). Read once: the birth title is re-stamped from them, and the
    // per-turn prompt summary needs the previous message count.
    const prevTraces = this.traceTracker.getTracesBySession(sessionId);

    // Envelope resolution inputs (display only): the harness vocabulary scoped
    // from this request's User-Agent and any self-declared prompt. Headers come
    // from whichever transport owns the leg — same precedence as the trace
    // identity below (Fastify request, MITM client request, plain headers) —
    // and the result is resolved ONCE here for the title, the per-turn summary
    // and the route snippet.
    const envelopeHints = envelopeHintsOf(
      (context?.fastifyRequest?.headers ??
        context?.clientRequest?.headers ??
        context?.headers) as Record<string, string | string[] | undefined> | undefined
    );

    // Session title: the FIRST user message carrying human text, flattened and
    // capped like the capture preview (array content is joined, never dropped —
    // a multimodal opening message must still name the session). Client
    // metadata envelopes are skipped, not quoted: Cursor's agent opens with a
    // standalone `<timestamp>` message or a whole `<user_info>`/`<rules>`/…
    // context bundle, which would otherwise title the session with a clock
    // reading or an OS banner; Claude Code MIXES `<system-reminder>` + a
    // `/clear` record with the human prompt in ONE message (see
    // utils/client-envelope.ts for the four rules and
    // utils/harness-profiles.ts for the scoped vocabulary). Strict runs
    // first so an unrecognized envelope never outranks a later human turn in
    // the same request; only when the whole request carries no recognized
    // human text does the permissive pass keep a tag-only message (a prompt
    // that is itself markup) rather than naming the session nothing. Once
    // written, every later turn copies the birth value verbatim, so the trace
    // ring can evict the birth trace without blanking the console title.
    // Written to two places from this ONE value: the live entity
    // (attachOrigin, below) and the trace (step 8) — a row rebuilt from traces
    // alone has no entity at all.
    const firstUserSummary =
      // A declared prompt (layer 0) is authoritative and outranks inference on
      // every later turn too — but the frozen birth value still wins, because
      // the title is a birth attribute.
      prevTraces[0]?.request.firstUserSummary ??
      envelopeHints.declaredPrompt ??
      (() => {
        const userTexts: string[] = [];
        for (const item of normalizedRequest.input) {
          if (item.type !== 'message' || item.role !== 'user') continue;
          const raw = messageText(item);
          if (raw) userTexts.push(raw);
        }
        // Strict-then-permissive pass lives in the normalizer, shared with the
        // capture-session preview (one derivation, three surfaces).
        return firstDisplayText(userTexts, DISPLAY_CAP_CHARS, { profile: envelopeHints.profile });
      })();

    // Birth metadata: attach once per session (first-write-wins inside the
    // manager), recording the inbound wire, the layer that resolved the id,
    // the client ip and the first-message snippet for UI identification.
    const bornSession = this.sessionManager.getSession(sessionId);
    if (bornSession && bornSession.requestCount === 1) {
      this.sessionManager.attachOrigin(
        sessionId,
        { wire: context?.wire, lookupType: preResolvedSession.lookupType },
        context?.clientIp,
        firstUserSummary
      );
    }

    // 4A. Directives (`<prefix>tier-up` / `<prefix>tier-down`, ADR-0011
    // rewrite) — TIER axis. Deliberately
    // AFTER the ratchet: a directive is a per-turn override, so it must never
    // raise `session.maxTier` or re-pin the session (the turn is the signal's
    // scope). It is also the ONLY legal automatic-path downgrade. Explicit
    // client choices (named model / forced tier / combo) outrank a directive —
    // the client already decided — and say so in the ledger.
    const directivesApplicable = sessionMode === 'ratchet';
    if (!directivesApplicable && directiveScan.effective.length > 0) {
      appendRoutingLedger({
        kind: 'directive_ignored',
        sessionId,
        promptHash,
        detail: { cause: 'explicit_choice', sessionMode, tokens: directiveScan.effective.map((h) => h.token) },
      });
    }
    // `@ocr-continue` (ADR-0011 §4): a content-level directive with NO axis
    // overlay — its entire effect is the directive-only drop upstream (the
    // turn continues the previous assistant reply at the unchanged tier and
    // effort). Ledger it so a promptless turn stays auditable.
    if (directivesApplicable && directiveActions.includes('continue')) {
      appendRoutingLedger({
        kind: 'directive_applied',
        sessionId,
        promptHash,
        detail: { axis: 'continue', token: `${directivePrefix}continue`, changed: false },
      });
    }
    let tierDirectiveChanged = false;
    if (directivesApplicable) {
      const tierDirective = applyTierDirectives(directiveActions, decision.targetTier);
      if (tierDirective.applied) {
        const from = decision.targetTier;
        const suffix = tierDirective.suffix ?? (tierDirective.delta > 0 ? 'tier-up' : 'tier-down');
        const token = `${directivePrefix}${suffix}`;
        decision.targetTier = tierDirective.tier;
        tierDirectiveChanged = tierDirective.changed;
        if (tierDirective.changed) {
          decision.reasonCode = tierDirective.pinned
            ? 'directive.tier_set'
            : tierDirective.delta > 0
              ? 'directive.tier_up'
              : 'directive.tier_down';
          decision.reason = `Directive ${token} — tier ${from} → ${tierDirective.tier}`;
          decision.reasonParams = {
            ...(decision.reasonParams ?? {}),
            directive: tierDirective.pinned ? 'tier_set' : tierDirective.delta > 0 ? 'tier_up' : 'tier_down',
            token,
            direction: tierDirective.direction,
            from,
            to: tierDirective.tier,
            ...(tierDirective.clamped ? { clamped: true } : {}),
          };
        }
        appendRoutingLedger({
          kind: 'directive_applied',
          sessionId,
          promptHash,
          detail: {
            axis: 'tier',
            mode: tierDirective.pinned ? 'pin' : 'step',
            token,
            direction: tierDirective.direction,
            from,
            to: tierDirective.tier,
            delta: tierDirective.delta,
            changed: tierDirective.changed,
            clamped: tierDirective.clamped,
            ...(tierDirective.ignoredSteps > 0
              ? { ignoredSteps: tierDirective.ignoredSteps, ignoredCause: 'pin_wins' }
              : {}),
          },
        });
      }
    }

    let actualTier = decision.targetTier;

    // 4B. Session-Pin Eviction (ratchet mode only — explicit/combo requests
    // have no session pin): when the pinned model is evicted by config intent
    // or by health, hard-switch the session onto a healthy actualTier landing
    // (with write-back). Two orthogonal forces — see the inline contract.
    const cbManager = this.registry.getCircuitBreakerManager();
    let preferredModel: ModelRegistration | null = null;
    // A tier directive moves THIS turn off the session pin on purpose: the pin
    // belongs to the session's baseline (and to the ratchet, which this
    // overlay bypasses), while the directive asks for a different tier right
    // now. Following the pin here would silently serve the old tier and make
    // `@ocr-tier-up/-down` a no-op for every established session. Skipping the
    // block also skips pin eviction/repin for this single turn — the pin is
    // re-evaluated on the next, non-directive turn.
    if (sessionMode === 'ratchet' && !tierDirectiveChanged) {
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
      //   `unclaimed` (no tier member list claims it any more), or the global
      //   denylist (tiers.exclude) vetoes it. A model MOVED to another tier is
      //   NOT evicted: the new tier's member list claims it, so it still joins
      //   that pool (multi-membership included — eviction fires only when NO
      //   pool claims the id).
      //   Hand-configured models (no autoTier stamp) never move
      //   — member-list edits never evict them; only the denylist or a registry
      //   removal can. Checked with healthyOnly=false so health never
      //   masquerades as config intent (and vice versa below).
      //   HEALTH (runtime reality, model CAPABILITY view —
      //   registry.modelHealthView): evict ONLY at 'unavailable' — every
      //   credential tuple out of service
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
          !this.poolOfHomedModel(preferredModel).some((m) => m.id === pinnedId));
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
          // first success. Explicitly rebinding here to the new default credential
          // would pick an credential the model was never verified against.
        }
      }
    } else if (sessionMode === 'explicit' && !explicitModel && normalizedRequest.routerOptions?.forceTier) {
      // Forced-tier turn (ADR-0014): the session pin is followed ONLY when it
      // lives in the forced tier — then following is pure KV affinity (the
      // pin IS a model of the tier the client forced, so serving it cannot
      // cross the contract). A pin in any other tier is neither followed nor
      // rewritten (a forced lite must not be dragged to a plus/ultra pin,
      // and the session's own pin state stays untouched for later auto
      // turns); a zombie id repairs to the forced tier's healthy head.
      const pinnedId = this.sessionManager.getSession(sessionId)?.pinnedModel;
      preferredModel = pinnedId ? this.registry.getModel(pinnedId) ?? null : null;
      // Follow gates: a same-tier pin (pure KV affinity — serving it cannot
      // cross the contract), a pin with NO home tier (nothing to compare
      // against, so the affinity argument does not apply and eviction decides
      // its fate), the EMPTY-tier degraded landing (the pin IS the model
      // getModelForTier degrades to), or a zombie id (repair to the forced
      // tier's healthy head). Anything else — a pin homed in another tier
      // while the forced pool has members — is neither followed nor
      // rewritten (ADR-0014).
      const tierPool = this.registry.getCandidateModelsForTier(actualTier, false);
      const degradeLanding =
        preferredModel !== null &&
        tierPool.length === 0 &&
        this.registry.getModelForTier(actualTier).id === preferredModel.id;
      const unhomed =
        preferredModel !== null && preferredModel.tier === undefined;
      if (
        pinnedId &&
        (preferredModel === null ||
          unhomed ||
          preferredModel.tier === actualTier ||
          degradeLanding)
      ) {
        const configEvicted =
          preferredModel === null ||
          !this.poolOfHomedModel(preferredModel).some((m) => m.id === pinnedId);
        const healthEvicted =
          preferredModel !== null && this.registry.modelHealthView(preferredModel) === 'unavailable';
        if (configEvicted || healthEvicted) {
          const healthyReplacement = this.registry.getModelForTier(actualTier, true);
          if (
            healthyReplacement &&
            healthyReplacement.id !== pinnedId &&
            this.registry.modelAvailable(healthyReplacement).available
          ) {
            this.sessionManager.repinModel(sessionId, healthyReplacement);
            preferredModel = healthyReplacement;
            decision.reasonParams = {
              ...(decision.reasonParams ?? {}),
              repin: configEvicted ? 'config' : 'health',
              repinFrom: pinnedId,
              repinTo: healthyReplacement.id,
            };
          }
        }
      } else {
        preferredModel = null; // pin outside the forced tier — never followed
      }
    }

    let finalResponse!: CanonicalResponse;
    // Pre-execution placeholder for the effort machinery below. Placeholder
    // resolution must not consult the tier pool when the request already
    // carries its own model: a combo is the sanctioned way to address
    // pool-less models, and an explicitly named model stays directly
    // callable by design — when no member list claims any registered model the
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
    // A native token budget (Anthropic `thinking.budget_tokens`, Responses
    // `reasoning.max_tokens`) has no OpenAI-chat spelling. On wires without a
    // native budget field, translate it to the equivalent ladder level BEFORE
    // the default pin / effort matching below, so capability clamps and the
    // X-OCR-Thinking-* headers see it; the budget itself stays on the request
    // for wires that consume it natively.
    const servedWire = actualModel.wire ?? 'openai-chat';
    const budgetTokens = normalizedRequest.reasoning?.budgetTokens;
    if (
      effortOf(normalizedRequest) === undefined &&
      typeof budgetTokens === 'number' &&
      budgetTokens > 0 &&
      servedWire !== 'anthropic-messages' &&
      servedWire !== 'google-gemini' &&
      servedWire !== 'openai-responses'
    ) {
      setEffort(normalizedRequest, effortFromThinkingBudget(budgetTokens));
    }
    if (effortOf(normalizedRequest) === undefined && actualModel.defaultEffort) {
      setEffort(normalizedRequest, actualModel.defaultEffort);
      effortSource = 'default'; // ADR-0012: the model pin owns the ask
    }

    // Effort directives (`<prefix>effort-up` / `<prefix>effort-down`,
    // ADR-0011 rewrite) — EFFORT axis.
    // Baseline = the effective ask already in play (client value, else the
    // entry/L2 injection, else the model default pinned just above), so the
    // step is relative to what this turn WOULD have served — symmetric with the
    // tier axis, which steps from the post-ratchet decision. Capability-clamped
    // with the same degraded-or-equal rule as everything else. Runs BEFORE the effort matching below so a
    // model pick can honour a raised level. Per-turn: it writes the request
    // for this call only and never records session state.
    if (directivesApplicable) {
      // An EXPLICIT empty support set (a toggle model: `[]` from
      // effortLadderFor) must stay `[]` here — applyEffortDirectives reads it
      // as "no level control, directives are a no-op". modelSupportsEfforts
      // collapses `[]` to undefined (the registry's "cannot serve a mapped
      // level" rule), which would silently re-enable directives on toggle
      // models, so the empty declaration is preserved before the resolution.
      const declared = actualModel.supportedReasoningEfforts;
      const supportedEfforts =
        declared && declared.length === 0
          ? declared
          : modelSupportsEfforts(declared, actualModel.supportsReasoningEffort, actualModel.reasoningDisableable);
      const before = effortOf(normalizedRequest);
      const effortDirective = applyEffortDirectives(directiveActions, before, supportedEfforts, actualModel.reasoningDisableable === false);
      if (effortDirective.applied) {
        const suffix = effortDirective.suffix ?? (effortDirective.delta > 0 ? 'effort-up' : 'effort-down');
        const token = `${directivePrefix}${suffix}`;
        if (effortDirective.changed && effortDirective.effort) {
          setEffort(normalizedRequest, effortDirective.effort);
          effortSource = 'directive'; // the user's own instruction owns the ask
          decision.reasonParams = {
            ...(decision.reasonParams ?? {}),
            effort: effortDirective.effort,
            ...(tierDirectiveChanged
              ? {}
              : {
                // A tier directive is the headline reason of its turn; the
                // effort overlay only takes the headline slot when it is the
                // only directive present (otherwise from/to would collide).
                token,
                direction: effortDirective.direction,
                from: before ?? '—',
                to: effortDirective.effort,
              }),
          };
          if (!tierDirectiveChanged) {
            decision.reasonCode = effortDirective.pinned
              ? 'directive.effort_set'
              : effortDirective.delta > 0
                ? 'directive.effort_up'
                : 'directive.effort_down';
            decision.reason = `Directive ${token} — thinking level ${before ?? '—'} → ${effortDirective.effort}`;
          }
        }
        appendRoutingLedger({
          kind: 'directive_applied',
          sessionId,
          promptHash,
          detail: {
            axis: 'effort',
            mode: effortDirective.pinned ? 'pin' : 'step',
            token,
            direction: effortDirective.direction,
            from: before,
            to: effortDirective.effort,
            delta: effortDirective.delta,
            changed: effortDirective.changed,
            clamped: effortDirective.clamped,
            model: actualModel.id,
            ...(effortDirective.ignoredSteps > 0
              ? { ignoredSteps: effortDirective.ignoredSteps, ignoredCause: 'pin_wins' }
              : {}),
          },
        });
      }
    }
    const requestedEffort: ReasoningEffort | undefined = effortOf(normalizedRequest);
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
      if (actualEffort !== undefined && actualEffort !== requestedEffort) {
        setEffort(normalizedRequest, actualEffort);
      }
    } else if (preferredModel) {
      // Explicit model choice / session pin: never re-route, but translate by
      // the model's pool effortMap first (none included), then clamp to what
      // it can serve and write back the truth.
      const supported = modelSupportsEfforts(
        preferredModel.supportedReasoningEfforts,
        preferredModel.supportsReasoningEffort,
        preferredModel.reasoningDisableable
      ) ?? [];
      const alwaysThink = preferredModel.reasoningDisableable === false;
      // ADR-0035: an always-think model with a declared ladder never serves
      // `none`, even for an explicit none ask or an effortMap→none translation.
      const forbidsNone = alwaysThink && supported.length > 0;
      const target = applyEffortMap(this.registry.effortMapFor(preferredModel, actualTier), requestedEffort ?? 'none');
      if (target === 'none' && !forbidsNone) {
        actualEffort = requestedEffort; // nothing in play — mirror exactly
      } else {
        let recomputed = downgradeReasoning(target, supported, alwaysThink);
        // Same contradictory-data rule as resolveServedEffort: an empty resolved
        // ladder on an always-think model never rewrites to the forbidden `none`.
        if (recomputed === 'none' && alwaysThink && supported.length === 0) recomputed = target;
        actualEffort = recomputed;
        reasoningDegraded =
          EFFORT_LADDER.indexOf(recomputed) < EFFORT_LADDER.indexOf(requestedEffort ?? 'none');
        if (recomputed !== requestedEffort) {
          setEffort(normalizedRequest, recomputed);
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
    let poolTiming: { firstChunkAt: number; streamEndAt: number; stalledMs?: number } | undefined = undefined;
    // Upstream transport of the SERVED attempt (registry-reported; ADR-0008
    // §1). Buffered by construction on the cascade's lite lead (it is never
    // given a relay) and whenever `streaming.upstream.mode` is `buffered`.
    let upstreamStream: 'sse' | 'buffered' | undefined = undefined;
    // Outbound egress of the SERVED attempt (ADR-0018). Resolved at the dial
    // (see executeCandidatePool), never at trace time — the proxy config
    // hot-applies, so a read after a long stream can describe a different
    // dial. undefined = unknown (plugin transport / mock), never direct.
    let servedEgress: AttemptEgress | undefined = undefined;

    // 5. Execution with Cascading Fallback & Schema Assertion
    // (lite-lead cascade is skipped for explicit model choices, combos AND
    // forced tiers — the client named exactly what to run. A forced tier is
    // a contract in BOTH directions: no lite-lead downgrade of a forced
    // plus/pro/ultra, no plus escape of a forced lite. ADR-0014.)
    const retryConfig = this.config.retry;
    const failoverEnabled = retryConfig?.enabled !== false && retryConfig?.failover?.enabled !== false;
    const maxFailoverCandidates = failoverEnabled ? (retryConfig?.failover?.maxAttempts ?? 2) : 1;
    const tierCrossPolicy = retryConfig?.failover?.tierCrossPolicy ?? 'allow_escalate';

    if (
      decision.needsSchemaValidation &&
      this.config.fallback.enabled &&
      !request.routerOptions?.disableFallback &&
      !explicitModel &&
      !comboId &&
      !normalizedRequest.routerOptions?.forceTier
    ) {
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

      let liteRes: CanonicalResponse | null = null;
      let assertionPassed = false;
      let assertionError = '';

      if (liteResult.success && liteResult.response) {
        liteRes = liteResult.response;
        const content = responseMessageText(liteRes);

        // Local static AST / Schema assertion (Zero extra LLM cost!)
        const validation = SchemaAssertion.validate(content, normalizedRequest.text?.format);
        if (validation.valid) {
          assertionPassed = true;
          finalResponse = liteRes;
          actualTier = 'lite';
          actualModel = liteResult.modelUsed!;
          // Same post-execution recompute as the direct path — lite failover
          // may have served a model whose translation/capability differs from
          // the tier-pick prediction (helper: map → clamp → mirror).
          {
            const r = this.resolveServedEffort(actualModel, requestedEffort, actualTier, budgetTokens);
            actualEffort = r.actualEffort;
            reasoningDegraded = r.degraded;
          }
          failoverOccurred = liteResult.failoverOccurred;
          failoverAttempts = liteResult.failoverAttempts;
          failoverPath = liteResult.failoverPath;
          inplaceRetries += liteResult.inplaceRetries;
          servedCredentialPrefix = liteResult.servedCredentialPrefix;
          upstreamStream = liteResult.transport;
          servedEgress = liteResult.egress;
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

        const failedContent = responseMessageText(liteRes);
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
            relay,
            streamRouting: {
              layerUsed: decision.layerUsed || 'layer0',
              sessionId,
              sessionRatchetApplied: ratchetApplied,
              sessionLookupType: preResolvedSession.lookupType,
              requestId,
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
          const escErr = plusResult.lastError;
          if (escErr instanceof IrUnsupportedError) throw escErr;
          const accessPolicy = context?.modelAccess;
          const escRemaining = this.registry
            .getCandidateModelsForTier(escalateTier, true)
            .filter(
              (m) =>
                !plusResult.failoverPath.includes(m.id) &&
                (!accessPolicy || isModelAllowedInTiers(m.id, accessPolicy, this.registry.tiersOf(m))),
            );
          throw routeExhaustedError(`escalation tier '${escalateTier}'`, plusResult.failoverPath, escErr, escRemaining);
        }

        finalResponse = plusResult.response;
        actualTier = escalateTier;
        actualModel = plusResult.modelUsed!;
        // Recompute effort against the actually-served model (same contract
        // as the direct path).
        {
          const r = this.resolveServedEffort(actualModel, requestedEffort, actualTier, budgetTokens);
          actualEffort = r.actualEffort;
          reasoningDegraded = r.degraded;
        }
        failoverOccurred = plusResult.failoverOccurred;
        failoverAttempts = plusResult.failoverAttempts;
        failoverPath = plusResult.failoverPath;
        inplaceRetries += plusResult.inplaceRetries;
        servedCredentialPrefix = plusResult.servedCredentialPrefix;
        poolTiming = plusResult.timing;
        upstreamStream = plusResult.transport;
        servedEgress = plusResult.egress;
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
        // Members are decided by their own home tier for model access / effort
        // translation — the composition spans tiers by design.
        accessTierMode = 'member-home';
      } else {
        // Explicit: the named model serves — the chain is [explicitModel] ONLY.
        // Cross-model substitution of a named model is a fidelity breach (the
        // OpenAI wire serves the named model or errors); in-place same-model
        // retry and credential re-spread stay unconditional. A client that
        // WANTS substitution opts in per request via router_options.failover.
        const explicitFailover =
          explicitModel && normalizedRequest.routerOptions?.failover === true;
        const head = explicitModel ?? preferredModel;
        if (explicitModel && !explicitFailover) {
          // The named model IS the contract: a one-model chain, no
          // substitution (ADR-0014). No pool is built at all — nothing to
          // fail over to.
          chain = [explicitModel];
          attemptCap = 1;
        } else {
          // Auto (or an explicit request that opted in via
          // router_options.failover): the tier pool (peek-filtered; fall back
          // to the full pool when everything is tripped — the loop force-tries
          // the last candidate) follows the head, so KV-cache affinity is
          // preserved on the first candidate.
          let pool = this.registry.getCandidateModelsForTier(actualTier, true);
          if (pool.length === 0) pool = this.registry.getCandidateModelsForTier(actualTier, false);
          // Bare-auto under a model-access policy: the classifier may land in a
          // tier that holds no admissible model (allow: none whitelisted in that
          // tier; deny: every model of that tier tier-denied) — widen the pool
          // to every allowed model across tiers (chosen tier first, then by
          // tier proximity) instead of failing with a policy 403. "auto"
          // promises SOME allowed model, not a specific tier.
          const accessPolicy = context?.modelAccess;
          const isBareAuto = !normalizedRequest.model || normalizedRequest.model === 'auto';
          if (accessPolicy && isBareAuto && !explicitModel && !comboId) {
            const rank = TIER_RANK;
            // A model with no home tier ranks BELOW every pool tier — it serves
            // from no pool, so "closest tier" is meaningless; it sorts last
            // rather than being silently ranked as `plus`.
            const rankOf = (m: ModelRegistration): number =>
              (m.tier ? rank[m.tier] : undefined) ?? Number.MAX_SAFE_INTEGER;
            // Multi-membership admit: allowed when the id or ANY membership
            // tier passes (allow mode); denied when the id or ANY membership
            // tier is denied (deny mode).
            const widened = this.registry
              .getAllModels()
              .filter((m) => isModelAllowedInTiers(m.id, accessPolicy, this.registry.tiersOf(m)))
              .sort(
                (a, b) =>
                  Math.abs(rankOf(a) - (rank[actualTier] ?? 9)) - Math.abs(rankOf(b) - (rank[actualTier] ?? 9)) ||
                  rankOf(a) - rankOf(b)
              );
            if (widened.length > 0) pool = widened;
          }
          chain = head ? [head, ...pool.filter(m => m.id !== head.id)] : pool;
          // Auto keeps the configured failover budget; an explicit opt-in is
          // bounded by its own chain length (failover.maxAttempts governs
          // auto routing only). Cross-tier escalation is an AUTO-routing
          // policy — forced tiers never escape their tier.
          attemptCap = explicitModel ? Math.max(1, chain.length) : maxFailoverCandidates;
        }
        allowEscalate =
          !explicitModel &&
          !normalizedRequest.routerOptions?.forceTier &&
          tierCrossPolicy === 'allow_escalate' &&
          actualTier === 'lite';
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
          relay,
          streamRouting: {
            layerUsed: decision.layerUsed || 'layer0',
            sessionId,
            sessionRatchetApplied: ratchetApplied,
            sessionLookupType: preResolvedSession.lookupType,
            requestId,
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
        if (explicitModel && chain.length === 1) {
          // An explicit chain that exhausted without a substitute (failover
          // off — the default) must fail LOUD and name the model: the client
          // asked for exactly this model and deserves to know it did not
          // serve, not a generic tier-level message (mirrors policyDenied).
          const lastErr = execResult.lastError;
          const unsupported = lastErr instanceof IrUnsupportedError;
          throw Object.assign(
            new Error(
              `Explicit model '${explicitModel.id}' did not serve the request (a named model is never substituted; opt in per request with router_options.failover to allow tier-pool failover). Last error: ${lastErr?.message ?? 'unknown'}`
            ),
            {
              statusCode: statusCodeOf(lastErr) ?? 502,
              ...(unsupported ? { name: 'IrUnsupportedError', code: 'unsupported_parameter' } : {}),
            }
          );
        }
        // Pool exhausted with a non-policy failure. The upstream verdict is
        // the GATEWAY's routing state, never the client's problem: agent
        // clients auto-retry 429 but hard-stop on 402, so a forwarded
        // "insufficient balance" wastes models that are still healthy.
        // Two gateway-authored shapes:
        //   - untried healthy models remain  → 429: the client's own backoff
        //     retry re-peeks the pool and lands on one of them, no user
        //     action needed (only routing-fixable classes remap — a 400 is
        //     the request's fault and retries cannot fix it);
        //   - every candidate is cooling down → keep the truthful status,
        //     say what the operator must do (console breaker panel /
        //     credentials).
        // Remaining = the executed CHAIN (covers combo member lists that span
        // tiers, where a tier-peek would read the wrong pool) minus the
        // attempted path, gated by the non-consuming per-model breaker peek —
        // so trips that happened during this very run are counted — and by
        // the key's model-access policy, which the pool filter applied
        // inside executeCandidatePool.
        const lastErr = execResult.lastError;
        if (lastErr instanceof IrUnsupportedError) throw lastErr;
        const accessPolicy = context?.modelAccess;
        const remaining = chain.filter(
          (m) =>
            !execResult.failoverPath.includes(m.id) &&
            this.getCircuitBreakerManager().isAvailable(m.id) &&
            (!accessPolicy || isModelAllowedInTiers(m.id, accessPolicy, this.registry.tiersOf(m))),
        );
        throw routeExhaustedError(comboId ? `combo '${comboId}'` : `tier '${actualTier}'`, execResult.failoverPath, lastErr, remaining);
      }

      finalResponse = execResult.response;
      actualModel = execResult.modelUsed!;
      actualTier = execResult.tierUsed!;
      poolTiming = execResult.timing;
      upstreamStream = execResult.transport;
      servedEgress = execResult.egress;
      // Recompute `actualEffort` against the model that ACTUALLY served the
      // request — failover may have shifted to a different model than the
      // one `pickModelForEffort` originally picked, with a different effort
      // translation/ceiling. The header / ExecutionResult must reflect reality.
      {
        const r = this.resolveServedEffort(actualModel, requestedEffort, actualTier, budgetTokens);
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
      fingerprintItems,
      finalResponse.output,
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
    // Perceived stall ratio numerator: total time the committed stream spent
    // frozen in gaps of ≥ PERCEIVED_STALL_MS. Carried straight through —
    // measured, not derived, so there is no second definition to drift from.
    // The session divides the summed value by its summed decode windows
    // (stallRatio).
    const stalledMs = poolTiming?.stalledMs;

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
    const servedEffort = effortOf(normalizedRequest);
    const wantsThinking =
      (servedEffort != null && servedEffort !== 'none') ||
      (typeof budgetTokens === 'number' && budgetTokens > 0);
    // 5-level default: `none` is a client toggle, not a capability.
    const modelEfforts = modelSupportsEfforts(
      actualModel.supportedReasoningEfforts,
      actualModel.supportsReasoningEffort,
      actualModel.reasoningDisableable
    ) ?? [];
    const supportsAnyThinking = modelEfforts.some((e) => e !== 'none');
    // Both warn paths go through the dedup + rate-limit warn throttle: at
    // QPS a misconfigured pool would otherwise print one warn per request.
    // Key = (condition, model, requested-effort) so operators can pin the
    // exact (model × asked-effort) tuple from a single line, and repeat
    // counts fold into the first line so persistent misconfig is visible
    // without becoming noise.
    const throttle = getWarnThrottle();
    if (wantsThinking && !supportsAnyThinking) {
      const key = `no-capability|${actualModel.id}|${actualModel.wire ?? 'openai-chat'}`;
      throttle.warn(
        key,
        `[ocr] thinking-level request served by '${actualModel.id}' (${actualModel.wire ?? 'openai-chat'} wire) — ` +
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

    const usage = finalResponse.usage;
    const cachedTokens = PromptOptimizer.extractCachedTokens(usage);
    this.tracker.record({
      tier: actualTier,
      fallbackOccurred,
      inputTokens: usage.inputTokens,
      cachedTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
      latencyMs,
    });

    // 7b. Sliding-window accounting (ratelimit engine). A completed
    // generation is ONE terminal fact recorded exactly here — success is the
    // only path that produces usage, and the request slots were already
    // consumed at the gates (inbound: auth preHandler, outbound: dispatch
    // above), so failed turns carry usage: 0 without a second ledger write.
    // Cached tokens are included in input; reasoning tokens in output.
    const rlUsage = {
      tokens: usage.inputTokens + usage.outputTokens,
      costUsd: computeRequestCost(usage, actualModel.pricing),
    };
    let usageCredentialPrefix: string | undefined;
    {
      const rl = getRateLimiter();
      const clientKeyId = keyIdentityOf(context)?.id;
      if (clientKeyId) rl.recordUsage(apiKeySubject(clientKeyId), rlUsage);
      // The credential that SERVED (same default-credential degeneracy as the pool gate,
      // so single-credential providers carry usage too). `servedUsagePrefix`
      // also feeds the trace record below (execution.credentialKeyHashPrefix):
      // one credential attribution, two consumers (ratelimit subject + quota
      // pairing).
      const servedUsagePrefix =
        servedCredentialPrefix ?? this.registry.getCredentialChain(actualModel.provider)?.[0]?.keyHashPrefix;
      if (servedUsagePrefix) rl.recordUsage(credentialSubject(actualModel.provider, servedUsagePrefix), rlUsage);
      usageCredentialPrefix = servedUsagePrefix;
    }

    // 7B. Experience-table write (ADR-0011) — post-success only: a failed turn
    // leaves no trace, so only served truth is learned. The l2_confident write
    // records what ACTUALLY served (failover/cascade truth), skipping
    // schema-cascade turns where the lite lead owns the tier decision.
    // Directives deliberately write NOTHING back: a manual override is an
    // operator/user decision, not statistical experience to bake into routing.
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
            // Display aid only: client metadata envelopes (Cursor's
            // `<timestamp>`, Claude Code's `<system-reminder>`) are dropped so
            // the snippet names the prompt, not a clock reading or harness
            // boilerplate — same 200-char display-aid precedent as the session
            // attachOrigin, same harness profile as the title.
            snippet:
              routeGate.snippetEnabled === false
                ? undefined
                : (envelopeHints.declaredPrompt ??
                  (lastUserText
                    ? clipDisplayText(
                      displayPromptText(lastUserText, { profile: envelopeHints.profile })
                    ) || undefined
                    : undefined)),
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
    }
    // 8. Session Trajectory Recording. The record is keyed by its own
    // `requestId` (ADR-0021); the caller's `clientRequestId` is stored beside
    // it as correlation only, because a caller may reuse one value for every
    // request of a conversation.

    // Display-only prompt text. The write-time boundary decides whether this
    // request opened a turn; a tool-result continuation carries the previous
    // prompt in its history and must not render a duplicate header. Text is
    // never consulted to DECIDE that boundary — `isPromptStart` is.
    const lastUserTextForSummary = messageText(lastUserMessage(normalizedRequest.input));
    const userPromptSummary = requestTurn.isPromptStart
      ? (envelopeHints.declaredPrompt ??
        clipDisplayText(displayPromptText(lastUserTextForSummary, { profile: envelopeHints.profile })))
      : '';

    this.traceTracker.record({
      requestId,
      ...(clientRequestId ? { clientRequestId } : {}),
      sessionId,
      requestNumber: sessionRequestCount,
      turnIndex: requestTurn.turnIndex,
      isPromptStart: requestTurn.isPromptStart,
      turnDecision: requestTurn.turnDecision,
      timestamp: startTime,
      // Key attribution on the lightweight session trajectory as well (works
      // even with capture disabled): which application's key drove this turn.
      apiKey: keyIdentityOf(context),
      request: {
        model: request.model || 'auto',
        userPromptSummary,
        ...(firstUserSummary ? { firstUserSummary } : {}),
        messageCount: normalizedRequest.input.length,
        hasSystemPrompt: Boolean(normalizedRequest.instructions)
          || normalizedRequest.input.some((item) => item.type === 'message' && (item.role === 'system' || item.role === 'developer')),
        hasToolsOrSchema: hasToolsOrSchema(normalizedRequest),
        // Response shape actually written to the client (surface-owned: the
        // C-3-normalized ask, or `client.mode: always` forcing SSE).
        clientStream: context?.clientStream === true,
        // Inbound protocol surface the client addressed (chat / anthropic /
        // responses) — the console's protocol column reads it directly.
        inboundWire: context?.wire as 'openai-chat' | 'anthropic-messages' | 'openai-responses' | undefined,
        clientHeaders: extractClientHeaders(context?.headers),
        ...(clientRef ? { clientRef } : {}),
      },
      routing: {
        layerUsed: (decision.layerUsed || 'layer0') as any,
        targetTier: actualTier,
        confidence: decision.confidence,
        reason: decision.reason,
        reasonCode: decision.reasonCode,
        reasonParams: decision.reasonParams,
        sessionRatchetApplied: ratchetApplied,
        sessionLookupType: preResolvedSession.lookupType,
      },
      execution: {
        modelUsed: actualModel.id,
        provider: actualModel.provider,
        credentialKeyHashPrefix: usageCredentialPrefix,
        tierUsed: actualTier,
        latencyMs,
        // OUTBOUND protocol wire the served attempt ran on (distinct from the
        // inbound surface unless the turn is a passthrough).
        wireKind: actualModel.wire,
        ttftMs,
        genMs,
        stalledMs,
        fallbackOccurred,
        // Provider-leg transport of the served attempt — the OUTBOUND stream
        // tag (ADR-0008 §1). 'sse' with clientStream:false is the accumulate
        // mode: the gateway read a stream and answered in JSON.
        upstreamStream,
        // Outbound egress of the served attempt (ADR-0018 vocabulary), as
        // resolved at the dial. Absent = unknown (legacy row / plugin-owned
        // transport / mock), never read as direct.
        ...(servedEgress
          ? {
              egress: servedEgress.mode,
              ...(servedEgress.mode === 'proxy' ? { egressProxy: servedEgress.origin } : {}),
            }
          : {}),
        fallbackReason,
        failoverOccurred,
        failoverAttempts,
        failoverPath,
        inplaceRetries,
        // Thinking-effort observability — the same values ExecutionResult
        // carries onto the X-OCR-Thinking-* headers; recorded per turn so
        // the console's session detail can show requested vs served levels.
        // effortSource attributes the ask to its author (ADR-0012).
        requestedEffort,
        actualEffort,
        reasoningDegraded,
        effortSource,
      },
      finops: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens,
        costUsd: rlUsage.costUsd,
      },
    });

    const breakerState = cbManager.getSnapshot(actualModel.id)?.state ?? 'CLOSED';
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
      protocolUsed: protocolForWire(actualModel.wire ?? 'openai-chat'),
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
      sessionLookupType: preResolvedSession.lookupType,
      requestId,
      latencyMs,
      ttftMs,
      genMs,
      stalledMs,
      clientStream: context?.clientStream === true,
      upstreamStream,
      // Reasoning-effort observability — server.ts reads these to set
      // X-OCR-Thinking-{Requested,Actual,Degraded} headers so the client
      // can see whether they got the level they asked for.
      requestedEffort,
      actualEffort,
      reasoningDegraded,
      effortSource,
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
  private wireConsumesBudgetNatively(wire?: string): boolean {
    return wire === 'anthropic-messages' || wire === 'google-gemini' || wire === 'openai-responses';
  }

  private resolveServedEffort(
    model: ModelRegistration,
    requestedEffort: ReasoningEffort | undefined,
    servedTier: TierLevel,
    budgetTokens?: number,
  ): { actualEffort: ReasoningEffort | undefined; degraded: boolean } {
    const effectiveRequested =
      requestedEffort ??
      (typeof budgetTokens === 'number' && budgetTokens > 0 && !this.wireConsumesBudgetNatively(model.wire)
        ? effortFromThinkingBudget(budgetTokens)
        : undefined);
    const ask = effectiveRequested ?? 'none';
    const target = applyEffortMap(this.registry.effortMapFor(model, servedTier), ask);
    const supported = modelSupportsEfforts(model.supportedReasoningEfforts, model.supportsReasoningEffort, model.reasoningDisableable) ?? [];
    const alwaysThink = model.reasoningDisableable === false;
    // ADR-0035 absolute withholding: an always-think model with a declared
    // ladder can NEVER serve `none` — not even for an explicit client none-ask
    // or an effortMap that translates to none. It clamps to its lowest rung.
    const forbidsNone = alwaysThink && supported.length > 0;
    if (target === 'none' && ask === 'none' && !forbidsNone) return { actualEffort: effectiveRequested, degraded: false };
    // `downgradeReasoning` carries the always-think floor: a below-floor ask on
    // a model whose vendor forbids thinking-off serves its lowest declared rung,
    // never the `none` that earns a 400 (ADR-0035).
    let actual = target === 'none' && !forbidsNone ? 'none' : downgradeReasoning(target, supported, alwaysThink);
    // Contradictory data: the vendor says always-think but the resolved ladder
    // is EMPTY (e.g. an operator override of only `none`, stripped to []).
    // There is no declared rung to clamp to; minting `none` would write the
    // forbidden thinking-off. Mirror the ask instead and let the vendor's own
    // wire-side clamp / replay be the net — never rewrite to `none` here.
    if (actual === 'none' && alwaysThink && supported.length === 0) {
      actual = ask;
    }
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
   *    length for opt-in/combo chains (an explicit model's chain is ONE — it
   *    is never substituted).
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
    request: CanonicalRequest,
    opts: {
      chain: ModelRegistration[];
      tier: TierLevel;
      /**
       * How each chain entry derives its model-access tier and effort
       * translation: 'pool' (default) = every entry is decided against THIS
       * tier — virtual tier-alias access rules apply pool-wide and the pool's
       * claiming rule supplies the effortMap. 'member-home' = each member is
       * decided by its OWN home tier with its home translation (combo chains:
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
    response?: CanonicalResponse;
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
     * forwarded chunk, streamEndAt = stream fully drained, stalledMs = the time
     * spent in gaps of ≥1 s between visible-output chunks (the perceived
     * stall-ratio numerator). The orchestrator converts them into the trace's
     * ttftMs/genMs/stalledMs.
     */
    timing?: { firstChunkAt: number; streamEndAt: number; stalledMs?: number };
    /**
     * Transport the SERVED attempt used: `'sse'` = the upstream SSE reader
     * ran (whether or not frames also reached the client), `'buffered'` = one
     * buffered provider call. Registry-reported, never inferred from timing.
     */
    transport?: 'sse' | 'buffered';
    /**
     * Outbound egress of the SERVED attempt, resolved immediately before its
     * dial (the proxy config hot-applies, so trace-time resolution could
     * describe a different dial). Undefined = unknown: the transport does not
     * report a dial base (plugin executor) or nothing was dialed (mock).
     */
    egress?: AttemptEgress;
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
    //    `member-home` on a model with NO home tier (it serves from no pool)
    //    falls back to the EXECUTION tier: the candidate is being tried from
    //    this chain, so this chain's tier is the only tier that truthfully
    //    describes the attempt.
    const accessTierOf = (m: ModelRegistration): TierLevel =>
      opts.accessTierMode === 'member-home' ? (m.tier ?? tier) : tier;
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
      // The default credential stands in when the selector degenerated (single-credential
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
        const budgetAsk =
          opts.requestedEffort === undefined &&
          typeof request.reasoning?.budgetTokens === 'number' &&
          request.reasoning.budgetTokens > 0 &&
          !this.wireConsumesBudgetNatively(candidate.wire)
            ? effortFromThinkingBudget(request.reasoning.budgetTokens)
            : undefined;
        const ask = opts.requestedEffort ?? budgetAsk ?? 'none';
        const target = applyEffortMap(candidateEffortMap, ask);
        const supported = modelSupportsEfforts(
          candidate.supportedReasoningEfforts,
          candidate.supportsReasoningEffort,
          candidate.reasoningDisableable
        ) ?? [];
        const candidateAlwaysThink = candidate.reasoningDisableable === false;
        // ADR-0035: an always-think model with a declared ladder never serves
        // `none` — the rewire must run even for an explicit none ask so the
        // upstream payload carries the clamped rung, not the forbidden none.
        const forbidsNone = candidateAlwaysThink && supported.length > 0;
        if (!(target === 'none' && ask === 'none') || forbidsNone) {
          let candidateEffort = target === 'none' && !forbidsNone ? 'none' : downgradeReasoning(target, supported, candidateAlwaysThink);
          if (candidateEffort === 'none' && candidateAlwaysThink && supported.length === 0) {
            candidateEffort = ask;
          }
          if (candidateEffort !== effortOf(request)) {
            candidateReq = {
              ...request,
              reasoning: { ...request.reasoning, effort: candidateEffort },
            };
          }
        }
      }
      // On cross-protocol failover candidates, strip non-portable reasoning
      // signatures / encrypted blobs so long multi-turn threads can still fail over
      // to Chat-only upstreams instead of failing with 400 on the backup model.
      if (
        failoverAttempts > 1 &&
        !capabilitiesFor(protocolForWire(candidate.wire ?? 'openai-chat')).reasoningSignature &&
        candidateReq.input.some((item) => item.type === 'reasoning' && (item.signature !== undefined || item.encrypted !== undefined))
      ) {
        const strippedInput = candidateReq.input.flatMap((item): InputItem[] => {
          if (item.type !== 'reasoning' || (item.signature === undefined && item.encrypted === undefined)) return [item];
          const { signature: _sig, encrypted: _enc, ...rest } = item;
          return rest.text || rest.summary ? [rest] : [];
        });
        candidateReq = { ...candidateReq, input: strippedInput };
      }

      // Stage this attempt's routing facts BEFORE the call: a relay that gets
      // bytes flushes them with the first forwarded chunk, and only an attempt
      // that actually proceeds can commit any (earlier attempts never got that
      // far, and each later attempt simply overwrites the staged set).
      if (opts.relay) {
        opts.relay.stageRouting({
          ...opts.streamRouting,
          modelUsed: candidate.id,
          tierUsed: candidateAccessTier,
          protocolUsed: protocolForWire(candidate.wire ?? 'openai-chat'),
        });
      }

      // In-place retry loop on the SAME candidate model
      let candidateSucceeded = false;
      let candidateResponse: CanonicalResponse | undefined = undefined;
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
      // Perceived stall bookkeeping: the stream's own cadence, not its
      // average. Only chunks that carry VISIBLE output advance `lastVisibleAt`
      // — answer text, tool-call fragments AND reasoning/thinking deltas (all
      // forwarded to the client). A role-only opener, a finish_reason frame or
      // the trailing usage frame produces nothing on the user's screen, so
      // treating them as progress would hide exactly the pause this metric
      // exists to catch — and counting thinking as silence would invent one.
      // Every gap ≥ PERCEIVED_STALL_MS is ADDED UP: the session-level figure
      // is a share of the decode window, which keeps repeated stutters and one
      // long freeze on the same scale (a single maximum cannot).
      let lastVisibleAt: number | undefined;
      let stalledMs: number | undefined;
      // Transport the served attempt actually used (registry-reported, once
      // per attempt). Reset per attempt: a retry re-issues with a fresh tag.
      let transport: 'sse' | 'buffered' | undefined;
      // Outbound egress resolved at THIS attempt's dial (AttemptEgress).
      let attemptEgress: AttemptEgress | undefined;
      const timingRelay: StreamRelay | undefined = opts.relay
        ? {
          stageRouting: (facts) => opts.relay!.stageRouting(facts),
          onTransport: (kind) => {
            transport = kind;
            opts.relay!.onTransport?.(kind);
          },
          onChunk: (chunk) => {
            const now = Date.now();
            firstChunkAt ??= now;
            if (hasVisibleOutput(chunk)) {
              if (lastVisibleAt !== undefined) {
                const gap = now - lastVisibleAt;
                // The first measured gap proves this turn HAS a stream
                // cadence: 0 means "measured and smooth", undefined stays
                // reserved for fewer than two output chunks.
                stalledMs ??= 0;
                if (gap >= PERCEIVED_STALL_MS) stalledMs += gap;
              }
              lastVisibleAt = now;
            }
            return opts.relay!.onChunk(chunk);
          },
          get committed() {
            return opts.relay!.committed;
          },
        }
        : undefined;

      for (let attempt = 0; attempt <= maxInplaceAttempts; attempt++) {
        try {
          // Resolve egress at the dial: the proxy config hot-applies, so a
          // read at trace time could describe a different dial than this one.
          attemptEgress = this.registry.egressFor(candidate);
          candidateResponse = await this.registry.execute(
            candidateReq,
            candidate,
            upstreamEventContext,
            credentialPrefix,
            timingRelay,
            opts.sessionId,
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
          // Breaker accounting is per logical request, NOT per in-place
          // attempt: a retried attempt that eventually succeeds leaves no
          // failure on the breaker, and an abandoned candidate records
          // exactly one failure. Counting every attempt let a single request
          // burn the whole trip threshold by itself (retry amplification).
          // The final attempt's diagnosis is the one recorded — it carries
          // the same registry-stamped usedCredentialKeyHashPrefix
          // (tripScope + credentialSuspect + usedKeyHashPrefix); the manager
          // attributes from `credentialPrefix` OR that stamp, so a
          // credential-fault error cools its credential even when selection
          // returned no prefix (all-unhealthy / no-session): the manager then
          // attributes from the diagnosis stamp itself. Only a chain-less
          // provider (no stamp at all) stays on the sentinel tuple.
          // A committed attempt can never actually in-place retry (the commit
          // check below returns first), so `committed` belongs in this
          // condition: without it a mid-stream CONNECTION_RESET on a streamed
          // turn would skip BOTH the retry and the record — zero breaker
          // evidence from clients dying mid-body on a dying upstream.
          // Single source for BOTH the recording decision above and the step-2
          // retry decision below — the committed check at the commit point
          // returns first, so the two can never disagree.
          const willRetryInPlace =
            diagnosis.isInPlaceRetriable && attempt < maxInplaceAttempts && !opts.relay?.committed;
          if (!willRetryInPlace) {
            cbManager.recordFailureScoped(
              candidate.id,
              diagnosis,
              candidate.provider,
              credentialPrefix,
              this.registry.getCredentialChain(candidate.provider)?.map((c) => c.keyHashPrefix)
            );
          }

          // Upstream-429 feedback into the local shaping window: the provider
          // just TOLD us this credential is at-cap — feed the declared wait
          // (or a 60s default when the 429 carries no Retry-After) into the
          // rate limiter so NEW-session steering avoids this credential
          // immediately instead of re-discovering the wall. The breaker keeps
          // its own independent cooldown below; this only sharpens the peek()
          // shaping input. No ledger entry: the failure event above already
          // records the 429 fact.
          if (diagnosis.category === 'RATE_LIMITED' && limitSubject) {
            getRateLimiter().penalize(
              limitSubject,
              diagnosis.retryAfterSeconds ? diagnosis.retryAfterSeconds * 1000 : UPSTREAM_429_DEFAULT_COOLDOWN_MS
            );
          }

          // Failure-ledger emission (serving role): the attempt's classifier
          // verdict is in hand — record the failed call regardless of whether
          // a later candidate rescues the turn (failover outcome is routing;
          // a failed call is fact). Repeats coalesce in the ledger, so a 429
          // storm lands as one growing row instead of hundreds.
          recordFailureEvent({
            model: candidate.id,
            provider: candidate.provider,
            // Pair attribution: the credential this call actually ran on — the
            // selector's prefix, else the registry stamp on the error (a
            // selection that degenerated to the default credential still attributes).
            keyHashPrefix: credentialPrefix ?? diagnosis.usedKeyHashPrefix,
            errorClass: diagnosis.category,
            status: diagnosis.statusCode,
            // Belt-and-suspenders: UpstreamError paths already redact, but
            // non-Upstream errors can still carry echoed secrets in message.
            message: redactUpstreamBody(err?.message ?? String(err)),
            role: 'serving',
            sessionId: opts.sessionId,
          });

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
          if (willRetryInPlace) {
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
              ? { firstChunkAt, streamEndAt, stalledMs }
              : undefined,
          // Served-attempt transport tag. `opts.relay` absent = the executor
          // was never given a relay, so the buffered call is certain.
          transport: opts.relay ? transport : 'buffered',
          // Served-attempt egress, resolved at the dial by this pool.
          egress: attemptEgress,
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

