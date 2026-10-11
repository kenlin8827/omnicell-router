import { FastifyInstance } from 'fastify';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { ProviderRegistry } from '../providers/registry.js';
import { SystemoneProvider } from '../providers/systemone.js';
import { ModelRegistration } from '../config/types.js';
import { loadConfig } from '../config/index.js';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { EFFORT_LADDER, ReasoningEffort } from '../types/router.js';
import { SystemoneRequest, SystemoneResponse } from '../protocols/systemone/types.js';
import {
  buildDecisionChatRequest,
  decisionReasoningEffort,
  synthesizeSystemoneResponse,
  validateSystemoneRequest,
} from '../protocols/systemone/convert.js';
import { makeModelAccessGuard } from '../auth/model-access.js';
import { UpstreamError } from '../resilience/error-classifier.js';

/**
 * System One protocol compatibility surface (POST /v1/systemone).
 *
 * Two upstream paths, selected by the resolved model's provider type:
 *  - `type: 'systemone'` provider → native passthrough (TypeSafe Jev /
 *    Bailian decision-model-preview wire), zero-loss.
 *  - any chat provider → protocol conversion: one JSON-constrained chat
 *    completion carries all questions; the reply is normalized back into
 *    the System One answers shape (probabilities are best-effort estimates).
 *
 * Stateless decision surface: the named model is the model served — no tier
 * cascade, session ratchet or combo resolution (see ADR-0014). Auth and
 * per-key model-access policies apply exactly like the other /v1 surfaces.
 */

const CONVERSION_REPAIR_ATTEMPTS = 1;

function chatText(chat: ChatCompletionResponse): string {
  const content = chat.choices?.[0]?.message?.content ?? '';
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Per-model effort preference learned at runtime.
 * A level = the pin that last worked; 'omit' = the upstream rejects the
 * field entirely, stop sending it. Populated by executeDecision's rejection
 * fallback — vendor enums can contradict the catalog's coarse capability
 * flag (e.g. Alibaba accepts only low|high|max while the model is declared
 * thinking-capable). Process-lifetime; a gateway restart re-probes once.
 */
const effortPreferenceByModel = new Map<string, ReasoningEffort | 'omit'>();

/** Did the upstream reject our `reasoning_effort` parameter/value? */
function isEffortRejection(err: any): boolean {
  if (!(err instanceof UpstreamError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /reasoning_effort/i.test(`${err.message || ''} ${err.errorBody || ''}`);
}

/**
 * Ladder levels the vendor's error message enumerates as acceptable
 * (e.g. "'reasoning_effort' must be one of: 'low', 'high', 'max'").
 * Excludes the value we just tried; returns them ordered lowest → highest.
 * This is the "look at what the upstream actually supports" signal — there
 * is no query API for the real enum, but a rejection usually discloses it.
 */
function parseMentionedEfforts(errorText: string, exclude: ReasoningEffort): ReasoningEffort[] {
  const found = new Set<ReasoningEffort>();
  for (const token of errorText.match(/\b(none|low|medium|high|xhigh|max)\b/gi) || []) {
    const level = token.toLowerCase() as ReasoningEffort;
    if (level !== exclude) found.add(level);
  }
  return [...found].sort((a, b) => EFFORT_LADDER.indexOf(a) - EFFORT_LADDER.indexOf(b));
}

/** The pin to attempt for a model: memoized learning first, then capability. */
function plannedEffort(model: ModelRegistration): ReasoningEffort | 'omit' {
  const memo = effortPreferenceByModel.get(model.id);
  if (memo) return memo;
  return decisionReasoningEffort(model) ?? 'omit';
}

/**
 * Execute the decision call, downgrading the effort pin when the upstream
 * rejects it. The retry target is learned from the vendor's own error
 * ("must be one of: 'low', 'high', 'max'") → its LOWEST allowed level;
 * when the message doesn't enumerate, the conservative chain applies
 * ('none' → 'low' → omit). Hard-bounded to 3 total attempts; the accepted
 * preference is memoized per model so later calls go straight to it.
 */
async function executeDecision(
  registry: ProviderRegistry,
  model: ModelRegistration,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  let attemptRequest = request;
  let rejections = 0;
  for (;;) {
    try {
      return await registry.execute(attemptRequest, model);
    } catch (err: any) {
      const attempted = attemptRequest.reasoning_effort as ReasoningEffort | undefined;
      if (!attempted || !isEffortRejection(err)) throw err;
      rejections++;
      let next: ReasoningEffort | 'omit';
      if (rejections >= 2) {
        next = 'omit'; // hard stop — bounded at 3 total attempts
      } else {
        // Parse the upstream's RAW error body only — the gateway's own
        // message prefix carries the provider name, which may itself contain
        // effort words and would poison the candidate parse.
        const mentioned = parseMentionedEfforts(err.errorBody || '', attempted);
        next = mentioned.length > 0 ? mentioned[0] : attempted === 'none' ? 'low' : 'omit';
      }
      effortPreferenceByModel.set(model.id, next);
      console.warn(
        `[systemone] upstream rejected reasoning_effort '${attempted}' for model '${model.id}' — downgrading the pin to '${next}'`
      );
      const retry: ChatCompletionRequest = { ...request };
      if (next === 'omit') delete retry.reasoning_effort;
      else retry.reasoning_effort = next;
      attemptRequest = retry;
    }
  }
}

async function convertViaChatModel(
  registry: ProviderRegistry,
  body: SystemoneRequest,
  model: ModelRegistration
): Promise<SystemoneResponse> {
  // System One = fast structured decisions: pin the decision call's reasoning
  // effort on the initial AND repair requests (memoized preference + runtime
  // rejection fallback live in plannedEffort / executeDecision).
  const build = (repair?: { previousOutput: string; reason: string }) => {
    const request = buildDecisionChatRequest(body, model.id, repair);
    const preference = plannedEffort(model);
    if (preference !== 'omit') request.reasoning_effort = preference;
    return request;
  };

  let chat = await executeDecision(registry, model, build());
  let synth = synthesizeSystemoneResponse(chat, body, model.id);
  for (let attempt = 0; attempt < CONVERSION_REPAIR_ATTEMPTS && !synth.ok; attempt++) {
    chat = await executeDecision(
      registry,
      model,
      build({ previousOutput: chatText(chat), reason: synth.reason })
    );
    synth = synthesizeSystemoneResponse(chat, body, model.id);
  }
  if (!synth.ok) {
    const err: any = new Error(
      `System One conversion failed: the model output could not be converted (${synth.reason}).`
    );
    err.systemoneCode = 'conversion_failed';
    err.statusCode = 502;
    throw err;
  }
  return synth.response;
}

function errorStatus(err: any): number {
  if (Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600) return err.statusCode;
  if (err instanceof UpstreamError && Number.isInteger(err.status) && err.status! >= 400 && err.status! < 600) {
    return err.status!;
  }
  return 502;
}

export function registerSystemoneRoutes(app: FastifyInstance, orchestrator: PipelineOrchestrator): void {
  app.post('/v1/systemone', async (req, reply) => {
    const verdict = validateSystemoneRequest(req.body);
    if (!verdict.ok) {
      return reply.status(400).send({
        error: { message: verdict.message, type: 'invalid_request_error', code: 'invalid_request_error' },
      });
    }
    const body = verdict.value;

    const registry = orchestrator.getRegistry();
    const rawModel = typeof body.model === 'string' ? body.model.trim() : '';
    const effective =
      rawModel && rawModel !== 'auto' && rawModel !== 'default'
        ? rawModel
        : (loadConfig().systemone?.defaultModel || '').trim();
    if (!effective) {
      return reply.status(400).send({
        error: {
          message: 'Invalid request: "model" is required (or configure systemone.defaultModel).',
          type: 'invalid_request_error',
          code: 'model_required',
        },
      });
    }

    // Per-key model access gate (403 when the key's policy denies this model).
    // The PHYSICAL model that will actually serve must always be admitted:
    // 'auto'/'default' resolve to `systemone.defaultModel`, so checking only
    // the alias would let a key denied for that model reach it via `auto`.
    // A named alias is additionally checked as itself — mirroring the chat
    // surfaces, where an allow-mode key must name `auto` explicitly.
    const enforceModelAccess = makeModelAccessGuard(registry);
    if (rawModel && rawModel !== effective && !enforceModelAccess(req, reply, rawModel)) {
      return reply;
    }
    if (!enforceModelAccess(req, reply, effective)) {
      return reply;
    }

    const model = registry.getModel(effective);
    if (!model) {
      return reply.status(404).send({
        error: { message: `Model '${effective}' not found.`, type: 'invalid_request_error', code: 'model_not_found' },
      });
    }

    const startedAt = Date.now();
    try {
      const providerConfig = registry.getProviderConfig(model.provider);
      let response: SystemoneResponse;
      let upstreamKind: 'native' | 'converted';
      if (providerConfig?.type === 'systemone') {
        upstreamKind = 'native';
        response = await new SystemoneProvider(providerConfig).createDecision(body, model);
      } else {
        upstreamKind = 'converted';
        response = await convertViaChatModel(registry, body, model);
      }

      reply.header('X-OCR-Model', model.id);
      reply.header('X-OCR-Systemone-Upstream', upstreamKind);
      reply.header('X-OCR-Latency-MS', (Date.now() - startedAt).toString());
      return reply.send(response);
    } catch (err: any) {
      req.log.error(err, 'System One request failed');
      const status = errorStatus(err);
      return reply.status(status).send({
        error: {
          message: err?.message || 'System One upstream failure',
          type: status >= 500 ? 'api_error' : 'invalid_request_error',
          code: err?.systemoneCode || (err instanceof UpstreamError ? 'upstream_error' : 'api_error'),
        },
      });
    }
  });
}