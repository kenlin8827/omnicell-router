import type http from 'node:http';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { detectSurface } from '../surfaces/table.js';
import { dispatchSurface } from '../surfaces/dispatch.js';
import { createNodeHttpTransport, readRequestBody, sendPreDispatchError } from '../surfaces/transport-node-http.js';

/**
 * Content-level LLM interception for the forward proxy.
 *
 * Runs on DECRYPTED requests (MITM'd HTTPS or plain HTTP). Only canonical LLM
 * endpoints are intercepted — path detection is TABLE-DRIVEN
 * (surfaces/table.ts, the same registry the Fastify routes register from),
 * so anything unmatched returns false → transparent forward.
 *
 * Matched traffic goes through the SAME dispatchSurface pipelines as the
 * native /v1 endpoints (one shared surface dispatch, contract §1): identical
 * parse-400 texts, error envelopes, X-OCR header set, RespStore statefulness
 * across legs, and capture pairing. This file holds NO protocol logic
 * anymore — transport primitives live in surfaces/transport-node-http.ts.
 *
 * POLICY EXEMPTION (deliberate): intercepted traffic carries no gateway key;
 * the authoritative note is in surfaces/transport-node-http.ts (the 'exempt'
 * ModelAccessGate). Do NOT "fix" it by inventing key headers here.
 */

export function createProxyInterceptor(
  orchestrator: PipelineOrchestrator
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  return async function intercept(req, res): Promise<boolean> {
    if (req.method !== 'POST') return false;
    const surface = detectSurface(req.url || '');
    if (!surface) return false;
    // Every table entry dispatches here now (chat family + the decision
    // surface wired in step 4) — no per-exec guard lives in this file.

    let raw: Buffer;
    try {
      raw = await readRequestBody(req);
    } catch (err) {
      sendPreDispatchError(res, surface, 413, err instanceof Error ? err.message : 'Request body too large');
      return true;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendPreDispatchError(res, surface, 400, 'Invalid JSON body');
      return true;
    }
    if (!body || typeof body !== 'object') {
      sendPreDispatchError(res, surface, 400, 'Invalid JSON body');
      return true;
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
      t.logError(err, 'Forward-proxy interception failed');
      if (!res.headersSent) {
        sendPreDispatchError(res, surface, 500, 'Internal Router Error');
      }
    }
    return true;
  };
}
