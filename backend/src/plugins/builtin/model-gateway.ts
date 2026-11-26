import type http from 'node:http';
import type { PipelineOrchestrator } from '../../pipeline/orchestrator.js';
import { dispatchSurface } from '../../surfaces/dispatch.js';
import { detectSurface } from '../../surfaces/table.js';
import { createNodeHttpTransport, readRequestBody, sendPreDispatchError } from '../../surfaces/transport-node-http.js';
import type { ClientGatewayPlugin } from '../types.js';
import { decompressBody, invalidJsonBody, isBodyAdmissionError, logBodyRejection, parseJsonBody, requestContentEncoding, preflightBodyAdmission, bodyLimitFor } from '../../surfaces/body-admission.js';

/**
 * The BUILT-IN universal gateway — the canonical model wires, expressed as a
 * gateway like any other (ADR-0026 revision 2).
 *
 * Why this exists rather than a package:
 *
 * Serving a decrypted canonical request is not just "run the pipeline". The
 * request arrives as node-http `req`/`res`, and turning that pair into a
 * `TransportContext` is where four policies live that a package cannot
 * restate: body reading with the 32 MB cap (413 envelope), the client-exchange
 * capture (`observability/http-exchange.ts` — the console's per-turn view),
 * the keyless POLICY EXEMPTION, and the surface-shaped error envelopes. A
 * packaged copy would either duplicate all four (drift) or silently lose
 * capture the moment an operator installed it.
 *
 * So the adapter stays in core and the ROW is what moves: the interceptor no
 * longer owns a dispatch branch at all — it asks the registry, exactly as it
 * does for Cursor, and this row answers last. Installing a package that claims
 * the wildcard pre-empts this row with no core change; disabling it hands the
 * traffic back here. That is the seam; the floor is just the default occupant.
 *
 * Both halves of the identity matter:
 *   - `hosts: ['*']` — willing to answer on any host nothing else claimed;
 *   - `match()` — accepting only `POST` on a canonical surface path, which is
 *     what keeps telemetry, uploads and every other vendor RPC transparent.
 */
export const BUILTIN_MODEL_GATEWAY_ID = 'model-gateway';

export function createBuiltinModelGateway(orchestrator: PipelineOrchestrator): ClientGatewayPlugin {
  return {
    hosts: ['*'],

    match(info: { method?: string; url?: string; headers: http.IncomingHttpHeaders }): boolean {
      if ((info.method || '').toUpperCase() !== 'POST') return false;
      // h1 carries the target on `url`; the h2 compat layer exposes it as
      // `:path`. Accept either so the row behaves identically on both legs.
      const target = info.url || String(info.headers[':path'] || '');
      return detectSurface(target) !== null;
    },

    async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      // The registry scopes the host, `match()` scoped the method and path —
      // anything reaching here is canonical by construction, but re-detect
      // rather than trust: this is also the direct-call entry (tests).
      const surface = detectSurface(req.url || '');
      if (!surface) {
        // Cannot answer: the caller (interceptor) treats a true return as
        // "handled", so an accept that stops being true mid-flight must not
        // leave the client hanging — 404 in the nearest envelope we have.
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'No canonical surface for this path' } }));
        return;
      }

      let receivedBytes: number | undefined;
      let body: unknown;
      try {
        // Media type and request coding are checked BEFORE the body is read:
        // a form-urlencoded or XML upload must be refused rather than buffered and
        // then rejected as "invalid JSON", and a body claiming a coding the gateway
        // cannot decode must not pay for its own upload. The native leg refuses the
        // same types (Fastify's own media-type gate) and the same codings, so the two
        // legs cannot disagree about serviceability.
        const preRefusal = preflightBodyAdmission(req.headers);
        if (preRefusal) throw preRefusal;
        const raw = await readRequestBody(req);
        receivedBytes = raw.length;
        // Same admission policy as the native leg: decode Content-Encoding with
        // the cap re-checked on the INFLATED size (readRequestBody bounded the
        // wire size), then parse. Both throw BodyAdmissionError carrying status,
        // code and the client-facing message, so the two legs cannot drift.
        body = parseJsonBody(decompressBody(raw, req.headers));
      } catch (err) {
        if (!isBodyAdmissionError(err)) {
          // A socket/read failure is not an admission decision — answer 400 with
          // the underlying reason rather than hanging the client.
          sendPreDispatchError(res, surface, 400, err instanceof Error ? err.message : 'Unreadable request body');
          return;
        }
        logBodyRejection(
          {
            leg: 'mitm',
            path: req.url || '',
            err,
            capBytes: bodyLimitFor('gateway'),
            receivedBytes,
            encoding: requestContentEncoding(req.headers),
          },
          undefined
        );
        sendPreDispatchError(res, surface, err.statusCode, err.message, err.code, err.headers);
        return;
      }
      if (!body || typeof body !== 'object') {
        // Valid JSON, wrong shape (array/string/number/null). Same 400 and the
        // same code and words as the native leg's shape check — the client's fix
        // is identical to a parse failure's.
        sendPreDispatchError(res, surface, 400, invalidJsonBody().message, 'invalid_json_body');
        return;
      }

      // surface.capture is the PROTOCOL-LEVEL capture policy (chat family:
      // always true; the decision surface wires capture in its pipeline only
      // behind the requestCapture.enabled master).
      const t = createNodeHttpTransport(req, res, surface.capture);
      try {
        await dispatchSurface(t, surface, orchestrator, body);
      } catch (err) {
        // Terminal sends inside the pipeline never throw (each is individually
        // guarded in the transport) and the pipeline's own catch covers
        // execution errors — reaching HERE means dispatch threw before any
        // terminal send (e.g. a disk-corrupt config re-read inside the
        // orchestrator). Without a fallback the MITM client would hang until
        // socket timeout, so answer with the surface's 500 envelope — but ONLY
        // while nothing has been written yet (headersSent ⇒ a partial/buggy
        // send already owns the wire; adding bytes would double-answer).
        t.logError(err, 'Gateway model dispatch failed');
        if (!res.headersSent) {
          sendPreDispatchError(res, surface, 500, 'Internal Router Error');
        }
      }
    },
  };
}
