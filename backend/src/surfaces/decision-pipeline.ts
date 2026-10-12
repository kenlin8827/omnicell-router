import crypto from 'node:crypto';
import { isModelAllowed, tierFromVirtualEntry } from '../auth/model-access.js';
import { loadConfig } from '../config/index.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { emitClientRequest, captureKeyIdentity, setClientExchangeContext } from '../observability/http-exchange.js';
import type { UpstreamEventContext } from '../observability/upstream-events.js';
import { resolveTraceId } from '../observability/trace-id.js';
import { runSystemoneDecision } from '../protocols/systemone/decide.js';
import { validateSystemoneRequest } from '../protocols/systemone/convert.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import type { ChatCompletionRequest } from '../types/openai.js';
import { buildSystemoneOcrHeaders } from './ocr-headers.js';
import { systemoneSurface } from './systemone.js';
import type { TransportContext } from './types.js';

/**
 * The decision pipeline — semantically verbatim move of the retired
 * routes/systemone.ts handler (contract §1.3), rewired onto TransportContext
 * so the Fastify /v1/systemone route and the MITM leg run the SAME protocol
 * logic. The executor (runSystemoneDecision) is untouched.
 *
 * CAPTURE: opt-in CLIENT-leg emission, gated AFTER every 400/403/
 * 404/503 return and BEFORE execution — mirroring the chat leg, where
 * orchestrator.process emits only past its own gates. `recorder.isSystemone-
 * Enabled()` is the config gate (requestCapture.enabled master — default OFF,
 * the privacy opt-in per ADR-0016 — × requestCapture.systemone.enabled
 * surface master — default ON, since the whole group only matters once the
 * master is on; the surface master silences BOTH systemone legs); when it is
 * false this function never calls captureProcessContext(),
 * so the OFF path is byte-identical to the ADR-0014 §4 structural
 * exemption (the default-off guard test pins zero events on BOTH legs).
 * The FULL CHAIN is emitted: the client exchange AND — through the ctx passed
 * to the executor — the upstream leg (native passthrough or synthesized
 * conversion call). FinOps rows and trace records stay excluded
 * (ADR-0014 §4 remaining limbs).
 */
export async function runDecisionSurface(
  t: TransportContext,
  orchestrator: Pick<PipelineOrchestrator, 'getRegistry' | 'getCaptureRecorder' | 'getSessionManager'>,
  body: unknown
): Promise<void> {
  const registry: ProviderRegistry = orchestrator.getRegistry();
  const verdict = validateSystemoneRequest(body);
  if (!verdict.ok) {
    t.sendJson(400, systemoneSurface.errorBody(400, verdict.message, 'invalid_request_error'));
    return;
  }
  const sysBody = verdict.value;

  const rawModel = typeof sysBody.model === 'string' ? sysBody.model.trim() : '';
  // Virtual tier aliases (auto-lite / auto-plus / auto-pro / auto-ultra)
  // resolve against the tier pool below. Everything else keeps the plain
  // stateless contract: a named physical id, or bare 'auto'/'default'/omit
  // falling back to `systemone.defaultModel`.
  const virtualTier = tierFromVirtualEntry(rawModel);

  let effective: string;
  if (virtualTier) {
    const tier = virtualTier;
    // Pool projection per the transport gate: 'key' → the key's policy;
    // 'exempt' → policy is undefined, so isModelAllowed admits everything
    // (same as today's keyless Fastify deploys). 404/403/503 stay EXPLICIT —
    // never a silent cross-tier fallback (ADR-0014 §1 frozen;
    // registry.getModelForTier would cross tiers, deliberately unused).
    const policy = t.access.policy;
    // The health-agnostic pool separates "tier not configured" (404) from
    // "nothing healthy" (503); the access filter then separates "policy
    // admits nothing" (403). Candidates are access-filtered BEFORE the
    // pick — mirroring the chat orchestrator — so a denied member never
    // blocks an allowed sibling in the same tier.
    const pool = registry.getCandidateModelsForTier(tier, false);
    if (pool.length === 0) {
      t.sendJson(
        404,
        systemoneSurface.errorBody(
          404,
          `No candidate model in tier '${tier}' (requested '${rawModel}').`,
          'model_not_found'
        )
      );
      return;
    }
    const allowed = pool.filter((m) => isModelAllowed(m.id, policy, m.tier));
    if (allowed.length === 0) {
      // Unreachable under an 'exempt' gate: undefined policy admits the whole
      // pool (allowed.length ≥ 1 after the 404 check), hence `policy!` is the
      // same non-null the retired route asserted on its Fastify `policy!`.
      t.sendJson(
        403,
        systemoneSurface.errorBody(
          403,
          `API key '${t.access.keyName}' is not allowed to use model '${rawModel}' (model policy: ${policy!.mode} [${policy!.models.join(', ')}])`,
          'model_not_allowed'
        )
      );
      return;
    }
    // Chain head of the healthy allowed pool (weight/priority order from
    // sortForChain) — deterministic per pool state. The chat pool's
    // weighted/round-robin strategies are a chat-surface nicety, not a
    // decision-surface one.
    const healthyAllowed = registry
      .getCandidateModelsForTier(tier, true)
      .filter((m) => isModelAllowed(m.id, policy, m.tier));
    if (healthyAllowed.length === 0) {
      t.sendJson(
        503,
        systemoneSurface.errorBody(
          503,
          `No healthy model available in tier '${tier}' (requested '${rawModel}').`,
          'no_healthy_model'
        )
      );
      return;
    }
    effective = healthyAllowed[0].id;
  } else {
    effective =
      rawModel && rawModel !== 'auto' && rawModel !== 'default'
        ? rawModel
        : (loadConfig().systemone?.defaultModel || '').trim();
    if (!effective) {
      t.sendJson(
        400,
        systemoneSurface.errorBody(
          400,
          'Invalid request: "model" is required (or configure systemone.defaultModel).',
          'model_required'
        )
      );
      return;
    }
  }

  // DOUBLE gate, order preserved from the retired route (alias first, then
  // physical). The PHYSICAL model that will actually serve must always be
  // admitted: 'auto'/'default' resolve to `systemone.defaultModel`, so
  // checking only the alias would let a key denied for that model reach it
  // via `auto` (tier-alias picks are admitted by construction — the pool was
  // already access-filtered — and re-checked here as the standing invariant).
  // A named alias is additionally checked as itself — mirroring the chat
  // surfaces, where an allow-mode key must name `auto` (or the tier alias)
  // explicitly, and a deny-mode key must not have the tier denied.
  // A false verdict means the 'key' gate ALREADY wrote its 403 (shared
  // makeModelAccessGuard envelope) — sending anything here would double-answer;
  // the 'exempt' gate answers true unconditionally.
  if (rawModel && rawModel !== effective && !t.access.enforce(rawModel)) {
    return;
  }
  if (!t.access.enforce(effective)) {
    return;
  }

  const model = registry.getModel(effective);
  if (!model) {
    t.sendJson(
      404,
      systemoneSurface.errorBody(404, `Model '${effective}' not found.`, 'model_not_found')
    );
    return;
  }

  // Capture — strictly after ALL gates above (400/403/404/503 returns emit
  // nothing, like the chat leg) and before execution. Skipped whole when the
  // gate is off: zero events, byte-identical to the pre-capture path. The
  // client leg covers the gateway's OWN inbound exchange; the SAME identity
  // (trace/session) also seeds an UpstreamEventContext passed to the
  // executor, so the provider leg (native passthrough or converted chat
  // call) emits its request/response pair too — the full chain is visible
  // on one turn. No `purpose`: within this surface's own turn the upstream
  // events are unambiguous (unlike the judge leg inside a CHAT turn).
  // The gateway-response event is finalized by the transport's terminal send
  // once the client ctx is registered — the same lazy-ctx mechanism the chat
  // leg uses on both transports.
  const recorder = orchestrator.getCaptureRecorder();
  let upstreamEventContext: UpstreamEventContext | undefined;
  if (recorder.isSystemoneEnabled()) {
    // Fail-open by CONTRACT, not just by construction: a broken capture
    // must never 500 the decision itself. Any throw in this block (future
    // callee edits included) is logged and the request proceeds unrecorded.
    try {
    const pctx = t.captureProcessContext();
    // traceId: mirror orchestrator.process — transport-captured headers first
    // (fastifyRequest / clientRequest), then the plain transport headers,
    // minting a 32-hex id only when no header source exists at all.
    const traceHeaders = pctx.fastifyRequest?.headers ?? pctx.clientRequest?.headers ?? t.headers;
    const traceId = traceHeaders
      ? resolveTraceId({ headers: traceHeaders }, 'client-or-mint').traceId
      : crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    // sessionId: archive key ONLY (same SessionManager entry the chat leg
    // pre-resolves through; no ratchet, no turn registration).
    const sessionId = orchestrator
      .getSessionManager()
      .resolveSessionId(sysBody as unknown as ChatCompletionRequest, t.clientIp, t.headers).sessionId;
    const clientExchangeCtx = emitClientRequest({
      recorder,
      req: pctx.fastifyRequest ?? pctx.clientRequest,
      body: sysBody,
      sessionId,
      traceId,
      model: effective,
    });
    if (pctx.fastifyRequest) {
      setClientExchangeContext(pctx.fastifyRequest, clientExchangeCtx);
    } else if (pctx.onClientExchange) {
      pctx.onClientExchange(clientExchangeCtx);
    }
    // Upstream leg shares the client-leg identity. Set only AFTER the client
    // event durably landed — a client-side failure keeps both legs silent
    // (consistent pairing, no orphan upstream events).
    upstreamEventContext = { recorder, sessionId, traceId, model: effective, apiKey: captureKeyIdentity(pctx.fastifyRequest) };
    } catch (captureErr) {
      // Non-fatal: decision proceeds unrecorded on any capture failure.
      t.logError(captureErr, 'systemone client-leg capture failed (non-fatal)');
    }
  }

  const startedAt = Date.now();
  try {
    const decision = await runSystemoneDecision(registry, sysBody, model, {
      upstreamEventContext,
    });

    // Unified X-OCR decision-surface header set (surfaces/ocr-headers.ts) —
    // exactly 3 keys; the latency is measured up to the moment the response
    // is ready.
    const ocrHeaders = buildSystemoneOcrHeaders(model.id, decision.upstreamKind, Date.now() - startedAt);
    t.sendJson(200, decision.response, ocrHeaders);
  } catch (err) {
    // Error policy verbatim: integer statusCode in [400,600) passes through,
    // else UpstreamError.status likewise, else 502; the code prefers the
    // executor's own systemoneCode tag.
    t.logError(err, 'System One request failed');
    const status = errorStatus(err);
    const e = err as { message?: string; systemoneCode?: string } | null | undefined;
    t.sendJson(
      status,
      systemoneSurface.errorBody(
        status,
        e?.message || 'System One upstream failure',
        e?.systemoneCode || (err instanceof UpstreamError ? 'upstream_error' : 'api_error')
      )
    );
  }
}

function errorStatus(err: unknown): number {
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
    return statusCode;
  }
  if (err instanceof UpstreamError && typeof err.status === 'number' && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  return 502;
}
