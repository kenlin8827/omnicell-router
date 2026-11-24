import type { CanonicalResponse } from '../ir/types.js';
// Type-only imports: erased at runtime, so the resilience -> types/router
// value-direction import cycle can never exist.
import type { CircuitBreakerSnapshot } from '../resilience/types.js';
import type { ModelAvailability } from '../resilience/circuit-breaker-manager.js';

export type TierLevel = 'lite' | 'plus' | 'pro' | 'ultra';

/**
 * What the member lists yield for a model. `TierLevel` is the REQUEST-side
 * four-state vocabulary (targetTier, TIER_RANK, escalateTier, session
 * ratchet); `'unclassified'` is a MODEL-side pool-membership outcome only —
 * no member list claims the model, so it joins no pool and carries no home
 * tier. Kept as a separate type so the two axes can't be conflated: it is a
 * CLAIM RESULT, never a value stored on a registration (`ModelRegistration.tier`
 * stays `TierLevel | undefined` precisely so TIER_RANK and the ratchet never
 * see a fifth level).
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
export const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof EFFORT_LADDER)[number];

/** Shared thinking-token budget estimates for protocols that express effort as a token budget. */
export const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

/**
 * Map an explicit thinking-token budget to the effort ladder. Needed on wires
 * whose SDK has no native budget field (OpenAI chat exposes `reasoning_effort`
 * only), so an Anthropic `thinking.budget_tokens` / Responses
 * `reasoning.max_tokens` request is translated instead of silently dropped.
 * Thresholds invert `EFFORT_TO_BUDGET`.
 */
export function effortFromThinkingBudget(tokens: number): ReasoningEffort {
  if (tokens <= EFFORT_TO_BUDGET.none) return 'none';
  if (tokens <= EFFORT_TO_BUDGET.minimal) return 'minimal';
  if (tokens <= EFFORT_TO_BUDGET.low) return 'low';
  if (tokens <= EFFORT_TO_BUDGET.medium) return 'medium';
  if (tokens <= EFFORT_TO_BUDGET.high) return 'high';
  if (tokens <= EFFORT_TO_BUDGET.xhigh) return 'xhigh';
  return 'max';
}

/**
 * WHO authored the effective effort ask (ADR-0012). Every value except
 * 'client' is a gateway decision injected after the client's wire value was
 * snapshotted:
 *   client     — the request's own `reasoning_effort` field
 *   decision layer      — the L2 decision layer's effort answer (classifier.layer2.effortDecision)
 *   entry      — a route-entry experience hit (ADR-0011)
 *   directive  — an `@ocr-effort-up` / `@ocr-effort-down` user directive (ADR-0011)
 *   default    — the served model's `defaultEffort` pin
 * `requestedEffort` stays the EFFECTIVE ask the machinery served against;
 * this field says whose ask it was. undefined = no level in play at all.
 */
export type EffortSource = 'client' | 'l2-decision' | 'entry' | 'directive' | 'default';

/**
 * Returns the highest effort level `supported` is allowed to substitute
 * for `requested`. "Degraded or equal": a `medium` request can be served
 * by anything `≤ medium`, never above. `undefined` `supported` → the full
 * `EFFORT_LADDER` (assume the model supports everything); an explicit
 * EMPTY array → `'none'` (the model serves no explicit level).
 */
export function downgradeReasoning(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[] | undefined,
  alwaysThink = false
): ReasoningEffort {
  const reqRank = EFFORT_LADDER.indexOf(requested);
  const candidates = (supported ?? EFFORT_LADDER)
    .filter((lvl) => EFFORT_LADDER.indexOf(lvl) <= reqRank)
    .sort((a, b) => EFFORT_LADDER.indexOf(b) - EFFORT_LADDER.indexOf(a));
  if (candidates.length > 0) return candidates[0]!;
  // Nothing in the ladder sits at or below the ask. An ALWAYS-THINK model
  // carries no `none` by construction (ADR-0035 withholding), so answering
  // thinking-off here would send a level its vendor refuses — land on the
  // lowest rung the model actually declares. A plain table that merely omits
  // `none` keeps the ADR-0011 down-direction contract: thinking-off is legal.
  if (alwaysThink) return lowestSupportedEffort(supported) ?? 'none';
  return 'none';
}

/** The lowest level a DECLARED support set can serve (`undefined` for an empty
 *  or undeclared set). The floor an always-think model is clamped to when an
 *  ask or a directive step would otherwise land on `none` the vendor forbids
 *  (ADR-0035: a table without `none` can never serve thinking-off). */
export function lowestSupportedEffort(
  supported: readonly ReasoningEffort[] | undefined
): ReasoningEffort | undefined {
  if (!supported || supported.length === 0) return undefined;
  return [...supported].sort((a, b) => EFFORT_LADDER.indexOf(a) - EFFORT_LADDER.indexOf(b))[0];
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
 * `disableable === false` (the vendor's always-think fact, ADR-0035) strips
 * `none` from the resolved set on EVERY branch — the withholding must hold at
 * the routing plane, not only on the published effort table.
 */
export function modelSupportsEfforts(
  supported: readonly ReasoningEffort[] | undefined,
  legacyFlag: boolean | undefined,
  disableable?: boolean
): ReasoningEffort[] | undefined {
  // An always-think model NEVER serves `none` (ADR-0035): strip it from any
  // resolved set — a stale config table, a legacy boolean expansion, a hand-
  // written registration. A set that empties under the strip falls through to
  // "no explicit effort control", never back to a ladder that re-admits it.
  const withoutNone = (levels: readonly ReasoningEffort[]): ReasoningEffort[] =>
    disableable === false ? levels.filter((e) => e !== 'none') : [...levels];
  if (supported && supported.length > 0) {
    const kept = withoutNone(supported);
    if (kept.length > 0) return kept;
  }
  if (legacyFlag === true) return withoutNone(EFFORT_LADDER);
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
  /** USD per 1M tokens, or absent when the price is unknown (see
   *  {@link ModelRegistration.pricing}). Cost maths must treat a missing
   *  value as unpriceable rather than as zero. */
  pricing?: ModelPricing;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  /**
   * Subset of `ReasoningEffort` this model can natively serve. Empty /
   * missing means "no explicit effort control — the model handles effort
   * internally". Default for thinking-capable models is the full
   * `EFFORT_LADDER` (all 7 levels).
   */
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  /**
   * Legacy boolean kept for back-compat with catalog / config files that
   * pre-date the per-level vocabulary. When true and no
   * `supportedReasoningEfforts` is set, `modelSupportsEfforts` resolves it to
   * the FULL `EFFORT_LADDER` (all 7 levels, `none` included). Carrying `none`
   * is a no-op on every generic path: a `none` target short-circuits before
   * the support set is read, and a clamp that can reach only `none` yields
   * `'none'` anyway. The ONE place where legacy still means the 6 non-`none`
   * levels is the System One wire, whose vendor enum has no `none`
   * (protocols/systemone/convert.ts → `'low'`).
   */
  supportsReasoningEffort?: boolean;
  /**
   * The vendor's on/off fact for a thinking model (ADR-0035): `false` = the
   * model ALWAYS thinks, so `none` is withheld from every resolved effort set
   * (`modelSupportsEfforts`) — including a legacy boolean expansion and a
   * stale config table. Written by the shared catalog-def mapper; absent =
   * off allowed / not stated.
   */
  reasoningDisableable?: boolean;
  supportsPromptCaching?: boolean;
  isDefaultInTier?: boolean;
}

export type SessionLookupType =
  | 'explicit_header'   // client-supplied header / router_options
  | 'embedded_user_id'  // session UUID embedded in metadata.user_id (Claude Code)
  | 'request_user'      // RETIRED: raw OpenAI request.user — no longer emitted (user-scoped, not conversation-scoped); readable in historical traces only
  | 'prefix_chain'      // exact head-prefix anchor of a completed chain
  | 'tail_anchor'       // trailing-window anchor (survives history truncation)
  | 'client_ref'        // client-minted conversation id alias via router_options.client_ref (Cursor conversation_id)
  | 'conversation_key'  // deterministic apiKey + first-user-message key
  | 'header_fallback'   // vendor x-*-session-id header naming an otherwise-minted cold start
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
  layerUsed?: 'layer0' | 'entry' | 'layer2';
  /**
   * The request declares a machine-checkable JSON output contract
   * (`response_format` json_object / json_schema). Arms the orchestrator's
   * lite-first schema-assertion cascade (ADR-0001 §2); a `tools` list alone
   * does NOT set it — there is no JSON contract for the assertion to check.
   */
  needsSchemaValidation: boolean;
  sessionId?: string;
  sessionRatchetApplied?: boolean;
  sessionLookupType?: SessionLookupType;
  pinnedModel?: string;
  /**
   * L2-decided thinking level (ADR-0012): set only by the L2 decision layer when
   * the client omitted `reasoning_effort` and `effortDecision` is on. The
   * orchestrator injects it into the request (the same precedence as a
   * route-entry hit — below a client-explicit value, below an `@ocr-*`
   * directive). Per-turn and unratcheted by design.
   */
  effort?: ReasoningEffort;
  /** The decision layer's self-reported confidence in `effort` — trace metadata only. */
  effortConfidence?: number;
}


export interface ExecutionResult {
  response?: CanonicalResponse;
  tierUsed?: TierLevel;
  modelUsed: string;
  layerUsed?: 'layer0' | 'entry' | 'layer2';
  /**
   * OUTBOUND protocol id of the SERVED attempt (the provider protocol id the
   * gateway spoke to the upstream, e.g. `openai-chat`). Distinct from the
   * inbound surface the client addressed — the gateway may have converted.
   * Resolved from the served model's wire through the offered protocol table
   * (`protocolForWire`), so the console prints one vocabulary on every page.
   */
  protocolUsed?: string;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  sessionId?: string;
  sessionRatchetApplied?: boolean;
  sessionLookupType?: SessionLookupType;
  /**
   * Gateway-owned id of THIS request (ADR-0021) — returned as
   * `X-OCR-Request-ID` so a caller/operator can name the exact console row.
   * Distinct from `sessionId` (the conversation); the caller's own
   * correlation value is never echoed back.
   */
  requestId?: string;
  latencyMs: number;
  /**
   * Industry TTFT/TPS split of the committed attempt, measured at the relay:
   * `ttftMs` = process start → first forwarded chunk, `genMs` = first chunk →
   * fully drained stream. Both undefined when the turn never streamed
   * (buffered execution, relay off, or a wire without a streaming executor),
   * which is exactly when a decode rate must NOT be synthesized.
   */
  ttftMs?: number;
  genMs?: number;
  /**
   * Inbound stream tag: the response SHAPE actually written to this client
   * (client `stream === true` after C-3, or `streaming.client.mode: always`).
   * Owned by the surface pipeline; the orchestrator only carries it.
   */
  clientStream?: boolean;
  /**
   * Outbound stream tag: the provider leg of the SERVED attempt.
   * `'sse'` = the upstream SSE reader ran; `'buffered'` = one buffered
   * provider call. `'sse'` with `clientStream: false` is the accumulate mode
   * (`streaming.upstream.mode: stream` on a JSON client) — a stream the
   * gateway drained and answered as JSON (ADR-0008 §1).
   */
  upstreamStream?: 'sse' | 'buffered';
  /**
   * The perceived-experience companion to the TTFT/decode pair: total time the
   * committed attempt's stream spent in gaps of ≥1 s between two consecutive
   * chunks the client received with visible output (answer text, tool-call
   * fragments or reasoning/thinking deltas). A turn can report a healthy decode
   * rate and still feel broken — seconds of frozen screen are what users
   * actually remember, and an average cannot express them. The session divides
   * the summed value by its summed decode windows (stallRatio). Undefined when
   * the turn never streamed, or when the stream delivered fewer than two such
   * chunks (no gap exists to measure); 0 means measured and smooth.
   */
  stalledMs?: number;
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
  /**
   * WHO authored the effective ask (ADR-0012): 'client' = the request's own
   * field; anything else is a gateway decision (decision layer / entry /
   * directive / model default). Surfaced as `X-OCR-Thinking-Source`.
   */
  effortSource?: EffortSource;
}



