import { DEFAULT_CATALOG_SOURCES, type CatalogSourceConfig, type SourceMapConfig } from '../../../config/types.js';
import { normalizeModelsDev } from './models-dev.js';
import { normalizeOpenRouter } from './openrouter.js';
import type { CatalogModel, CatalogProviderRecord, CatalogCost, CatalogLimit, CatalogModalities } from '../types.js';

/**
 * Normalizer registry — the extension point for catalog sources.
 *
 * Adding a source of a KNOWN type is pure config (config.yaml `catalog.sources`).
 * A NEW response shape is onboarded with a DECLARATIVE field mapping
 * (type: 'custom' + map: SourceMapConfig — still pure config); registering a
 * hand-written normalizer here is only for shapes a field map cannot express.
 */

export interface RemoteSourceDef {
  id: string;
  type: CatalogSourceConfig['type'];
  url: string;
  enabled: boolean;
  priority: number;
  /** type: 'custom' only — declarative field mapping (see SourceMapConfig) */
  map?: SourceMapConfig;
}

export interface ParsedSource {
  providers?: CatalogProviderRecord[];
  models?: CatalogModel[];
}

/** /v1/models (OpenAI-compatible) — bare model ids, rarely any pricing. */
export function normalizeOpenAICompatible(raw: any): CatalogModel[] {
  const data: any[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  return data
    .filter((m) => m?.id)
    .map((m) => ({
      id: String(m.id),
      name: m.name || undefined,
      limit: { context: m.context_length ?? m.context_window ?? m.max_model_len },
      source: 'openai-compatible' as const,
    }));
}

/** dotted-path getter ('pricing.prompt' → raw.pricing.prompt) */
export function pickPath(obj: any, path: string): any {
  return String(path)
    .split('.')
    .reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function asNumber(v: any): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * type: 'custom' — DECLARATIVE mapping (SourceMapConfig) from an arbitrary
 * JSON payload to OCR standard fields. This is the zero-code extension point:
 * onboarding a new catalog shape = writing a mapping, not code.
 */
export function normalizeMapped(raw: any, map: SourceMapConfig): CatalogModel[] {
  const list = map.items ? pickPath(raw, map.items) : raw;
  if (!Array.isArray(list)) return [];
  const scale = typeof map.costScale === 'number' && map.costScale > 0 ? map.costScale : 1;
  const models: CatalogModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = pickPath(item, map.id);
    if (id === undefined || id === null || String(id).trim() === '') continue;
    const m: CatalogModel = { id: String(id), source: 'mapped' as const };
    if (map.name) {
      const name = pickPath(item, map.name);
      if (name !== undefined && name !== null && String(name).trim() !== '') m.name = String(name);
    }
    const cost: CatalogCost = {};
    for (const [k, path] of [
      ['input', map.inputCost],
      ['output', map.outputCost],
      ['cache_read', map.cacheReadCost],
      ['cache_write', map.cacheWriteCost],
    ] as const) {
      if (!path) continue;
      const v = asNumber(pickPath(item, path));
      if (v !== undefined) cost[k] = v * scale;
    }
    if (Object.keys(cost).length > 0) m.cost = cost;
    const limit: CatalogLimit = {};
    if (map.context) {
      const v = asNumber(pickPath(item, map.context));
      if (v !== undefined && v > 0) limit.context = v;
    }
    if (map.output) {
      const v = asNumber(pickPath(item, map.output));
      if (v !== undefined && v > 0) limit.output = v;
    }
    if (Object.keys(limit).length > 0) m.limit = limit;
    if (map.toolCall) m.tool_call = Boolean(pickPath(item, map.toolCall));
    if (map.reasoning) m.reasoning = Boolean(pickPath(item, map.reasoning));
    if (map.modalitiesInput || map.modalitiesOutput) {
      const input = map.modalitiesInput ? pickPath(item, map.modalitiesInput) : undefined;
      const output = map.modalitiesOutput ? pickPath(item, map.modalitiesOutput) : undefined;
      const mod: CatalogModalities = {};
      if (Array.isArray(input)) mod.input = input.map(String);
      if (Array.isArray(output)) mod.output = output.map(String);
      if (Object.keys(mod).length > 0) m.modalities = mod;
    }
    models.push(m);
  }
  return models;
}

const REGISTRY: Record<CatalogSourceConfig['type'], (raw: any, map?: SourceMapConfig) => ParsedSource> = {
  'provider-catalog': (raw) => ({ providers: normalizeModelsDev(raw) }),
  'model-list': (raw) => ({ models: normalizeOpenRouter(raw) }),
  'openai-compatible': (raw) => ({ models: normalizeOpenAICompatible(raw) }),
  custom: (raw, map) => ({ models: map ? normalizeMapped(raw, map) : [] }),
};

export function parseByType(type: CatalogSourceConfig['type'], raw: any, map?: SourceMapConfig): ParsedSource | null {
  const parse = REGISTRY[type];
  if (!parse) return null;
  try {
    return parse(raw, map);
  } catch {
    return null;
  }
}

export function isKnownSourceType(type: string): type is CatalogSourceConfig['type'] {
  return type === 'provider-catalog' || type === 'model-list' || type === 'openai-compatible' || type === 'custom';
}

/**
 * Configured sources, falling back to built-in defaults. DISABLED entries are
 * retained (enabled=false) so the console can list and re-enable them; callers
 * that only want active sources must filter on `enabled` themselves.
 */
export function resolveSources(cfg?: CatalogSourceConfig[]): RemoteSourceDef[] {
  const list = cfg && cfg.length > 0 ? cfg : DEFAULT_CATALOG_SOURCES;
  return list
    .filter((s) => s.id && s.type && s.url)
    .map((s) => ({
      id: s.id,
      type: s.type,
      url: s.url,
      enabled: s.enabled !== false,
      priority: typeof s.priority === 'number' ? s.priority : 50,
      map: s.map,
    }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
