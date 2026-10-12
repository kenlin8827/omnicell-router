import { globMatch } from '../utils/glob.js';
import { EFFORT_LADDER, type EffortMap, type ReasoningEffort, type TierLevel } from '../types/router.js';
import type { TiersConfig, TierMemberRule } from '../config/types.js';

/**
 * member-list membership + inline effort translation.
 *
 * Tier membership has exactly ONE source: the explicit `tiers[t].members`
 * rule list. A model is claimed by the FIRST rule (tier order lite → plus →
 * pro → ultra, then list order within a tier) whose glob matches its FULL id
 * (`provider/model`); nothing matched → `'unclassified'` (fourth state, no
 * pool). List order IS priority: the first rule's models lead the tier's
 * failover chain.
 *
 * The classifier (tier-match.ts) stays alive as the SUGGESTION engine —
 * it feeds catalog-page recommendations, the /tiers ephemeral preview and
 * save-time checks, but NEVER routing and NEVER seeding (the first-boot
 * member defaults live in DEFAULT_CONFIG.tiers, not in generated lists).
 */

export const MEMBER_TIER_ORDER: TierLevel[] = ['lite', 'plus', 'pro', 'ultra'];

/** Descending tier order (highest first) — the cross-tier effort-search fallback. */
export const TIER_DESCENDING_ORDER: TierLevel[] = [...MEMBER_TIER_ORDER].reverse();

export interface ResolvedMembers {
  tiers: Record<TierLevel, TierMemberRule[]>;
  /**
   * True when ANY tier defines a `members` key (an explicit `members: []`
   * counts). False = the config carries no member lists anywhere (e.g. an
   * explicit `tiers: {}` or tiers without any members key) — there is no
   * runtime seeding: boot-direct keeps the pools empty and warns; the
   * template defaults live in DEFAULT_CONFIG.tiers (loadConfig fallback).
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

export interface MemberClaim {
  tier: TierLevel;
  rule: TierMemberRule;
  /** Rule position within the tier's list — becomes the chain priority. */
  index: number;
}

/** Claim ONE model id against the member lists (tier order → list order, first hit wins). */
export function claimModel(
  modelId: string,
  tiers: Record<TierLevel, TierMemberRule[]>
): MemberClaim | 'unclassified' {
  for (const tier of MEMBER_TIER_ORDER) {
    const rules = tiers[tier];
    for (let i = 0; i < rules.length; i++) {
      if (globMatch(rules[i].pattern, modelId)) return { tier, rule: rules[i], index: i };
    }
  }
  return 'unclassified';
}

/** Every tier whose list matches the id (save-time overlap check; runtime uses first-claim). */
export function matchingTiers(modelId: string, tiers: Record<TierLevel, TierMemberRule[]>): TierLevel[] {
  const hits: TierLevel[] = [];
  for (const tier of MEMBER_TIER_ORDER) {
    if (tiers[tier].some((r) => globMatch(r.pattern, modelId))) hits.push(tier);
  }
  return hits;
}

/** `effortMap[requested] ?? requested` — the single translation step. */
export function applyEffortMap(map: EffortMap | undefined, requested: ReasoningEffort): ReasoningEffort {
  return map?.[requested] ?? requested;
}