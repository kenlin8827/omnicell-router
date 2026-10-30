/**
 * skills.sh leaderboard reader.
 *
 * WHY A PAGE READER AND NOT THE API: `GET https://www.skills.sh/api/v1/skills` answers
 * `401 {"error":"authentication_required"}` and its own body names the credential — "Pass a Vercel OIDC
 * token (Authorization: Bearer <VERCEL_OIDC_TOKEN>)". That token is minted inside a Vercel deployment
 * and expires within the hour, so no local gateway can hold one: it is not an operator secret, it is a
 * workload identity. Everything below reads what the SITE's own browser reads.
 *
 * THE BOARD IS PAGED, and the console must page it the same way. Measured 2026-10-25 (anonymous, from
 * this environment):
 *   `GET /api/skills/<view>/<page>` → 200, 0-BASED page, **200 rows** per answer, and the answer states
 *      its own size: `{skills: [{source, skillId, name, installs, …}], hasMore, total}`.
 *      Measured: `all-time` total **9 911** (pages 0…49, page 49 = 111 rows, `hasMore: false`),
 *      `trending` total **9 959**, `hot` total **6 765**.
 *   `/`, `/trending`, `/hot`          → 200, server-rendered: the FIRST 600 rows (three site pages) sit
 *      in the Next.js RSC flight payload (`"initialSkills"`), together with `"totalSkills"` (the same
 *      9 911) and `"allTimeTotal"` (1 504 860 — INSTALLS, not skills).
 *      That payload is only the first screen: the site's own leaderboard component keeps fetching
 *      `/api/skills/<view>/<n>` from page 3 onward as the operator scrolls (`pageSize: 200`).
 *   `?q=`                             → IGNORED: `/trending?q=pdf` answered byte-identical to
 *      `/trending`, so a board has no server-side search.
 *   transport                         → the CDN drops bursts from here (`000` connection resets on
 *      roughly one attempt in three), which is why every read goes through the shared retry policy.
 *
 * SEARCH is a different, capped read: the site's own search box calls
 * `GET /api/search?q=<term>&limit=<n>` — the same undocumented sibling of the closed `/api/v1/*` API,
 * and it answers **200 anonymously** because the BROWSER calls it, not a server function. Measured
 * 2026-10-25: results are `{query, searchType:"fuzzy", searchVersion:"algolia", skills:[{id, source,
 * skillId, name, installs}], count, duration_ms}`; `limit` caps at **200** (500 → 200 rows); `offset`,
 * `page` and `cursor` are all IGNORED (identical first page), and `count` is the RETURNED row count,
 * not a catalogue tally. A term shorter than 2 characters answers
 * `400 {"error":"Query must be at least 2 characters"}`, so a short term is filtered over the board by
 * the caller.
 *
 * Deliberately NOT carried: `installs`, `weeklyInstalls`, `installsYesterday`, `isOfficial`. The market
 * row's popularity field is a GitHub star count (`harness/stars.ts` resolves it on demand), and printing
 * an install count under it would relabel one number as another; `isOfficial` is the SITE's status, and
 * this console's trust vocabulary belongs to a source, not a row. The board's own ORDER is preserved
 * (it IS the ranking) and that is the whole ranking signal this source contributes.
 *
 * A board also lists rows that are NOT GitHub repositories — measured 2026-10-25, the all-time board's
 * 31 `open.feishu.cn` skills (a vendor's own registry). Those have no `owner/repo` to install from, so
 * they are dropped rather than given an invented identity, and the browse note counts what survives.
 */

import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from '../net.js';

const SITE = 'https://www.skills.sh';

/** The three boards the site publishes, in the site's own tab order. */
export const SKILLS_SH_BOARDS = ['all-time', 'trending', 'hot'] as const;
export type SkillsShBoard = (typeof SKILLS_SH_BOARDS)[number];

/** Rows one BOARD answer carries — the site's own page size, not a console choice. */
export const SKILLS_SH_PAGE_SIZE = 200;

/**
 * Rows one SEARCH answer can carry. The site's own search box asks for 100; the endpoint caps at 200
 * (measured: `limit=500` answered 200), and it ignores every offset parameter, so 200 is the whole
 * reach of one query.
 */
export const SKILLS_SH_SEARCH_LIMIT = 200;

/** The search endpoint refuses anything shorter (`400 "Query must be at least 2 characters"`). */
export const SKILLS_SH_MIN_QUERY = 2;

export interface SkillsShEntry {
  /** `owner/repo` — the repository the skill lives in, and the install identity's first half. */
  source: string;
  /** Skill directory inside that repository, and the install identity's `#detail` half. */
  skillId: string;
  /** Display name (the site's own `name`, falling back to `skillId`). */
  name: string;
}

export type SkillsShRead =
  | {
      ok: true;
      /**
       * One slot per row the answer carried, in the source's own order — `null` where the row has no
       * installable identity (a vendor registry's `open.feishu.cn` entry, or a skill id that is not a
       * single path segment). Board reads keep the nulls so a caller can slice by UPSTREAM row index
       * (the site's ranking) and only then drop them; search reads hand over a compacted list, because
       * their answer has no stated size to stay aligned with.
       */
      slots: (SkillsShEntry | null)[];
      /** Rows the answer carried, before the install-grammar filter — `slots.length`. */
      rows: number;
      /** Rows the source says the whole board holds, when the answer states one (board reads: 9 911
       *  on All-time). A SEARCH answer has no such figure — its `count` is the returned row count. */
      total?: number;
      /** Whether another page exists upstream — the site's own `hasMore`. */
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

/**
 * Rows → slots, ONE PER ROW: the identity grammar decides what the market may offer, but the position
 * is kept so a caller can slice the board by the SITE's own row index (its ranking) before dropping the
 * un-installable ones. A dropped row must not shift every row after it.
 *
 * Shared by both reads: a board row and a search row carry the same `{source, skillId, name}`, and
 * `owner/repo` + directory is exactly the install grammar (`github:owner/repo#dir`, see `install.ts`).
 */
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

/** One JSON read of the site's own endpoints, with the shared retry policy and the failure vocabulary
 *  every other adapter answers with. */
async function readJson(
  url: string,
  label: string,
  fetchImpl: typeof fetch
): Promise<{ ok: true; body: unknown } | { ok: false; code: 'unavailable' | 'upstream'; reason: FailureReason; reasonParams?: Record<string, string>; message: string }> {
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
    return { ok: true, body: JSON.parse(await res.text()) };
  } catch (e) {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: describeFetchFailure(label, e) };
  }
}

/**
 * Read ONE board page (`GET /api/skills/<view>/<page>`, 0-based, 200 rows).
 *
 * This is the endpoint the site's own leaderboard component calls while the operator scrolls, so it is
 * the only honest way for the console to reach row 601 and beyond — the server-rendered page carries
 * just the first three answers.
 */
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

/**
 * Read ONE search answer (`GET /api/search`). `query` must already satisfy the site's 2-character
 * minimum — the caller decides that, because "too short to search" is a UI fact, not a fetch failure.
 *
 * The 200-row cap is the endpoint's own: it ignores `offset`/`page`/`cursor`, so asking for row 201 of
 * a broad match is not a request this reader can make. The caller reports the cap instead of paging
 * into a void.
 */
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
