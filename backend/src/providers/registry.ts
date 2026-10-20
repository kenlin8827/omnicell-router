import { LLMProvider, type UpstreamEventContext, type CallCredential } from './base.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { ResponsesProvider } from './responses.js';
import { GoogleProvider } from './google.js';
import { ModelRegistration, ModelVariant, ProviderConfig, RouterConfig, TiersConfig, TierMemberRule, ComboConfig, ComboModelRef } from '../config/types.js';
import { PoolMembership, ReasoningEffort, TierLevel, EFFORT_LADDER, downgradeReasoning, modelSupportsEfforts, type EffortMap } from '../types/router.js';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { CircuitBreakerManager, UpstreamError, type ModelAvailability, type ModelHealthView } from '../resilience/index.js';
import { globMatchAny } from '../utils/glob.js';
import { loadConfig } from '../config/index.js';
import { resolveTierMembers, claimModel, claimInTier, matchingTiers, applyEffortMap, MEMBER_TIER_ORDER, TIER_DESCENDING_ORDER, comboMemberRefsOf, expandComboRefs, RESERVED_COMBO_IDS, type ExpandedMembers } from './member-match.js';
import { createChunkAccumulator, type StreamRelay } from '../utils/chat-stream.js';

/**
 * Normalize a client-supplied upstream host for provider matching: lowercase,
 * strip IPv6 brackets and a trailing :port. Returns undefined for empty or
 * non-string input so callers can treat "no host" uniformly.
 */
function normalizeHostHeader(host: unknown): string | undefined {
  if (typeof host !== 'string') return undefined;
  let h = host.trim().toLowerCase();
  if (!h) return undefined;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) h = h.slice(1, end);
  } else if (h.includes(':')) {
    h = h.split(':')[0];
  }
  return h || undefined;
}

/** Hostname of a provider baseUrl, or undefined when it is absent/malformed
 *  (WHATWG URL already lowercases the hostname). */
function hostOfBaseUrl(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return undefined;
  try {
    return new URL(baseUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private models = new Map<string, ModelRegistration>();
  private tierDefaults = new Map<TierLevel, ModelRegistration>();
  private circuitBreakerManager: CircuitBreakerManager;
  private tierPolicies: TiersConfig;
  /**
   * The COMMITTED member-list view pools read: `tiers.<t>.members` with
   * `combo:<id>` refs expanded, stored by reclassifyTiers (the one commit
   * point) and initialized from the boot config. Every pool read — candidates,
   * weights, effort translation, membership sets — goes through this snapshot,
   * so what routing sees is always exactly what was last committed.
   */
  private committedMembers: Record<TierLevel, TierMemberRule[]> = { lite: [], plus: [], pro: [], ultra: [] };
  private rrCursor = new Map<TierLevel, number>();
  private combos = new Map<string, ComboConfig>();
  private comboRrCursor = new Map<string, number>();
  /** Raw configs for every configured provider (all types) — lets the
   *  /v1/systemone route detect native System One upstreams and reach their
   *  baseUrl/apiKey (systemone providers build no chat executor). */
  private providerConfigs = new Map<string, ProviderConfig>();
  /** Pre-resolved baseUrl hostname per provider (constructor-time; the
   *  configs themselves are constructor-populated and never mutate) — keeps
   *  bare-name host disambiguation off the URL parser in the hot path. */
  private providerHosts = new Map<string, string | undefined>();
  /** Sibling-id index for model variants: `<baseId>-<variantId>` → base + variant. */
  private variantIndex = new Map<string, { baseId: string; variant: ModelVariant }>();
  /**
   * Per-provider credential chains for per-call selection,
   * populated ONLY through `registerProvider` (the boot path hands raw keys from
   * `buildDirectPool` here and nowhere else). NEVER serialize: masked credential
   * views keep going through the credential store's `CredentialMeta`. Chain order =
   * selection priority (active head first); chain head = the boot-baked
   * `config.apiKey` (inline-precedence case included — boot prepends it).
   */
  private credentialChains = new Map<string, CallCredential[]>();
  private mockMode = false;
  private autoRefreshTierMatch = true;
  private lastMatchRefreshAt = 0;

  constructor(config: RouterConfig, mockMode = false) {
    this.mockMode = mockMode;
    this.tierPolicies = config.tiers || {};
    // The breaker rules resolver borrows trip.rateLimit.hardTripAboveMs's
    // default from retry.inplace.maxRateLimitWaitMs (spec: the breaker-side
    // copy never rewrites the retry-side in-place-retry decision).
    this.circuitBreakerManager = new CircuitBreakerManager(config.circuitBreaker, Date.now, undefined, config.retry);

    // Initialize providers
    for (const pConfig of config.providers || []) {
      this.providerConfigs.set(pConfig.name, pConfig);
      this.providerHosts.set(pConfig.name, hostOfBaseUrl(pConfig.baseUrl));
      if (pConfig.type === 'systemone') {
        // Native System One upstreams are NOT chat executors — the shared
        // decision executor calls them directly (protocols/systemone/decide.ts).
        // Skipping the LLMProvider pool keeps chat routing from ever
        // dispatching to them.
        continue;
      }
      if (pConfig.type === 'anthropic') {
        this.providers.set(pConfig.name, new AnthropicProvider(pConfig));
      } else if (pConfig.type === 'responses') {
        this.providers.set(pConfig.name, new ResponsesProvider(pConfig));
      } else if (pConfig.type === 'google') {
        this.providers.set(pConfig.name, new GoogleProvider(pConfig));
      } else {
        this.providers.set(pConfig.name, new OpenAICompatibleProvider(pConfig));
      }
    }

    // Initialize models
    for (const mConfig of config.models || []) {
      this.registerModel(mConfig, mConfig.isDefaultInTier);
    }

    // Initialize custom model combos (after models so member resolution at
    // request time can find them; membership itself is resolved lazily)
    this.applyCombos(config.combos);

    // Initial committed member view (boot config; re-expanded so pools exist
    // before the first save-commit). All models are registered by now, so
    // combo-ref expansion sees the full universe.
    this.committedMembers = this.expandedMemberRules(this.tierPolicies).tiers;

    // In mock testing mode, if no models provided, populate mock tier models
    if (this.mockMode && this.models.size === 0) {
      const mockT1: ModelRegistration = {
        id: 'mock-lite',
        provider: 'mock',
        upstreamModel: 'mock-lite',
        tier: 'lite',
        isDefaultInTier: true,
        pricing: { input: 0.2, cacheRead: 0.05, output: 0.8 },
      };
      const mockT2: ModelRegistration = {
        id: 'mock-plus',
        provider: 'mock',
        upstreamModel: 'mock-plus',
        tier: 'plus',
        isDefaultInTier: true,
        pricing: { input: 3.0, cacheRead: 0.75, output: 12.0 },
      };
      const mockT3: ModelRegistration = {
        id: 'mock-pro',
        provider: 'mock',
        upstreamModel: 'mock-pro',
        tier: 'pro',
        isDefaultInTier: true,
        pricing: { input: 15.0, cacheRead: 3.75, output: 60.0 },
      };
      const mockT4: ModelRegistration = {
        id: 'mock-ultra',
        provider: 'mock',
        upstreamModel: 'mock-ultra',
        tier: 'ultra',
        isDefaultInTier: true,
        pricing: { input: 30.0, cacheRead: 7.5, output: 120.0 },
      };
      this.registerModel(mockT1, true);
      this.registerModel(mockT2, true);
      this.registerModel(mockT3, true);
      this.registerModel(mockT4, true);
    }
  }

  public registerProvider(name: string, provider: LLMProvider, credentialChain?: CallCredential[]): void {
    this.providers.set(name, provider);
    if (credentialChain?.length) this.credentialChains.set(name, credentialChain);
  }

  public registerModel(model: ModelRegistration, isDefault = false): void {
    if (this.combos.has(model.id)) {
      console.warn(`[Registry] Model id '${model.id}' shadows an existing combo id — the combo became unreachable.`);
    }
    this.models.set(model.id, model);
    this.circuitBreakerManager.registerModel(model);
    this.indexVariants(model);
    // an UNCLAIMED model must never become a tier's representative —
    // it joins no pool, so promoting it would hand routing a model the pools
    // themselves filter out. Explicit `isDefault` pinning stays authoritative.
    if (model.unclassified && !isDefault) return;
    if (isDefault || !this.tierDefaults.has(model.tier)) {
      this.tierDefaults.set(model.tier, model);
    }
  }

  public getCircuitBreakerManager(): CircuitBreakerManager {
    return this.circuitBreakerManager;
  }

  /**
   * Aggregate model availability across its credential chain:
   * the chain's credential prefixes feed `modelAvailability`, so a model whose
   * credentials are ALL pair-OPEN/SUSPECT reads as unavailable even while its
   * model breaker is CLOSED, and a model trip marks every prefix open.
   * Chain-less providers (config.yaml boot) pass an empty prefix list and the
   * aggregate degenerates to the plain model check.
   */
  public modelAvailable(model: ModelRegistration): ModelAvailability {
    const chain = this.credentialChains.get(model.provider);
    const prefixes = chain?.map((c) => c.keyHashPrefix) ?? [];
    return this.circuitBreakerManager.modelAvailability(model.id, prefixes);
  }

  /**
   * Model capability view for session-pin eviction ('available' /
   * 'recovering' / 'unavailable') — see
   * `CircuitBreakerManager.modelHealthView`; state reads are non-consuming.
   */
  public modelHealthView(model: ModelRegistration): ModelHealthView {
    const chain = this.credentialChains.get(model.provider);
    const prefixes = chain?.map((c) => c.keyHashPrefix) ?? [];
    return this.circuitBreakerManager.modelHealthView(model.id, prefixes);
  }

  public setDefaultTierModel(tier: TierLevel, model: ModelRegistration): void {
    this.models.set(model.id, model);
    this.tierDefaults.set(tier, model);
    this.circuitBreakerManager.registerModel(model);
    this.indexVariants(model);
  }

  public getModel(modelId: string): ModelRegistration | undefined {
    return this.models.get(modelId);
  }

  /**
   * Resolve a BARE upstream name (no `provider/` prefix — how clients name a
   * model the way its own catalog does, e.g. `qwen3.8-flash`) to registered
   * models whose `upstreamModel` equals it. This is the second exact-match
   * tier after full-id lookup: several providers commonly expose the same
   * upstream name, so ALL hits are returned, ordered deterministically
   * (cheapest input price first, then id) — the first entry is the primary,
   * the rest are reachable through the same-tier failover pool. Names
   * containing `/` are rejected (those are full-id lookups, not bare names).
   *
   * `upstreamHost` (the proxy-interception target host, when the request
   * arrived through the MITM forward proxy) disambiguates same-name models:
   * candidates whose provider baseUrl hostname matches the host win; when
   * nothing matches (hooked clients hit the gateway itself, unknown hosts)
   * the full hit list applies. Empty result = no registered model carries
   * that upstream name; the caller keeps its existing contract for that case.
   */
  public getModelsByUpstreamName(bareName: string, upstreamHost?: string): ModelRegistration[] {
    if (!bareName || bareName.includes('/')) return [];
    const hits: ModelRegistration[] = [];
    for (const m of this.models.values()) {
      if (m.upstreamModel === bareName) hits.push(m);
    }
    // Locale-independent tiebreak: strict code-unit order, not localeCompare.
    const byPrice = (a: ModelRegistration, b: ModelRegistration) =>
      (a.pricing.input ?? Infinity) - (b.pricing.input ?? Infinity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const host = normalizeHostHeader(upstreamHost);
    if (host) {
      const scoped = hits.filter((m) => this.providerHosts.get(m.provider) === host);
      if (scoped.length > 0) return scoped.sort(byPrice);
    }
    return hits.sort(byPrice);
  }

  /** Raw provider config (any type) — the /v1/systemone route uses it to
   *  detect native System One upstreams and reach their baseUrl/apiKey. */
  public getProviderConfig(name: string): ProviderConfig | undefined {
    return this.providerConfigs.get(name);
  }

  /**
   * The provider's ordered credential chain (selection
   * priority order), or undefined when no chain was registered (config.yaml
   * providers, mock/stub call sites) — callers then use the baked config key.
   * Raw keys: in-process consumers only, never serialize.
   */
  public getCredentialChain(name: string): CallCredential[] | undefined {
    return this.credentialChains.get(name);
  }

  /**
   * Active credential (chain head = the boot-baked key). Providers without a
   * registered chain return undefined — behavior identical to reading
   * `getProviderConfig(name).apiKey` directly (single-key degeneracy).
   */
  public getActiveCredential(name: string): CallCredential | undefined {
    return this.credentialChains.get(name)?.[0];
  }

  /**
   * Why a model is rejected from every pool ('' = allowed). The ONLY pool
   * filter left: the GLOBAL denylist (tiers.exclude) — unconditional, it
   * outranks even an explicit pin. Per-tier vetoes (match.exclude)
   * and the model-side excludeTiers live inside the classification gate.
   */
  private policyRejectionReason(policies: TiersConfig | undefined, m: ModelRegistration): string {
    const exclude = policies?.exclude;
    if (exclude?.length && globMatchAny(exclude, m.id)) return 'exclude';
    return '';
  }

  /** Weight of a model inside a tier: from THIS tier's claiming member rule
   *  in the committed view (per-tier claim — a model in several tiers carries
   *  a weight per pool), default 1. */
  private weightFor(tier: TierLevel, modelId: string): number {
    const claim = claimInTier(tier, modelId, this.committedMembers);
    return claim ? Math.max(1, Number(claim.rule.weight) || 1) : 1;
  }

  /** Effective selection strategy: explicit config wins; default priority (legacy weights retired). */
  private selectionStrategy(tier: TierLevel): 'priority' | 'weighted' | 'round_robin' {
    return this.tierPolicies?.[tier]?.selection ?? 'priority';
  }

  /** Weighted round-robin: each model occupies `weight` consecutive slots per cycle. */
  private pickRoundRobin(models: ModelRegistration[], tier: TierLevel): ModelRegistration {
    const slots: ModelRegistration[] = [];
    for (const m of models) {
      const w = this.weightFor(tier, m.id);
      for (let i = 0; i < w; i++) slots.push(m);
    }
    if (slots.length === 0) return models[0];
    const prev = this.rrCursor.get(tier) ?? 0;
    this.rrCursor.set(tier, prev + 1);
    return slots[prev % slots.length];
  }

  /**
   * Primary pick inside a tier, driven by the tier's selection strategy:
   * - priority (default): first healthy candidate in chain order (= member
   *   list order)
   * - weighted: weighted random draw over the healthy pool (claiming member
   *   rule's weight, default 1)
   * - round_robin: rotating weighted slots for even distribution over time
   * The failover chain order is strategy-independent (buildTierPoolEntries:
   * rule weight desc, then rule list order).
   */
  private pickPrimary(models: ModelRegistration[], tier: TierLevel): ModelRegistration {
    if (models.length <= 1) return models[0];
    const strategy = this.selectionStrategy(tier);
    if (strategy === 'round_robin') return this.pickRoundRobin(models, tier);
    if (strategy === 'weighted') {
      const weights = models.map((m) => this.weightFor(tier, m.id));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < models.length; i++) {
        r -= weights[i];
        if (r < 0) return models[i];
      }
      return models[models.length - 1];
    }
    return models[0];
  }

  /**
   * Per-tier pool construction — the ONE membership read for a single tier.
   * Membership is a PER-TIER projection of the member lists: every rule in
   * THIS tier's list claims models independently of the other tiers, so a
   * model (or a combo's expanded members) may join several pools at once.
   * Hand-configured models (no tierMatch) are reclassification-immune: they
   * join exactly their explicit tier, with weight from this tier's matching
   * rule when one exists (default 1). Chain order = claiming-rule weight
   * (desc) then rule list position (asc); entries carry the claiming rule's
   * weight and effortMap — the translation that applies when the model
   * serves from THIS pool.
   */
  private buildTierPoolEntries(
    tier: TierLevel,
    members: Record<TierLevel, TierMemberRule[]>,
  ): { model: ModelRegistration; weight: number; effortMap?: EffortMap; rank: number }[] {
    const entries: { model: ModelRegistration; weight: number; effortMap?: EffortMap; rank: number }[] = [];
    for (const m of this.models.values()) {
      if (!m.tierMatch) {
        // Hand-configured model: explicit tier, member rules never move it.
        if (m.unclassified || m.tier !== tier) continue;
        const claim = claimInTier(tier, m.id, members);
        entries.push({
          model: m,
          weight: claim ? Math.max(1, Number(claim.rule.weight) || 1) : 1,
          effortMap: m.effortMap,
          rank: m.isDefaultInTier ? 0 : m.priority ?? 10,
        });
        continue;
      }
      const claim = claimInTier(tier, m.id, members);
      if (!claim) continue;
      entries.push({
        model: m,
        weight: Math.max(1, Number(claim.rule.weight) || 1),
        effortMap: claim.rule.effortMap,
        rank: claim.index,
      });
    }
    entries.sort((a, b) => b.weight - a.weight || a.rank - b.rank);
    return entries;
  }

  /**
   * The effort translation that applies when `model` serves from `tier`'s
   * pool: the claiming rule's effortMap in THAT tier (a model holding
   * membership in several tiers translates differently per pool).
   * Hand-configured models keep their stored translation
   * (reclassification-immune); a model absent from this tier (escalation-tail
   * resolution) falls back to the stored home-tier translation.
   */
  public effortMapFor(model: ModelRegistration, tier: TierLevel): EffortMap | undefined {
    if (!model.tierMatch) return model.effortMap;
    const claim = claimInTier(tier, model.id, this.committedMembers);
    if (claim) return claim.rule.effortMap; // this pool's rule is authoritative (undefined = passthrough)
    return model.effortMap; // serving outside its pools — home-tier translation
  }

  /**
   * Every tier whose member list claims the model — the multi-membership
   * view behind the catalog's `tiers` array and tier-expanded model-access
   * checks. Hand-configured models expose exactly their explicit tier.
   */
  public tiersOf(model: ModelRegistration): TierLevel[] {
    if (!model.tierMatch) return model.unclassified ? [] : [model.tier];
    return matchingTiers(model.id, this.committedMembers);
  }

  /**
   * Runtime tier reclassification — tier membership is pure file-derived data
   * (config `tiers[t].members`), replayed against each model id on
   * pool resolution instead of waiting for a gateway restart. Model UNIVERSE
   * (providers/credentials/wire) stays a boot snapshot.
   */

  /** Hot-path guard: replay member lists + refresh policies at most every 2 seconds. */
  private maybeRefreshTierMatch(): void {
    if (!this.autoRefreshTierMatch) return;
    const now = Date.now();
    if (now - this.lastMatchRefreshAt < 2000) return;
    this.lastMatchRefreshAt = now;
    try {
      const tiers = loadConfig().tiers || {};
      this.tierPolicies = tiers; // the global denylist lives here too
      this.reclassifyTiers(this.expandedMemberRules(tiers).tiers);
    } catch {
      // transient config/IO error — keep the current classification
    }
  }

  /** Latest committed `tiers` config (snapshot; updated by applyTierConfigNow / maybeRefreshTierMatch). */
  public getTierPolicies(): TiersConfig {
    return this.tierPolicies;
  }

  /** Test hook: silence the lazy config re-read (explicit reclassifyTiers still works). */
  public setAutoRefreshTierMatch(on: boolean): void {
    this.autoRefreshTierMatch = on;
  }

  /** Registered member refs of one combo (config order, deduped, unregistered
      dropped) — null when the ref is dead: unknown id, operator-disabled, or
      shadowed by a registered model. */
  private comboMemberRefs(comboId: string): { id: string; weight: number }[] | null {
    const combo = this.combos.get(comboId);
    if (!combo || combo.disabled === true || this.models.has(comboId)) return null;
    return comboMemberRefsOf(combo, (id) => this.models.has(id));
  }

  /**
   * The ONE member-rule read view: `tiers.<t>.members` with `combo:<id>` refs
   * expanded in place. Every membership consumer (claims, weights, pools,
   * boot, save checks) must read through this so pools stay physical-model
   * lists while config keeps the operator's declared references.
   */
  public expandedMemberRules(policies: TiersConfig | undefined): ExpandedMembers {
    return expandComboRefs(resolveTierMembers(policies).tiers, (id) => this.comboMemberRefs(id));
  }

  /**
   * COMMIT path — the only one that rewrites live pool membership. Called on
   * every config-save event (console routes) so edits take effect immediately;
   * the lazy maybeRefreshTierMatch replay remains only as the out-of-band
   * (hand-edited YAML) safety net.
   */
  public applyTierConfigNow(): void {
    if (this.mockMode) return;
    const tiers = loadConfig().tiers || {};
    this.tierPolicies = tiers;
    this.lastMatchRefreshAt = Date.now(); // the file was just read — skip the TTL replay
    this.reclassifyTiers(this.expandedMemberRules(tiers).tiers);
  }

  /** Replays the member lists over every reclassifiable model and stores
   * them as the committed pool view (buildTierPoolEntries reads exactly this
   * snapshot). What is stored per model is the DERIVED HOME view used by
   * single-tier consumers (pinned force_tier, tier-keyed reporting,
   * model-access tier expansion): `tier` = first claim in tier order
   * lite→plus→pro→ultra, with that claim's chain data and effortMap.
   * Representatives are refreshed from the per-tier pools afterwards. */
  public reclassifyTiers(members: Record<TierLevel, TierMemberRule[]>): void {
    if (this.mockMode) return;
    this.committedMembers = members;
    for (const m of this.models.values()) {
      if (!m.tierMatch) continue; // hand-configured: never moved
      const home = claimModel(m.id, members);
      if (home === 'unclassified') {
        m.unclassified = true;
        m.isDefaultInTier = false;
        delete m.effortMap;
        continue;
      }
      m.unclassified = false;
      m.tier = home.tier;
      m.priority = home.index + 1; // home list order (derived view)
      m.isDefaultInTier = home.index === 0; // the home list leader
      if (home.rule.effortMap) m.effortMap = home.rule.effortMap;
      else delete m.effortMap;
    }
    // Representatives = chain head of each tier's per-tier pool (weight desc,
    // then rule-list order) — a model leading tier X need not lead its home
    // tier's list once pools can overlap.
    for (const tier of MEMBER_TIER_ORDER) {
      const head = this.buildTierPoolEntries(tier, members)[0]?.model;
      if (head) this.tierDefaults.set(tier, head);
      else this.tierDefaults.delete(tier);
    }
  }

  /**
   * Returns all candidate models registered for a given tier, in chain order
   * (member-list order). If healthyOnly is true, only returns models
   * where the circuit breaker allows execution. The global denylist
   * (tiers.exclude) is applied first; unclaimed (`unclassified`) models join no
   * pool. Membership is the per-tier projection (buildTierPoolEntries) —
   * a model may serve in several tiers at once.
   */
  public getCandidateModelsForTier(tier: TierLevel, healthyOnly = true): ModelRegistration[] {
    this.maybeRefreshTierMatch();
    return this.tierPoolEntries(tier, healthyOnly).map(({ model }) => model);
  }

  /**
   * Pick a model that can serve `requested` effort. Returns the highest-effort
   * model that still satisfies the request (never upgrades above the requested
   * level — that's dishonest). If no candidate in the tier supports any
   * effort, expands the search across all healthy tiers so a model that
   * happens to live in the wrong tier pool (typical when a thinking-capable
   * model was categorized as `plus` but the client requested `high` from the
   * `pro` pool) can still serve.
   *
   * Returns `{ model, actualEffort, degraded }`:
   *   - `model`         the chosen ModelRegistration
   *   - `actualEffort`  the highest effort ≤ requested that `model` supports;
   *                      `none` when the model can't do explicit thinking
   *   - `degraded`      true if `actualEffort` rank < `requested` rank
   *
   * Returns `null` when:
   *   - the requested effort is `none` AND the tier is fully empty, or
   *   - no candidate in the tier OR cross-tier fallback can serve ANY
   *     explicit effort ≤ requested. Per the honesty contract, an over-spec
   *     pool (one whose supported set sits above the requested level) is
   *     NOT a valid match — we'd rather let the orchestrator pick a
   *     different route than silently drop to `none`.
   */
  public pickModelForEffort(
    tier: TierLevel,
    requested: ReasoningEffort,
    healthyOnly = true,
  ): { model: ModelRegistration; actualEffort: ReasoningEffort; degraded: boolean } | null {
    if (requested === 'none') {
      // No thinking requested. Legacy pass-through (any model) UNLESS a
      // member rule maps `none` to a real level (e.g. none→high):
      // then the mapped candidates compete and the mapped level is served.
      const entries = this.tierPoolEntries(tier, healthyOnly);
      if (entries.some((e) => applyEffortMap(e.effortMap, 'none') !== 'none')) {
        const mapped = this.bestEffortMatch(entries, requested);
        if (mapped) return mapped;
      }
      const m = this.getModelForTier(tier, healthyOnly);
      if (m) return { model: m, actualEffort: 'none', degraded: false };
      return null;
    }

    // Pass 1: pick from the requested tier (each candidate is first translated
    // by ITS pool's effortMap, then capability-clamped — see bestEffortMatch).
    const tierPick = this.bestEffortMatch(this.tierPoolEntries(tier, healthyOnly), requested);
    if (tierPick) return tierPick;

    // Pass 2: cross-tier fallback — search all tiers in tier-rank order
    // (highest first) for any healthy thinking-capable model. Per design
    // decision 2026-10: cross-tier mixing is allowed; the actual model is
    // still reported in the response so the caller sees the truth.
    const tierOrder = TIER_DESCENDING_ORDER;
    for (const t of tierOrder) {
      if (t === tier) continue;
      const pick = this.bestEffortMatch(this.tierPoolEntries(t, healthyOnly), requested);
      if (pick) return pick;
    }
    return null;
  }

  /** Denylist- and health-filtered per-tier pool entries (see
   *  buildTierPoolEntries); the effortMap on each entry is the translation
   *  that applies when the model serves from THIS tier's pool. */
  private tierPoolEntries(tier: TierLevel, healthyOnly: boolean) {
    return this.buildTierPoolEntries(tier, this.committedMembers)
      .filter(({ model }) => !this.policyRejectionReason(this.tierPolicies, model))
      .filter(({ model }) => !healthyOnly || this.modelAvailable(model).available);
  }

  /**
   * Best candidate for `requested` under the translation contract:
   * each candidate is first TRANSLATED by its pool entry's effortMap, then
   * clamped by its declared capability (downgradeReasoning). Candidates whose
   * clamp yields `'none'` while the mapped target was a real level are
   * skipped — the honesty contract still forbids silently dropping requested
   * thinking. Ordering: smallest gap = rank(requested) − rank(actual) first (a
   * mapped-UP candidate has a negative gap and wins; a mapped-down one loses
   * to a native server); ties fall to pool order.
   */
  private bestEffortMatch(
    pool: { model: ModelRegistration; effortMap?: EffortMap }[],
    requested: ReasoningEffort,
  ): { model: ModelRegistration; actualEffort: ReasoningEffort; degraded: boolean } | null {
    const reqRank = EFFORT_LADDER.indexOf(requested);
    let best: { model: ModelRegistration; actualEffort: ReasoningEffort; gap: number } | null = null;
    for (const { model: m, effortMap } of pool) {
      const target = applyEffortMap(effortMap, requested);
      if (target === 'none') {
        // Explicit translation to none (or an unmapped `none` request):
        // serves without thinking. NOT skipped on requested !== 'none' —
        // mapping TO none is an explicit operator choice.
        const gap = reqRank;
        if (best === null || gap < best.gap) best = { model: m, actualEffort: 'none', gap };
        continue;
      }
      const supported = modelSupportsEfforts(m.supportedReasoningEfforts, m.supportsReasoningEffort);
      if (!supported) continue; // no explicit effort control → cannot serve a mapped level
      const actual = downgradeReasoning(target, supported);
      if (actual === 'none') continue; // capability can't reach any real level → skip
      const gap = reqRank - EFFORT_LADDER.indexOf(actual);
      if (best === null || gap < best.gap) {
        best = { model: m, actualEffort: actual, gap };
      }
    }
    if (!best) return null;
    return { model: best.model, actualEffort: best.actualEffort, degraded: best.gap > 0 };
  }

  public getModelForTier(tier: TierLevel, healthyOnly = true): ModelRegistration {
    const candidates = this.getCandidateModelsForTier(tier, healthyOnly);
    if (candidates.length > 0) {
      return this.pickPrimary(candidates, tier);
    }
    // If healthyOnly was true and no healthy models found, fallback to any model in tier
    if (healthyOnly) {
      const anyCandidate = this.getCandidateModelsForTier(tier, false);
      if (anyCandidate.length > 0) {
        return this.pickPrimary(anyCandidate, tier);
      }
    }
    // the requested tier is EMPTY (a real possibility now that there
    // is no residual catch-all). Degradation is still possible — routing must
    // not hard-fail on a config the user can legitimately write — but it is
    // NEVER silent: the cross-tier step is logged with the reason.
    const escalate = (this.tierPolicies ? loadConfig().fallback?.escalateTier : undefined) ?? 'plus';
    const order: TierLevel[] = [escalate, 'plus', 'lite', 'pro', 'ultra'];
    const chain = order.filter((t, i, all) => t !== tier && all.indexOf(t) === i);
    for (const step of chain) {
      const rep = this.tierDefaults.get(step);
      if (rep && !rep.unclassified) {
        console.warn(`[Registry] Tier '${tier}' has no candidate model — falling back to '${step}' (${rep.id}), reason=empty-pool`);
        return rep;
      }
    }
    const any = Array.from(this.models.values()).find((m) => !m.unclassified);
    if (!any) {
      throw new Error(`No routable models registered (every model is unclassified or excluded).`);
    }
    console.warn(`[Registry] Tier '${tier}' has no candidate model — falling back to the first registered model (${any.id}), reason=empty-pool`);
    return any;
  }

  public getAllModels(): ModelRegistration[] {
    return Array.from(this.models.values());
  }

  // ─── Model variants (sibling ids) ───────────────────────────────────────

  /**
   * Maintain the sibling-id index for a (re)registered model:
   *  - a REAL registered model id always beats a sibling id (registering
   *    `base-low` as a model drops the `base-low` sibling mapping);
   *  - re-registration replaces the model's previous sibling set;
   *  - sibling ids shadowed by models / reserved virtual ids are skipped.
   */
  private indexVariants(model: ModelRegistration): void {
    if (this.variantIndex.has(model.id)) {
      console.warn(`[Registry] Model id '${model.id}' shadows a variant sibling id — the sibling mapping was dropped.`);
      this.variantIndex.delete(model.id);
    }
    for (const [siblingId, ref] of this.variantIndex) {
      if (ref.baseId === model.id) this.variantIndex.delete(siblingId);
    }
    for (const variant of model.variants || []) {
      const siblingId = `${model.id}-${variant.id}`;
      if (
        this.models.has(siblingId) ||
        this.variantIndex.has(siblingId) ||
        RESERVED_COMBO_IDS.has(siblingId)
      ) {
        continue;
      }
      this.variantIndex.set(siblingId, { baseId: model.id, variant });
    }
  }

  /**
   * Resolve a variant reference to its base model + variant:
   *  - sibling id form `<baseId>-<variantId>` (as advertised by /v1/models);
   *  - explicit syntax form `<baseId>#<variantId>`.
   * Callers check exact registered models FIRST — a real id always wins.
   * Returns null when nothing matches; the caller decides whether that means
   * a hard error (`#` syntax must not silently degrade) or plain classifier
   * fallback (unregistered names keep the existing contract).
   */
  public resolveVariantRef(modelId: string): { base: ModelRegistration; variant: ModelVariant } | null {
    if (!modelId) return null;
    // A user-authored combo id keeps its own semantics on collision.
    if (this.combos.has(modelId)) return null;
    const sibling = this.variantIndex.get(modelId);
    if (sibling) {
      const base = this.models.get(sibling.baseId);
      if (base) return { base, variant: sibling.variant };
    }
    const hash = modelId.indexOf('#');
    if (hash > 0 && hash < modelId.length - 1) {
      const base = this.models.get(modelId.slice(0, hash));
      const variant = base?.variants?.find((v) => v.id === modelId.slice(hash + 1));
      if (base && variant) return { base, variant };
    }
    return null;
  }

  /** Variant sibling entries advertised by /v1/models (shadowed ids excluded). */
  public getVariantExposures(): { id: string; base: ModelRegistration; variant: ModelVariant }[] {
    const out: { id: string; base: ModelRegistration; variant: ModelVariant }[] = [];
    for (const [id, ref] of this.variantIndex) {
      const base = this.models.get(ref.baseId);
      if (!base) continue;
      if (this.combos.has(id)) continue;
      out.push({ id, base, variant: ref.variant });
    }
    return out;
  }

  // ─── Custom model combos ────────────────────────────────────────────────

  /** (Re)register combo definitions — used at boot and for hot-apply on console config saves. */
  public applyCombos(combos?: ComboConfig[]): void {
    this.combos.clear();
    this.comboRrCursor.clear();
    for (const combo of combos || []) {
      if (!combo?.id || !Array.isArray(combo.models) || combo.models.length === 0) continue;
      if (RESERVED_COMBO_IDS.has(combo.id)) {
        console.warn(`[Registry] Combo id '${combo.id}' is a reserved virtual model name — combo ignored.`);
        continue;
      }
      if (this.models.has(combo.id)) {
        console.warn(`[Registry] Combo id '${combo.id}' collides with a registered model id — combo ignored.`);
        continue;
      }
      this.combos.set(combo.id, combo);
    }
  }

  public isCombo(modelId: string): boolean {
    return this.combos.has(modelId);
  }

  public getCombos(): ComboConfig[] {
    // Disabled combos stay registered (so the request path can reject them by
    // id) but never surface in catalogs — clients cannot select what the
    // gateway will not serve.
    // A model registered AFTER a combo (setDefaultTierModel / console flows)
    // shadows the combo id — exclude those from exposure so /v1/models never
    // lists a duplicate id that cannot route.
    return Array.from(this.combos.values()).filter(c => c.disabled !== true && !this.models.has(c.id));
  }

  /** True when the combo is registered but operator-disabled. */
  public isComboDisabled(modelId: string): boolean {
    return this.combos.get(modelId)?.disabled === true;
  }

  /** Normalize a member entry (bare string | {id, weight}) to {id, weight>=1}. */
  private comboMemberRef(entry: string | ComboModelRef): { id: string; weight: number } {
    if (typeof entry === 'string') return { id: entry, weight: 1 };
    return { id: entry.id, weight: Math.max(1, Number(entry.weight) || 1) };
  }

  /**
   * Resolve a combo to its registered member models in config order.
   * Unregistered ids are dropped and duplicates collapse to the first
   * occurrence — resolved per call so late registrations join naturally.
   */
  public resolveCombo(comboId: string): ModelRegistration[] {
    const combo = this.combos.get(comboId);
    if (!combo) return [];
    const seen = new Set<string>();
    const members: ModelRegistration[] = [];
    for (const entry of combo.models) {
      const ref = this.comboMemberRef(entry);
      if (seen.has(ref.id)) continue;
      const model = this.models.get(ref.id);
      if (model) {
        members.push(model);
        seen.add(ref.id);
      }
    }
    return members;
  }

  /**
   * Combo primary pick, mirroring the tier selection strategies:
   * - priority (default): first healthy member in config order
   * - weighted: weight-random draw over the healthy pool
   * - round_robin: rotating weighted slots (combo-scoped cursor)
   * Falls back to the full member list when every member is tripped.
   */
  public pickComboLeader(comboId: string, members: ModelRegistration[]): ModelRegistration {
    if (members.length <= 1) return members[0];
    const strategy = this.combos.get(comboId)?.selection ?? 'priority';
    // Decision 6 aggregate (same rule as the tier pools): a member whose every
    // credential is out must not lead a combo.
    const healthy = members.filter((m) => this.modelAvailable(m).available);
    const pool = healthy.length > 0 ? healthy : members;
    const weights = new Map<string, number>();
    for (const entry of this.combos.get(comboId)?.models || []) {
      const ref = this.comboMemberRef(entry);
      if (!weights.has(ref.id)) weights.set(ref.id, ref.weight);
    }

    if (strategy === 'round_robin') {
      const slots: ModelRegistration[] = [];
      for (const m of pool) {
        const w = weights.get(m.id) ?? 1;
        for (let i = 0; i < w; i++) slots.push(m);
      }
      if (slots.length === 0) return pool[0];
      const prev = this.comboRrCursor.get(comboId) ?? 0;
      this.comboRrCursor.set(comboId, prev + 1);
      return slots[prev % slots.length];
    }

    if (strategy === 'weighted') {
      const ws = pool.map(m => weights.get(m.id) ?? 1);
      const total = ws.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < pool.length; i++) {
        r -= ws[i];
        if (r < 0) return pool[i];
      }
      return pool[pool.length - 1];
    }

    return pool[0];
  }

  /**
   * Introspection for the console resolve a tier's effective
   * candidate pool from the member lists + the global denylist. A PURE
   * projection over (model id × tiers.members) — `policiesOverride` carries
   * freshly-edited form state for previews without committing; runtime
   * callers omit it and get the construction-time snapshot. Pool order =
   * rule weight (desc) then member-list order; entries carry the claiming
   * rule's weight (default 1). `unclassified` is the diagnostic fourth state:
   * models claimed by NO tier (it is never hidden by the denylist — the
   * console must show it for the unpooled view / one-click join).
   */
  public resolveTierPool(
    tier: PoolMembership,
    policiesOverride?: TiersConfig,
  ): {
    pool: { model: ModelRegistration; weight: number }[];
    excluded: { id: string; reason: string }[];
  } {
    const policies = policiesOverride ?? this.tierPolicies;
    // Preview (override) re-derives from the DRAFT; the committed view reads
    // exactly what reclassifyTiers last committed.
    const members = policiesOverride ? this.expandedMemberRules(policiesOverride).tiers : this.committedMembers;
    if (tier === 'unclassified') {
      const pool: { model: ModelRegistration; weight: number }[] = [];
      for (const m of this.models.values()) {
        if (!m.tierMatch) {
          // Hand-configured model: unclassified exactly when registered so.
          if (m.unclassified) pool.push({ model: m, weight: 1 });
          continue;
        }
        if (claimModel(m.id, members) === 'unclassified') pool.push({ model: m, weight: 1 });
      }
      return { pool, excluded: [] };
    }
    const pool: { model: ModelRegistration; weight: number }[] = [];
    const excluded: { id: string; reason: string }[] = [];
    for (const entry of this.buildTierPoolEntries(tier, members)) {
      const reason = this.policyRejectionReason(policies, entry.model);
      if (reason) excluded.push({ id: entry.model.id, reason });
      else pool.push({ model: entry.model, weight: entry.weight });
    }
    return { pool, excluded };
  }

  /**
   * Execute one completion. `credentialKeyHashPrefix` 
   * selects one credential of the provider's registered chain by its Decision 5
   * identity; omitted = the boot-baked default (executor `config.apiKey`).
   * On failure the thrown error is re-raised UNCHANGED in class/shape with the
   * used credential's display-safe prefix stamped on `usedCredentialKeyHashPrefix`
   * when a chain is registered — the attribution seam for the P3 pair-level
   * breaker work (no classification changes here).
   */
  public async execute(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credentialKeyHashPrefix?: string,
    /**
       * Progressive-output relay. Present = the caller is able to forward
       * chunks to the client as they arrive; the registry still returns ONE
       * complete `ChatCompletionResponse` (accumulated from the chunks), so
       * every post-turn consumer — breaker, FinOps, rate ledger, trace, session
       * registration — keeps reading a buffered object and is untouched by
       * streaming. Absent, or a wire with no streaming executor, or mock mode =
       * the existing buffered call, byte-for-byte as before.
       */
    relay?: StreamRelay
  ): Promise<ChatCompletionResponse> {
    if (this.mockMode) {
      return this.mockExecute(request, model);
    }

    const provider = this.providers.get(model.provider);
    if (!provider) {
      throw new Error(`Provider '${model.provider}' not found for model '${model.id}'`);
    }

    const chain = this.credentialChains.get(model.provider);
    let credential: CallCredential | undefined;
    if (credentialKeyHashPrefix !== undefined) {
      credential = chain?.find((c) => c.keyHashPrefix === credentialKeyHashPrefix);
      if (!credential) {
        // Loud fail (cp-failfast): a selector matching no chain entry means the
        // caller routes on credential state that is stale w.r.t. this boot's pool
        // — silently serving the baked key would hide exactly the drift the
        // keyHash anchor exists to catch.
        throw new Error(
          `Unknown credential selector '${credentialKeyHashPrefix}' for provider '${model.provider}'`
        );
      }
    }

    try {
      if (relay) {
        const streams = provider.supportsStreaming
          ? provider.supportsStreaming(model)
          : typeof provider.createStream === 'function';
        if (streams) {
          const accumulate = createChunkAccumulator();
          const stream = await provider.createStream!(request, model, upstreamEventContext, credential);
          // Drained to the end even when the client has gone away: the turn's
          // usage frame arrives only with the last chunk, and an abort-triggered
          // accounting hole would let a client dodge token rate limits by
          // cancelling repeatedly.
          for await (const chunk of stream) {
            accumulate.push(chunk);
            relay.onChunk(chunk);
          }
          return accumulate.finish();
        }
        // No streaming executor for this wire — fall through to the buffered
        // call. Legal precisely because nothing has been forwarded yet: a relay
        // that has committed bytes can never take this path (createStream would
        // have been reached first, and its failure surfaces as an error).
      }
      return await provider.createCompletion(request, model, upstreamEventContext, credential);
    } catch (err) {
      // Attribution stamp: selector hit → that credential; no selector → the chain
      // head, which IS the baked key boot executed with (registry invariant).
      const used = credential ?? chain?.[0];
      if (used && err && (typeof err === 'object' || typeof err === 'function')) {
        (err as { usedCredentialKeyHashPrefix?: string }).usedCredentialKeyHashPrefix = used.keyHashPrefix;
      }
      throw err;
    }
  }

  /**
   * High-fidelity mock executor for automated testing & offline demos
   */
  private async mockExecute(
    request: ChatCompletionRequest,
    model: ModelRegistration
  ): Promise<ChatCompletionResponse> {
    const reqAny = request as any;
    if (reqAny.__simulate_error_model__ === model.id || reqAny.__simulate_error_all__) {
      let shouldThrow = true;
      if (typeof reqAny.__simulate_fail_times__ === 'number') {
        if (reqAny.__simulate_fail_times__ > 0) {
          reqAny.__simulate_fail_times__--;
          shouldThrow = true;
        } else {
          shouldThrow = false;
        }
      }

      if (shouldThrow) {
        const status = reqAny.__simulate_status__ || 503;
        const errorMsg = reqAny.__simulate_message__ || `Simulated error for model ${model.id} (Status ${status})`;
        throw new UpstreamError({
          message: errorMsg,
          status,
          errorBody: JSON.stringify({ error: { message: errorMsg, code: reqAny.__simulate_code__ } }),
          provider: model.provider,
          modelId: model.id,
          retryAfterSeconds: reqAny.__simulate_retry_after__,
        });
      }
    }

    const isJsonRequested =
      request.response_format?.type === 'json_object' ||
      request.response_format?.type === 'json_schema' ||
      /json/i.test(JSON.stringify(request.messages));

    let content = 'This is a standard mock response from ' + model.id;

    if (isJsonRequested) {
      // Simulate lite tier occasionally returning slightly malformed JSON or valid JSON
      if (model.tier === 'lite' && (request as any).__simulate_malformed__) {
        content = '{ "name": "sample", "invalid_json_trailing": ';
      } else {
        content = JSON.stringify({
          status: 'success',
          tier: model.tier,
          model: model.id,
          data: {
            title: 'Mock Structured Output',
            category: 'test',
          },
        });
      }
    }

    return {
      id: `mock-chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 150,
        completion_tokens: 80,
        total_tokens: 230,
        prompt_tokens_details: {
          cached_tokens: 50,
        },
      },
    };
  }
}
