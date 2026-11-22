import type http from 'node:http';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { createBuiltinModelGateway } from '../plugins/builtin/model-gateway.js';
import { findGateway } from '../plugins/gateways.js';
import { proxyCallerOf, runWithProxyCaller } from './caller-context.js';

/**
 * Decrypted-request dispatch for the forward proxy, in exactly TWO outcomes
 * (ADR-0026 revision 2):
 *
 *   1. a GATEWAY accepts this request — an exact SNI host claim, an installed
 *      wildcard claim, or last of all the built-in universal gateway — and
 *      owns it from there;
 *   2. nothing accepted it: this is not model traffic, return false and let
 *      the caller forward it transparently, byte-for-byte.
 *
 * There is deliberately no third branch any more. Model service is not
 * something this file does; it is something a gateway does, and the built-in
 * row (`plugins/builtin/model-gateway.ts`) is merely the default occupant of
 * that slot. Installing a package that claims the wildcard takes over with no
 * core change; disabling it hands the traffic straight back.
 *
 * POLICY: intercepted traffic carries NO gateway key — the authoritative note
 * lives in `surfaces/transport-node-http.ts` (the node-http transport); do NOT
 * invent key headers here. Gateway-plugin completions are the exception: they
 * inherit the CONNECT credential bound by `caller-context.ts` (ADR-0017).
 */
export function createProxyInterceptor(
  orchestrator: PipelineOrchestrator
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  // The built-in row needs the live orchestrator, and this factory is the one
  // place that has it. It is captured HERE rather than stored in the gateway
  // registry: two interceptors can exist in one process, and a shared slot
  // would let the later factory re-point the earlier server's model traffic.
  const builtin = createBuiltinModelGateway(orchestrator);

  return async function intercept(req, res): Promise<boolean> {
    const gateway = findGateway(req, builtin);
    if (!gateway) return false;

    try {
      await runWithProxyCaller(proxyCallerOf(req), () => gateway.handle(req, res));
    } catch {
      // The built-in row answers its own failures in the surface envelope; a
      // plugin that throws past its own error handling gets the proxy's
      // generic refusal rather than a hung socket.
      if (!res.headersSent) {
        try {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: 'Gateway handler failed' } }));
        } catch {}
      }
    }
    return true;
  };
}
