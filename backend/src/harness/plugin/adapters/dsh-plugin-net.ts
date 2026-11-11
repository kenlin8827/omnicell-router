import { cache, CACHE_TTL_MS, registerBrowseCache, registerBrowseView, SLOW_CACHE_TTL_MS } from '../../common/market.js';
import type { BrowseResult, MarketItem } from '../../common/market.js';
import { catalogRegistry } from '../../common/catalog-registry.js';
import { readTextCapped } from '../../net.js';
import type { HarnessSourceView } from '../../types.js';

/**
 * dsh-plugin.net — a community, evidence-first DSH plugin registry (ADR-0015 §D10 amendment).
 *
 * It publishes TWO surfaces:
 *   · `/api/plugins.json` (API v3) — the small REVIEWED set: each record states the package or
 *     repository it installs from and the evidence behind the claim — including the repository's
 *     GitHub star count (`stars`), which the registry states itself.
 *   · `/plugins` — the full topic catalogue (≈6.8k repositories, ≈5.9k with a root bundle
 *     manifest), shipped as four content-hashed `catalog-data-*.js` chunks rather than an API.
 * The reader offers the reviewed records first (npm handles where proven), then every catalogue
 * repository whose `bundle-manifest` signal says it carries a DSH bundle, as `github:<owner/repo>`.
 * It never treats `install-command` as proof: that route is often a shell script, and this gateway
 * does not run third-party scripts. A record marked `unavailable`, or one with neither a bundle
 * manifest nor a proven npm package, is not a row.

 * The catalogue chunks are `var e=JSON.parse(\`…\`);export{e as t};`. They are decoded as a JS
 * template literal and parsed as JSON — never evaluated — so a hostile upstream cannot execute in
 * the gateway.
 *
 * Rows are DSH-only (`hosts: ['dsh']`): the vendor CLI lands them in a DSH profile.
 */

const SITE = 'https://dsh-plugin.net';
const API = `${SITE}/api/plugins.json`;
const TIMEOUT_MS = 20_000;
const CATALOG_PAGE = `${SITE}/plugins`;
const CACHE_KEY = 'dsh-plugin-net|snapshot';
const CATALOG_KEY = 'dsh-plugin-net|catalog';

interface DshRecord {
  slug?: unknown;
  name?: unknown;
  repository?: unknown;
  repositoryUrl?: unknown;
  registryUrl?: unknown;
  description?: unknown;
  category?: unknown;
  categorySlug?: unknown;
  packageName?: unknown;
  installKind?: unknown;
  installSpec?: unknown;
  publishedVersion?: unknown;
  nativeBundle?: unknown;
  evidenceScore?: unknown;
  stars?: unknown;
}

interface DshPayload {
  snapshotDate?: unknown;
  plugins?: unknown;
}

interface Installable {
  key: string;
  repo: string | null;
  packageName: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The install handle a reviewed record proves — or null when its documented route is not ours. */
function installable(record: DshRecord): Installable | null {
  const repo = readString(record.repository);
  const repoOk = repo && /^[\w.-]+\/[\w.-]+$/.test(repo);
  const kind = readString(record.installKind);
  const spec = readString(record.installSpec) ?? '';
  if (kind === 'npm') {
    const pkg = readString(record.packageName);
    return pkg ? { key: `npm:${pkg}`, repo: repoOk ? repo : null, packageName: pkg } : null;
  }
  // A git bundle is installable only when the registry's own command adds a github: ref.
  if (repoOk && /add\s+(?:github:|git\+https:\/\/github\.com\/)/.test(spec)) {
    return { key: `github:${repo}`, repo, packageName: null };
  }
  return null;
}

function toItem(record: DshRecord, snapshotDate: string): MarketItem | null {
  const install = installable(record);
  if (!install) return null;
  const name = readString(record.name) ?? install.packageName ?? install.repo ?? install.key;
  const url = readString(record.registryUrl) ?? `${SITE}/plugins/${readString(record.slug) ?? ''}`;
  const category = readString(record.category);
  const categorySlug = readString(record.categorySlug);
  const version = readString(record.publishedVersion);
  // The registry states the repository's GitHub star count per record, so this row needs no
  // on-demand resolver. Absent or malformed stays `null` ("no signal"), never `0`.
  const stars = typeof record.stars === 'number' && Number.isFinite(record.stars) ? record.stars : null;
  return {
    id: `dsh-plugin-net:${readString(record.slug) ?? install.key}`,
    sourceId: 'dsh-plugin-net',
    catalog: 'dsh-plugin.net',
    key: install.key,
    installKind: 'plugin',
    name,
    ...(install.repo ? { repo: install.repo } : {}),
    description: readString(record.description),
    url,
    stars,
    updatedAt: snapshotDate,
    topics: category ? [category] : [],
    ...(categorySlug || version
      ? { categories: [...(categorySlug ? [categorySlug] : []), ...(version ? [version] : [])] }
      : {}),
  };
}

async function readSnapshot(fetchImpl: typeof fetch): Promise<
  | { ok: true; snapshotDate: string; items: MarketItem[] }
  | Extract<BrowseResult, { ok: false }>
> {
  const hit = cache.get(CACHE_KEY);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ok: true, snapshotDate: hit.items[0]?.updatedAt ?? '', items: hit.items };
  }
  let res: Response;
  try {
    res = await fetchImpl(API, {
      headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
    return {
      ok: false,
      code: 'upstream',
      reason: timeout ? 'timeout' : 'network',
      message: timeout ? 'dsh-plugin.net timed out — try again in a moment' : 'dsh-plugin.net could not be reached',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: res.status === 429 ? 'rateLimited' : 'http',
      reasonParams: { status: String(res.status) },
      message: `dsh-plugin.net answered ${res.status}`,
    };
  }
  let payload: DshPayload | null = null;
  try {
    const body = await readTextCapped(res);
    if (!body.ok) {
      return {
        ok: false,
        code: 'upstream',
        reason: 'badPayload',
        message: `dsh-plugin.net answered more than ${body.cap} bytes — refused`,
      };
    }
    payload = JSON.parse(body.text) as DshPayload | null;
  } catch {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'dsh-plugin.net returned an unreadable snapshot' };
  }
  // A literal `null` body parses fine and then explodes on `payload.plugins`, OUTSIDE any guard —
  // the same "reader answers a reason, never throws" rule the date parse below follows.
  if (!payload || !Array.isArray(payload.plugins)) {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'dsh-plugin.net snapshot has no plugin list' };
  }
  const snapshotDate = readString(payload.snapshotDate) ?? '';
  // `snapshotDate` is arbitrary third-party text: an unparseable value must degrade to "no date"
  // instead of throwing `RangeError` out of the reader (an adapter answers a reason, never throws).
  const parsedDate = snapshotDate ? new Date(snapshotDate) : null;
  const updatedAt = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : '';
  const items = (payload.plugins as DshRecord[])
    .map((record) => toItem(record, updatedAt))
    .filter((item): item is MarketItem => item !== null);
  cache.set(CACHE_KEY, { at: Date.now(), items });
  return { ok: true, snapshotDate, items };
}

/**
 * Browse the reviewed snapshot plus the full catalogue. Reviewed rows come first (their npm
 * handle is pinned); catalogue rows follow in the catalogue's own stars order, as
 * `github:<owner/repo>`. A query narrows the UNION locally — neither surface has search/paging.
 *
 * A catalogue failure never hides the reviewed set: the page still answers with those rows and
 * says the full catalogue could not be read.
 */
export async function browseDshPluginNet(
  query: string,
  limit = 24,
  page = 1,
  _sort?: string,
  fetchImpl: typeof fetch = fetch
): Promise<BrowseResult> {
  const [reviewed, catalog] = await Promise.all([readSnapshot(fetchImpl), readCatalog(fetchImpl)]);
  if (!reviewed.ok) return reviewed;
  // Both surfaces publish the repository's GitHub stars, so a reviewed row that states none borrows
  // the catalogue's answer for the same repo instead of sending the operator to the on-demand
  // resolver. A reviewed row that DOES state a count keeps it: the reviewed record is the authority.
  const catalogStars = new Map<string, number>();
  if (catalog.ok) {
    for (const item of catalog.items) {
      if (item.repo && item.stars !== null) catalogStars.set(item.repo, item.stars);
    }
  }
  const withStars = (item: MarketItem): MarketItem => {
    if (item.stars !== null || !item.repo) return item;
    const borrowed = catalogStars.get(item.repo);
    return borrowed === undefined ? item : { ...item, stars: borrowed };
  };
  const reviewedItems = reviewed.items.map(withStars);
  const reviewedRepos = new Set(reviewedItems.map((item) => item.repo).filter((repo): repo is string => !!repo));
  const merged = [
    ...reviewedItems,
    ...(catalog.ok ? catalog.items.filter((item) => !item.repo || !reviewedRepos.has(item.repo)) : []),
  ];
  const needle = query.trim().toLowerCase();
  const tokens = needle ? needle.split(/\s+/) : [];
  const rows = tokens.length
    ? merged.filter((item) =>
        tokens.every((token) =>
          [item.name, item.repo ?? '', item.description ?? '', ...item.topics, ...(item.categories ?? [])]
            .join(' ')
            .toLowerCase()
            .includes(token)
        )
      )
    : merged;
  const size = Math.min(Math.max(limit, 1), 50);
  const at = Math.max(page, 1);
  const offset = (at - 1) * size;
  const items = rows.slice(offset, offset + size);
  return {
    ok: true,
    items,
    hasMore: offset + items.length < rows.length,
    total: rows.length,
    totalScope: 'catalog',
    note: catalog.ok
      ? 'dsh-plugin.net — reviewed records first, then the full bundle catalogue (github installs); the DSH CLI writes the profile'
      : `dsh-plugin.net — reviewed records only; the full catalogue could not be read (${catalog.message})`,
    noteCode: 'dsh-plugin-net',
  };
}

type CatalogRow = [string, string, string, string, number, string, string, string, string[]];

/**
 * Decode the TEMPLATE LITERAL wrapper the site ships (`JSON.parse(\`…\`)`) into the JSON text it
 * would have produced. This is a deterministic escape decoder, not evaluation: `\xNN`, `\uNNNN`,
 * `\u{…}`, `\\`, `\${` and line continuations follow template-literal semantics, and unknown
 * escapes drop their backslash exactly as JS does. Exported for the reader's contract test.
 */
export function decodeCatalogLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    i += 1;
    if (i >= raw.length) {
      out += '\\';
      break;
    }
    const escape = raw[i]!;
    if (escape === 'n') out += '\n';
    else if (escape === 'r') out += '\r';
    else if (escape === 't') out += '\t';
    else if (escape === 'b') out += '\b';
    else if (escape === 'f') out += '\f';
    else if (escape === 'v') out += '\v';
    else if (escape === '0') out += '\0';
    else if (escape === 'x') {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (escape === 'u') {
      if (raw[i + 1] === '{') {
        const close = raw.indexOf('}', i + 2);
        out += String.fromCodePoint(Number.parseInt(raw.slice(i + 2, close), 16));
        i = close;
      } else {
        out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else if (escape === '`') out += '`';
    else if (escape === '\\') out += '\\';
    else if (escape === '$') out += '$';
    else if (escape !== '\n') out += escape;
  }
  return out;
}

function catalogItems(rows: unknown[]): MarketItem[] {
  const seen = new Set<string>();
  const out: MarketItem[] = [];
  for (const raw of rows) {
    if (!Array.isArray(raw) || raw.length < 9) continue;
    const row = raw as CatalogRow;
    const repo = typeof row[0] === 'string' ? row[0].trim() : '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || seen.has(repo)) continue;
    const signals = Array.isArray(row[8]) ? row[8] : [];
    if (!signals.includes('bundle-manifest')) continue;
    seen.add(repo);
    const stars = typeof row[4] === 'number' && Number.isFinite(row[4]) ? row[4] : null;
    const pushed = typeof row[5] === 'string' && row[5] ? row[5] : '';
    const topics = typeof row[7] === 'string' ? row[7].split(/\s+/).filter(Boolean) : [];
    out.push({
      id: `dsh-plugin-net:catalog:${repo}`,
      sourceId: 'dsh-plugin-net',
      catalog: 'dsh-plugin.net',
      key: `github:${repo}`,
      installKind: 'plugin',
      name: repo.split('/').pop() ?? repo,
      repo,
      description: typeof row[1] === 'string' ? row[1] : null,
      url: `${SITE}/check/${repo}`,
      stars,
      updatedAt: pushed,
      topics,
      ...(typeof row[2] === 'string' && row[2] ? { categories: [row[2]] } : {}),
    });
  }
  return out.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
}

async function readCatalog(
  fetchImpl: typeof fetch
): Promise<{ ok: true; items: MarketItem[] } | { ok: false; message: string }> {
  const hit = cache.get(CATALOG_KEY);
  if (hit && Date.now() - hit.at < SLOW_CACHE_TTL_MS) return { ok: true, items: hit.items };
  try {
    const page = await fetchImpl(CATALOG_PAGE, {
      headers: { Accept: 'text/html', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!page.ok) return { ok: false, message: `catalogue page answered ${page.status}` };
    const pageBody = await readTextCapped(page);
    if (!pageBody.ok) throw new Error(`catalogue page exceeded ${pageBody.cap} bytes`);
    const html = pageBody.text;
    const assets = [...new Set(html.match(/\/assets\/catalog-data-\d+-[\w-]+\.js/g) ?? [])].sort();
    if (assets.length === 0) return { ok: false, message: 'catalogue page named no data chunks' };
    const chunks = await Promise.all(
      assets.map(async (asset) => {
        const res = await fetchImpl(`${SITE}${asset}`, {
          headers: { Accept: 'text/javascript', 'User-Agent': 'omnicellrouter-harness' },
          signal: AbortSignal.timeout(TIMEOUT_MS * 2),
        });
        if (!res.ok) throw new Error(`catalogue chunk answered ${res.status}`);
        const chunkBody = await readTextCapped(res);
        if (!chunkBody.ok) throw new Error(`catalogue chunk exceeded ${chunkBody.cap} bytes`);
        return chunkBody.text;
      })
    );
    const rows: unknown[] = [];
    for (const chunk of chunks) {
      const match = chunk.match(/JSON\.parse\(`([\s\S]*?)`\);export/);
      if (!match) throw new Error('catalogue chunk changed shape');
      const parsed = JSON.parse(decodeCatalogLiteral(match[1]!)) as unknown;
      if (!Array.isArray(parsed)) throw new Error('catalogue chunk is not an array');
      rows.push(...parsed);
    }
    const items = catalogItems(rows);
    cache.set(CATALOG_KEY, { at: Date.now(), items });
    return { ok: true, items };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** The dsh-plugin.net chip on the DSH plugin page. */
export const DSH_PLUGIN_NET_VIEW: HarnessSourceView = {
  id: 'dsh-plugin-net',
  catalog: 'dsh-plugin.net',
  label: 'dsh-plugin.net (community)',
  kinds: ['plugin'],
  trust: 'community',
  auth: 'none',
  enabled: true,
  browsable: true,
  hosts: ['dsh'],
  browse: browseDshPluginNet,
};

registerBrowseCache('dsh-plugin-net', () => {
  cache.delete(CACHE_KEY);
  cache.delete(CATALOG_KEY);
});

registerBrowseView(DSH_PLUGIN_NET_VIEW);

catalogRegistry.register({
  harness: 'dsh',
  id: 'dsh-plugin-net',
  catalog: 'dsh-plugin.net',
  label: DSH_PLUGIN_NET_VIEW.label,
  kinds: ['plugin'],
  trust: 'community',
  builtin: true,
  hosts: ['dsh'],
  browse: browseDshPluginNet,
});
