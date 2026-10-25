import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fastify from 'fastify';
import {
  clawhubFromKey,
  packageFromKey,
  readMarketDetail,
  resetDetailCache,
  safePackageName,
  safeRepoSlug,
} from '../src/harness/detail.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * Market-row detail (ADR-0015 §D6). Two things are under test beyond the happy path:
 *  - the URL is BUILT from a validated identity (`npm:<name>` / `owner/repo`), never taken from the
 *    caller — the endpoint must not be usable as an arbitrary-URL proxy;
 *  - a row with nothing readable still answers, because the console's dialog is built on the row it
 *    already holds.
 */

type Call = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/** A fetch stub that records calls and answers by URL substring. */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => resetDetailCache());
afterEach(() => resetDetailCache());

describe('identity validation', () => {
  it('accepts plain and scoped package names, and reads them out of an npm key', () => {
    expect(safePackageName('opencode-pty')).toBe('opencode-pty');
    expect(safePackageName('@scope/pkg')).toBe('@scope/pkg');
    expect(packageFromKey('npm:@scope/pkg')).toBe('@scope/pkg');
  });

  it('refuses anything that could steer the URL', () => {
    for (const bad of ['../etc/passwd', 'a/b/c', '@scope', 'pkg?x=1', 'pkg#x', 'http://evil.test/x', '.', '..', '']) {
      expect(safePackageName(bad)).toBeNull();
    }
    // A key of another source names no package.
    expect(packageFromKey('github:owner/repo')).toBeNull();
    expect(packageFromKey(undefined)).toBeNull();
  });

  it('accepts an owner/repo slug and refuses a URL or a traversal', () => {
    expect(safeRepoSlug('owner/repo')).toBe('owner/repo');
    for (const bad of ['https://github.com/owner/repo', '../x', 'owner/', '/repo', 'a/b/c']) {
      expect(safeRepoSlug(bad)).toBeNull();
    }
  });

  it('reads a clawhub key as the owner/slug pair and refuses anything else', () => {
    expect(clawhubFromKey('clawhub:owner/skill')).toEqual({ owner: 'owner', slug: 'skill' });
    for (const bad of ['npm:pkg', 'clawhub:owner', 'clawhub:owner/a/b', 'clawhub:../x', 'clawhub:']) {
      expect(clawhubFromKey(bad)).toBeNull();
    }
  });
});

describe('readMarketDetail', () => {  it('reads the npm document and never touches GitHub when it carries a README', async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({
        name: 'opencode-pty',
        description: 'pty plugin',
        homepage: 'https://example.test',
        license: 'MIT',
        keywords: ['opencode-plugin'],
        readme: '# Title\r\n\r\nbody',
        repository: { url: 'git+https://github.com/owner/repo.git' },
        'dist-tags': { latest: '1.2.3' },
        time: { modified: '2026-01-02T03:04:05Z', '1.2.3': '2026-01-01T00:00:00Z' },
      })
    );

    const detail = await readMarketDetail({ key: 'npm:opencode-pty' }, impl);

    expect(detail.readFrom).toBe('npm');
    expect(detail.readme).toBe('# Title\n\nbody');
    expect(detail.latestVersion).toBe('1.2.3');
    expect(detail.license).toBe('MIT');
    expect(detail.publishedAt).toBe('2026-01-01T00:00:00Z');
    expect(detail.repo).toBe('owner/repo');
    expect(calls.map((c) => c.url)).toEqual(['https://registry.npmjs.org/opencode-pty']);
  });

  it('falls back to the repository README when the registry document has no body', async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.startsWith('https://registry.npmjs.org/')) {
        return jsonResponse({
          name: 'pkg',
          repository: { url: 'https://github.com/owner/repo' },
          'dist-tags': { latest: '1.0.0' },
        });
      }
      if (url.endsWith('/readme')) return textResponse('## From GitHub');
      return jsonResponse({ stargazers_count: 42, language: 'TypeScript', topics: ['plugin'] });
    });

    const detail = await readMarketDetail({ key: 'npm:pkg' }, impl);

    expect(detail.readme).toBe('## From GitHub');
    expect(detail.readFrom).toBe('github');
    expect(detail.stars).toBe(42);
    expect(detail.language).toBe('TypeScript');
    expect(calls.some((c) => c.url === 'https://api.github.com/repos/owner/repo/readme')).toBe(true);
  });

  it('reads a GitHub-only row (no package key) from its repo slug', async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.endsWith('/readme')) return textResponse('# Repo README');
      return jsonResponse({ description: 'a plugin', stargazers_count: 7 });
    });

    const detail = await readMarketDetail({ repo: 'owner/repo' }, impl);

    expect(detail.readFrom).toBe('github');
    expect(detail.readme).toBe('# Repo README');
    expect(detail.stars).toBe(7);
    expect(calls.length).toBe(2);
  });

  it('answers readFrom "none" without any request when the row declares no identity', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({}));
    const detail = await readMarketDetail({}, impl);
    expect(detail.readFrom).toBe('none');
    expect(detail.readme).toBeNull();
    expect(calls).toEqual([]);
  });

  it('reports a translatable reason instead of throwing when the registry refuses', async () => {
    const { impl } = stubFetch(() => jsonResponse({ error: 'Not found' }, 404));
    const detail = await readMarketDetail({ key: 'npm:missing-pkg' }, impl);
    expect(detail.readme).toBeNull();
    expect(detail.reason).toBe('http');
    expect(detail.reasonParams).toEqual({ status: '404' });
    expect(detail.message).toContain('missing-pkg');
  }, 30_000);

  it('caches the answer for the same identity', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ readme: 'body', 'dist-tags': { latest: '1.0.0' } }));
    await readMarketDetail({ key: 'npm:pkg' }, impl);
    await readMarketDetail({ key: 'npm:pkg' }, impl);
    expect(calls.length).toBe(1);
  });

  it('does not cache a failed read — the next click retries', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return jsonResponse({ error: 'upstream down' }, 500);
    }) as unknown as typeof fetch;
    await readMarketDetail({ key: 'npm:pkg' }, impl);
    await readMarketDetail({ key: 'npm:pkg' }, impl);
    // A 5xx earns another ask under the shared policy, so ONE click now spends the whole attempt
    // budget (5 requests, ADR-0015 §8) and the failure is still not cached — the next click is a
    // fresh round, not a pinned error.
    expect(calls).toBe(10);
  }, 30_000);
});

/**
 * ClawHub rows carry neither an npm name nor a repository, so their long-form half comes from the
 * registry's OWN per-skill record. These cases pin that path: the identity is the row's owner/slug
 * (never its `url`), the published SKILL.md loses its YAML frontmatter before rendering, and the
 * registry's star/download/install tally travels in `registryStats` — never in `stars`, which means
 * a GitHub count.
 */
describe('readMarketDetail — ClawHub', () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    skill: {
      slug: 'skill',
      displayName: 'Skill',
      summary: 'one-line summary',
      description: '---\nname: skill\ndescription: "x"\n---\n\n# Title\n\nbody\n',
      topics: ['OCR', 'CSV'],
      tags: { latest: '1.3.3' },
      updatedAt: 1_790_000_000_000,
      stats: { comments: 0, downloads: 1085, installs: 25, stars: 1, versions: 15 },
      ...overrides,
    },
    latestVersion: { version: '1.3.3', createdAt: 1_789_000_000_000, license: 'MIT-0' },
    owner: { handle: 'owner' },
  });

  it('reads the registry record, strips the frontmatter and keeps the counters separate', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(record()));
    const detail = await readMarketDetail({ key: 'clawhub:owner/skill' }, impl);

    expect(detail.readFrom).toBe('clawhub');
    expect(detail.readme).toBe('# Title\n\nbody');
    expect(detail.latestVersion).toBe('1.3.3');
    expect(detail.license).toBe('MIT-0');
    expect(detail.publishedAt).toBe(new Date(1_789_000_000_000).toISOString());
    expect(detail.updatedAt).toBe(new Date(1_790_000_000_000).toISOString());
    expect(detail.registryStats).toEqual({ stars: 1, downloads: 1085, installs: 25 });
    expect(detail.stars).toBeUndefined();
    // ONE read, to the registry, with the row's own identity — never its `url`.
    expect(calls.map((c) => c.url)).toEqual(['https://clawhub.ai/api/v1/skills/skill?ownerHandle=owner']);
  });

  it('caches the answer for the same skill and not for another owner', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(record()));
    await readMarketDetail({ key: 'clawhub:owner/skill' }, impl);
    await readMarketDetail({ key: 'clawhub:owner/skill' }, impl);
    expect(calls.length).toBe(1);
    await readMarketDetail({ key: 'clawhub:other/skill' }, impl);
    expect(calls.length).toBe(2);
  });

  it('reports a translatable reason when the registry has no such skill', async () => {
    const { impl } = stubFetch(() => textResponse('Skill not found', 404));
    const detail = await readMarketDetail({ key: 'clawhub:owner/missing' }, impl);
    expect(detail.readFrom).toBe('none');
    expect(detail.readme).toBeNull();
    expect(detail.reason).toBe('http');
    expect(detail.reasonParams).toEqual({ status: '404' });
    expect(detail.message).toContain('owner/missing');
  }, 30_000);

  it('refuses a record the registry resolved to a different publisher', async () => {
    const { impl } = stubFetch(() => jsonResponse({ ...record(), owner: { handle: 'someoneelse' } }));
    const detail = await readMarketDetail({ key: 'clawhub:owner/skill' }, impl);
    expect(detail.readFrom).toBe('none');
    expect(detail.readme).toBeNull();
    expect(detail.message).toContain('someoneelse');
  });
});

describe('GET /api/admin/harness/detail', () => {
  it('answers the detail for a known source and echoes the source id', async () => {
    const { impl } = stubFetch(() => jsonResponse({ readme: 'hello', 'dist-tags': { latest: '2.0.0' } }));
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const app = fastify();
      registerHarnessRoutes(app);
      await app.ready();
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/harness/detail?source=npm&key=npm:some-pkg',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; source: string; detail: { readme: string; latestVersion: string } };
      expect(body.status).toBe('ok');
      expect(body.source).toBe('npm');
      expect(body.detail.readme).toBe('hello');
      expect(body.detail.latestVersion).toBe('2.0.0');
      await app.close();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses an unknown source instead of guessing one', async () => {
    const app = fastify();
    registerHarnessRoutes(app);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/admin/harness/detail?source=nope' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
