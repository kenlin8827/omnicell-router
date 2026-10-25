import { describe, expect, it } from 'bun:test';
import zlib from 'node:zlib';
import {
  CLAWHUB_MAX_FILES,
  downloadClawHubZip,
  fetchClawHubCatalogPage,
  fetchClawHubLatestVersion,
  fetchClawHubSearch,
  fetchClawHubSkill,
  readZip,
  stripFrontmatter,
  ZipTooLargeError,
  type ZipEntry,
} from '../src/harness/clawhub.js';
import { browseClawHub, browseSource, resetBrowseCache } from '../src/harness/browse.js';
import { clawhubAdapter } from '../src/harness/sources/clawhub.js';
import type { HarnessSourceView } from '../src/harness/types.js';

/**
 * ClawHub source, fixture-driven (no network): the registry answers JSON catalog/search/versions
 * reads and ZIP download bytes, so every test crafts its own bodies — the same house pattern as the
 * smithery and skills-sh reader tests. The ZIP builder writes the exact 32-bit layout `readZip`
 * parses (local headers, central directory, EOCD), stored and deflate entries both.
 */

function buildZip(entries: { path: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30 + name.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    payload.copy(local, 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function zipResponse(entries: { path: string; data: Buffer; deflate?: boolean }[]): Response {
  return new Response(buildZip(entries), { status: 200, headers: { 'content-type': 'application/zip' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Route = [RegExp, (url: string) => Response];

function fetchRouter(routes: Route[]): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [pattern, handler] of routes) if (pattern.test(url)) return Promise.resolve(handler(url));
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as typeof fetch;
}

const noSleep = async () => {};

const catalogRow = (slug: string) => ({
  ownerHandle: 'openclaw',
  slug,
  displayName: slug,
  summary: `summary of ${slug}`,
  topics: ['GitHub'],
  updatedAt: 1_700_000_000_000,
  stats: { comments: 2, downloads: 1085, installs: 25, stars: 1, versions: 15 },
});

function sourceView(): HarnessSourceView {
  return {
    id: 'clawhub',
    label: 'ClawHub',
    kinds: ['skill'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    sorts: ['downloads', 'stars', 'updated'],
  };
}

const SKILL_ZIP: { path: string; data: Buffer; deflate?: boolean }[] = [
  { path: 'SKILL.md', data: Buffer.from('---\nname: gitcrawl\n---\n# Gitcrawl\n') },
  { path: 'skill-card.md', data: Buffer.from('card', 'utf8'), deflate: true },
  { path: 'agents/openai.yaml', data: Buffer.from('model: x\n', 'utf8'), deflate: true },
];

describe('readZip', () => {
  it('reads stored and deflate entries and skips directory records', () => {
    const entries: ZipEntry[] = readZip(
      buildZip([...SKILL_ZIP, { path: 'references/', data: Buffer.alloc(0) }])
    );
    expect(entries.map((e) => e.path)).toEqual(['SKILL.md', 'skill-card.md', 'agents/openai.yaml']);
    expect(entries[0]!.data.toString('utf8')).toContain('# Gitcrawl');
    expect(entries[1]!.data.toString('utf8')).toBe('card');
    expect(entries[2]!.data.toString('utf8')).toBe('model: x\n');
  });

  it('refuses bytes with no end-of-central-directory record', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(/not a ZIP archive/);
  });

  it('bounds EXPANDED bytes, not just the compressed archive size', () => {
    // ~9 MiB of zeros deflates to a few KiB: the download itself passes the 8 MiB compressed cap, so
    // only an inflate limit keeps this from becoming the process's memory.
    const bomb = buildZip([{ path: 'SKILL.md', data: Buffer.alloc(9 * 1024 * 1024), deflate: true }]);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => readZip(bomb)).toThrow(ZipTooLargeError);
  });
});

describe('downloadClawHubZip', () => {
  it('answers the archive bytes for a pinned version', async () => {
    const fetchImpl = fetchRouter([
      [/\/api\/v1\/download\?/, () => zipResponse(SKILL_ZIP)],
    ]);
    const read = await downloadClawHubZip('gitcrawl', 'openclaw', '1.0.0', fetchImpl, noSleep);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.zip.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('maps 404 to no_artifact and a 409 slug clash to its owning handles', async () => {
    const missing = await downloadClawHubZip('gone', 'openclaw', '1.0.0', fetchRouter([
      [/\/api\/v1\/download\?/, () => new Response('Skill not found', { status: 404, headers: { 'content-type': 'text/plain' } })],
    ]), noSleep);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('no_artifact');

    const clash = await downloadClawHubZip('github', 'someone', '1.0.0', fetchRouter([
      [/\/api\/v1\/download\?/, () => jsonResponse({
        code: 'AMBIGUOUS_SKILL_SLUG',
        matches: [{ ownerHandle: 'a', slug: 'github' }, { ownerHandle: 'b', slug: 'github' }],
      }, 409)],
    ]), noSleep);
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.code).toBe('ambiguous');
    expect(clash.candidates).toEqual(['a/github', 'b/github']);
  });

  it('refuses a JSON handoff answer by name instead of guessing the descriptor', async () => {
    const read = await downloadClawHubZip('mirrored', 'openclaw', '1.0.0', fetchRouter([
      [/\/api\/v1\/download\?/, () => jsonResponse({ kind: 'public-github' })],
    ]), noSleep);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('upstream');
    expect(read.message).toContain('public-github handoff');
  });
});

describe('clawhubAdapter.resolve', () => {
  it('pins the registry version and hands the writer unarchived files', async () => {
    const fetchImpl = fetchRouter([
      [/\/api\/v1\/skills\/gitcrawl\/versions\?/, () => jsonResponse({ items: [{ version: '1.2.3', createdAt: 1 }] })],
      [/\/api\/v1\/download\?/, () => zipResponse(SKILL_ZIP)],
    ]);
    const resolved = await clawhubAdapter.resolve('openclaw/gitcrawl', 'skill', { fetchImpl });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.canonicalKey).toBe('clawhub:openclaw/gitcrawl');
    expect(resolved.name).toBe('gitcrawl');
    expect(resolved.pin).toEqual({ clawhub: { slug: 'openclaw/gitcrawl', version: '1.2.3' } });
    expect(resolved.storeKey).toBe('clawhub__openclaw__gitcrawl@1.2.3');
    expect(resolved.payload.kind).toBe('skill');
    if (resolved.payload.kind !== 'skill') return;
    expect(resolved.payload.files.map((f) => f.path)).toEqual(['SKILL.md', 'skill-card.md', 'agents/openai.yaml']);
  });

  it('refuses a non-skill kind and a malformed reference before any network work', async () => {
    const noFetch = fetchRouter([]);
    const kind = await clawhubAdapter.resolve('openclaw/gitcrawl', 'extension', { fetchImpl: noFetch });
    expect(kind.ok).toBe(false);
    if (!kind.ok) expect(kind.code).toBe('unsupported_kind');
    const ref = await clawhubAdapter.resolve('gitcrawl', 'skill', { fetchImpl: noFetch });
    expect(ref.ok).toBe(false);
    if (!ref.ok) expect(ref.code).toBe('no_artifact');
  });

  it('refuses an archive without a root SKILL.md', async () => {
    const fetchImpl = fetchRouter([
      [/\/api\/v1\/skills\/plain\/versions\?/, () => jsonResponse({ items: [{ version: '1.0.0' }] })],
      [/\/api\/v1\/download\?/, () => zipResponse([{ path: 'README.md', data: Buffer.from('no skill here') }])],
    ]);
    const resolved = await clawhubAdapter.resolve('openclaw/plain', 'skill', { fetchImpl });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('no_artifact');
  });

  it('enforces the file-count cap before anything reaches disk', async () => {
    const many = [
      { path: 'SKILL.md', data: Buffer.from('---\nname: big\n---\n') },
      ...Array.from({ length: CLAWHUB_MAX_FILES }, (_, i) => ({ path: `file-${i}.txt`, data: Buffer.from('x') })),
    ];
    const fetchImpl = fetchRouter([
      [/\/api\/v1\/skills\/big\/versions\?/, () => jsonResponse({ items: [{ version: '1.0.0' }] })],
      [/\/api\/v1\/download\?/, () => zipResponse(many)],
    ]);
    const resolved = await clawhubAdapter.resolve('openclaw/big', 'skill', { fetchImpl });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('too_large');
  });
});

describe('stripFrontmatter', () => {
  it('removes a leading YAML block and leaves a later rule alone', () => {
    expect(stripFrontmatter('---\nname: x\n---\n\n# Title\n')).toBe('# Title\n');
    expect(stripFrontmatter('---\r\nname: x\r\n---\r\n\r\n# Title')).toBe('# Title');
    // No frontmatter, and a rule that is NOT the opening line: both are content.
    expect(stripFrontmatter('# Title\n\n---\n\nbody')).toBe('# Title\n\n---\n\nbody');
    expect(stripFrontmatter('---\nunterminated')).toBe('---\nunterminated');
  });
});

describe('fetchClawHubSkill', () => {
  const record = () => ({
    skill: {
      slug: 'skill',
      displayName: 'Skill',
      summary: 'one line',
      description: '---\nname: skill\n---\n\n# Title\n',
      topics: ['CSV'],
      tags: { latest: '1.3.3' },
      updatedAt: 1_790_000_000_000,
      stats: { comments: 0, downloads: 1085, installs: 25, stars: 1, versions: 15 },
    },
    latestVersion: { version: '1.3.3', createdAt: 1_789_000_000_000, license: 'MIT-0' },
    owner: { handle: 'openclaw' },
  });

  it('normalizes the record and reads it by ownerHandle', async () => {
    const read = await fetchClawHubSkill(
      'skill',
      'openclaw',
      fetchRouter([[/\/api\/v1\/skills\/skill\?ownerHandle=openclaw/, () => jsonResponse(record())]])
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.detail.body).toBe('# Title');
    expect(read.detail.version).toBe('1.3.3');
    expect(read.detail.license).toBe('MIT-0');
    expect(read.detail.stats).toEqual({ stars: 1, downloads: 1085, installs: 25 });
    expect(read.detail.publishedAtMs).toBe(1_789_000_000_000);
  });

  it('maps a 404 to no_artifact and a publisher mismatch to a refusal', async () => {
    const missing = await fetchClawHubSkill('gone', 'openclaw', fetchRouter([]));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('no_artifact');
    expect(missing.message).toContain('openclaw/gone');

    const mismatched = await fetchClawHubSkill(
      'skill',
      'openclaw',
      fetchRouter([[/\/api\/v1\/skills\//, () => jsonResponse({ ...record(), owner: { handle: 'other' } })]])
    );
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.message).toContain('other');
  }, 30_000);
});

describe('fetchClawHubLatestVersion', () => {  it('reads the newest semver through the undocumented ownerHandle disambiguator', async () => {
    let seen = '';
    const fetchImpl = fetchRouter([
      [/\/api\/v1\/skills\/self-improving-agent\/versions\?/, (url) => {
        seen = url;
        return jsonResponse({ items: [{ version: '4.0.5' }] });
      }],
    ]);
    const read = await fetchClawHubLatestVersion('self-improving-agent', 'pskoett', fetchImpl);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.version).toBe('4.0.5');
    expect(seen).toContain('ownerHandle=pskoett');
  });

  it('answers null (not a failure) when the registry lists no version', async () => {
    const read = await fetchClawHubLatestVersion('empty', 'openclaw', fetchRouter([
      [/\/api\/v1\/skills\/empty\/versions\?/, () => jsonResponse({ items: [] })],
    ]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.version).toBeNull();
  });
});

describe('browseClawHub', () => {
  const realFetch = globalThis.fetch;

  it('pages the catalog through the cursor chain', async () => {
    globalThis.fetch = fetchRouter([
      [/\/api\/v1\/skills\?.*cursor=/, () => jsonResponse({ items: [catalogRow('second')], nextCursor: null })],
      [/\/api\/v1\/skills\?/, () => jsonResponse({ items: [catalogRow('first')], nextCursor: 'c1' })],
    ]);
    try {
      const page1 = await browseClawHub('', 24, 1, 'downloads');
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.items.map((i) => i.id)).toEqual(['clawhub:openclaw/first']);
      expect(page1.hasMore).toBe(true);
      // A row carries no repo and no GitHub star count — ClawHub's own tally rides in
      // `registryStats`, so the star COLUMN never claims a GitHub number it does not have.
      expect(page1.items[0]!.stars).toBeNull();
      expect(page1.items[0]!.repo).toBeUndefined();
      expect(page1.items[0]!.registryStats).toEqual({ stars: 1, downloads: 1085, installs: 25 });
      expect(page1.items[0]!.url).toBe('https://clawhub.ai/openclaw/skills/first');
      expect(page1.items[0]!.updatedAt).toBe('2023-11-14T22:13:20.000Z');
      expect(page1.noteCode).toBe('clawhub-catalog');

      const page2 = await browseClawHub('', 24, 2, 'downloads');
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.items.map((i) => i.id)).toEqual(['clawhub:openclaw/second']);
      expect(page2.hasMore).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      resetBrowseCache();
    }
  });

  it('answers a typed query from the search endpoint as a window', async () => {
    globalThis.fetch = fetchRouter([
      [/\/api\/v1\/search\?/, () => jsonResponse({
        results: [
          { ownerHandle: 'openclaw', slug: 'one', displayName: 'One', summary: 's', metrics: { updatedAt: 1_700_000_000_000 }, native: { skill: { topics: ['GitHub'] } } },
          { ownerHandle: 'openclaw', slug: 'two', displayName: 'Two', summary: 's', metrics: { updatedAt: 1_700_000_000_000 }, native: { skill: { topics: [] } } },
          { ownerHandle: 'openclaw', slug: 'three', displayName: 'Three', summary: 's', metrics: { updatedAt: 1_700_000_000_000 }, native: { skill: { topics: [] } } },
        ],
      })],
    ]);
    try {
      const page1 = await browseClawHub('git', 2, 1);
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.items.length).toBe(2);
      expect(page1.total).toBe(3);
      expect(page1.totalScope).toBe('window');
      expect(page1.hasMore).toBe(true);
      expect(page1.noteCode).toBe('clawhub-search');

      const page2 = await browseClawHub('git', 2, 2);
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.items.length).toBe(1);
      expect(page2.hasMore).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      resetBrowseCache();
    }
  });

  it('routes through browseSource with the declared sorts', async () => {
    globalThis.fetch = fetchRouter([
      [/\/api\/v1\/skills\?/, () => jsonResponse({ items: [catalogRow('first')], nextCursor: null })],
    ]);
    try {
      const result = await browseSource(sourceView(), '', 24, { page: 1, sort: 'downloads' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items[0]!.sourceId).toBe('clawhub');
      expect(result.items[0]!.installKind).toBe('skill');
    } finally {
      globalThis.fetch = realFetch;
      resetBrowseCache();
    }
  });
});

describe('fetchClawHubCatalogPage', () => {
  it('drops rows without an owner/slug identity and carries the cursor', async () => {
    const fetchImpl = fetchRouter([
      [/\/api\/v1\/skills\?/, () => jsonResponse({
        items: [
          catalogRow('good'),
          { slug: 'no-owner' },
          { ownerHandle: 'no-slug' },
        ],
        nextCursor: 'c2',
      })],
    ]);
    const read = await fetchClawHubCatalogPage('downloads', 50, null, fetchImpl);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.map((e) => e.slug)).toEqual(['good']);
    expect(read.next).toBe('c2');
  });
});

describe('fetchClawHubSearch', () => {
  it('normalizes the nested search row shape', async () => {
    const fetchImpl = fetchRouter([
      [/\/api\/v1\/search\?/, () => jsonResponse({
        results: [
          { ownerHandle: 'openclaw', slug: 'one', displayName: 'One', summary: 's', metrics: { updatedAt: 1_700_000_000_000 }, native: { skill: { topics: ['GitHub'] } } },
          { slug: 'broken' },
        ],
      })],
    ]);
    const read = await fetchClawHubSearch('git', fetchImpl);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.length).toBe(1);
    expect(read.entries[0]!.topics).toEqual(['GitHub']);
    expect(read.entries[0]!.updatedAtMs).toBe(1_700_000_000_000);
  });
});
