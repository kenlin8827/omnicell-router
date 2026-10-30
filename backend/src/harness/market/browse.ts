import { fetchPiDevCatalog, PI_DEV_PAGE_SIZE, type PiDevEntry } from '../plugin/pi-dev.js';
import {
  fetchSkillsShPage,
  isSkillsShBoard,
  searchSkillsSh,
  SKILLS_SH_MIN_QUERY,
  SKILLS_SH_PAGE_SIZE,
  SKILLS_SH_SEARCH_LIMIT,
  type SkillsShEntry,
} from '../skill/skills-sh.js';
import { CLAWHUB_SEARCH_LIMIT, CLAWHUB_WALK_MAX, fetchClawHubCatalogPage, fetchClawHubSearch, type ClawHubEntry } from '../skill/clawhub.js';
import { repoSlug } from './catalog-npm.js';
import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from '../net.js';
import type { HarnessKind, HarnessSourceView } from '../types.js';

/**
 * Marketplace browse (ADR-0015 §8, slice T4-lite).
 *
 * The console needs ONE standard shape from every source, so the adapter does the normalizing and
 * the page never learns a vendor's JSON. Five sources are live: GitHub (skills), the npm registry
 * (plugin and MCP packages), the official pi.dev package catalog (plugin packages, read from the
 * server-rendered catalog page), the skills.sh leaderboards (skills, read from the site's
 * server-rendered boards — its API is closed to callers without a Vercel workload token), and the
 * ClawHub community registry (skills, read through its own public API and installed from the
 * registry's own versioned store). A source whose upstream cannot be read answers
`unavailable` with the measured reason rather than rendering an empty market that looks broken.
 *
 * Anonymous GitHub search is rate limited (10 req/min), so results are cached briefly — typing in the
 * search field must not spend the whole budget. npm search, the pi.dev catalog and the
 * community registry are anonymous and share the cache.
 */

const API = 'https://api.github.com';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const CACHE_TTL_MS = 60_000;

/**
 * Board pages of a leaderboard source live LONGER than a search answer.
 *
 * A ranking moves slowly (installs accumulate over days), while skills.sh throttles a burst with
 * `429 + Retry-After: 60` after roughly 30 requests (measured 2026-10-25). Its all-time board is ~50
 * upstream pages, so a deep scroll spends two throttle windows to reach the end — and a second visit
 * would spend them again under the shared 60 s window. Ten minutes keeps that to one walk per window.
 *
 * This is NOT a licence to stop re-reading: the market's refresh button evicts the source's whole cache
 * family before dispatch (`evictBrowseCache`), so an explicit "ask again" still reaches the site.
 */
const BOARD_TTL_MS = 10 * 60_000;

export interface MarketItem {
  /** Stable across sources: `<sourceId>:<repo or package>`. */
  id: string;
  sourceId: string;
  /**
   * Portable install handle — what the install endpoint takes as `key`
   * (`github:<owner/repo>` / `npm:<name>`). `id` carries the same value; `key` names its role.
   */
  key: string;
  /**
   * Which writer serves this row: a skill copy tree, an plugin package, or an MCP server merged
   * into a host's own config. It is the WRITER's kind, not the page's — an npm package reached from
   * the skills page is an plugin (ADR-0015 §8).
   */
  installKind: 'skill' | 'mcp' | 'plugin';
  /** Display name — the repo name, or the skill directory when a repo holds several. */
  name: string;
  /** `owner/repo` when the row has a GitHub project; absent for sources whose identity is only a
   *  package name. */
  repo?: string;
  description: string | null;
  url: string;
  /**
   * GitHub stars, or `null` when this source publishes no popularity signal at all.
   *
   * `null` is NOT `0`: a catalog that never states a star count (npm, the Pi catalog, the community
   * registries) must not claim "nobody starred this". The console renders the two differently, and a
   * row may still ACQUIRE a number later — `harness/stars.ts` resolves stars on demand for the
   * repositories a page references, one batched GitHub search per page.
   */
  stars: number | null;
  /**
   * The SOURCE'S OWN popularity counters, when the source has a popularity system of its own that is
   * NOT GitHub stars — today only ClawHub (its own star unit, plus downloads/installs).
   *
   * Kept in a separate field, never folded into `stars`: the star column means "GitHub stars", and
   * printing a registry rating under it would relabel one number as another (ADR-0015 §D6 — the same
   * rule that keeps skills.sh's install tally out). The console labels this one with its source.
   */
  registryStats?: {
    stars: number | null;
    downloads: number | null;
    installs: number | null;
  };
  updatedAt: string;
  topics: string[];
}

export type BrowseResult =
  | {
      ok: true;
      items: MarketItem[];
      /** True when the source has another page for this query — the console's "next" affordance. */
      hasMore: boolean;
      /** Rows the source reports for this query, when it reports one. Absent = unknown, and the
       *  console then shows the page number without inventing a total. */
      total?: number;
      /**
       * What `total` COUNTS. Absent means "the catalog, as far as the source can see it". `window`
       * says the number is only the reachable slice — skills.sh ships a fixed 600-row board out of a
       * 9 911-skill ranking, and its search caps every answer at 200 — so the console must not print it
       * as the population. The pager still needs it to draw the page buttons.
       */
      totalScope?: 'catalog' | 'window';
      /** English copy, kept as the fallback the console shows when it has no string for `noteCode`. */
      note?: string;
      /** Opaque identity for `note` — the console maps it to its own translation table and fills
       *  `noteParams` into that string. Same rule as the ratelimit ledger's `note`/`noteCode`: the
       *  backend states the fact, the console owns the words. */
      noteCode?: HarnessNoteCode;
      noteParams?: Record<string, string>;
    }
  | {
      ok: false;
      code: 'unsupported_source' | 'unavailable' | 'upstream';
      /** Why the read failed, in vocabulary the console translates (`harness.browseError.*`).
       *  `message` stays as the English fallback: an unmapped reason never shows a bare key. */
      reason?: FailureReason;
      reasonParams?: Record<string, string>;
      message: string;
    };

/** The sentences a browse adapter attaches to an answer (`noteCode`). */
export type HarnessNoteCode =
  /** github — no GITHUB_TOKEN, so the anonymous search quota applies. */
  | 'github-anonymous'
  /** npm — no query typed, so the empty-query keyword default (`{keyword}`) is what was searched. */
  | 'npm-keyword'
  /** npm — no query typed and this host has no tag convention, so a plain phrase (`{query}`) was
   *  searched: a relevance guess, not a catalog membership. */
  | 'npm-default'
  /** pi-dev — the catalog's own install command. */
  | 'pi-dev'
  /** npm — an order the registry cannot serve natively: the backend fetched a window (npm's own
   *  ranking) and ordered THAT (`{n}` rows), so the list is sorted server-side, not in the page. */
  | 'window-sorted'
  /** skills.sh — one BOARD answer: `{n}` is the size the site states for the board, read 200 rows at a
   *  time from its own paging endpoint. */
  | 'skills-sh-board'
  /** skills.sh — a full-catalog search: `{n}` is the endpoint's own match cap per query (it ignores
   *  paging), so a broad term stops there instead of paging into a void. */
  | 'skills-sh-search'
  /** clawhub — the catalog endpoint's own ranking, cursor-paged and count-less. */
  | 'clawhub-catalog'
  /** clawhub — a full-catalog search: `{n}` is the limit one request carries (the endpoint has no
   *  paging parameter), so the answer is a window. */
  | 'clawhub-search';

/**
 * GitHub request headers — one place for the token, shared by every reader that talks to the API
 * (browse and the on-demand star resolver). A second copy would drift the day one of them learns a
 * new header.
 */
export function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'omnicellrouter-harness',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

interface SearchRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  pushed_at: string;
  topics?: string[];
}


const cache = new Map<
  string,
  {
    at: number;
    /** Rows in the market's shape. Board pages leave this empty and carry `slots` instead. */
    items: MarketItem[];
    hasMore?: boolean;
    total?: number;
    catalogSize?: number;
    rows?: number;
    /** skills.sh board pages only: one slot per upstream row, so a slice keeps the site's row index. */
    slots?: (SkillsShEntry | null)[];
  }
>();



/** ClawHub pages and cursor chains — the same shape as the MCP registry's (a cursor API has no
 *  offset, so page N is only reachable by walking N-1 recorded cursors). */
const clawhubPages = new Map<string, { at: number; items: MarketItem[]; next: string | null }>();
const clawhubCursors = new Map<string, { at: number; cursors: string[] }>();

/** Drop the whole browse cache (tests, and any caller that cannot name one source): the TTL is a
 *  rate-limit shield, not a correctness contract. */
export function resetBrowseCache(): void {
  cache.clear();
  clawhubPages.clear();
  clawhubCursors.clear();
}

/** The first segment of every cache key, per source: the adapter that owns that window. */
const CACHE_PREFIX: Record<string, string> = {
  github: 'github|',
  npm: 'npm|',
  'pi-dev': 'pi-dev|',
  'skills-sh': 'skills-sh|',
  clawhub: 'clawhub|',
};

/**
 * Drop ONE source's cached pages, so the next read asks upstream again.
 *
 * Only an explicit operator refresh reaches here (`browseSource(..., { refresh: true })`): the 60 s
 * window exists to shield the anonymous quota, and a forced re-read is the one caller that means
 * "that window is stale, ask now". It is narrowed to one source on purpose — refreshing GitHub must
 * not discard the npm or pi.dev window another tab just warmed.
 */
export function evictBrowseCache(sourceId: string): void {
  const prefix = CACHE_PREFIX[sourceId];
  if (!prefix) return;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
  // ClawHub keeps the same two families (row pages and the cursor chain that reaches them).
  for (const key of [...clawhubPages.keys()]) if (key.startsWith(prefix)) clawhubPages.delete(key);
  for (const key of [...clawhubCursors.keys()]) if (key.startsWith(prefix)) clawhubCursors.delete(key);
}

/** Public repositories that carry skills. A single `topic:` qualifier — GitHub answers 422 to
 *  the unparenthesized OR-combination of qualifiers. */
const DEFAULT_QUERY = 'topic:claude-skills';

function toItem(repo: SearchRepo): MarketItem {
  return {
    id: `github:${repo.full_name}`,
    sourceId: 'github',
    key: `github:${repo.full_name}`,
    installKind: 'skill',
    name: repo.name,
    repo: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    stars: repo.stargazers_count,
    updatedAt: repo.pushed_at,
    topics: repo.topics ?? [],
  };
}

export async function browseGitHub(query: string, limit = 24, page = 1, sort = 'stars'): Promise<BrowseResult> {
  const q = query.trim() || DEFAULT_QUERY;
  const perPage = Math.min(Math.max(limit, 1), 50);
  const at = Math.max(page, 1);
  // GitHub's published orderings; `best-match` means "omit sort", which is the API default ranking.
  const ORDER: Record<string, string | null> = {
    stars: 'stars',
    forks: 'forks',
    updated: 'updated',
    // GitHub's fourth documented value: ranks by open issues carrying the `help wanted` label.
    'help-wanted-issues': 'help-wanted-issues',
    'best-match': null,
  };
  const order = sort in ORDER ? sort : 'stars';
  const upstream = ORDER[order]!;
  const key = `github|${q}|${perPage}|${at}|${order}`;
  const note = process.env.GITHUB_TOKEN?.trim() ? undefined : 'anonymous GitHub search: 10 requests/minute';
  const noteCode = process.env.GITHUB_TOKEN?.trim() ? undefined : ('github-anonymous' as const);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ok: true, items: hit.items, note, ...(noteCode ? { noteCode } : {}), hasMore: hit.hasMore ?? false, ...(hit.total !== undefined ? { total: hit.total } : {}) };
  }

  // `order=desc` on every sort: best-match has no direction, and the other three are only useful
  // from the top. Omitting `sort` entirely is what requests GitHub's relevance ranking.
  const sortParam = upstream ? `&sort=${upstream}&order=desc` : '';
  const url = `${API}/search/repositories?q=${encodeURIComponent(q)}${sortParam}&per_page=${perPage}&page=${at}`;
  let res: Response;
  try {
    // Every failed answer is retried inside the shared policy (`net.ts`); a 403/429 that outlasts
    // the retries is mapped below.
    res = await fetchWithRetry(url, { headers: githubHeaders() });
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('GitHub search', e) };
  }
  if (res.status === 403 || res.status === 429) {
    return {
      ok: false,
      code: 'unavailable',
      reason: 'rateLimited',
      message: 'GitHub search rate limit reached — set GITHUB_TOKEN to raise it',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: String(res.status) },
      message: `GitHub returned HTTP ${res.status}`,
    };
  }

  let payload: { items?: SearchRepo[]; total_count?: number };
  try {
    payload = (await res.json()) as { items?: SearchRepo[]; total_count?: number };
  } catch {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'GitHub search answered non-JSON content' };
  }
  const items = (payload.items ?? []).map(toItem);
  // GitHub reports a total, but its search API refuses to page past 1000 rows — so the total the
  // console may act on is the REACHABLE one. Reporting 50 000 would render a pager whose last 2 000
  // pages answer empty.
  const total = payload.total_count === undefined ? undefined : Math.min(payload.total_count, 1000);
  const hasMore = total !== undefined ? at * perPage < total : items.length === perPage;
  cache.set(key, { at: Date.now(), items, hasMore, ...(total !== undefined ? { total } : {}) });
  return { ok: true, items, note, ...(noteCode ? { noteCode } : {}), hasMore, ...(total !== undefined ? { total } : {}) };
}

interface NpmSearchPackage {
  name?: string;
  version?: string;
  description?: string;
  date?: string;
  keywords?: string[];
  links?: { npm?: string; repository?: string };
}

interface NpmSearchResponse {
  objects?: { package?: NpmSearchPackage }[];
  total?: number;
}

/**
 * Empty-query default, PER HARNESS. npm search ranks by relevance over the WHOLE registry, so an
 * empty `text` returns unrelated popular packages — a market tab that looks broken. The `keywords:`
 * qualifier is an exact tag filter (measured 2026-10-25: the first 250 rows of each query below all
 * carry the tag), and npm declares one convention per runtime, so a page pinned to one harness opens
 * on THAT runtime's catalog — never on another's. Anything the operator types is passed verbatim.
 *
 * Ecosystem size, measured the same day: `pi-package` 12 736 · `dsh-plugin` 10 048 ·
 * `opencode-plugin` 2 684 · `claude-code-plugin` 656 · `codex-plugin` 118 ·
 * `gemini-cli-plugin` 18.
 *
 * A host with NO tag convention is deliberately ABSENT from this map. `cursor-plugin` (2),
 * `windsurf-plugin` (1), `zed-plugin` (2), `cline-plugin` (4), `amp-plugin` (0) and
 * `copilot-plugin` (8) are one cross-tagging package plus noise, so a `keywords:` default there
 * would render an empty market and present it as a catalog. Those hosts open on the plain phrase
 * below — a relevance query across runtimes, which is honest about being a guess.
 */
const NPM_DEFAULT_QUERY: Record<string, string> = {
  pi: 'keywords:pi-package',
  opencode: 'keywords:opencode-plugin',
  dsh: 'keywords:dsh-plugin',
  claude: 'keywords:claude-code-plugin',
  codex: 'keywords:codex-plugin',
  'gemini-cli': 'keywords:gemini-cli-plugin',
};
/** Fallback for a host with no npm tag convention — plugin-shaped packages, any runtime. */
const NPM_FALLBACK_QUERY = 'coding agent plugin';

/** The empty-query expression one harness opens on (exported so a test can pin the mapping). */
export function npmDefaultQuery(harness: string): string {
  return NPM_DEFAULT_QUERY[harness] ?? NPM_FALLBACK_QUERY;
}

/**
 * The empty-query expression the MCP axis opens on: the author's own `mcp-server` tag. Measured
 * 2026-10-25: `keywords:mcp-server` matches 10 501 packages, while `keywords:model-context-protocol`
 * casts the wider 41 344-row net but tags SDKs and clients as often as servers — the narrower tag
 * is the honest default. `keywords:` is the same exact tag filter the per-harness map above relies
 * on, and anything the operator types is passed verbatim, same as the plugin axis.
 */
const NPM_MCP_QUERY = 'keywords:mcp-server';

/** The empty-query expression one (kind, harness) pair opens on (exported so a test can pin it). */
export function npmDefaultQueryFor(kind: HarnessKind | undefined, harness: string): string {
  return kind === 'mcp' ? NPM_MCP_QUERY : npmDefaultQuery(harness);
}

function toNpmItem(pkg: NpmSearchPackage, installKind: 'mcp' | 'plugin' = 'plugin'): MarketItem | null {
  if (!pkg.name) return null;
  // npm search states the repository the package publishes (`git+https://…`, `git://…` and
  // `https://…` are the same project), so the slug is parsed off a normalized URL. A row with a repo
  // can have its stars resolved on demand (`harness/stars.ts`); a row without one cannot — and `null`
  // says so, because npm itself publishes no star count.
  const declared = (pkg.links?.repository ?? '').trim().replace(/^git\+/, '').replace(/^git:\/\//, 'https://');
  const slug = repoSlug(declared.replace(/\.git$/, ''));
  return {
    id: `npm:${pkg.name}`,
    sourceId: 'npm',
    key: `npm:${pkg.name}`,
    installKind,
    name: pkg.name,
    ...(slug ? { repo: `${slug.owner}/${slug.repo}` } : {}),
    description: pkg.description ?? null,
    url: pkg.links?.npm ?? `https://www.npmjs.com/package/${pkg.name}`,
    // npm exposes no star count; `null` keeps "unknown" distinguishable from "zero".
    stars: null,
    updatedAt: pkg.date ?? '',
    topics: pkg.keywords ?? [],
  };
}

/**
 * Orders npm's registry API cannot produce itself.
 *
 * `/-/v1/search` has no `sort` parameter and its documented `quality`/`popularity`/`maintenance`
 * weights are inert today (measured 2026-10-25: 50-row result sets identical under three extreme
 * weightings across five queries). So for these keys the BACKEND fetches one maximum-size window in
 * the registry's own relevance order and orders that window server-side — the page still renders the
 * order it was given, and the note names the window so the claim stays honest.
 */
const NPM_WINDOW = 250;
const NPM_WINDOW_SORTS = new Set(['name', 'updated']);

export async function browseNpm(
  query: string,
  limit = 24,
  defaultQuery = NPM_FALLBACK_QUERY,
  page = 1,
  sort = 'relevance',
  installKind: 'mcp' | 'plugin' = 'plugin'
): Promise<BrowseResult> {
  const typed = query.trim();
  const text = typed || defaultQuery;
  const size = Math.min(Math.max(limit, 1), 50);
  const at = Math.max(page, 1);
  const from = (at - 1) * size;
  const windowed = NPM_WINDOW_SORTS.has(sort);
  // A windowed answer fetches once from the top and slices the sorted result, so `from`/`size` alone
  // cannot describe it: the upstream request is always the whole window.
  const fetchSize = windowed ? NPM_WINDOW : size;
  const fetchFrom = windowed ? 0 : from;
  // The console words the note, so it gets an IDENTITY (`noteCode`) plus params, never a sentence.
  // A `keywords:` default reads as a tag; a phrase default must not claim to be one.
  const tag = text.startsWith('keywords:') ? text.slice('keywords:'.length) : null;
  let noteFields: { note?: string; noteCode?: HarnessNoteCode; noteParams?: Record<string, string> } = typed
    ? {}
    : tag !== null
      ? { note: `no query: showing packages tagged ${tag}`, noteCode: 'npm-keyword', noteParams: { keyword: tag } }
      : {
          note: `no query: this host publishes no npm tag — showing packages matching '${text}'`,
          noteCode: 'npm-default',
          noteParams: { query: text },
        };
  // The kind travels in the key: one typed query asked from two axes (an plugin chip and an MCP
  // chip) searches the same text but must not share rows — the install kind stamped on them differs.
  const cacheKey = `npm|${installKind}|${text}|${size}|${at}|${sort}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return {
      ok: true,
      items: hit.items,
      hasMore: hit.hasMore ?? false,
      ...(hit.total !== undefined ? { total: hit.total } : {}),
      ...noteFields,
    };
  }

  const url = `${NPM_REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=${fetchSize}&from=${fetchFrom}`;
  let res: Response;
  try {
    // Same shared retry as GitHub: any failed answer is asked again inside the budget. The LAST
    // 429/5xx is returned as-is and mapped by the branches below, so the console still gets a reason.
    res = await fetchWithRetry(url, { headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' } });
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('npm search', e) };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, code: 'unavailable', reason: 'unavailable', message: `npm search returned HTTP ${res.status} — try again later` };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: String(res.status) },
      message: `npm search returned HTTP ${res.status}`,
    };
  }

  let payload: NpmSearchResponse;
  try {
    payload = (await res.json()) as NpmSearchResponse;
  } catch {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'npm search answered non-JSON content' };
  }
  const fetched = (payload.objects ?? [])
    .map((entry) => (entry.package ? toNpmItem(entry.package, installKind) : null))
    .filter((item): item is MarketItem => item !== null);
  let items = fetched;
  let total = payload.total;
  let hasMore = fetchFrom + fetched.length < (total ?? 0);
  if (windowed) {
    // Unknown dates sink; ties fall back to the name so the order is stable across requests.
    const sorted =
      sort === 'updated'
        ? [...fetched].sort((a, b) => {
            const av = a.updatedAt || '';
            const bv = b.updatedAt || '';
            if (!av && !bv) return a.name.localeCompare(b.name);
            if (!av) return 1;
            if (!bv) return -1;
            return bv.localeCompare(av) || a.name.localeCompare(b.name);
          })
        : [...fetched].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    items = sorted.slice(from, from + size);
    // The window IS the answer space here: reporting the registry's millions would promise pages
    // this order cannot produce.
    total = sorted.length;
    hasMore = from + size < sorted.length;
    noteFields = {
      note: `sorted server-side across the top ${sorted.length} matches`,
      noteCode: 'window-sorted',
      noteParams: { n: String(sorted.length) },
    };
  }
  cache.set(cacheKey, { at: Date.now(), items, hasMore, ...(total !== undefined ? { total } : {}) });
  return {
    ok: true,
    items,
    hasMore,
    ...(total !== undefined ? { total } : {}),
    ...noteFields,
  };
}



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
    topics: [],
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

/**
 * skills.sh (source `skills-sh`) — the browse half of `harness/skills-sh.ts`.
 *
 * TWO reads, and which one answers depends on the query:
 *  - an EMPTY query (or a 1-character one) is answered from the chosen BOARD — All time (`/`),
 *    Trending 24h (`/trending`), Hot (`/hot`), each a fixed 600-row window the site renders whole. The
 *    three boards are the source's three ORDERINGS, so they are declared as `sorts` rather than as
 *    three sources.
 *  - a query of 2+ characters goes to the site's own search endpoint (`/api/search`, anonymous), which
 *    covers the WHOLE catalog — 1.5M+ skills — instead of the board window. It caps at 200 matches per
 *    query and ignores paging, so `total` is that capped count; claiming the leaderboard's own total
 *    (or the catalog's) would be a number this market cannot reach.
 *  - Every row installs through the GITHUB writer (`github:owner/repo#skill-dir`), because that is what
 *    the site's own `npx skills add <owner/repo>` resolves to: one artifact, one identity, and the
 *    console's installed-state join stays exact.
 */
function toSkillsShItem(entry: SkillsShEntry): MarketItem {
  return {
    id: `skills-sh:${entry.source}#${entry.skillId}`,
    sourceId: 'skills-sh',
    key: `github:${entry.source}#${entry.skillId}`,
    installKind: 'skill',
    name: entry.name,
    repo: entry.source,
    // The board prints no description; the skill's own page does, but reading 600 detail pages to fill
    // one column would be 600 requests for a field the drawer resolves on click.
    description: null,
    url: `https://www.skills.sh/${entry.source}/${entry.skillId}`,
    stars: null,
    // The board states no per-skill date. `''` = unknown (the console renders "—"), never "today".
    updatedAt: '',
    topics: [],
  };
}

export async function browseSkillsSh(
  query: string,
  limit = 24,
  page = 1,
  sort = 'all-time'
): Promise<BrowseResult> {
  const board = isSkillsShBoard(sort) ? sort : 'all-time';
  const typed = query.trim();
  const size = Math.min(Math.max(limit, 1), 50);
  const offset = (Math.max(page, 1) - 1) * size;

  // A query of 2+ characters goes to the site's own search endpoint, which covers the WHOLE catalog —
  // not one board. An empty query (and a 1-character term, which that endpoint refuses with
  // `400 "Query must be at least 2 characters"`) is answered from the board.
  const viaSearch = typed.length >= SKILLS_SH_MIN_QUERY;

  if (viaSearch) {
    const cacheKey = `skills-sh|q|${typed.toLowerCase()}`;
    let rows: MarketItem[];
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      rows = hit.items;
    } else {
      const read = await searchSkillsSh(typed, fetch);
      if (!read.ok) return read;
      rows = read.slots.filter((entry): entry is SkillsShEntry => entry !== null).map(toSkillsShItem);
      cache.set(cacheKey, { at: Date.now(), items: rows });
    }
    const items = rows.slice(offset, offset + size);
    // A search answer caps at 200 rows and the endpoint ignores `offset`/`page`/`cursor`, so its count
    // is a WINDOW: the pager needs it for page buttons, but the summary stays hidden (`totalScope`).
    return {
      ok: true,
      items,
      hasMore: offset + items.length < rows.length,
      total: rows.length,
      totalScope: 'window',
      note: `full-catalog skills.sh search — at most ${SKILLS_SH_SEARCH_LIMIT} matches per query (the endpoint ignores paging)`,
      noteCode: 'skills-sh-search',
      noteParams: { n: String(SKILLS_SH_SEARCH_LIMIT) },
    };
  }

  // The board is PAGED UPSTREAM — `/api/skills/<view>/<n>`, 0-based, 200 rows an answer, and the answer
  // states its own `total` — so a console page is a slice of the upstream pages it straddles. This is
  // how the site's own leaderboard reaches row 601: the console asks for the same pages, caches each one
  // for the shared TTL, and never re-ranks (the site's order IS the ranking).
  const firstPage = Math.floor(offset / SKILLS_SH_PAGE_SIZE);
  const lastPage = Math.floor((offset + size - 1) / SKILLS_SH_PAGE_SIZE);
  // Slots, not entries: the slice is taken by the SITE's row index (its ranking), then the rows with no
  // installable identity are dropped. Dropping first would shift every later row, so page N would
  // repeat or skip rows after the first `open.feishu.cn` entry.
  const merged: (SkillsShEntry | null)[] = [];
  let rawRows = 0;
  let total: number | undefined;
  let upstreamHasMore = false;
  for (let n = firstPage; n <= lastPage; n += 1) {
    const cacheKey = `skills-sh|b|${board}|${n}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < BOARD_TTL_MS) {
      merged.push(...(hit.slots ?? []));
      rawRows += hit.rows ?? (hit.slots ?? []).length;
      total = hit.catalogSize ?? total;
      upstreamHasMore = hit.hasMore ?? false;
    } else {
      const read = await fetchSkillsShPage(board, n, fetch);
      if (!read.ok) return read;
      merged.push(...read.slots);
      rawRows += read.rows;
      total = read.total ?? total;
      upstreamHasMore = read.hasMore === true;
      cache.set(cacheKey, {
        at: Date.now(),
        items: [],
        slots: read.slots,
        rows: read.rows,
        hasMore: read.hasMore,
        ...(read.total !== undefined ? { catalogSize: read.total } : {}),
      });
    }
  }

  const start = offset - firstPage * SKILLS_SH_PAGE_SIZE;
  const items = merged
    .slice(start, start + size)
    .filter((entry): entry is SkillsShEntry => entry !== null)
    .map(toSkillsShItem);
  const served = offset + size;
  const totalRows = total ?? 0;
  return {
    ok: true,
    items,
    // `hasMore` = more rows exist either upstream or in the stated total. A board whose tail is shorter
    // than one answer reports `hasMore: false` on its last page, so the two agree by construction.
    hasMore: upstreamHasMore || (totalRows > 0 && served < totalRows),
    ...(totalRows > 0 ? { total: totalRows } : {}),
    note: totalRows > 0
      ? `skills.sh leaderboard — ${totalRows} ranked skills, read ${SKILLS_SH_PAGE_SIZE} rows at a time from the site's own paging endpoint`
      : `skills.sh leaderboard — ${rawRows} rows on this page (the site states no total)`,
    noteCode: 'skills-sh-board',
    noteParams: totalRows > 0 ? { n: String(totalRows) } : { n: String(rawRows) },
  };
}

/**
 * ClawHub (source `clawhub`) — the browse half of `harness/clawhub.ts`.
 *
 * TWO reads, and which one answers depends on the query:
 *  - an EMPTY query is answered from the catalog endpoint (`/api/v1/skills`), cursor-paged, so a
 *    console page walks the recorded cursor chain the way the MCP registry market does — page N
 *    costs N reads once, then the chain remembers them, and a page past the walk limit is a typed
 *    refusal. The registry publishes no count for the listing, so the console shows the page number
 *    without inventing a total.
 *  - a typed query goes to `/api/v1/search`, which has NO paging parameter: one answer is the whole
 *    reach of the query (`totalScope: 'window'`, the skills.sh-search treatment), sliced locally.
 *  - Every row installs from ClawHub's own versioned store (`clawhub:<owner>/<slug>`): the registry
 *    pins by version, not by commit, so no repo is claimed and `stars` stays `null` — the registry's
 *    own star/download/install tally travels in `registryStats` instead, where the console can label
 *    it as ClawHub's (the skills.sh rule).
 */
function toClawHubItem(entry: ClawHubEntry): MarketItem {
  return {
    id: `clawhub:${entry.ownerHandle}/${entry.slug}`,
    sourceId: 'clawhub',
    key: `clawhub:${entry.ownerHandle}/${entry.slug}`,
    installKind: 'skill',
    name: entry.name,
    description: entry.summary,
    // The registry's usage terms ask third-party directories to link the canonical page, which is
    // also where the operator can read the skill's own record before installing it.
    url: `https://clawhub.ai/${entry.ownerHandle}/skills/${entry.slug}`,
    stars: null,
    ...(entry.stats ? { registryStats: entry.stats } : {}),
    updatedAt: entry.updatedAtMs !== null ? new Date(entry.updatedAtMs).toISOString() : '',
    topics: entry.topics,
  };
}

/** One catalog page as market rows, cached by its own upstream index so a page costs one read. */
async function clawhubCatalogPage(
  sort: string,
  size: number,
  index: number,
  cursor: string
): Promise<{ ok: true; items: MarketItem[]; next: string | null } | { ok: false; code: 'upstream' | 'unavailable'; reason?: FailureReason; reasonParams?: Record<string, string>; message: string }> {
  const cacheKey = `clawhub|${sort}|${size}|${index}`;
  const hit = clawhubPages.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, items: hit.items, next: hit.next };
  const read = await fetchClawHubCatalogPage(sort, size, cursor || null);
  if (!read.ok) return read;
  const items = read.entries.map(toClawHubItem);
  clawhubPages.set(cacheKey, { at: Date.now(), items, next: read.next });
  return { ok: true, items, next: read.next };
}

export async function browseClawHub(query: string, limit = 24, page = 1, sort = 'downloads'): Promise<BrowseResult> {
  const q = query.trim();
  const size = Math.min(Math.max(limit, 1), 50);
  const at = Math.max(page, 1);

  if (q) {
    const cacheKey = `clawhub|q|${q.toLowerCase()}`;
    let rows: MarketItem[];
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      rows = hit.items;
    } else {
      const read = await fetchClawHubSearch(q);
      if (!read.ok) return read;
      rows = read.entries.map(toClawHubItem);
      cache.set(cacheKey, { at: Date.now(), items: rows });
    }
    const offset = (at - 1) * size;
    const items = rows.slice(offset, offset + size);
    // The search endpoint ignores every paging parameter, so its answer count is a WINDOW: the pager
    // keeps the number for its page buttons but the summary stays hidden (`totalScope`).
    return {
      ok: true,
      items,
      hasMore: offset + items.length < rows.length,
      total: rows.length,
      totalScope: 'window',
      note: `full-catalog ClawHub search — at most ${CLAWHUB_SEARCH_LIMIT} matches per query (the endpoint has no paging)`,
      noteCode: 'clawhub-search',
      noteParams: { n: String(CLAWHUB_SEARCH_LIMIT) },
    };
  }

  // The catalog walk: extend the (sort, size) chain in place so later pages are one read each.
  if (at > CLAWHUB_WALK_MAX) {
    return {
      ok: false,
      code: 'unavailable',
      reason: 'unavailable',
      message: `page ${at} is past the ${CLAWHUB_WALK_MAX}-page cursor walk limit`,
    };
  }
  const chainKey = `clawhub|cursors|${sort}|${size}`;
  let chain = clawhubCursors.get(chainKey);
  if (!chain || Date.now() - chain.at >= CACHE_TTL_MS) {
    chain = { at: Date.now(), cursors: [''] };
    clawhubCursors.set(chainKey, chain);
  }
  while (chain.cursors.length - 1 < at - 1) {
    const prev = await clawhubCatalogPage(sort, size, chain.cursors.length - 1, chain.cursors[chain.cursors.length - 1]!);
    if (!prev.ok) return prev;
    if (prev.next === null) break;
    chain.cursors.push(prev.next);
  }
  const index = at - 1;
  const beyond = index > chain.cursors.length - 1;
  const read = beyond ? null : await clawhubCatalogPage(sort, size, index, chain.cursors[index]!);
  if (read && !read.ok) return read;
  return {
    ok: true,
    items: read?.items ?? [],
    hasMore: read !== null && read.next !== null,
    note: 'ClawHub community registry — rows install from the registry\u2019s own store, pinned to a version',
    noteCode: 'clawhub-catalog',
  };
}

/** One browse request, dispatched by the source view. The source's OWN declared sorts are the only
 *  orders that travel upstream — the facade never invents an ordering a source did not declare. */
export async function browseSource(
  source: HarnessSourceView,
  query: string,
  limit: number,
  opts: { harness?: string; page?: number; sort?: string; refresh?: boolean; kind?: HarnessKind; fetchImpl?: typeof fetch } = {}
): Promise<BrowseResult> {
  const page = Math.max(opts.page ?? 1, 1);
  // Only an order this source DECLARES may travel upstream; anything else is not the console's to ask.
  const sort = opts.sort && source.sorts?.includes(opts.sort) ? opts.sort : source.sorts?.[0];
  if (!source.enabled) {
    return {
      ok: false,
      code: 'unavailable',
      reason: 'unavailable',
      message: source.unavailableReason ?? `${source.label} is unavailable`,
    };
  }
  // A forced re-read drops this source's window BEFORE the adapter computes its cache key, so the
  // adapter's own read-through starts from an empty family and genuinely asks upstream.
  if (opts.refresh) evictBrowseCache(source.id);
  if (source.id === 'github') return browseGitHub(query, limit, page, sort);
  if (source.id === 'npm')
    return browseNpm(
      query,
      limit,
      npmDefaultQueryFor(opts.kind, opts.harness ?? ''),
      page,
      sort,
      // Rows the MCP axis installs as `mcp`; the skill axis keeps the extension payload path (a
      // package-shaped skill installs through the runtime's package store), so only mcp forks here.
      opts.kind === 'mcp' ? 'mcp' : 'plugin'
    );
  if (source.id === 'pi-dev') return browsePiDev(query, limit, page, sort, opts.fetchImpl);
  if (source.id === 'skills-sh') return browseSkillsSh(query, limit, page, sort);
  if (source.id === 'clawhub') return browseClawHub(query, limit, page, sort);
  return { ok: false, code: 'unsupported_source', reason: 'unsupportedSource', message: `no browse adapter for '${source.id}' yet` };
}

