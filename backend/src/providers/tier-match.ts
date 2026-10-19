import { PoolMembership, TierLevel } from '../types/router.js';
import { globMatchAny } from '../utils/glob.js';
import { TiersConfig } from '../config/types.js';

/**
 * Smart-match configuration per tier — the SINGLE basis of candidate-pool
 * membership: patterns claim, price bands bound, exclude vetoes.
 *
 * removed the residual catch-all tier: all four tiers are configured
 * identically and a model that matches no positive condition becomes
 * `'unclassified'` (joins no pool) instead of silently landing in a tier.
 * There is no dead configuration — every field below is honored for every tier.
 *
 * Classification chain for ONE model (first hit wins, highest authority first):
 *   1. explicit tier (catalog override / defs-file model def) — resolved by
 *      the registry BEFORE calling classifyTier; human pins outrank rules
 *   2. tier name patterns (wildcards over the model id) — lite → pro → plus →
 *      ultra (lighter tiers claim first so heavier ones aren't accidentally
 *      swallowed by a too-greedy lighter pattern)
 *   3. price bands over the RAW catalog $/M input price — closed bands by
 *      ascending floor first, then open-ended bands by DESCENDING floor (a band
 *      with no ceiling is a weak condition and must not eat the tier above it).
 *      Missing price = no band hit; free models (input = 0) DO fall into a
 *      max-only band
 *   4. catalog/config thinking-effort flag → pro
 *   5. nothing matched → 'unclassified'
 *
 * `exclude` and `excludeTiers` are NOT an earlier stage: they GATE each claim
 * (a claim returns, so a separate stage placed after the claims could never
 * run). The global `tiers.exclude` denylist is unconditional and is enforced at
 * the pool layer (see ProviderRegistry.policyRejectionReason) — it outranks even
 * a pin.
 */
export interface TierMatch {
  patterns?: string[]; // wildcard patterns over model id (case-insensitive)
  minInputPerM?: number; // price-band floor; undefined = no floor
  maxInputPerM?: number; // price-band ceiling; undefined = open-ended (weak)
  /**
   * Per-tier veto on AUTOMATIC claiming (explicit catalog/jsonc pins bypass it).
   * A vetoed model falls to the next claimant in the chain — now it
   * may end up `'unclassified'` rather than defaulting to a tier.
   */
  exclude?: string[];
  /**
   * anchor-exclude: a model matching ANY positive condition of one of
   * these tiers may not be AUTO-claimed by THIS tier. It is a convenience veto
   * derived from the other tiers' own patterns / band / flag, so overlapping
   * ranges can be resolved without reordering the chain.
   * Example: plus.excludeTiers: [pro] keeps every pro-priced (or
   * pro-patterned, or flagged) model out of the plus pool.
   */
  excludeTiers?: TierLevel[];
}

export type ResolvedTierMatch = Record<TierLevel, TierMatch>;

/** Order in which name patterns are consulted (first hit wins). */
const PATTERN_ORDER: TierLevel[] = ['lite', 'pro', 'plus', 'ultra'];

/**
 * Built-in baseline — fully PRICE-DRIVEN. NO tier presets name patterns: vendor
 * tier words ("flash" / "lite" / "pro" / "air" / "turbo"…) mean very different
 * prices across vendors, so a preset like `*flash*` would mis-map capable SKUs
 * (e.g. `deepseek-v4.1-flash` @ $0.3) or premium ones (`gemini-flash` @ $1.5)
 * into the wrong pool. Classification is the price band over the raw catalog
 * $/M input price (free/local = 0 falls into lite's max-only band); the catalog
 * thinking-effort flag claims `pro` when no band does; nothing matches →
 * 'unclassified'. Bands (Claude-calibrated): lite ≤ 0.8, plus [0.8, 3],
 * pro [3, 8], ultra ≥ $8/M input.
 *
 * Name patterns are still honored if YOU configure them per tier (console
 * /tiers page) — add them only when a name genuinely correlates with a tier in
 * your catalog.
 */
export const DEFAULT_TIER_MATCH: ResolvedTierMatch = {
  lite: { maxInputPerM: 0.8 },
  plus: { minInputPerM: 0.8, maxInputPerM: 3 },
  pro: { minInputPerM: 3, maxInputPerM: 8 },
  ultra: { minInputPerM: 8 },
};

/** Per-field merge of user `tiers[t].match` over the built-in defaults. */
export function resolveTierMatch(policies: TiersConfig | undefined): ResolvedTierMatch {
  const out = {} as ResolvedTierMatch;
  for (const tier of PATTERN_ORDER) {
    const d = DEFAULT_TIER_MATCH[tier];
    const m = policies?.[tier]?.match;
    out[tier] = {
      patterns: m?.patterns ?? d.patterns,
      minInputPerM: m?.minInputPerM ?? d.minInputPerM,
      maxInputPerM: m?.maxInputPerM ?? d.maxInputPerM,
      exclude: m?.exclude ?? d.exclude,
      excludeTiers: m?.excludeTiers ?? d.excludeTiers,
    };
  }
  return out;
}

export interface TierClassifyInput {
  modelId: string; // provider-qualified or bare model id (matched lowercased)
  inputPerM?: number; // RAW catalog price; undefined = unknown → bands skip
  reasoningFlag: boolean; // catalog `thinking-effort` capability flag (was historically named 'reasoning')
}

/** True when the price lies inside the tier's band (band must be configured). */
function bandHit(band: TierMatch, price?: number): boolean {
  // Reject NaN: `NaN < x` and `NaN > x` are both false, so without this guard
  // a corrupted catalog row with price=NaN would silently fall THROUGH every
  // band check and get claimed as the last-evaluated one — wrong membership.
  if (price == null || Number.isNaN(price)) return false;
  if (band.minInputPerM == null && band.maxInputPerM == null) return false;
  if (band.minInputPerM != null && price < band.minInputPerM) return false;
  if (band.maxInputPerM != null && price > band.maxInputPerM) return false;
  return true;
}

/**
 * Bands are consulted by ascending floor, but an OPEN-ENDED band (no ceiling)
 * is a weak condition: it is consulted only after every closed band had a
 * chance. Without this rule a plus band like `{min: 0.8}` would swallow
 * every priced model before pro's `{min: 3}` is ever asked.
 * Among two open-ended bands the HIGHER floor is the more specific claim, so
 * they are consulted by descending floor (an unbounded band must not eat the
 * tier above it).
 */
export function bandOrder(match: ResolvedTierMatch): TierLevel[] {
  const configured = PATTERN_ORDER.filter((t) => match[t].minInputPerM != null || match[t].maxInputPerM != null);
  const floor = (t: TierLevel) => match[t].minInputPerM ?? 0;
  const closed = configured.filter((t) => match[t].maxInputPerM != null).sort((a, b) => floor(a) - floor(b));
  const open = configured.filter((t) => match[t].maxInputPerM == null).sort((a, b) => floor(b) - floor(a));
  return [...closed, ...open];
}

/**
 * Does the model match ANY positive condition of `t` (patterns / price band /
 * thinking-effort flag)? Used to evaluate another tier's `excludeTiers` anchor. The
 * referenced tier's own exclude list is NOT consulted — the anchor is the set of
 * models its CONDITIONS describe, which is what "these tiers' models" means.
 */
export function matchesTierConditions(tier: TierLevel, input: TierClassifyInput, match: ResolvedTierMatch): boolean {
  const mid = input.modelId.toLowerCase();
  if (globMatchAny(match[tier].patterns, mid)) return true;
  if (bandHit(match[tier], input.inputPerM)) return true;
  if (tier === 'pro' && input.reasoningFlag) return true;
  return false;
}

/** Classify a model by the effective match config (see the chain above).
 * Returns `'unclassified'` when nothing claims it — there is no residual tier
 * any more. Hand-configured models (no captured tierMatch) never
 * reach this function; explicit pins short-circuit it in the registry. */
export function classifyTier(input: TierClassifyInput, match: ResolvedTierMatch): PoolMembership {
  const mid = input.modelId.toLowerCase();
  const price = input.inputPerM;
  const anchorVetoed = (tier: TierLevel) =>
    (match[tier].excludeTiers ?? []).some((other) => other !== tier && matchesTierConditions(other, input, match));
  // Gate = this tier's own exclude list + its excludeTiers anchors.
  const claim = (tier: TierLevel, hits: boolean) =>
    hits &&
    !(match[tier].exclude?.length && globMatchAny(match[tier].exclude, mid)) &&
    !anchorVetoed(tier);
  // 2. Name patterns — explicit naming beats another tier's band.
  for (const tier of PATTERN_ORDER) if (claim(tier, globMatchAny(match[tier].patterns, mid))) return tier;
  // 3. Price bands — closed by ascending floor, then open-ended by descending floor.
  for (const tier of bandOrder(match)) if (claim(tier, bandHit(match[tier], price))) return tier;
  // 4. The mere thinking-effort flag.
  if (claim('pro', input.reasoningFlag)) return 'pro';
  // 5. No residual: an unclaimed model joins no pool.
  return 'unclassified';
}
