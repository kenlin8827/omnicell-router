import {
  buildV2ProviderNode,
  legacyShapedProviderPaths,
  patchJsonc,
  type ProviderDefInput,
} from './user-config.js';
import type { OpencodeFlavor } from './credentials/paths.js';
import { normalizeProtocols, protocolsFromLegacyNode } from '../providers/protocols-field.js';
import { currentPackageFor } from './provider-package.js';

/**
 * ONE def adapter per opencode FLAVOR — the client version decides which config
 * spelling is authoritative, exactly as the credential sync clients do.
 *
 *  - opencode-v1: defs live under the singular `provider` key in the v1 node
 *    spelling (`npm`/`options`/`models`). That spelling is v1's native one, so
 *    its adapter CONVERTS it through the same builder the console uses
 *    (`protocols`/`settings`) — translation between flavors, not compatibility.
 *  - opencode-v2: defs live under the canonical plural `providers` key. The
 *    client's live spelling is still `package`/`settings`; OCR truth is
 *    `protocols`/`settings`. The adapter converts either client shape (and any
 *    retired npm/options leftover) into the OCR node — never rejects a node
 *    that can be lifted, and never stores `package` in providers.json.
 *
 * The adapter layer also owns the client-config LAYOUT of the write direction
 * (`clientDefNodes`, `writeDefSlot`). No call site outside this module names a
 * slot, so "where do defs live" can never grow a second answer.
 */

export interface ProviderDefRead {
  node?: Record<string, any>;
  /** true when a client/retired spelling had to be translated into OCR shape. */
  converted?: boolean;
  error?: string;
}

export interface ProviderDefAdapter {
  flavor: OpencodeFlavor;
  /**
   * The client config key THIS flavor keeps its provider defs under. Private to
   * the adapter layer on purpose: callers ask for the operations below, never
   * for a slot name.
   */
  slot: 'provider' | 'providers';
  /** Read one raw client node and return the defs-file node it maps to. */
  read(id: string, raw: Record<string, any>): ProviderDefRead;
}

function isPlainRecord(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Any client-shaped node → OCR `protocols`/`settings` through the ONE def builder.
 * Lifts `package`/`npm`/`protocol` into `protocols[]` (ADR-0010); maps
 * `settings` or retired `options` into the builder's options bag.
 */
function convertClientNode(id: string, node: Record<string, any>): ProviderDefRead {
  const bag = isPlainRecord(node.settings)
    ? node.settings
    : isPlainRecord(node.options)
      ? node.options
      : {};
  // Client package / npm spellings → OCR protocol ids (opencode SDK map first).
  const lifted = protocolsFromLegacyNode(node) ?? normalizeProtocols(node.protocols);
  const protocols = normalizeProtocols(lifted.map((p) => currentPackageFor(p)));
  const def: ProviderDefInput = {
    id,
    // An inline key is carried only because it is ALREADY in a file; a
    // `{env:X}` value becomes env:["X"] instead (builder rules).
    apiKeyInline: typeof bag.apiKey === 'string',
    ...(typeof node.name === 'string' ? { name: node.name } : {}),
    ...(protocols.length > 0 ? { protocols } : {}),
    ...(typeof bag.baseURL === 'string' ? { baseURL: bag.baseURL } : {}),
    ...(typeof bag.apiKey === 'string' ? { apiKey: bag.apiKey } : {}),
    ...(isPlainRecord(node.headers) ? { headers: node.headers as Record<string, string> } : {}),
    options: bag,
    ...(isPlainRecord(node.models) ? { models: node.models } : {}),
    ...(Array.isArray(node.env) ? { env: node.env.filter((n: unknown): n is string => typeof n === 'string') } : {}),
    ...(typeof node.canonical === 'string' ? { canonical: node.canonical } : {}),
    ...(isPlainRecord(node.body) ? { body: node.body } : {}),
  };
  const built = buildV2ProviderNode(def);
  if (built.error || !built.node) return { error: built.error ?? 'empty node' };
  return { node: built.node, converted: true };
}

/** OCR-shaped already: protocols/settings (and no retired npm/package/options/protocol). */
function isOcrShapedNode(raw: Record<string, any>): boolean {
  return legacyShapedProviderPaths(raw).length === 0;
}

const V1_ADAPTER: ProviderDefAdapter = {
  flavor: 'opencode-v1',
  // The slot key IS this flavor's spelling — deliberately a literal, not a
  // shared constant: one name used by both adapters would erase the very
  // difference they exist to encode.
  slot: 'provider',
  read(id, raw) {
    // Shape decides, not the slot: a node already in OCR spelling is copied
    // verbatim; the v1 / client spelling is translated.
    if (isOcrShapedNode(raw)) return { node: { ...raw } };
    return convertClientNode(id, raw);
  },
};

const V2_ADAPTER: ProviderDefAdapter = {
  flavor: 'opencode-v2',
  slot: 'providers',
  read(id, raw) {
    // Live opencode-v2 clients still author `package`/`settings`. OCR stores
    // `protocols`/`settings`. Convert anything that is not already OCR-shaped
    // — including retired npm/options leftovers in this slot — instead of
    // rejecting a node the operator can use.
    if (isOcrShapedNode(raw)) return { node: { ...raw } };
    return convertClientNode(id, raw);
  },
};

/** The adapter for a client flavor; no flavor evidence resolves to the canonical spelling. */
export function providerDefAdapter(flavor: OpencodeFlavor | undefined): ProviderDefAdapter {
  return flavor === 'opencode-v1' ? V1_ADAPTER : V2_ADAPTER;
}

// ---------------------------------------------------------------------------
// Client config layout — the ONLY place that knows where defs live in the file
// ---------------------------------------------------------------------------

/**
 * The node map currently in the canonical slot (undefined when absent /
 * malformed). The materializer compares this against the defs book, and the sync
 * status view derives its `defsDrift` badge from the same call, so badge and
 * push agree.
 */
export function clientDefNodes(
  clientConfig: Record<string, any> | undefined
): Record<string, any> | undefined {
  const slot: unknown = clientConfig?.[V2_ADAPTER.slot];
  return isPlainRecord(slot) ? slot : undefined;
}

/**
 * Write the def book into the client config: REPLACE the canonical slot.
 *
 * The defs file stores OCR spelling (`protocols`/`settings`); materialize maps
 * that to the client's `package`/`settings` before this write. Only text-level
 * patching happens here, so comments outside the slot survive. An empty render
 * REMOVES the slot rather than leaving `{}`: no defs to carry means no key
 * worth having.
 */
export function writeDefSlot(configPath: string, providers: Record<string, unknown>): void {
  patchJsonc(configPath, [V2_ADAPTER.slot], Object.keys(providers).length > 0 ? providers : undefined);
}
