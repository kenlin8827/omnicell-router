import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { buildOcrSummaryFrame } from '../utils/chat-sse.js';
import type { StreamRelay, StreamRoutingFacts } from '../utils/chat-stream.js';
import { buildChatOcrCompletionFacts, buildChatOcrHeaders, buildChatOcrRoutingHeaders } from './ocr-headers.js';
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
 *
 * STREAMED EXCEPTION: on a relayed turn (client `stream:true` on a surface that
 * can frame upstream chunks and has no `afterResult` hook) the headers flush and
 * the frames are written INSIDE `process`, because the whole point is that the
 * client sees bytes before the turn completes. Two consequences are encoded
 * rather than accidental:
 *  - the header block carries routing facts only; completion facts ride the
 *    trailing `ocr-summary` comment frame before `[DONE]`;
 *  - a failure after the first byte ends the stream WITHOUT `[DONE]` — no JSON
 *    error body, no retry, because the client already holds part of the answer.
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

  // 5. Streaming relay — offered when the client asked for a stream AND the
  //    surface can frame an upstream chunk one-for-one (chat wire). A surface
  //    with `afterResult` is deliberately excluded: that hook must run strictly
  //    before the first byte, and a relayed turn flushes bytes DURING
  //    orchestrator.process. The orchestrator still decides whether to USE the
  //    relay (wire capability / assertion cascade / mock mode / config) — when
  //    it does not, no byte is written and the buffered send below runs exactly
  //    as before.
  const includeUsage = request.stream_options?.include_usage === true;
  let streamed = false;
  let stagedFacts: StreamRoutingFacts | undefined;
  let relay: StreamRelay | undefined;
  if (request.stream === true && surface.encodeChunk && !surface.afterResult) {
    relay = {
      stageRouting(facts) {
        stagedFacts = facts;
      },
      onChunk(chunk) {
        if (!streamed) {
          streamed = true;
          // Headers flush with the first byte, so only the ROUTING half of the
          // X-OCR set is legal here; completion facts come in the summary frame.
          t.beginSse(buildChatOcrRoutingHeaders(stagedFacts ?? {}, gateModel));
        }
        const frame = surface.encodeChunk!(chunk, {
          model: stagedFacts?.modelUsed || gateModel,
          includeUsage,
        });
        if (frame !== null) t.writeSseChunk(frame);
      },
      get committed() {
        return streamed;
      },
    };
  }

  try {
    // 6. Execute. captureProcessContext() carries the transport-specific
    //    capture fields (Fastify: fastifyRequest) so this pipeline stays
    //    transport-neutral.
    const result = await orchestrator.process(
      request,
      {
        clientIp: t.clientIp,
        headers: t.headers,
        wire: surface.wire,
        modelAccess: t.access.policy,
        ...t.captureProcessContext(),
      },
      relay
    );

    if (streamed) {
      // 7a. Streamed terminal: the frames already went out during execution.
      // Close with the completion-time facts, then [DONE] — the summary MUST
      // precede [DONE], because most parsers stop reading at [DONE].
      t.writeSseChunk(buildOcrSummaryFrame(buildChatOcrCompletionFacts(result)));
      t.writeSseChunk('data: [DONE]\n\n');
      t.endSse();
      return;
    }

    // 7b. Unified X-OCR header set (surfaces/ocr-headers.ts) — staged once for
    //    the non-stream wire + the capture hook's getHeaders(), and spread
    //    verbatim into writeHead on the buffered SSE wire.
    const headers = buildChatOcrHeaders(result, gateModel);

    // 7c. Surface hook strictly BEFORE the first response byte (responses
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
    if (streamed) {
      // Bytes (and the 200 event-stream headers) already reached the client:
      // a JSON error body would be a SECOND terminal send on this wire, and a
      // retry would duplicate output the client has partly consumed. Close
      // WITHOUT [DONE] — the standard "stream ended unexpectedly" signal.
      t.logError(err, 'Streamed chat execution failed after the first byte');
      t.endSse();
      return;
    }
    // Execution failure: log loudly, map through the surface's own error
    // policy, one terminal JSON send.
    t.logError(err, 'Chat completion execution failed');
    const mapped = surface.executionError(err);
    t.sendJson(mapped.status, mapped.body);
  }
}
