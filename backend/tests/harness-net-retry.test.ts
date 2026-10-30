import { afterEach, describe, expect, it } from 'bun:test';
import { browseGitHub, resetBrowseCache } from '../src/harness/market/browse.js';
import { fetchFailureReason, fetchWithRetry, MARKET_RETRY, type RetryPolicy } from '../src/harness/net.js';

/**
 * The shared market retry policy (ADR-0015 §8).
 *
 * What is pinned here is the DECISION TABLE, not a duration: EVERY failed answer — a thrown reset,
 * a 5xx, a 429, any other 4xx — is asked again while attempts and budget last; the only early
 * return is a `Retry-After` the remaining budget cannot fit. The budget is also pinned, because
 * "5 attempts" without a total deadline is what turns a dead upstream into a 45-second spinner.
 */

/** A policy with the production SHAPE but instant sleeps, so a test never waits for a backoff. */
const FAST: RetryPolicy = { ...MARKET_RETRY };

interface Call {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = { url, ...(init ? { init } : {}) };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

afterEach(() => resetBrowseCache());

describe('fetchWithRetry — transient failures are retried', () => {
  it('asks again after a thrown reset and returns the successful attempt', async () => {
    let attempt = 0;
    const { impl, calls } = stubFetch(() => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('fetch failed');
      return new Response('{"ok":true}', { status: 200 });
    });

    const res = await fetchWithRetry('https://example.test/a', {}, FAST, { fetchImpl: impl, sleep: noSleep });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('retries a 5xx and answers with the last one once the attempt ceiling is spent', async () => {
    const { impl, calls } = stubFetch(() => new Response('boom', { status: 503 }));

    const res = await fetchWithRetry('https://example.test/a', {}, FAST, { fetchImpl: impl, sleep: noSleep });

    // The last answer is RETURNED, never thrown: the caller still maps the status to its own reason.
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(FAST.attempts);
  });

  it('retries 408 and 425 — the two non-5xx "ask again" statuses', async () => {
    for (const status of [408, 425]) {
      resetBrowseCache();
      let attempt = 0;
      const { impl, calls } = stubFetch(() => {
        attempt += 1;
        return new Response('', { status: attempt === 1 ? status : 200 });
      });
      const res = await fetchWithRetry('https://example.test/a', {}, FAST, { fetchImpl: impl, sleep: noSleep });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
    }
  });

  it('backs off 400 ms, then doubling (±20 % jitter)', async () => {
    const slept: number[] = [];
    const { impl } = stubFetch(() => new Response('boom', { status: 502 }));

    await fetchWithRetry('https://example.test/a', {}, FAST, {
      fetchImpl: impl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toHaveLength(FAST.attempts - 1);
    expect(slept[0]!).toBeGreaterThanOrEqual(320);
    expect(slept[0]!).toBeLessThanOrEqual(480);
    expect(slept[1]!).toBeGreaterThanOrEqual(640);
    expect(slept[1]!).toBeLessThanOrEqual(960);
    expect(slept[2]!).toBeGreaterThanOrEqual(1_280);
    expect(slept[2]!).toBeLessThanOrEqual(1_920);
    expect(slept[3]!).toBeGreaterThanOrEqual(2_560);
    expect(slept[3]!).toBeLessThanOrEqual(3_840);
  });
});

describe('fetchWithRetry — every status earns another ask', () => {
  it('retries a 429 and hands back the last answer once the ceiling is spent', async () => {
    const { impl, calls } = stubFetch(() => new Response('slow down', { status: 429 }));
    const res = await fetchWithRetry('https://example.test/a', {}, FAST, { fetchImpl: impl, sleep: noSleep });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(FAST.attempts);
  });

  it('retries 403, 404 and 422 — a transient 4xx earns the same second ask', async () => {
    for (const status of [403, 404, 422]) {
      let attempt = 0;
      const { impl, calls } = stubFetch(() => {
        attempt += 1;
        return new Response('', { status: attempt === 1 ? status : 200 });
      });
      const res = await fetchWithRetry('https://example.test/a', {}, FAST, { fetchImpl: impl, sleep: noSleep });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
    }
  });

  it('floors the backoff at a Retry-After that fits the budget', async () => {
    let attempt = 0;
    const slept: number[] = [];
    const { impl, calls } = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } })
        : new Response('', { status: 200 });
    });
    const res = await fetchWithRetry('https://example.test/a', {}, FAST, {
      fetchImpl: impl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    // The plain backoff would be ~400 ms; the server's ask floors the sleep at 1 000.
    expect(slept).toEqual([1_000]);
  });
});

describe('fetchWithRetry — the only early returns left', () => {
  it('does not retry a Retry-After the remaining budget cannot fit', async () => {
    const { impl, calls } = stubFetch(
      () => new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } })
    );
    const res = await fetchWithRetry('https://example.test/a', {}, FAST, { fetchImpl: impl, sleep: noSleep });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it('does not repeat an attempt that already consumed the budget', async () => {
    // A hanging connection is what `AbortSignal.timeout` cuts off in production; here the attempt is
    // slow by itself, which is the same arithmetic: 350 ms of a 1 200 ms budget leaves no room for a
    // retry (one needs its own deadline plus the backoff), so the caller hears about it at once.
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 350));
      const err = new Error('fetch failed');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as typeof fetch;

    const started = Date.now();
    let thrown: unknown;
    try {
      await fetchWithRetry('https://example.test/a', {}, { ...FAST, attempts: 5, budgetMs: 1_200, timeoutMs: 4_000 }, {
        fetchImpl: impl,
      });
    } catch (e) {
      thrown = e;
    }

    expect(fetchFailureReason(thrown)).toBe('timeout');
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('browse readers use the shared policy', () => {
  it('browseGitHub recovers from one 503 without surfacing an error', async () => {
    const original = globalThis.fetch;
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      if (attempt === 1) return new Response('boom', { status: 503 });
      return new Response(
        JSON.stringify({
          items: [
            {
              full_name: 'acme/skill',
              name: 'skill',
              description: 'd',
              html_url: 'https://github.com/acme/skill',
              stargazers_count: 3,
              pushed_at: '2026-10-25T00:00:00Z',
            },
          ],
          total_count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const result = await browseGitHub('retry-probe-unique-query', 5, 1, 'stars');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items[0]?.repo).toBe('acme/skill');
      expect(attempt).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});
