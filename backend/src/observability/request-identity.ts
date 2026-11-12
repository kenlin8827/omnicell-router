import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Request identity — the ONE vocabulary (ADR-0021). Every id names WHO
 * produced it and WHAT it scopes; there is no generic "trace id" abstraction
 * in the model.
 *
 *   - `requestId` / `sessionId` — the GATEWAY's own ids. Unqualified names
 *     are the local (default) namespace: `requestId` names one inference turn
 *     (unique, immutable — the trace record key, the console row identity,
 *     the capture join key; never supplied by a client), `sessionId` names
 *     the conversation entity.
 *   - `clientRequestId` — the caller's own correlation value (W3C
 *     `traceparent` trace-id, `x-request-id`, …). Optional, may repeat across
 *     requests (a trace is a DAG of many spans), correlation only — NEVER a
 *     key.
 *   - `exchangeId` — gateway-minted, one per HTTP exchange (request + its
 *     response share it). Pairs capture events; there are 2+ exchanges per
 *     request (client leg, upstream leg, each failover attempt).
 *
 * This module is a BOUNDARY adapter: it parses W3C Trace Context
 * (https://www.w3.org/TR/trace-context/) and the de-facto correlation
 * headers, and mints the gateway-owned ids. Downstream code never sees the
 * wire vocabulary.
 */

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * Inbound correlation headers, in precedence order: W3C `traceparent` (the
 * canonical, most explicit form) first, then the de-facto LLM-SDK headers.
 * A malformed value falls through — the request is never rejected over it.
 */
const CLIENT_REQUEST_ID_HEADERS = [
  'traceparent',
  'x-request-id',
  'x-trace-id',
  'x-correlation-id',
  'request-id',
] as const;

export type ClientRequestIdSource = (typeof CLIENT_REQUEST_ID_HEADERS)[number];

/**
 * Extract the caller's correlation id. Absent when the caller sent none —
 * the gateway does NOT invent one (an invented value would be a
 * gateway-owned id in disguise; that role belongs to `requestId`).
 */
export function resolveClientRequestId(
  req: Pick<FastifyRequest, 'headers'> | { headers?: Record<string, string | string[] | undefined> }
): { clientRequestId?: string; source?: ClientRequestIdSource } {
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;

  for (const name of CLIENT_REQUEST_ID_HEADERS) {
    const raw = pickHeader(headers, name);
    if (!raw) continue;
    const value = raw.trim();
    if (!value) continue;

    if (name === 'traceparent') {
      const m = TRACEPARENT_RE.exec(value);
      // W3C: invalid traceparent is ignored, not fatal.
      if (m && TRACE_ID_RE.test(m[2])) return { clientRequestId: m[2].toLowerCase(), source: name };
      continue;
    }

    // Opaque id (UUID / NanoID / base32 / provider slug) — preserved VERBATIM
    // so the caller's correlation link stays byte-exact: these alphabets are
    // case-sensitive, and lowercasing would silently break the join. Bounded
    // only to keep the value displayable.
    if (value.length <= 128) return { clientRequestId: value, source: name };
  }

  return {};
}

/**
 * Mint the gateway-owned id of one inference turn.
 *
 * The `req_` prefix is deliberate: console rows show both ids side by side and
 * operators paste them into URLs, so a gateway id must not read as "an
 * unprefixed caller id". 96 bits of entropy keeps collisions negligible.
 */
export function mintRequestId(): string {
  return `req_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Mint one HTTP exchange id: 64 bits, 16 hex — enough for uniqueness within a
 * request (2-6 exchanges) and recognizably the same shape the W3C span model
 * uses on the wire (this value is not a span id; it is ours).
 */
export function mintExchangeId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Build a W3C-compatible traceparent for an OUTGOING request — a wire helper
 * for upstream propagation. `clientRequestId` is the caller's trace-id and
 * `exchangeId` our exchange id (acting as the parent span id on the wire).
 */
export function buildTraceparent(clientRequestId: string, exchangeId: string): string {
  return `00-${clientRequestId}-${exchangeId}-01`;
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}
