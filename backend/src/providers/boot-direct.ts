import { ModelRegistration, ModelVariant, ProviderConfig, TiersConfig } from '../config/types.js';
import type { CatalogModel } from '../opencode/catalog/types.js';
import { PoolMembership, TierLevel, EFFORT_LADDER, type ReasoningEffort } from '../types/router.js';
import { loadConfig, saveConfig } from '../config/index.js';
import { resolveTierMatch, classifyTier } from './tier-match.js';
import { resolveTierMembers, claimModel, generateMemberLists, MEMBER_TIER_ORDER, type ImportableModel } from './member-match.js';
import { globMatchAny } from '../utils/glob.js';
import { catalogRepository } from '../opencode/catalog/repository.js';
import {
  getProviderNodeById,
  getProviderModelDefs,
  expandEnvTemplate,
  readAuthEntries,
} from '../opencode/user-config.js';
import { WireKind, wireFor, unroutableReason, baseForWire } from './wire.js';

/**
 * build the direct execution pool WITHOUT the opencode daemon.
 * Truth sources are files only:
 *   - opencode.jsonc provider nodes (baseURL/headers/npm/model defs)   [user-config.ts]
 *   - auth.json credentials                                            [user-config.ts]
 *   - models.dev catalog (pricing/capabilities/provider+model npm)     [catalogRepository]
 * Wire per model = wireFor(model npm > config npm > provider npm, base hint).
 * OAuth providers are excluded explicitly; token refresh is owned elsewhere.
 */

export interface DirectBootResult {
  /** logical provider name → resolved wire set (one DispatchingProvider per entry) */
  instances: { name: string; config: ProviderConfig; wires: WireKind[]; wireBases: Partial<Record<WireKind, string>> }[];
  models: ModelRegistration[];
  excluded: { provider: string; model?: string; reason: string }[];
}

/**
 * Normalize a model def's `variants` array into the gateway's routable form.
 * Only effort-bearing variants are kept — the gateway serves a variant by
 * pinning a reasoning effort, so variants without `settings.reasoningEffort` /
 * `settings.effort` have nothing routable to contribute. Unknown effort
 * values and duplicate ids are dropped; undefined = no variants.
 */
export function routableVariants(raw: unknown): ModelVariant[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ModelVariant[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof (entry as any).id === 'string' ? (entry as any).id.trim() : '';
    if (!id || seen.has(id)) continue;
    const settings =
      (entry as any).settings && typeof (entry as any).settings === 'object' ? (entry as any).settings : {};
    const effortRaw = settings.reasoningEffort ?? settings.effort;
    if (typeof effortRaw !== 'string' || !(EFFORT_LADDER as readonly string[]).includes(effortRaw)) continue;
    seen.add(id);
    out.push({ id, reasoningEffort: effortRaw as ReasoningEffort });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Catalog `reasoning_options` → the gateway's effort ladder for
 * `supportedReasoningEfforts`.
 *  - `effort`: intersect values with EFFORT_LADDER — the real tiers
 *    (glm-5.3 only has low/high/max, o3 has no xhigh, so the "boolean expands
 *    into the full ladder" assumption over-declares for this model set);
 *  - `budget_tokens`: the full ladder (continuous budget, any tier maps to a
 *    budget);
 *  - `toggle` / unknown shape: `[]` — the model has NO explicit level
 *    control (selection skips it for effort requests; wire-side clamps to
 *    'none'). Never `undefined`: that means "assume everything" and the
 *    legacy boolean, when present, would resurrect a full-ladder claim;
 *  - legacy data with no reasoning_options: fall back to the boolean-expanded
 *    ladder (backward compatibility).
 */
export function effortLadderFor(
  catModel: CatalogModel | undefined,
  isReasoning: boolean
): readonly ReasoningEffort[] | undefined {
  const opts = catModel?.reasoningOptions;
  if (!Array.isArray(opts) || opts.length === 0) {
    return isReasoning ? EFFORT_LADDER : undefined;
  }
  const effortOpt = opts.find((o) => o?.type === 'effort');
  if (effortOpt && Array.isArray(effortOpt.values) && effortOpt.values.length > 0) {
    const allowed = effortOpt.values.filter(
      (v): v is ReasoningEffort => (EFFORT_LADDER as readonly string[]).includes(v)
    );
    if (allowed.length > 0) return allowed;
  }
  if (opts.some((o) => o?.type === 'budget_tokens')) return EFFORT_LADDER;
  return [];
}

export async function buildDirectPool(): Promise<DirectBootResult> {
  const catalog = await catalogRepository.list();
  // Boot-time smart match (config `tiers[t].match` over the built-in
  // baseline). The registry replays it live on every config-save event
  // (applyTierConfigNow) — no gateway restart required for tier edits.
  const tierMatch = resolveTierMatch(loadConfig().tiers);
  const authEntries = readAuthEntries();
  const instances: DirectBootResult['instances'] = [];
  const models: ModelRegistration[] = [];
  const excluded: DirectBootResult['excluded'] = [];

  for (const rec of catalog) {
    const def = getProviderNodeById(rec.id);
    const auth = authEntries[rec.id];

    const apiKey = expandEnvTemplate(def?.options?.apiKey) || auth?.key || auth?.access;
    if (!apiKey) {
      // catalog-universe providers without credentials are structural noise —
      // only surface when the user actually defined a config node for them.
      if (def) excluded.push({ provider: rec.id, reason: '无凭证（auth.json/内联均缺失）' });
      continue;
    }
    if (auth?.type === 'oauth') {
      excluded.push({ provider: rec.id, reason: 'OAuth 凭证（网关自持刷新前显式排除）' });
      continue;
    }
    // models.dev `api` (canonical) beats the daemon's runtime hint; per-wire
    // mounts can differ (e.g. Zen exposes chat+responses under /zen/v1 while
    // the daemon's effective base is a newer inference mount), and the hint
    // may be stale project-scoped state.
    const baseURL = expandEnvTemplate(def?.options?.baseURL) || rec.api || rec.baseURL;
    if (!baseURL) {
      excluded.push({ provider: rec.id, reason: '无法确定 baseURL（无 config 定义且目录无默认 api）' });
      continue;
    }

    const defs = getProviderModelDefs(rec.id) || {};
    const catById = new Map(rec.models.map((m) => [m.id, m]));
    // config definitions win as the model universe when present (opencode
    // semantics); auth-only providers (no defs at all) fall back to the full
    // catalog listing. "Present but every def disabled" is NOT that case — it
    // must end up with an empty universe, or hidden models leak back in
    // through the catalog fallback.
    // NOTE: no def-level `disabled` filter here — visibility is decided ONCE
    // below from the aggregate (which merges def values + overrides.json, with
    // the override winning). Filtering here would make a def-level
    // `disabled: true` unrecoverable from the UI.
    const defIds = Object.keys(defs);
    const modelIds = defIds.length > 0 ? defIds : rec.models.map((m) => m.id);
    if (modelIds.length === 0) {
      excluded.push({ provider: rec.id, reason: '目录与配置均无可用模型' });
      continue;
    }

    const wires = new Set<WireKind>();
    const wireBases = new Map<string, string>();
    for (const mid of modelIds) {
      const d = (defs as any)[mid];
      const catModel = catById.get(mid);
      // Hidden from the catalog (overrides.json `disabled`, or a def-level
      // `disabled` flag which the aggregation already carried over). Read from
      // the AGGREGATE so both write paths are honored by this one check —
      // hidden models stay listed in the catalog viewer but never reach the
      // routing pool, so /v1/models omits them and nothing can be pinned.
      if (catModel?.disabled === true) {
        excluded.push({ provider: rec.id, model: `${rec.id}/${mid}`, reason: '已在模型目录中隐藏（disabled）' });
        continue;
      }
      // the routing pool speaks chat/responses/anthropic only —
      // image/audio/video OUTPUT models (qwen-image, TTS, ASR…) belong to tool
      // extension mechanisms and would answer 400 ModelProtocolUnsupported or
      // garbage on any text wire. Config-defined models without modality data
      // pass through (no evidence they are non-text).
      const outMods = catModel?.modalities?.output;
      if (Array.isArray(outMods) && outMods.length > 0 && !outMods.includes('text')) {
        excluded.push({ provider: rec.id, model: `${rec.id}/${mid}`, reason: `非文本输出模型（modalities.output=${outMods.join('/')}），不入文本路由池` });
        continue;
      }
      const npm = d?.provider?.npm || catModel?.npm || def?.npm || rec.npm;
      const wire = wireFor(npm, baseURL || rec.api);
      if (wire === 'unroutable') {
        excluded.push({ provider: rec.id, model: `${rec.id}/${mid}`, reason: unroutableReason(npm) });
        continue;
      }
      wires.add(wire);
      wireBases.set(wire, baseForWire(wire, baseURL));

      const isReasoning = catModel?.reasoning === true || d?.capabilities?.reasoning === true;
      const inputCost = catModel?.cost?.input ?? (isReasoning ? 10.0 : 2.0);
      const outputCost = catModel?.cost?.output ?? inputCost * 4.0;
      const cacheRead = catModel?.cost?.cache_read ?? inputCost * 0.25;

      // Explicit tier from the opencode.jsonc model definition wins; otherwise
      // the configurable smart match classifies (patterns → price band →
      // thinking-effort flag). Free models (input = 0) can hit the lite band;
      // models without catalog pricing simply skip bands and now end up
      // UNCLASSIFIED (no residual tier) unless something claims them.
      // NOTE: this is only the first-boot migration seed — the committed
      // member lists below (claimModel) are the sole membership source.
      const explicitTier = (v: unknown): TierLevel | undefined =>
        v === 'lite' || v === 'plus' || v === 'pro' || v === 'ultra' ? (v as TierLevel) : undefined;
      const rawInputPerM = catModel?.cost?.input;
      const configTier = explicitTier(d?.tier);
      const membership: PoolMembership = configTier ?? classifyTier({ modelId: mid, inputPerM: rawInputPerM, reasoningFlag: isReasoning }, tierMatch);
      const unclassified = membership === 'unclassified';
      const tier: TierLevel = unclassified ? 'plus' : membership;
      const variants = routableVariants((d as any)?.variants ?? catModel?.variants);
      // Model-default thinking level: override (catalog) wins over the def's
      // `settings.reasoningEffort`; invalid values are dropped defensively.
      const rawDefaultEffort = catModel?.defaultEffort ?? (d?.settings?.reasoningEffort as string | undefined);
      const defaultEffort = (EFFORT_LADDER as readonly string[]).includes(rawDefaultEffort ?? '')
        ? (rawDefaultEffort as ReasoningEffort)
        : undefined;

      models.push({
        id: `${rec.id}/${mid}`,
        provider: rec.id,
        upstreamModel: (d && typeof d === 'object' && d.modelID ? String(d.modelID) : mid),
        tier,
        isDefaultInTier: false,
        // Catalog reasoning_options → the real effort tiers (see effortLadderFor).
        // The legacy `supportsReasoningEffort` boolean is intentionally NOT set:
        // `supportedReasoningEfforts` is always resolved here, and the legacy
        // true-branch would resurrect a full-ladder claim for [] (toggle) models.
        supportedReasoningEfforts: effortLadderFor(catModel, isReasoning),
        // Tri-state sampling-parameter capability flag — the provider layer
        // strips params for temperature:false models.
        temperature: catModel?.temperature,
        supportsPromptCaching: wire === 'anthropic' || (catModel?.cost?.cache_read != null ? true : undefined),
        // Variants become routable sibling ids (`<id>-<variant>`) + `#variant`
        // syntax; the jsonc def is the source (catalog records may mirror it).
        variants,
        // Pinned when the client omits `reasoning_effort` (orchestrator).
        defaultEffort,
        wire,
        // Classification inputs → the registry replays tier membership live
        // (config match + catalog overrides) without a gateway restart.
        tierMatch: { rawInputPerM, reasoningFlag: isReasoning },
        ...(configTier ? { configTier } : {}),
        ...(unclassified ? { unclassified: true } : {}),
        pricing: {
          input: inputCost,
          output: outputCost,
          cacheRead,
          ...(catModel?.cost?.cache_write != null ? { cacheWrite: catModel.cost.cache_write } : {}),
        },
      });
    }

    if (wires.size === 0) {
      excluded.push({ provider: rec.id, reason: '该 provider 全部模型不可直连路由' });
      continue;
    }
    instances.push({
      name: rec.id,
      config: {
        name: rec.id,
        type: 'dispatch',
        baseUrl: baseURL,
        apiKey,
        headers: def?.options?.headers,
      },
      wires: [...wires],
      wireBases: Object.fromEntries(wireBases) as Partial<Record<WireKind, string>>,
    });
  }

  // ─── membership: explicit member lists are the ONLY source ──────
  // Bootstrap: a brand-new install has no `members` anywhere (DEFAULT_CONFIG
  // ships tiers: {}), so seed the first lists from the classifier
  // (configTier > match) and persist them — otherwise every model would come
  // out `unclassified` and all four pools would be empty. Afterwards list
  // order IS the chain order (priority = rule index + 1) and the list leader
  // is the tier representative.
  let resolved = resolveTierMembers(loadConfig().tiers);
  if (!resolved.configured) {
    const tiersCfg = loadConfig().tiers || {};
    // The tier leaders must land at list index 0 (cheapest lite / median plus
    // / first-reasoning pro / priciest ultra) — at this point
    // isDefaultInTier/priority are not yet assigned, so without this pass the
    // seeded order would degenerate to registration insertion order and the
    // seeded chain would pick a different primary.
    const external = models.filter((m) => m.provider !== 'opencode');
    const seedPool = external.length > 0 ? external : models;
    const seedLeaders = new Set<string>();
    const byInput = (a: ModelRegistration, b: ModelRegistration) => (a.pricing.input ?? 0) - (b.pricing.input ?? 0);
    const tLite = seedPool.filter((m) => m.tier === 'lite').sort(byInput);
    if (tLite[0]) seedLeaders.add(tLite[0].id);
    let tPlus = seedPool.filter((m) => m.tier === 'plus').sort(byInput);
    if (tPlus.length === 0) tPlus = seedPool.filter((m) => m.tier !== 'pro' && m.tier !== 'ultra');
    if (tPlus.length > 0) seedLeaders.add(tPlus[Math.floor(tPlus.length / 2)].id);
    const tPro = seedPool.filter((m) => m.tier === 'pro');
    if (tPro.length > 0) seedLeaders.add((tPro.find((m) => (m.supportedReasoningEfforts?.length ?? 0) > 0) || tPro[0]).id);
    const tUltra = seedPool.filter((m) => m.tier === 'ultra').sort((a, b) => -byInput(a, b));
    if (tUltra[0]) seedLeaders.add(tUltra[0].id);
    const inputs: ImportableModel[] = models.map((m) => {
      const bareId = m.id.startsWith(m.provider + '/') ? m.id.slice(m.provider.length + 1) : m.id;
      return {
        id: m.id,
        bareId,
        inputPerM: m.tierMatch?.rawInputPerM,
        reasoningFlag: m.tierMatch?.reasoningFlag ?? false,
        configTier: m.configTier,
        chainPriority: seedLeaders.has(m.id) ? 0 : 10,
      };
    });
    const deny = tiersCfg.exclude ?? [];
    const seeded = generateMemberLists(inputs, tierMatch, (id) => deny.length > 0 && globMatchAny(deny, id));
    const mergedTiers: TiersConfig = { ...tiersCfg };
    for (const t of MEMBER_TIER_ORDER) {
      mergedTiers[t] = { ...(tiersCfg[t] ?? {}), members: seeded[t] };
    }
    // In-memory lists apply for THIS boot regardless (a persist failure must
    // not strand the gateway on empty pools); persistence retries next boot.
    resolved = { tiers: seeded, configured: true };
    const saved = saveConfig({ tiers: mergedTiers });
    if (saved.success) {
      console.log(
        `[OCR] seeded the first tier member lists from the built-in match ` +
          `(lite ${seeded.lite.length} / plus ${seeded.plus.length} / pro ${seeded.pro.length} / ultra ${seeded.ultra.length}) ` +
          `and saved to config.yaml — review/adjust on the /tiers page.`
      );
    } else {
      console.warn(
        `[OCR] member-list seed could not be persisted (${saved.error}) — ` +
          `lists act in-memory for this boot only; they retry on the next start.`
      );
    }
  }
  for (const m of models) {
    const claim = claimModel(m.id, resolved.tiers);
    if (claim === 'unclassified') {
      m.unclassified = true;
      continue;
    }
    delete m.unclassified;
    m.tier = claim.tier;
    m.priority = claim.index + 1; // member-list order IS the chain order
    m.isDefaultInTier = claim.index === 0; // the list leader
    if (claim.rule.effortMap) m.effortMap = claim.rule.effortMap;
  }

  return { instances, models, excluded };
}
