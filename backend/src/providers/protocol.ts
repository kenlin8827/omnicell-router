/**
 * OCR protocol ids — the ONLY protocol vocabulary OCR stores and serves.
 *
 * Canonical ids (storage, wire, console, plugin manifest `protocol`):
 *   `openai-chat`, `openai-responses`, `anthropic-messages`,
 *   `google-gemini`, `systemone` — plus any protocol id a plugin declares.
 * The canonical id IS the wire id (ADR-0033): there is no second "short wire"
 * vocabulary. A display-only alias lives in the frontend, never in storage.
 *
 * OCR is decoupled from any client SDK: a provider def carries a protocol
 * (`anthropic-messages`, `openai-chat`, …), never an npm package.
 * The opencode SDK spelling lives exclusively in the opencode integration
 * (`opencode/provider-package.ts`), which maps its package vocabulary to these
 * ids on import and back on export.
 *
 * Legacy defs books, plugins, SDK packages and old wire spellings are
 * translated here so an upgrade keeps routing; no write path emits them again.
 * Accepted legacy ids: `responses`, `anthropic`, `google` and the old bare
 * wire `openai` (handled by protocolForWire, not here — as an npm token
 * `openai` means the Responses SDK, matching `@ai-sdk/openai`).
 */
const LEGACY_ALIASES: Record<string, string> = {
  '@ai-sdk/openai-compatible': 'openai-chat',
  'openai-compatible': 'openai-chat',
  '@ai-sdk/azure': 'azure',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/google': 'google-gemini',
  '@ai-sdk/typesafe-ai': 'systemone',
  '@ai-sdk/qoder': 'qoder',
  '@ai-sdk/workbuddy': 'workbuddy',
  // Chat-compatible vendor packages carried no distinct wire.
  '@ai-sdk/xai': 'openai-chat',
  '@ai-sdk/mistral': 'openai-chat',
  // The Responses protocol is OpenAI's second API shape; keep it explicitly
  // under the OpenAI name instead of a generic `responses` token.
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
  google: 'google-gemini',
};

/** Normalize any historical spelling to the canonical protocol id. */
export function currentProtocol(value: string): string {
  const v = (value || '').trim().toLowerCase();
  return Object.hasOwn(LEGACY_ALIASES, v) ? LEGACY_ALIASES[v] : v;
}

/** Legacy short WIRE spellings -> canonical id. Used only where an OLD stored
 *  wire value (trace `wireKind`, config `type`) is read; npm tokens never pass
 *  through here — `currentProtocol` owns that direction. */
const LEGACY_WIRE_ALIASES: Record<string, string> = {
  openai: 'openai-chat',
  chat: 'openai-chat',
  'openai-compatible': 'openai-chat',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
  google: 'google-gemini',
};

/** Canonical id for any stored wire/protocol value, new or legacy. */
export function canonicalProtocol(value: string): string {
  const v = (value || '').trim().toLowerCase();
  return Object.hasOwn(LEGACY_WIRE_ALIASES, v) ? LEGACY_WIRE_ALIASES[v] : currentProtocol(v);
}
