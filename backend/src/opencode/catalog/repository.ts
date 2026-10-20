import { OpenCodeConnector } from '../connector.js';
import { listOpenCodeProviders, getProviderNodeById } from '../user-config.js';
import { getProviderDefsPath } from '../provider-defs.js';
import { BUILTIN_SOURCE_ID, type CatalogConfig, type CatalogSourceConfig, type SourceMapConfig } from '../../config/types.js';
import { resolveSources, parseByType, isKnownSourceType, type RemoteSourceDef, type ParsedSource } from './sources/registry.js';
import { modelsDevLogoUrl } from './sources/models-dev.js';
import { readCacheFile, writeCacheFile } from './cache.js';
import { readCustomStore, getCustomStorePath } from './custom-store.js';
import { readOverridesStore, getOverridesStorePath } from './overrides-store.js';
import { proxiedFetch } from '../../utils/proxy.js';
import { CATALOG_USER_AGENT } from './constants.js';
import { loadConfig, getConfigPath } from '../../config/index.js';
import { readOcrStore, writeOcrStore, getOcrStorePath } from './ocr-store.js';
import { ocrCredentialsFile } from '../credentials/paths.js';
import fs from 'node:fs';
import { localLogoApiPath } from './logos.js';
import type { CatalogModel, CatalogProviderRecord, CatalogSourceId } from './types.js';

/**
 * Config-driven multi-source catalog aggregator.
 *
 * Remote sources are declared in config.yaml (`catalog.sources`) — id/type/url/
 * enabled/priority — and dispatched through the normalizer registry. Adding a
 * source of a known type requires zero code changes.
 *
 * Merge semantics (fill-missing-only): sources are processed in ascending
 * `priority` — the `builtin` baseline (OpenCode's built-in catalog, models.dev)
 * first, then extension sources. Config definitions are established before all
 * remotes, so they win by order. A later source may only fill fields that are
 * absent / empty / zero; non-blank values are never overwritten. Every
 * provider/model keeps the `source` marker of its creating source.
 *
 * A DISABLED source is excluded from the aggregation (and from auto-sync)
 * entirely — its payload stays available to the console data viewer, and
 * manual refresh keeps working (updating only its per-source cache/view).
 */

const SERVICE_TTL_MS = 5 * 60 * 1000;
/** OpenRouter's official brand glyph (verified 200). */
const OPENROUTER_BRAND_LOGO = 'https://openrouter.ai/brand/v2/openrouter-glyph-light.svg';

/**
 * A value a later source may fill: absent, empty, or zero. Anything else is
 * "already known" and never overwritten — first non-blank value wins.
 */
export function isBlank(v: any): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function isPlainObject(v: any): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shape check: a cached payload must look like a ParsedSource (providers and/or models arrays). */
function looksLikeParsed(v: unknown): v is ParsedSource {
  return Boolean(
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    (Array.isArray((v as any).providers) || Array.isArray((v as any).models))
  );
}

/**
 * Fill-missing-only value merge: blank base → overlay; blank overlay → base;
 * two plain objects → recurse (nested containers like `cost`/`limit` merge per
 * field); otherwise the first non-blank value wins.
 */
export function mergeFillMissing(base: any, overlay: any): any {
  if (isBlank(base)) return overlay;
  if (isBlank(overlay)) return base;
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: any = { ...base };
    for (const [k, v] of Object.entries(overlay)) out[k] = mergeFillMissing(base[k], v);
    return out;
  }
  return base;
}

/**
 * Extension sources may only ENRICH existing model entries (fill-missing per
 * field) — never add new ones. The model universe is defined by config + the
 * builtin baseline; anything else is an overlay, not a source of truth.
 */
export function fillOnlyModels(base: CatalogModel[], overlay: CatalogModel[], locked?: Set<string>): CatalogModel[] {
  if (overlay.length === 0 || base.length === 0) return base;
  const byId = new Map(overlay.map((m) => [m.id, m]));
  return base.map((b) => (byId.has(b.id) ? mergeModels([b], [byId.get(b.id)!], locked)[0] : b));
}

/**
 * Union-merge model lists by id with fill-missing-only semantics: the first
 * source to set a field owns it (undefined / '' / 0 / empty container count as
 * unset); later sources only fill blanks, recursing into nested objects
 * (`cost`, `limit`). `source` stays the creating source.
 *
 * `locked` (catalog.lockedModels, bare model ids): a locked id that ALREADY has
 * a base entry is skipped entirely by overlays — its locally maintained values
 * stand as-is, INCLUDING explicit zeros (which fill-missing would otherwise
 * treat as unset and backfill from a remote source).
 */
export function mergeModels(base: CatalogModel[], overlay: CatalogModel[], locked?: Set<string>): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const m of base) byId.set(m.id, m);
  for (const m of overlay) {
    const existing = byId.get(m.id);
    if (!existing) {
      byId.set(m.id, m);
      continue;
    }
    if (locked?.has(m.id)) continue;
    const ocr: any = { ...existing };
    for (const [k, v] of Object.entries(m)) {
      if (k === 'source') continue;
      ocr[k] = mergeFillMissing((existing as any)[k], v);
    }
    byId.set(m.id, ocr as CatalogModel);
  }
  return Array.from(byId.values());
}

function addSource(sources: CatalogSourceId[], s: CatalogSourceId): CatalogSourceId[] {
  return sources.includes(s) ? sources : [...sources, s];
}

interface ServiceProbe {
  available: boolean;
  baseURLs: Map<string, string>;
}

interface RemoteState {
  def: RemoteSourceDef;
  parsed: ParsedSource;
  origin: 'network' | 'cache' | 'stale' | 'none';
  /** last successful sync (epoch ms) — fetch time from network, write time from cache */
  fetchedAt?: number;
  lastError?: string;
}

/** Console view of one catalog source: config def joined with its live sync state. */
export interface CatalogSourceView {
  id: string;
  type: CatalogSourceConfig['type'];
  url: string;
  enabled: boolean;
  priority: number;
  /** mandatory baseline (models.opencode.ai) — locked against removal/disabling */
  builtin: boolean;
  origin: RemoteState['origin'];
  fetchedAt?: number;
  lastError?: string;
  /** provider + model records currently ocr from this source */
  records: number;
}

/** Throw helper carrying an HTTP status for console routes. */
function sourceError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export class CatalogRepository {
  private remote = new Map<string, RemoteState>();
  private serviceProbe: ServiceProbe | null = null;
  private serviceProbedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connector: OpenCodeConnector | null = null;
  private sources: RemoteSourceDef[] = resolveSources();
  private intervalMs = 24 * 3600 * 1000;
  private started = false;
  // Static ocr-catalog store (catalog-ocr.json): the repository RUNS on
  // this materialized aggregation. list() serves the in-memory copy; a rebuild
  // happens only when a source sync lands or the signature (jsonc/config.yaml
  // mtimes + source defs + locked ids) drifts — then the store is rewritten.
  private ocr: CatalogProviderRecord[] | null = null;
  private ocrDirty = true;
  private ocrSig = '';

  /**
   * Apply config before start(). If `catalog.sources` is empty/omitted the
   * built-in defaults (openrouter, models.dev) are used.
   */
  applyConfig(catalog?: CatalogConfig): this {
    if (this.started) return this;
    if (catalog?.syncIntervalMs && catalog.syncIntervalMs > 0) this.intervalMs = catalog.syncIntervalMs;
    this.sources = resolveSources(catalog?.sources);
    return this;
  }

  /** Boot-time sync of every enabled source + periodic refresh. */
  async start(): Promise<void> {
    this.started = true;
    await Promise.all(this.enabledSources().map((def) => this.syncRemote(def)));
    // Disabled sources: hydrate the console viewer from their per-source disk
    // cache WITHOUT network — disabled means no auto-sync/aggregation, not
    // data loss; manual refresh stays available.
    for (const def of this.sources.filter((s) => !s.enabled)) {
      const cached = readCacheFile<ParsedSource>(`catalog/${def.id}`);
      if (looksLikeParsed(cached?.data) && cached) {
        this.applyRemote(def, cached.data, 'cache', cached.fetchedAt);
      }
    }
    this.resetTimer();
    // Materialize / load the static ocr store up front — if it exists and the
    // signature matches, boot runs on it with zero aggregation.
    await this.ensureOcrStore().catch(() => undefined);
    console.log(`[OCR] Catalog store: ${this.ocrLoadOrigin} (${this.ocr?.length ?? 0} providers) — ${getOcrStorePath()}`);
    // Auto-pull models for custom providers in the background (ADD-ONLY,
    // catalog.autoPullModels gated) — boot completes without waiting for it.
    void this.autoPullSafely();
  }

  /** Auto-pull sweep with full failure containment (scheduler + boot hook). */
  private async autoPullSafely(): Promise<void> {
    try {
      const { autoPullProviderModels } = await import('./auto-pull.js');
      const results = await autoPullProviderModels();
      const pulled = results.reduce((n, r) => n + r.pulled, 0);
      if (pulled > 0) {
        console.log(`[OCR] Auto model pull: +${pulled} models across ${results.filter((r) => r.pulled > 0).length} providers`);
      }
    } catch {
      // best effort — next sync period retries
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private enabledSources(): RemoteSourceDef[] {
    return this.sources.filter((s) => s.enabled);
  }

  get syncInterval(): number {
    return this.intervalMs;
  }

  private resetTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void Promise.all(this.enabledSources().map((def) => this.syncRemote(def)))
        .then(() => this.ensureOcrStore())
        .then(() => this.autoPullSafely())
        .catch(() => undefined);
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Hot-apply a new auto-sync period (ms) — resets the periodic timer at once. */
  setSyncInterval(ms: number): void {
    if (!Number.isFinite(ms) || ms < 60_000) {
      throw sourceError(400, 'syncIntervalMs must be a number >= 60000 (1 minute)');
    }
    this.intervalMs = Math.floor(ms);
    if (this.started) this.resetTimer();
  }

  get lastSyncOrigin(): string {
    return this.sources
      .map((def) => `${def.id}:${this.remote.get(def.id)?.origin ?? 'none'}`)
      .join(', ');
  }

  private async syncRemote(def: RemoteSourceDef, force = false): Promise<void> {
    // Per-source cache: ~/.cache/onecast-router/catalog/<sourceId>.json
    const cacheName = `catalog/${def.id}`;
    let cached = readCacheFile<ParsedSource>(cacheName);
    // One-shot migration from the pre-restructure flat names
    // (catalog-v2-<id>.json; the baseline source was id 'builtin' back then).
    if (!cached) {
      const legacyName = def.id === BUILTIN_SOURCE_ID ? 'catalog-v2-builtin' : `catalog-v2-${def.id}`;
      const legacy = readCacheFile<ParsedSource>(legacyName);
      if (legacy?.data) {
        writeCacheFile(cacheName, legacy.data);
        cached = legacy;
      }
    }
    // Shape validation: legacy caches (pre-repository) stored a bare array and
    // must NOT be treated as a valid ParsedSource.
    const cachedValid = looksLikeParsed(cached?.data);
    // `force` (manual console refresh) bypasses the freshness window and always
    // re-fetches from the network.
    const fresh = !force && cachedValid && cached && Date.now() - cached.fetchedAt < this.intervalMs;

    if (fresh && cached) {
      this.applyRemote(def, cached.data, 'cache', cached.fetchedAt);
      return;
    }

    try {
      const res = await proxiedFetch(def.url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': CATALOG_USER_AGENT },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseByType(def.type, await res.json(), def.map);
      if (!parsed) throw new Error(`no normalizer registered for type '${def.type}'`);
      const nonEmpty = (parsed.providers?.length || parsed.models?.length || 0) > 0;
      if (nonEmpty) writeCacheFile(cacheName, parsed);
      this.applyRemote(def, parsed, nonEmpty ? 'network' : 'none', Date.now(), nonEmpty ? undefined : 'payload contained no records');
    } catch (err: any) {
      const message = err?.message || String(err);
      if (cachedValid && cached) this.applyRemote(def, cached.data, 'stale', cached.fetchedAt, message);
      else this.applyRemote(def, {}, 'none', undefined, message);
    }
  }

  private applyRemote(
    def: RemoteSourceDef,
    parsed: ParsedSource,
    origin: RemoteState['origin'],
    fetchedAt?: number,
    lastError?: string,
  ): void {
    this.remote.set(def.id, { def, parsed, origin, fetchedAt, lastError });
    this.ocrDirty = true; // source data changed → ocr store needs a rebuild
  }

  // ── Console source management (runtime mutations; routes persist config.yaml) ──

  private findDef(id: string): RemoteSourceDef | undefined {
    return this.sources.find((s) => s.id === id);
  }

  /** All configured sources (INCLUDING disabled) joined with their live sync state. */
  sourceStates(): CatalogSourceView[] {
    return [...this.sources]
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((def) => {
        const st = this.remote.get(def.id);
        const parsed = st?.parsed ?? {};
        return {
          id: def.id,
          type: def.type,
          url: def.url,
          enabled: def.enabled,
          priority: def.priority,
          builtin: def.id === BUILTIN_SOURCE_ID,
          origin: st?.origin ?? 'none',
          fetchedAt: st?.fetchedAt,
          lastError: st?.lastError,
          records: (parsed.providers?.length || 0) + (parsed.models?.length || 0),
        };
      });
  }

  private stateOf(id: string): CatalogSourceView {
    const view = this.sourceStates().find((s) => s.id === id);
    if (!view) throw sourceError(500, `catalog source '${id}' vanished after mutation`);
    return view;
  }

  /**
   * Register a new source and sync it immediately (force, no cache shortcut).
   * Persisting the updated list to config.yaml is the caller's job (console route).
   */
  async addSource(input: {
    id: string;
    type: string;
    url: string;
    priority?: number;
    enabled?: boolean;
    map?: SourceMapConfig;
  }): Promise<CatalogSourceView> {
    const id = String(input.id || '').trim().toLowerCase();    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) {
      throw sourceError(400, `invalid source id '${input.id}' (2-64 chars: a-z 0-9 . _ -)`);
    }
    if (id === BUILTIN_SOURCE_ID) {
      throw sourceError(403, `'${BUILTIN_SOURCE_ID}' is the mandatory baseline source and cannot be redefined`);
    }
    if (!isKnownSourceType(String(input.type || ''))) {
      throw sourceError(400, `unknown source type '${input.type}'`);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.url);
    } catch {
      throw sourceError(400, `invalid source url '${input.url}'`);
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw sourceError(400, 'source url must be http(s)');
    }
    if (this.findDef(id)) {
      throw sourceError(409, `catalog source '${id}' already exists`);
    }
    if (input.type === 'custom' && (!input.map || !input.map.id)) {
      throw sourceError(400, `type 'custom' requires a field mapping (map.id is required)`);
    }
    const def: RemoteSourceDef = {
      id,
      type: input.type as CatalogSourceConfig['type'],
      url: String(input.url).trim(),
      enabled: input.enabled !== false,
      priority:
        typeof input.priority === 'number' && input.priority >= 1 && input.priority <= 999
          ? Math.floor(input.priority)
          : 50,
      map: input.map,
    };
    this.sources.push(def);
    if (def.enabled) await this.syncRemote(def, true);
    return this.stateOf(id);
  }

  /** Remove a source at runtime (baseline is locked). Caller persists config.yaml. */
  removeSource(id: string): void {
    if (id === BUILTIN_SOURCE_ID) {
      throw sourceError(403, 'the baseline catalog source is mandatory and cannot be removed');
    }
    const idx = this.sources.findIndex((s) => s.id === id);
    if (idx === -1) throw sourceError(404, `catalog source '${id}' not found`);
    this.sources.splice(idx, 1);
    this.remote.delete(id);
  }

/**
 * Enable/disable at runtime. Disabled = excluded from the OCR aggregation
 * only: the in-memory payload is RETAINED for the console data viewer and
 * manual refresh keeps working (no auto-sync, no boot network for it).
 * Caller persists.
 */
async setSourceEnabled(id: string, enabled: boolean): Promise<CatalogSourceView> {
    const def = this.findDef(id);
    if (!def) throw sourceError(404, `catalog source '${id}' not found`);
    if (id === BUILTIN_SOURCE_ID && !enabled) {
      throw sourceError(403, 'the baseline catalog source is mandatory and cannot be disabled');
    }
    def.enabled = enabled;
    if (enabled) await this.syncRemote(def, true);
    return this.stateOf(id);
  }

  /**
   * Force a network re-sync of one source right now (bypasses cache freshness).
   * Works for DISABLED sources too — data lands in the per-source cache and
   * the console viewer, but never enters the OCR aggregation while disabled.
   */
  async refreshSource(id: string): Promise<CatalogSourceView> {
    const def = this.findDef(id);
    if (!def) throw sourceError(404, `catalog source '${id}' not found`);
    await this.syncRemote(def, true);
    await this.ensureOcrStore();
    await this.autoPullSafely(); // source data changed → custom providers may gain models
    return this.stateOf(id);
  }

  /**
   * Force a network re-sync of every source (console "refresh all") — disabled
   * sources included: refresh updates only their per-source cache/view, the
   * aggregation still skips them while disabled.
   */
  async refreshAll(): Promise<void> {
    await Promise.all(this.sources.map((def) => this.syncRemote(def, true)));
    await this.ensureOcrStore();
    await this.autoPullSafely();
  }

  /**
   * In-memory parsed payload of one source — exactly what the console data
   * viewer shows (identical to the on-disk catalog/<id>.json `data` field).
   */
  sourceData(id: string): {
    source: CatalogSourceView;
    fetchedAt?: number;
    providers?: CatalogProviderRecord[];
    models?: CatalogModel[];
  } {
    const def = this.findDef(id);
    if (!def) throw sourceError(404, `catalog source '${id}' not found`);
    const st = this.remote.get(id);
    const parsed = st?.parsed ?? {};
    return {
      source: this.stateOf(id),
      fetchedAt: st?.fetchedAt,
      providers: parsed.providers ?? [],
      models: parsed.models ?? [],
    };
  }

  /** Runtime defs (including disabled) — console routes persist these to config.yaml. */
  configuredSources(): RemoteSourceDef[] {
    return this.sources.map((d) => ({ ...d }));
  }

  /** Remote entries producing model lists (ENABLED only), ascending priority. */
  private modelSources(): RemoteState[] {
    return [...this.remote.values()]
      .filter((r) => r.def.enabled && Array.isArray(r.parsed.models) && r.parsed.models!.length > 0)
      .sort((a, b) => a.def.priority - b.def.priority);
  }

  /** OpenRouter-style `vendor/model` → vendor → models (first writer wins per id). */
  private demuxByVendor(): Map<string, CatalogModel[]> {
    const map = new Map<string, CatalogModel[]>();
    for (const src of this.modelSources()) {
      for (const m of src.parsed.models!) {
        const slash = m.id.indexOf('/');
        if (slash <= 0) continue;
        const vendor = m.id.slice(0, slash);
        if (!map.has(vendor)) map.set(vendor, []);
        map.get(vendor)!.push({ ...m, id: m.id.slice(slash + 1) });
      }
    }
    return map;
  }

  private configModelsFor(id: string): CatalogModel[] {
    const node = getProviderNodeById(id);
    if (!node?.models || typeof node.models !== 'object') return [];
    // Config defs use the OpenCode v2 schema (`capabilities{tools,input,output}`);
    // CatalogModel is the snake_case models.dev view (`tool_call`, `modalities`).
    // Normalize v2 → snake_case fill-missing-style so view consumers (e.g. the
    // /models capability column) see one shape; explicit snake_case fields and
    // `capabilities` itself are kept untouched.
    return Object.entries<any>(node.models).map(([mid, m]) => {
      const def = m && typeof m === 'object' ? m : {};
      const caps = def.capabilities && typeof def.capabilities === 'object' ? def.capabilities : {};
      const modalities: Record<string, string[]> = {
        ...(Array.isArray(caps.input) && caps.input.length > 0
          ? { input: caps.input.map((x: any) => String(x)) }
          : {}),
        ...(Array.isArray(caps.output) && caps.output.length > 0
          ? { output: caps.output.map((x: any) => String(x)) }
          : {}),
      };
      return {
        ...def,
        tool_call: def.tool_call ?? (typeof caps.tools === 'boolean' ? caps.tools : undefined),
        reasoning: def.reasoning ?? (caps.reasoning === true || undefined),
        modalities:
          Object.keys(modalities).length > 0
            ? { ...modalities, ...(isPlainObject(def.modalities) ? def.modalities : {}) }
            : def.modalities,
        id: mid,
        source: 'config' as const,
      };
    });
  }

  /** Unified, management-safe catalog view (no secrets). Served from the static ocr store. */
  async list(): Promise<CatalogProviderRecord[]> {
    return this.ensureOcrStore();
  }

  /**
   * Aggregation signature: everything that can change the ocr result OUTSIDE
   * a source sync — provider-defs file edits (providers/models), and
   * config.yaml edits (catalog.sources CRUD, lockedModels). Source data itself
   * flips ocrDirty via applyRemote().
   */
  private ocrSignature(): string {
    const mtime = (p?: string): number => {
      try {
        return p && fs.existsSync(p) ? Math.round(fs.statSync(p).mtimeMs) : 0;
      } catch {
        return 0;
      }
    };
    const srcs = this.sources.map((s) => `${s.id}:${s.url}:${s.enabled}:${s.priority}`).join('|');
    // Per-source fetchedAt: when a sync lands newer source data (auto refresh
    // included), the signature drifts and the store is rebuilt — never served
    // stale against fresher per-source caches.
    const fetched = this.sources.map((s) => `${s.id}:${this.remote.get(s.id)?.fetchedAt ?? 0}`).join('|');
    const locked = (loadConfig().catalog?.lockedModels ?? []).join(',');
    const customMtime = mtime(getCustomStorePath());
    const overridesMtime = mtime(getOverridesStorePath());
    // The defs file replaced opencode.jsonc as the def truth: its mtime drives
    // the rebuild, and the jsonc mtime stays OUT — a materialization rewrite
    // must not look like a source change. The credentials file is IN: `connected`
    // is derived from bound-store credential presence (see aggregate step 4b),
    // so a key add/remove must drift the signature or the store serves the old
    // connected flags until restart.
    const defsMtime = mtime(getProviderDefsPath());
    return `${defsMtime}:${mtime(getConfigPath())}:${srcs}:${fetched}:${locked}:${customMtime}:${overridesMtime}:${mtime(ocrCredentialsFile())}`;
  }

  private ocrLoadOrigin = 'not-built';

  /**
   * Serve the ocr catalog from the in-memory copy, lazily rebuilding from
   * (a) the static store when its signature matches, else (b) a fresh
   * aggregation that is then materialized to catalog-ocr.json.
   */
  async ensureOcrStore(): Promise<CatalogProviderRecord[]> {
    const sig = this.ocrSignature();
    if (this.ocr && !this.ocrDirty && sig === this.ocrSig) return this.ocr;

    // Cold start (no in-memory copy yet): the repository RUNS on the static
    // store when it exists and its signature still matches the environment.
    if (!this.ocr) {
      const store = readOcrStore();
      if (store && store.sig === sig) {
        this.ocr = store.providers;
        this.ocrSig = sig;
        this.ocrDirty = false;
        this.ocrLoadOrigin = 'loaded-from-store';
        return this.ocr;
      }
    }

    const providers = await this.aggregate();
    this.ocr = providers;
    this.ocrDirty = false;
    this.ocrSig = sig;
    this.ocrLoadOrigin = this.ocrLoadOrigin === 'not-built' ? 'generated' : 'rebuilt';
    writeOcrStore(sig, providers);
    return providers;
  }

  private async aggregate(): Promise<CatalogProviderRecord[]> {
    // catalog.lockedModels — locally anchored models whose maintained values
    // (including explicit zero prices, which fill-missing would backfill) are
    // never overwritten by any remote source. Entries are fully-qualified
    // 'providerId||modelId' keys; bare model ids (legacy) lock across providers.
    // Read live from config.yaml so console changes apply on the next
    // aggregation without a restart.
    const lockedRaw = loadConfig().catalog?.lockedModels ?? [];
    const isLocked = (providerId: string, modelId: string): boolean =>
      lockedRaw.includes(`${providerId}||${modelId}`) || lockedRaw.includes(modelId);
    const lockedFor = (providerId: string): Set<string> => {
      const own = lockedRaw
        .filter((k) => k.startsWith(`${providerId}||`))
        .map((k) => k.slice(providerId.length + 2));
      return new Set([...own, ...lockedRaw.filter((k) => !k.includes('||'))]);
    };
    const unified = new Map<string, CatalogProviderRecord>();

    // 1. opencode user data (config definitions + credentials) — real-time, top precedence
    for (const v of listOpenCodeProviders()) {
      unified.set(v.id, {
        id: v.id,
        name: v.name,
        npm: v.npm,
        baseURL: v.baseURL,
        custom: v.custom,
        connected: v.auth.connected,
        sources: ['config'],
        models: this.configModelsFor(v.id),
      });
    }

    // 1b. custom store — models pulled for credential-only providers (no jsonc
    // node to write into; e.g. live /v1/models of a self-hosted gateway). Inserted
    // AFTER the builtin baseline: entry-creating for providers the catalog lacks,
    // fill-missing-only for those it already covers. sources tag: 'custom'.
    const customStore = readCustomStore();
    if (customStore) {
      for (const [pid, entry] of Object.entries(customStore.providers)) {
        if (!entry.models || entry.models.length === 0) continue;
        const record: CatalogProviderRecord = {
          id: pid,
          name: entry.name,
          npm: entry.npm,
          api: entry.api,
          custom: true,
          connected: false,
          sources: ['custom'],
          models: entry.models.map((m) => ({ ...m, source: 'custom' as const })),
        };
        const existing = unified.get(pid);
        if (!existing) {
          unified.set(pid, record);
          continue;
        }
        existing.name = existing.name || entry.name;
        existing.npm = existing.npm || entry.npm;
        existing.api = existing.api || entry.api;
        existing.sources = addSource(existing.sources, 'custom');
        existing.models = mergeModels(existing.models, record.models, lockedFor(pid));
      }
    }

    const orByVendor = this.demuxByVendor();

    // 2. provider-catalog sources (ascending priority; builtin is the baseline):
    //    later sources only fill blanks on existing records (config was first).
    //    DISABLED sources are skipped — their data stays viewer-only.
    for (const src of [...this.remote.values()]
      .filter((r) => r.def.enabled && Array.isArray(r.parsed.providers) && r.parsed.providers!.length > 0)
      .sort((a, b) => a.def.priority - b.def.priority)) {
      const isBaseline = src.def.id === BUILTIN_SOURCE_ID;
      for (const md of src.parsed.providers!) {
        const existing = unified.get(md.id);
        if (!existing) {
          // Provider records may be created by any provider-catalog source, but
          // model ENTRIES only by the builtin baseline (config came earlier and
          // keeps priority through fill-missing order).
          unified.set(md.id, { ...md, models: isBaseline ? md.models : [] });
          continue;
        }
        existing.name = existing.name || md.name;
        existing.logo = existing.logo || md.logo;
        existing.api = existing.api || md.api;
        existing.doc = existing.doc || md.doc;
        existing.env = existing.env || md.env;
        existing.sources = addSource(existing.sources, src.def.id as CatalogSourceId);
        if (isBaseline) existing.models = mergeModels(existing.models, md.models, lockedFor(existing.id));
      }
    }

    // 3. model-list sources: enrich EXISTING providers/models only (fill-missing),
    //    never add model entries — builtin + config define the model universe.
    const ownRecordDone = new Set<string>();
    for (const src of this.modelSources()) {
      const sourceId = src.def.id as CatalogSourceId;
      for (const [vendor, models] of orByVendor) {
        const rec = unified.get(vendor);
        if (!rec) continue;
        rec.sources = addSource(rec.sources, sourceId);
        rec.models = fillOnlyModels(rec.models, models, lockedFor(rec.id));
      }
      // First-party record for the source itself (e.g. 'openrouter')
      if (!ownRecordDone.has(src.def.id)) {
        ownRecordDone.add(src.def.id);
        const rec = unified.get(src.def.id);
        const models = src.parsed.models!;
        if (rec) {
          rec.models = fillOnlyModels(rec.models, models, lockedFor(rec.id));
          rec.sources = addSource(rec.sources, sourceId);
          if (src.def.id === 'openrouter') rec.logo = OPENROUTER_BRAND_LOGO;
        } else {
          unified.set(src.def.id, {
            id: src.def.id,
            name: src.def.id,
            logo: src.def.id === 'openrouter' ? OPENROUTER_BRAND_LOGO : modelsDevLogoUrl(src.def.id),
            custom: false,
            connected: false,
            sources: [sourceId],
            models: [], // extension source — no model entries of its own
          });
        }
      }
    }

    // 3d. cross-provider bare-id inheritance: a model whose pricing is missing
    // or zero (plan-type providers carry all-zero rows) inherits reference
    // values from OTHER providers' entries with the same bare id (last '/'
    // segment), info-richest first. Field-level fill-missing: own values win.
    const byBare = new Map<string, Array<CatalogModel & { __pid: string }>>();
    for (const rec of unified.values()) {
      for (const m of rec.models) {
        const bare = m.id.slice(m.id.lastIndexOf('/') + 1).toLowerCase();
        const entry: CatalogModel & { __pid: string } = { ...m, cost: m.cost ? { ...m.cost } : undefined, limit: m.limit ? { ...m.limit } : undefined, modalities: m.modalities ? { ...m.modalities } : undefined, __pid: rec.id };
        const arr = byBare.get(bare);
        if (arr) arr.push(entry);
        else byBare.set(bare, [entry]);
      }
    }
    const posNum = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
    const infoOf = (m: CatalogModel): number => {
      let s = 0;
      if (m.name) s += 1;
      if (posNum(m.cost?.input)) s += 2;
      if (posNum(m.cost?.output)) s += 2;
      if (posNum(m.limit?.context)) s += 1;
      if (m.modalities?.input?.length || m.modalities?.output?.length) s += 1;
      return s;
    };
    for (const rec of unified.values()) {
      for (const m of rec.models) {
        if (isLocked(rec.id, m.id)) continue; // anchored: source data may not touch it
        const bare = m.id.slice(m.id.lastIndexOf('/') + 1).toLowerCase();
        const cands = (byBare.get(bare) ?? [])
          .filter((o) => o.__pid !== rec.id)
          .sort((a, b) => infoOf(b) - infoOf(a));
        if (cands.length === 0) continue;
        m.cost = { ...(m.cost ?? {}) };
        m.limit = { ...(m.limit ?? {}) };
        for (const hit of cands) {
          for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
            if (posNum(m.cost[k]) === undefined && posNum(hit.cost?.[k]) !== undefined) m.cost[k] = posNum(hit.cost?.[k]);
          }
          for (const k of ['context', 'output'] as const) {
            if (posNum(m.limit[k]) === undefined && posNum(hit.limit?.[k]) !== undefined) m.limit[k] = posNum(hit.limit?.[k]);
          }
          if (!m.name) m.name = hit.name;
          if (!m.modalities?.input?.length && !m.modalities?.output?.length && hit.modalities) m.modalities = hit.modalities;
          if (m.tool_call === undefined && hit.tool_call !== undefined) m.tool_call = hit.tool_call;
          if (m.reasoning === undefined && hit.reasoning !== undefined) m.reasoning = hit.reasoning;
        }
        if (!Object.values(m.cost).some((v) => v !== undefined)) delete m.cost;
        if (m.limit.context === undefined && m.limit.output === undefined) delete m.limit;
      }
    }

    // 3e. aggregate overrides — field-level edits made in the OCR Catalog viewer,
    // applied LAST so they always win over sourced values. This is a separate
    // editing plane from defs-file definitions (provider layer).
    const overrides = readOverridesStore();
    if (overrides) {
      for (const [key, entry] of Object.entries(overrides.models)) {
        const sep = key.indexOf('||');
        if (sep <= 0) continue;
        const rec = unified.get(key.slice(0, sep));
        const model = rec?.models.find((x) => x.id === key.slice(sep + 2));
        if (!model) continue;
        if (entry.name !== undefined) model.name = entry.name;
        if (entry.cost) model.cost = { ...(model.cost ?? {}), ...entry.cost };
        if (entry.limit) model.limit = { ...(model.limit ?? {}), ...entry.limit };
        if (entry.modalities) model.modalities = entry.modalities;
        if (entry.tool_call !== undefined) model.tool_call = entry.tool_call;
        if (entry.reasoning !== undefined) model.reasoning = entry.reasoning;
        if (entry.temperature !== undefined) model.temperature = entry.temperature;
        if (entry.disabled !== undefined) model.disabled = entry.disabled;
        if (entry.reasoningEfforts !== undefined) {
          model.reasoningOptions =
            entry.reasoningEfforts.length > 0
              ? [{ type: 'effort', values: [...entry.reasoningEfforts] }]
              : [{ type: 'toggle' }]; // empty = no explicit level control
        }
        if (entry.npm !== undefined) model.npm = entry.npm;
        if (entry.defaultEffort !== undefined) {
          if (entry.defaultEffort === null) delete model.defaultEffort; // clear → follow catalog/def
          else model.defaultEffort = entry.defaultEffort;
        }
        if (entry.variants !== undefined) {
          // UI short shape → def shape; effort-less entries are dropped (they
          // contribute nothing routable — see boot-direct routableVariants).
          model.variants = entry.variants
            .filter((v) => v.id && v.effort)
            .map((v) => ({ id: v.id, settings: { reasoningEffort: v.effort } }));
        }
      }
    }

    // 4. live service baseURL hints (effective routing endpoints)
    const service = await this.probeService();
    if (service.available) {
      for (const [id, baseURL] of service.baseURLs) {
        const rec = unified.get(id);
        if (!rec) continue;
        rec.baseURL = rec.baseURL || baseURL;
        rec.sources = addSource(rec.sources, 'service');
      }
    }

    // 4b. bound-store credential presence → `connected`. The store is the single
    // credential truth; auth.json is a frozen migration snapshot and inline defs
    // keys are the exception, so steps 1/1b/2 systematically under-report — a
    // provider routing fine on a store credential would read disconnected here.
    // Any stored credential (same rule the provider grid applies) marks the
    // provider connected; an unreadable store degrades to the sourced flag.
    try {
      const { getCredentialStore } = await import('../credentials/index.js');
      const store = await getCredentialStore();
      const storeConnected = new Set(store.credentialsOverview().map((o) => o.providerId));
      if (storeConnected.size > 0) {
        for (const rec of unified.values()) {
          if (storeConnected.has(rec.id)) rec.connected = true;
        }
      }
    } catch {
      // store unreadable / not bound yet — keep the auth.json + inline-derived flag
    }

    // 5. serve logos through the local disk-cache proxy (offline-safe page loads)
    return Array.from(unified.values())
      .map((rec) => {
        // custom = user-defined/self-hosted provider: an explicit jsonc definition
        // OR not covered by any remote catalog source (zhipu, private relays, …).
        // Catalog-covered providers (zhipuai-coding-plan, openrouter, …) are not.
        const catalogCovered = rec.sources.includes('opencode') || rec.sources.includes('models-dev');
        return { ...rec, logo: localLogoApiPath(rec.logo), custom: rec.custom || !catalogCovered };
      })
      .sort(
        (a, b) =>
          Number(b.custom || b.connected) - Number(a.custom || a.connected) ||
          (a.name || '').localeCompare(b.name || '')
      );
  }

  async getProvider(id: string): Promise<CatalogProviderRecord | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  /** Cheapest known input price ($/1M); negative promo prices are ignored. */
  minInputPrice(rec: CatalogProviderRecord): number | undefined {
    const prices = rec.models
      .map((m) => m.cost?.input)
      .filter((v): v is number => typeof v === 'number' && v >= 0);
    return prices.length > 0 ? Math.min(...prices) : undefined;
  }

  private async probeService(): Promise<ServiceProbe> {
    if (this.serviceProbe && Date.now() - this.serviceProbedAt < SERVICE_TTL_MS) {
      return this.serviceProbe;
    }
    const probe: ServiceProbe = { available: false, baseURLs: new Map() };
    try {
      if (!this.connector) this.connector = new OpenCodeConnector();
      if (this.connector.isAvailable()) {
        const providers = await this.connector.getProviders();
        for (const p of providers) {
          const baseURL = p?.settings?.baseURL;
          if (p?.id && typeof baseURL === 'string') probe.baseURLs.set(p.id, baseURL);
        }
        probe.available = true;
      }
    } catch {
      // service offline — keep cached negative result for the TTL window
    }
    this.serviceProbe = probe;
    this.serviceProbedAt = Date.now();
    return probe;
  }
}

/** Process-wide singleton (scheduler runs once per gateway). */
export const catalogRepository = new CatalogRepository();
