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

/**
 * opencode v2 SDK package form (ADR-0019 Decision 9): `@opencode/ai/providers/<segment>`
 * replaces the opencode v1 `@ai-sdk/<x>` npm strings. Known segments map to the SAME
 * wire kinds as their opencode v1 counterparts; an unknown segment is 'unroutable' —
 * never fire a guessed wire at an unprobed SDK. probe.ts probeKindFor
 * delegates here, so the console probe inherits both shapes automatically.
 */
const OPENCODE_V2_PACKAGE_RE = /@opencode\/ai\/providers\/([a-z0-9._-]+)/;
const OPENCODE_V2_SEGMENT_WIRES: Record<string, WireKind> = {
  openai: 'responses', // @ai-sdk/openai (NOT -compatible) = Responses API wire
  'openai-compatible': 'openai',
  anthropic: 'anthropic',
  google: 'google',
  azure: 'unroutable', // SDK-side URL construction — parity with '@ai-sdk/azure'
  vertex: 'unroutable', // rawPredict + project/location signing
  'google-vertex': 'unroutable',
  bedrock: 'unroutable', // SigV4
  'amazon-bedrock': 'unroutable',
};

/** opencode v2 package segment of an npm string, or null when it is not opencode-v2 shaped. */
function opencodeV2Segment(npm: string): string | null {
  const m = OPENCODE_V2_PACKAGE_RE.exec(npm);
  return m ? m[1] : null;
}

/**
 * True when the string is already in opencode v2 `@opencode/ai/providers/<segment>` shape.
 * Exported for the ADR-0019 P4 WRITE side (user-config opencodeV2PackageFor) so the
 * package vocabulary has exactly ONE regex owner.
 */
export function isOpencodeV2Package(npm: string): boolean {
  return OPENCODE_V2_PACKAGE_RE.test(npm || '');
}

export function wireFor(npm?: string, baseHint?: string): WireKind {
  const n = (npm || '').toLowerCase();
  if (n) {
    const seg = opencodeV2Segment(n);
    if (seg !== null) {
      // opencode v2 packages are matched by segment EXACTLY — a fuzzy fallback here
      // would silently route an unprobed provider package onto a guessed wire.
      // Security P3-1: Object.hasOwn — prototype members ('constructor',
      // 'toString') must never masquerade as a known wire kind.
      const known: WireKind | undefined = Object.hasOwn(OPENCODE_V2_SEGMENT_WIRES, seg) ? OPENCODE_V2_SEGMENT_WIRES[seg] : undefined;
      return known ?? 'unroutable';
    }
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

/** Machine classification of an unroutable wire — the console localizes the
 * code; the human sentence never rides the wire (i18n contract). */
export type UnroutableCode = 'unknownPackage' | 'dedicatedTransport';
export function unroutableInfo(npm?: string): { code: UnroutableCode; npm: string } {
  const n = (npm || '').toLowerCase();
  const seg = opencodeV2Segment(n);
  if (seg !== null) {
    // P3-1: Object.hasOwn parity with wireFor (prototype-member segments are
    // unknown, never a wire kind).
    const known: WireKind | undefined = Object.hasOwn(OPENCODE_V2_SEGMENT_WIRES, seg) ? OPENCODE_V2_SEGMENT_WIRES[seg] : undefined;
    if (known === undefined) return { code: 'unknownPackage', npm: npm || '' };
  }
  return { code: 'dedicatedTransport', npm: npm || '' };
}

/** Human-readable exclusion reason for console/logs when a wire is unroutable.
 * @deprecated i18n residue — the boot-direct exclusion surface still renders
 * this Chinese text on /tiers. Migrate to unroutableInfo codes + t() there,
 * then delete. */
export function unroutableReason(npm?: string): string {
  const { code, npm: n } = unroutableInfo(npm);
  return code === 'unknownPackage'
    ? `无法识别的 opencode v2 SDK 包名（${n || '未知 package'}），网关直连暂不支持（显式不可路由）`
    : `该 provider 的 SDK 包需要专用端点构造/签名（${n || '未知 npm'}），网关直连暂不支持（显式不可路由）`;
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
