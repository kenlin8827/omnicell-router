import { loadConfig } from '../../config/index.js';
import type { CatalogModel } from './types.js';

/**
 * Model pull engine for opencode.jsonc-defined (custom) providers.
 *
 * Two paths, chosen automatically by console routes AND the periodic
 * auto-pull scheduler (catalog.autoPullModels, default on):
 *  - live:     provider has baseURL + credential → pull its own /v1/models
 *  - catalog:  otherwise → static merged catalog (builtin → extensions)
 *
 * Both paths are ADD-ONLY: models already defined in opencode.jsonc are never
 * overwritten — locally maintained values stay source-proof.
 */

/** CatalogModel is already in the OpenCode schema — strip id/source, pass the rest through. */
export function catalogModelToDef(m: Record<string, any>): Record<string, any> {
  const def: Record<string, any> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'id' || k === 'source') continue;
    if (v === undefined) continue;
    // Flat catalog npm → opencode's model-level `provider: { npm }` override
    // (models.dev schema), so added models keep their exact wire shape.
    if (k === 'npm') {
      def.provider = { ...(def.provider || {}), npm: v };
      continue;
    }
    def[k] = v;
  }
  // Name fallback: bare /v1/models payloads carry no name — derive it from the
  // last '/' segment of the id (e.g. 'zhipu/glm-4.7' → 'glm-4.7').
  if (!def.name) def.name = String(m.id).split('/').pop();
  return def;
}

export interface PullResult {
  httpStatus: number;
  body: Record<string, any>;
}

export async function pullLiveModels(id: string, opts: { pattern?: string; dryRun?: boolean }): Promise<PullResult> {
  const { getProviderNodeById, getProviderModelDefs, upsertProviderModel, matchesGlobPattern, expandEnvTemplate } =
    await import('../user-config.js');
  const def = getProviderNodeById(id);
  if (!def) {
    return { httpStatus: 404, body: { success: false, error: `Provider '${id}' is not defined in opencode.jsonc` } };
  }
  const baseURL = def?.options?.baseURL;
  if (!baseURL) {
    return { httpStatus: 400, body: { success: false, error: `Provider '${id}' has no baseURL configured` } };
  }
  // ADR-0019 B4: raw key from the BOUND store (opencode v2 db / v1 auth.json / ocr
  // file) — direct auth.json reads would miss v2-managed and standalone
  // credentials.json keys. Inline precedence above the store kept (Decision 1).
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
  const matched = enriched.filter((m) => !pattern || matchesGlobPattern(pattern, m.id));
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

export async function pullCatalogModels(id: string, opts: { pattern?: string; dryRun?: boolean }): Promise<PullResult> {
  const { getProviderModelDefs, upsertProviderModel, matchesGlobPattern, getProviderNodeById } = await import('../user-config.js');
  const { catalogRepository } = await import('./repository.js');
  const provider = await catalogRepository.getProvider(id);
  if (!provider) {
    return { httpStatus: 404, body: { success: false, error: `Provider '${id}' not found in the model catalog` } };
  }
  const existing = getProviderModelDefs(id) || {};
  const pattern = opts.pattern?.trim();
  const matched = provider.models.filter((m) => !pattern || matchesGlobPattern(pattern, m.id));
  const pullable = matched.filter((m) => !(m.id in existing)); // never overwrite maintained defs
  // self-hosted gateways are absent from the static catalog — say so instead of a silent 0
  const notInCatalog = provider.sources.every((s) => s === 'config');
  const hint = notInCatalog && matched.length === 0 ? 'not-in-catalog' : undefined;
  if (opts.dryRun) {
    return { httpStatus: 200, body: { status: 'ok', matched: matched.length, pullable: pullable.length, models: pullable, hint } };
  }
  // Landing spot: providers with an opencode.jsonc node write there; CREDENTIAL-ONLY
  // providers (auth.json entry without a node) land in catalog/custom.json, which
  // feeds the aggregation as the 'custom' source.
  const hasNode = Boolean(getProviderNodeById(id));
  let pulled = 0;
  if (hasNode) {
    for (const m of pullable) {
      const result = upsertProviderModel(id, m.id, catalogModelToDef(m));
      if (!result.success) return { httpStatus: 400, body: result };
      pulled++;
    }
  } else {
    const { upsertCustomProviderModels } = await import('./custom-store.js');
    pulled = upsertCustomProviderModels(id, { name: provider.name, npm: provider.npm, api: provider.api }, pullable);
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
 * One auto-pull sweep over EVERY opencode.jsonc provider (ADD-ONLY per
 * provider). Gated by catalog.autoPullModels (default ON, checked live so the
 * console switch is hot). Failures are captured per provider — a sweep never
 * throws.
 */
export async function autoPullProviderModels(): Promise<AutoPullEntry[]> {
  if (loadConfig().catalog?.autoPullModels === false) return [];
  const { listOpenCodeProviders, expandEnvTemplate, getProviderNodeById } = await import('../user-config.js');
  // ADR-0019 B4: keys from the BOUND store (same rule as pullLiveModels —
  // inline above the store; the auth.json-direct read missed opencode v2 db and
  // standalone credentials.json keys).
  const { getCredentialStore } = await import('../credentials/index.js');
  const credStore = await getCredentialStore();

  // Phase 1 — concurrent FETCH (network only, no writes): resolve each
  // provider's candidate model list from its own /v1/models or the catalog.
  const jobs = await Promise.all(
    listOpenCodeProviders().map(async (v): Promise<{ id: string; mode: AutoPullEntry['mode']; models: CatalogModel[]; error?: string; meta?: { name?: string; npm?: string; api?: string } }> => {
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
          const pulled = normalizeOpenAICompatible(raw);
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
        models: provider.models,
        meta: { name: provider.name, npm: provider.npm, api: provider.api },
      };
    })
  );

  // Phase 2 — SERIAL WRITE: patchJsonc is a read-modify-write over the shared
  // opencode.jsonc, so model upserts must never run concurrently.
  const { getProviderModelDefs, upsertProviderModel } = await import('../user-config.js');
  const { upsertCustomProviderModels } = await import('./custom-store.js');
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
    const existing = getProviderModelDefs(job.id) || {};
    let pulled = 0;
    if (hasNode) {
      for (const m of job.models) {
        if (m.id in existing) continue; // ADD-ONLY: maintained defs are source-proof
        if (upsertProviderModel(job.id, m.id, catalogModelToDef(m)).success) pulled++;
      }
    } else {
      // credential-only provider (no jsonc node) → the custom store is the landing spot
      pulled = upsertCustomProviderModels(job.id, job.meta ?? {}, job.models.map((m) => ({ ...m, source: 'custom' as const })));
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
export async function autoPullProvider(id: string, opts: { pattern?: string; dryRun?: boolean } = {}): Promise<PullResult> {
  const { getProviderNodeById, expandEnvTemplate } = await import('../user-config.js');
  const { getCredentialStore } = await import('../credentials/index.js');
  // Credential-only providers (no jsonc node) are pullable too — they land in
  // catalog/custom.json (the 'custom' aggregation source).
  const def = getProviderNodeById(id);
  // B4: live capability keyed on the BOUND store (pullLiveModels resolves the
  // same way — one source, no live/catalog branch mismatch). P3-5: capability
  // only — listAccounts is masked, no raw key ever enters here.
  const store = await getCredentialStore();
  const inlineKey = expandEnvTemplate(def?.options?.apiKey);
  const liveCapable = Boolean(def?.options?.baseURL && (inlineKey || store.listAccounts(id).some((a) => a.routable)));
  return liveCapable ? pullLiveModels(id, opts) : pullCatalogModels(id, opts);
}
