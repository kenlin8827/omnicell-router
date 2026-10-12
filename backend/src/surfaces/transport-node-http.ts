import type http from 'node:http';
import {
  appendGatewayResponseChunk,
  emitGatewayResponse,
  type ClientExchangeContext,
} from '../observability/http-exchange.js';
import type { ProtocolSurface, TransportContext } from './types.js';

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

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Read the request body with a hard 32 MB cap (migrated verbatim from the
 * pre-refactor interceptor). Oversized bodies reject with 'Request body
 * too large' → the caller maps that to 413 via surface.errorBody.
 */
export function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (d: Buffer) => {
      total += d.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
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
  message: string
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(surface.errorBody(status, message));
  } catch (err) {
    logWriteError(err, 'node-http pre-dispatch error body serialization failed');
    return;
  }
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(serialized);
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
 * policy threaded in by the caller: `true` (chat family) and `'configurable'`
 * (decision family, ADR-0016) both wire the captureProcessContext() trio —
 * who actually emits is the pipeline's decision. `false` answers {} and so
 * structurally disables client events on that leg.
 */
export function createNodeHttpTransport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  captureEnabled: boolean | 'configurable'
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
  req.on('aborted', () => {
    clientGone = true;
  });
  const finalizeCapture = () => {
    if (!clientCtx || !clientCtx.recorder.isEnabled()) return;
    if (clientGone || res.socket?.destroyed) {
      emitGatewayResponse(clientCtx, {
        statusCode: 499,
        statusMessage: 'Client Closed Request',
        getHeader: () => undefined,
      });
    } else {
      emitGatewayResponse(clientCtx, res);
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
            },
            onClientExchange: (ctx: ClientExchangeContext) => {
              clientCtx = ctx;
            },
          }
        : {},

    sendJson: (status, payload, headers) => {
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch (err) {
        logWriteError(err, 'node-http sendJson payload serialization failed');
        serialized = '{"error":{"message":"Internal Router Error","type":"api_error"}}';
      }
      try {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          ...(headers ?? {}),
        });
        // Stash BEFORE end so the finalize below always sees the full body.
        if (clientCtx) appendGatewayResponseChunk(clientCtx, serialized);
        res.end(serialized);
      } catch (err) {
        logWriteError(err, 'node-http sendJson write failed');
      }
      finalizeCapture();
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
    },

    writeSseChunk: (chunk) => {
      // C-5: per-chunk write parity with the Fastify leg (byte streams stay
      // identical; the capture stash accumulates the same frames).
      try {
        if (clientCtx) appendGatewayResponseChunk(clientCtx, chunk);
        res.write(chunk);
      } catch (err) {
        logWriteError(err, 'node-http writeSseChunk failed');
      }
    },

    endSse: () => {
      try {
        res.end();
      } catch (err) {
        logWriteError(err, 'node-http endSse failed');
      }
      finalizeCapture();
    },

    isClientGone: () => clientGone || res.socket?.destroyed === true,

    logError: (err, message) => {
      logWriteError(err, message);
    },
  };
}
