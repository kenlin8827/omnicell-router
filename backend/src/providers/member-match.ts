import { globMatch } from '../utils/glob.js';
import { EFFORT_LADDER, type EffortMap, type ReasoningEffort, type TierLevel } from '../types/router.js';
import type { ComboConfig, TiersConfig, TierMemberRule } from '../config/types.js';

/**
 * member-list membership + inline effort translation.
 *
 * Tier membership has exactly ONE config source: the explicit `tiers[t].members`
 * rule list. Membership is a PER-TIER projection: each tier's list independently
 * claims every model its rules match — a model (or a combo's expanded members)
 * MAY join several tiers at once, and each tier's chain order / weight /
 * effortMap come from THAT tier's own rules (`claimInTier`). For consumers that
 * need a single tier value (pinned-model force_tier, tier-keyed reporting,
 * model-access tier expansion) `claimModel` derives the home tier: the first
 * claim in tier order lite → plus → pro → ultra. Nothing matched →
 * `'unclassified'` (fourth state, no pool).
 *
 * `combo:<id>` rules are the one sanctioned indirection: declared references
 * that expand IN PLACE into the combo's registered members at every commit /
 * read point (expandComboRefs) — pools stay physical-model lists, the request
 * path never resolves refs, and later combo edits follow into the tier at the
 * next commit. A combo may be referenced by any number of tiers.
 *
 * The classifier (tier-match.ts) stays alive as the SUGGESTION engine —
 * it feeds catalog-page recommendations, the /tiers ephemeral preview and
 * save-time checks, but NEVER routing and NEVER seeding (DEFAULT_CONFIG.tiers
 * ships four EMPTY pools — no member defaults exist to seed from).
 */

export const MEMBER_TIER_ORDER: TierLevel[] = ['lite', 'plus', 'pro', 'ultra'];

/** Descending tier order (highest first) — the cross-tier effort-search fallback. */
export const TIER_DESCENDING_ORDER: TierLevel[] = [...MEMBER_TIER_ORDER].reverse();

export interface ResolvedMembers {
  tiers: Record<TierLevel, TierMemberRule[]>;
  /**
   * True when ANY tier defines a `members` key (an explicit `members: []`
   * counts). False = the config carries no member lists anywhere (the
   * shipped default: DEFAULT_CONFIG.tiers is four empty tier shells, same
   * as an explicit `tiers: {}`) — there is no runtime seeding: boot-direct
   * keeps the pools empty and warns until the operator adds members.
   */
  configured: boolean;
}

/** Sanitize one effort map: keep only known levels on both sides; empty → undefined. */
export function sanitizeEffortMap(raw: unknown): EffortMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: EffortMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(EFFORT_LADDER as readonly string[]).includes(k)) continue;
    if (typeof v !== 'string' || !(EFFORT_LADDER as readonly string[]).includes(v)) continue;
    out[k as ReasoningEffort] = v as ReasoningEffort;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Sanitize a tier's raw member list: drop malformed entries, keep order. */
export function sanitizeMemberRules(raw: unknown): TierMemberRule[] {
  if (!Array.isArray(raw)) return [];
  const out: TierMemberRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const pattern = typeof (entry as any).pattern === 'string' ? (entry as any).pattern.trim() : '';
    if (!pattern) continue;
    const rule: TierMemberRule = { pattern };
    const w = Number((entry as any).weight);
    if (Number.isFinite(w) && w >= 1) rule.weight = w;
    const map = sanitizeEffortMap((entry as any).effortMap);
    if (map) rule.effortMap = map;
    out.push(rule);
  }
  return out;
}

export function resolveTierMembers(policies: TiersConfig | undefined): ResolvedMembers {
  const tiers = { lite: [], plus: [], pro: [], ultra: [] } as Record<TierLevel, TierMemberRule[]>;
  let configured = false;
  for (const tier of MEMBER_TIER_ORDER) {
    const raw = policies?.[tier]?.members;
    if (raw !== undefined) configured = true;
    tiers[tier] = sanitizeMemberRules(raw);
  }
  return { tiers, configured };
}

/** Reserved member-rule prefix marking a combo indirection — never a glob. */
export const COMBO_REF_PREFIX = 'combo:';

export const isComboRef = (pattern: string): boolean => pattern.startsWith(COMBO_REF_PREFIX);

/** Virtual model ids that routing already owns — a combo may never take one
    (registry applyCombos ignores such definitions with a warn), so combo
    expansion treats them as dead refs everywhere (commit AND boot views). */
export const RESERVED_COMBO_IDS = new Set(['auto', 'default', 'auto-lite', 'auto-plus', 'auto-pro', 'auto-ultra']);

/** Registered member refs of one combo id, config order, deduped; empty = nothing live. */
export type ComboRefLookup = (comboId: string) => { id: string; weight: number }[] | null;

/** Normalized registered member refs of one combo definition (bare string |
    {id, weight} entries → {id, weight>=1}; unregistered dropped, duplicates
    collapse to first). Shared by the registry lookup and the boot lookup. */
export function comboMemberRefsOf(
  combo: ComboConfig,
  isRegistered: (modelId: string) => boolean,
): { id: string; weight: number }[] {
  const seen = new Set<string>();
  const refs: { id: string; weight: number }[] = [];
  for (const entry of combo.models || []) {
    const ref = typeof entry === 'string' ? { id: entry, weight: 1 } : { id: entry.id, weight: Math.max(1, Number(entry.weight) || 1) };
    if (!ref.id || seen.has(ref.id) || !isRegistered(ref.id)) continue;
    seen.add(ref.id);
    refs.push(ref);
  }
  return refs;
}

/** One-shot lookup over the raw combo config (boot path — no registry yet):
    pre-resolves every combo's refs against the registration universe. */
export function comboRefLookupFromConfig(
  combos: ComboConfig[] | undefined,
  isRegistered: (modelId: string) => boolean,
): ComboRefLookup {
  const map = new Map<string, { id: string; weight: number }[]>();
  for (const combo of combos || []) {
    // disabled = operator takedown; a model registered over the combo id
    // shadows it; reserved ids (auto*) were never registered as combos —
    // all three leave the combo unable to serve, so all are dead refs.
    if (!combo?.id || combo.disabled === true || isRegistered(combo.id) || RESERVED_COMBO_IDS.has(combo.id)) continue;
    map.set(combo.id, comboMemberRefsOf(combo, isRegistered));
  }
  return (comboId) => map.get(comboId) ?? null;
}

export interface ExpandedMembers {
  tiers: Record<TierLevel, TierMemberRule[]>;
  /** Combo refs that contributed nothing (unknown / disabled / shadowed / zero registered members). */
  dead: { tier: TierLevel; ref: string }[];
}

/**
 * Replace `combo:<id>` member rules IN PLACE with the combo's registered
 * members: config order preserved (the ref's list position decides chain
 * order), per-member weight carried, the ref rule's effortMap applied
 * block-wide to every expanded member. Duplicate/unregistered ids are dropped;
 * a ref that yields nothing is reported dead. Pools stay physical-model lists
 * — the request path never sees a ref. Exact-id claims from earlier rules in
 * the SAME tier dedupe the expansion (per-tier hygiene; cross-tier overlap is
 * legal by contract); glob overlap is left to the pool projection.
 */
export function expandComboRefs(tiers: Record<TierLevel, TierMemberRule[]>, lookup: ComboRefLookup): ExpandedMembers {
  const out: Record<TierLevel, TierMemberRule[]> = { lite: [], plus: [], pro: [], ultra: [] };
  const dead: { tier: TierLevel; ref: string }[] = [];
  for (const tier of MEMBER_TIER_ORDER) {
    const claimed = new Set<string>();
    for (const rule of tiers[tier]) {
      if (!isComboRef(rule.pattern)) {
        out[tier].push(rule);
        // exact-id hygiene only — substring/glob patterns claim wider sets
        // that only the per-tier pool projection knows about
        if (!/[*?]/.test(rule.pattern)) claimed.add(rule.pattern.toLowerCase());
        continue;
      }
      const members = lookup(rule.pattern.slice(COMBO_REF_PREFIX.length));
      if (!members || members.length === 0) {
        dead.push({ tier, ref: rule.pattern });
        continue;
      }
      let added = 0;
      for (const { id, weight } of members) {
        if (claimed.has(id.toLowerCase())) continue;
        claimed.add(id.toLowerCase());
        // exact pin: a member's full id must not substring-claim longer
        // sibling ids (p/v4 vs p/v4-pro)
        const expanded: TierMemberRule = { pattern: id, exact: true };
        if (weight > 1) expanded.weight = weight;
        if (rule.effortMap) expanded.effortMap = { ...rule.effortMap };
        out[tier].push(expanded);
        added++;
      }
      if (added === 0) dead.push({ tier, ref: rule.pattern });
    }
  }
  return { tiers: out, dead };
}

export interface MemberClaim {
  tier: TierLevel;
  rule: TierMemberRule;
  /** Rule position within the tier's list — becomes the chain priority. */
  index: number;
}

/** One rule against one model id: `exact` rules pin the full id (combo
    expansion); everything else keeps the glob semantics (substring / wildcards). */
function ruleMatches(rule: TierMemberRule, modelId: string): boolean {
  if (rule.exact) return rule.pattern.trim().toLowerCase() === modelId.toLowerCase();
  return globMatch(rule.pattern, modelId);
}

/** Claim ONE model id against the member lists (tier order → list order, first hit wins). */
export function claimModel(
  modelId: string,
  tiers: Record<TierLevel, TierMemberRule[]>
): MemberClaim | 'unclassified' {
  for (const tier of MEMBER_TIER_ORDER) {
    const rules = tiers[tier];
    for (let i = 0; i < rules.length; i++) {
      if (ruleMatches(rules[i], modelId)) return { tier, rule: rules[i], index: i };
    }
  }
  return 'unclassified';
}

/**
 * Per-tier membership claim: the rule (if any) by which `modelId` joins THIS
 * tier's pool. Independent of every other tier — one model may hold a claim
 * in several tiers simultaneously; each tier's chain order / weight /
 * effortMap follow the claiming rule found here. null = not a member.
 */
export function claimInTier(
  tier: TierLevel,
  modelId: string,
  tiers: Record<TierLevel, TierMemberRule[]>
): MemberClaim | null {
  const rules = tiers[tier];
  for (let i = 0; i < rules.length; i++) {
    if (ruleMatches(rules[i], modelId)) return { tier, rule: rules[i], index: i };
  }
  return null;
}

/** Every tier whose list matches the id (the multi-membership view behind the
 *  catalog's `tiers` array and tier-expanded model-access checks). */
export function matchingTiers(modelId: string, tiers: Record<TierLevel, TierMemberRule[]>): TierLevel[] {
  const hits: TierLevel[] = [];
  for (const tier of MEMBER_TIER_ORDER) {
    if (tiers[tier].some((r) => ruleMatches(r, modelId))) hits.push(tier);
  }
  return hits;
}

/** `effortMap[requested] ?? requested` — the single translation step. */
export function applyEffortMap(map: EffortMap | undefined, requested: ReasoningEffort): ReasoningEffort {
  return map?.[requested] ?? requested;
}