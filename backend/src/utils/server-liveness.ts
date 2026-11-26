import type http from 'node:http';
import {
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  SERVER_REQUEST_TIMEOUT_MS,
} from '../config/defaults.js';

/**
 * INBOUND liveness bounds, spelled ONCE for every listener the gateway owns.
 *
 * The numbers live in `config/defaults.ts` (single source); this module only turns
 * them into the two shapes a server needs, so a future fourth listener cannot
 * quietly re-pick its own timeouts. Leaving these to the runtime is not neutral:
 * Node ships 300s / 60s / 5s, Bun ships none, so the same slow client holds a
 * socket open forever on one runtime and is reaped on the other. These values
 * match Node's shipped numbers deliberately — on Node this changes nothing, it
 * makes Bun behave like Node instead of behaving undefined.
 *
 * Per-chunk body progress is a DIFFERENT bound that a server-level clock cannot
 * express (`requestTimeout` measures the whole request, so a trickling client never
 * trips it): see `REQUEST_BODY_IDLE_TIMEOUT_MS` in
 * `surfaces/transport-node-http.ts`.
 */

/** Option-object form — Fastify and `http.createServer` both take these keys.
 *  Mutable widened type on purpose: an `as const` object makes Fastify's generic
 *  inference pick a different server type and the instance stops typechecking. */
export const INBOUND_LIVENESS_OPTIONS: {
  requestTimeout: number;
  headersTimeout: number;
  keepAliveTimeout: number;
} = {
  requestTimeout: SERVER_REQUEST_TIMEOUT_MS,
  headersTimeout: SERVER_HEADERS_TIMEOUT_MS,
  keepAliveTimeout: SERVER_KEEP_ALIVE_TIMEOUT_MS,
};

/** Assignment form — for a server instance that was already constructed. */
export function applyInboundLiveness(server: http.Server): void {
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
}
