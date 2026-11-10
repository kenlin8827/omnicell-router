import { beforeEach, describe, expect, it } from 'bun:test';
import {
  browseDshPluginNet,
  decodeCatalogLiteral,
  DSH_PLUGIN_NET_VIEW,
} from '../src/harness/plugin/adapters/dsh-plugin-net.js';
import { browseSkillsSh, SKILLS_SH_VIEW } from '../src/harness/skill/skills-sh.js';
import { SOURCES } from '../src/harness/common/source-views.js';
import { browseSource, resetBrowseCache } from '../src/harness/common/market.js';
import { getDefaultViewsForHarness } from '../src/harness/plugin/builtin.js';

beforeEach(() => {
  resetBrowseCache();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const DSH_SNAPSHOT = {
  snapshotDate: '2026-11-09',
  plugins: [
    {
      slug: 'modlens',
      name: 'Modlens',
      repository: 'liustack/modlens',
      registryUrl: 'https://dsh-plugin.net/plugins/modlens',
      description: 'Turn images into structured evidence.',
      category: 'Vision',
      categorySlug: 'vision',
      packageName: '@liustack/modlens',
      installKind: 'npm',
      installSpec: 'dsh plugin --profile web add @liustack/modlens@3.21.1',
      publishedVersion: '3.27.3',
      nativeBundle: true,
    },
    {
      slug: 'aegis',
      name: 'Aegis',
      repository: 'GanyuanRan/Aegis',
      registryUrl: 'https://dsh-plugin.net/plugins/aegis',
      description: 'Safety checks.',
      category: 'Security',
      categorySlug: 'security',
      packageName: null,
      installKind: 'github',
      installSpec: 'dsh plugin --profile web add github:GanyuanRan/Aegis',
    },
    {
      slug: 'dsh-browser',
      name: 'DSH Browser',
      repository: 'Lum1104/dsh-browser',
      description: 'Installed by a shell script.',
      packageName: null,
      installKind: 'github',
      installSpec: 'curl -fsSL https://example.test/install.sh | bash',
    },
    {
      slug: 'dsh-memory',
      name: 'Memory',
      repository: 'dsh-memory/bundle',
      description: 'Unavailable record.',
      packageName: '@dsh-memory/bundle',
      installKind: 'unavailable',
      installSpec: 'dsh plugin --profile web add @dsh-memory/bundle',
    },
  ],
};

const CATALOG_CHUNK =
  'var e=JSON.parse(`[["acme/dsh-cat","Catalogue bundle","TypeScript","MIT",500,"2026-10-01T00:00:00Z","2026-10-01","dsh-plugin bundle",["bundle-manifest"]],["skip/no-bundle","Script only","JavaScript","MIT",10,"2026-10-01T00:00:00Z","2026-10-01","dsh-plugin",["install-command"]],["liustack/modlens","Duplicate of a reviewed row","JavaScript","MIT",900,"2026-10-01T00:00:00Z","2026-10-01","dsh-plugin",["bundle-manifest"]]]`);export{e as t};';

/** Serves the reviewed snapshot, the catalogue page, and its content-hashed chunk. */
async function dshFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/api/plugins.json')) return json(DSH_SNAPSHOT);
  if (url.endsWith('/plugins')) return new Response('<script src="/assets/catalog-data-0-abc123.js"></script>');
  if (url.includes('/assets/catalog-data-0-abc123.js')) return new Response(CATALOG_CHUNK);
  return json({}, 404);
}

describe('decodeCatalogLiteral', () => {
  it('decodes template-literal escapes without evaluating the upstream script', () => {
    expect(decodeCatalogLiteral('a\\\\"b')).toBe('a\\"b');
    expect(decodeCatalogLiteral('tab\\there')).toBe('tab\there');
  });
});

describe('dsh-plugin.net browse', () => {
  it('keeps only installable reviewed records and maps them to the native handles', async () => {
    const result = await browseDshPluginNet('', 24, 1, undefined, dshFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Two reviewed rows + one catalogue bundle; the script-only and duplicate-repo rows are not
    // installable / already represented by the reviewed npm handle.
    expect(result.total).toBe(3);
    expect(result.items.map((item) => item.key)).toEqual([
      'npm:@liustack/modlens',
      'github:GanyuanRan/Aegis',
      'github:acme/dsh-cat',
    ]);
    expect(result.items[0]).toMatchObject({
      sourceId: 'dsh-plugin-net',
      installKind: 'plugin',
      name: 'Modlens',
      repo: 'liustack/modlens',
      updatedAt: '2026-11-09T00:00:00.000Z',
    });
    expect(result.items[2]).toMatchObject({ stars: 500, repo: 'acme/dsh-cat' });
  });

  it('filters locally, pages the same list, and reports upstream failures as failures', async () => {
    const filtered = await browseDshPluginNet('vision', 1, 1, undefined, async () => json(DSH_SNAPSHOT));
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.items.map((item) => item.name)).toEqual(['Modlens']);
    expect(filtered.hasMore).toBe(false);
    resetBrowseCache();

    const failed = await browseDshPluginNet('', 24, 1, undefined, async () => json({}, 503));
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.code).toBe('upstream');
    expect(failed.reason).toBe('http');
  });

  it('is registered as the DSH default plugin source, not a cross-harness chip', async () => {
    expect(SOURCES.some((source) => source.id === 'dsh-plugin-net')).toBe(true);
    expect(getDefaultViewsForHarness('dsh').map((view) => view.id)).toEqual(['dsh-plugin-net']);
    expect(DSH_PLUGIN_NET_VIEW.hosts).toEqual(['dsh']);
    const browsed = await browseSource(DSH_PLUGIN_NET_VIEW, '', 24, {
      fetchImpl: async () => json(DSH_SNAPSHOT),
    });
    resetBrowseCache();
    expect(browsed.ok).toBe(true);
  });

  it('answers a null snapshot body as a failure, not a TypeError', async () => {
    // `JSON.parse('null')` succeeds, so the shape guard must reject a null payload itself instead of
    // dereferencing `payload.plugins` out of any try — that used to surface as a raw 500 on `/browse`.
    const browsed = await browseDshPluginNet('', 24, 1, undefined, async () => json(null));
    expect(browsed.ok).toBe(false);
    if (browsed.ok) return;
    expect(browsed.code).toBe('upstream');
    expect(browsed.reason).toBe('badPayload');
  });

  it('degrades an unparseable snapshotDate to "no date" instead of throwing a 500', async () => {
    // `snapshotDate` is third-party text: `new Date('not-a-date').toISOString()` throws `RangeError`,
    // which used to escape the reader and surface as a raw 500 on `/browse`.
    const browsed = await browseDshPluginNet('', 24, 1, undefined, async () =>
      json({ ...DSH_SNAPSHOT, snapshotDate: 'not-a-date' })
    );
    expect(browsed.ok).toBe(true);
    if (!browsed.ok) return;
    // The two REVIEWED rows survive; the catalogue bundle page is not served by this mock.
    expect(browsed.items.map((item) => item.name)).toEqual(['Modlens', 'Aegis']);
    expect(browsed.items.every((item) => item.updatedAt === '')).toBe(true);
  });
});

const SKILLS_SH_ANSWER = {
  query: 'react',
  skills: [
    {
      id: 'vercel-labs/agent-skills/vercel-react-best-practices',
      source: 'vercel-labs/agent-skills',
      skillId: 'vercel-react-best-practices',
      name: 'vercel-react-best-practices',
      installs: 885584,
    },
    { id: 'bad-row', source: 'not-a-repo', skillId: 'bad-row', name: 'bad', installs: 1 },
  ],
};

describe('skills.sh browse', () => {
  it('searches the whole catalog for 2+ characters and installs through the GitHub writer', async () => {
    const result = await browseSkillsSh('react', 24, 1, undefined, async () => json(SKILLS_SH_ANSWER));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      key: 'github:vercel-labs/agent-skills#vercel-react-best-practices',
      installKind: 'skill',
      repo: 'vercel-labs/agent-skills',
      stars: null,
    });
    expect(result.totalScope).toBe('window');
  });

  it('reads the chosen board with the site own paging when the query is empty', async () => {
    const urls: string[] = [];
    const board = {
      skills: [
        { source: 'vercel-labs/agent-skills', skillId: 'react', name: 'React' },
        { source: 'open.feishu.cn', skillId: 'docs', name: 'vendor row' },
        { source: 'mattpocock/skills', skillId: 'grill-me', name: 'grill-me' },
      ],
      total: 500,
      hasMore: true,
      page: 0,
    };
    const result = await browseSkillsSh('', 3, 1, 'trending', async (input) => {
      urls.push(String(input));
      return json(board);
    });
    expect(urls[0]).toContain('/api/skills/trending/0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.key)).toEqual([
      'github:vercel-labs/agent-skills#react',
      'github:mattpocock/skills#grill-me',
    ]);
    expect(result.total).toBe(500);
    expect(result.hasMore).toBe(true);
  });

  it('registers the global skill chip with the site own three boards as sorts', () => {
    expect(SOURCES.some((source) => source.id === 'skills-sh')).toBe(true);
    expect(SKILLS_SH_VIEW.hosts).toBeUndefined();
    expect(SKILLS_SH_VIEW.sorts).toEqual(['all-time', 'trending', 'hot']);
  });
});
