import { ModelRegistration, ModelVariant, ProviderConfig } from '../config/types.js';
import { DispatchingProvider } from './executors/dispatch.js';
import type { ProviderRegistry } from './registry.js';
import type { CatalogModel } from '../opencode/catalog/types.js';
import { TierLevel, EFFORT_LADDER, type ReasoningEffort } from '../types/router.js';
import { loadConfig } from '../config/index.js';
import { resolveTierMembers, claimModel, comboRefLookupFromConfig, expandComboRefs, markExactFullIds } from './member-match.js';
import { pricingFromCost } from './virtual-meta.js';
import { catalogRepository } from '../opencode/catalog/repository.js';
import {
  getProviderNodeById,
  getProviderModelDefs,
  expandEnvTemplate,
  legacyShapedSlotEntries,
} from '../opencode/user-config.js';
import { getCredentialStore, getCredentialStoreStatus } from '../opencode/credentials/index.js';
import { keyHashPrefix } from '../opencode/credentials/types.js';
import { sanitizeExtraHeaders } from '../utils/http-headers.js';
import { assertAllowedUpstream, UpstreamUrlError } from '../utils/upstream-url-guard.js';
import type { CallCredential, RawCred, ResolvedCredential } from '../opencode/credentials/types.js';
import { WireKind, wireFor, unroutableInfo, baseForWire } from './wire.js';
import { normalizeProtocols, primaryProtocol } from './protocols-field.js';
import { getProviderTakedownStore } from './provider-takedown.js';
import { getModelServicePlugin, pluginDeclinesCredentials } from '../plugins/host.js';

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
     * default credential. RAW KEYS IN MEMORY ONLY: this payload goes to
     * `registry.registerProvider` and nothing else — never serialize it into
     * a console/API surface (masked views keep using `CredentialMeta`).
     */
    credentialChain: CallCredential[];
  }[];
  models: ModelRegistration[];
  /**
   * Reason text is human-readable; reasonCode is machine-readable (present on
   * store-level entries merged from the binding and on provider-level
   * takedowns — `operator_disabled`).
   */
  excluded: { provider: string; model?: string; reason: string; reasonCode?: string }[];
}

/** Raw key + display identity → the per-call selectable credential (P3 step 1).
 *  `label` stays absent when the operator never named the credential — the
 *  store's machine id is NOT a display name (it used to leak as a UUID).
 *  Exported for the console's hot chain rebuild (`registry.refreshCredentialChain`
 *  callers) — the same mapping the boot pool uses, never a second convention. */
export function toCallCredential(key: string, label?: string, weight?: number): CallCredential {
  return { key, keyHashPrefix: keyHashPrefix(key), ...(label ? { label } : {}), ...(weight !== undefined ? { weight } : {}) };
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
    // Legacy data with no reasoning_options: the boolean expands to the full
    // ladder — minus `none` when the def states the model always thinks.
    return isReasoning ? fullLadder(catModel?.reasoningDisableable) : undefined;
  }
  const effortOpt = opts.find((o) => o?.type === 'effort');
  if (effortOpt && Array.isArray(effortOpt.values) && effortOpt.values.length > 0) {
    const allowed = effortOpt.values.filter(
      (v): v is ReasoningEffort => (EFFORT_LADDER as readonly string[]).includes(v)
    );
    if (allowed.length > 0) return withoutForbiddenNone(allowed, catModel?.reasoningDisableable);
  }
  if (opts.some((o) => o?.type === 'budget_tokens')) return fullLadder(catModel?.reasoningDisableable);
  // A declared table with NO usable level is "no explicit level control" —
  // never expanded into a full ladder. `[]` already withholds `none`: the
  // router reads it as "no level to offer", and the wire-side clamp keeps the
  // model's own always-think behaviour (the qoder 1210 replay is the net).
  return [];
}

/** The boolean-expanded ladder, honouring an always-think declaration. */
function fullLadder(disableable: boolean | undefined): readonly ReasoningEffort[] {
  return disableable === false ? EFFORT_LADDER.filter((e) => e !== 'none') : EFFORT_LADDER;
}

/** Strip `none` from a declared table when the def says the model always
 *  thinks. A table that empties under the strip stays EMPTY (no level control)
 *  — it must never fall back to a ladder that re-admits the forbidden level. */
function withoutForbiddenNone(
  levels: readonly ReasoningEffort[],
  disableable: boolean | undefined
): readonly ReasoningEffort[] {
  if (disableable !== false) return levels;
  return levels.filter((e) => e !== 'none');
}

/** One shared line for a node the reader refuses to route (Decision 11). */
function retiredShapeReason(paths: string[]): string {
  return `provider def node is a retired shape (${paths.join(', ')}): retired shapes are not routable — use the protocols/settings shape`;
}

export async function buildDirectPool(): Promise<DirectBootResult> {
  const catalog = await catalogRepository.list();
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

  // Decision 11: a retired-shape node is dropped by the reader (its wire config
  // is unproven — the node parses, but a retired opencode-v1 `options` bag may be
  // ignored, which would point the provider at a silently wrong endpoint), so the
  // drop is reported here rather than leaving the operator to wonder where their
  // provider went.
  const retiredShapes = new Map(legacyShapedSlotEntries().map((e) => [e.id, e.paths]));

  for (const rec of catalog) {
    const takedown = getProviderTakedownStore().get(rec.id);
    if (takedown) {
      excluded.push({
        provider: rec.id,
        reasonCode: 'operator_disabled',
        reason: takedown.reason
          ? `disabled by operator: ${takedown.reason}`
          : 'disabled by operator (console provider takedown)',
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
    // Bake the default credential (P3 step 1); `resolved?.key` stays the defensive
    // fallback for a store whose chain read came back empty while resolveKey
    // answered — head === baked key is an invariant the registry relies on.
    const pkg = primaryProtocol(normalizeProtocols(def?.protocols));
    // A plugin that declares only `none` owns login. A stored OCR key is not an account and is not required to route.
    const credentialless = pkg ? pluginDeclinesCredentials(getModelServicePlugin(wireFor(pkg))) : false;
    let apiKey = inlineKey || storeCreds[0]?.key || resolved?.key;
    if (credentialless) {
      apiKey = '';
      storeCreds = [];
      resolved = null;
    } else if (!apiKey) {
      // catalog-universe providers without credentials are structural noise —
      // only surface when the user actually defined a config node for them.
      // the credential candidates are the inline def and
      // the BOUND store (auth.json is no longer named here — it is not a sink).
      if (def) excluded.push({ provider: rec.id, reasonCode: 'no_credential', reason: 'no credential (neither inline nor in the credential store)' });
      continue;
    }
    // models.dev `api` (canonical) beats the daemon's runtime hint; per-wire
    // mounts can differ (e.g. Zen exposes chat+responses under /zen/v1 while
    // the daemon's effective base is a newer inference mount), and the hint
    // may be stale project-scoped state.
    const baseURL = expandEnvTemplate(def?.options?.baseURL) || rec.api || rec.baseURL;
    if (!baseURL) {
      excluded.push({ provider: rec.id, reason: 'baseURL undetermined (no config definition and no catalog default api)' });
      continue;
    }
    // The gateway must never route THROUGH itself: a baseURL pointing back at
    // this gateway's own listen endpoint would make every routed request
    // recurse into the gateway again. Checked on the RESOLVED value — an
    // env-templated `{env:SELF_URL}` expands exactly above, so a guard on the
    // raw record would miss it. The criterion is the URL, never the id — a
    // `omnicell-router` def pointing at ANOTHER instance is a legitimate
    // federation upstream. Excluded loudly, never silently (ADR-0005 §2:
    // unroutable is excluded and reported, never a boot abort).
    try {
      assertAllowedUpstream(baseURL, loadConfig().port);
    } catch (err) {
      if (err instanceof UpstreamUrlError && err.reasonCode === 'self_upstream_refused') {
        excluded.push({
          provider: rec.id,
          reason: `provider baseURL (${baseURL}) points at this gateway — the gateway cannot be its own upstream`,
          reasonCode: 'self_loop',
        });
      } else {
        excluded.push({
          provider: rec.id,
          reason: err instanceof UpstreamUrlError ? err.message : String(err),
          reasonCode: err instanceof UpstreamUrlError ? err.reasonCode : 'invalid_upstream_url',
        });
      }
      continue;
    }

    const defs = getProviderModelDefs(rec.id) || {};
    const catById = new Map(rec.models.map((m) => [m.id, m]));
    // The provider's defs node IS its model universe (connect-time doctrine,
    // ADR-0010): every connected provider owns a node, and the catalog is a
    // SOURCE for that node, never a fallback universe. An empty node means
    // "nothing maintained yet" and must not re-expand to the catalog listing —
    // pull or add models to make them routable. There is no per-model hidden
    // flag: removing a model from routing means removing its definition.
    const modelIds = Object.keys(defs);
    if (modelIds.length === 0) {
      excluded.push({ provider: rec.id, reason: 'no models maintained in the config (pull or add them)' });
      continue;
    }

    const wires = new Set<WireKind>();
    const wireBases = new Map<string, string>();
    for (const mid of modelIds) {
      const d = (defs as any)[mid];
      const catModel = catById.get(mid);
      // Operator takedown, CLIENT-only by contract: the model stays in the
      // console (catalog viewer, /models) but leaves the routing pool, so
      // /v1/models omits it and no client request can be pinned to it.
      // Read from the AGGREGATE so both write paths are honored by this one
      // check (overrides.json wins over a def-level flag).
      if (catModel?.disabled === true) {
        excluded.push({ provider: rec.id, model: `${rec.id}/${mid}`, reason: 'hidden from the client catalog (disabled)' });
        continue;
      }
      // the routing pool speaks chat/responses/anthropic only —
      // image/audio/video OUTPUT models (qwen-image, TTS, ASR…) belong to tool
      // extension mechanisms and would answer 400 ModelProtocolUnsupported or
      // garbage on any text wire. Config-defined models without modality data
      // pass through (no evidence they are non-text).
      const outMods = catModel?.modalities?.output;
      if (Array.isArray(outMods) && outMods.length > 0 && !outMods.includes('text')) {
        excluded.push({ provider: rec.id, model: `${rec.id}/${mid}`, reason: `non-text output model (modalities.output=${outMods.join('/')}), not in the text routing pool` });
        continue;
      }
      // Ordered dial set (ADR-0033): model override → catalog model → provider
      // def → catalog provider. ONE level fully wins (a declared list is never
      // patched item-by-item across levels); the boot primary is its head, and
      // the per-attempt dialer re-picks from the same list.
      const modelProtocols =
        normalizeProtocols(d?.provider?.protocols).length > 0
          ? normalizeProtocols(d?.provider?.protocols)
          : normalizeProtocols(catModel?.protocols).length > 0
            ? normalizeProtocols(catModel?.protocols)
            : normalizeProtocols(def?.protocols).length > 0
              ? normalizeProtocols(def?.protocols)
              : normalizeProtocols(rec.protocols);
      const npm = modelProtocols.length > 0 ? modelProtocols[0] : undefined;
      const wire = wireFor(npm, baseURL || rec.api);
      if (wire === 'unroutable') {
        const info = unroutableInfo(npm);
        excluded.push({
          provider: rec.id,
          model: `${rec.id}/${mid}`,
          reasonCode: `unroutable_${info.code}`,
          reason: `wire not routable (${info.code}): ${info.npm || 'unknown package'}`,
        });
        continue;
      }
      wires.add(wire);
      wireBases.set(wire, baseForWire(wire, baseURL));

      const isReasoning = catModel?.reasoning === true || d?.capabilities?.reasoning === true;
      // No pricing fallback: a model whose price is unknown keeps `undefined`
      // (a fabricated number is indistinguishable from a real quote downstream
      // and erases the per-model differences the cost surfaces exist to show).
      // The one cost→pricing rule is shared with the combo envelope.
      const pricing = pricingFromCost(catModel?.cost);

      // The defs-file model definition may declare an EXPLICIT tier — an operator
      // pin that the member lists can never move (no `autoTier` stamp below).
      // Everything else starts with NO home tier: the member lists are the one
      // membership source, and the loop over `claimModel` at the end of this
      // function assigns the derived home view for every claimed model. Nothing
      // classifies by price, name pattern or capability any more.
      const explicitTier = (v: unknown): TierLevel | undefined =>
        v === 'lite' || v === 'plus' || v === 'pro' || v === 'ultra' ? (v as TierLevel) : undefined;
      const configTier = explicitTier(d?.tier);
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
        // Absent for machine-derived models: the claim loop at the end of this
        // function assigns the home tier from the member lists.
        tier: configTier,
        isDefaultInTier: false,
        // Catalog reasoning_options → the real effort tiers (see effortLadderFor).
        // The legacy `supportsReasoningEffort` boolean is intentionally NOT set:
        // `supportedReasoningEfforts` is always resolved here, and the legacy
        // true-branch would resurrect a full-ladder claim for [] (toggle) models.
        supportedReasoningEfforts: effortLadderFor(catModel, isReasoning),
        // The vendor's on/off fact rides the registration so EVERY routing
        // resolution (modelSupportsEfforts) withholds `none` for an always-think
        // model — not only the boot ladder above (ADR-0035 rule 2).
        ...(catModel?.reasoningDisableable === false ? { reasoningDisableable: false } : {}),
        // Tri-state sampling-parameter capability flag — the provider layer
        // strips params for temperature:false models.
        temperature: catModel?.temperature,
        // Tri-state developer-role capability flag (override-only; default =
        // the openai wire rewrites `developer` → `system`).
        supportsDeveloperRole: catModel?.supportsDeveloperRole,
        supportsPromptCaching: wire === 'anthropic-messages' || (catModel?.cost?.cache_read != null ? true : undefined),
        // Variants become routable sibling ids (`<id>-<variant>`) + `#variant`
        // syntax; the jsonc def is the source (catalog records may mirror it).
        variants,
        // Pinned when the client omits `reasoning_effort` (orchestrator).
        defaultEffort,
        wire,
        // The full ordered dial set the boot primary above heads (ADR-0033).
        ...(modelProtocols.length > 0 ? { protocols: modelProtocols } : {}),
        // Provenance stamp: the registry is allowed to re-project this model's
        // home tier from the member lists at every commit. Only machine-derived
        // models carry it — an explicit `tier` in the defs file keeps it out so
        // member-list edits can never move a hand-configured model.
        ...(configTier ? { configTier } : { autoTier: true as const }),
        ...(pricing ? { pricing } : {}),
      });
    }

    if (wires.size === 0) {
      excluded.push({ provider: rec.id, reason: 'every model of this provider is not directly routable' });
      continue;
    }
    // per-call selection chain. One instance per provider
    // even with N credentials: the head is baked as the default, the full
    // ordered chain rides on the payload (registry-only, raw keys in memory).
    // Single-credential providers get a length-1 chain — behavior byte-identical.
    const credentialChain: CallCredential[] = storeCreds.map((c) =>
      toCallCredential(c.key, c.label, c.weight)
    );
    // Defensive fallback consistency: if the chain read was empty but resolveKey
    // supplied the baked key, represent it so head === config.apiKey always holds.
    if (credentialChain.length === 0 && resolved) {
      credentialChain.push(toCallCredential(resolved.key, resolved.credential.label));
    }
    // Inline {env}/options.apiKey outranks the store for the baked default
    // (Decision 1) — it becomes the chain HEAD too, keeping the invariant
    // head === config.apiKey; store credentials stay selectable below it.
    if (inlineKey && !credentialless) credentialChain.unshift(toCallCredential(inlineKey, 'inline'));
    instances.push({
      name: rec.id,
      config: {
        name: rec.id,
        type: 'dispatch',
        baseUrl: baseURL,
        // Boot-baked credential: the active default credential —
        // the same key resolveKey picks when a provider holds exactly one
        // credential. Per-call selection reads the chain below; the baked key
        // remains the no-selector default.
        apiKey,
        headers: sanitizeExtraHeaders(def?.options?.headers),
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
  // Membership itself is a per-tier projection computed live at every pool
  // build (registry.buildTierPoolEntries) — a model may join several tiers.
  // What is written here is the DERIVED HOME view for single-tier consumers
  // (first claim in tier order lite→plus→pro→ultra: tier, chain priority,
  // list-leader flag, home effortMap). Members are edited on the console
  // /tiers page (hot-applied by the registry; no restart, no persistence).
  const cfgTiers = loadConfig().tiers;
  const registeredIds = new Set(models.map((m) => m.id));
  const registeredLower = new Set(models.map((m) => m.id.toLowerCase()));
  const lookup = comboRefLookupFromConfig(loadConfig().combos, (id) => registeredIds.has(id));
  const expanded = expandComboRefs(resolveTierMembers(cfgTiers).tiers, lookup);
  // Hand-written FULL ids pin exactly like combo-expanded members (the console's
  // "full id = exact match" contract): `deepseek/v4-flash` must not claim the
  // longer sibling `deepseek/v4-flash-vision-exp`. Partial patterns stay
  // substring patterns.
  const resolved = {
    dead: expanded.dead,
    tiers: markExactFullIds(expanded.tiers, (id) => registeredLower.has(id.toLowerCase())),
  };
  for (const d of resolved.dead) {
    console.warn(
      `[Boot] Tier '${d.tier}' references combo '${d.ref.slice('combo:'.length)}' that contributes no members ` +
        `(unknown / disabled / shadowed / zero registered models) — check it on the /tiers page.`,
    );
  }
  let claimed = 0;
  for (const m of models) {
    // An explicit defs-file tier is an operator PIN: the member lists may
    // project the model into pools, but they never rewrite its home view.
    // It still POPULATES its tier pool (hand-configured branch), so it counts
    // toward "pools are non-empty" — otherwise an all-pinned deployment would
    // log a false "pools are EMPTY" warning.
    if (m.configTier) {
      claimed++;
      continue;
    }
    const home = claimModel(m.id, resolved.tiers);
    if (home === 'unclassified') {
      m.tier = undefined;
      continue;
    }
    claimed++;
    m.tier = home.tier;
    m.priority = home.index + 1; // home list order (derived view)
    m.isDefaultInTier = home.index === 0; // the home list leader
    if (home.rule.effortMap) m.effortMap = home.rule.effortMap;
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

/**
 * Hot pool rebuild (console provider-def mutations): the runtime twin of the
 * boot path — the SAME builder with the SAME invariants, reconciled into the
 * live registry without a gateway restart. Fail-open at the caller: a rebuild
 * error must never take routing down; the existing registry keeps serving.
 */
export async function refreshDirectPool(registry: ProviderRegistry): Promise<DirectBootResult> {
  const boot = await buildDirectPool();
  registry.applyDirectPool(
    boot.instances.map((inst) => ({
      name: inst.name,
      provider: new DispatchingProvider(inst.config, inst.wireBases),
      config: inst.config,
      credentialChain: inst.credentialChain,
    })),
    boot.models
  );
  // Event-drive follow-catalog rewrites off the same seam every pool rebuild
  // already shares (console mutations, catalog auto-pull, config save). Fail-open:
  // a sync scheduling error must never undo a successful pool rebuild.
  try {
    const { requestFollowCatalogSync } = await import('../cli/clients/follow-catalog-sync.js');
    requestFollowCatalogSync({ reason: 'pool' });
  } catch (err) {
    console.warn(
      `[pool] follow-catalog sync schedule failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return boot;
}
