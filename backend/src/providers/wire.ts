/**
 * canonical wire-shape decision, ONE source of truth shared by the
 * execution dispatchers and the console probe. Rationale: protocol truth lives
 * in DATA (models.dev `provider.npm`, provider-level and model-level), not in
 * daemon behavior; any place that maps npm → wire must call this function so
 * test and inference can never diverge again.
 *
 * Precedence at call sites: model-level provider.npm > config-node npm >
 * catalog provider npm; `baseHint` (api/baseURL) only breaks ties when no npm
 * is known.
 */

export type WireKind = 'openai' | 'anthropic' | 'google' | 'responses' | 'unroutable';

/**
 * npm packages that need SDK-side URL construction or request signing beyond a
 * plain HTTPS POST (Azure deployment paths + api-version, Vertex rawPredict +
 * project/location, Bedrock SigV4) → explicitly unroutable —
 * never fire a guessed wire that later blames a 400 on the upstream.
 */
function isUnroutable(npm: string): boolean {
  return (
    npm.includes('vertex') ||
    npm.includes('bedrock') ||
    npm.includes('@ai-sdk/azure') ||
    npm.includes('amazon-mantle') // AWS Mantle hosted models (SigV4)
  );
}

export function wireFor(npm?: string, baseHint?: string): WireKind {
  const n = (npm || '').toLowerCase();
  if (n) {
    if (isUnroutable(n)) return 'unroutable';
    if (n.includes('anthropic')) return 'anthropic';
    if (n.includes('google')) return 'google';
    // `@ai-sdk/openai` (NOT -compatible) = OpenAI Responses API wire.
    if (n.includes('openai') && !n.includes('compatible')) return 'responses';
    return 'openai';
  }
  const a = (baseHint || '').toLowerCase();
  if (a.includes('anthropic')) return 'anthropic';
  if (a.includes('google')) return 'google';
  return 'openai';
}

/** Human-readable exclusion reason for console/logs when a wire is unroutable. */
export function unroutableReason(npm?: string): string {
  return `该 provider 的 SDK 包需要专用端点构造/签名（${npm || '未知 npm'}），网关直连暂不支持（显式不可路由）`;
}

/**
 * Anthropic-wire mount translation. models.dev publishes ONE `api` per provider
 * (usually the OpenAI-compatible mount), but gateways often serve the Anthropic
 * Messages wire on a sibling mount — Zen: /zen/v1 → /inference/anthropic/v1
 * (verified 2026-10-08: /zen/v1/messages 404s while /inference/anthropic/v1/messages
 * returns 200). Applied at boot when wire === 'anthropic'.
 */
export function baseForWire(wire: WireKind, base: string): string {
  if (wire !== 'anthropic') return base;
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
