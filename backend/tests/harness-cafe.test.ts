import { afterAll, describe, expect, it } from 'bun:test';
import { fetchCafeExtensions } from '../src/harness/opencode-cafe.js';
import { sanitizePackageName } from '../src/harness/catalog-npm.js';
import { opencodeCafeAdapter } from '../src/harness/sources/opencode-cafe.js';
import { browseOpencodeCafe, resetBrowseCache } from '../src/harness/browse.js';

/**
 * opencode.cafe is a Convex-backed catalog whose PUBLIC query also returns `author.email`. Two things
 * therefore have to hold: only `type: 'plugin'` rows are extensions, and no row may carry personal
 * contact data any further than this module.
 */

const CAFE_ROWS = [
  {
    _id: 'abc',
    productId: 'plugin-a',
    type: 'plugin',
    displayName: 'Plugin A',
    description: 'A plugin.',
    repoUrl: 'https://github.com/acme/plugin-a',
    installation: '```json\n{ "plugin": ["plugin-a@1.2.3"] }\n```',
    tags: ['memory'],
    author: { userId: 'user_1', name: 'Alice', email: 'alice@example.com' },
  },
  {
    _id: 'def',
    productId: 'theme-b',
    type: 'theme',
    displayName: 'Theme B',
    description: 'A theme.',
    repoUrl: 'https://github.com/acme/theme-b',
    installation: 'Add the JSON to your theme file.',
    tags: [],
    author: { userId: 'user_2', name: 'Bob', email: 'bob@example.com' },
  },
  {
    _id: 'ghi',
    productId: 'plugin-c',
    type: 'plugin',
    displayName: 'Plugin C',
    description: 'A plugin installed from a local path.',
    repoUrl: 'https://github.com/acme/opencode-c',
    installation: '```json\n{ "plugin": ["./plugin/local/entry.js"] }\n```',
    tags: [],
    author: { userId: 'user_3', name: 'Carol', email: 'carol@example.com' },
  },
];

const NPM: Record<string, { version: string; repository: string }> = {
  'plugin-a': { version: '1.2.3', repository: 'git+https://github.com/acme/plugin-a.git' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Convex query + npm registry stand-in. */
function stubFetch(seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('convex.cloud/api/query')) return json({ status: 'success', value: CAFE_ROWS });
    const m = /^https:\/\/registry\.npmjs\.org\/(.+)$/.exec(url);
    if (!m) return json({}, 404);
    const path = decodeURIComponent(m[1]!);
    const lastSlash = path.lastIndexOf('/');
    const head = path.slice(0, lastSlash);
    const tail = path.slice(lastSlash + 1);
    if (tail === 'latest' && NPM[head]) {
      return json({ name: head, version: NPM[head]!.version, repository: NPM[head]!.repository });
    }
    if (NPM[path]) return json({ name: path, 'dist-tags': { latest: NPM[path]!.version } });
    for (const [name, pkg] of Object.entries(NPM)) {
      if (path === `${name}/${pkg.version}`) {
        return json({ name, version: pkg.version, dist: { integrity: 'sha512-stub' } });
      }
    }
    return json({ error: 'Not found' }, 404);
  }) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('fetchCafeExtensions', () => {
  it('narrows rows and drops author contact data entirely', async () => {
    globalThis.fetch = stubFetch();
    const result = await fetchCafeExtensions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.length).toBe(3);
    for (const entry of result.entries) {
      // Neither the type nor the tests can see it: `author` is simply not part of the shape.
      expect(Object.keys(entry)).not.toContain('author');
      expect(JSON.stringify(entry)).not.toContain('@example.com');
    }
    expect(result.entries[0]?.installation).toContain('plugin-a');
  });

  it('reports an upstream failure instead of an empty catalog', async () => {
    globalThis.fetch = (async () => json({ status: 'error', errorMessage: 'boom' })) as unknown as typeof fetch;
    const result = await fetchCafeExtensions();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('upstream');
  });

  it('reports a non-200 answer as unavailable when the service is down', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const result = await fetchCafeExtensions();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
  }, 30_000);
});

describe('browseOpencodeCafe catalog composition', () => {
  // The site counts every catalog entry as an "extension"; this market can only install `plugin`
  // rows. Answering 40 of 54 without a word reads as data loss, so the count travels as copy.
  it('says how many catalog entries are plugins, and drops the note once a query is typed', async () => {
    resetBrowseCache();
    globalThis.fetch = stubFetch();

    const catalog = await browseOpencodeCafe('', 24);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    // 2 of the 3 stubbed rows are plugins; the theme is a different artifact kind.
    expect(catalog.items.length).toBe(2);
    expect(catalog.noteCode).toBe('cafe-filtered');
    expect(catalog.noteParams).toEqual({ total: '3', plugins: '2' });

    const searched = await browseOpencodeCafe('plugin-a', 24);
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    // A typed query is a search over the installable rows — the catalog's own tally is not a claim
    // about those results.
    expect(searched.noteCode).toBeUndefined();
    expect(searched.note).toBeUndefined();
  });
});

describe('sanitizePackageName', () => {
  it('strips a version or dist-tag without eating the scope', () => {
    expect(sanitizePackageName('opencode-pty@0.4.0')).toBe('opencode-pty');
    expect(sanitizePackageName('@tarquinen/opencode-dcp@latest')).toBe('@tarquinen/opencode-dcp');
    expect(sanitizePackageName('@scope/name')).toBe('@scope/name');
  });

  it('rejects tokens that are not package references', () => {
    expect(sanitizePackageName('./plugin/speckit-chain/speckit-chain.js')).toBeNull();
    expect(sanitizePackageName('...other plugins')).toBeNull();
    expect(sanitizePackageName('&&')).toBeNull();
    expect(sanitizePackageName('-g')).toBeNull();
    expect(sanitizePackageName('')).toBeNull();
  });
});

describe('opencodeCafeAdapter.resolve', () => {
  it('installs a declared package and answers the npm identity', async () => {
    const result = await opencodeCafeAdapter.resolve('plugin-a', 'extension', { fetchImpl: stubFetch() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonicalKey).toBe('npm:plugin-a');
    if (result.payload.kind !== 'extension') return;
    // The version in the install snippet is stripped: the npm adapter pins a concrete one itself.
    expect(result.payload.spec).toBe('plugin-a@1.2.3');
  });

  it('refuses a row that is not a plugin, even when it exists in the catalog', async () => {
    const result = await opencodeCafeAdapter.resolve('theme-b', 'extension', { fetchImpl: stubFetch() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_artifact');
    expect(result.message).toContain('not a plugin');
  });

  it('answers no_artifact when the install snippet names nothing installable', async () => {
    const result = await opencodeCafeAdapter.resolve('plugin-c', 'extension', { fetchImpl: stubFetch() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_artifact');
    expect(result.message).toContain('github.com/acme/opencode-c');
  });
});
