import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { browseSource, resetBrowseCache } from '../src/harness/common/market.js';
import { browsePiDev } from '../src/harness/plugin/adapters/pi-dev.js';
import { decodeEntities, fetchPiDevCatalog, parsePiDevCatalog, parsePiDevCount } from '../src/harness/plugin/adapters/pi-dev.js';
import type { HarnessSourceView } from '../src/harness/types.js';

/**
 * pi.dev is the OFFICIAL Pi catalog, and the only browse source read out of server-rendered HTML
 * instead of an API. The contract under test is therefore narrow and explicit: the card attributes the
 * page's own filter script consumes, the printed `pi install npm:<pkg>` command (which is what makes
 * the row's install handle honest), and the count marker that answers paging. Every failure mode must
 * answer `upstream`/`unavailable`, never an empty market: "no such package" and "the markup moved" are
 * different claims.
 */

const realFetch = globalThis.fetch;

/** One card, shaped exactly like a measured pi.dev page (2026-10-25). */
function card(opts: {
  name: string;
  types?: string;
  date?: number;
  desc?: string;
  packagePath?: string;
  install?: string;
  npm?: string | null;
  repo?: string | null;
}): string {
  const npmLink = opts.npm === null ? '' : `<a href="https://www.npmjs.com/package/${opts.npm ?? opts.name}" target="_blank" rel="noopener">npm</a>`;
  const repoLink = opts.repo === null ? '' : `<a href="https://github.com/${opts.repo ?? 'nicobailon/pi-subagents'}" target="_blank" rel="noopener">repo</a>`;
  const repo = opts.repo === null ? '' : `<a href="https://github.com/${opts.repo ?? 'nicobailon/pi-subagents'}/issues/new?template=package-report.yml&amp;labels=package-report" target="_blank" rel="noopener">report</a>`;
  return `<article class="surface-panel content-card" data-package-card="true" data-package-name="${opts.name}" data-package-search="${opts.name}" data-package-types="${opts.types ?? 'plugin'}" data-package-downloads="558314" data-package-date="${opts.date ?? 1792878517488}" data-package-sort-name="${opts.name}"><div class="packages-card-preview" aria-hidden="true" data-preview-type="plugin"><div class="packages-card-preview-frame" data-package-preview-frame="true" data-package-preview-name="${opts.name}" data-package-preview-status="missing"><span></span></div></div><div class="packages-card-body"><h3 class="packages-name"><a href="/packages/${opts.name}" data-package-link="true" data-package-path="/packages/${opts.packagePath ?? opts.name}">${opts.name}</a></h3><p class="packages-desc">${opts.desc ?? 'Pi plugin for single-agent delegation and scripted multi-agent workflows'}</p><div class="packages-meta"><span>nicopreme</span><span>558.3K/mo</span><span>3h ago</span></div><div class="packages-badges"><span class="meta-chip packages-badge" data-type="plugin">plugin</span></div><div class="packages-links">${npmLink}${repoLink}${repo}</div><div class="packages-install"><code><span class="prefix">$</span> pi install npm:${opts.install ?? opts.name}</code></div></div></article>`;
}

/** A rendered catalog page. The marker must agree with the cards, or "is there a next page" lies. */
function page(cards: string[], opts: { from?: number; total?: number; of?: number; marker?: boolean } = {}): string {
  const from = opts.from ?? 1;
  const total = opts.total ?? (cards.length === 0 ? 0 : from + cards.length - 1);
  const range = cards.length === 0 ? '0-0' : `${from}-${from + cards.length - 1}`;
  const marker =
    opts.marker === false
      ? ''
      : `<span class="packages-count">${range} / ${total}${opts.of === undefined ? '' : ` (of ${opts.of})`}</span>`;
  return `<!DOCTYPE html><html><body><section class="packages-index-card"><header>${marker}</header><div class="content-grid packages-grid">${cards.join('')}</div></section></body></html>`;
}

function stub(status: number, body: string, contentType = 'text/html'): void {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}

/** Serve one HTML per catalog page number (1-based); an unlisted page answers as an empty last page. */
function stubPages(pages: Record<number, string>): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const n = Number(url.searchParams.get('page') ?? '1');
    return new Response(pages[n] ?? page([], { from: 0, total: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { urls };
}

function sourceView(overrides: Partial<HarnessSourceView> = {}): HarnessSourceView {
  return {
    id: 'pi-dev',
    label: 'pi.dev (official)',
    kinds: ['plugin'],
    trust: 'official',
    auth: 'none',
    enabled: true,
    browsable: true,
    hosts: ['pi'],
    ...overrides,
  };
}

/** 50 installable cards — one full catalog page. */
function fullPage(prefix: string): string[] {
  return Array.from({ length: 50 }, (_, i) => card({ name: `${prefix}${i + 1}` }));
}

beforeEach(() => {
  resetBrowseCache();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &lt;p&gt; &quot;q&quot; &#39;s&#39; &#x27;x&#x27;')).toBe(`a & b <p> "q" 's' 'x'`);
    expect(decodeEntities('100&nosuch; & more')).toBe('100&nosuch; & more');
  });
});

describe('parsePiDevCatalog', () => {
  it('reads name, type, date, description, repo and page url from a card', () => {
    const parsed = parsePiDevCatalog(page([card({ name: 'pi-subagents' })]));
    expect(parsed.cards).toBe(1);
    expect(parsed.marker).toBe(true);
    expect(parsed.entries).toHaveLength(1);
    const entry = parsed.entries[0]!;
    expect(entry.packageName).toBe('pi-subagents');
    expect(entry.types).toEqual(['plugin']);
    expect(entry.description).toBe('Pi plugin for single-agent delegation and scripted multi-agent workflows');
    expect(entry.repoUrl).toBe('https://github.com/nicobailon/pi-subagents');
    expect(entry.url).toBe('https://pi.dev/packages/pi-subagents');
    expect(entry.publishedAt).toBe(new Date(1792878517488).toISOString());
  });

  it('never mistakes the card report link for the project repository', () => {
    const parsed = parsePiDevCatalog(page([card({ name: 'no-repo', repo: null })]));
    // Only the `…/pi/issues/new?…` report anchor is left in that card.
    expect(parsed.entries[0]!.repoUrl).toBeUndefined();
  });

  it('prefers the printed install command over the card name and keeps scoped names intact', () => {
    const parsed = parsePiDevCatalog(
      page([card({ name: 'friendly-fork', install: '@scope/real-pkg', npm: '@scope/real-pkg' })])
    );
    expect(parsed.entries[0]!.packageName).toBe('@scope/real-pkg');
  });

  it('turns an escaped-markup banner into no description rather than markup soup', () => {
    const parsed = parsePiDevCatalog(
      page([card({ name: 'pi-intercom', desc: '&lt;p&gt;   &lt;img src=&quot;banner.png&quot; alt=&quot;pi-intercom&quot; width=&quot;1100&quot;&gt; &lt;/p&gt;' })])
    );
    expect(parsed.entries[0]!.description).toBeNull();
  });

  it('decodes an escaped description instead of dropping it', () => {
    const parsed = parsePiDevCatalog(page([card({ name: 'decode-me', desc: 'Memory &amp; recall for Pi' })]));
    expect(parsed.entries[0]!.description).toBe('Memory & recall for Pi');
  });

  it('reports a card count of zero for a page with the result marker only', () => {
    const parsed = parsePiDevCatalog(page([]));
    expect(parsed).toEqual({ entries: [], cards: 0, marker: true });
  });
});

describe('parsePiDevCount', () => {
  it('reads the match count and the successor flag from a query page', () => {
    expect(parsePiDevCount(page([], { from: 1, total: 286, of: 5338, marker: true }))).toEqual({ total: 286, more: true });
  });

  it('reads a whole-catalog page without the "(of N)" suffix', () => {
    expect(parsePiDevCount('<span class="packages-count">1-50 / 5338</span>')).toEqual({ total: 5338, more: true });
  });

  it('stops at the last page', () => {
    expect(parsePiDevCount('<span class="packages-count">251-286 / 286 (of 5338)</span>')).toEqual({ total: 286, more: false });
    expect(parsePiDevCount('<span class="packages-count">0-0 / 0</span>')).toEqual({ total: 0, more: false });
  });

  it('answers "unknown, no successor" for a page without the marker', () => {
    expect(parsePiDevCount('<html><body>nothing</body></html>')).toEqual({ total: null, more: false });
  });
});

describe('fetchPiDevCatalog paging', () => {
  it('leaves page 1 without the parameter and addresses deeper pages with the catalog own `page`', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(new URL(String(input)).search);
      return new Response(page([card({ name: 'x' })]), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchPiDevCatalog('sub agents');
    await fetchPiDevCatalog('sub agents', 3);
    expect(urls[0]).toContain('name=sub%20agents');
    expect(urls[0]).not.toContain('page=1');
    expect(urls[1]).toContain('page=3');
  });

  it("sends the catalog's own sort value and falls back to downloads for an unknown one", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(new URL(String(input)).search);
      return new Response(page([card({ name: 'x' })]), { status: 200 });
    }) as unknown as typeof fetch;

    // The catalog's sort control offers exactly three orders (measured 2026-10-25).
    await fetchPiDevCatalog('', 1, fetch, 'recent');
    await fetchPiDevCatalog('', 1, fetch, 'name');
    // An order the site does not document is never sent: it falls back to the default ranking.
    await fetchPiDevCatalog('', 1, fetch, 'stars');
    expect(urls[0]).toContain('sort=recent');
    expect(urls[1]).toContain('sort=name');
    expect(urls[2]).toContain('sort=downloads');
  });

  it('reports the source count and whether a successor page exists', async () => {
    stub(200, page(fullPage('row'), { from: 1, total: 286, of: 5338 }));
    const read = await fetchPiDevCatalog('subagents');
    if (!read.ok) throw new Error('expected ok');
    expect(read.total).toBe(286);
    expect(read.more).toBe(true);
  });
});

describe('browsePiDev', () => {
  it('maps every row onto the shared market shape with an npm install handle', async () => {
    stub(200, page([card({ name: 'pi-subagents' })]));
    const result = await browsePiDev('', 24);
    if (!result.ok) throw new Error('expected ok');
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.id).toBe('pi-dev:pi-subagents');
    expect(item.sourceId).toBe('pi-dev');
    // The catalog prints `pi install npm:<pkg>`: the package is the identity, so the row installs
    // through the npm source and the console's installed-state join stays exact.
    expect(item.key).toBe('npm:pi-subagents');
    expect(item.installKind).toBe('plugin');
    expect(item.repo).toBe('nicobailon/pi-subagents');
    expect(item.url).toBe('https://pi.dev/packages/pi-subagents');
    expect(item.stars).toBeNull();
    expect(item.updatedAt).toBe(new Date(1792878517488).toISOString());
    expect(result.note).toBeString();
  });

  it('lists the catalog row for row — typed rows included, since every row installs the same way', async () => {
    stub(
      200,
      page([
        card({ name: 'an-plugin', types: 'plugin' }),
        card({ name: 'a-bundle', types: '' }),
        card({ name: 'multi-typed', types: 'plugin skill prompt' }),
        card({ name: 'a-skill', types: 'skill' }),
        card({ name: 'a-theme', types: 'theme' }),
        card({ name: 'a-prompt', types: 'prompt' }),
      ])
    );
    const result = await browsePiDev('', 50);
    if (!result.ok) throw new Error('expected ok');
    // Dropping rows would break the one thing a 5 000-row catalog needs: an exact `from–to / total`.
    expect(result.items.map((i) => i.name)).toEqual([
      'an-plugin',
      'a-bundle',
      'multi-typed',
      'a-skill',
      'a-theme',
      'a-prompt',
    ]);
  });

  it('reports the source own count, the way the catalog prints it', async () => {
    stub(200, page(fullPage('row'), { from: 1, total: 5338 }));
    const result = await browsePiDev('', 24);
    if (!result.ok) throw new Error('expected ok');
    expect(result.total).toBe(5338);
    expect(result.hasMore).toBe(true);
  });

  it('reads the two catalog pages a console window straddles, without gaps or repeats', async () => {
    const first = fullPage('row');
    const second = Array.from({ length: 10 }, (_, i) => card({ name: `row${51 + i}` }));
    const { urls } = stubPages({
      1: page(first, { from: 1, total: 60 }),
      2: page(second, { from: 51, total: 60 }),
    });

    // Console page 3 at 24 rows/page = catalog rows 49..72: the tail of page 1 and page 2.
    const result = await browsePiDev('', 24, 3);
    if (!result.ok) throw new Error('expected ok');
    expect(result.items.map((i) => i.name)).toEqual([
      'row49',
      'row50',
      ...Array.from({ length: 10 }, (_, i) => `row${51 + i}`),
    ]);
    expect(result.hasMore).toBe(false);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('page=2');
  });

  it('answers a next page with the leftover rows of the catalog', async () => {
    // A 50-row catalog: console page 3 starts at row 49, and catalog page 2 is an empty page.
    stubPages({ 1: page(fullPage('row'), { from: 1, total: 50 }) });
    const result = await browsePiDev('', 24, 3);
    if (!result.ok) throw new Error('expected ok');
    expect(result.items.map((i) => i.name)).toEqual(['row49', 'row50']);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(50);
  });

  it('reuses one cached catalog page across console pages inside the window', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(page(fullPage('row'), { from: 1, total: 200 }), { status: 200 });
    }) as unknown as typeof fetch;

    await browsePiDev('', 24, 1);
    await browsePiDev('', 24, 2);
    expect(calls).toBe(1);
  });

  it('reads any depth in at most two catalog fetches — no walk from the first page', async () => {
    const { urls } = stubPages({
      10: page(fullPage('tenth'), { from: 451, total: 5338 }),
      11: page(fullPage('eleventh'), { from: 501, total: 5338 }),
    });

    // Console page 21 at 24 rows/page = catalog rows 481..504 → catalog pages 10 and 11.
    const result = await browsePiDev('', 24, 21);
    if (!result.ok) throw new Error('expected ok');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('page=10');
    expect(urls[1]).toContain('page=11');
    expect(result.items[0]?.name).toBe('tenth31');
    expect(result.total).toBe(5338);
    expect(result.hasMore).toBe(true);
  });

  it('answers an empty list for a query the catalog has no result for', async () => {
    stub(200, page([]));
    const result = await browsePiDev('zzz-no-such-package-zzz', 24);
    if (!result.ok) throw new Error('expected ok');
    expect(result.items).toEqual([]);
  });

  it('answers unavailable when the CDN throttles or fails', async () => {
    stub(429, 'slow down');
    const throttled = await browsePiDev('', 24);
    expect(throttled).toMatchObject({ ok: false, code: 'unavailable', reason: 'unavailable' });

    resetBrowseCache();
    stub(503, 'down');
    const failed = await browsePiDev('', 24);
    expect(failed).toMatchObject({ ok: false, code: 'unavailable', reason: 'unavailable' });
  }, 30_000);

  it('answers upstream for a non-OK answer other than throttling — and names the status', async () => {
    stub(404, 'not found');
    const result = await browsePiDev('', 24);
    // `reason` is what the console translates; the status rides along so the sentence can name it.
    expect(result).toMatchObject({
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: '404' },
    });
  }, 30_000);

  it('answers upstream when the connection fails — in a sentence, not the runtime text', async () => {
    globalThis.fetch = (async () => {
      // Verbatim Bun message: it names no subject and prescribes an option the console cannot set.
      throw new Error(
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'
      );
    }) as unknown as typeof fetch;
    const result = await browsePiDev('', 24);
    expect(result).toEqual({
      ok: false,
      code: 'upstream',
      reason: 'network',
      message: 'pi.dev catalog could not be reached — check the network connection and try again',
    });
  }, 30_000);

  it('answers upstream and names a timeout as a timeout', async () => {
    globalThis.fetch = (async () => {
      const timeout = new Error('The operation timed out.');
      timeout.name = 'TimeoutError';
      throw timeout;
    }) as unknown as typeof fetch;
    const result = await browsePiDev('', 24);
    expect(result).toEqual({
      ok: false,
      code: 'upstream',
      reason: 'timeout',
      message: 'pi.dev catalog timed out — try again in a moment',
    });
  }, 30_000);

  it('answers upstream when the page is not a catalog any more', async () => {
    stub(200, '<!DOCTYPE html><html><body><h1>Redesigned</h1></body></html>');
    const result = await browsePiDev('', 24);
    expect(result).toMatchObject({ ok: false, code: 'upstream', reason: 'markupChanged' });
  });

  it('answers upstream when cards survive but carry no package identity', async () => {
    stub(200, page(['<article data-package-card="true" data-package-types="plugin"></article>']));
    const result = await browsePiDev('', 24);
    expect(result).toMatchObject({ ok: false, code: 'upstream', reason: 'markupChanged' });
  });
});

describe('browseSource dispatch', () => {
  it('routes pi-dev to the official catalog reader and passes the page through', async () => {
    const { urls } = stubPages({
      1: page(fullPage('row'), { from: 1, total: 300 }),
      2: page(fullPage('next'), { from: 51, total: 300 }),
    });
    const result = await browseSource(sourceView(), '', 24, { harness: 'pi', page: 3 });
    if (!result.ok) throw new Error('expected ok');
    expect(result.items[0]?.sourceId).toBe('pi-dev');
    expect(urls[1]).toContain('page=2');
  });

  it('keeps an unavailable source honest instead of blanking the market', async () => {
    const result = await browseSource(
      sourceView({ enabled: false, unavailableReason: 'measured: 401 without a key' }),
      '',
      24
    );
    expect(result).toEqual({
      ok: false,
      code: 'unavailable',
      reason: 'unavailable',
      message: 'measured: 401 without a key',
    });
  });
});
