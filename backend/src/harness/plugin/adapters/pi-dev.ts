import { BasePluginMarketAdapter, clampPage } from './base.js';
import { cache, CACHE_TTL_MS, registerBrowseCache, registerBrowseView, toCatalogRow } from '../../common/market.js';
import { catalogRegistry } from '../../common/catalog-registry.js';
import type { BrowseResult, HostProbe, MarketItem } from '../../common/market.js';
import { repoSlug } from '../../common/npm-catalog.js';
import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from '../../net.js';
import { getHostAdapter } from '../../host/index.js';
import type { HarnessHostId, HarnessSourceView } from '../../types.js';
import type { CatalogRow, CatalogPage, CatalogSort, CatalogSource } from '../types.js';
import type { InstallResult } from '../../host/install.js';

/**
 * Pi's OFFICIAL market surface (ADR-0015 §D10): the base adapter and the live pi.dev catalog
 * reader. Operator git sources live in `pi-github.ts` — the two halves share only
 * `PiPluginMarketAdapter`.
 *
 *   · `PiPluginMarketAdapter`    — the base: operator git marketplaces + pi.dev;
 *   · `PiDevPluginMarketAdapter` — pi.dev alone, live and read-only.
 */

// ---------------------------------------------------------------------------
// Adapter chain
// ---------------------------------------------------------------------------

export class PiPluginMarketAdapter extends BasePluginMarketAdapter {
  protected federatedViews(): HarnessSourceView[] {
    return [PI_DEV_VIEW];
  }
}

/** pi, read-only official surface: ONLY the pi.dev catalog, queried live. No operator source
 *  registry (register/unregister are refused), no index store — every answer is the source's own
 *  native order with its own total, and installs go through the rows' `npm:<pkg>` handles. */
export class PiDevPluginMarketAdapter extends PiPluginMarketAdapter {
  constructor(fetchImpl: typeof fetch = fetch, probes: () => HostProbe[] = () => []) {
    super('pi', fetchImpl, probes);
  }

  sources(): CatalogSource[] {
    return [
      {
        id: 'pi-dev',
  catalog: 'pi.dev',
  label: PI_DEV_VIEW.label,
        tier: 'federated',
        sorts: ['name', 'updated'], // catalog-level vocabulary; the live query maps to pi.dev's own orders
        counts: true,
      },
    ];
  }

  async search(q: string, opts: { page?: number; pageSize?: number; sort?: CatalogSort } = {}): Promise<CatalogPage> {
    const { page, pageSize } = clampPage(opts);
    const result = await browsePiDev(q, pageSize, page, opts.sort);
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
          rows: rows.map((row) => toCatalogRow(row, PI_DEV_VIEW.hosts ?? [])),
          ...(result.total !== undefined ? { total: result.total, totalExact: result.totalScope !== 'window' } : {}),
        },
      ],
    };
  }

  async checkSource(): Promise<{ ok: boolean; skills: number; mcps: number; plugins: number; hosts: HarnessHostId[]; marketplace: string | null; message: string }> {
    return { ok: false, skills: 0, mcps: 0, plugins: 0, hosts: [], marketplace: null, message: 'the official pi.dev catalog is read-only — no operator sources' };
  }

  async registerSource(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'the official pi.dev catalog is read-only — no operator sources' };
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

// ---------------------------------------------------------------------------
// pi.dev catalog reader
// ---------------------------------------------------------------------------

/**
 * pi.dev package catalog reader — the OFFICIAL Pi source.
 *
 * The catalog is a server-rendered HTML page (no JSON API): cards carry `data-package-*`
 * attributes, the printed install command is `pi install npm:<pkg>`, and the grid header prints the
 * count. Everything below keys off those measured attributes; a page that stops matching answers
 * `markupChanged` rather than an empty market.
 */

const CATALOG_URL = 'https://pi.dev/packages';

/** Cards per server-rendered page (measured; the site ignores any page-size parameter). */
export const PI_DEV_PAGE_SIZE = 50;

export interface PiDevEntry {
  /** npm package name the catalog prints in its install command. */
  packageName: string;
  description: string | null;
  /** Catalog type chips (`plugin`, `skill`, `theme`, `prompt`); empty for an untyped package. */
  types: string[];
  /** First non-issue GitHub link on the card. */
  repoUrl?: string;
  /** The catalog's own page for this package. */
  url: string;
  /** ISO publication time from the card's epoch-ms attribute; `''` when absent. */
  publishedAt: string;
  /** Monthly downloads count from data-package-downloads, or null. */
  downloads?: number | null;
}

export type PiDevRead =
  | {
      ok: true;
      entries: PiDevEntry[];
      /** Rows the catalog says match this query — the SOURCE's count, not this market's row count
       *  (callers that filter rows must not pass it on as their own total). */
      total: number | null;
      /** The catalog has a successor page for this query. */
      more: boolean;
    }
  | { ok: false; code: 'unavailable' | 'upstream'; reason: FailureReason; reasonParams?: Record<string, string>; message: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the handful of HTML entities a card can carry (descriptions are escaped upstream). */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole: string, body: string): string => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Readable prose from a card fragment.
 *
 * A description is sometimes not prose at all: the author published markdown/HTML, so the card shows
 * escaped markup (`&lt;p&gt; &lt;img …&gt;`). Decode first, then drop tags — what survives is the
 * honest text, and an image-only banner leaves nothing, which becomes `null` rather than markup soup.
 */
function plainText(fragment: string): string {
  return decodeEntities(fragment)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same grammar the npm adapter enforces: `[@scope/]name`, no shell-shaped characters. */
const PACKAGE_GRAMMAR = /^(@[\w.-]+\/)?[\w.-]+$/;

function attr(block: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(block)?.[1];
}

/**
 * Split one server-rendered catalog page into entries. Exported for tests: the fixture is a page
 * fragment, and the mapping to a market row is the caller's business.
 *
 * `cards` and `marker` let the caller tell "the page had no results" from "the page is not a catalog
 * any more" — see the fail-loud note at the top of this module.
 */
export function parsePiDevCatalog(html: string): { entries: PiDevEntry[]; cards: number; marker: boolean } {
  const marker = /class="packages-count"/.test(html);
  const blocks = html.split(/<article\b/).filter((block) => block.includes('data-package-card="true"'));
  const entries: PiDevEntry[] = [];

  for (const block of blocks) {
    const declared = attr(block, 'data-package-name');
    if (!declared) continue;
    // The printed install command is the catalog's own statement of the package it installs; the npm
    // link is the fallback and the card name the last resort (all three agree on every measured row).
    const printed = /pi install npm:([^\s<]+)/.exec(block)?.[1];
    const npmLink = /npmjs\.com\/package\/([^"\s?#]+)/.exec(block)?.[1];
    const packageName = decodeEntities(printed ?? npmLink ?? declared);
    if (!PACKAGE_GRAMMAR.test(packageName)) continue;

    const repoUrl = [...block.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g)]
      .map((m) => m[0])
      .find((url) => !/\/issues(\/|$)/.test(url));

    const dateMs = Number(attr(block, 'data-package-date'));
    const publishedAt = Number.isFinite(dateMs) && dateMs > 0 ? new Date(dateMs).toISOString() : '';
    const desc = /<p class="packages-desc">([\s\S]*?)<\/p>/.exec(block)?.[1];
    const path = attr(block, 'data-package-path');
    const dlRaw = attr(block, 'data-package-downloads');
    const downloads = dlRaw !== undefined && Number.isFinite(Number(dlRaw)) ? Number(dlRaw) : null;

    entries.push({
      packageName,
      description: desc === undefined ? null : plainText(desc) || null,
      types: (attr(block, 'data-package-types') ?? '').split(/\s+/).filter(Boolean),
      ...(repoUrl ? { repoUrl } : {}),
      url: path && /^\/[\w./@-]+$/.test(path) ? `https://pi.dev${path}` : `https://pi.dev/packages/${packageName}`,
      publishedAt,
      ...(downloads !== null ? { downloads } : {}),
    });
  }

  return { entries, cards: blocks.length, marker };
}

/**
 * The grid's count marker — `1-50 / 286 (of 5338)` — answers two questions: how many rows the query
 * matches, and whether a successor page exists. Parsing it beats "ask for page N+1 and see if it is
 * empty": that costs a request and cannot tell an exhausted catalog from a broken one.
 */
export function parsePiDevCount(html: string): { total: number | null; more: boolean } {
  const m = /class="packages-count"[^>]*>\s*(\d+)-(\d+)\s*\/\s*([\d,]+)(?:\s*\(of\s*([\d,]+)\))?/.exec(html);
  if (!m) return { total: null, more: false };
  const end = Number(m[2]);
  const total = Number(m[3]!.replace(/,/g, ''));
  if (!Number.isFinite(total)) return { total: null, more: false };
  return { total, more: Number.isFinite(end) && end < total };
}

/**
 * Read ONE catalog page. `query` is passed verbatim as the catalog's own `name` filter; `page` is the
 * catalog's own 1-based page (50 cards each). Page 1 leaves the parameter off, so the request stays
 * exactly the URL that was measured.
 */
/** The catalog's OWN order values, read from its sort control (`Most downloads` / `Recently
 *  published` / `A-Z`). Any other value is ignored by the site — measured 2026-10-25: unknown
 *  values fall back to the downloads order — so this adapter never sends one it has not seen work. */
const PI_DEV_SORTS = new Set(['downloads', 'recent', 'name']);

export async function fetchPiDevCatalog(
  query: string,
  page = 1,
  fetchImpl: typeof fetch = fetch,
  sort = 'downloads'
): Promise<PiDevRead> {
  const typed = query.trim();
  const at = Math.max(page, 1);
  const paged = at > 1 ? `&page=${at}` : '';
  const order = PI_DEV_SORTS.has(sort) ? sort : 'downloads';
  const url = `${CATALOG_URL}?sort=${order}${paged}${typed ? `&name=${encodeURIComponent(typed)}` : ''}`;
  let res: Response;
  try {
    // The CDN drops bursts from some environments, so a transient failure is asked again under the
    // shared policy; `upstream` + a reason is what a caller sees once the budget is spent.
    res = await fetchWithRetry(
      url,
      { headers: { Accept: 'text/html', 'User-Agent': 'omnicellrouter-harness' } },
      undefined,
      { fetchImpl }
    );
  } catch (e) {
    // Connection resets are measured from this environment (the CDN drops bursts): "try later", never
    // "no such package".
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('pi.dev catalog', e) };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, code: 'unavailable', reason: 'unavailable', message: `pi.dev catalog returned HTTP ${res.status} — try again later` };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: String(res.status) },
      message: `pi.dev catalog returned HTTP ${res.status}`,
    };
  }

  let html: string;
  try {
    html = await res.text();
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('pi.dev catalog', e) };
  }

  const parsed = parsePiDevCatalog(html);
  if (parsed.cards === 0 && !parsed.marker) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'markupChanged',
      message: 'pi.dev catalog markup changed — no package cards or result count',
    };
  }
  if (parsed.cards > 0 && parsed.entries.length === 0) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'markupChanged',
      message: 'pi.dev catalog markup changed — package cards carried no package name',
    };
  }
  const count = parsePiDevCount(html);
  return { ok: true, entries: parsed.entries, total: count.total, more: count.more };
}

// ---------------------------------------------------------------------------
// pi.dev → market rows
// ---------------------------------------------------------------------------

/** One pi.dev catalog row → one market row.
 *
 * `key` belongs to the npm source: the catalog prints `pi install npm:<pkg>` for every row, so the
 * package is the identity and the row installs through the npm adapter. That keeps ONE identity per
 * package (and the console's installed-state join is `canonicalKey`-exact), while `sourceId`/`id`
 * still record where the row was discovered. */
function toPiDevItem(entry: PiDevEntry): MarketItem {
  const slug = repoSlug(entry.repoUrl);
  return {
    id: `pi-dev:${entry.packageName}`,
    sourceId: 'pi-dev',
    key: `npm:${entry.packageName}`,
    installKind: 'plugin',
    name: entry.packageName,
    ...(slug ? { repo: `${slug.owner}/${slug.repo}` } : {}),
    description: entry.description,
    url: entry.url,
    // The catalog carries downloads, not stars: `null` keeps "the catalog never said" apart from
    // "nobody starred it" — the console resolves a row's stars from its repo on demand.
    stars: null,
    updatedAt: entry.publishedAt,
    topics: entry.types,
    catalog: 'pi.dev',
    channel: 'pi-dev',
    categories: entry.types.length > 0 ? entry.types : ['plugin'],
    ...(entry.downloads !== undefined && entry.downloads !== null ? { registryStats: { downloads: entry.downloads, stars: null, installs: null } } : {}),
  };
}

/**
 * One catalog page as market rows, cached by its own upstream page number.
 *
 * This market lists the catalog row for row: every entry — plugin, untyped bundle, skill, theme,
 * prompt — installs with the same printed command (`pi install npm:<pkg>`) into the same runtime
 * package store, so nothing is filtered, and the catalog's own count is therefore the honest `total`.
 * The type chips are the catalog's vocabulary, not this market's kinds.
 *
 * The console pages by rows of THIS market while the catalog pages by ITS 50 cards; because nothing
 * is filtered the two relate arithmetically (row `i` is catalog row `i`), so a console window reads
 * only the one or two catalog pages it straddles — no walking from the first page, no duplicates and
 * no gaps at any depth. Each catalog page is fetched once per cache window, and its count marker is
 * carried along so the console can print `1–24 / 5338` the way the source does.
 */
async function piDevCatalogPage(
  q: string,
  upstream: number,
  sort: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; items: MarketItem[]; more: boolean; total: number | null }
  | { ok: false; code: 'upstream' | 'unavailable'; message: string }
> {
  const cacheKey = `pi-dev|${q}|${upstream}|${sort}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ok: true, items: hit.items, more: hit.hasMore ?? false, total: hit.total ?? null };
  }

  const read = await fetchPiDevCatalog(q, upstream, fetchImpl, sort);
  if (!read.ok) return read;
  const items = read.entries.map(toPiDevItem);
  cache.set(cacheKey, {
    at: Date.now(),
    items,
    hasMore: read.more,
    ...(read.total !== null ? { total: read.total } : {}),
  });
  return { ok: true, items, more: read.more, total: read.total };
}

/**
 * Browse the official Pi package catalog (pi.dev/packages); empty query = its top-downloads page.
 *
 * `total` is the SOURCE's own count — the number the catalog prints in its grid header — because this
 * market lists exactly the catalog's rows, so the range and the total describe the same list. `hasMore`
 * still decides the "next" affordance: a source that stops short of its own count (a short last page)
 * must not advertise a successor.
 *
 * Because nothing is filtered, a window maps onto the catalog arithmetically: console rows `offset …
 * offset+size-1` straddle at most TWO catalog pages (size ≤ 50), so even page 200 costs two fetches and
 * the deep walk below is bounded by construction rather than by a cap.
 */
export async function browsePiDev(query: string, limit = 24, page = 1, sort = 'downloads', fetchImpl: typeof fetch = fetch): Promise<BrowseResult> {
  const q = query.trim();
  const size = Math.min(Math.max(limit, 1), 50);
  const at = Math.max(page, 1);
  const offset = (at - 1) * size;
  const note = q ? undefined : 'official Pi package catalog — every row installs with `pi install npm:<pkg>`';
  const noteCode = q ? undefined : ('pi-dev' as const);

  const firstPage = Math.floor(offset / PI_DEV_PAGE_SIZE) + 1;
  const lastPage = Math.floor((offset + size - 1) / PI_DEV_PAGE_SIZE) + 1;
  const base = (firstPage - 1) * PI_DEV_PAGE_SIZE;

  const rows: MarketItem[] = [];
  let total: number | null = null;
  let more = false;
  for (let upstream = firstPage; upstream <= lastPage; upstream += 1) {
    const read = await piDevCatalogPage(q, upstream, sort, fetchImpl);
    if (!read.ok) return read;
    rows.push(...read.items);
    // The FIRST page of the window states the query's count; a page past the catalog's end reports
    // zero matches, and that must not overwrite the count the in-range page gave.
    if (upstream === firstPage) total = read.total;
    // Only the last fetched page can speak for "is there anything after this window".
    if (upstream === lastPage) more = read.more;
  }

  const local = offset - base;
  const items = rows.slice(local, local + size);
  return {
    ok: true,
    items,
    // The source's own count when it states one; otherwise the catalog page's successor flag.
    hasMore: total !== null ? offset + items.length < total : more,
    ...(total !== null ? { total } : {}),
    note,
    ...(noteCode ? { noteCode } : {}),
  };
}

/** The official Pi package catalog chip (`pi.dev/packages`): the FIRST and only plugin directory,
 *  so a pi page opens on it. Every row prints its own `pi install npm:<pkg>` command; the row
 *  therefore carries an `npm:<pkg>` handle and installs through the npm source — one package, ONE
 *  identity, and the console's installed-state join stays exact.
 *
 *  The catalog's sort CONTROL offers three orders (`Most downloads` / `Recently published` / `A-Z`),
 *  mapping to `?sort=downloads|recent|name` — measured 2026-10-25: each reorders the page, and an
 *  unknown value silently falls back to downloads. Those three are the source's whole official set. */
export const PI_DEV_VIEW: HarnessSourceView = {
  id: 'pi-dev',
  catalog: 'pi.dev',
  label: 'pi.dev (official)',
  kinds: ['plugin'],
  trust: 'official',
  auth: 'none',
  enabled: true,
  browsable: true,
  hosts: ['pi'],
  sorts: ['downloads', 'recent', 'name'],
  browse: browsePiDev,
};

registerBrowseCache('pi-dev', () => {
  for (const key of [...cache.keys()]) if (key.startsWith('pi-dev|')) cache.delete(key);
});

registerBrowseView(PI_DEV_VIEW);

catalogRegistry.register({
  harness: 'pi',
  id: 'pi-dev',
  catalog: 'pi.dev',
  label: PI_DEV_VIEW.label,
  kinds: ['plugin'],
  trust: 'official',
  builtin: true,
  sorts: ['downloads', 'recent', 'name'],
  browse: browsePiDev,
});
