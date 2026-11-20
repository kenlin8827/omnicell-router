import { currentProtocol } from '../providers/protocol.js';

/**
 * opencode-v2 package vocabulary — the IMPORT-direction compatibility layer
 * (opencode config → OCR defs book), owned by the opencode integration and NOT
 * by wire resolution.
 *
 * Older opencode builds stored `@opencode/ai/providers/<segment>`. This table
 * translates ONLY that opencode-owned vocabulary; OCR-native protocols
 * (`qoder`, `workbuddy`) have no relation to opencode and are handled by
 * `providers/protocol.ts`. Unknown segments pass through untouched so
 * `wireFor` reports them as unroutable instead of guessing.
 */
export const OPENCODE_V2_PACKAGE_PREFIX = '@opencode/ai/providers/';

const OPENCODE_V2_SEGMENTS: Record<string, string> = {
  openai: 'openai-responses',
  anthropic: 'anthropic-messages',
  google: 'google-gemini',
  azure: 'azure',
  vertex: 'vertex',
  bedrock: 'bedrock',
  'openai-compatible': 'openai-chat',
  'google-vertex': 'google-vertex',
  'amazon-bedrock': 'amazon-bedrock',
  typesafe: 'systemone',
};

/** Translate an opencode-v2 package value, then the OCR protocol aliases. */
export function currentPackageFor(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return value;
  if (trimmed.startsWith(OPENCODE_V2_PACKAGE_PREFIX)) {
    const segment = trimmed.slice(OPENCODE_V2_PACKAGE_PREFIX.length);
    if (Object.hasOwn(OPENCODE_V2_SEGMENTS, segment)) return OPENCODE_V2_SEGMENTS[segment];
    return trimmed;
  }
  return currentProtocol(trimmed);
}

/**
 * Catalog / override `npm` slot → OCR protocol id.
 *
 * The slot name stays `npm` (models.dev and the model-def file spelling).
 * The value OCR serves is a protocol id: `@ai-sdk/*` and
 * `@opencode/ai/providers/*` are translated here; an id that is already
 * canonical passes through. Empty is absent. An unknown package passes
 * through lowercased — the same string `wireFor` sees — and is not guessed.
 */
export function protocolIdFromNpm(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  return currentPackageFor(trimmed);
}

const PROTOCOL_TO_OPENCODE_SDK: Record<string, string> = Object.fromEntries(
  Object.entries(OPENCODE_V2_SEGMENTS).map(([segment, protocol]) => [
    protocol,
    `${OPENCODE_V2_PACKAGE_PREFIX}${segment}`,
  ]),
);

/**
 * Export direction (OCR protocol → opencode SDK package), used ONLY for files
 * the opencode client reads. Unknown protocols pass through untouched — the
 * client accepts raw npm, and OCR-native protocols get the compatible
 * fallback in the materializer.
 */
export function opencodePackageFor(protocol: string): string {
  return Object.hasOwn(PROTOCOL_TO_OPENCODE_SDK, protocol)
    ? PROTOCOL_TO_OPENCODE_SDK[protocol]
    : protocol;
}
