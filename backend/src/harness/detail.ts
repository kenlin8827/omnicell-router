import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from './net.js';
import { fetchClawHubSkill } from './clawhub.js';

/**
 * Market-row detail (ADR-0015 §D6) — the long-form half of a browse answer.
 *
 * A market row carries what a search/list endpoint can carry: a name, a one-line description, stars
 * and a link. The console's detail dialog needs what only a SECOND read can produce — the README and
 * the package facts (licence, version, publish date). Three upstreams serve that: the npm registry
 * document, the GitHub repo + README, and ClawHub's own per-skill record (whose `description` IS the
 * published SKILL.md — that registry stores its skills itself and names no repository).
 *
 * **This module never fetches a caller-supplied URL.** The console holds `item.url`, but embedding a
 * remote page was measured impossible (github.com and npmjs.com answer `X-Frame-Options: deny` /
 * `SAMEORIGIN`, pi.dev answers `SAMEORIGIN`), so the console renders a native dialog instead — and a
 * proxy that would follow an arbitrary URL is exactly the SSRF surface this endpoint refuses to be.
 * Only the package name parsed out of `npm:<name>`, a validated `owner/repo` and the
 * `clawhub:<owner>/<slug>` pair decide the upstream.
 *
 * Failure wording follows the shared rule (see `net.ts`): a translatable `reason` plus an English
 * `message` fallback, never the runtime's own error text.
 */

const NPM_REGISTRY = 'https://registry.npmjs.org';
const GITHUB_API = 'https://api.github.com';
/** READMEs run long (some plugins ship 200 KiB of markdown); the console renders one dialog. */
const README_CAP = 120_000;
/** Longer than a browse page's 60 s: a README does not change per keystroke, and the anonymous
 *  GitHub budget is 60 req/hour on a per-IP basis. */
const CACHE_TTL_MS = 10 * 60_000;

export interface MarketDetail {
  /** Markdown body, already capped. `null` when the row publishes none. */
  readme: string | null;
  /** Repository the body came from, when one could be resolved. */
  repo?: string;
  description?: string;
  homepage?: string;
  license?: string;
  latestVersion?: string;
  /** ISO timestamp of the latest publish (npm) / last push (GitHub). */
  publishedAt?: string;
  updatedAt?: string;
  language?: string;
  stars?: number;
  topics?: string[];
  /**
   * The SOURCE'S OWN popularity counters — today ClawHub's star/download/install tally. Separate
   * from `stars` on purpose: those are GitHub's unit, and the console labels this row with its
   * source instead of relabelling a number (ADR-0015 §D6).
   */
  registryStats?: {
    stars: number | null;
    downloads: number | null;
    installs: number | null;
  };
  /** Which upstream actually answered. `none` = nothing could be read (the caller renders local
   *  row data only, so the dialog still opens). */
  readFrom: 'npm' | 'github' | 'clawhub' | 'none';
  /** Why the long-form read produced nothing, in the console's translatable vocabulary. */
  reason?: FailureReason;
  reasonParams?: Record<string, string>;
  /** English fallback for `reason` — and the diagnostic. */
  message?: string;
}

interface NpmDoc {
  name?: string;
  description?: string;
  homepage?: string;
  license?: string | { type?: string };
  keywords?: string[];
  readme?: string;
  repository?: string | { url?: string };
  'dist-tags'?: { latest?: string };
  time?: Record<string, string>;
}

interface GithubRepoDoc {
  description?: string;
  homepage?: string;
  language?: string;
  stargazers_count?: number;
  updated_at?: string;
  pushed_at?: string;
  topics?: string[];
  license?: { spdx_id?: string; name?: string } | null;
}

/** A patch onto the accumulator, plus the failure wording when a read produced nothing. */
interface ReadOutcome {
  patch: Partial<MarketDetail>;
  problem?: { reason: FailureReason; reasonParams?: Record<string, string>; message: string };
}

const cache = new Map<string, { at: number; detail: MarketDetail }>();

/** Cache keys are caller-shaped (any package/repo pair a market row names), so the Map is bounded:
 *  past the cap the oldest entries are dropped (a Map iterates in insertion order). */
const CACHE_MAX_ENTRIES = 200;

/** Test hook: a cached detail would otherwise leak between cases. */
export function resetDetailCache(): void {
  cache.clear();
}

/**
 * A package name this reader is willing to interpolate into a registry URL.
 *
 * The input reaches us from a market row named by a THIRD PARTY (a catalog prints its own install
 * command), so it is validated here, at the boundary, before any string concatenation: no traversal
 * segment, no extra slash, no scheme.
 */
export function safePackageName(name: string | undefined | null): string | null {
  const raw = name?.trim();
  if (!raw || raw.length > 214) return null;
  const parts = raw.split('/');
  if (parts.length > 2) return null;
  // Two segments only as a SCOPE: `@owner/name`. A bare `@scope` names nothing.
  if (parts.length === 2 && (!parts[0]!.startsWith('@') || parts[0]!.length < 2)) return null;
  if (parts.length === 1 && parts[0]!.startsWith('@')) return null;
  for (const part of parts) {
    if (!/^@?[\w.-]+$/.test(part)) return null;
    if (part === '.' || part === '..') return null;
  }
  return raw;
}

/** `npm:<name>` → the package name, or null when the key names another source. */
export function packageFromKey(key: string | undefined | null): string | null {
  const raw = key?.trim();
  if (!raw || !raw.startsWith('npm:')) return null;
  return safePackageName(raw.slice('npm:'.length));
}

/** `owner/repo` as the console spelled it, or null. Never a URL: the API host is ours to pick. */
export function safeRepoSlug(slug: string | undefined | null): string | null {
  const m = /^([\w.-]{1,100})\/([\w.-]{1,100})$/.exec(slug?.trim() ?? '');
  if (!m) return null;
  if (m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * `clawhub:<owner>/<slug>` → the two identity halves, or null when the key names another source.
 *
 * ClawHub rows carry no npm name and no repository, so their detail is read from the registry's own
 * record — and the pair is validated here, at the boundary, for exactly the reason `safeRepoSlug`
 * exists: both halves are interpolated into a URL this process chooses.
 */
export function clawhubFromKey(key: string | undefined | null): { owner: string; slug: string } | null {
  const raw = key?.trim();
  if (!raw || !raw.startsWith('clawhub:')) return null;
  const slug = safeRepoSlug(raw.slice('clawhub:'.length));
  if (!slug) return null;
  const [owner, name] = slug.split('/') as [string, string];
  return { owner, slug: name };
}

/** A `repository` field (string or `{url}`) → `owner/repo`, for the GitHub fallback read. */
function repoFromRepositoryField(value: NpmDoc['repository']): string | undefined {
  const url = typeof value === 'string' ? value : value?.url;
  if (!url) return undefined;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Line endings normalized and length bounded — one dialog renders it, no scrolling cliff. */
function capReadme(text: string | undefined): string | null {
  if (typeof text !== 'string') return null;
  const body = text.replace(/\r\n/g, '\n').trim();
  if (!body) return null;
  return body.length > README_CAP ? `${body.slice(0, README_CAP)}\n\n…(README truncated)` : body;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** ms epoch → ISO, or undefined — a registry that states no timestamp gets no guessed date. */
function isoFromMs(value: number | null | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

async function readNpm(pkg: string, fetchImpl: typeof fetch): Promise<ReadOutcome> {
  let res: Response;
  try {
    // The per-attempt deadline and the retry budget come from the shared policy (`net.ts`).
    res = await fetchWithRetry(
      `${NPM_REGISTRY}/${pkg}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' } },
      undefined,
      { fetchImpl }
    );
  } catch (e) {
    return { patch: {}, problem: { reason: fetchFailureReason(e), message: describeFetchFailure(`npm package '${pkg}'`, e) } };
  }
  if (res.status === 404) {
    return {
      patch: {},
      problem: { reason: 'http', reasonParams: { status: '404' }, message: `npm has no package '${pkg}'` },
    };
  }
  if (res.status === 429 || res.status >= 500) {
    return {
      patch: {},
      problem: { reason: 'unavailable', message: `npm registry returned HTTP ${res.status} — try again later` },
    };
  }
  if (!res.ok) {
    return {
      patch: {},
      problem: { reason: 'http', reasonParams: { status: String(res.status) }, message: `npm registry returned HTTP ${res.status}` },
    };
  }

  let doc: NpmDoc;
  try {
    doc = (await res.json()) as NpmDoc;
  } catch {
    return { patch: {}, problem: { reason: 'badPayload', message: 'npm registry answered non-JSON content' } };
  }

  const latest = doc['dist-tags']?.latest;
  const license = typeof doc.license === 'string' ? doc.license : doc.license?.type;
  return {
    patch: {
      readFrom: 'npm',
      readme: capReadme(doc.readme),
      description: nonEmpty(doc.description),
      homepage: nonEmpty(doc.homepage),
      license: nonEmpty(license),
      latestVersion: nonEmpty(latest),
      publishedAt: latest ? doc.time?.[latest] : doc.time?.modified,
      updatedAt: doc.time?.modified,
      topics: doc.keywords?.length ? doc.keywords : undefined,
      repo: repoFromRepositoryField(doc.repository),
    },
  };
}

function githubHeaders(raw = false): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'User-Agent': 'omnicellrouter-harness',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** The repository read: facts and README, both inside one anonymous-budget window. */
async function readGithub(repo: string, fetchImpl: typeof fetch): Promise<ReadOutcome> {
  // Each read carries its own attempt deadline inside the shared retry policy (`net.ts`); a reset on
  // one of them is repaired without failing the dialog.
  const [readmeRes, repoRes] = await Promise.all([
    fetchWithRetry(`${GITHUB_API}/repos/${repo}/readme`, { headers: githubHeaders(true) }, undefined, {
      fetchImpl,
    }).catch(() => null),
    fetchWithRetry(`${GITHUB_API}/repos/${repo}`, { headers: githubHeaders() }, undefined, { fetchImpl }).catch(
      () => null
    ),
  ]);

  const patch: Partial<MarketDetail> = { repo };

  if (repoRes?.ok) {
    patch.readFrom = 'github';
    try {
      const doc = (await repoRes.json()) as GithubRepoDoc;
      patch.description = nonEmpty(doc.description);
      patch.homepage = nonEmpty(doc.homepage);
      patch.language = nonEmpty(doc.language);
      patch.stars = typeof doc.stargazers_count === 'number' ? doc.stargazers_count : undefined;
      patch.updatedAt = nonEmpty(doc.pushed_at) ?? nonEmpty(doc.updated_at);
      patch.topics = doc.topics?.length ? doc.topics : undefined;
      patch.license = nonEmpty(doc.license?.spdx_id) ?? nonEmpty(doc.license?.name);
    } catch {
      // A repo document we cannot decode leaves the patch as the slug alone; the README may still
      // have answered, and a half-filled dialog beats none.
    }
  }

  if (readmeRes?.ok) {
    try {
      patch.readme = capReadme(await readmeRes.text());
      patch.readFrom = 'github';
      return { patch };
    } catch {
      // fall through to the failure wording below
    }
  }

  // No README is a normal answer, not a failure: plenty of packages document themselves in the
  // registry description. Only a refused/throttled read is worth reporting.
  const status = readmeRes?.status ?? 0;
  if (status === 0) {
    return {
      patch,
      problem: { reason: 'network', message: `GitHub could not be reached for '${repo}' — check the network connection and try again` },
    };
  }
  if (status === 404) return { patch };
  if (status === 403 || status === 429) {
    return {
      patch,
      problem: {
        reason: 'rateLimited',
        reasonParams: { status: String(status) },
        message: `GitHub refused the README read (HTTP ${status}) — set GITHUB_TOKEN or try again later`,
      },
    };
  }
  return {
    patch,
    problem: {
      reason: 'http',
      reasonParams: { status: String(status) },
      message: `GitHub returned HTTP ${status} for the README`,
    },
  };
}

/**
 * Read the long-form half of one market row.
 *
 * Order: the registry first (one request, and it carries the README for the overwhelming majority of
 * packages), then the repository (facts + README) when the registry had no body or the row has no
 * package at all. A `clawhub:<owner>/<slug>` row takes neither of those paths — it has no npm name
 * and no repository, and its registry's own per-skill record carries the published SKILL.md. A row
 * that reaches none of them still answers — `readFrom: 'none'` — because the dialog is built on the
 * row the console already holds.
 */
export async function readMarketDetail(
  input: { key?: string; repo?: string },
  fetchImpl: typeof fetch = fetch
): Promise<MarketDetail> {
  const pkg = packageFromKey(input.key);
  const repo = safeRepoSlug(input.repo);
  // Only a row with no npm identity can be a ClawHub row: the two are mutually exclusive, and the
  // key names exactly one source.
  const clawhub = pkg ? null : clawhubFromKey(input.key);

  const cacheKey = `detail|${pkg ?? ''}|${repo ?? ''}|${clawhub ? `${clawhub.owner}/${clawhub.slug}` : ''}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.detail;

  let detail: MarketDetail = { readme: null, readFrom: 'none', ...(repo ? { repo } : {}) };
  let problem: ReadOutcome['problem'];

  if (pkg) {
    const npm = await readNpm(pkg, fetchImpl);
    detail = { ...detail, ...npm.patch };
    problem = npm.problem;
  }

  if (clawhub) {
    const read = await fetchClawHubSkill(clawhub.slug, clawhub.owner, fetchImpl);
    if (read.ok) {
      const skill = read.detail;
      const publishedAt = isoFromMs(skill.publishedAtMs);
      const updatedAt = isoFromMs(skill.updatedAtMs);
      detail = {
        ...detail,
        readFrom: 'clawhub',
        readme: capReadme(skill.body ?? undefined),
        ...(skill.summary ? { description: skill.summary } : {}),
        ...(skill.version ? { latestVersion: skill.version } : {}),
        ...(skill.license ? { license: skill.license } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(skill.topics.length > 0 ? { topics: skill.topics } : {}),
        ...(skill.stats ? { registryStats: skill.stats } : {}),
      };
    } else {
      problem = {
        reason: read.reason ?? 'http',
        ...(read.reasonParams ? { reasonParams: read.reasonParams } : {}),
        message: read.message,
      };
    }
  }

  const repoForReadme = repo ?? detail.repo;
  if (!detail.readme && repoForReadme) {
    const gh = await readGithub(repoForReadme, fetchImpl);
    detail = { ...detail, ...gh.patch };
    // The repository read speaks about the README it could not deliver; a repo that answered its
    // facts without a README is not a failure at all, so only a real problem replaces the reason.
    if (gh.problem) problem = gh.problem;
    else if (detail.readme) problem = undefined;
  }

  if (problem) {
    detail = {
      ...detail,
      reason: problem.reason,
      ...(problem.reasonParams ? { reasonParams: problem.reasonParams } : {}),
      message: problem.message,
    };
  }

  // A FAILED read is not cached: the operator's next click is a retry, and pinning a network blip
  // for ten minutes would make the dialog look permanently broken.
  if (!detail.reason) {
    while (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { at: Date.now(), detail });
  }
  return detail;
}
