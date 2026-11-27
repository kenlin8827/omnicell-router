/**
 * OCR-owned `protocols: string[]` helpers (ADR-0010 clean schema).
 *
 * Steady-state truth never stores `npm` / `package` / `protocol` as the dial
 * slot. Migrators may call `protocolsFromLegacyNode` once while rewriting a
 * file; after the hop, readers use `normalizeProtocols` / `primaryProtocol`
 * only.
 */

import { currentProtocol } from './protocol.js';

const DEFAULT_PROTOCOL = 'openai-chat';

/** Coerce any value into a deduped, ordered list of OCR protocol ids. */
export function normalizeProtocols(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const id = currentProtocol(item.trim());
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [currentProtocol(raw.trim())];
  }
  return [];
}

/** First declared protocol, or the chat default when the list is empty. */
export function primaryProtocol(protocols: readonly string[] | undefined): string {
  return protocols && protocols.length > 0 ? protocols[0]! : DEFAULT_PROTOCOL;
}

/**
 * Migrator-only: lift retired singular slots on one object into `protocols`.
 * Does not mutate `node`. Returns undefined when nothing protocol-shaped was found.
 */
export function protocolsFromLegacyNode(node: Record<string, unknown> | null | undefined): string[] | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node.protocols) || typeof node.protocols === 'string') {
    const list = normalizeProtocols(node.protocols);
    return list.length > 0 ? list : undefined;
  }
  for (const key of ['package', 'npm', 'protocol'] as const) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) {
      return normalizeProtocols(v);
    }
  }
  return undefined;
}

/**
 * Strip retired protocol-slot keys from a shallow copy of `node`.
 * Used by migrators after writing `protocols`.
 */
export function stripLegacyProtocolKeys<T extends Record<string, unknown>>(node: T): T {
  const next = { ...node };
  delete (next as Record<string, unknown>).npm;
  delete (next as Record<string, unknown>).package;
  delete (next as Record<string, unknown>).protocol;
  return next;
}

export { DEFAULT_PROTOCOL };
