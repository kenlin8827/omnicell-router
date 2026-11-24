import type { ProviderRegistry } from './registry.js';
import type { ComboConfig, ModelRegistration } from '../config/types.js';
import type { CatalogCost, CatalogModel, CatalogProviderRecord } from '../opencode/catalog/types.js';
import { EFFORT_LADDER, type ModelPricing, type TierLevel } from '../types/router.js';

/**
 * Capability envelope for VIRTUAL model refs (auto* aliases, tier aliases,
 * combos) — the shared math behind client-hook model records (pi models.json)
 * and the `/v1/models` `metadata` block. A virtual ref has no single physical
 * truth, but its member set bounds what every request can safely assume, so
 * the envelope claims LIMITS, never effort truth:
 *  - compaction limits: MIN across members (any member overflowing breaks
 *    the request — the safe answer for a failover chain);
 *  - image input: claimed only when EVERY member declares it (a
 *    vision-incapable failover member would 400 the attachment);
 *  - pricing: the chain-order LEADER (first member of the first tier in
 *    ladder order / first config-ordered combo member — the member that
 *    serves the request under priority selection);
 *  - the effort ladder is deliberately NOT part of the envelope — tier
 *    membership is rule-driven and drifts with every config save; the
 *    gateway clamps per request and reports truth via X-OCR-Thinking-*.
 */
export interface VirtualEnvelope {
  memberCount: number;
  contextWindow?: number;
  maxTokens?: number;
  imageInput?: boolean;
  /** Leader pricing in the registry vocabulary (camelCase cache fields). */
  pricing?: { input: number; output: number; cacheRead: number; cacheWrite?: number };
  /** Catalog display name of the leader, when the catalog has one. */
  leaderName?: string;
  /** Intersection flags: claimed only when EVERY member declares the capability. */
  toolCall?: boolean;
  temperature?: boolean;
  structuredOutput?: boolean;
}

/** Strip `none` from a published effort table when the vendor forbids
 *  thinking-off (ADR-0035): the public catalog must advertise exactly what
 *  routing will serve, never a level the gateway withholds. An effort option
 *  that empties under the strip is dropped, not re-published. */
function stripForbiddenNone(
  options: NonNullable<CatalogModel['reasoningOptions']>,
  disableable: boolean | undefined
): NonNullable<CatalogModel['reasoningOptions']> {
  if (disableable !== false) return options;
  return options
    .map((o) => (o.type === 'effort' && Array.isArray(o.values) ? { ...o, values: o.values.filter((v) => v !== 'none') } : o))
    .filter((o) => !(o.type === 'effort' && Array.isArray(o.values) && o.values.length === 0));
}

/**
 * models.dev-shaped capability block for ONE model record (snake_case, aligned
 * with https://models.opencode.ai/api.json). Fields absent from the record stay
 * absent — consumers treat missing as unknown, not false.
 */
export function modelsDevBlock(cat: CatalogModel): Record<string, unknown> {
  return {
    ...(cat.attachment !== undefined ? { attachment: cat.attachment } : {}),
    ...(cat.reasoning !== undefined ? { reasoning: cat.reasoning } : {}),
    ...(cat.reasoningOptions ? { reasoning_options: stripForbiddenNone(cat.reasoningOptions, cat.reasoningDisableable) } : {}),
    ...(cat.tool_call !== undefined ? { tool_call: cat.tool_call } : {}),
    ...(cat.temperature !== undefined ? { temperature: cat.temperature } : {}),
    ...(cat.structured_output !== undefined ? { structured_output: cat.structured_output } : {}),
    ...(cat.modalities ? { modalities: cat.modalities } : {}),
    ...(cat.limit ? { limit: cat.limit } : {}),
    ...(cat.cost ? { cost: cat.cost } : {}),
    ...(cat.interleaved ? { interleaved: cat.interleaved } : {}),
    ...(cat.status ? { status: cat.status } : {}),
  };
}

/**
 * models.dev-shaped capability block for a VIRTUAL ref from its envelope:
 * `reasoning:true` + the full effort ladder (the gateway clamps per request —
 * X-OCR-Thinking-* reports the truth), intersection tool/temperature/
 * structured-output flags, and min limits / leader cost from the members.
 */
export function virtualModelsDevBlock(env: VirtualEnvelope): Record<string, unknown> {
  return {
    ...(env.imageInput ? { attachment: true } : {}),
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: [...EFFORT_LADDER] }],
    ...(env.toolCall ? { tool_call: true } : {}),
    ...(env.temperature ? { temperature: true } : {}),
    ...(env.structuredOutput ? { structured_output: true } : {}),
    modalities: { input: env.imageInput ? ['text', 'image'] : ['text'], output: ['text'] },
    ...((env.contextWindow || env.maxTokens) ? { limit: { ...(env.contextWindow ? { context: env.contextWindow } : {}), ...(env.maxTokens ? { output: env.maxTokens } : {}) } } : {}),
    ...(env.pricing ? { cost: { input: env.pricing.input, output: env.pricing.output, cache_read: env.pricing.cacheRead, ...(env.pricing.cacheWrite !== undefined ? { cache_write: env.pricing.cacheWrite } : {}) } } : {}),
  };
}

/** The tier ladder in escalation order — `auto` spans all of it. */
export const TIER_LADDER: readonly TierLevel[] = ['lite', 'plus', 'pro', 'ultra'];

/**
 * What each tier is FOR — a FUNCTION label, deliberately not a price or
 * capability ranking. The distinction matters: an ordering ("lite < plus <
 * pro < ultra, cheapest → broadest") makes every console decision land on the
 * top rung, because "best" is then unambiguous. A function label instead lets
 * a decider match a role's WORK to a tier.
 *
 * The wording mirrors the gateway's own pi-subagent default mapping
 * (cli/clients/pi.ts PI_SUBAGENT_TIERS), which is the one place these rungs
 * were already given meaning. It is an operator-facing convention, not a
 * routing rule: routing itself only knows pool membership.
 */
export const TIER_PURPOSE: Record<TierLevel, string> = {
  lite: 'recon & web research — breadth over depth, cheap single-shot work',
  plus: 'verification & delegation — check someone else\'s output, hand work out',
  pro: 'implementation & review — write code, review code',
  ultra: 'the oracle second opinion — the hardest judgment calls',
};

/** Minimal registry seam so callers can pass the live singleton (or a stub). */
export type CatalogList = () => Promise<CatalogProviderRecord[]>;

/**
 * The ONE catalog-cost → registration-pricing rule (no fabrication, ADR-0035):
 * input AND output must both be known or there is no price (`undefined`, never
 * a synthesized 0 — "free" is a lie the cost plane exists to remove). An absent
 * cached-READ rate derives from `input` (a vendor that publishes none bills
 * cache reads as input). An absent cached-WRITE rate is OMITTED, not zeroed:
 * `cache_write: 0` would publish "cache writes are free", a number the vendor
 * never stated. Shared by boot-direct (real models) and the virtual combo
 * envelope so the two derivations can never drift apart.
 */
export function pricingFromCost(cost: CatalogCost | undefined): ModelPricing | undefined {
  if (!cost || cost.input === undefined || cost.output === undefined) return undefined;
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cache_read ?? cost.input,
    ...(cost.cache_write !== undefined ? { cacheWrite: cost.cache_write } : {}),
  };
}

/** Common math: safe-min limits, intersection image, leader pricing/name. */
function envelopeOf(
  memberCats: CatalogModel[],
  leaderCat: CatalogModel | undefined,
  leaderPricing: ModelRegistration['pricing'] | undefined,
  fallbackCount: number
): VirtualEnvelope {
  const contexts = memberCats.map((c) => c.limit?.context).filter((n): n is number => typeof n === 'number' && n > 0);
  const outputs = memberCats.map((c) => c.limit?.output).filter((n): n is number => typeof n === 'number' && n > 0);
  const allImage = memberCats.length > 0 && memberCats.every((c) => Array.isArray(c.modalities?.input) && c.modalities!.input!.includes('image'));
  // Intersection capability flags: a virtual ref may land on ANY member, so a
  // capability is only claimed when every member declares it.
  const all = (pick: (c: CatalogModel) => boolean | undefined) =>
    memberCats.length > 0 && memberCats.every((c) => pick(c) === true);
  // Cost fallback and display name bind to the true chain-order LEADER (by
  // identity), never to "the first member that happens to have a record".
  const pricing = leaderPricing ?? pricingFromCost(leaderCat?.cost);
  return {
    memberCount: fallbackCount,
    ...(contexts.length > 0 ? { contextWindow: Math.min(...contexts) } : {}),
    ...(outputs.length > 0 ? { maxTokens: Math.min(...outputs) } : {}),
    ...(allImage ? { imageInput: true } : {}),
    ...(all((c) => c.tool_call) ? { toolCall: true } : {}),
    ...(all((c) => c.temperature) ? { temperature: true } : {}),
    ...(all((c) => c.structured_output) ? { structuredOutput: true } : {}),
    ...(pricing ? { pricing } : {}),
    ...(leaderCat?.name ? { leaderName: leaderCat.name } : {}),
  };
}

/**
 * Batch catalog lookup for member ids: full registered form `${provider}/${model}`
 * first, then bare model id (mirrors the client-hook lookup semantics). Ids with
 * no catalog record are absent from `records` — skipped, not treated as zero.
 * `lookup` resolves any single member id with the same precedence (used for the
 * chain-order leader, who must be found by IDENTITY even when other members
 * lack catalog records).
 *
 * Each pushed record's LOOKUP id is available from the `byId` map: callers
 * that key by the registered id (`server.ts` catById.get(m.id)) must read that
 * map, not the record's own `id` — a prefixed provider's registered id is
 * `${provider}/${upstream}` while the catalog record keeps the bare upstream
 * key, so indexing records by `rec.id` misses every prefixed provider.
 */
export async function findMemberCatalogRecords(
  ids: string[],
  listCatalog: CatalogList
): Promise<{
  records: CatalogModel[];
  lookup: (id: string) => CatalogModel | undefined;
  /** Resolved record keyed by the id it was looked up by (registered form). */
  byId: Map<string, CatalogModel>;
}> {
  let providers: CatalogProviderRecord[];
  try {
    providers = await listCatalog();
  } catch {
    return { records: [], lookup: () => undefined, byId: new Map() };
  }
  const byFull = new Map<string, CatalogModel>();
  const byBare = new Map<string, CatalogModel>();
  for (const rec of providers) {
    for (const m of rec.models) {
      byFull.set(`${rec.id}/${m.id}`, m);
      if (!byBare.has(m.id)) byBare.set(m.id, m);
    }
  }
  const lookup = (id: string) => byFull.get(id) ?? byBare.get(id);
  const records: CatalogModel[] = [];
  const byId = new Map<string, CatalogModel>();
  for (const id of ids) {
    const cat = lookup(id);
    if (!cat) continue;
    records.push(cat);
    // First writer wins: a repeated id must not let a later bare-key hit
    // overwrite the prefixed provider's record.
    if (!byId.has(id)) byId.set(id, cat);
  }
  return { records, lookup, byId };
}

/**
 * Envelope for a tier alias (`lite`|`plus`|`pro`|`ultra`) or `auto`. `auto`
 * unions EVERY tier's pool in ladder order (an auto request may land on any
 * tier); a single tier alias reads only its own pool. Pricing follows the
 * first pool entry of the first tier in ladder order that still has members.
 * Unhealthy members stay included (healthyOnly=false) — the envelope is about
 * capability, not live health.
 */
export async function tierAliasEnvelope(
  registry: ProviderRegistry,
  listCatalog: CatalogList,
  alias: string
): Promise<VirtualEnvelope> {
  const tiers: TierLevel[] = alias === 'auto' ? [...TIER_LADDER] : [alias as TierLevel];
  let leaderPricing: ModelRegistration['pricing'] | undefined;
  const memberIds: string[] = [];
  for (const tier of tiers) {
    const pool = registry.getCandidateModelsForTier(tier, false);
    if (pool.length === 0) continue;
    if (!leaderPricing) leaderPricing = pool[0].pricing;
    memberIds.push(...pool.map((m) => m.id));
    if (alias !== 'auto') break;
  }
  if (memberIds.length === 0) return { memberCount: 0 };
  // A model may join several tiers (ADR-0003 §2) — dedupe so memberCount and
  // the catalog lookup see each member once.
  const uniqueMemberIds = [...new Set(memberIds)];
  const { records, lookup } = await findMemberCatalogRecords(uniqueMemberIds, listCatalog);
  return envelopeOf(records, lookup(uniqueMemberIds[0]), leaderPricing, uniqueMemberIds.length);
}

/**
 * Envelope for a combo: members are the FIXED config list (no rule drift —
 * unlike tiers this is a stable snapshot by construction). Pricing follows
 * the first config-ordered member, registry record first, catalog cost as
 * the fallback vocabulary conversion.
 */
export async function comboEnvelope(
  registry: ProviderRegistry,
  listCatalog: CatalogList,
  combo: ComboConfig
): Promise<VirtualEnvelope> {
  const memberIds = combo.models
    .map((raw) => (typeof raw === 'string' ? raw : raw?.id))
    .filter((id): id is string => !!id);
  if (memberIds.length === 0) return { memberCount: 0 };
  const leaderReg = registry.getModel(memberIds[0]);
  const { records, lookup } = await findMemberCatalogRecords(memberIds, listCatalog);
  return envelopeOf(records, lookup(memberIds[0]), leaderReg?.pricing, memberIds.length);
}
