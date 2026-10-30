/**
 * On-demand GitHub star resolver for market rows.
 *
 * Most catalogs this market reads publish no popularity signal: npm states downloads, the Pi catalog
 * states downloads, the community registries state neither. Their rows carry `stars: null`, and the
 * console shows "unknown" rather than the false claim "0 stars". A row that DOES name a repository can
 * still get a real count — but only when the operator asks, because the number costs quota:
 *
 *  - anonymous GitHub search is 10 requests/minute, and the per-repository REST endpoint is 60/hour;
 *  - the SEARCH endpoint accepts several `repo:` qualifiers in one query, so a page of 24 rows costs
 *    ~3 requests instead of 24 — one query answers up to as many repositories as fit in `q` (GitHub
 *    caps a query near 256 characters, which is ~8 repositories);
 *  - a resolved count is cached for a day (`TTL_MS`), so paging back and forth — or reloading the
 *    console — does not re-spend the budget.
 *
 * The resolver is deliberately NOT wired into browse: a market read must never silently spend the
 * operator's quota on enrichment they did not ask for. `GITHUB_TOKEN` raises the ceiling when set
 * (the header is shared with browse through `githubHeaders`).
 */

import { githubHeaders } from './browse.js';
import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from '../net.js';

const API = 'https://api.github.com';

/**
 * How long a resolved count is reused: ONE DAY.
 *
 * Stars are a slow-moving popularity signal, so the number stays useful long after it was read, and
 * a day bounds the staleness to something a reader would accept for a comparison column. The cache
 * lives in the gateway process, so a restart also clears it — the TTL is the ceiling, not a promise.
 * (An earlier 15-minute value was pure quota paranoia: the console now shows cached counts on render
 * through `peekStarCache`, so a short TTL only hid data it already had.)
 */
const TTL_MS = 24 * 60 * 60_000;

/** Query budget for `repo:` qualifiers — GitHub caps `q` near 256 characters. */
const QUERY_BUDGET = 230;

/** One request resolves at most this many repositories: a page's worth, never an unbounded crawl. */
export const STARS_MAX_REPOS = 100;

/** Same grammar as a GitHub slug: two non-empty path halves, nothing shell-shaped. */
const REPO_GRAMMAR = /^[\w.-]+\/[\w.-]+$/;

const cache = new Map<string, { stars: number | null; at: number }>();

/** Drop the star cache. Test-only: the TTL is a quota shield, not a correctness contract. */
export function resetStarCache(): void {
  cache.clear();
}

/**
 * Answer from the cache ONLY — never a request.
 *
 * This is what makes a proactive display safe. The console can ask "what do you already know about
 * the repositories I am showing?" on every page turn, and a miss stays a miss instead of becoming a
 * GitHub search the operator never asked for. The TTL applies here too: an expired entry is a miss,
 * so a stale number is never pinned on screen for longer than a fresh click would have reused it.
 */
export function peekStarCache(repos: readonly string[]): {
  stars: Record<string, number>;
  missing: string[];
  cached: number;
} {
  const wanted = normalizeRepos(repos);
  const stars: Record<string, number> = {};
  const missing: string[] = [];
  const now = Date.now();
  for (const repo of wanted) {
    const hit = cache.get(repo);
    if (!hit || now - hit.at >= TTL_MS || hit.stars === null) {
      missing.push(repo);
      continue;
    }
    stars[repo] = hit.stars;
  }
  return { stars, missing, cached: Object.keys(stars).length };
}

export type StarsRead =
  | {
      ok: true;
      /** `owner/repo` (lowercase) → star count. Repositories GitHub did not answer appear in `missing`. */
      stars: Record<string, number>;
      /** Requested repositories this pass could not resolve (deleted, private, renamed, or a fork). */
      missing: string[];
      /** How many of the requested repositories were already cached — the reason a click was free. */
      cached: number;
    }
  | {
      ok: false;
      code: 'unavailable' | 'upstream';
      reason: FailureReason;
      reasonParams?: Record<string, string>;
      message: string;
    };

/** Normalize a caller's repository list: validated, deduped, lowercased, and bounded. */
export function normalizeRepos(repos: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of repos) {
    const repo = raw.trim().replace(/\.git$/, '').toLowerCase();
    if (!REPO_GRAMMAR.test(repo)) continue;
    if (!out.includes(repo)) out.push(repo);
    if (out.length >= STARS_MAX_REPOS) break;
  }
  return out;
}

/**
 * Split repositories into queries that stay inside GitHub's `q` budget.
 *
 * The chunk boundary is the QUERY LENGTH, not a fixed count: `repo:owner/name` costs its own length
 * plus a space, so a fixed "8 per request" would overflow the cap on long slugs and waste the budget
 * on short ones.
 */
export function chunkRepos(repos: readonly string[], budget = QUERY_BUDGET): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const repo of repos) {
    const cost = `repo:${repo}`.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && length + cost > budget) {
      chunks.push(current);
      current = [repo];
      length = `repo:${repo}`.length;
      continue;
    }
    current.push(repo);
    length += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface SearchHit {
  full_name: string;
  stargazers_count: number;
}

/**
 * Resolve stars for the given repositories, one batched search per query chunk.
 *
 * Cached repositories are answered without a request; only the remainder is fetched. A failed chunk
 * answers its reason and the whole read fails — a partial answer rendered as "the rest have no stars"
 * would invent data.
 */
export async function fetchRepoStars(
  repos: readonly string[],
  fetchImpl: typeof fetch = fetch
): Promise<StarsRead> {
  const wanted = normalizeRepos(repos);
  const stars: Record<string, number> = {};
  const pending: string[] = [];
  let cached = 0;

  const now = Date.now();
  for (const repo of wanted) {
    const hit = cache.get(repo);
    if (hit && now - hit.at < TTL_MS) {
      cached += 1;
      // A cached `null` is a KNOWN miss: the repository could not be searched minutes ago, and
      // re-asking on every click spends quota to learn the same thing.
      if (hit.stars !== null) stars[repo] = hit.stars;
    } else {
      pending.push(repo);
    }
  }

  for (const chunk of chunkRepos(pending)) {
    const q = chunk.map((repo) => `repo:${repo}`).join(' ');
    const url = `${API}/search/repositories?q=${encodeURIComponent(q)}&per_page=${STARS_MAX_REPOS}`;
    let res: Response;
    try {
      // Every failed answer is retried inside the shared policy; a 403/429 that outlasts the
      // retries is mapped below.
      res = await fetchWithRetry(url, { headers: githubHeaders() }, undefined, { fetchImpl });
    } catch (e) {
      return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('GitHub star lookup', e) };
    }
    if (res.status === 403 || res.status === 429) {
      return {
        ok: false,
        code: 'unavailable',
        reason: 'rateLimited',
        message: 'GitHub search rate limit reached — set GITHUB_TOKEN to raise it',
      };
    }
    // 422 is GitHub's answer when NOTHING in the query is searchable ("the listed … repositories
    // cannot be searched either because the resources do not exist or you do not have permission").
    // A chunk of renamed/deleted repos therefore resolves to "unknown" for those rows — an error here
    // would fail the whole page over repositories that simply cannot be asked about.
    if (res.status === 422) {
      for (const repo of chunk) cache.set(repo, { stars: null, at: now });
      continue;
    }
    if (!res.ok) {
      return {
        ok: false,
        code: 'upstream',
        reason: 'http',
        reasonParams: { status: String(res.status) },
        message: `GitHub star lookup returned HTTP ${res.status}`,
      };
    }

    let payload: { items?: SearchHit[] };
    try {
      payload = (await res.json()) as { items?: SearchHit[] };
    } catch {
      return { ok: false, code: 'upstream', reason: 'badPayload', message: 'GitHub star lookup answered non-JSON content' };
    }

    // GitHub matches a renamed repository by its CURRENT name, so the answer is joined back on
    // `full_name` — a chunk's items are matched, never positionally zipped with the chunk.
    const answered = new Map<string, number>();
    for (const item of payload.items ?? []) {
      if (typeof item.full_name === 'string' && typeof item.stargazers_count === 'number') {
        answered.set(item.full_name.toLowerCase(), item.stargazers_count);
      }
    }
    for (const repo of chunk) {
      const count = answered.get(repo);
      if (count === undefined) continue;
      stars[repo] = count;
      cache.set(repo, { stars: count, at: now });
    }
  }

  const missing = wanted.filter((repo) => stars[repo] === undefined);
  // Remember the misses too — see the cache note above; without this a page holding one dead repo
  // re-spends a request on it every single click.
  for (const repo of missing) {
    if (!cache.has(repo)) cache.set(repo, { stars: null, at: now });
  }
  return { ok: true, stars, missing, cached };
}
