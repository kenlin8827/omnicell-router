/**
 * Prefer-native southbound dial from a model's `protocols[]` (ADR-0033).
 *
 * One attempt speaks exactly one wire. Selection:
 *  1. inbound surface id if listed in `protocols`
 *  2. first declaration-order entry that admits the canonical request
 *  3. otherwise `protocols[0]` (existing gate honesty)
 */

import type { CanonicalRequest } from '../ir/types.js';
import type { ProtocolId } from '../ir/types.js';
import { assertCanonicalRequestSupported } from '../ir/validate.js';
import type { WireKind } from './wire.js';
import { primaryProtocol } from './protocols-field.js';

const CORE_SURFACE_WIRES = new Set<string>([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
]);

function admits(ir: CanonicalRequest, protocol: string): boolean {
  if (!CORE_SURFACE_WIRES.has(protocol) && protocol !== 'google-gemini') {
    // Plugin / decision wires: capability matrix may not list them; keep them
    // eligible only via inbound match or as declaration fallback.
    return false;
  }
  try {
    assertCanonicalRequestSupported(ir, protocol as ProtocolId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the outbound wire for this attempt.
 * @param protocols ordered dial set (already resolved for the model)
 * @param inboundWire client surface protocol id, when known
 * @param request canonical IR for capability escalate
 */
export function pickDialWire(
  protocols: readonly string[] | undefined,
  inboundWire: string | undefined,
  request: CanonicalRequest,
): WireKind {
  const list = protocols && protocols.length > 0 ? [...protocols] : [primaryProtocol(undefined)];
  const inbound = inboundWire?.trim();
  if (inbound && list.includes(inbound)) {
    return inbound as WireKind;
  }
  for (const id of list) {
    if (inbound && id === inbound) continue;
    if (admits(request, id)) return id as WireKind;
  }
  return list[0] as WireKind;
}
