import { probeMarketplace, marketplaceSourceId, resolveSlug, resolveScopedSlug, addMarketplaceEntry, normalizeExtensionDir, removeMarketplaceEntry, getMarketplaceEntry, listMarketplaceEntries, federatedSections, writeNpmSourceSnapshot, githubRepoFromInput, SLUG_FAILURE_REASON } from '../../common/market.js';
import { parseNpmSource, probeNpmSource } from '../../common/npm-source.js';
import { indexSources, harvestAll, queryIndex, readIndex } from '../catalog.js';
import type { MarketplaceEntry, ProbeOptions } from '../../common/market.js';
import type { HostProbe } from '../../common/market.js';
import { adapterFor } from '../../host/adapters/index.js';
import { getHostAdapter } from '../../host/index.js';
import { getBuiltinViewsForHarness } from '../builtin.js';
import type { InstallChannel } from '../../host/request.js';
import type { CatalogRow, CatalogPage, CatalogSort, CatalogSource, PluginAdapter, SourceOutcome } from '../types.js';
import type { HarnessHostId, HarnessSourceView } from '../../types.js';
import type { InstallResult } from '../../host/install.js';

/**
 * Shared plugin-market engine (ADR-0015 §D10). One file per harness holds that harness's adapter
 * chain; this module owns everything that is NOT harness-specific: the index/federated merge, the
 * source CRUD verbs, the extension-layer defaults and the row → install translation.
 *
 * The identity IS the support declaration — there is no `supported()` predicate: an adapter
 * existing means the harness is served, the landing check happens at install time, and row-level
 * compatibility travels on `CatalogRow.hosts`.
 */

/** Query bounds: fan-out concurrency cap and per-source timeout — the facade owns the latency ceiling. */
const PAGE_DEFAULT = 24;

export function clampPage(opts: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  return {
    page: Math.max(1, Math.floor(opts.page ?? 1)),
    pageSize: Math.min(Math.max(1, Math.floor(opts.pageSize ?? PAGE_DEFAULT)), 100),
  };
}

/** The install channel a row travels by: npm-backed rows by registry, everything else by its
 *  repository source (`github:<owner/repo>`, `mp-<slug>:<repo>#<dir>`). */
export function channelOf(row: CatalogRow): InstallChannel {
  if (row.key.startsWith('npm:')) return 'npm';
  if (row.key.startsWith('github:')) return 'github';
  if (row.key.startsWith('mp-')) return 'github';
  return 'local';
}

/** The WRITING source for a row: `npm:<pkg>` rows write through the npm source; `mp-*` and other
 *  prefixed keys write through their own source. Federated catalog ids that only DISPLAY the row
 *  surface in `listedOn` instead. */
export function sourceIdOf(row: CatalogRow): string {
  if (row.key.startsWith('npm:')) return 'npm';
  const prefix = row.key.slice(0, row.key.indexOf(':'));
  return prefix || row.sourceId;
}

/** Operator input, normalized by the same parser the skill axis uses (`githubRepoFromInput`). */
const repoFromUrl = githubRepoFromInput;

const NOT_A_REPO = (url: string) => `not a GitHub repository: '${url}' (use owner/repo or a github.com URL)`;

/** The transient entry a dry-run/registration probe runs against (never persisted as config). */
export function tempEntry(slug: string, repo: string, extensionDir: string | null, harness: HarnessHostId | null): MarketplaceEntry {
  return {
    slug,
    repo,
    enabled: true,
    addedAt: Date.now(),
    rescan: { enabled: false, intervalMs: 86_400_000 },
    harness,
    extensionDir,
  };
}

/** Normalize the caller's extension scope once; a refused value is reported verbatim. */
function scopeOf(raw: string | undefined): { ok: true; extensionDir: string | null } | { ok: false; message: string } {
  const scoped = normalizeExtensionDir(raw);
  if (scoped !== null && typeof scoped !== 'string') return { ok: false, message: scoped.error };
  return { ok: true, extensionDir: scoped };
}

/** A refused probe, named for the console: a pinned layer that the repository does not publish is
 *  an answer about the SOURCE (`no_form`); anything else is upstream and keeps its own wording. */
function probeFailure(
  outcome: { code: 'bad_request' | 'missing_dir' | 'unavailable'; message: string },
  repo: string,
  dir: string | null,
): SourceOutcome {
  if (outcome.code === 'missing_dir' && dir) {
    return { ok: false, reason: 'no_form', params: { repo, dir }, message: outcome.message };
  }
  return { ok: false, reason: 'probe_failed', params: { repo }, message: outcome.message };
}

export class BasePluginMarketAdapter implements PluginAdapter {
  /** The repo-relative directory this harness's published form lives in, or `null` when the
   *  harness has no convention. Advertised to the console; the operator may override per source. */
  readonly extensionDir: string | null;

  constructor(
    readonly harness: HarnessHostId,
    protected readonly fetchImpl: typeof fetch = fetch,
    /** Every served harness's published form, supplied by the construction point (`adapters/index.ts`).
     *  Detection needs ALL of them: the harness that happened to run a probe is not evidence. */
    private readonly allHostProbes: () => HostProbe[] = () => [],
  ) {
    // The ecosystem's published layer is declared by the harness's own host adapter (one file per
    // host) — the market engine never hard-codes a directory table.
    this.extensionDir = adapterFor(harness)?.extensionDir ?? null;
  }

  /** The detection set: every served harness's form, or just this adapter's own when unwired. */
  protected probes(): HostProbe[] {
    const all = this.allHostProbes();
    if (all.length > 0) return all;
    return [{ harness: this.harness, dir: this.extensionDir, options: this.probeOptions() }];
  }

  /**
   * The live marketplace views this harness's market searches.
   * Native sources for native-supporting harnesses; default federated sources (union) otherwise.
   */
  protected federatedViews(): HarnessSourceView[] {
    return getBuiltinViewsForHarness(this.harness);
  }

  /** The source formats this harness's adapter reads. Empty = a bare `SKILL.md` scan; concrete
   *  adapters add only their own hooks (claude's catalog reader, pi's package layer). */
  protected probeOptions(): ProbeOptions {
    return {};
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
    const sections = await federatedSections(this.harness, q, { page, pageSize }, this.fetchImpl, this.federatedViews());
    for (const s of sections) if (s.note) notes.push(`${s.label}: ${s.note}`);
    return { rows, page, pageSize, hasMore: page * pageSize < total, total, notes, sections };
  }

  async checkSource(
    url: string,
    opts: { extensionDir?: string; type?: 'github' | 'npm' } = {},
  ): Promise<
    {
      ok: boolean;
      skills: number;
      mcps: number;
      plugins: number;
      hosts: HarnessHostId[];
      marketplace: string | null;
    } & SourceOutcome
  > {
    const empty = { skills: 0, mcps: 0, plugins: 0, hosts: [] as HarnessHostId[], marketplace: null };
    if (opts.type === 'npm' || /^npm:/i.test(url.trim())) {
      const query = parseNpmSource(url);
      if (!query.ok) return { ok: false, ...empty, reason: 'invalid_source', params: { url: url.trim() }, message: query.message };
      const probed = await probeNpmSource(query, this.fetchImpl);
      if (!probed.ok) return { ok: false, ...empty, reason: 'probe_failed', params: { url: url.trim() }, message: probed.message };
      return { ok: true, skills: 0, mcps: 0, plugins: probed.packages.length, hosts: [], marketplace: null };
    }
    const repo = repoFromUrl(url);
    if (!repo) return { ok: false, ...empty, reason: 'not_a_repo', params: { url: url.trim() }, message: NOT_A_REPO(url) };
    const scope = scopeOf(opts.extensionDir);
    if (!scope.ok) return { ok: false, ...empty, reason: 'invalid_layer', params: { layer: opts.extensionDir ?? '' }, message: scope.message };
    const outcome = await probeMarketplace(tempEntry('probe', repo, scope.extensionDir, this.harness), this.fetchImpl, {
      ...this.probeOptions(),
      defaultExtensionDir: this.extensionDir ?? undefined,
      persist: false,
      hosts: this.probes(),
    });
    if (!outcome.ok) return { ...empty, ...probeFailure(outcome, repo, scope.extensionDir) };
    return {
      ok: true,
      skills: outcome.snapshot.rows.length,
      mcps: 0,
      plugins: outcome.snapshot.plugins.length,
      hosts: outcome.snapshot.hosts,
      marketplace: outcome.snapshot.marketplace,
    };
  }

  async registerSource(
    url: string,
    opts: { rescan?: { enabled?: boolean; intervalMs?: number }; extensionDir?: string; type?: 'github' | 'npm'; catalog?: string } = {},
  ): Promise<SourceOutcome> {
    if (opts.type === 'npm' || /^npm:/i.test(url.trim())) return this.registerNpmSource(url, opts);
    const repo = repoFromUrl(url);
    if (!repo) return { ok: false, reason: 'not_a_repo', params: { url: url.trim() }, message: NOT_A_REPO(url) };
    const scope = scopeOf(opts.extensionDir);
    if (!scope.ok) return { ok: false, reason: 'invalid_layer', params: { layer: opts.extensionDir ?? '' }, message: scope.message };
    // A source pins a harness ONLY by naming its extension layer (§D10): the dialog probes every
    // served form, so an unpinned repository is shared and each tab narrows it by `snapshot.hosts`.
    const scopedHarness = scope.extensionDir ? this.harness : null;
    const slug = resolveSlug(repo, scope.extensionDir);
    if (!slug.ok) {
      // ANOTHER harness carries this repository. This tab asked for it, and a harness-scoped
      // source is a different identity (`mp-<repo>-<harness>`), so it is registered here instead
      // of claiming the sibling's entry — the two are enabled, synced and removed independently.
      const scoped = !scope.extensionDir && slug.code === 'repo_taken' ? await this.registerHarnessScoped(repo, opts) : null;
      if (scoped) return scoped;
      // Name the entry the operator can SEE: this harness's own source when it already holds the
      // repository, the foreign pin only when nothing here does.
      const local = slug.code === 'repo_taken' ? listMarketplaceEntries(this.harness).find((e) => e.repo === repo && e.harness === this.harness) : undefined;
      if (local) {
        const layer: Record<string, string> = local.extensionDir ? { layer: local.extensionDir } : {};
        return {
          ok: false,
          reason: 'already_configured',
          params: { repo, slug: local.slug, harness: this.harness, ...layer },
          message: `'${repo}' is already configured as '${local.slug}' for ${this.harness}${local.extensionDir ? ` (layer ${local.extensionDir})` : ''}`,
        };
      }
      return { ok: false, reason: SLUG_FAILURE_REASON[slug.code], params: slug.params, message: slug.message };
    }
    const outcome = await probeMarketplace(tempEntry(slug.slug, repo, scope.extensionDir, scopedHarness), this.fetchImpl, {
      ...this.probeOptions(),
      defaultExtensionDir: this.extensionDir ?? undefined,
      hosts: this.probes(),
    });
    if (!outcome.ok) return probeFailure(outcome, repo, scope.extensionDir);
    // The EFFECTIVE layer is recorded: a source that fell back to the harness's published
    // directory is the same layer as one that named it, so the duplicate gate sees one pair.
    const entry = addMarketplaceEntry({ slug: slug.slug, repo, type: 'github', catalog: opts.catalog, rescan: opts.rescan, harness: scopedHarness, extensionDir: outcome.snapshot.extensionDir });
    // The store is GLOBAL: every served harness's index must reflect the mutation, not just
    // the acting one — a stale sibling tab would claim a per-harness ownership that is not there.
    harvestAll();
    void import('../../host/marketplace-sync.js').then(({ syncMarketplaceToHost }) => syncMarketplaceToHost(entry));
    const detected = outcome.snapshot.hosts.length > 0 ? outcome.snapshot.hosts.join(', ') : 'none';
    return {
      ok: true,
      reason: 'registered',
      params: { repo, slug: marketplaceSourceId(slug.slug), harnesses: detected },
      message: `registered '${repo}' as '${marketplaceSourceId(slug.slug)}' (harnesses: ${detected})`,
    };
  }

  /**
   * Register a repository that ANOTHER harness already carries as THIS harness's own source
   * (ADR-0015 §D9/§D11). The slug cannot be the repo basename (one slug is one `mp-` id for the
   * whole store), so the harness disambiguates it: `mp-<repo>-<harness>`. The probe still runs
   * unpinned — the source reads every form the repository publishes, and only this harness's
   * index syncs it — while `entry.harness` keeps it out of the sibling's tab and host.
   * Returns null (plain duplicate) when this harness already holds the repository, when it is
   * shared, or when nothing foreign holds it.
   */
  private async registerHarnessScoped(
    repo: string,
    opts: { rescan?: { enabled?: boolean; intervalMs?: number }; catalog?: string },
  ): Promise<SourceOutcome | null> {
    const holders = listMarketplaceEntries().filter((e) => e.repo === repo);
    if (holders.length === 0 || holders.some((e) => !e.harness || e.harness === this.harness)) return null;
    const slug = resolveScopedSlug(repo, this.harness);
    if (!slug.ok) return null;
    const outcome = await probeMarketplace(tempEntry(slug.slug, repo, null, this.harness), this.fetchImpl, {
      ...this.probeOptions(),
      defaultExtensionDir: this.extensionDir ?? undefined,
      hosts: this.probes(),
    });
    if (!outcome.ok) return probeFailure(outcome, repo, null);
    const entry = addMarketplaceEntry({
      slug: slug.slug,
      repo,
      type: 'github',
      catalog: opts.catalog,
      rescan: opts.rescan,
      harness: this.harness,
      extensionDir: outcome.snapshot.extensionDir,
    });
    harvestAll();
    void import('../../host/marketplace-sync.js').then(({ syncMarketplaceToHost }) => syncMarketplaceToHost(entry));
    const detected = outcome.snapshot.hosts.length > 0 ? outcome.snapshot.hosts.join(', ') : 'none';
    return {
      ok: true,
      reason: 'registered_scoped',
      params: { repo, slug: marketplaceSourceId(slug.slug), harness: this.harness, harnesses: detected },
      message: `registered '${repo}' for ${this.harness} as '${marketplaceSourceId(slug.slug)}' (harnesses: ${detected})`,
    };
  }

  /** NPM source: a package or whole scope, resolved once at registration, harvested like a repo. */
  private async registerNpmSource(
    url: string,
    opts: { rescan?: { enabled?: boolean; intervalMs?: number }; catalog?: string },
  ): Promise<SourceOutcome> {
    const query = parseNpmSource(url);
    if (!query.ok) return { ok: false, reason: 'invalid_source', params: { url: url.trim() }, message: query.message };
    // The scope prefix IS the identity an operator registered: `@scope/*` stays one source.
    const target = query.kind === 'package' ? query.name : `${query.scope}/*`;
    const probed = await probeNpmSource(query, this.fetchImpl);
    if (!probed.ok) return { ok: false, reason: 'probe_failed', params: { url: url.trim() }, message: probed.message };
    const slug = resolveSlug(target, null);
    if (!slug.ok) return { ok: false, reason: SLUG_FAILURE_REASON[slug.code], params: slug.params, message: slug.message };
    const entry = addMarketplaceEntry({ slug: slug.slug, repo: target, type: 'npm', catalog: opts.catalog, rescan: opts.rescan, harness: this.harness, extensionDir: null });
    writeNpmSourceSnapshot(slug.slug, probed.packages, this.harness);
    harvestAll();
    void import('../../host/marketplace-sync.js').then(({ syncMarketplaceToHost }) => syncMarketplaceToHost(entry));
    return {
      ok: true,
      reason: 'registered',
      params: { repo: target, slug: marketplaceSourceId(slug.slug), harnesses: '' },
      message: `registered npm '${target}' as '${marketplaceSourceId(slug.slug)}' (${probed.packages.length} package(s))`,
    };
  }

  unregisterSource(slug: string): boolean {
    const entry = getMarketplaceEntry(slug, this.harness);
    if (entry) {
      void import('../../host/marketplace-sync.js').then(({ removeMarketplaceFromHost }) => removeMarketplaceFromHost(entry));
    }
    const removed = removeMarketplaceEntry(slug, this.harness);
    if (removed) harvestAll();
    return removed;
  }

  async install(row: CatalogRow, opts: { scope?: 'global' | 'project'; confirm?: boolean } = {}): Promise<InstallResult> {
    // ALL writes live on the host axis (§D11): the market adapter only translates the row —
    // channel from the key's source prefix, provenance from `surfaces` — and hands it over.
    // A git-backed row additionally names its marketplace identity, so the runtime's OWN install
    // command runs instead of resolving a payload.
    const gitBacked = row.repo !== null && channelOf(row) === 'github';
    return getHostAdapter(this.harness).installPlugin({
      kind: 'plugin',
      channel: channelOf(row),
      key: row.key,
      scope: opts.scope,
      ...(opts.confirm ? { confirm: true } : {}),
      listedOn: row.surfaces.filter((s) => s !== sourceIdOf(row)),
      ...(gitBacked
        ? {
            marketplace: {
              repo: row.repo!,
              plugin: row.name,
              name: row.marketplace ?? row.repo!.split('/').pop()!,
            },
          }
        : {}),
      fetchImpl: this.fetchImpl,
    });
  }
}

