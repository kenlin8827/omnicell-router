import { cache, CACHE_TTL_MS, registerBrowseCache, registerBrowseView, SLOW_CACHE_TTL_MS } from '../common/market.js';
import type { BrowseResult, MarketItem } from '../common/market.js';
import { catalogRegistry } from '../common/catalog-registry.js';
import type { HarnessSourceView } from '../types.js';
import { describeFetchFailure, fetchFailureReason, fetchWithRetry, readTextCapped, type FailureReason } from '../net.js';

/**
 * skills.sh leaderboard reader (ADR-0015 §D6 amendment, 2026-11-10).
 *
 * WHY THE SITE'S ENDPOINTS, NOT ITS API: `GET /api/v1/skills` answers 401 without a Vercel OIDC
 * token, a workload identity this gateway cannot hold. Everything below reads what the SITE's own
 * browser reads:
 *
 *   · `GET /api/skills/<view>/<page>` — anonymous, 0-based pages of 200 rows, with `total` and
 *     `hasMore`. This is the board itself (`all-time`, `trending`, `hot`) and the source's three
 *     orderings.
 *   · `GET /api/search?q=&limit=` — anonymous, whole-catalog search; a term under two characters is
 *     refused, `limit` caps at 200, and every offset parameter is ignored (a window, not a page).
 *
 * Rows install through the GitHub writer as `github:<owner/repo>#<skill-dir>` — the site's own
 * `npx skills add` identity. Rows whose source is not an `owner/repo` repository (a vendor registry)
 * are dropped before they reach the market. The board's order IS the ranking; the console never
 * re-sorts it.
 */

const SITE = 'https://www.skills.sh';

/** The three boards the site publishes, in the site's own tab order. */
export const SKILLS_SH_BOARDS = ['all-time', 'trending', 'hot'] as const;
export type SkillsShBoard = (typeof SKILLS_SH_BOARDS)[number];

/** Rows one BOARD answer carries — the site's own page size, not a console choice. */
export const SKILLS_SH_PAGE_SIZE = 200;

/** Rows one SEARCH answer can carry (the endpoint caps here and ignores offsets). */
export const SKILLS_SH_SEARCH_LIMIT = 200;

/** The search endpoint refuses anything shorter (`400 "Query must be at least 2 characters"`). */
export const SKILLS_SH_MIN_QUERY = 2;

export interface SkillsShEntry {
  /** `owner/repo` — the repository the skill lives in, and the install identity's first half. */
  source: string;
  /** Skill directory inside that repository, and the install identity's `#detail` half. */
  skillId: string;
  name: string;
}

export type SkillsShRead =
  | {
      ok: true;
      /** One slot per upstream row, `null` where the row has no installable identity. Keeping the
       *  nulls lets the caller slice by the SITE's ranking before dropping them. */
      slots: (SkillsShEntry | null)[];
      rows: number;
      total?: number;
      hasMore?: boolean;
    }
  | {
      ok: false;
      code: 'unavailable' | 'upstream';
      reason: FailureReason;
      reasonParams?: Record<string, string>;
      message: string;
    };

export function isSkillsShBoard(value: string): value is SkillsShBoard {
  return (SKILLS_SH_BOARDS as readonly string[]).includes(value);
}

/** Same grammar the GitHub skill writer accepts: `owner/name`, and a single path-like directory. */
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SKILL_DIR = /^[\w.-]+$/;

function toSlots(rows: unknown[]): (SkillsShEntry | null)[] {
  const slots: (SkillsShEntry | null)[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      slots.push(null);
      continue;
    }
    const record = row as Record<string, unknown>;
    const source = typeof record.source === 'string' ? record.source.trim() : '';
    const skillId = typeof record.skillId === 'string' ? record.skillId.trim() : '';
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : skillId;
    slots.push(OWNER_REPO.test(source) && SKILL_DIR.test(skillId) ? { source, skillId, name } : null);
  }
  return slots;
}

async function readJson(
  url: string,
  label: string,
  fetchImpl: typeof fetch
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; code: 'unavailable' | 'upstream'; reason: FailureReason; reasonParams?: Record<string, string>; message: string }
> {
  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' } },
      undefined,
      { fetchImpl }
    );
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure(label, e) };
  }
  if (res.status === 429 || res.status >= 500) {
    return {
      ok: false,
      code: 'unavailable',
      reason: 'unavailable',
      message: `${label} returned HTTP ${res.status} — try again later`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: String(res.status) },
      message: `${label} returned HTTP ${res.status}`,
    };
  }
  try {
    const body = await readTextCapped(res);
    if (!body.ok) {
      return {
        ok: false,
        code: 'upstream',
        reason: 'badPayload',
        message: `${label} answered more than ${body.cap} bytes — refused`,
      };
    }
    return { ok: true, body: JSON.parse(body.text) };
  } catch (e) {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: describeFetchFailure(label, e) };
  }
}

/** Read ONE board page (`GET /api/skills/<view>/<page>`, 0-based, 200 rows). */
export async function fetchSkillsShPage(
  board: SkillsShBoard,
  page: number,
  fetchImpl: typeof fetch = fetch
): Promise<SkillsShRead> {
  const index = Math.max(0, Math.floor(page));
  const read = await readJson(`${SITE}/api/skills/${board}/${index}`, 'skills.sh board', fetchImpl);
  if (!read.ok) return read;
  const body = read.body as { skills?: unknown; hasMore?: unknown; total?: unknown } | null;
  const rows = body?.skills;
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'markupChanged',
      message: 'skills.sh board answered no `skills` array — the endpoint changed shape',
    };
  }
  const total = typeof body?.total === 'number' && Number.isFinite(body.total) ? body.total : undefined;
  const slots = toSlots(rows);
  return {
    ok: true,
    slots,
    rows: rows.length,
    ...(total !== undefined ? { total } : {}),
    hasMore: body?.hasMore === true,
  };
}

/** Read ONE search answer; the caller enforces the site's 2-character minimum. */
export async function searchSkillsSh(
  query: string,
  fetchImpl: typeof fetch = fetch,
  limit = SKILLS_SH_SEARCH_LIMIT
): Promise<SkillsShRead> {
  const url = `${SITE}/api/search?q=${encodeURIComponent(query.trim())}&limit=${Math.min(Math.max(limit, 1), SKILLS_SH_SEARCH_LIMIT)}`;
  const read = await readJson(url, 'skills.sh search', fetchImpl);
  if (!read.ok) return read;
  const rows = (read.body as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'markupChanged',
      message: 'skills.sh search answered no `skills` array — the endpoint changed shape',
    };
  }
  return { ok: true, slots: toSlots(rows), rows: rows.length };
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

interface BoardPage {
  at: number;
  slots: (SkillsShEntry | null)[];
  rows: number;
  total?: number;
  hasMore: boolean;
}

const boardPages = new Map<string, BoardPage>();

function toItem(entry: SkillsShEntry): MarketItem {
  return {
    id: `skills-sh:${entry.source}#${entry.skillId}`,
    sourceId: 'skills-sh',
    catalog: 'skills.sh',
    key: `github:${entry.source}#${entry.skillId}`,
    installKind: 'skill',
    name: entry.name,
    repo: entry.source,
    description: null,
    url: `${SITE}/${entry.source}/${entry.skillId}`,
    stars: null,
    updatedAt: '',
    topics: [],
  };
}

/**
 * Browse skills.sh. Empty (or 1-character) queries read the chosen BOARD with the site's own paging;
 * 2+ characters search the whole catalog through the site's own search endpoint, which is a capped
 * window. Every row installs as `github:<owner/repo>#<skill-dir>`.
 */
export async function browseSkillsSh(
  query: string,
  limit = 24,
  page = 1,
  sort = 'all-time',
  fetchImpl: typeof fetch = fetch
): Promise<BrowseResult> {
  const board = isSkillsShBoard(sort) ? sort : 'all-time';
  const typed = query.trim();
  const size = Math.min(Math.max(limit, 1), 50);
  const offset = (Math.max(page, 1) - 1) * size;

  if (typed.length >= SKILLS_SH_MIN_QUERY) {
    const cacheKey = `skills-sh|q|${typed.toLowerCase()}`;
    let rows: MarketItem[];
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      rows = hit.items;
    } else {
      const read = await searchSkillsSh(typed, fetchImpl);
      if (!read.ok) return read;
      rows = read.slots.filter((entry): entry is SkillsShEntry => entry !== null).map(toItem);
      cache.set(cacheKey, { at: Date.now(), items: rows });
    }
    const items = rows.slice(offset, offset + size);
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

  const firstPage = Math.floor(offset / SKILLS_SH_PAGE_SIZE);
  const lastPage = Math.floor((offset + size - 1) / SKILLS_SH_PAGE_SIZE);
  const merged: (SkillsShEntry | null)[] = [];
  let rawRows = 0;
  let total: number | undefined;
  let upstreamHasMore = false;
  for (let n = firstPage; n <= lastPage; n += 1) {
    const cacheKey = `skills-sh|b|${board}|${n}`;
    const hit = boardPages.get(cacheKey);
    // The slow window: a leaderboard moves over days, and the site throttles a burst with
    // `429 Retry-After: 60`, so re-asking every minute would spend a budget the board does not use.
    if (hit && Date.now() - hit.at < SLOW_CACHE_TTL_MS) {
      merged.push(...hit.slots);
      rawRows += hit.rows;
      total = hit.total ?? total;
      upstreamHasMore = hit.hasMore;
    } else {
      const read = await fetchSkillsShPage(board, n, fetchImpl);
      if (!read.ok) return read;
      merged.push(...read.slots);
      rawRows += read.rows;
      total = read.total ?? total;
      upstreamHasMore = read.hasMore === true;
      boardPages.set(cacheKey, {
        at: Date.now(),
        slots: read.slots,
        rows: read.rows,
        ...(read.total !== undefined ? { total: read.total } : {}),
        hasMore: read.hasMore === true,
      });
    }
  }

  const start = offset - firstPage * SKILLS_SH_PAGE_SIZE;
  const items = merged
    .slice(start, start + size)
    .filter((entry): entry is SkillsShEntry => entry !== null)
    .map(toItem);
  const totalRows = total ?? 0;
  return {
    ok: true,
    items,
    hasMore: upstreamHasMore || (totalRows > 0 && offset + size < totalRows),
    ...(totalRows > 0 ? { total: totalRows } : {}),
    note: totalRows > 0
      ? `skills.sh leaderboard — ${totalRows} ranked skills, read ${SKILLS_SH_PAGE_SIZE} rows at a time from the site's own paging endpoint`
      : `skills.sh leaderboard — ${rawRows} rows on this page (the site states no total)`,
    noteCode: 'skills-sh-board',
    noteParams: { n: String(totalRows > 0 ? totalRows : rawRows) },
  };
}

/** The skills.sh chip on every skill page — a global directory like ClawHub. */
export const SKILLS_SH_VIEW: HarnessSourceView = {
  id: 'skills-sh',
  catalog: 'skills.sh',
  label: 'skills.sh',
  kinds: ['skill'],
  trust: 'aggregator',
  auth: 'none',
  enabled: true,
  browsable: true,
  sorts: ['all-time', 'trending', 'hot'],
  browse: browseSkillsSh,
};

registerBrowseCache('skills-sh', () => {
  boardPages.clear();
  for (const key of [...cache.keys()]) if (key.startsWith('skills-sh|')) cache.delete(key);
});

registerBrowseView(SKILLS_SH_VIEW);

catalogRegistry.register({
  id: 'skills-sh',
  catalog: 'skills.sh',
  label: SKILLS_SH_VIEW.label,
  kinds: ['skill'],
  trust: 'aggregator',
  builtin: true,
  sorts: ['all-time', 'trending', 'hot'],
  browse: browseSkillsSh,
});
