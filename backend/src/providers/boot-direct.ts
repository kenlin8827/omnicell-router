import { ModelRegistration, ModelVariant, ProviderConfig } from '../config/types.js';
import type { CatalogModel } from '../opencode/catalog/types.js';
import { PoolMembership, TierLevel, EFFORT_LADDER, type ReasoningEffort } from '../types/router.js';
import { loadConfig } from '../config/index.js';
import { resolveTierMatch, classifyTier } from './tier-match.js';
import { resolveTierMembers, claimModel, comboRefLookupFromConfig, expandComboRefs } from './member-match.js';
import { catalogRepository } from '../opencode/catalog/repository.js';
import {
  getProviderNodeById,
  getProviderModelDefs,
  expandEnvTemplate,
  legacyShapedSlotEntries,
  ROUTER_PROVIDER_ID,
} from '../opencode/user-config.js';
import { getCredentialStore, getCredentialStoreStatus } from '../opencode/credentials/index.js';
import { keyHashPrefix } from '../opencode/credentials/types.js';
import type { CallCredential, RawCred, ResolvedCredential } from '../opencode/credentials/types.js';
import { WireKind, wireFor, unroutableReason, baseForWire } from './wire.js';

/**
 * Build the direct execution pool WITHOUT the opencode daemon.
 * Truth sources:
 *   - the OCR provider-defs file's provider nodes (baseURL/headers/npm/model defs)
 *     [provider-defs.ts via user-config.ts]
 *   - the bound CredentialStore (opencode v2 db, the v2
 *     read-only fallback, or the OCR file — whichever the factory bound at boot) [credentials/]
 *   - models.dev catalog (pricing/capabilities/provider+model npm)     [catalogRepository]
 * Wire per model = wireFor(model npm > config npm > provider npm, base hint).
 * OAuth providers are excluded explicitly; token refresh is owned elsewhere.
 */

export interface DirectBootResult {
  /** logical provider name → resolved wire set (one DispatchingProvider per entry) */
  instances: {
    name: string;
    config: ProviderConfig;
    wires: WireKind[];
    wireBases: Partial<Record<WireKind, string>>;
    /**
     * The provider's ordered credentials for per-call
     * selection (active head first). INVARIANT: `credentialChain[0].key ===
     * config.apiKey` — the inline credential is prepended as head when it
     * outranks the store (Decision 1), so the baked default always equals the
     * chain head. RAW KEYS IN MEMORY ONLY: this payload goes to
     * `registry.registerProvider` and nothing else — never serialize it into
     * a console/API surface (masked views keep using `CredentialMeta`).
     */
    credentialChain: CallCredential[];
  }[];
  models: ModelRegistration[];
  /** reasonCode present on store-level entries merged from the binding (machine-readable; the reason text stays human-readable). */
  excluded: { provider: string; model?: string; reason: string; reasonCode?: string }[];
}

/** Raw key + display identity → the per-call selectable credential (P3 step 1). */
function toCallCredential(key: string, label: string): CallCredential {
  return { key, keyHashPrefix: keyHashPrefix(key), label };
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

/** One shared line for a node the reader refuses to route (Decision 11). */
function retiredShapeReason(paths: string[]): string {
  return `provider 定义节点为已废弃形状（${paths.join(', ')}）：已废弃形状不可路由 —— 请改用 package/settings 的 v2 形状`;
}

export async function buildDirectPool(): Promise<DirectBootResult> {
  const catalog = await catalogRepository.list();
  // Boot-time smart match (config `tiers[t].match` over the built-in
  // baseline). The registry replays it live on every config-save event
  // (applyTierConfigNow) — no gateway restart required for tier edits.
  const tierMatch = resolveTierMatch(loadConfig().tiers);
  // credentials come from the BOOT-BOUND CredentialStore, not
  // from auth.json directly. buildDirectPool is the boot/pool-rebuild path,
  // the ONLY sanctioned caller class for the raw `resolveKey`/`resolveKeyChain`
  //; the head key is baked once into instances[].config
  // and the full chain rides on the instance payload (registry-only).
  const store = await getCredentialStore();
  const storeStatus = await getCredentialStoreStatus();
  const instances: DirectBootResult['instances'] = [];
  const models: ModelRegistration[] = [];
  const excluded: DirectBootResult['excluded'] = [];

  // Decision 11: a retired-shape node is dropped by the reader (opencode's own v2
  // decoder discards the whole node), so the drop is reported here rather than
  // leaving the operator to wonder where their provider went.
  const retiredShapes = new Map(legacyShapedSlotEntries().map((e) => [e.id, e.paths]));

  for (const rec of catalog) {
    // The gateway must never route THROUGH itself: the hook-owned
    // `onecast-router` def (baseURL = this gateway) is client-takeover
    // material, not an upstream. Excluded loudly, never silently pooled.
    if (rec.id === ROUTER_PROVIDER_ID) {
      excluded.push({
        provider: rec.id,
        reason: 'router self-loop — the gateway cannot be its own upstream',
        reasonCode: 'router_self_loop',
      });
      continue;
    }
    const retired = retiredShapes.get(rec.id);
    if (retired) {
      retiredShapes.delete(rec.id);
      excluded.push({ provider: rec.id, reasonCode: 'legacy_shaped_node', reason: retiredShapeReason(retired) });
      continue;
    }
    const def = getProviderNodeById(rec.id);

    // Decision 1 last bullet: inline `{env:VAR}` / `options.apiKey` stay
    // ABOVE the store; the store supplies only the "store segment" the old
    // `auth.key || auth.access` lookup covered.
    const inlineKey = expandEnvTemplate(def?.options?.apiKey);
    // P2-9: a per-provider store read that THROWS (file unreadable mid-loop)
    // must not kill the whole pool rebuild — the affected provider lands as an
    // excluded entry (reasonCode db_unreadable) and the loop continues with the
    // others.
    let resolved: ResolvedCredential | null;
    // the same try-guarded read also fetches the
    // ordered chain (active head first); routable rows only.
    let storeCreds: RawCred[];
    try {
      resolved = store.resolveKey(rec.id);
      storeCreds = store.resolveKeyChain(rec.id);
    } catch (e) {
      excluded.push({
        provider: rec.id,
        reason: `store read failed: ${e instanceof Error ? e.message : String(e)}`,
        reasonCode: 'db_unreadable',
      });
      continue;
    }
    // Bake the chain head (P3 step 1); `resolved?.key` stays the defensive
    // fallback for a store whose chain read came back empty while resolveKey
    // answered — head === baked key is an invariant the registry relies on.
    const apiKey = inlineKey || storeCreds[0]?.key || resolved?.key;

    if (!apiKey) {
      // catalog-universe providers without credentials are structural noise —
      // only surface when the user actually defined a config node for them.
      // the credential candidates are the inline def and
      // the BOUND store (auth.json is no longer named here — it is not a sink).
      if (def) excluded.push({ provider: rec.id, reasonCode: 'no_credential', reason: '无凭证（内联或凭证库均缺失）' });
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

      // Explicit tier from the defs-file model definition wins; otherwise
      // the configurable smart match classifies (patterns → price band →
      // thinking-effort flag). Free models (input = 0) can hit the lite band;
      // models without catalog pricing simply skip bands. This pre-labeling is
      // suggestion/display only — the member lists below (claimModel) are the
      // sole membership source and overwrite it for every claimed model.
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
    // per-call selection chain. One instance per provider
    // even with N credentials: the head is baked as the default, the full
    // ordered chain rides on the payload (registry-only, raw keys in memory).
    // Single-credential providers get a length-1 chain — behavior byte-identical.
    const credentialChain: CallCredential[] = storeCreds.map((c) =>
      toCallCredential(c.key, c.label ?? c.credentialId)
    );
    // Defensive fallback consistency: if the chain read was empty but resolveKey
    // supplied the baked key, represent it so head === config.apiKey always holds.
    if (credentialChain.length === 0 && resolved) {
      credentialChain.push(toCallCredential(resolved.key, resolved.credential.label ?? resolved.credential.id));
    }
    // Inline {env}/options.apiKey outranks the store for the baked default
    // (Decision 1) — it becomes the chain HEAD too, keeping the invariant
    // head === config.apiKey; store credentials stay selectable below it.
    if (inlineKey) credentialChain.unshift(toCallCredential(inlineKey, 'inline'));
    instances.push({
      name: rec.id,
      config: {
        name: rec.id,
        type: 'dispatch',
        baseUrl: baseURL,
        // Boot-baked credential: the active-chain head —
        // the same key resolveKey picks when a provider holds exactly one
        // credential. Per-call selection reads the chain below; the baked key
        // remains the no-selector default.
        apiKey,
        headers: def?.options?.headers,
      },
      wires: [...wires],
      wireBases: Object.fromEntries(wireBases) as Partial<Record<WireKind, string>>,
      credentialChain,
    });
  }

  // A retired node for an id the catalog universe doesn't carry would otherwise be
  // invisible — the config side of the pool is exactly where such providers live.
  for (const [id, paths] of retiredShapes) {
    excluded.push({ provider: id, reasonCode: 'legacy_shaped_node', reason: retiredShapeReason(paths) });
  }

  // ─── store-binding exclusions merge ────────────────
  // Degraded-binding exclusions from the factory (excludedWithReason — the
  // boot hook used to console.log them only) surface in the same excluded[]
  // array, carrying their machine-readable reasonCode. Merge policy:
  //  - 'no_routable_credential' is skipped when the provider loop already
  //    produced a provider-level entry (its OAuth / no-credential reason is
  //    more specific than the overview-derived generic one);
  //  - 'no_routable_credential' is ALSO skipped when the provider ended up with
  //    an instance anyway — an inline `{env:VAR}`/settings key or an imported
  //    credential can make it routable after the binding snapshot was taken, and
  //    reporting "no routable credential" for a provider that is serving traffic
  //    is a false exclusion (the binding's credential overview is store-scoped and
  //    cannot see the config-side credential);
  //  - every other store-level code REPLACES a provider-level loop entry
  //    (stranded-key diagnostics, e.g. "db unreadable, key present in the
  //    auth.json snapshot", explain the absence better than the generic
  //    no-credential line can).
  for (const ex of storeStatus.excluded) {
    const dupIndex = excluded.findIndex((e) => e.provider === ex.provider && !e.model);
    if (ex.reasonCode === 'no_routable_credential' && dupIndex !== -1) continue;
    if (ex.reasonCode === 'no_routable_credential' && instances.some((i) => i.name === ex.provider)) continue;
    if (dupIndex !== -1) excluded.splice(dupIndex, 1);
    excluded.push({ provider: ex.provider, reason: `${ex.reasonCode}: ${ex.detail}`, reasonCode: ex.reasonCode });
  }

  // ─── membership: explicit member lists are the ONLY source ──────
  // No runtime seeding and no shipped member defaults: DEFAULT_CONFIG.tiers
  // is four EMPTY tier shells (defaultConfigYaml() writes them into every
  // brand-new config.yaml; loadConfig() falls back to them when a file has
  // no `tiers:` section). Every install starts pool-less — the all-empty
  // warning below fires until the operator adds members on the console
  // /tiers page; every model stays directly callable by id.
  // List order IS chain order (priority = rule index + 1), list index 0 is
  // the tier representative. Members are edited on the console /tiers page
  // (hot-applied by the registry; no restart, no persistence from boot).
  const cfgTiers = loadConfig().tiers;
  const registeredIds = new Set(models.map((m) => m.id));
  const lookup = comboRefLookupFromConfig(loadConfig().combos, (id) => registeredIds.has(id));
  const resolved = expandComboRefs(resolveTierMembers(cfgTiers).tiers, lookup);
  for (const d of resolved.dead) {
    console.warn(
      `[Boot] Tier '${d.tier}' references combo '${d.ref.slice('combo:'.length)}' that contributes no members ` +
        `(unknown / disabled / shadowed / zero registered models) — check it on the /tiers page.`,
    );
  }
  let claimed = 0;
  for (const m of models) {
    const claim = claimModel(m.id, resolved.tiers);
    if (claim === 'unclassified') {
      m.unclassified = true;
      continue;
    }
    claimed++;
    delete m.unclassified;
    m.tier = claim.tier;
    m.priority = claim.index + 1; // member-list order IS the chain order
    m.isDefaultInTier = claim.index === 0; // the list leader
    if (claim.rule.effortMap) m.effortMap = claim.rule.effortMap;
  }
  // Warn only when models exist but none is claimed — with zero registered
  // models (no provider credentials yet) the actionable gap is "add models",
  // not "add tier members", and the server already logs the empty registry.
  if (claimed === 0 && models.length > 0) {
    console.warn(
      '[OCR] No model matches any tier member rule — all four routing pools (lite/plus/pro/ultra) are EMPTY and `auto` cannot route. ' +
        'Add members on the console /tiers page (or in config.yaml under `tiers: <tier>: members:`). ' +
        'Every other model remains directly callable by full id; nothing was seeded or written.'
    );
  }

  return { instances, models, excluded };
}
