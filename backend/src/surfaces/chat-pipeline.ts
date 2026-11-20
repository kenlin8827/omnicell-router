import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { StreamRelay, StreamRoutingFacts } from '../utils/stream-relay.js';
import { buildChatOcrHeaders, buildChatOcrRoutingHeaders, buildChatOcrSummaryFrame } from './ocr-headers.js';
import type { ChatSurface, SurfacePathContext, TransportContext } from './types.js';
import { streamingPosture } from '../pipeline/streaming-posture.js';

/** Preserve synchronous sinks while serializing writes when the transport applies backpressure. */
function writeSseFrames(t: TransportContext, frames: Iterable<string>): void | Promise<void> {
  let pending: Promise<void> | undefined;
  for (const frame of frames) {
    if (pending) {
      pending = pending.then(() => t.writeSseChunk(frame));
      continue;
    }
    const result = t.writeSseChunk(frame);
    if (result) pending = Promise.resolve(result);
  }
  return pending;
}

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
 * can frame upstream chunks) the headers flush and the frames are written
 * INSIDE `process`, because the whole point is that the client sees bytes
 * before the turn completes. A surface carrying `afterResult` may relay only
 * when it also supplies `streamStart` — its ids must be minted at parse time,
 * since the hook itself runs after the turn. Two consequences are encoded
 * rather than accidental:
 *  - the header block carries routing facts only; completion facts ride the
 *    trailing `ocr-summary` comment on every chat-shaped wire (chat places it
 *    before `[DONE]`; anthropic and responses place it after their terminal
 *    event);
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
  // The path context rides along so a URL-addressed wire can reach the model its
  // body never carries; body-addressed wires ignore the argument entirely.
  const parsed = surface.parse(body, pathContextOf(t.url));

  // 2. Invalid body → 400 through the surface envelope (no headers staged).
  if (parsed.error) {
    t.sendJson(400, surface.errorBody(400, parsed.error, parsed.errorCode));
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

  // 5. Client stream mode (streaming.client.mode — ADR-0008 §1). `deny`
  //    refuses an SSE ask before anything reaches the orchestrator (no
  //    capture event: this is a pre-process 400, same class as parse/gate);
  //    `always` answers in SSE even when the client sent `stream: false`,
  //    which for a surface without a chunk encoder means its buffered SSE
  //    frame sequence (`encodeStream`) rather than a JSON body.
  const clientStreamMode = streamingPosture().client;
  if (request.stream === true && clientStreamMode === 'deny') {
    t.sendJson(
      400,
      surface.errorBody(
        400,
        'Streaming is disabled by this gateway (streaming.client.mode: deny). Resend with "stream": false.'
      )
    );
    return;
  }
  const wantsStream = clientStreamMode === 'always' ? true : request.stream === true;

  // 5b. Streaming relay — offered when the response is SSE AND the surface
  //    can frame an upstream chunk one-for-one. A surface with `afterResult`
  //    is excluded unless it ALSO declares `streamStart`: that hook needs the
  //    completed result, which does not exist yet at the first byte, so its
  //    state (response id / message item id) must already be minted by parse.
  //    The orchestrator still decides whether to USE the relay (wire capability
  //    / assertion cascade / mock mode / upstream transport mode) — when it
  //    does not, no byte is written and the buffered send below runs as before.
  const includeUsage = request.streamOptions?.includeUsage === true;
  let streamed = false;
  let stagedFacts: StreamRoutingFacts | undefined;
  let relay: StreamRelay | undefined;
  const chunkCtx = (): { model: string; includeUsage: boolean; state: unknown } => ({
    model: stagedFacts?.modelUsed || gateModel,
    includeUsage,
    state: parsed.state,
  });
  if (wantsStream && surface.encodeChunk && (!surface.afterResult || surface.streamStart)) {
    relay = {
      stageRouting(facts) {
        stagedFacts = facts;
      },
      onChunk(chunk) {
        const opening: string[] = [];
        if (!streamed) {
          streamed = true;
          // Headers flush with the first byte, so only the ROUTING half of the
          // X-OCR set is legal here; completion facts come in the summary frame.
          t.beginSse(buildChatOcrRoutingHeaders(stagedFacts ?? {}, gateModel));
          // Responses wire: created / in_progress / output_item.added /
          // content_part.added must precede EVERY delta, and their ids were
          // minted by parse (afterResult has not run yet).
          opening.push(...surface.streamStart?.(parsed.state, chunkCtx()) ?? []);
        }
        const frame = surface.encodeChunk!(chunk, chunkCtx());
        if (frame !== null) opening.push(frame);
        return writeSseFrames(t, opening);
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
        // Response shape actually written (client ask OR `client.mode: always`):
        // the orchestrator stamps it on the trace so the console can tag the
        // inbound leg without re-deriving the posture.
        clientStream: wantsStream,
        // Capture keeps the client's protocol envelope; IR belongs to routing
        // and execution, never to the inbound wire archive.
        clientBody: body,
        ...t.captureProcessContext(),
      },
      relay
    );

    if (streamed) {
      // The relayed turn still produced an accumulated result. Run the hook
      // now (before the closing frames) so the id in `response.created` is the
      // same one the store persists — the buffered leg runs it at step 7c.
      surface.afterResult?.(result, parsed.state);
      if (surface.streamEnd) {
        await writeSseFrames(t, surface.streamEnd(result, parsed.state, chunkCtx()));
      } else {
        // Fallback when a surface defines no streamEnd. The summary precedes
        // [DONE]; most parsers stop reading at [DONE]. Chat, Anthropic and
        // Responses all define streamEnd and do not take this branch.
        await writeSseFrames(t, [
          buildChatOcrSummaryFrame(result),
          'data: [DONE]\n\n',
        ]);
      }
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

    // 8. Terminal send. `wantsStream` = the client's typed `stream` ask OR
    //    `client.mode: always`. The C-3 normalization still governs the ASK:
    //    a non-boolean truthy `stream` value takes the JSON path unless the
    //    operator forced SSE, matching the MITM leg and the typed contract.
    if (wantsStream) {
      // Encode BEFORE beginSse: if encodeStream ever throws, the catch's
      // JSON error send still owns a clean (header-less) response. Sending
      // SSE headers first would DOUBLE-TERMINATE — a 200 event-stream
      // preamble followed by an error JSON body on the same wire (the
      // pre-refactor leg shared this defect; ordering fixes it).
      const chunks = surface.encodeStream(result, parsed.state);
      t.beginSse(headers);
      await writeSseFrames(t, chunks);
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

/**
 * Split the transport's request target into the path context `parse` receives.
 * Deliberately dumb (no decoding, no normalization): the wire's own converter
 * knows which of its paths are meaningful, and a percent-decode here would
 * invent a canonical form neither transport promises.
 */
function pathContextOf(url: string): SurfacePathContext {
  const q = url.indexOf('?');
  return q === -1 ? { path: url, query: '' } : { path: url.slice(0, q), query: url.slice(q + 1) };
}
