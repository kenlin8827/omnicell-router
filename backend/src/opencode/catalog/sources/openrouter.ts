import { writeCacheFile, readCacheFile } from '../cache.js';
import { CATALOG_USER_AGENT } from '../constants.js';
import type { CatalogModel, CatalogProviderRecord } from '../types.js';

/**
 * OpenRouter source — first-party model catalog with live pricing.
 * https://openrouter.ai/api/v1/models (public, no auth)
 *
 * NOTE: OpenRouter pricing is USD per TOKEN (string decimals) — converted to
 * the repository-wide USD per 1M convention here (×1e6).
 */

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_NAME = 'catalog-openrouter';
export const OPENROUTER_PROVIDER_ID = 'openrouter';

function toPerMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n * 1e6 : undefined;
}

/** Pure normalizer (unit-tested without network). */
export function normalizeOpenRouter(raw: { data?: any[] }): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const m of raw?.data ?? []) {
    if (!m?.id) continue;
    const params: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    models.push({
      id: m.id,
      name: m.name || undefined,
      reasoning: params.includes('reasoning') || undefined,
      tool_call: params.includes('tools') || undefined,
      // OpenRouter's supported_parameters containing `temperature` IS a support
      // declaration; absence may mean "not declared" rather than "explicitly
      // unsupported", so emit only true — false's authoritative source is the
      // baseline catalog.
      temperature: params.includes('temperature') || undefined,
      limit: {
        context: m.context_length ?? m.top_provider?.context_length,
        output: m.top_provider?.max_completion_tokens,
      },
      cost: {
        input: toPerMillion(m.pricing?.prompt),
        output: toPerMillion(m.pricing?.completion),
        cache_read: toPerMillion(m.pricing?.input_cache_read ?? m.pricing?.internal_cache),
      },
      source: 'openrouter',
    });
  }
  return models;
}

export async function syncOpenRouter(
  force = false,
  opts: { url?: string; cacheName?: string } = {}
): Promise<{ origin: 'network' | 'cache' | 'stale' | 'none'; models: CatalogModel[] }> {
  const url = opts.url || OPENROUTER_MODELS_URL;
  const cacheName = opts.cacheName || CACHE_NAME;
  const cached = readCacheFile<CatalogModel[]>(cacheName);
  const fresh = cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000;

  if (!force && fresh && cached) {
    return { origin: 'cache', models: cached.data };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': CATALOG_USER_AGENT },
    });
    if (!res.ok) throw new Error(`openrouter HTTP ${res.status}`);
    const models = normalizeOpenRouter((await res.json()) as { data?: any[] });
    if (models.length > 0) writeCacheFile(cacheName, models);
    return { origin: models.length > 0 ? 'network' : 'none', models };
  } catch {
    if (cached) return { origin: 'stale', models: cached.data };
    return { origin: 'none', models: [] };
  }
}
