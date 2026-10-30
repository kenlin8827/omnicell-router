import { probeMarketplace, marketplaceSourceId, validateSlug, addMarketplaceEntry, removeMarketplace } from '../market/marketplaces.js';
import { indexSources, harvestAll, queryIndex, readIndex } from './catalog.js';
import { federatedSections, federatedIdsFor } from './federated.js';
import { browseSource } from '../market/browse.js';
import type { MarketItem } from '../market/browse.js';
import { SOURCES_VIEW_LOOKUP } from '../market/source-views.js';
import { getHostAdapter } from '../host/index.js';
import type { InstallChannel } from '../host/request.js';
import type { CatalogRow, CatalogPage, CatalogSort, CatalogSource, PluginAdapter } from './types.js';
import type { HarnessHostId } from '../types.js';
import type { InstallResult } from '../host/install.js';

/**
 * Per-harness plugin adapters (ADR-0015 §D10). The identity IS the support declaration — there is
 * no `supported()` predicate: an adapter existing means the harness is served, the landing check
 * happens at install time, and row-level compatibility travels on `CatalogRow.hosts`.
 *
 * Three concrete adapters ship:
 *  - `ClaudePluginAdapter`    — claude: operator git marketplaces (index tier) only; no federated
 *                               plugin directory serves claude today, so the tier is empty.
 *  - `PiPluginAdapter`        — pi: operator git marketplaces (index tier) + the official pi.dev
 *                               catalog as the federated tier.
 *  - `PiOfficialPluginAdapter`— pi, read-only: ONLY the official pi.dev catalog, live. No operator
 *                               source registry, no index store — a pure federated surface.
 */

/** Query bounds: fan-out concurrency cap and per-source timeout — the facade owns the latency ceiling. */
const PAGE_DEFAULT = 24;

function clampPage(opts: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  return {
    page: Math.max(1, Math.floor(opts.page ?? 1)),
    pageSize: Math.min(Math.max(1, Math.floor(opts.pageSize ?? PAGE_DEFAULT)), 100),
  };
}

export class PluginMarketAdapter implements PluginAdapter {
  constructor(
    readonly harness: HarnessHostId,
    protected readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The federated source ids this adapter asks. Default: every plugin-kind view whose declared
   *  hosts cover this harness; concrete adapters narrow further. */
  protected federatedIds(): string[] {
    return federatedIdsFor(this.harness);
  }

  sources(): CatalogSource[] {
    return indexSources(this.harness);
  }

  async search(q: string, opts: { page?: number; pageSize?: number; sort?: CatalogSort } = {}): Promise<CatalogPage> {
    const { page, pageSize } = clampPage(opts);
    const sort = opts.sort ?? 'name';
    const { rows, total } = queryIndex(this.harness, q, { page, pageSize, sort });
    const notes: string[] = [];
    if (sort === 'stars' && readIndex(this.harness).every((r) => r.stars === null)) {
      notes.push('no source in this catalog carries a trustworthy star count');
    }
    // Federated tier: per-source sections in the source's own native order — never interleaved
    // into the sorted rows (§D10 co-ordering honesty). A timeout degrades that section, not the page.
    const sections = await federatedSections(this.harness, q, { page, pageSize }, this.fetchImpl, this.federatedIds());
    for (const s of sections) if (s.note) notes.push(`${s.label}: ${s.note}`);
    return { rows, page, pageSize, hasMore: page * pageSize < total, total, notes, sections };
  }

  async checkSource(url: string): Promise<{ ok: boolean; skills: number; mcps: number; plugins: number; message?: string }> {
    const repo = repoFromUrl(url);
    if (!repo) return { ok: false, skills: 0, mcps: 0, plugins: 0, message: `not a GitHub repository URL: '${url}'` };
    const outcome = await probeMarketplace(tempEntry(slugFromRepo(repo), repo), this.fetchImpl, { persist: false });
    if (!outcome.ok) return { ok: false, skills: 0, mcps: 0, plugins: 0, message: outcome.message };
    return { ok: true, skills: outcome.snapshot.rows.length, mcps: 0, plugins: outcome.snapshot.plugins.length };
  }

  async registerSource(url: string, opts?: { rescan?: { enabled?: boolean; intervalMs?: number } }): Promise<{ ok: boolean; message?: string }> {
    const repo = repoFromUrl(url);
    if (!repo) return { ok: false, message: `not a GitHub repository URL: '${url}'` };
    const slug = slugFromRepo(repo);
    const slugErr = validateSlug(slug);
    if (slugErr) return { ok: false, message: slugErr };
    const outcome = await probeMarketplace(tempEntry(slug, repo), this.fetchImpl);
    if (!outcome.ok) return { ok: false, message: outcome.message };
    addMarketplaceEntry({ slug, repo, rescan: opts?.rescan });
    // The store is GLOBAL: every served harness's index must reflect the mutation, not just
    // the acting one — a stale sibling tab would claim a per-harness ownership that is not there.
    harvestAll();
    return { ok: true, message: `registered '${repo}' as '${marketplaceSourceId(slug)}'` };
  }

  unregisterSource(slug: string): boolean {
    const removed = removeMarketplace(slug);
    if (removed) harvestAll();
    return removed;
  }

  async install(row: CatalogRow, opts: { scope?: 'global' | 'project' } = {}): Promise<InstallResult> {
    // ALL writes live on the host axis (§D11): the market adapter only translates the row —
    // channel from the key's source prefix, provenance from `surfaces` — and hands it over.
    return getHostAdapter(this.harness).installPlugin({
      kind: 'plugin',
      channel: channelOf(row),
      key: row.key,
      scope: opts.scope,
      listedOn: row.surfaces.filter((s) => s !== sourceIdOf(row)),
      fetchImpl: this.fetchImpl,
    });
  }
}

/** The install channel a row travels by: npm-backed rows by registry, everything else by its
 *  repository source (`github:<owner/repo>`, `mp-<slug>:<repo>#<dir>`). */
function channelOf(row: CatalogRow): InstallChannel {
  if (row.key.startsWith('npm:')) return 'npm';
  if (row.key.startsWith('github:')) return 'github';
  if (row.key.startsWith('mp-')) return 'github';
  return 'local';
}

/** claude: operator git marketplaces only. No federated plugin directory serves claude, so the
 *  federated tier is empty — search answers from the index store alone. */
export class ClaudePluginMarketAdapter extends PluginMarketAdapter {
  protected federatedIds(): string[] {
    return [];
  }
}

/** pi: operator git marketplaces (index tier) + the official pi.dev catalog (federated tier). */
export class PiPluginMarketAdapter extends PluginMarketAdapter {
  protected federatedIds(): string[] {
    return ['pi-dev'];
  }
}

const PI_DEV_VIEW = SOURCES_VIEW_LOOKUP['pi-dev'];

/** pi, read-only official surface: ONLY the pi.dev catalog, queried live. No operator source
 *  registry (register/unregister are refused), no index store — every answer is the source's own
 *  native order with its own total, and installs go through the rows' `npm:<pkg>` handles. */
export class PiOfficialPluginMarketAdapter implements PluginAdapter {
  readonly harness: HarnessHostId = 'pi';

  constructor(protected readonly fetchImpl: typeof fetch = fetch) {}

  sources(): CatalogSource[] {
    return [
      {
        id: 'pi-dev',
        label: PI_DEV_VIEW?.label ?? 'pi.dev (official)',
        tier: 'federated',
        sorts: ['name', 'updated'], // catalog-level vocabulary; the live query maps to pi.dev's own orders
        counts: true,
      },
    ];
  }

  async search(q: string, opts: { page?: number; pageSize?: number; sort?: CatalogSort } = {}): Promise<CatalogPage> {
    const { page, pageSize } = clampPage(opts);
    if (!PI_DEV_VIEW) {
      return { rows: [], page, pageSize, hasMore: false, total: null, notes: ['pi.dev source view unavailable'] };
    }
    const result = await browseSource(PI_DEV_VIEW, q, pageSize, {
      harness: this.harness,
      page,
      sort: opts.sort,
      fetchImpl: this.fetchImpl,
    });
    if (!result.ok) {
      return { rows: [], page, pageSize, hasMore: false, total: null, notes: [result.message] };
    }
    const rows = result.items.filter((i) => i.installKind === 'plugin');
    return {
      rows: [],
      page,
      pageSize,
      hasMore: result.hasMore,
      // The count is the source's own; the rows travel as the labeled section (§D10).
      total: null,
      notes: [],
      sections: [
        {
          sourceId: 'pi-dev',
          label: PI_DEV_VIEW.label,
          rows: rows.map(toCatalogRow),
          ...(result.total !== undefined ? { total: result.total, totalExact: result.totalScope !== 'window' } : {}),
        },
      ],
    };
  }

  async checkSource(): Promise<{ ok: boolean; skills: number; mcps: number; plugins: number; message: string }> {
    return { ok: false, skills: 0, mcps: 0, plugins: 0, message: 'the official pi.dev catalog is read-only — no operator sources' };
  }

  async registerSource(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'the official pi.dev catalog is read-only — no operator sources' };
  }

  unregisterSource(): boolean {
    return false;
  }

  async install(row: CatalogRow, opts: { scope?: 'global' | 'project' } = {}): Promise<InstallResult> {
    if (!row.key.startsWith('npm:')) {
      return { ok: false, code: 'bad_request', message: `the official catalog installs npm packages only, got '${row.key}'` };
    }
    return getHostAdapter(this.harness).installPlugin({
      kind: 'plugin',
      channel: 'npm',
      key: row.key,
      scope: opts.scope,
      fetchImpl: this.fetchImpl,
    });
  }
}

/** `MarketItem` → `CatalogRow` for federated answers (same conversion the federated tier uses). */
function toCatalogRow(item: MarketItem): CatalogRow {
  return {
    key: item.key,
    name: item.name,
    summary: item.description,
    stars: item.stars,
    updatedAt: item.updatedAt ? Date.parse(item.updatedAt) || null : null,
    sourceId: item.sourceId,
    surfaces: [item.sourceId],
    hosts: [],
    repo: item.repo ?? null,
  };
}

/** The WRITING source for a row: `npm:<pkg>` rows write through the npm source; `mp-*` and other
 *  prefixed keys write through their own source. Federated catalog ids that only DISPLAY the row
 *  pi.dev surface in `listedOn` instead. */
function sourceIdOf(row: CatalogRow): string {
  if (row.key.startsWith('npm:')) return 'npm';
  const prefix = row.key.slice(0, row.key.indexOf(':'));
  return prefix || row.sourceId;
}

function tempEntry(slug: string, repo: string) {
  return { slug, repo, enabled: true, addedAt: Date.now(), rescan: { enabled: false, intervalMs: 86_400_000 } };
}

// --- helpers (delegating to the marketplaces module; wired to its public surface in step 13) ---

function repoFromUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1] ?? null;
}
function slugFromRepo(repo: string): string {
  const base = repo.split('/')[1]?.toLowerCase().replace(/[^a-z0-9-]/g, '-') ?? 'source';
  return base.replace(/^-+|-+$/g, '') || 'source';
}

/** Create the per-harness adapter. `fetchImpl` is injectable for tests; production uses global fetch. */
export function createPluginAdapter(harness: HarnessHostId, fetchImpl?: typeof fetch): PluginAdapter {
  if (harness === 'claude') return new ClaudePluginMarketAdapter('claude', fetchImpl);
  if (harness === 'pi') return new PiPluginMarketAdapter('pi', fetchImpl);
  return new PluginMarketAdapter(harness, fetchImpl);
}
