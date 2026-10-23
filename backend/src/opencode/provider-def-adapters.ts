import { buildV2ProviderNode, legacyShapedProviderPaths, patchJsonc, type ProviderDefInput } from './user-config.js';
import type { OpencodeFlavor } from './credentials/paths.js';

/**
 * ONE def adapter per opencode FLAVOR — the client version decides which config
 * spelling is authoritative, exactly as the credential sync clients do.
 *
 *  - opencode-v1: defs live under the singular `provider` key in the v1 node
 *    spelling (`npm`/`options`/`models`). That spelling is v1's native one, so
 *    its adapter CONVERTS it through the same builder the console uses
 *    (`package`/`settings`) — translation between flavors, not compatibility.
 *  - opencode-v2: defs live under the canonical plural `providers` key in the
 *    `package`/`settings` spelling — which IS the defs-file spelling, so its
 *    adapter copies verbatim and refuses anything else.
 *
 * The adapter layer also owns the client-config LAYOUT of the write direction
 * (`clientDefNodes`, `writeDefSlot`). No call site outside this module names a
 * slot, so "where do defs live" can never grow a second answer.
 */

export interface ProviderDefRead {
  node?: Record<string, any>;
  /** true when the v1 native spelling had to be translated. */
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

/** v1 native node → current node through the ONE def builder. */
function convertRetiredNode(id: string, node: Record<string, any>): ProviderDefRead {
  const options = isPlainRecord(node.options) ? node.options : {};
  const def: ProviderDefInput = {
    id,
    // An inline key is carried only because it is ALREADY in a file; a
    // `{env:X}` value becomes env:["X"] instead (builder rules).
    apiKeyInline: typeof options.apiKey === 'string',
    ...(typeof node.name === 'string' ? { name: node.name } : {}),
    ...(typeof node.npm === 'string' ? { npm: node.npm } : {}),
    ...(typeof options.baseURL === 'string' ? { baseURL: options.baseURL } : {}),
    ...(typeof options.apiKey === 'string' ? { apiKey: options.apiKey } : {}),
    ...(isPlainRecord(node.headers) ? { headers: node.headers as Record<string, string> } : {}),
    options,
    ...(isPlainRecord(node.models) ? { models: node.models } : {}),
    ...(Array.isArray(node.env) ? { env: node.env.filter((n: unknown): n is string => typeof n === 'string') } : {}),
    ...(typeof node.canonical === 'string' ? { canonical: node.canonical } : {}),
    ...(isPlainRecord(node.body) ? { body: node.body } : {}),
  };
  const built = buildV2ProviderNode(def);
  if (built.error || !built.node) return { error: built.error ?? 'empty node' };
  return { node: built.node, converted: true };
}

const V1_ADAPTER: ProviderDefAdapter = {
  flavor: 'opencode-v1',
  // The slot key IS this flavor's spelling — deliberately a literal, not a
  // shared constant: one name used by both adapters would erase the very
  // difference they exist to encode.
  slot: 'provider',
  read(id, raw) {
    // Shape decides, not the slot: a node already in the current spelling is
    // copied verbatim; the v1 spelling is translated.
    if (legacyShapedProviderPaths(raw).length === 0) return { node: { ...raw } };
    return convertRetiredNode(id, raw);
  },
};

const V2_ADAPTER: ProviderDefAdapter = {
  flavor: 'opencode-v2',
  slot: 'providers',
  read(_id, raw) {
    // Verbatim: this slot's spelling IS the defs-file spelling. A node still in
    // the v1 spelling would be stored as a def nothing can render, so it is
    // reported loudly instead of half-imported.
    if (legacyShapedProviderPaths(raw).length > 0) {
      return { error: 'retired npm/options node in the canonical `providers` slot — re-author it as package/settings' };
    }
    return { node: { ...raw } };
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
 * The defs file stores the v2 spelling, so the canonical slot is the only write
 * peer (a v1 client gets key sync, never def writes — the render is identity, and
 * landing v2 nodes under the retired spelling would corrupt its contract). Only
 * text-level patching happens here, so comments outside the slot survive. An
 * empty render REMOVES the slot rather than leaving `{}`: no defs to carry means
 * no key worth having.
 */
export function writeDefSlot(configPath: string, providers: Record<string, unknown>): void {
  patchJsonc(configPath, [V2_ADAPTER.slot], Object.keys(providers).length > 0 ? providers : undefined);
}
