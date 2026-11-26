import type http from 'node:http';
import {
  appendClientResponseChunk,
  markClientResponseStreamStart,
  emitClientResponse,
  type ClientExchangeContext,
} from '../observability/http-exchange.js';
import type { ProtocolSurface, TransportContext } from './types.js';
import { bodyLimitFor, payloadTooLarge, requestBodyTimeout } from './body-admission.js';
import { REQUEST_BODY_IDLE_TIMEOUT_MS } from '../config/defaults.js';
import { createClientLegWatchdog, writeWithBackpressure, type ClientLegWatchdog } from './transport-backpressure.js';

/**
 * Raw node:http transport (the MITM forward-proxy leg) — the second
 * implementation of the frozen TransportContext terminal-send discipline
 * (contract §1.5). The interceptor reads the body, hands this transport to
 * dispatchSurface, and the SAME chat pipelines then run byte-comparable on
 * both legs.
 *
 * POLICY EXEMPTION (deliberate): intercepted traffic carries NO gateway key —
 * the upstream Authorization header belongs to the real upstream API, so
 * per-key model-access policies cannot apply here. This surface is a trusted
 * local-machine convenience (the user explicitly points their tools at the
 * proxy); anyone who can reach the proxy could equally call the native
 * endpoints if they held a key, and inference cost-control for untrusted
 * remote callers is the proxy operator's job (bind it to loopback). Do NOT
 * "fix" this by inventing key headers the caller cannot send.
 * (Authoritative text — interceptor.ts keeps only a pointer here.)
 */

/**
 * Read the request body with the gateway's hard cap (`bodyLimitFor('gateway')` —
 * the SAME number the native Fastify routes pass as bodyLimit, so one admission
 * ceiling covers both legs; `client.bodyLimits.maxBytes` moves it for both at the
 * next boot). Oversized bodies reject with a BodyAdmissionError
 * that already carries the 413 status, the `payload_too_large` code and the
 * client-facing sentence; the caller only has to answer with it.
 *
 * The cap is measured on the WIRE here (this leg buffers before decoding), and
 * `model-gateway.ts` re-checks after `decompressBody`, so a compressed body
 * cannot slip past the ceiling that the native leg applies to its inflated
 * stream.
 *
 * A STALLED body is refused too, with 408 (see `requestBodyTimeout`). The
 * server-level `requestTimeout` cannot express it: that clock covers the whole
 * request, so one byte per minute never trips it — and on Bun no such clock is
 * armed at all. This timer is re-armed on every chunk, so liveness is measured on
 * the axis that actually fails in practice: progress, not elapsed time.
 *
 * `idleMs` is a seam (a test cannot wait a minute, and a later config knob needs
 * one call site); production callers pass nothing and get the single-source default.
 */
export function readRequestBody(
  req: http.IncomingMessage,
  idleMs: number = REQUEST_BODY_IDLE_TIMEOUT_MS
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const capBytes = bodyLimitFor('gateway');
    let total = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = (): void => {
      if (idle) clearTimeout(idle);
      idle = undefined;
    };
    const armIdle = (): void => {
      clearIdle();
      idle = setTimeout(() => {
        idle = undefined;
        // Same shape as the size overflow: stop consuming, let the caller answer,
        // and let `sendPreDispatchError` close the connection.
        req.pause();
        reject(requestBodyTimeout());
      }, idleMs);
      // Never hold the event loop open for a client that has stopped talking.
      idle.unref?.();
    };
    req.on('data', (d: Buffer) => {
      armIdle();
      total += d.length;
      if (total > capBytes) {
        clearIdle();
        // RFC 9110 15.5.14: an oversized payload is refused with a 413 — an
        // ANSWER, not a reset. Destroying the request here tore the socket down
        // before the caller could write the status, so the client saw a bare
        // ECONNRESET with no code at all (verified on bun and node). Pause
        // instead — the ceiling is already crossed, so stop consuming and let
        // `sendPreDispatchError` answer, flush and close.
        req.pause();
        reject(payloadTooLarge(capBytes));
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      clearIdle();
      resolve(Buffer.concat(chunks));
    });
    // A client that hangs up mid-body is not a stalled body: no 408 answer to send,
    // just stop the clock.
    req.on('close', clearIdle);
    req.on('error', (err) => {
      clearIdle();
      reject(err);
    });
  });
}

/**
 * Pre-dispatch error (413 oversized body / 400 invalid JSON): sent through
 * the surface's own error envelope BEFORE any orchestrator call, so no
 * capture events exist on this path on either leg (contract §4: 400/403
 * precede process). Adapters never throw — write failures are logged loud.
 */
export function sendPreDispatchError(
  res: http.ServerResponse,
  surface: ProtocolSurface,
  status: number,
  message: string,
  code?: string,
  /** The rejection's negotiation headers (`Accept-Encoding` for a refused coding,
   *  `Accept` for a refused media type). Carried through so the MITM leg advertises
   *  exactly what the native leg does — a client that only reads the headers learns
   *  the fix on neither leg if they are dropped here. */
  headers?: Record<string, string>
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(surface.errorBody(status, message, code));
  } catch (err) {
    logWriteError(err, 'node-http pre-dispatch error body serialization failed');
    return;
  }
  try {
    // The MITM leg serves BOTH HTTP/1.1 and the http2 compatibility API. h2
    // forbids connection-specific fields (writeHead throws
    // ERR_HTTP2_INVALID_CONNECTION_HEADERS, which used to eat the whole
    // envelope), so `connection: close` is spoken only on the h1 leg.
    const isH2 = (res as unknown as { stream?: unknown }).stream !== undefined;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      ...(isH2 ? {} : { connection: 'close' }),
      ...(headers ?? {}),
    });
    res.end(serialized);
    // The body was deliberately left unread, so this connection is not reusable.
    // destroySoon() — never destroy() — flushes the answer first and then closes
    // the transport; on the h2 leg it ends the affected stream, not the
    // multiplexed session.
    (res as unknown as { destroySoon?: () => void }).destroySoon?.();
  } catch (err) {
    logWriteError(err, 'node-http pre-dispatch error write failed');
  }
}

function logWriteError(err: unknown, message: string): void {
  // R-3: loud-not-silent. Bun's socket layer can surface write errors as
  // 'ERR_STREAM_DESTROYED'-style throws on dead peers; they must reach the
  // operator log, never an empty catch.
  console.error(`[forward-proxy] ${message}`, err);
}

/**
 * Build the MITM-leg transport. `captureEnabled` is the SURFACE capture
 * policy threaded in by the caller: `true` wires the
 * captureProcessContext() trio — who actually emits is the pipeline's
 * decision (it consults the recorder master). `false` answers {} and so
 * structurally disables client events on that leg.
 */
export function createNodeHttpTransport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  captureEnabled: boolean
): TransportContext {
  // Capture plumbing for the MITM leg: hand the ORIGINAL request line +
  // headers to the capture (they are otherwise empty on this path — no
  // Fastify request exists here). The response side is finalized
  // SYNCHRONOUSLY after res.end. Client-abort detection uses the REQUEST
  // side signal: on Bun, res 'finish'/'close' never fire on premature
  // disconnects (verified), but req 'aborted' does — so the handler only
  // flips a flag and finalizeCapture makes the single emit decision
  // (real status when the socket lived, synthetic 499 — nginx convention —
  // when the client was gone before the payload went out).
  let clientCtx: ClientExchangeContext | undefined;
  let clientGone = false;
  // SSE stall deadline (shared implementation, same reasoning as the Fastify
  // leg): a peer that never drains and never reports abort parks the relay, so
  // the exchange — including its terminal 499 — is closed from a timer instead.
  let sseWatchdog: ClientLegWatchdog | undefined;
  req.on('aborted', () => {
    clientGone = true;
    sseWatchdog?.stop();
  });
  const isClientGone = () => clientGone || res.destroyed || res.socket?.destroyed === true;
  const finalizeCapture = (gone = isClientGone()) => {
    if (!clientCtx || !clientCtx.recorder.isEnabled()) return;
    if (gone) {
      emitClientResponse(clientCtx, {
        statusCode: 499,
        statusMessage: 'Client Closed Request',
        getHeader: () => undefined,
      });
    } else {
      emitClientResponse(clientCtx, res);
    }
  };

  return {
    method: req.method || 'POST',
    url: req.url || '',
    headers: req.headers as Record<string, string | string[] | undefined>,
    clientIp: req.socket.remoteAddress || undefined,

    // Trusted-local-machine leg: see the POLICY EXEMPTION block above.
    access: {
      kind: 'exempt',
      keyName: '',
      policy: undefined,
      enforce: () => true,
    },

    captureProcessContext: () =>
      captureEnabled
        ? {
          clientRequest: {
            method: req.method || 'POST',
            url: req.url || '',
            headers: req.headers as Record<string, string | string[] | undefined>,
            // Scheme marker for the origin-form url case: an origin-form
            // url on this transport is always a TLS-DECRYPTED MITM leg
            // (plain-HTTP proxy requests arrive absolute-form and never
            // consult the marker).
            scheme: 'https' as const,
          },
          onClientExchange: (ctx: ClientExchangeContext) => {
            clientCtx = ctx;
          },
        }
        : {},

    relayUpstream: (up) => {
      // Verbatim origin relay (direct legs): the pipe IS the response —
      // status/headers/body bytes pass through untouched; the capture stash
      // accumulates the same bytes the client receives.
      try {
        res.writeHead(up.statusCode || 502, up.statusMessage, up.headers as http.OutgoingHttpHeaders);
      } catch (err) {
        logWriteError(err, 'node-http relayUpstream writeHead failed');
        up.stream.on('error', () => { });
        try { up.stream.destroy(); } catch { }
        finalizeCapture();
        return;
      }
      up.stream.on('data', (chunk: Buffer) => {
        if (clientCtx) appendClientResponseChunk(clientCtx, chunk.toString('utf8'));
      });
      res.once('close', () => {
        if (!res.writableEnded) {
          clientGone = true;
          try { up.stream.destroy(); } catch { }
          finalizeCapture();
        }
      });
      // Register 'end' BEFORE pipe() so finalizeCapture evaluates isClientGone()
      // before pipe's internal onend listener calls res.end()/destroy().
      up.stream.on('end', () => {
        finalizeCapture();
      });
      up.stream.pipe(res);
      up.stream.on('error', () => {
        try {
          res.destroy();
        } catch { }
        finalizeCapture();
      });
      up.stream.once('close', () => {
        finalizeCapture();
      });
    },
    sendJson: (status, payload, headers) => {
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch (err) {
        logWriteError(err, 'node-http sendJson payload serialization failed');
        serialized = '{"error":{"message":"Internal Router Error","type":"api_error"}}';
      }
      const goneBeforeSend = isClientGone();
      try {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          ...(headers ?? {}),
        });
        // Stash BEFORE end so the finalize below always sees the full body.
        if (clientCtx) appendClientResponseChunk(clientCtx, serialized);
        res.end(serialized);
      } catch (err) {
        logWriteError(err, 'node-http sendJson write failed');
      }
      finalizeCapture(goneBeforeSend);
    },

    beginSse: (headers) => {
      // R-5 SECURITY posture: deliberately NO 'Connection: keep-alive' and
      // NO 'Access-Control-Allow-Origin' here (the Fastify leg keeps both —
      // that leg owns browser CORS itself). The MITM leg impersonates the
      // upstream origin (api.openai.com etc.); adding ACAO:* would teach
      // any page the browser visited through the proxy that this forged
      // origin is CORS-permeable, widening the blast radius of the MITM CA.
      try {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          ...headers,
        });
      } catch (err) {
        logWriteError(err, 'node-http beginSse writeHead failed');
      }
      sseWatchdog = createClientLegWatchdog({
        onStall: (idleTimeoutMs) => {
          logWriteError(
            new Error(`No SSE frame reached the client for ${idleTimeoutMs}ms — closing the exchange`),
            'node-http SSE client leg stalled'
          );
          clientGone = true;
          try {
            res.destroy();
          } catch {
            // Already destroyed: exactly the state we are asserting.
          }
          finalizeCapture();
        },
      });
    },

    writeSseChunk: (chunk) => {
      // C-5: per-chunk write parity with the Fastify leg (byte streams stay
      // identical; the capture stash accumulates the same frames).
      if (clientCtx) {
        markClientResponseStreamStart(clientCtx);
        appendClientResponseChunk(clientCtx, chunk);
      }
      sseWatchdog?.progress();
      if (clientGone || res.destroyed || res.writableEnded) return;
      return writeWithBackpressure(res, chunk, (err) => logWriteError(err, 'node-http writeSseChunk failed'));
    },

    endSse: () => {
      sseWatchdog?.stop();
      const goneBeforeEnd = isClientGone();
      try {
        res.end();
      } catch (err) {
        logWriteError(err, 'node-http endSse failed');
      }
      finalizeCapture(goneBeforeEnd);
    },

    isClientGone,

    logError: (err, message) => {
      logWriteError(err, message);
    },
  };
}
