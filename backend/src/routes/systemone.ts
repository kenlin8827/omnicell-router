import { FastifyInstance } from 'fastify';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { ProviderRegistry } from '../providers/registry.js';
import { SystemoneProvider } from '../providers/systemone.js';
import { ModelRegistration } from '../config/types.js';
import { loadConfig } from '../config/index.js';
import { ChatCompletionResponse } from '../types/openai.js';
import { SystemoneRequest, SystemoneResponse } from '../protocols/systemone/types.js';
import {
  buildDecisionChatRequest,
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

async function convertViaChatModel(
  registry: ProviderRegistry,
  body: SystemoneRequest,
  model: ModelRegistration
): Promise<SystemoneResponse> {
  let chat = await registry.execute(buildDecisionChatRequest(body, model.id), model);
  let synth = synthesizeSystemoneResponse(chat, body, model.id);
  for (let attempt = 0; attempt < CONVERSION_REPAIR_ATTEMPTS && !synth.ok; attempt++) {
    const repair = buildDecisionChatRequest(body, model.id, {
      previousOutput: chatText(chat),
      reason: synth.reason,
    });
    chat = await registry.execute(repair, model);
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

    // Per-key model access gate (403 when the key's policy denies this model)
    const enforceModelAccess = makeModelAccessGuard(registry);
    if (!enforceModelAccess(req, reply, rawModel || effective)) {
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