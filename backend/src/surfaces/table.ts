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
