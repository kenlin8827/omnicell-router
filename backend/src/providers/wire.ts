import { currentProtocol } from './protocol.js';
import { isPluginWire, nativeBaseHintWire } from './plugin-wires.js';
/**
 * Canonical wire-shape decision, ONE source of truth shared by the
 * execution dispatchers and the console probe. Rationale: protocol truth lives
 * in DATA — the catalog `npm` slot holds an OCR protocol id (models.dev's SDK
 * package string is translated at ingest), at provider level and model level —
 * not in daemon behavior. Any place that maps that slot to a wire must call
 * this function so test and inference can never diverge.
 *
 * Precedence at call sites: model-level provider.npm > config-node npm >
 * catalog provider npm; `baseHint` (api/baseURL) only breaks ties when no npm
 * is known.
 */

/** Wire shapes the CORE executes. Everything else is plugin-provided, so the
 *  wire vocabulary is open: `plugin-wires.ts` owns the plugin half and the
 *  plugin host fills it from the loaded manifests — never a vendor name in a
 *  core table. */
export type CoreWireKind =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini'
  | 'systemone'
  | 'unroutable';
export type WireKind = CoreWireKind | (string & {});

/**
 * Npm packages that need SDK-side URL construction or request signing beyond a
 * plain HTTPS POST (Azure deployment paths + api-version, Vertex rawPredict +
 * project/location, Bedrock SigV4) → explicitly unroutable —
 * never fire a guessed wire that later blames a 400 on the upstream.
 */
function isUnroutable(npm: string): boolean {
  return (
    npm === 'azure' ||
    npm.includes('vertex') ||
    npm.includes('bedrock') ||
    npm.includes('amazon-mantle') // AWS Mantle hosted models (SigV4)
  );
}

export function wireFor(npm?: string, baseHint?: string): WireKind {
  const n = currentProtocol((npm || '').trim().toLowerCase());
  if (n) {
    // A retired spelling was already translated above; anything still carrying
    // the opencode-v2 prefix or a path-like `/name` is unknown and refused,
    // never guessed.
    if (n.includes('@opencode/ai/') || n.startsWith('/')) return 'unroutable';

    if (isUnroutable(n)) return 'unroutable';
    if (n === 'systemone' || n.includes('typesafe')) return 'systemone';
    // currentProtocol() has already canonicalized known ids and legacy bare
    // spellings, so an exact core id IS its own wire (ADR-0033). The substring
    // branches below catch SDK-derived tokens that carry a core name but were
    // not an exact alias — they resolve to that core's canonical id.
    if (
      n === 'openai-responses' ||
      n === 'openai-chat' ||
      n === 'anthropic-messages' ||
      n === 'google-gemini'
    ) return n;
    // Plugin-owned protocols are matched AFTER the core shapes (a plugin never
    // overrides a core wire) and BEFORE the chat fallback: an id a plugin
    // serves resolves to itself, and an OCR-native id resolves even while its
    // plugin is absent, so the failure lands on dispatch with a truthful
    // "plugin not installed" instead of a silent wrong-upstream 400.
    if (isPluginWire(n)) return n;
    if (n.includes('anthropic')) return 'anthropic-messages';
    if (n.includes('google')) return 'google-gemini';
    if (n.includes('openai') && !n.includes('compatible') && !n.includes('chat')) return 'openai-responses';
    return 'openai-chat';
  }
  const a = (baseHint || '').toLowerCase();
  if (a.includes('anthropic')) return 'anthropic-messages';
  const native = nativeBaseHintWire(a);
  if (native) return native;
  if (a.includes('google')) return 'google-gemini';
  return 'openai-chat';
}

/** Machine classification of an unroutable wire — the console localizes the
 * code; the human sentence never rides the wire (i18n contract). */
export type UnroutableCode = 'unknownPackage' | 'dedicatedTransport';
export function unroutableInfo(npm?: string): { code: UnroutableCode; npm: string } {
  const n = (npm || '').toLowerCase();
  if (n.includes('@opencode/ai/')) return { code: 'unknownPackage', npm: npm || '' };
  return { code: 'dedicatedTransport', npm: npm || '' };
}

/**
 * Anthropic-wire mount translation. models.dev publishes ONE `api` per provider
 * (usually the OpenAI-compatible mount), but gateways often serve the Anthropic
 * Messages wire on a sibling mount — Zen: /zen/v1 → /inference/anthropic/v1
 * (verified 2026-10-08: /zen/v1/messages 404s while /inference/anthropic/v1/messages
 * returns 200). Applied at boot when wire === 'anthropic-messages'.
 */
export function baseForWire(wire: WireKind, base: string): string {
  if (wire !== 'anthropic-messages') return base;
  if (base.includes('/zen/v1')) return base.replace('/zen/v1', '/inference/anthropic/v1');
  if (base.includes('/openai')) return base.replace('/openai', '/anthropic');
  return base;
}

/**
 * Normalize an Anthropic Messages endpoint base to end exactly at /v1
 * (executors append `/messages` or `/v1/messages` — this kills /v1/v1 doubles).
 */
export function anthropicMessagesUrl(base: string): string {
  const clean = base.replace(/\/+$/, '');
  return clean.endsWith('/v1') ? `${clean}/messages` : `${clean}/v1/messages`;
}

/**
 * `data:<mime>;base64,<payload>` image URL — shared by the Anthropic and
 * Google payload builders (both inline base64 data URLs as image blocks).
 */
export { DATA_URL_RE } from '../ir/media.js';
