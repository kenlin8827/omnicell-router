import { anthropicSurface } from './anthropic.js';
import { chatSurface } from './chat.js';
import { responsesSurface } from './responses.js';
import { systemoneSurface } from './systemone.js';
import type { ProtocolSurface } from './types.js';

/**
 * The protocol-surface registry. A single table drives BOTH route
 * registration (server.ts shim) and MITM path detection (detectSurface),
 * so a new wire is added by appending an entry — no second switch to keep
 * in sync.
 *
 * Order is the frozen §1 table order (chat, anthropic, responses, systemone;
 * steps 2/3a/3b/4 respectively). Detection is order-independent in practice:
 * the four detectSuffix values are mutually non-overlapping, so no path can
 * match two entries.
 */
export const SURFACES: readonly ProtocolSurface[] = [
  chatSurface,
  anthropicSurface,
  responsesSurface,
  systemoneSurface,
];

/**
 * The exact request paths the gateway SERVES for inference traffic — the set
 * the inbound rate limiter meters against (server.ts preHandler). Derived from
 * the same rows as routePath, so appending a table entry joins route
 * registration, MITM detection and metering in one move.
 *
 * MATCHING MODE HERE IS EXACT PATH EQUALITY, not the suffix match
 * detectSurface uses. That is sound while every wire addresses its model in
 * the BODY (routePath is then the whole route). A wire that addresses the
 * model IN THE URL — Gemini `POST /v1beta/models/<model>:generateContent`,
 * Bedrock `/model/<id>/converse` — needs a per-surface path matcher here
 * instead of a set: appended as-is its traffic would route and bill normally
 * but stay UNMETERED, because no concrete URL equals routePath.
 */
export const INFERENCE_ROUTE_PATHS: ReadonlySet<string> = new Set(SURFACES.map((s) => s.routePath));

/**
 * Suffix match against the table. Lowercased, query stripped. detectSuffix
 * is intentionally WIDER than routePath on the decision leg —
 * callers pass path+query from raw transports where the prefix is not
 * guaranteed to be the gateway mount.
 */
export function detectSurface(pathAndQuery: string): ProtocolSurface | null {
  const p = (pathAndQuery || '').split('?')[0].toLowerCase();
  for (const s of SURFACES) if (p.endsWith(s.detectSuffix)) return s;
  return null;
}
