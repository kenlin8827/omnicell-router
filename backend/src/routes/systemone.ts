import { FastifyInstance } from 'fastify';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { loadConfig } from '../config/index.js';
import { runSystemoneDecision } from '../protocols/systemone/decide.js';
import { validateSystemoneRequest } from '../protocols/systemone/convert.js';
import { makeModelAccessGuard } from '../auth/model-access.js';
import { UpstreamError } from '../resilience/error-classifier.js';

/**
 * System One protocol compatibility surface (POST /v1/systemone).
 *
 * A thin HTTP shell over the shared decision executor
 * (protocols/systemone/decide.ts) — the same one the Layer 2 router judge
 * uses. This route owns ONLY the wire concerns: structural validation,
 * model resolution, per-key model access, status mapping and response
 * headers. Upstream dispatch (native passthrough vs chat conversion, the
 * reasoning-effort calibration) lives in the shared executor.
 *
 * Stateless decision surface: the named model is the model served — no tier
 * cascade, session ratchet or combo resolution. Auth and
 * per-key model-access policies apply exactly like the other /v1 surfaces.
 */

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
      const decision = await runSystemoneDecision(registry, body, model);

      reply.header('X-OCR-Model', model.id);
      reply.header('X-OCR-Systemone-Upstream', decision.upstreamKind);
      reply.header('X-OCR-Latency-MS', (Date.now() - startedAt).toString());
      return reply.send(decision.response);
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