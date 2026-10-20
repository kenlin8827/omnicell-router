import { ChatCompletionResponse } from './openai.js';
// Type-only imports: erased at runtime, so the resilience -> types/router
// value-direction import cycle can never exist.
import type { CircuitBreakerSnapshot } from '../resilience/types.js';
import type { ModelAvailability } from '../resilience/circuit-breaker-manager.js';

export type TierLevel = 'lite' | 'plus' | 'pro' | 'ultra';

/**
 * What a model's smart-match classification yields. `TierLevel`
 * is the REQUEST-side four-state vocabulary (targetTier, TIER_RANK,
 * escalateTier, session ratchet); `'unclassified'` is a
 * MODEL-side pool-membership outcome only. Kept as a separate type so the
 * two axes can't be conflated.
 *
 * Tier naming: strength-gradient labels that work across model vendors
 * (Claude, GPT-*, Gemini, etc.) instead of vendor-specific brand names.
 * Four-tier vocabulary, ordered lite → plus → pro → ultra, with `ultra`
 * at the price/quality ceiling. Tier semantics and membership: see the
 * model-addressing decision record (the facts-side corpus carries no
 * migration history by design).
 */
export type PoolMembership = TierLevel | 'unclassified';

export const TIER_RANK: Record<TierLevel, number> = {
  lite: 1,
  plus: 2,
  pro: 3,
  ultra: 4,
};

/**
 * Thinking-effort vocabulary, aligned with OpenCode's 6-level ladder
 * (lowest → highest). `EFFORT_LADDER.indexOf(effort)` IS the rank —
 * weaker levels have smaller index.
 *   none     — no reasoning (the lowest tier; client sends this
 *             explicitly to mean "do not think", not as a default)
 *   low / medium / high   — shared by every wire (OpenAI, Anthropic,
 *                           Google, OpenAI Responses)
 *   xhigh    — OpenAI / OpenAI-compatible top tier (GPT-5+)
 *   max      — Anthropic top tier (Opus 5.5+)
 *
 * `none` IS a real effort value, not a default or a missing-field
 * marker. An omitted `reasoning_effort` field is `undefined`; an
 * explicit `'none'` is the lowest tier of the ladder. The two must be
 * distinguished on the response side (X-OCR-Thinking-Actual header,
 * `actualEffort` field) so the client sees what the gateway actually
 * served.
 *
 * Default `supportedReasoningEfforts` for a thinking-capable model is
 * the full 6-level ladder — there is no 5-level "thinking subset".
 */
export const EFFORT_LADDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof EFFORT_LADDER)[number];

/**
 * Returns the highest effort level `supported` is allowed to substitute
 * for `requested`. "Degraded or equal": a `medium` request can be served
 * by anything `≤ medium`, never above. `undefined` `supported` → the full
 * `EFFORT_LADDER` (assume the model supports everything); an explicit
 * EMPTY array → `'none'` (the model serves no explicit level).
 */
export function downgradeReasoning(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[] | undefined
): ReasoningEffort {
  const reqRank = EFFORT_LADDER.indexOf(requested);
  const candidates = (supported ?? EFFORT_LADDER)
    .filter((lvl) => EFFORT_LADDER.indexOf(lvl) <= reqRank)
    .sort((a, b) => EFFORT_LADDER.indexOf(b) - EFFORT_LADDER.indexOf(a));
  return candidates[0] ?? 'none';
}

/**
 * Per-model thinking-level TRANSLATION table (client-requested →
 * upstream value), inline on a tier member rule. `effortMap[requested] ??
 * requested` — a missing key means passthrough. Applied per candidate at
 * selection AND at execution (it is a model property, not a routing policy).
 */
export type EffortMap = Partial<Record<ReasoningEffort, ReasoningEffort>>;

/**
 * Shared resolution of a model's explicit-effort support (registry pick +
 * orchestrator recompute use the SAME rule):
 *   - a non-empty `supportedReasoningEfforts` wins;
 *   - the legacy boolean `true` → the full EFFORT_LADDER;
 *   - otherwise `undefined` = "no explicit effort control" (callers decide:
 *     selection skips the candidate; wire-side recompute clamps to `[]`).
 */
export function modelSupportsEfforts(
  supported: readonly ReasoningEffort[] | undefined,
  legacyFlag: boolean | undefined
): ReasoningEffort[] | undefined {
  if (supported && supported.length > 0) return [...supported];
  if (legacyFlag === true) return [...EFFORT_LADDER];
  return undefined;
}

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface TierModelConfig {
  id: string;
  provider: string;
  upstreamModel?: string;
  realModel?: string;
  tier?: TierLevel;
  pricing: ModelPricing;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  /**
   * Subset of `ReasoningEffort` this model can natively serve. Empty /
   * missing means "no explicit effort control — the model handles effort
   * internally". Default for thinking-capable models is the full
   * `EFFORT_LADDER` (all 6 levels).
   */
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  /**
   * Legacy boolean kept for back-compat with catalog / config files that
   * pre-date the per-level vocabulary. When true and no
   * `supportedReasoningEfforts` is set, `modelSupportsEfforts` resolves it to
   * the FULL `EFFORT_LADDER` (all 6 levels, `none` included). Carrying `none`
   * is a no-op on every generic path: a `none` target short-circuits before
   * the support set is read, and a clamp that can reach only `none` yields
   * `'none'` anyway. The ONE place where legacy still means the 5 non-`none`
   * levels is the System One wire, whose vendor enum has no `none`
   * (protocols/systemone/convert.ts → `'low'`).
   */
  supportsReasoningEffort?: boolean;
  supportsPromptCaching?: boolean;
  isDefaultInTier?: boolean;
}

export type SessionLookupType =
  | 'explicit_header'   // client-supplied header / router_options
  | 'embedded_user_id'  // session UUID embedded in metadata.user_id (Claude Code)
  | 'request_user'      // raw OpenAI request.user field
  | 'prefix_chain'      // exact head-prefix anchor of a completed chain
  | 'tail_anchor'       // trailing-window anchor (survives history truncation)
  | 'conversation_key'  // deterministic apiKey + first-user-message key
  | 'cold_start';       // fresh mint (random, collision-free by construction)

/**
 * Machine-readable routing-reason vocabulary carried alongside the English
 * `reason` on every decision and trace. Producers emit a code from the locked
 * set ('forced', 'default', 'combo', 'l2.*', 'session.*') plus the params
 * needed to render it; the console localizes from code+params and falls back
 * to the raw `reason` for unknown or legacy values.
 */
export type ReasonParams = Record<string, string | number | boolean>;

export interface RoutingDecision {
  targetTier: TierLevel;
  confidence: number;
  reason: string;
  reasonCode?: string;
  reasonParams?: ReasonParams;
  layerUsed?: 'layer0' | 'layer2';
  needsSchemaValidation: boolean;
  sessionId?: string;
  sessionRatchetApplied?: boolean;
  sessionLookupType?: SessionLookupType;
  pinnedModel?: string;
}

export interface ExecutionResult {
  response: ChatCompletionResponse;
  tierUsed: TierLevel;
  modelUsed: string;
  layerUsed?: 'layer0' | 'layer2';
  fallbackOccurred: boolean;
  fallbackReason?: string;
  sessionId?: string;
  sessionRatchetApplied?: boolean;
  sessionLookupType?: SessionLookupType;
  traceId?: string;
  latencyMs: number;
  failoverOccurred?: boolean;
  failoverAttempts?: number;
  failoverPath?: string[];
  inplaceRetries?: number;
  breakerState?: string;
  /**
   * Additive — older readers never see these: the credential
   * that served the turn (display-safe keyHash prefix; undefined = the legacy
   * no-prefix/baked-key path), that pair's breaker snapshot, and the model
   * aggregate summary for the served model.
   */
  servedCredentialPrefix?: string;
  scopedBreakerSnap?: CircuitBreakerSnapshot;
  modelAvailability?: ModelAvailability;
  /**
   * Variant id resolved from a sibling `base-variant` / `base#variant` model
   * request (undefined when the client named a plain model).
   */
  variantUsed?: string;
  /**
   * Reasoning-effort observability. `requestedEffort` is the value the
   * client sent (or undefined if the client omitted the field).
   * `actualEffort` is what the gateway actually served (may be lower
   * after registry-level downgrade); `reasoningDegraded` flags the
   * discrepancy. Both are full 6-level `ReasoningEffort` values.
   */
  requestedEffort?: ReasoningEffort;
  actualEffort?: ReasoningEffort;
  reasoningDegraded?: boolean;
}



