import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { browseSkillsSh, browseSource, resetBrowseCache } from '../src/harness/browse.js';
import { fetchSkillsShPage, searchSkillsSh, SKILLS_SH_PAGE_SIZE } from '../src/harness/skills-sh.js';
import type { HarnessSourceView } from '../src/harness/types.js';

/**
 * skills.sh is read the way the SITE's own browser reads it: `GET /api/skills/<view>/<page>` for a
 * board (0-based, 200 rows an answer, the answer states `total`/`hasMore`) and `GET /api/search?q=`
 * for a query (capped at 200, no paging). The closed `/api/v1/*` API wants a Vercel workload token and
 * is never called. The contract under test:
 *   · a board answer pages — page N holds rows N*200..N*200+199 of the site's own order;
 *   · the stated `total` is the board's size (9 911 on All-time), not the rows one answer carried;
 *   · rows whose ids cannot be addressed (`open.feishu.cn`) are dropped, and the note says how many;
 *   · every failure mode answers `upstream`/`unavailable`, never an empty market.
 */

const realFetch = globalThis.fetch;

/** One leaderboard row, shaped exactly like a measured skills.sh payload (2026-10-25). */
function row(source: string, skillId: string, installs = 1000) {
  return { source, skillId, name: skillId, installs };
}

/** A board answer as the site's endpoint frames it. */
function boardAnswer(rows: unknown[], total: number, hasMore: boolean): Response {
  return new Response(JSON.stringify({ skills: rows, total, hasMore }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Serve `/api/skills/<view>/<n>` from a full in-memory board (200 rows a page, like the site) and one
 * search answer for `/api/search`; record every URL asked for.
 */
function stubBoard(
  board: Record<string, unknown[]>,
  search: unknown[] = []
): { urls: string[]; queries: string[] } {
  const urls: string[] = [];
  const queries: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url.pathname);
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      queries.push(q);
      return new Response(JSON.stringify({ query: q, searchType: 'fuzzy', skills: search, count: search.length }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const match = /^\/api\/skills\/([a-z-]+)\/(\d+)$/.exec(url.pathname);
    if (!match) return new Response('not found', { status: 404 });
    const view = match[1]!;
    const index = Number(match[2]);
    const all = board[view] ?? [];
    const pageRows = all.slice(index * SKILLS_SH_PAGE_SIZE, (index + 1) * SKILLS_SH_PAGE_SIZE);
    return boardAnswer(pageRows, all.length, (index + 1) * SKILLS_SH_PAGE_SIZE < all.length);
  }) as unknown as typeof fetch;
  return { urls, queries };
}

function sourceView(overrides: Partial<HarnessSourceView> = {}): HarnessSourceView {
  return {
    id: 'skills-sh',
    label: 'skills.sh',
    kinds: ['skill'],
    trust: 'aggregator',
    auth: 'oidc',
    enabled: true,
    browsable: true,
    sorts: ['all-time', 'trending', 'hot'],
    ...overrides,
  };
}

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  resetBrowseCache();
});

describe('skills.sh board reads', () => {
  it('asks the endpoint the site itself pages with, 0-based', async () => {
    const seen = stubBoard({ 'all-time': [row('acme/skills', 'a')] });
    await fetchSkillsShPage('all-time', 0);
    expect(seen.urls).toEqual(['/api/skills/all-time/0']);
  });

  it('carries the board’s own `total` and `hasMore`', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row('acme/skills', `s${i}`));
    stubBoard({ 'all-time': rows });
    const first = await fetchSkillsShPage('all-time', 0);
    if (!first.ok) throw new Error('expected an ok read');
    expect(first.rows).toBe(SKILLS_SH_PAGE_SIZE);
    expect(first.total).toBe(250);
    expect(first.hasMore).toBe(true);

    const second = await fetchSkillsShPage('all-time', 1);
    if (!second.ok) throw new Error('expected an ok read');
    expect(second.rows).toBe(50);
    expect(second.hasMore).toBe(false);
  });

  it('drops rows whose ids cannot be addressed, and keeps the rest', async () => {
    stubBoard({
      'all-time': [row('acme/skills', 'kept'), { source: 'open.feishu.cn', skillId: 'lark-doc' }, { source: '', skillId: 'x' }],
    });
    const read = await fetchSkillsShPage('all-time', 0);
    if (!read.ok) throw new Error('expected an ok read');
    // One slot per upstream row: the position survives (so slicing by the site's rank stays aligned),
    // and `null` marks a row the install grammar cannot address.
    expect(read.rows).toBe(3);
    expect(read.slots).toHaveLength(3);
    expect(read.slots.map((s) => s?.skillId ?? null)).toEqual(['kept', null, null]);
  });

  it('answers `markupChanged` when the answer carries no skills array', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ rows: [] }), { status: 200 })) as unknown as typeof fetch;
    const read = await fetchSkillsShPage('hot', 0);
    expect(read).toMatchObject({ ok: false, code: 'upstream', reason: 'markupChanged' });
  });

  it('answers `unavailable` for a 5xx and `upstream/http` for a 404', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    expect(await fetchSkillsShPage('hot', 0)).toMatchObject({ ok: false, code: 'unavailable' });

    globalThis.fetch = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchSkillsShPage('hot', 0)).toMatchObject({
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: '404' },
    });
  }, 30_000);

  it('answers `upstream` when the connection is dropped', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchSkillsShPage('hot', 0)).toMatchObject({ ok: false, code: 'upstream' });
  }, 30_000);
});

describe('skills.sh browse', () => {
  it('reads the board the requested order names', async () => {
    const seen = stubBoard({ trending: [row('acme/skills', 'trending-one')] });
    const res = await browseSkillsSh('', 24, 1, 'trending');
    expect(seen.urls).toEqual(['/api/skills/trending/0']);
    if (!res.ok) throw new Error('expected an ok read');
    expect(res.items).toHaveLength(1);
  });

  it('falls back to the all-time board for an order the source never declared', async () => {
    const seen = stubBoard({ 'all-time': [row('acme/skills', 'a')] });
    const res = await browseSkillsSh('', 24, 1, 'stars');
    expect(seen.urls).toEqual(['/api/skills/all-time/0']);
    expect(res.ok).toBe(true);
  });

  it('maps a row onto the GITHUB install identity and the site’s own detail page', async () => {
    stubBoard({ 'all-time': [row('vercel-labs/skills', 'find-skills', 4034610)] });
    const res = await browseSkillsSh('', 24, 1, 'all-time');
    if (!res.ok) throw new Error('expected an ok read');
    expect(res.items[0]).toMatchObject({
      id: 'skills-sh:vercel-labs/skills#find-skills',
      key: 'github:vercel-labs/skills#find-skills',
      installKind: 'skill',
      sourceId: 'skills-sh',
      repo: 'vercel-labs/skills',
      url: 'https://www.skills.sh/vercel-labs/skills/find-skills',
      stars: null,
      description: null,
    });
  });

  it('reports the board’s own size as `total` — this source is NOT a window', async () => {
    // 300 rows: two site pages. The console's 24-row page is a slice of the FIRST site page.
    stubBoard({ 'all-time': Array.from({ length: 300 }, (_, i) => row('acme/skills', `s${i}`)) });
    const res = await browseSkillsSh('', 24, 1, 'all-time');
    if (!res.ok) throw new Error('expected an ok read');
    expect(res.items).toHaveLength(24);
    expect(res.total).toBe(300);
    expect(res.totalScope).toBeUndefined();
    expect(res.hasMore).toBe(true);
    expect(res.noteCode).toBe('skills-sh-board');
    expect(res.noteParams).toEqual({ n: '300' });
  });

  it('pages DEEPER than the first site page instead of stopping at row 200', async () => {
    // 450 rows = site pages 0..2. Console page 9 (offset 192..216) straddles site pages 0 and 1.
    const rows = Array.from({ length: 450 }, (_, i) => row('acme/skills', `s${i}`));
    const seen = stubBoard({ 'all-time': rows });

    const straddle = await browseSkillsSh('', 24, 9, 'all-time');
    if (!straddle.ok) throw new Error('expected an ok read');
    expect(straddle.items.map((i) => i.name)).toEqual(
      Array.from({ length: 24 }, (_, i) => `s${192 + i}`)
    );
    expect(seen.urls).toEqual(['/api/skills/all-time/0', '/api/skills/all-time/1']);

    // Page 19 starts at 432 — site page 2, i.e. the tail the old 600-row snapshot also carried.
    const tail = await browseSkillsSh('', 24, 19, 'all-time');
    if (!tail.ok) throw new Error('expected an ok read');
    expect(tail.items.map((i) => i.name)).toEqual(Array.from({ length: 18 }, (_, i) => `s${432 + i}`));
    expect(tail.hasMore).toBe(false);
  });

  it('serves a page that needs a second site page without re-asking for the first', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => row('acme/skills', `s${i}`));
    const seen = stubBoard({ 'all-time': rows });
    await browseSkillsSh('', 24, 9, 'all-time');
    const before = seen.urls.length;
    await browseSkillsSh('', 24, 9, 'all-time');
    // The straddling read cached both site pages, so a repeat costs nothing upstream.
    expect(seen.urls.length).toBe(before);
  });

  it('re-asks the site when the operator refreshes, even inside the board window', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row('acme/skills', `s${i}`));
    const seen = stubBoard({ 'all-time': rows });
    await browseSkillsSh('', 24, 1, 'all-time');
    const before = seen.urls.length;
    const refreshed = await browseSource(sourceView(), '', 24, { sort: 'all-time', refresh: true });
    if (!refreshed.ok) throw new Error('expected an ok read');
    // Board pages live 10 minutes instead of the shared 60 s, so the refresh button is the ONLY way to
    // see a new ranking inside that window — it must still reach the site.
    expect(seen.urls.length).toBe(before + 1);
    expect(seen.urls.at(-1)).toBe('/api/skills/all-time/0');
  });

  it('searches the WHOLE catalog for a real query instead of the board', async () => {
    const seen = stubBoard({ 'all-time': [row('board/skills', 'not-this-one')] }, [
      { id: 'anthropics/skills/pdf', source: 'anthropics/skills', skillId: 'pdf', name: 'pdf', installs: 216618 },
      { id: 'openai/skills/pdf', source: 'openai/skills', skillId: 'pdf', name: 'pdf', installs: 13390 },
    ]);
    const res = await browseSkillsSh('  pdf  ', 24, 1, 'all-time');
    if (!res.ok) throw new Error('expected an ok read');
    expect(seen.urls).toEqual(['/api/search']);
    expect(seen.queries).toEqual(['pdf']);
    expect(res.items.map((i) => i.key)).toEqual(['github:anthropics/skills#pdf', 'github:openai/skills#pdf']);
    expect(res.noteCode).toBe('skills-sh-search');
    expect(res.noteParams).toEqual({ n: '200' });
    // A capped search answer IS a window: the pager keeps the count, the summary hides.
    expect(res.total).toBe(2);
    expect(res.totalScope).toBe('window');
  });

  it('keeps the endpoint’s relevance order and pages over its capped answer', async () => {
    stubBoard({}, Array.from({ length: 5 }, (_, i) => row('acme/skills', `s${i + 1}`)));
    const first = await browseSkillsSh('acme', 2, 1, 'hot');
    if (!first.ok) throw new Error('expected an ok read');
    expect(first.items.map((i) => i.name)).toEqual(['s1', 's2']);
    expect(first.hasMore).toBe(true);

    const second = await browseSkillsSh('acme', 2, 2, 'hot');
    if (!second.ok) throw new Error('expected an ok read');
    expect(second.items.map((i) => i.name)).toEqual(['s3', 's4']);

    const last = await browseSkillsSh('acme', 2, 3, 'hot');
    if (!last.ok) throw new Error('expected an ok read');
    expect(last.items.map((i) => i.name)).toEqual(['s5']);
    expect(last.hasMore).toBe(false);
  });

  it('serves the registered source through browseSource', async () => {
    stubBoard({ 'all-time': [row('acme/skills', 'via-registry')] });
    const res = await browseSource(sourceView(), '', 24, { sort: 'all-time' });
    if (!res.ok) throw new Error('expected an ok read');
    expect(res.items[0]?.key).toBe('github:acme/skills#via-registry');
  });

  it('never browses a disabled source', async () => {
    const res = await browseSource(sourceView({ enabled: false, unavailableReason: 'off' }), '', 24);
    expect(res).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('skills.sh search reads', () => {
  const json = (body: unknown, status = 200) =>
    (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('asks for the endpoint’s own maximum window and encodes the term', async () => {
    let asked = '';
    const impl = (async (input: RequestInfo | URL) => {
      asked = String(input);
      return new Response(JSON.stringify({ skills: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await searchSkillsSh(' pdf tools ', impl);
    expect(asked).toContain('q=pdf%20tools');
    expect(asked).toContain('limit=200');
  });

  it('drops rows that are not installable GitHub identities', async () => {
    const read = await searchSkillsSh(
      'lark',
      json({ skills: [{ source: 'open.feishu.cn', skillId: 'lark-doc' }, { source: 'acme/skills', skillId: 'kept' }] })
    );
    if (!read.ok) throw new Error('expected an ok read');
    expect(read.slots.map((s) => s?.skillId ?? null)).toEqual([null, 'kept']);
  });

  it('answers an empty result as an empty list, not a failure', async () => {
    const read = await searchSkillsSh('zzzz', json({ skills: [] }));
    expect(read).toMatchObject({ ok: true, slots: [], rows: 0 });
  });

  it('maps a throttled upstream to `unavailable` and a client error to `upstream/http`', async () => {
    const four = await searchSkillsSh('pdf', json({ error: 'Query must be at least 2 characters' }, 400));
    expect(four).toMatchObject({ ok: false, code: 'upstream', reason: 'http', reasonParams: { status: '400' } });
    const five = await searchSkillsSh('pdf', json('boom', 503));
    expect(five).toMatchObject({ ok: false, code: 'unavailable' });
    const many = await searchSkillsSh('pdf', json('slow down', 429));
    expect(many).toMatchObject({ ok: false, code: 'unavailable' });
  }, 30_000);

  it('answers `badPayload` for unparsable JSON and `markupChanged` for a missing array', async () => {
    const broken = await searchSkillsSh('pdf', json('<html>not json</html>'));
    expect(broken).toMatchObject({ ok: false, code: 'upstream', reason: 'badPayload' });
    const shape = await searchSkillsSh('pdf', json({ results: [] }));
    expect(shape).toMatchObject({ ok: false, code: 'upstream', reason: 'markupChanged' });
  });
});
