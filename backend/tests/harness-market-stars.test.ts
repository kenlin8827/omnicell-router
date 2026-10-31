import { beforeEach, describe, expect, it } from 'bun:test';
import { chunkRepos, fetchRepoStars, normalizeRepos, peekStarCache, resetStarCache } from '../src/harness/common/stars.js';

/**
 * On-demand star resolution. The contract under test is narrow: the repository list is validated and
 * bounded, the queries respect GitHub's `q` budget, a page's repositories are resolved by FEWER
 * requests than there are rows (the whole point of batching), an answer is cached so a second click
 * spends nothing, and a repository GitHub does not index comes back in `missing` instead of a 0.
 */

function fakeFetch(handler: (url: string) => { status?: number; body?: unknown }) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const { status = 200, body = {} } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Repositories named by one search URL's `q` parameter. */
function queried(url: string): string[] {
  const q = new URL(url).searchParams.get('q') ?? '';
  return [...q.matchAll(/repo:([\w.-]+\/[\w.-]+)/g)].map((m) => m[1]!);
}

beforeEach(() => {
  resetStarCache();
});

describe('normalizeRepos', () => {
  it('lowercases, dedupes, strips .git and drops anything that is not owner/repo', () => {
    expect(
      normalizeRepos(['Anomalyco/OpenCode', 'anomalyco/opencode', 'foo/bar.git', 'not a repo', 'a/b/c', ''])
    ).toEqual(['anomalyco/opencode', 'foo/bar']);
  });

  it('bounds the batch so one click cannot become an unbounded crawl', () => {
    const many = Array.from({ length: 400 }, (_, i) => `o${i}/r${i}`);
    expect(normalizeRepos(many).length).toBe(100);
  });
});

describe('chunkRepos', () => {
  it('keeps every query inside the character budget', () => {
    const repos = Array.from({ length: 30 }, (_, i) => `owner-${i}/repository-name-${i}`);
    const chunks = chunkRepos(repos, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const q = chunk.map((r) => `repo:${r}`).join(' ');
      expect(q.length).toBeLessThanOrEqual(120);
    }
    expect(chunks.flat()).toEqual(repos);
  });

  it('answers one chunk for a page that fits', () => {
    expect(chunkRepos(['a/b', 'c/d'], 230)).toEqual([['a/b', 'c/d']]);
  });
});

describe('fetchRepoStars', () => {
  it('resolves a page of repositories with ONE batched search and names the ones GitHub skipped', async () => {
    const { impl, calls } = fakeFetch((url) => {
      const asked = queried(url);
      return {
        body: {
          items: asked
            .filter((r) => r !== 'gone/repo')
            .map((r) => ({ full_name: r, stargazers_count: r === 'a/b' ? 42 : 7 })),
        },
      };
    });

    const read = await fetchRepoStars(['a/b', 'gone/repo', 'c/d'], impl);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(calls.length).toBe(1);
    expect(read.stars).toEqual({ 'a/b': 42, 'c/d': 7 });
    expect(read.missing).toEqual(['gone/repo']);
    expect(read.cached).toBe(0);
  });

  it('serves a repeated read from the cache without another request', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { items: [{ full_name: 'a/b', stargazers_count: 42 }] } }));

    await fetchRepoStars(['a/b'], impl);
    const again = await fetchRepoStars(['a/b'], impl);
    expect(calls.length).toBe(1);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.stars).toEqual({ 'a/b': 42 });
    expect(again.cached).toBe(1);
    expect(again.missing).toEqual([]);
  });

  it('splits an oversized batch across queries instead of one impossible `q`', async () => {
    const repos = Array.from({ length: 40 }, (_, i) => `owner${i}/project${i}`);
    const { impl, calls } = fakeFetch((url) => ({
      body: { items: queried(url).map((r) => ({ full_name: r, stargazers_count: 1 })) },
    }));

    const read = await fetchRepoStars(repos, impl);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(calls.length).toBeGreaterThan(1);
    expect(Object.keys(read.stars).length).toBe(40);
    for (const url of calls) {
      expect((new URL(url).searchParams.get('q') ?? '').length).toBeLessThanOrEqual(230);
    }
  });

  it('treats a 422 (nothing in the query is searchable) as "unknown", not as an error', async () => {
    // Measured 2026-10-25: a `repo:` query whose repositories are all deleted/renamed answers
    // 422 "Validation Failed", not an empty result set. Failing the page over that would be wrong —
    // those rows simply keep "unknown".
    const { impl } = fakeFetch(() => ({ status: 422, body: { message: 'Validation Failed' } }));
    const read = await fetchRepoStars(['gone/a', 'gone/b'], impl);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.stars).toEqual({});
    expect(read.missing).toEqual(['gone/a', 'gone/b']);
  }, 30_000);

  it('remembers a miss, so a click on a page holding a dead repo does not re-spend a request', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { items: [] } }));
    await fetchRepoStars(['gone/a'], impl);
    const again = await fetchRepoStars(['gone/a'], impl);
    expect(calls.length).toBe(1);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.missing).toEqual(['gone/a']);
    expect(again.cached).toBe(1);
  });

  it('answers rateLimited instead of an empty star map', async () => {
    const { impl } = fakeFetch(() => ({ status: 403, body: { message: 'API rate limit exceeded' } }));
    const read = await fetchRepoStars(['a/b'], impl);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('unavailable');
    expect(read.reason).toBe('rateLimited');
  }, 30_000);

  it('answers badPayload for a non-JSON answer', async () => {
    const impl = (async () =>
      new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch;
    const read = await fetchRepoStars(['a/b'], impl);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('badPayload');
  });
});

describe('peekStarCache', () => {
  it('answers nothing for repositories the cache has never seen — and never calls out', () => {
    // No fetch implementation is even reachable from `peekStarCache`: the whole point is that a
    // render-time question can never become an upstream request.
    const peek = peekStarCache(['a/b', 'c/d']);
    expect(peek.stars).toEqual({});
    expect(peek.missing).toEqual(['a/b', 'c/d']);
    expect(peek.cached).toBe(0);
  });

  it('shows what a resolved read already cached, and names the rest', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { items: [{ full_name: 'a/b', stargazers_count: 42 }] } }));
    await fetchRepoStars(['a/b'], impl);
    const before = calls.length;

    const peek = peekStarCache(['a/b', 'never/asked']);
    expect(peek.stars).toEqual({ 'a/b': 42 });
    expect(peek.missing).toEqual(['never/asked']);
    expect(peek.cached).toBe(1);
    expect(calls.length).toBe(before);
  });

  it('does not repeat a remembered miss as a value', async () => {
    const { impl } = fakeFetch(() => ({ body: { items: [] } }));
    await fetchRepoStars(['gone/a'], impl);

    const peek = peekStarCache(['gone/a']);
    expect(peek.stars).toEqual({});
    expect(peek.missing).toEqual(['gone/a']);
  });
});
