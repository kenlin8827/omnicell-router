import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { buildChatOcrHeaders } from './ocr-headers.js';
import type { ChatSurface, TransportContext } from './types.js';

/**
 * The frozen execution order for every chat-shaped wire (contract §1.3).
 * Steps 1-4 deliberately precede orchestrator.process — and therefore
 * precede capture: a parse-400 or a gate-403 never produces capture events
 * on either leg (today's behavior, two-leg invariant).
 *
 *   parse → 400 → gate → process → headers → afterResult → terminal send
 *
 * The terminal send is exactly ONE of beginSse+writeSseChunk*+endSse or
 * sendJson (TransportContext's terminal-send discipline).
 */
export async function runChatSurface(
  t: TransportContext,
  surface: ChatSurface,
  orchestrator: Pick<PipelineOrchestrator, 'process'>,
  body: unknown
): Promise<void> {
  // 1. Parse — protocol-level shape check only; model resolution stays with the orchestrator.
  const parsed = surface.parse(body);

  // 2. Invalid body → 400 through the surface envelope (no headers staged).
  if (parsed.error) {
    t.sendJson(400, surface.errorBody(400, parsed.error));
    return;
  }
  // SurfaceParseResult invariant: exactly one of error/request is set.
  const request = parsed.request!;

  // 3. Gate model: trimmed client name or 'auto'.
  const gateModel = request.model?.trim() || 'auto';

  // 4. Per-key model access gate — on a false verdict the gate has ALREADY
  //    written the 403; sending anything here would double-answer.
  if (!t.access.enforce(gateModel)) {
    return;
  }

  try {
    // 5. Execute. captureProcessContext() carries the transport-specific
    //    capture fields (Fastify: fastifyRequest) so this pipeline stays
    //    transport-neutral.
    const result = await orchestrator.process(request, {
      clientIp: t.clientIp,
      headers: t.headers,
      wire: surface.wire,
      modelAccess: t.access.policy,
      ...t.captureProcessContext(),
    });

    // 6. Unified X-OCR header set (surfaces/ocr-headers.ts) — staged once for
    //    the non-stream wire + the capture hook's getHeaders(), and spread
    //    verbatim into writeHead on the SSE wire.
    const headers = buildChatOcrHeaders(result, gateModel);

    // 7. Surface hook strictly BEFORE the first response byte (responses
    //    wire: RespStore.append so the id resolves when created fires).
    surface.afterResult?.(result, parsed.state);

    // 8. Terminal send. `=== true`: the frozen normalization (C-3) — non-
    //    boolean truthy `stream` values take the JSON path, matching the
    //    MITM leg and the typed contract.
    if (request.stream === true) {
      // Encode BEFORE beginSse: if encodeStream ever throws, the catch's
      // JSON error send still owns a clean (header-less) response. Sending
      // SSE headers first would DOUBLE-TERMINATE — a 200 event-stream
      // preamble followed by an error JSON body on the same wire (the
      // pre-refactor leg shared this defect; ordering fixes it).
      const chunks = surface.encodeStream(result, parsed.state);
      t.beginSse(headers);
      for (const chunk of chunks) {
        t.writeSseChunk(chunk);
      }
      t.endSse();
    } else {
      t.sendJson(200, surface.encodeJson(result, parsed.state), headers);
    }
  } catch (err: unknown) {
    // Execution failure: log loudly, map through the surface's own error
    // policy, one terminal JSON send.
    t.logError(err, 'Chat completion execution failed');
    const mapped = surface.executionError(err);
    t.sendJson(mapped.status, mapped.body);
  }
}
