import { describeFetchFailure } from '../net.js';

/**
 * NPM marketplace source (ADR-0015 §D9 amendment, 2026-10-31): the operator may register a package
 * name or a whole scope (`@scope/*`) as a plugin source. Discovery is a registry read; INSTALL is
 * still the npm resolver (`npm:<pkg>`), so a row registered here and the same package browsed
 * elsewhere share one identity.
 *
 * A package PAGE URL is accepted as the same input: npmjs.com displays exactly the name the
 * registry answers for, so normalizing it adds no second identity — the link an operator copies is
 * just another spelling of `name`. A tarball or version-document URL is NOT a package page and
 * stays invalid (it names an archive or a pin, not the package).
 *
 * Only what the registry itself states is used: the package name, plus the description it publishes.
 * No popularity, no stars (the registry has neither), and no author runtime arguments.
 */

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 30_000;
/** Scope reads are a listing, not a crawl: the first page of the registry's own ranking. */
const SCOPE_LIMIT = 25;

export type NpmQuery =
  | { ok: true; kind: 'package'; name: string }
  | { ok: true; kind: 'scope'; scope: string }
  | { ok: false; kind: 'invalid'; message: string };

/**
 * The registry name a package page URL displays, or null when the URL is not such a page.
 *
 * `https://www.npmjs.com/package/<name>` accepts the scoped forms (`@scope/pkg`, `%2F`-encoded) and
 * the page's `/v/<version>` tab — that tab is display state, not a pin (the resolver pins the
 * version from the registry document). `https://registry.npmjs.org/<name>` is accepted at its ROOT
 * only: a deeper path (`/pkg/1.2.3`, `/-/pkg.tgz`) names a version or an archive, which this source
 * cannot represent, so it stays invalid rather than silently resolving to "latest".
 */
function nameFromUrl(value: string): string | null {
  const page = /^https?:\/\/(?:www\.)?npmjs\.com\/package\/([^?#]+)/i.exec(value);
  const registry = /^https?:\/\/registry\.npmjs\.org\/([^?#]+)/i.exec(value);
  const raw = page?.[1] ?? registry?.[1];
  if (!raw) return null;
  const segments = raw
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const [first, second] = segments;
  if (!first) return null;
  // `%2F` keeps the scope in one segment; the plain form splits it across two.
  const scoped = first.startsWith('@') && !first.includes('/');
  const name = first.startsWith('@')
    ? first.includes('/')
      ? first
      : second
        ? `${first}/${second}`
        : ''
    : first;
  if (!name) return null;
  if (registry && segments.length > (scoped ? 2 : 1)) return null;
  return name;
}

/** Parse the operator's input: a package (`@scope/pkg`, `pkg`), a scope prefix (`@scope/*`), or a
 *  package page URL (normalized to its name). */
export function parseNpmSource(raw: string): NpmQuery {
  const trimmed = raw.trim().replace(/^npm:/i, '');
  const value = nameFromUrl(trimmed) ?? trimmed;
  if (/^@[\w.-]+\/\*$/.test(value)) return { ok: true, kind: 'scope', scope: value.slice(0, -2) };
  if (/^(@[\w.-]+\/)?[\w.-]+$/.test(value)) return { ok: true, kind: 'package', name: value };
  return { ok: false, kind: 'invalid', message: `invalid npm package or scope '${raw}'` };
}

export interface NpmPackageRow {
  name: string;
  description: string | null;
}

export type NpmProbeOutcome =
  | { ok: true; packages: NpmPackageRow[] }
  | { ok: false; message: string };

interface Packument {
  name?: string;
  description?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { name?: string; description?: string }>;
}

interface SearchAnswer {
  objects?: { package?: { name?: string; description?: string } }[];
}

async function readJson<T>(fetchImpl: typeof fetch, url: string, what: string): Promise<{ ok: true; body: T } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, message: describeFetchFailure(`npm registry for ${what}`, e) };
  }
  if (res.status === 404) return { ok: false, message: `${what} is not in the registry` };
  if (!res.ok) return { ok: false, message: `${what}: registry returned HTTP ${res.status}` };
  try {
    return { ok: true, body: (await res.json()) as T };
  } catch {
    return { ok: false, message: `${what}: registry returned non-JSON content` };
  }
}

/** Read one package (existence + name + description), or the first page of one scope. */
export async function probeNpmSource(query: NpmQuery, fetchImpl: typeof fetch = fetch): Promise<NpmProbeOutcome> {
  if (!query.ok) return { ok: false, message: query.message };
  if (query.kind === 'package') {
    const path = query.name.startsWith('@') ? query.name.replace('/', '%2F') : query.name;
    const answer = await readJson<Packument>(fetchImpl, `${REGISTRY}/${path}`, `package '${query.name}'`);
    if (!answer.ok) return answer;
    const doc = answer.body;
    const latest = doc['dist-tags']?.latest;
    const version = latest ? doc.versions?.[latest] : undefined;
    return {
      ok: true,
      packages: [{ name: doc.name ?? query.name, description: doc.description ?? version?.description ?? null }],
    };
  }
  const answer = await readJson<SearchAnswer>(fetchImpl, `${REGISTRY}/-/v1/search?text=scope:${encodeURIComponent(query.scope)}&size=${SCOPE_LIMIT}`, `scope '${query.scope}'`);
  if (!answer.ok) return answer;
  const packages = (answer.body.objects ?? [])
    .map((entry) => entry.package)
    .filter((pkg): pkg is { name: string; description?: string } => !!pkg && typeof pkg.name === 'string')
    .map((pkg) => ({ name: pkg.name, description: pkg.description ?? null }));
  if (packages.length === 0) return { ok: false, message: `no packages found in scope '${query.scope}'` };
  return { ok: true, packages };
}
