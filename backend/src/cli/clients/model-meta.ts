import type { ProviderRegistry } from '../../providers/registry.js';
import type { CatalogModel, CatalogProviderRecord } from '../../opencode/catalog/types.js';
import { modelSupportsEfforts, type ReasoningEffort } from '../../types/router.js';
import { comboEnvelope, tierAliasEnvelope } from '../../providers/virtual-meta.js';
import { VIRTUAL_AUTO_IDS } from '../types.js';

/**
 * Client-hook model metadata — the per-entry enrichment written into client
 * config files that declare rich model records (pi's `models.json`). The
 * entry vocabulary is pi's: its `/thinking` picker reads `reasoning` +
 * `thinkingLevelMap` (absent → the model reads as non-thinking and no
 * thinking level can be set), the `/model` picker reads `name`, compaction
 * reads `contextWindow` / `maxTokens`, and the session cost footer reads
 * `cost` (USD per million tokens — the same unit the gateway catalog and
 * registry pricing already use).
 */

export interface ClientModelMeta {
  /** Catalog display name for the client's model picker. */
  name?: string;
  /** Whether the client should expose a thinking-level picker at all. */
  reasoning: boolean;
  /** pi `thinkingLevelMap` — pi level → wire value; null marks an unsupported level. */
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite?: number };
  /** pi `input` modalities — only written when the catalog declares image input. */
  input?: string[];
}

/**
 * Gateway-side dependency seam for client-hook metadata. The server injects
 * its live registry + catalog at boot; the standalone CLI leaves it unset —
 * there the adapters fall back to static alias declarations and bare entries
 * (nothing to resolve against). Module state, last injection wins: the
 * isolated test runner gives every file its own process.
 */
export interface GatewayMetaDeps {
  registry: ProviderRegistry;
  catalogList: () => Promise<CatalogProviderRecord[]>;
}

let metaDepsSource: (() => GatewayMetaDeps | undefined) | undefined;

export function setGatewayMetaDeps(fn: (() => GatewayMetaDeps | undefined) | undefined): void {
  metaDepsSource = fn;
}

/**
 * pi thinking-level keys in display order. pi's ladder has two rungs the
 * gateway vocabulary does not: `off` maps to the gateway's explicit `'none'`
 * wire value, and `minimal` has no gateway rung at all (always null — pi
 * hides it). Remaining rungs map identity; levels the model cannot serve are
 * null so the client never offers them. Without a supported set the FULL
 * identity map applies — the permissive declaration for dynamic targets
 * (auto* aliases, combos) whose actual model is resolved per request by the
 * gateway, which clamps to what it can serve and reports the truth via the
 * X-OCR-Thinking-* headers.
 */
export function piThinkingLevelMap(supported?: readonly ReasoningEffort[]): Record<string, string | null> {
  if (!supported) {
    return { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
  }
  const has = (lvl: ReasoningEffort) => supported.includes(lvl);
  return {
    off: 'none',
    minimal: null,
    low: has('low') ? 'low' : null,
    medium: has('medium') ? 'medium' : null,
    high: has('high') ? 'high' : null,
    xhigh: has('xhigh') ? 'xhigh' : null,
    max: has('max') ? 'max' : null,
  };
}

/** Convert a gateway envelope into the pi entry vocabulary (snake_case cost handled). */
function envToDisplayMeta(env: {
  contextWindow?: number;
  maxTokens?: number;
  imageInput?: boolean;
  pricing?: { input: number; output: number; cacheRead: number; cacheWrite?: number };
  leaderName?: string;
}): Omit<ClientModelMeta, 'reasoning'> {
  return {
    ...(env.leaderName ? { name: env.leaderName } : {}),
    ...(env.contextWindow ? { contextWindow: env.contextWindow } : {}),
    ...(env.maxTokens ? { maxTokens: env.maxTokens } : {}),
    ...(env.imageInput ? { input: ['text', 'image'] } : {}),
    ...(env.pricing ? { cost: piCost(env.pricing) } : {}),
  };
}

/** pi cost block — all four fields required by pi's schema, cacheWrite defaulting to 0.
 *  Accepts both vocabularies: registry pricing (camelCase cacheRead/cacheWrite)
 *  and catalog CatalogCost (snake_case cache_read/cache_write). */
function piCost(pricing: { input?: number; output?: number; cacheRead?: number; cache_read?: number; cacheWrite?: number; cache_write?: number } | undefined): ClientModelMeta['cost'] {
  if (!pricing) return undefined;
  return {
    input: pricing.input ?? 0,
    output: pricing.output ?? 0,
    cacheRead: pricing.cacheRead ?? pricing.cache_read ?? 0,
    cacheWrite: pricing.cacheWrite ?? pricing.cache_write ?? 0,
  };
}

/** Display fields shared by registry-hit and catalog-only resolution. */
function displayMeta(cat: CatalogModel): Omit<ClientModelMeta, 'reasoning'> {
  return {
    ...(cat.name ? { name: cat.name } : {}),
    ...(cat.limit?.context ? { contextWindow: cat.limit.context } : {}),
    ...(cat.limit?.output ? { maxTokens: cat.limit.output } : {}),
    ...(Array.isArray(cat.modalities?.input) && cat.modalities!.input!.includes('image') ? { input: ['text', 'image'] } : {}),
  };
}

/** Catalog lookup: full registered form `${provider}/${model}` first, then bare model id. */
async function findCatalogModel(
  id: string,
  catalogList: () => Promise<CatalogProviderRecord[]>
): Promise<CatalogModel | undefined> {
  let providers: CatalogProviderRecord[];
  try {
    providers = await catalogList();
  } catch {
    return undefined;
  }
  for (const rec of providers) {
    for (const m of rec.models) {
      if (`${rec.id}/${m.id}` === id) return m;
    }
  }
  for (const rec of providers) {
    const m = rec.models.find((x) => x.id === id);
    if (m) return m;
  }
  return undefined;
}

/**
 * Resolve per-id client metadata from the live gateway truth. Effort support
 * and pricing come from the registry (post-override, post tier replay);
 * display fields (name / context / max output / modalities) come from the
 * catalog. Combo ids resolve as dynamic targets (permissive full ladder —
 * each member is clamped per request); variant sibling ids declare
 * reasoning:false, the variant id itself pins the effort. Ids resolving to
 * nothing are absent from the result — the caller writes a bare entry.
 * Unknown/unavailable catalog never throws: metadata is best-effort display
 * data, a resolver failure must not fail the client setup.
 */
export async function resolveClientModelMeta(ids: string[]): Promise<Record<string, ClientModelMeta>> {
  const deps = metaDepsSource?.();
  const unique = [...new Set(ids.map((id) => (id || '').trim()).filter(Boolean))];
  const out: Record<string, ClientModelMeta> = {};
  if (!deps || unique.length === 0) return out;

  const registry = deps.registry;
  const combos = new Set(registry.getCombos().map((c) => c.id));
  const variants = new Set(registry.getVariantExposures().map((v) => v.id));
  const catalogList = deps.catalogList;

  for (const id of unique) {
    try {
      if (VIRTUAL_AUTO_IDS.has(id)) {
        // Static base (name/ladder) stays in the caller (pi.ts PI_ALIAS_META);
        // the aggregated tier-member envelope rides on top when a registry is
        // live. Effort ladder stays the permissive full map — see virtual-meta.
        const env = await tierAliasEnvelope(registry, catalogList, id);
        out[id] = { ...envToDisplayMeta(env), reasoning: true, thinkingLevelMap: piThinkingLevelMap() };
        continue;
      }
      if (combos.has(id)) {
        // Aggregate member capabilities from the fixed config list (see
        // virtual-meta.ts); the ladder stays permissive — each member is
        // clamped per request.
        const combo = registry.getCombos().find((c) => c.id === id);
        const env = combo ? await comboEnvelope(registry, catalogList, combo) : { memberCount: 0 };
        out[id] = { ...envToDisplayMeta(env), reasoning: true, thinkingLevelMap: piThinkingLevelMap() };
        continue;
      }
      if (variants.has(id)) {
        out[id] = { reasoning: false };
        continue;
      }
      const reg = registry.getModel(id);
      if (reg) {
        const supported = modelSupportsEfforts(reg.supportedReasoningEfforts, reg.supportsReasoningEffort);
        const cat = await findCatalogModel(id, catalogList);
        out[id] = {
          ...(cat ? displayMeta(cat) : {}),
          reasoning: !!supported,
          ...(supported ? { thinkingLevelMap: piThinkingLevelMap(supported) } : {}),
          cost: piCost(reg.pricing),
        };
        continue;
      }
      // Unregistered but catalogued (registry reloaded between UI and setup):
      // derive the effort ladder straight from the catalog's reasoningOptions.
      const cat = await findCatalogModel(id, catalogList);
      if (cat) {
        const { effortLadderFor } = await import('../../providers/boot-direct.js');
        const supported = effortLadderFor(cat, cat.reasoning === true);
        out[id] = {
          ...displayMeta(cat),
          reasoning: !!supported,
          ...(supported ? { thinkingLevelMap: piThinkingLevelMap(supported) } : {}),
        };
      }
    } catch {
      // best-effort — an unresolvable id stays absent (bare entry)
    }
  }
  return out;
}
