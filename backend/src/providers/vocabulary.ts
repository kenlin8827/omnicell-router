/**
 * The OCR protocol vocabulary — ONE table, served to the console over
 * `/api/admin/opencode/protocol-vocabulary` so every UI surface (custom-provider
 * form dropdown, model-level protocol editor, display-name mapping) renders the
 * SAME list in the SAME order without keeping a second copy in frontend code.
 *
 * OCR is decoupled from SDK packages: these are protocol ids. The opencode
 * integration owns the separate SDK-package mapping table
 * (`opencode/provider-package.ts`).
 *
 * Consistency contracts (pinned by vocabulary.test.ts):
 *   - every entry resolves through wire.ts (no invented wire kinds);
 *   - `order` is the UI dropdown order: chat-wire majors first.
 */
import { wireFor } from './wire.js';
import { canonicalProtocol } from './protocol.js';
import { claimedPluginWires } from './plugin-wires.js';

export interface ProtocolVocabularyEntry {
  /** Canonical protocol id (also the value rendered in the dropdown). */
  alias: string;
  /** Same id — kept so readers can address either field without a second map. */
  package: string;
  /** Resolved wire — informational for the UI, authoritative in wireFor(). */
  wire: string;
  /** UI dropdown order (ascending). */
  order: number;
}

const RAW_ENTRIES: Omit<ProtocolVocabularyEntry, 'wire'>[] = [
  { alias: 'openai-chat', package: 'openai-chat', order: 10 },
  { alias: 'anthropic-messages', package: 'anthropic-messages', order: 20 },
  { alias: 'openai-responses', package: 'openai-responses', order: 30 },
  { alias: 'google-gemini', package: 'google-gemini', order: 40 },
  // The TypeSafe decision wire is OFFERED: a def authored with it keeps the
  // decision wire end to end. The client copy is made loadable by
  // CLIENT_PACKAGE_FALLBACK (def-materialize.ts) — offering the protocol must
  // not depend on the client having shipped a matching SDK module.
  { alias: 'systemone', package: 'systemone', order: 50 },
  // Unroutable protocols (azure / bedrock / vertex — SDK-side URL construction
  // / SigV4 signing, wire 'unroutable') are deliberately NOT offered:
  // suggesting them would invite authoring a def the router can never serve.
  //
  // Plugin-owned protocols are NOT listed here: no core file names a vendor
  // protocol, because the offering is derived from what an INSTALLED plugin
  // claims (see `protocolVocabulary`).
];

/** First order value handed to plugin-owned protocols — after the last static
 *  entry, so the kind split stays visible in the dropdown. */
const PLUGIN_ORDER_BASE = 95;

/**
 * The offered protocol table, rebuilt per call.
 *
 * Static core protocols plus every wire a LOADED model-service plugin claims
 * (bare protocol id = wire id). Deriving the plugin half from the live registry
 * is what keeps the dropdown honest in both directions: a protocol nobody can
 * execute is never suggested, and a newly installed plugin becomes selectable
 * with no core edit. Uninstalling drops the rows back out.
 */
export function protocolVocabulary(): ProtocolVocabularyEntry[] {
  const entries: ProtocolVocabularyEntry[] = RAW_ENTRIES.map((e) => ({
    ...e,
    wire: wireFor(e.alias),
  }));
  const taken = new Set(entries.map((e) => e.alias));
  let order = PLUGIN_ORDER_BASE;
  for (const wire of claimedPluginWires()) {
    // A plugin wire is offered under its own protocol id and only when that id
    // resolves to itself (a plugin cannot annex a core protocol).
    if (taken.has(wire) || wireFor(wire) !== wire) continue;
    taken.add(wire);
    entries.push({ alias: wire, package: wire, wire, order: order++ });
  }
  return entries;
}

/**
 * Protocol id that SPEAKS a resolved wire — the display inverse of `wireFor`.
 * The playground's per-turn chip and the console's session column both name the
 * OUTBOUND protocol, but execution only knows the wire; this maps it back
 * through the same offered table so the two surfaces print one id.
 *
 * Fail-open: a wire with no offered protocol (a plugin wire whose plugin is not
 * installed, `unroutable`) keeps its own id — a chip must never invent a
 * protocol the gateway cannot execute.
 */
export function protocolForWire(wire: string): string {
  // Old traces/configs stored the retired short wire spellings; normalize them
  // so a legacy row still prints the SAME protocol id the current row would.
  const canonical = canonicalProtocol(wire);
  for (const entry of protocolVocabulary()) {
    if (entry.wire === canonical) return entry.alias;
  }
  return wire;
}
