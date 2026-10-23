import { catalogModelToDef } from '../provider-defs.js';
import { loadConfig } from '../../config/index.js';
import { isSelfBaseURL } from '../../utils/self-url.js';
import type { CatalogModel } from './types.js';

/**
 * Model pull engine for provider definitions (providers.json).
 *
 * Two paths, chosen automatically by console routes AND the periodic
 * auto-pull scheduler (catalog.autoPullModels + catalog.autoPullPatterns):
 *  - live:     provider has baseURL + credential → pull its own /v1/models
 *  - catalog:  otherwise → static merged catalog (builtin → extensions)
 *
 * The PERIODIC sweep is opt-in per provider: only providers declared in
 * catalog.autoPullPatterns are swept, and only within their glob pattern —
 * an undeclared provider (e.g. an aggregator gateway with hundreds of
 * upstream models) never gets its full list written back. Both paths are
 * ADD-ONLY: models already defined in the defs file are never overwritten —
 * locally maintained values stay source-proof. Manual console pulls are
 * unaffected by the whitelist (pattern passed per-request there).
 */

export interface PullResult {
  httpStatus: number;
  body: Record<string, any>;
}

export async function pullLiveModels(id: string, opts: { pattern?: string; ids?: string[]; dryRun?: boolean }): Promise<PullResult> {
  const { getProviderNodeById, getProviderModelDefs, upsertProviderModel, matchesGlobPattern, expandEnvTemplate } =
    await import('../user-config.js');
  const def = getProviderNodeById(id);
  if (!def) {
    return { httpStatus: 404, body: { success: false, error: `Provider '${id}' is not defined in the provider defs file` } };
  }
  const baseURL = def?.options?.baseURL;
  if (!baseURL) {
    return { httpStatus: 400, body: { success: false, error: `Provider '${id}' has no baseURL configured` } };
  }
  // A baseURL pointing back at THIS gateway would fetch our own /v1/models and
  // write every routable model back as this provider's defs — self-duplication,
  // not data. A DIFFERENT instance (another port/host) is a legitimate pull
  // target (federation). Criterion is the URL, never the id.
  if (isSelfBaseURL(baseURL, loadConfig().port)) {
    return {
      httpStatus: 400,
      body: { success: false, error: `Provider '${id}' baseURL (${baseURL}) points at this gateway itself — self-pull refused` },
    };
  }
  // raw key from the BOUND store (every credential flavor lands there: v2 db
  // pushes, v1/standalone imports into the ocr file) — direct auth.json reads
  // would miss v2-managed and standalone credentials.json keys. Inline
  // precedence above the store kept (Decision 1).
  const { getCredentialStore } = await import('../credentials/index.js');
  const store = await getCredentialStore();
  const inlineKey = expandEnvTemplate(def?.options?.apiKey);
  const key = inlineKey || store.resolveKey(id)?.key;
  if (!key) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        authHint: true,
        error: `No API key for '${id}' (credential store or inline) — cannot authenticate against ${baseURL}`,
      },
    };
  }

  const url = `${String(baseURL).replace(/\/+$/, '')}/models`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  } catch (err: any) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message;
    return { httpStatus: 502, body: { success: false, reasonCode: 'pull_unreachable', url, cause: cause ? String(cause) : undefined } };
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    const text = raw.replace(/\s+/g, ' ').slice(0, 600);
    return {
      httpStatus: res.status === 401 || res.status === 403 ? 401 : 502,
      body: {
        success: false,
        reasonCode: 'pull_http',
        authHint: res.status === 401 || res.status === 403,
        url,
        httpStatus: res.status,
        upstreamBody: text || undefined,
      },
    };
  }
  const raw = await res.json().catch(() => null);
  if (!raw) {
    return { httpStatus: 502, body: { success: false, reasonCode: 'pull_non_json', url } };
  }
  const { normalizeOpenAICompatible } = await import('./sources/registry.js');
  const models = normalizeOpenAICompatible(raw);
  // Auto-enrich from the aggregated catalog (pricing/limits/modalities for the
  // same ids) BEFORE writing — fill-missing-only, own entries excluded.
  const enriched = await enrichFromCatalog(models, id);
  const pattern = opts.pattern?.trim();
  // Explicit id selection (console pull-preview click-to-select) narrows the
  // matched set on TOP of the pattern; ids not matched are simply absent.
  const idFilter = opts.ids?.length ? new Set(opts.ids.map(String)) : undefined;
  const matched = enriched.filter(
    (m) => (!pattern || matchesGlobPattern(pattern, m.id)) && (!idFilter || idFilter.has(m.id))
  );
  const existing = getProviderModelDefs(id) || {};
  const pullable = matched.filter((m) => !(m.id in existing));
  if (opts.dryRun) {
    return { httpStatus: 200, body: { status: 'ok', live: true, matched: matched.length, pullable: pullable.length, models: pullable } };
  }
  let pulled = 0;
  for (const m of pullable) {
    const result = upsertProviderModel(id, m.id, catalogModelToDef(m));
    if (!result.success) return { httpStatus: 400, body: result };
    pulled++;
  }
  return {
    httpStatus: 200,
    body: {
      status: 'ok',
      success: true,
      live: true,
      matched: matched.length,
      pullable: pullable.length,
      pulled,
      skipped: matched.length - pullable.length,
    },
  };
}

export async function pullCatalogModels(id: string, opts: { pattern?: string; ids?: string[]; dryRun?: boolean }): Promise<PullResult> {
  const { getProviderModelDefs, upsertProviderModel, matchesGlobPattern } = await import('../user-config.js');
  const { catalogRepository } = await import('./repository.js');
  const provider = await catalogRepository.getProvider(id);
  if (!provider) {
    return { httpStatus: 404, body: { success: false, error: `Provider '${id}' not found in the model catalog` } };
  }
  const existing = getProviderModelDefs(id) || {};
  const pattern = opts.pattern?.trim();
  // Explicit id selection (console pull-preview click-to-select) narrows the
  // matched set on TOP of the pattern; ids not matched are simply absent.
  const idFilter = opts.ids?.length ? new Set(opts.ids.map(String)) : undefined;
  const matched = provider.models.filter(
    (m) => (!pattern || matchesGlobPattern(pattern, m.id)) && (!idFilter || idFilter.has(m.id))
  );
  const pullable = matched.filter((m) => !(m.id in existing)); // never overwrite maintained defs
  // self-hosted gateways are absent from the static catalog — say so instead of a silent 0
  const notInCatalog = provider.sources.every((s) => s === 'config');
  const hint = notInCatalog && matched.length === 0 ? 'not-in-catalog' : undefined;
  if (opts.dryRun) {
    return { httpStatus: 200, body: { status: 'ok', matched: matched.length, pullable: pullable.length, models: pullable, hint } };
  }
  // Landing spot: the provider's own defs node (EVERY connected provider has
  // one — connect-time doctrine, see ensureConnectedProviderBook below).
  let pulled = 0;
  for (const m of pullable) {
    const result = upsertProviderModel(id, m.id, catalogModelToDef(m));
    if (!result.success) return { httpStatus: 400, body: result };
    pulled++;
  }
  return {
    httpStatus: 200,
    body: {
      status: 'ok',
      success: true,
      matched: matched.length,
      pullable: pullable.length,
      pulled,
      skipped: matched.length - pullable.length,
      ...(hint ? { hint } : {}),
    },
  };
}

export interface AutoPullEntry {
  providerId: string;
  mode: 'live' | 'catalog' | 'skipped';
  pulled: number;
  skipped?: number;
  error?: string;
}

/** How much usable data a CatalogModel carries — tie-break between equal matches. */
function infoScore(m: CatalogModel): number {
  let s = 0;
  if (m.name) s += 1;
  if (typeof m.cost?.input === 'number' && m.cost.input >= 0) s += 2;
  if (typeof m.cost?.output === 'number' && m.cost.output >= 0) s += 2;
  if (typeof m.limit?.context === 'number' && m.limit.context > 0) s += 1;
  if (m.modalities?.input?.length || m.modalities?.output?.length) s += 1;
  return s;
}

/**
 * Enrich freshly pulled models from the aggregated catalog (fill-missing-only):
 * bare /v1/models lists carry just ids, while the catalog (models.opencode.ai,
 * OpenRouter, …) holds authoritative pricing/limits/modalities for the same
 * ids. Matching is by bare id (last '/' segment), excluding the provider's own
 * entries; among duplicates the info-richest record wins. Values already
 * present on the pulled model (e.g. live context_length) are never overwritten.
 */
async function enrichFromCatalog(models: CatalogModel[], excludeProviderId: string): Promise<CatalogModel[]> {
  const { catalogRepository } = await import('./repository.js');
  const unified = await catalogRepository.list();
  const byBare = new Map<string, CatalogModel[]>();
  for (const p of unified) {
    if (p.id === excludeProviderId) continue; // never enrich from itself
    for (const m of p.models) {
      const bare = (m.id.includes('/') ? m.id.slice(m.id.lastIndexOf('/') + 1) : m.id).toLowerCase();
      const arr = byBare.get(bare);
      if (arr) arr.push(m);
      else byBare.set(bare, [m]);
    }
  }
  const best = (bareId: string): CatalogModel[] => {
    const cands = byBare.get(bareId.toLowerCase());
    if (!cands || cands.length === 0) return [];
    return [...cands].sort((a, b) => infoScore(b) - infoScore(a));
  };
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return models.map((m) => {
    const bare = m.id.includes('/') ? m.id.slice(m.id.lastIndexOf('/') + 1) : m.id;
    const hits = best(bare);
    if (hits.length === 0) return m;
    const out: CatalogModel = { ...m };
    out.name = out.name || hits[0].name || out.id.split('/').pop();
    // MERGE field-by-field across ALL matching entries (info-richest first):
    // one entry may carry pricing while another carries context/modalities.
    out.cost = { ...(out.cost ?? {}) };
    out.limit = { ...(out.limit ?? {}) };
    for (const hit of hits) {
      for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
        if (out.cost[k] === undefined && num(hit.cost?.[k]) !== undefined) out.cost[k] = num(hit.cost?.[k]);
      }
      for (const k of ['context', 'output'] as const) {
        if (out.limit[k] === undefined && num(hit.limit?.[k]) !== undefined) out.limit[k] = num(hit.limit?.[k]);
      }
      if (!out.modalities?.input?.length && !out.modalities?.output?.length && hit.modalities) out.modalities = hit.modalities;
      if (out.tool_call === undefined && hit.tool_call !== undefined) out.tool_call = hit.tool_call;
      if (out.reasoning === undefined && hit.reasoning !== undefined) out.reasoning = hit.reasoning;
    }
    if (!Object.values(out.cost).some((v) => v !== undefined)) delete out.cost;
    if (out.limit.context === undefined && out.limit.output === undefined) delete out.limit;
    return out;
  });
}

/**
 * One auto-pull sweep over DECLARED defs-file providers (ADD-ONLY per
 * provider). Gated by catalog.autoPullModels (master switch, default ON) and
 * catalog.autoPullPatterns (per-provider opt-in: providerId → glob). A
 * provider absent from the pattern map — or mapped to a blank string — is
 * skipped entirely, and a declared provider's pull is bounded by its pattern.
 * Both are checked live so console edits are hot. Failures are captured per
 * provider — a sweep never throws.
 */
export async function autoPullProviderModels(): Promise<AutoPullEntry[]> {
  const cfg = loadConfig().catalog;
  if (cfg?.autoPullModels === false) return [];
  const patterns = cfg?.autoPullPatterns ?? {};
  const { listConfigProviders, expandEnvTemplate, getProviderNodeById, matchesGlobPattern } =
    await import('../user-config.js');
  // keys from the BOUND store (same rule as pullLiveModels — inline above the
  // store); the store covers every credential flavor (standalone imports, v2
  // pushes), so no snapshot read is needed here.
  const { getCredentialStore } = await import('../credentials/index.js');
  const credStore = await getCredentialStore();

  // Phase 1 — concurrent FETCH (network only, no writes): resolve each
  // provider's candidate model list from its own /v1/models or the catalog.
  const jobs = await Promise.all(
    listConfigProviders().map(async (v): Promise<{ id: string; mode: AutoPullEntry['mode']; models: CatalogModel[]; error?: string }> => {
      // A def whose baseURL points back at THIS gateway self-fetches
      // /v1/models and re-materializes every routable model as its defs
      // (same refusal as pullLiveModels). Other instances pull fine.
      const sweepBaseURL = getProviderNodeById(v.id)?.options?.baseURL;
      if (isSelfBaseURL(sweepBaseURL, loadConfig().port)) {
        return { id: v.id, mode: 'skipped', models: [], error: `baseURL (${sweepBaseURL}) points at this gateway — self-pull refused` };
      }
      // Opt-in gate: an undeclared provider is never swept — no fetch, no
      // catalog lookup, no writes. This is what keeps an aggregator gateway's
      // full upstream list from being materialized every sync period.
      const pattern = patterns[v.id]?.trim();
      if (!pattern) return { id: v.id, mode: 'skipped', models: [] };
      const def = getProviderNodeById(v.id);
      if (!def) return { id: v.id, mode: 'skipped', models: [] };
      const baseURL = def?.options?.baseURL;
      const inlineKey = expandEnvTemplate(def?.options?.apiKey);
      const key = inlineKey || credStore.resolveKey(v.id)?.key;
      if (baseURL && key) {
        try {
          const res = await fetch(`${String(baseURL).replace(/\/+$/, '')}/models`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) return { id: v.id, mode: 'live', models: [], error: `HTTP ${res.status}` };
          const raw = await res.json().catch(() => null);
          if (!raw) return { id: v.id, mode: 'live', models: [], error: 'non-JSON payload' };
          const { normalizeOpenAICompatible } = await import('./sources/registry.js');
          const pulled = normalizeOpenAICompatible(raw).filter((m) => matchesGlobPattern(pattern, m.id));
          const models = await enrichFromCatalog(pulled, v.id);
          return { id: v.id, mode: 'live', models };
        } catch (err: any) {
          return { id: v.id, mode: 'live', models: [], error: err?.message || String(err) };
        }
      }
      const { catalogRepository } = await import('./repository.js');
      const provider = await catalogRepository.getProvider(v.id);
      if (!provider || provider.models.length === 0) return { id: v.id, mode: 'skipped', models: [] };
      return {
        id: v.id,
        mode: 'catalog',
        models: provider.models.filter((m) => matchesGlobPattern(pattern, m.id)),
      };
    })
  );

  // Phase 2 — SERIAL WRITE: writeProviderDefs is a whole-map read-modify-write over the shared
  // defs file, so model upserts must never run concurrently.
  const { getProviderModelDefs, upsertProviderModel } = await import('../user-config.js');
  const out: AutoPullEntry[] = [];
  for (const job of jobs) {
    if (job.mode === 'skipped') {
      out.push({ providerId: job.id, mode: 'skipped', pulled: 0 });
      continue;
    }
    if (job.error) {
      out.push({ providerId: job.id, mode: job.mode, pulled: 0, error: job.error });
      continue;
    }
    const hasNode = Boolean(getProviderNodeById(job.id));
    if (!hasNode) {
      // Unification doctrine: every CONNECTED provider has a defs node (created
      // at connect/bind). A nodeless provider is not connected — nothing to
      // write into, and the sweep never fabricates connections.
      out.push({ providerId: job.id, mode: 'skipped', pulled: 0 });
      continue;
    }
    const existing = getProviderModelDefs(job.id) || {};
    let pulled = 0;
    for (const m of job.models) {
      if (m.id in existing) continue; // ADD-ONLY: maintained defs are source-proof
      if (upsertProviderModel(job.id, m.id, catalogModelToDef(m)).success) pulled++;
    }
    out.push({ providerId: job.id, mode: job.mode, pulled, skipped: job.models.length - pulled });
  }
  return out;
}

/**
 * Pull one provider's models with the automatic live/catalog choice — the SAME
 * dispatch the console pull route and the periodic scheduler use. Shared so the
 * create route can opportunistically top up a brand-new provider in one gesture.
 */
export async function autoPullProvider(
  id: string,
  opts: { pattern?: string; ids?: string[]; dryRun?: boolean } = {}
): Promise<PullResult> {
  const { getProviderNodeById, expandEnvTemplate } = await import('../user-config.js');
  const { getCredentialStore } = await import('../credentials/index.js');
  const def = getProviderNodeById(id);
  // B4: live capability keyed on the BOUND store (pullLiveModels resolves the
  // same way — one source, no live/catalog branch mismatch). P3-5: capability
  // only — listCredentials is masked, no raw key ever enters here.
  const store = await getCredentialStore();
  const inlineKey = expandEnvTemplate(def?.options?.apiKey);
  const liveCapable = Boolean(def?.options?.baseURL && (inlineKey || store.listCredentials(id).some((a) => a.routable)));
  return liveCapable ? pullLiveModels(id, opts) : pullCatalogModels(id, opts);
}

export interface ConnectedProviderBook {
  /** True when this call created the provider's defs node. */
  nodeCreated: boolean;
  /** Model defs written by the auto-fill (0 when the node already had models). */
  pulled: number;
  /** Best-effort fill failure — never fails the connect, surfaces as data. */
  fillError?: string;
}

/**
 * Connect-time doctrine: EVERY connected provider owns a defs node whose
 * models are the provider's universe. Called after a credential lands
 * (console connect, provider create, boot bind sweep):
 *
 *  1. Node absent → create it, seeding the effective baseURL from the explicit
 *     override or the aggregated catalog record (so live pull works uniformly —
 *     the historical credential-only class had no node to carry one).
 *  1b. Node PRESENT but carrying no `baseURL` → seed the same effective
 *     baseURL into it. This is not cosmetic: the boot bind deliberately creates
 *     BARE nodes (it must never wait on the aggregation), so on a hard cutover
 *     every legacy store-backed provider arrives here with a baseURL-less node,
 *     and the documented recovery gesture (re-connect without retyping the
 *     baseURL) would otherwise leave the node permanently unable to live-pull.
 *  2. Node has no models yet → auto-fill: live /v1/models first (baseURL +
 *     store key), static catalog fallback. A node that already has models is
 *     operator-owned truth — never re-filled here.
 *
 * Best-effort end to end: fill failures ride `fillError`, the caller's own
 * operation (connect/create/bind) always succeeds.
 */
export async function ensureConnectedProviderBook(
  id: string,
  opts: { baseURL?: string } = {}
): Promise<ConnectedProviderBook> {
  const { getProviderNodeById, getProviderModelDefs, upsertProviderDef } = await import('../user-config.js');
  let nodeCreated = false;
  // NOTE: getProviderNodeById reads the NORMALIZED view, which drops retired-
  // shape nodes (Decision 9) — a connect on such a provider deliberately
  // rebuilds it from the catalog (the key just went to the store; the boot
  // exclusion asked the operator to migrate). The bind sweep, by contrast,
  // checks the RAW file and never resurrects (see factory.ts).
  const existing = getProviderNodeById(id);
  // The catalog lookup is only paid for when a baseURL/name is actually needed
  // (node absent, or present-but-baseless) — an operator-owned node needs no
  // network on this path.
  let catalogName: string | undefined;
  let catalogNpm: string | undefined;
  let catalogBase: string | undefined;
  if ((!existing || !existing.options?.baseURL) && !opts.baseURL) {
    try {
      const { catalogRepository } = await import('./repository.js');
      const rec = await catalogRepository.getProvider(id);
      catalogName = rec?.name;
      catalogNpm = rec?.npm;
      catalogBase = rec?.baseURL || rec?.api;
    } catch {
      // catalog unavailable → node without baseURL; catalog-path fill still applies
    }
  }
  if (!existing) {
    const up = upsertProviderDef({ id, name: catalogName, npm: catalogNpm, baseURL: opts.baseURL || catalogBase });
    if (!up.success) return { nodeCreated: false, pulled: 0, fillError: up.error };
    nodeCreated = true;
  } else if (!existing.options?.baseURL) {
    // Baseless node (the bind sweep's shape). Merging, not rebuilding: every
    // other slot the operator owns (name/npm/headers/models/env/canonical/body)
    // rides through untouched.
    const baseURL = opts.baseURL || catalogBase;
    if (baseURL) {
      const up = upsertProviderDef({
        id,
        name: existing.name,
        npm: existing.npm,
        baseURL,
        headers: existing.options?.headers,
        models: existing.models,
        options: existing.options,
        env: existing.env,
        canonical: existing.canonical,
        body: existing.body,
      });
      if (!up.success) return { nodeCreated: false, pulled: 0, fillError: up.error };
    }
  }
  if (Object.keys(getProviderModelDefs(id) ?? {}).length > 0) {
    return { nodeCreated, pulled: 0 }; // operator-owned models — never re-filled
  }
  let res = await autoPullProvider(id, {});
  if (!res.body?.success) {
    res = await pullCatalogModels(id, {}); // static catalog fallback (live fetch failed)
  }
  return {
    nodeCreated,
    pulled: res.body?.pulled ?? 0,
    ...(res.body?.success ? {} : { fillError: String(res.body?.error ?? 'model auto-fill failed') }),
  };
}
