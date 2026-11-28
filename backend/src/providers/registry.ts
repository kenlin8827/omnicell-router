import { LLMProvider, type UpstreamEventContext, type CallCredential } from './base.js';
import { pickDialWire } from './dial-wire.js';
import { OpenAIChatProvider } from './executors/openai-chat.js';
import { AnthropicMessagesProvider } from './executors/anthropic-messages.js';
import { OpenAIResponsesProvider } from './executors/openai-responses.js';
import { GoogleGeminiProvider } from './executors/google-gemini.js';
import { getModelServicePlugin } from '../plugins/host.js';
import { ModelRegistration, ModelVariant, ProviderConfig, RouterConfig, TiersConfig, TierMemberRule, ComboConfig, ComboModelRef } from '../config/types.js';
import { PoolMembership, ReasoningEffort, TierLevel, EFFORT_LADDER, downgradeReasoning, modelSupportsEfforts, type EffortMap } from '../types/router.js';
import type { CanonicalRequest, CanonicalResponse } from '../ir/types.js';
import { IrUnsupportedError } from '../ir/errors.js';
import { withDialContext } from '../ir/validate.js';
import { createEventAccumulator } from '../ir/stream.js';
import { createToolMarkupScanner, detectToolMarkupLeak, type ToolMarkupLeak } from './compat/tool-markup-leak.js';
import { createToolMarkupStreamRecovery, recoverToolMarkupInResponse, toolMarkupRecoveryFor } from './compat/tool-markup-recovery.js';
import { recordFailureEvent } from '../observability/failure-events.js';
import type { StreamRelay } from '../utils/stream-relay.js';
import { createPluginProvider } from './executors/plugin-adapter.js';
import { isPluginWire } from './plugin-wires.js';
import { canonicalProtocol } from './protocol.js';
import { CircuitBreakerManager, UpstreamError, type ModelAvailability, type ModelHealthView } from '../resilience/index.js';
import { globMatchAny } from '../utils/glob.js';
import { loadConfig } from '../config/index.js';
import { redactProxyUrl, resolveProxyUrl } from '../utils/proxy.js';
import { resolveTierMembers, claimModel, claimInTier, matchingTiers, applyEffortMap, markExactFullIds, MEMBER_TIER_ORDER, TIER_DESCENDING_ORDER, comboMemberRefsOf, expandComboRefs, RESERVED_IDS, type ExpandedMembers } from './member-match.js';
import { WeightedRoundRobin, normalizeSelectionStrategy, normalizeMemberWeight, type SelectionStrategy } from './selection.js';

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

/**
 * One line at the observation join point. Residual markup is an UPSTREAM defect
 * the operator has to act on (wrong endpoint, or a relay whose tool-call parser
 * is off), so it belongs in the failure ledger. Validated recovered calls have
 * their own response marker; this row fires only for markup left unrecovered.
 */
function reportToolMarkupLeak(leak: ToolMarkupLeak | null, model: ModelRegistration): void {
  if (!leak) return;
  recordFailureEvent({
    model: model.id,
    provider: model.provider,
    errorClass: 'UNKNOWN',
    role: 'serving',
    message:
      `upstream returned ${leak.calls} tool-call block(s) as TEXT — the endpoint is not ` +
      'converting its own tool-call format; point the provider at an API that parses it',
  });
}

/**
 * Outbound egress of ONE dial attempt (ADR-0018 vocabulary): straight out of
 * the machine, or through the operator's outbound proxy (ADR-0022), whose
 * redacted endpoint rides along. Absent = unknown — never read as direct.
 */
export type AttemptEgress = { mode: 'direct' } | { mode: 'proxy'; origin: string };

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
  /** Smooth weighted round-robin cursors — one per tier pool. */
  private tierRr = new WeightedRoundRobin();
  private combos = new Map<string, ComboConfig>();
  /** Smooth weighted round-robin cursors — one per combo pool. */
  private comboRr = new WeightedRoundRobin();
  /** Fingerprint of the combo section last applied by applyCombos — lets the
   *  lazy hand-edit safety net skip no-op replays instead of resetting
   *  round-robin cursors and re-logging skip warnings every TTL window. */
  private combosFingerprint = '';
  /** Raw configs for every configured provider (all types) — lets the
   *  /v1/systemone route reach provider baseUrl/apiKey (this map is the
   *  credential/config source for chat providers registered outside the
   *  constructor). */
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
   * selection priority (active head first); default credential = the boot-baked
   * `config.apiKey` (inline-precedence case included — boot prepends it).
   */
  private credentialChains = new Map<string, CallCredential[]>();
  private mockMode = false;
  private autoRefreshMembers = true;
  private lastMembersRefreshAt = 0;

  constructor(config: RouterConfig, mockMode = false, providerConfigs: ProviderConfig[] = []) {
    this.mockMode = mockMode;
    this.tierPolicies = config.tiers || {};
    // The breaker rules resolver borrows trip.rateLimit.hardTripAboveMs's
    // default from retry.inplace.maxRateLimitWaitMs (spec: the breaker-side
    // copy never rewrites the retry-side in-place-retry decision).
    this.circuitBreakerManager = new CircuitBreakerManager(config.circuitBreaker, Date.now, undefined, config.retry);

    // Chat providers materialize exclusively from the provider-defs file +
    // CredentialStore (ADR-0005/0010) and enter via `registerProvider`; tests
    // may hand extra configs through the third constructor parameter.
    for (const pConfig of providerConfigs) {
      const wire = canonicalProtocol(pConfig.type);
      this.providerConfigs.set(pConfig.name, pConfig);
      this.providerHosts.set(pConfig.name, hostOfBaseUrl(pConfig.baseUrl));
      if (wire === 'anthropic-messages') {
        this.providers.set(pConfig.name, new AnthropicMessagesProvider(pConfig));
      } else if (wire === 'openai-responses') {
        this.providers.set(pConfig.name, new OpenAIResponsesProvider(pConfig));
      } else if (wire === 'google-gemini') {
        this.providers.set(pConfig.name, new GoogleGeminiProvider(pConfig));
      } else if (wire === 'openai-chat') {
        this.providers.set(pConfig.name, new OpenAIChatProvider(pConfig));
      } else if (wire === 'systemone') {
        // Decision-wire providers have NO chat executor (ADR-0008 §7) — the
        // native decision limb calls them through protocols/systemone/native.ts.
        // Register a placeholder that fails any chat dispatch honestly.
        this.providers.set(pConfig.name, {
          name: pConfig.name,
          createCompletion: async () => {
            throw new Error(
              `Provider '${pConfig.name}' is on the System One decision wire — it serves /v1/systemone natively and cannot answer chat completions`
            );
          },
        });
      } else {
        // Beyond the core wires above, the protocol belongs to a PLUGIN. The
        // plugin host is the authority on which wires exist, so the decision
        // ASKS it — a core branch naming a vendor protocol would silently
        // mis-route every protocol it does not name.
        const plugin = getModelServicePlugin(wire);
        if (plugin) {
          this.providers.set(pConfig.name, createPluginProvider(plugin, pConfig));
        } else if (isPluginWire(wire)) {
          // Plugin protocol with no executor: keep the provider addressable and
          // fail honestly, so the console can point at /plugins instead of the
          // request dying against the wrong upstream.
          this.providers.set(pConfig.name, {
            name: pConfig.name,
            createCompletion: async () => {
              throw new Error(`Provider '${pConfig.name}' is on the ${wire} wire but the ${wire} plugin is not installed (console /plugins)`);
            },
          });
        } else {
          this.providers.set(pConfig.name, new OpenAIChatProvider(pConfig));
        }
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

  public registerProvider(
    name: string,
    provider: LLMProvider,
    credentialChain?: CallCredential[],
    /** Boot config for the provider (baseUrl/headers/…). Required for wires
     *  whose executors read provider config at CALL time — the native System
     *  One decision limb reads baseUrl + custom headers from here. Chat-wire
     *  executors bake their config into the LLMProvider instance, so for them
     *  this is informational (still recorded for the host index). */
    config?: ProviderConfig
  ): void {
    this.providers.set(name, provider);
    if (credentialChain?.length) this.credentialChains.set(name, credentialChain);
    if (config) {
      this.providerConfigs.set(name, config);
      this.providerHosts.set(name, hostOfBaseUrl(config.baseUrl));
    }
  }

  /**
   * Hot credential-chain refresh — the runtime twin of the boot-baked chain.
   * Credential-store mutations (console connect/disconnect/activate, credential
   * sync) call this so `getCredentialChain` reflects the store WITHOUT a
   * gateway restart. A non-empty chain replaces the entry wholesale (callers
   * snapshot the array they hold; in-flight requests keep serving on the old
   * reference — the Map swap is atomic under Bun's single thread). An EMPTY
   * chain deletes the entry: the provider degenerates to the pre-P3 head-baked
   * path (`config.apiKey`), which matches boot's head === baked-key invariant.
   * RAW KEYS IN MEMORY ONLY — same contract as `registerProvider`; never
   * serialize into a console/API surface.
   */
  public refreshCredentialChain(name: string, chain: readonly CallCredential[]): void {
    if (chain.length) this.credentialChains.set(name, [...chain]);
    else this.credentialChains.delete(name);
  }

  public registerModel(model: ModelRegistration, isDefault = false): void {
    if (RESERVED_IDS.has(model.id)) {
      console.warn(`[Registry] Model id '${model.id}' is a reserved virtual model name — registration ignored.`);
      return;
    }
    if (this.combos.has(model.id)) {
      console.warn(`[Registry] Model id '${model.id}' shadows an existing combo id — the combo became unreachable.`);
    }
    this.models.set(model.id, model);
    this.circuitBreakerManager.registerModel(model);
    this.indexVariants(model);
    // an UNCLAIMED model (no home tier) must never become a tier's
    // representative — it joins no pool, so promoting it would hand routing a
    // model the pools themselves filter out. Explicit `isDefault` pinning stays
    // authoritative.
    if (model.tier === undefined && !isDefault) return;
    const home = model.tier;
    if (home !== undefined && (isDefault || !this.tierDefaults.has(home))) {
      this.tierDefaults.set(home, model);
    }
  }

  public getCircuitBreakerManager(): CircuitBreakerManager {
    return this.circuitBreakerManager;
  }

  /**
   * Aggregate model availability across its credential chain:
   * the chain's credential prefixes feed `modelAvailability`, so a model whose
   * credentials are ALL tuple-OPEN/SUSPECT reads as unavailable. A model-scope
   * trip lands on every tuple, so the aggregate reads it as every prefix open.
   * Chain-less providers (config.yaml boot) pass an empty prefix list and the
   * aggregate degenerates to the sentinel-tuple check.
   */
  public modelAvailable(model: ModelRegistration): ModelAvailability {
    const chain = this.credentialChains.get(model.provider);
    const prefixes = chain?.map((c) => c.keyHashPrefix) ?? [];
    return this.circuitBreakerManager.modelAvailability(model.id, prefixes);
  }

  /**
   * Hot pool sync (provider-def saves / connect / disconnect): reconcile the
   * boot-built registry with a freshly built direct pool WITHOUT a restart —
   * the model-set analogue of `refreshCredentialChain`. Providers and chains
   * swap wholesale; models reconcile IN PLACE (existing registration objects
   * mutate, so session pins and in-flight references stay valid; removed ids
   * retire with their breaker tuples); the tier/combos view re-commits
   * afterwards. The variant index rebuilds via registerModel/indexVariants.
   */
  public applyDirectPool(
    instances: {
      name: string;
      provider: LLMProvider;
      config: ProviderConfig;
      credentialChain?: CallCredential[];
    }[],
    models: ModelRegistration[]
  ): void {
    if (this.mockMode) return;
    const keep = new Set(instances.map((i) => i.name));
    for (const name of Array.from(this.providers.keys())) {
      if (!keep.has(name)) {
        this.providers.delete(name);
        this.credentialChains.delete(name);
        this.providerConfigs.delete(name);
        this.providerHosts.delete(name);
      }
    }
    for (const inst of instances) {
      // registerProvider only WRITES a chain when non-empty — a kept provider
      // whose fresh chain is empty must not keep its old (dead) keys routable.
      if (!inst.credentialChain || inst.credentialChain.length === 0) this.credentialChains.delete(inst.name);
      this.registerProvider(inst.name, inst.provider, inst.credentialChain, inst.config);
    }
    const nextIds = new Set(models.map((m) => m.id));
    for (const id of Array.from(this.models.keys())) {
      if (!nextIds.has(id)) this.retireModel(id);
    }
    for (const m of models) {
      const existing = this.models.get(m.id);
      if (existing) {
        // Replace-in-place, NOT Object.assign: a fresh record that OMITS a
        // provenance/capability key must not leave the old value routable.
        // Boot emits EITHER configTier OR autoTier, and reasoningDisableable /
        // pricing only when the vendor states them — Object.assign would keep
        // a stale autoTier (silently re-claiming a freshly pinned model), a
        // stale always-think fact, or a stale price forever after the source
        // changed. Identity is preserved (the Map entry and any held reference
        // stay valid) while absent keys are reset.
        for (const key of Object.keys(existing)) {
          if (!(key in m)) delete (existing as unknown as Record<string, unknown>)[key];
        }
        Object.assign(existing, m);
        this.indexVariants(existing);
      } else {
        this.registerModel(m, m.isDefaultInTier);
      }
    }
    // Re-commit the tier/combos view over the reconciled model set
    // (representatives and pools included).
    this.applyTierConfigNow();
    this.applyCombos(loadConfig().combos);
  }

  private retireModel(id: string): void {
    this.models.delete(id);
    for (const [tier, m] of Array.from(this.tierDefaults)) {
      if (m.id === id) this.tierDefaults.delete(tier);
    }
    for (const [siblingId, ref] of Array.from(this.variantIndex)) {
      if (ref.baseId === id) this.variantIndex.delete(siblingId);
    }
    this.circuitBreakerManager.dropModel(id);
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
    // Unpriced models sort last: an unknown price cannot claim to be the
    // cheapest, and `Infinity` keeps that ordering without inventing a number.
    const byPrice = (a: ModelRegistration, b: ModelRegistration) =>
      (a.pricing?.input ?? Infinity) - (b.pricing?.input ?? Infinity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const host = normalizeHostHeader(upstreamHost);
    if (host) {
      const scoped = hits.filter((m) => this.providerHosts.get(m.provider) === host);
      if (scoped.length > 0) return scoped.sort(byPrice);
    }
    return hits.sort(byPrice);
  }

  /** Raw provider config (any type) — used for provider baseUrl/apiKey
   *  lookup (e.g. boot-time provider registration). */
  public getProviderConfig(name: string): ProviderConfig | undefined {
    return this.providerConfigs.get(name);
  }

  /**
   * The provider's ordered credential chain (selection
   * priority order), or undefined when no chain was registered (mock/stub call
   * sites) — callers then use the baked config key.
   * Raw keys: in-process consumers only, never serialize.
   */
  public getCredentialChain(name: string): CallCredential[] | undefined {
    return this.credentialChains.get(name);
  }

  /**
   * Active credential (default credential = the boot-baked key). Providers without a
   * registered chain return undefined — behavior identical to reading
   * `getProviderConfig(name).apiKey` directly (single-key degeneracy).
   */
  public getActiveCredential(name: string): CallCredential | undefined {
    return this.credentialChains.get(name)?.[0];
  }

  /**
   * Why a model is rejected from every pool ('' = allowed). The ONLY pool
   * filter: the GLOBAL denylist (tiers.exclude) — unconditional, it outranks
   * even an explicit pin.
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
    return claim ? normalizeMemberWeight(claim.rule.weight) : 1;
  }

  /** Effective selection strategy: explicit config wins, default priority. */
  private selectionStrategy(tier: TierLevel): SelectionStrategy {
    return normalizeSelectionStrategy(this.tierPolicies?.[tier]?.selection);
  }

  /**
   * Primary pick inside a tier, driven by the tier's selection strategy:
   * - priority (default): first healthy candidate in chain order (= member
   *   list order)
   * - weighted_round_robin: smooth WEIGHTED round-robin — weight = the
   *   claiming member rule's weight (default 1), served in proportion, evenly
   *   interleaved
   * - round_robin: plain sequential round-robin — equal turns, weights ignored
   * `weighted_round_robin` and `round_robin` share ONE smooth round-robin core
   * (combos use it too); only the weight policy differs.
   * The failover chain order is strategy-independent (buildTierPoolEntries:
   * rule weight desc, then rule list order).
   */
  private pickPrimary(models: ModelRegistration[], tier: TierLevel): ModelRegistration {
    const strategy = this.selectionStrategy(tier);
    // `priority` never touches a cursor. The rotation strategies ALWAYS go
    // through the core — including a single-member pool, whose identity check
    // resets a stale vector after a shrink (a short-circuit here would strand
    // credit accumulated before it).
    if (strategy === 'priority') return models[0];
    const weightOf = strategy === 'weighted_round_robin' ? (m: ModelRegistration) => this.weightFor(tier, m.id) : () => 1;
    return this.tierRr.pick(`${tier}:${strategy}`, models, (m) => m.id, weightOf);
  }

  /**
   * Strategy-aware leader over an ALREADY-FILTERED candidate list. `getModelForTier`
   * assembles the pool (health, denylist, cross-tier fallback) and then picks;
   * this is the pure pick for a chain whose pool was filtered elsewhere
   * (model access, widening) — the serving chain must lead with this model.
   */
  public pickLeader(tier: TierLevel, candidates: ModelRegistration[]): ModelRegistration {
    return this.pickPrimary(candidates, tier);
  }

  /**
   * Chain order for a ready candidate list: the strategy-selected leader first,
   * then the remaining members in their existing order. `priority` leaves the
   * list untouched (its head already leads); only the rotation strategies
   * reorder, and the failover walk after the head is unchanged.
   */
  public orderChain(tier: TierLevel, candidates: ModelRegistration[]): ModelRegistration[] {
    if (candidates.length === 0) return candidates;
    const leader = this.pickPrimary(candidates, tier);
    return [leader, ...candidates.filter((m) => m.id !== leader.id)];
  }

  /**
   * Per-tier pool construction — the ONE membership read for a single tier.
   * Membership is a PER-TIER projection of the member lists: every rule in
   * THIS tier's list claims models independently of the other tiers, so a
   * model (or a combo's expanded members) may join several pools at once.
   * Hand-configured models (no autoTier stamp) never move: their explicit
   * tier is permanent. They join exactly their explicit tier, with weight
   * from this tier's matching rule when one exists (default 1). Chain order =
   * claiming-rule weight
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
      if (!m.autoTier) {
        // Hand-configured model: explicit tier, member rules never move it.
        if (m.tier !== tier) continue;
        const claim = claimInTier(tier, m.id, members);
        entries.push({
          model: m,
          weight: claim ? normalizeMemberWeight(claim.rule.weight) : 1,
          effortMap: m.effortMap,
          rank: m.isDefaultInTier ? 0 : m.priority ?? 10,
        });
        continue;
      }
      const claim = claimInTier(tier, m.id, members);
      if (!claim) continue;
      entries.push({
        model: m,
        weight: normalizeMemberWeight(claim.rule.weight),
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
   * Hand-configured models keep their stored translation; a model absent from
   * this tier (escalation-tail resolution) falls back to the stored home-tier
   * translation.
   */
  public effortMapFor(model: ModelRegistration, tier: TierLevel): EffortMap | undefined {
    if (!model.autoTier) return model.effortMap;
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
    if (!model.autoTier) return model.tier === undefined ? [] : [model.tier];
    return matchingTiers(model.id, this.committedMembers);
  }

  /**
   * Runtime tier membership replay — membership is pure file-derived data
   * (config `tiers[t].members`), replayed against each model id on
   * pool resolution instead of waiting for a gateway restart. Model UNIVERSE
   * (providers/credentials/wire) stays a boot snapshot.
   */

  /** Hot-path guard: replay member lists + the combo map + policies at most every 2 seconds. */
  private maybeRefreshMembers(): void {
    if (!this.autoRefreshMembers) return;
    const now = Date.now();
    if (now - this.lastMembersRefreshAt < 2000) return;
    this.lastMembersRefreshAt = now;
    try {
      const fresh = loadConfig();
      // Combos share the hand-edited-YAML safety net: a combo write that
      // bypasses the console save paths (hand edit, direct saveConfig
      // callers) must not stay invisible to routing until the next save
      // event. Applied BEFORE the tier replay — combo-ref expansion reads
      // the combo map. Mock mode excepted: hermetic registries never couple
      // to disk. applyCombos self-skips on an unchanged section.
      if (!this.mockMode) this.applyCombos(fresh.combos);
      const tiers = fresh.tiers || {};
      this.tierPolicies = tiers; // the global denylist lives here too
      this.reclassifyTiers(this.expandedMemberRules(tiers).tiers);
    } catch {
      // transient config/IO error — keep the current membership
    }
  }

  /** Latest committed `tiers` config (snapshot; updated by applyTierConfigNow / maybeRefreshMembers). */
  public getTierPolicies(): TiersConfig {
    return this.tierPolicies;
  }

  /** Test hook: silence the lazy config re-read (explicit reclassifyTiers still works). */
  public setAutoRefreshMembers(on: boolean): void {
    this.autoRefreshMembers = on;
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
   * expanded in place and hand-written FULL ids pinned exact. Every membership
   * consumer (claims, weights, pools, boot, save checks) must read through this
   * so pools stay physical-model lists while config keeps the operator's
   * declared references. Exact pinning is a PROJECTION concern, not a config
   * write: the stored `tiers` keeps the operator's plain pattern.
   */
  public expandedMemberRules(policies: TiersConfig | undefined): ExpandedMembers {
    const expanded = expandComboRefs(resolveTierMembers(policies).tiers, (id) => this.comboMemberRefs(id));
    const registered = new Set<string>();
    for (const id of this.models.keys()) registered.add(id.toLowerCase());
    return { dead: expanded.dead, tiers: markExactFullIds(expanded.tiers, (id) => registered.has(id.toLowerCase())) };
  }

  /**
   * COMMIT path — the only one that rewrites live pool membership. Called on
   * every config-save event (console routes) so edits take effect immediately;
   * the lazy maybeRefreshMembers replay (tiers AND combos) remains only as
   * the out-of-band (hand-edited YAML) safety net.
   */
  public applyTierConfigNow(): void {
    if (this.mockMode) return;
    const tiers = loadConfig().tiers || {};
    this.tierPolicies = tiers;
    this.lastMembersRefreshAt = Date.now(); // the file was just read — skip the TTL replay
    this.reclassifyTiers(this.expandedMemberRules(tiers).tiers);
  }

  /** Replays the member lists over every stamped model and stores
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
      if (!m.autoTier) continue; // hand-configured: never moved
      const home = claimModel(m.id, members);
      if (home === 'unclassified') {
        m.tier = undefined;
        m.isDefaultInTier = false;
        delete m.effortMap;
        continue;
      }
      m.tier = home.tier;
      m.priority = home.index + 1; // home list order (derived view)
      m.isDefaultInTier = home.index === 0; // the home list leader
      if (home.rule.effortMap) m.effortMap = home.rule.effortMap;
      else delete m.effortMap;
    }
    // Representatives = leading model of each tier's per-tier pool (weight desc,
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
   * (tiers.exclude) is applied first; models no member list claims (no home
   * tier) join no pool. Membership is the per-tier projection
   * (buildTierPoolEntries) — a model may serve in several tiers at once.
   */
  public getCandidateModelsForTier(
    tier: TierLevel,
    healthyOnly = true,
    opts?: { decisionSurface?: boolean }
  ): ModelRegistration[] {
    this.maybeRefreshMembers();
    return this.tierPoolEntries(tier, healthyOnly, opts).map(({ model }) => model);
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
      // Pass-through head is NOT a selection: the caller's per-request chain
      // head is the one real pick, so reading the rotation cursor here would
      // advance it twice per request and serve every second draw. The pool
      // head (all health levels, never drawn) is the same model the chain
      // would lead with.
      const head =
        entries[0]?.model ?? this.getCandidateModelsForTier(tier, false)[0];
      if (head) return { model: head, actualEffort: 'none', degraded: false };
      // Pool empty at every health level: keep the getter's cross-tier /
      // throw contract. No rotation draw can happen here — a pool with no
      // candidate has nothing for pickPrimary to advance.
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
   *  that applies when the model serves from THIS tier's pool.
   *  DECISION-WIRE EXCLUSION (ADR-0008 §7): models on wire 'systemone' can
   *  only answer the decision protocol — they are filtered out of every CHAT
   *  pool read (the default) so routing never pins one and blames the
   *  upstream for the gateway's own wire mismatch; the decision surface
   *  passes `decisionSurface: true` to see them. */
  private tierPoolEntries(
    tier: TierLevel,
    healthyOnly: boolean,
    opts?: { decisionSurface?: boolean }
  ) {
    return this.buildTierPoolEntries(tier, this.committedMembers)
      .filter(({ model }) => opts?.decisionSurface === true || model.wire !== 'systemone')
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
      const supported = modelSupportsEfforts(m.supportedReasoningEfforts, m.supportsReasoningEffort, m.reasoningDisableable);
      if (!supported) continue; // no explicit effort control → cannot serve a mapped level
      // Deliberately the 2-arg form: this is ROUTING, where an unreachable ask
      // means SKIP the candidate (never serve above what was asked). The
      // always-think floor belongs to the sites that must serve one fixed model
      // (orchestrator / directives), not here.
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
      if (rep && rep.tier !== undefined) {
        console.warn(`[Registry] Tier '${tier}' has no candidate model — falling back to '${step}' (${rep.id}), reason=empty-pool`);
        return rep;
      }
    }
    const any = Array.from(this.models.values()).find((m) => m.tier !== undefined);
    if (!any) {
      throw new Error(`No routable models registered (no model's tier membership is claimed by any pool).`);
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
        RESERVED_IDS.has(siblingId)
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

  /**
   * (Re)register combo definitions — used at boot, for hot-apply on console
   * config saves, and by the lazy maybeRefreshMembers safety net. A section
   * byte-identical to the last applied one is a no-op (keeps round-robin
   * cursors, avoids repeat skip warnings): skip outcomes depend only on the
   * section plus the monotonically grown model map, and every read path
   * re-checks model shadowing live, so skipping loses nothing.
   */
  public applyCombos(combos?: ComboConfig[]): void {
    const fingerprint = JSON.stringify(combos ?? null);
    if (fingerprint === this.combosFingerprint) return;
    this.combosFingerprint = fingerprint;
    this.combos.clear();
    this.comboRr.reset();
    for (const combo of combos || []) {
      if (!combo?.id || !Array.isArray(combo.models) || combo.models.length === 0) continue;
      if (RESERVED_IDS.has(combo.id)) {
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
    return { id: entry.id, weight: normalizeMemberWeight(entry.weight) };
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
   * Combo primary pick, mirroring the tier selection strategies exactly:
   * - priority (default): first healthy member in config order
   * - weighted_round_robin: smooth WEIGHTED round-robin — weight = the member
   *   entry's weight (default 1)
   * - round_robin: plain sequential round-robin — equal turns, weights ignored
   * The same smooth round-robin core serves the tier pools; cursors are
   * combo-scoped (and strategy-scoped).
   * Falls back to the full member list when every member is tripped.
   */
  public pickComboLeader(comboId: string, members: ModelRegistration[]): ModelRegistration {
    if (members.length === 0) return members[0];
    // Single-member combos still go through the rotation core on rotation
    // strategies so a shrunk pool resets its cursor (same rule as the tiers).
    const strategy = normalizeSelectionStrategy(this.combos.get(comboId)?.selection);
    // Decision 6 aggregate (same rule as the tier pools): a member whose every
    // credential is out must not lead a combo.
    const healthy = members.filter((m) => this.modelAvailable(m).available);
    const pool = healthy.length > 0 ? healthy : members;
    const weights = new Map<string, number>();
    for (const entry of this.combos.get(comboId)?.models || []) {
      const ref = this.comboMemberRef(entry);
      if (!weights.has(ref.id)) weights.set(ref.id, ref.weight);
    }

    if (strategy === 'priority') return pool[0];
    const weightOf =
      strategy === 'weighted_round_robin' ? (m: ModelRegistration) => weights.get(m.id) ?? 1 : () => 1;
    return this.comboRr.pick(`${comboId}:${strategy}`, pool, (m) => m.id, weightOf);
  }

  /**
   * Introspection for the console resolve a tier's effective
   * candidate pool from the member lists + the global denylist. A PURE
   * projection over (model id × tiers.members) — `policiesOverride` carries
   * freshly-edited form state for previews without committing; runtime
   * callers omit it and get the construction-time snapshot. Pool order =
   * rule weight (desc) then member-list order; entries carry the claiming
   * rule's weight (default 1). `'unclassified'` is the diagnostic fourth state:
   * models claimed by NO tier (it is never hidden by the denylist — the
   * console must show it for the unpooled view / one-click join). A model is
   * in this view exactly when its home tier is undefined.
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
        if (!m.autoTier) {
          // Hand-configured model: unclaimed exactly when registered so.
          if (m.tier === undefined) pool.push({ model: m, weight: 1 });
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
   * Outbound egress the CORE transport will take for `model`, resolved from
   * the same `resolveProxyUrl` the executors call at dial time (ADR-0018 /
   * ADR-0022). Call this IMMEDIATELY before `execute()` and keep the value
   * with the attempt: the proxy config hot-applies, so a read after a long
   * stream can describe a different dial.
   *
   * `undefined` = UNKNOWN, never direct: nothing was dialed (mock mode) or
   * the transport does not report its dial base (plugin-owned executors).
   */
  public egressFor(model: ModelRegistration): AttemptEgress | undefined {
    if (this.mockMode) return undefined;
    const base = this.providers.get(model.provider)?.dialBaseFor?.(model);
    if (!base) return undefined;
    const proxy = resolveProxyUrl(base, { provider: model.provider, model: model.id });
    return proxy ? { mode: 'proxy', origin: redactProxyUrl(proxy) } : { mode: 'direct' };
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
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credentialKeyHashPrefix?: string,
    relay?: StreamRelay,
    /** Resolved OCR conversation id. Not a capture field. */
    sessionId?: string,
    /** Inbound client surface protocol — prefer-native dial (ADR-0033). */
    inboundWire?: string,
  ): Promise<CanonicalResponse> {
    if (this.mockMode) {
      relay?.onTransport?.('buffered');
      return this.mockExecute(request, model);
    }
    const provider = this.providers.get(model.provider);
    if (!provider) throw new Error(`Provider '${model.provider}' not found for model '${model.id}'`);
    const dialWire = pickDialWire(model.protocols ?? (model.wire ? [model.wire] : undefined), inboundWire, request);
    const dialModel: ModelRegistration =
      dialWire === model.wire ? model : { ...model, wire: dialWire };
    const chain = this.credentialChains.get(model.provider);
    let credential: CallCredential | undefined;
    if (credentialKeyHashPrefix !== undefined) {
      credential = chain?.find((entry) => entry.keyHashPrefix === credentialKeyHashPrefix);
      if (!credential) {
        throw new Error(`Unknown credential selector '${credentialKeyHashPrefix}' for provider '${model.provider}'`);
      }
    }
    try {
      const recovery = toolMarkupRecoveryFor(request, dialModel, this.providerConfigs.get(model.provider));
      if (relay) {
        const streams = provider.supportsStreaming
          ? provider.supportsStreaming(dialModel)
          : typeof provider.createStream === 'function';
        if (streams) {
          const accumulate = createEventAccumulator();
          const scanner = recovery ? null : createToolMarkupScanner();
          const rewrite = recovery ? createToolMarkupStreamRecovery(request) : null;
          relay.onTransport?.('sse');
          const stream = await provider.createStream!(request, dialModel, upstreamEventContext, credential, sessionId);
          // Drain for terminal usage even if the client disconnected. Relay and
          // accounting consume the same event objects without history copies.
          for await (const event of stream) {
            const outgoing = rewrite ? rewrite.push(event) : [event];
            if (scanner && event.type === 'response.output_text.delta') scanner.push(event.text);
            for (const item of outgoing) {
              accumulate.push(item);
              await relay.onChunk(item);
            }
          }
          for (const item of rewrite?.finish() ?? []) {
            accumulate.push(item);
            await relay.onChunk(item);
          }
          const accumulated = accumulate.finish();
          const finished = rewrite ? rewrite.finishResponse(accumulated) : accumulated;
          reportToolMarkupLeak(rewrite ? finished.toolMarkupLeak ?? null : scanner!.leak(), dialModel);
          return finished;
        }
        relay.onTransport?.('buffered');
      }
      const buffered = await provider.createCompletion(request, dialModel, upstreamEventContext, credential, sessionId);
      const finished = recovery ? recoverToolMarkupInResponse(buffered, request) : buffered;
      const leak = recovery ? finished.toolMarkupLeak ?? null : detectToolMarkupLeak(finished);
      if (!leak) return finished;
      reportToolMarkupLeak(leak, dialModel);
      return { ...finished, toolMarkupLeak: leak };
    } catch (err) {
      const used = credential ?? chain?.[0];
      if (used && err && (typeof err === 'object' || typeof err === 'function')) {
        (err as { usedCredentialKeyHashPrefix?: string }).usedCredentialKeyHashPrefix = used.keyHashPrefix;
      }
      // Layer model + declared protocols onto IR refusals so the client sees
      // which dial was incompatible — not only the bare protocol id.
      if (err instanceof IrUnsupportedError) {
        throw withDialContext(err, {
          modelId: dialModel.id,
          dialWire: dialWire,
          protocols: dialModel.protocols ?? (dialModel.wire ? [dialModel.wire] : undefined),
        });
      }
      throw err;
    }
  }

  private async mockExecute(
    request: CanonicalRequest,
    model: ModelRegistration,
  ): Promise<CanonicalResponse> {
    const controls = request as CanonicalRequest & Record<string, any>;
    if (controls.__simulate_error_model__ === model.id || controls.__simulate_error_all__) {
      let shouldThrow = true;
      if (typeof controls.__simulate_fail_times__ === 'number') {
        shouldThrow = controls.__simulate_fail_times__-- > 0;
      }
      if (shouldThrow) {
        const status = controls.__simulate_status__ || 503;
        const message = controls.__simulate_message__ || `Simulated error for model ${model.id} (Status ${status})`;
        throw new UpstreamError({
          message,
          status,
          errorBody: JSON.stringify({ error: { message, code: controls.__simulate_code__ } }),
          provider: model.provider,
          modelId: model.id,
          retryAfterSeconds: controls.__simulate_retry_after__,
        });
      }
    }
    const format = request.text?.format?.type;
    const isJsonRequested = format === 'json_object' || format === 'json_schema' || /json/i.test(JSON.stringify(request.input));
    let content = `This is a standard mock response from ${model.id}`;
    if (isJsonRequested) {
      content = model.tier === 'lite' && controls.__simulate_malformed__
        ? '{ "name": "sample", "invalid_json_trailing": '
        : JSON.stringify({
          status: 'success', tier: model.tier, model: model.id,
          data: { title: 'Mock Structured Output', category: 'test' },
        });
    }
    return {
      id: `mock-chatcmpl-${Date.now()}`,
      createdAt: Math.floor(Date.now() / 1000),
      model: model.id,
      status: 'completed',
      reason: 'stop',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: content }] }],
      usage: { inputTokens: 150, outputTokens: 80, totalTokens: 230, cachedInputTokens: 50 },
    };
  }
}
