import { writeCacheFile, readCacheFile } from '../cache.js';
import { CATALOG_USER_AGENT } from '../constants.js';
import { protocolIdFromNpm } from '../../provider-package.js';
import type { CatalogModel, CatalogProviderRecord, CatalogSourceState } from '../types.js';

/**
 * models.dev source — the same catalog OpenCode uses for `opencode auth login`.
 * Pricing arrives already in USD/1M tokens. Logos are static assets keyed by provider id.
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_NAME = 'catalog-models-dev';

export function modelsDevLogoUrl(providerId: string): string {
  return `https://models.dev/logos/${providerId}.svg`;
}

/** Pure normalizer (unit-tested without network). models.dev shape ≈ opencode schema. */
export function normalizeModelsDev(raw: Record<string, any>): CatalogProviderRecord[] {
  const list: CatalogProviderRecord[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;

    const models: CatalogModel[] = [];
    if (entry.models && typeof entry.models === 'object') {
      for (const [mid, m] of Object.entries<any>(entry.models)) {
        if (!m || typeof m !== 'object') continue;
        models.push({
          id: mid,
          name: m.name || undefined,
          // model-level protocol override; SDK package names → protocols[] below
          protocols:
            m.provider && typeof m.provider === 'object' && m.provider.npm
              ? [String(m.provider.npm)]
              : undefined,
          attachment: m.attachment === true || undefined,
          reasoning: m.reasoning === true || undefined,
          tool_call: m.tool_call === true || undefined,
          // Tri-state capability flag: true = confirmed supported / false =
          // explicitly unsupported (next-gen Claude etc.) / absent = no data.
          // Must NOT be written as `=== true || undefined` — that conflates
          // false with unknown, leaving the provider layer unable to strip the
          // param (upstream 400 "`temperature` is deprecated").
          temperature: m.temperature === true ? true : m.temperature === false ? false : undefined,
          reasoningOptions:
            Array.isArray(m.reasoning_options) && m.reasoning_options.length > 0
              ? m.reasoning_options
              : undefined,
          interleaved: m.interleaved && typeof m.interleaved === 'object' ? m.interleaved : undefined,
          structured_output: m.structured_output === true || undefined,
          status: m.status || undefined,
          // Passthrough display metadata — kept verbatim so the catalog is the
          // complete models.dev schema; consumers attach progressively.
          description: m.description || undefined,
          family: m.family || undefined,
          release_date: m.release_date || undefined,
          last_updated: m.last_updated || undefined,
          open_weights: m.open_weights === true || undefined,
          knowledge: m.knowledge || undefined,
          canonical_model_id: m.canonical_model_id || undefined,
          experimental: m.experimental && typeof m.experimental === 'object' ? m.experimental : undefined,
          modalities: m.modalities && typeof m.modalities === 'object' ? m.modalities : undefined,
          cost: m.cost && typeof m.cost === 'object' ? m.cost : undefined,
          limit: m.limit && typeof m.limit === 'object' ? m.limit : undefined,
          source: 'opencode',
        });
      }
    }

    list.push({
      id,
      name: entry.name || id,
      logo: modelsDevLogoUrl(id),
      protocols: entry.npm ? [String(entry.npm)] : undefined,
      api: entry.api || undefined,
      doc: entry.doc || undefined,
      env: Array.isArray(entry.env) ? entry.env : undefined,
      custom: false,
      connected: false,
      sources: ['opencode'],
      models,
    });
  }

  list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return withProtocolIds(list);
}

/** External npm / raw protocol strings become OCR `protocols: string[]`.
 *  Idempotent on already-canonical ids. Cache replays call this too, including
 *  caches a pre-protocols build wrote in the retired singular `npm` slot. */
export function withProtocolIds(providers: CatalogProviderRecord[]): CatalogProviderRecord[] {
  return providers.map((p) => {
    const legacyProvider = p as CatalogProviderRecord & { npm?: unknown };
    const rawProvider = p.protocols ?? (typeof legacyProvider.npm === 'string' ? [legacyProvider.npm] : []);
    const protocols = rawProvider
      .map((id) => protocolIdFromNpm(id) ?? id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const { npm: _legacyProviderNpm, ...provider } = legacyProvider;
    return {
      ...provider,
      protocols: protocols.length > 0 ? [...new Set(protocols)] : undefined,
      models: p.models.map((m) => {
        const legacyModel = m as CatalogModel & { npm?: unknown };
        const rawModel = m.protocols ?? (typeof legacyModel.npm === 'string' ? [legacyModel.npm] : []);
        const mp = rawModel
          .map((id) => protocolIdFromNpm(id) ?? id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const { npm: _legacyNpm, ...model } = legacyModel;
        return mp.length > 0 ? { ...model, protocols: [...new Set(mp)] } : { ...model, protocols: undefined };
      }),
    };
  });
}

/**
 * Sync models.dev: network → 24h cache → stale-on-error.
 * Returns the payload plus where it came from.
 */
export async function syncModelsDev(
  force = false,
  opts: { url?: string; cacheName?: string } = {}
): Promise<{ origin: 'network' | 'cache' | 'stale' | 'none'; providers: CatalogProviderRecord[] }> {
  const url = opts.url || MODELS_DEV_URL;
  const cacheName = opts.cacheName || CACHE_NAME;
  const cached = readCacheFile<CatalogProviderRecord[]>(cacheName);
  const fresh = cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000;

  if (!force && fresh && cached) {
    return { origin: 'cache', providers: withProtocolIds(cached.data) };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': CATALOG_USER_AGENT },
    });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const providers = normalizeModelsDev((await res.json()) as Record<string, any>);
    if (providers.length > 0) writeCacheFile(cacheName, providers);
    return { origin: providers.length > 0 ? 'network' : 'none', providers };
  } catch {
    if (cached) return { origin: 'stale', providers: withProtocolIds(cached.data) };
    return { origin: 'none', providers: [] };
  }
}

export function readModelsDevCache(cacheName: string = CACHE_NAME): CatalogSourceState<CatalogProviderRecord[]> | null {
  return readCacheFile<CatalogProviderRecord[]>(cacheName);
}
