import type { FastifyReply, FastifyRequest } from 'fastify';
import { getModelAccessPolicy, makeModelAccessGuard } from '../auth/model-access.js';
import type { ClientExchangeContext } from '../observability/http-exchange.js';
import {
  appendGatewayResponseChunk,
  markGatewayResponseStreamStart,
  emitGatewayResponse,
  getClientExchangeContext,
} from '../observability/http-exchange.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { ApiKeyConfig } from '../config/types.js';
import type { TransportContext } from './types.js';

/**
 * Fastify transport (step-3c form): explicit capture inside the terminal
 * sends, replacing server.ts's global onSend/onResponse/onRequest hooks.
 *
 * Emitted-event FIELD SOURCES are unchanged (contract §4): non-stream =
 * reply.statusCode + reply.getHeaders(); stream = the beginSse mirror map —
 * reply.getHeaders() merges the staged X-OCR set over the raw writeHead map,
 * exactly what the old finalization hook read. Only the EMISSION MOMENT
 * moves: onResponse (after the socket flush) → synchronously after send,
 * before flush, behind the responded dedup. The abort listener is the old
 * onRequest-close hook migrated verbatim (writableEnded → responded →
 * isEnabled triple guard, lazy ctx read — the exchange ctx only exists once
 * orchestrator.process has attached it, so it MUST be read at event time).
 */
export function createFastifyTransport(
  req: FastifyRequest,
  reply: FastifyReply,
  orchestrator: Pick<PipelineOrchestrator, 'getRegistry'>
): TransportContext {
  // authInfo is attached by the auth preHandler (validateApiKey's result);
  // Fastify's request type has no declaration for it — typed view, not any.
  const keyConfig: ApiKeyConfig | undefined =
    (req as FastifyRequest & { authInfo?: { keyConfig?: ApiKeyConfig } }).authInfo?.keyConfig;
  // The guard sends its own 403 envelope on denial (shared across all legs).
  const guard = makeModelAccessGuard(orchestrator.getRegistry());

  // Stashed at beginSse exactly where the old handler read it — the capture
  // ctx exists only after process() attached it (capture enabled) — undefined
  // silently disables the chunk accumulation, mirroring `if (sseCtx)`.
  let sseCtx: ClientExchangeContext | undefined;
  // Set by the migrated close listener (see below) — the isClientGone signal.
  let closed = false;

  // Client-abort capture — server.ts's onRequest hook, migrated verbatim:
  // when the socket closes before the response finishes, no terminal send
  // may double-answer, so if no response event was emitted yet, record a
  // synthetic 499 (nginx convention for client-closed connection) and every
  // request event stays paired. NB: Fastify's `onClose` application hook is
  // server-shutdown, NOT this. On Bun 'close' never fires on premature
  // disconnect (forward-proxy.test.ts:360 is the runtime spec), which is why
  // the terminal sends ALSO consult isClientGone() below.
  reply.raw.on('close', () => {
    closed = true;
    // writableEnded = response fully written — a later socket close (e.g.
    // keep-alive teardown) must not synthesize a 499 for a completed 200.
    if (reply.raw.writableEnded) return;
    const ctx = getClientExchangeContext(req);
    if (ctx && !ctx.pending.responded && ctx.recorder.isEnabled()) {
      emitGatewayResponse(ctx, {
        statusCode: 499,
        statusMessage: 'Client Closed Request',
        getHeader: () => undefined,
      });
    }
  });

  // Bun fires no reliable 'close'/'aborted' after the response is dead —
  // the migrated listener covers Node; the socket-destroyed poll covers
  // Bun (forward-proxy.test.ts:360 documents the verified runtime).
  const isClientGone = () => closed || reply.raw.socket?.destroyed === true;

  // Fastify's per-request pino child — the one error sink for this transport.
  const logError = (err: unknown, message: string) => {
    req.log.error(err, message);
  };

  // Terminal-send finalize (contract §1.5): one emit decision per response —
  // real status when the socket lived, synthetic 499 when the client was
  // already gone. `responded` dedup lives inside emitGatewayResponse; the
  // isEnabled gate + ctx presence check live here (no ctx ⇒ pre-process 400
  // or capture-off ⇒ nothing to pair).
  const finalizeCapture = (view: Parameters<typeof emitGatewayResponse>[1]) => {
    const ctx = getClientExchangeContext(req);
    if (!ctx || !ctx.recorder.isEnabled()) return;
    if (isClientGone()) {
      emitGatewayResponse(ctx, {
        statusCode: 499,
        statusMessage: 'Client Closed Request',
        getHeader: () => undefined,
      });
    } else {
      emitGatewayResponse(ctx, view);
    }
  };

  const transport: TransportContext = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    clientIp: req.ip,

    access: {
      kind: 'key',
      keyName: keyConfig?.name ?? '',
      policy: getModelAccessPolicy(keyConfig),
      enforce: (requestedModel: string) => guard(req, reply, requestedModel),
    },

    captureProcessContext: () => ({ fastifyRequest: req }),

    sendJson: (status, payload, headers) => {
      // Serialize ONCE; the string passthrough keeps Fastify from running
      // its own serializer twice and gives the capture the exact wire bytes.
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch (err) {
        logError(err, 'Fastify sendJson payload serialization failed');
        serialized = '{"error":{"message":"Internal Router Error","type":"api_error"}}';
      }
      // Stage headers BEFORE send — the same points the old hook chain saw:
      // explicit content-type (previously the serializer's default) + the
      // X-OCR set, so reply.getHeaders() (capture map) and the wire agree.
      reply.header('content-type', 'application/json; charset=utf-8');
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          reply.header(k, v);
        }
      }
      // send() settles asynchronously; on a dead socket its rejection would
      // otherwise be unhandled and bypass Fastify's error logging — route it
      // to this transport's one error sink. Promise.resolve assimilates the
      // thenable reply (FastifyReply types .then but not .catch). The call
      // stays synchronous here: exactly ONE terminal send per request
      // (contract §1.5), and the capture stash + finalize below still run
      // in send-order.
      Promise.resolve(reply.status(status).send(serialized)).catch((err: unknown) => logError(err, 'Fastify sendJson reply.send rejected'));
      const ctx = getClientExchangeContext(req);
      if (ctx) {
        appendGatewayResponseChunk(ctx, serialized);
      }
      // view=reply: statusCode + getHeaders() — the old onResponse source.
      finalizeCapture(reply);
    },

    beginSse: (headers) => {
      // Mirror-map: reply.header() staging is what today's pre-branch loop
      // did for BOTH wires, and the capture finalize reads reply.getHeaders()
      // — skipping it would strip X-OCR from the stream's capture event.
      for (const [k, v] of Object.entries(headers)) {
        reply.header(k, v);
      }
      // Literal order preserved: Node writes headers in object key order.
      // Dead-peer guard mirrors transport-node-http.ts (R-3): Bun's socket
      // layer surfaces write errors as synchronous 'ERR_STREAM_DESTROYED'-
      // style throws on dead peers — a throw here would reach chat-pipeline's
      // catch, whose JSON error send would DOUBLE-TERMINATE the SSE wire.
      try {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          ...headers,
        });
      } catch (err) {
        logError(err, 'Fastify beginSse writeHead failed');
      }
      sseCtx = getClientExchangeContext(req);
    },

    writeSseChunk: (chunk) => {
      // SSE bypasses Fastify's serializer, so the capture stash stays here —
      // per chunk, exactly like the old handler (the [DONE] frame is the
      // last chunk, so it lands in the capture too, same as before).
      if (sseCtx) {
        markGatewayResponseStreamStart(sseCtx);
        appendGatewayResponseChunk(sseCtx, chunk);
      }
      try {
        reply.raw.write(chunk);
      } catch (err) {
        logError(err, 'Fastify writeSseChunk failed');
      }
    },

    endSse: () => {
      try {
        reply.raw.end();
      } catch (err) {
        logError(err, 'Fastify endSse failed');
      }
      // Synchronous finalize replaces the old post-flush onResponse emit.
      // view=reply keeps the same sources (statusCode + merged getHeaders()).
      finalizeCapture(reply);
    },

    isClientGone,
    logError,
  };

  return transport;
}
