/**
 * ClawHub reader (`https://clawhub.ai`) — the public skill registry of OpenClaw, and the one skill
 * registry whose rows install from the registry's OWN store rather than from a GitHub repository.
 *
 * Everything below reads the registry's documented public API (measured 2026-10-25, anonymous):
 *   `GET /api/v1/skills?limit=&cursor=&sort=` → 200 `{items: [...], nextCursor}` — cursor-paged
 *      whole-catalog listing; `sort` accepts `recommended|updated|createdAt|downloads|stars|…`
 *      (the OpenAPI enum; aliases `rating`/`installs`/`newest` are legacy spellings). A page honors
 *      the requested `limit` (measured: 100 → 99 rows), so one console page (≤ 50) is one upstream
 *      page. `trending` is the one sort the cursor does NOT apply — never declared to the console.
 *   `GET /api/v1/search?q=&limit=` → 200 `{results: [...]}` — relevance-ranked whole-catalog search
 *      with NO paging parameter (measured: `offset` is ignored, identical first page; the OpenAPI
 *      spec declares only `q`/`limit`/filters). One answer is the whole reach of a query, so the
 *      console treats it as a window — a count the pager can use but the summary must not print.
 *   `GET /api/v1/skills/<slug>?ownerHandle=` → 200 `{skill, latestVersion, metadata, owner,
 *      moderation}` — the registry's own record for ONE skill, including `skill.description` (the
 *      published `SKILL.md` verbatim, frontmatter and all), `latestVersion.license/createdAt` and the
 *      moderation verdict. This is the long-form half a detail dialog renders (`harness/detail.ts`);
 *      the row itself still carries only the summary. An `ownerHandle` that owns no such slug answers
 *      404 (measured 2026-10-25), so the parameter doubles as the disambiguator the versions and
 *      download endpoints already need.
 *   `GET /api/v1/skills/<slug>/versions?limit=&ownerHandle=` → 200 `{items: [{version, …}]}` —
 *      semver list, newest first. `ownerHandle` is UNDOCUMENTED on this endpoint but is the
 *      parameter the registry's own `409 Ambiguous skill slug` error names, and it is what
 *      disambiguates a slug several publishers use (measured: `self-improving-agent` + ownerHandle
 *      answers that owner's versions).
 *   `GET /api/v1/download?slug=&ownerHandle=&version=` → 200 `application/zip` — deterministic
 *      bytes for that version (bare `slug` 404s nothing an `ownerHandle` fixes; `@owner/slug` and
 *      `owner/slug` path/query forms answer 404 — only the bare slug plus `ownerHandle` resolves).
 *      A 200 that carries JSON instead of ZIP bytes is the registry's `public-github` handoff
 *      descriptor for GitHub-backed skills — this reader refuses it by name rather than guessing
 *      the descriptor's shape.
 *
 * Errors are plain text (`404 Skill not found`) or a JSON body behind `409` (`AMBIGUOUS_SKILL_SLUG`
 * with a `matches[]` listing the owning handles) — both mapped to the shared failure vocabulary.
 * Anonymous reads are limited to 3000/min per IP with `Retry-After` on 429 — the widest budget of
 * any source this market reads — and every read still goes through the shared retry policy, because
 * the registry's CDN drops bursts from this environment (`000` on roughly one probe in three).
 *
 * Deliberately NOT folded into `MarketItem.stars`: ClawHub's own `stats.stars` and download/install
 * counts. `MarketItem.stars` is a GitHub star count one unit per field (`harness/common/stars.ts` resolves
 * it from a repository, and these rows have none), so printing ClawHub's own rating under it would
 * relabel one number as another — a registry rating is not a GitHub star. They travel
 * in their OWN field (`MarketItem.registryStats` / `MarketDetail.registryStats`) instead, where the
 * console labels them with the source's name.
 */

import zlib from 'node:zlib';
import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from '../net.js';
import { cache, CACHE_TTL_MS, registerBrowseCache, registerBrowseView } from '../common/market.js';
import { catalogRegistry } from '../common/catalog-registry.js';
import type { BrowseResult, MarketItem } from '../common/market.js';
import type { HarnessSourceView } from '../types.js';

const SITE = 'https://clawhub.ai';

/** Largest console page this adapter forwards (upstream honors at least 100; the market asks ≤ 50). */
export const CLAWHUB_PAGE_MAX = 50;

/**
 * The limit one search request carries. The endpoint ignores every paging parameter, so this is the
 * whole reach of one query — the console slices the answer locally and reports it as a window.
 */
export const CLAWHUB_SEARCH_LIMIT = 200;

/** Deepest console page the cursor walk will serve (40 × 50 rows) — same bound as the MCP registry
 *  walk: a cursor API has no offset, so page N costs N reads, and past this depth the answer is a
 *  typed refusal rather than a silent clamp onto the last page. */
export const CLAWHUB_WALK_MAX = 40;

/** Payload caps, identical to the GitHub skill adapter's — enforced before any disk write. */
export const CLAWHUB_MAX_FILES = 200;
export const CLAWHUB_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The registry's OWN popularity counters for one skill.
 *
 * A separate shape on purpose: `MarketItem.stars` means a GitHub star count (one unit per field, the
 * same rule that keeps a registry rating out of it), and ClawHub's star is a different unit
 * from a different system. Carried WITH the source's name attached, so the console can label it
 * instead of relabelling one number as another (ADR-0015 §D6).
 */
export interface ClawHubStats {
  stars: number | null;
  downloads: number | null;
  installs: number | null;
}

/** One skill row normalized out of a catalog or search answer — the vendor JSON stops here. */
export interface ClawHubEntry {
  /** Publisher handle — the identity's first half (`<ownerHandle>/<slug>`). */
  ownerHandle: string;
  /** Registry slug — the identity's second half, and the install name. */
  slug: string;
  /** Display name (vendor spelling). */
  name: string;
  summary: string | null;
  topics: string[];
  /** Row timestamp in ms epoch, when the answer carries one; `null` otherwise (never "today"). */
  updatedAtMs: number | null;
  /** The registry's own star/download/install tally, when the answer carries one. */
  stats: ClawHubStats | null;
}

/** `ownerHandle`/`slug` are the identity; a row missing either has no installable identity at all. */
const OWNER = /^[\w.-]+$/;
const SLUG = /^[\w.-]+$/;

/** A counter, or `null` — never a guess, never `0` for a count the answer did not state. */
const countOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The vendor's `stats` object → the three counters this market shows, or `null` when absent. */
function toStats(raw: unknown): ClawHubStats | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const stats = {
    stars: countOrNull(row.stars),
    downloads: countOrNull(row.downloads),
    installs: countOrNull(row.installs),
  };
  return stats.stars === null && stats.downloads === null && stats.installs === null ? null : stats;
}

function toEntry(
  ownerHandle: unknown,
  slug: unknown,
  name: unknown,
  summary: unknown,
  topics: unknown,
  updatedAtMs: unknown,
  stats: unknown
): ClawHubEntry | null {
  if (typeof ownerHandle !== 'string' || typeof slug !== 'string') return null;
  if (!OWNER.test(ownerHandle) || !SLUG.test(slug)) return null;
  return {
    ownerHandle,
    slug,
    name: typeof name === 'string' && name.trim() ? name.trim() : slug,
    summary: typeof summary === 'string' && summary.trim() ? summary.trim() : null,
    topics: Array.isArray(topics) ? topics.filter((t): t is string => typeof t === 'string') : [],
    updatedAtMs: typeof updatedAtMs === 'number' && Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    stats: toStats(stats),
  };
}

/** One JSON read with the shared retry policy and the failure vocabulary every adapter answers with. */
async function readJson(
  url: string,
  label: string,
  fetchImpl: typeof fetch
): Promise<{ ok: true; body: unknown } | { ok: false; code: 'unavailable' | 'upstream'; reason: FailureReason; reasonParams?: Record<string, string>; message: string }> {
  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' } },
      undefined,
      { fetchImpl }
    );
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure(label, e) };
  }
  if (res.status === 429 || res.status >= 500) {
    return {
      ok: false,
      code: 'unavailable',
      reason: 'unavailable',
      message: `${label} returned HTTP ${res.status} — try again later`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: String(res.status) },
      message: `${label} returned HTTP ${res.status}`,
    };
  }
  try {
    return { ok: true, body: JSON.parse(await res.text()) };
  } catch (e) {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: describeFetchFailure(label, e) };
  }
}

/** One catalog page → normalized entries, in the registry's own order (its ranking). */
export async function fetchClawHubCatalogPage(
  sort: string,
  limit: number,
  cursor: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<
  | { ok: true; entries: ClawHubEntry[]; next: string | null }
  | { ok: false; code: 'unavailable' | 'upstream'; reason?: FailureReason; reasonParams?: Record<string, string>; message: string }
> {
  const params = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), CLAWHUB_PAGE_MAX)), sort });
  if (cursor) params.set('cursor', cursor);
  const read = await readJson(`${SITE}/api/v1/skills?${params.toString()}`, 'ClawHub catalog', fetchImpl);
  if (!read.ok) return read;
  const body = read.body as { items?: unknown; nextCursor?: unknown } | null;
  if (!Array.isArray(body?.items)) {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'ClawHub catalog answered no `items` array — the endpoint changed shape' };
  }
  const entries = body.items
    .map((row) => {
      const r = row as Record<string, unknown>;
      return toEntry(r.ownerHandle, r.slug, r.displayName, r.summary, r.topics, r.updatedAt, r.stats);
    })
    .filter((entry): entry is ClawHubEntry => entry !== null);
  return { ok: true, entries, next: typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null };
}

/** One whole-catalog search answer → normalized entries, in the registry's relevance order. */
export async function fetchClawHubSearch(
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<
  | { ok: true; entries: ClawHubEntry[] }
  | { ok: false; code: 'unavailable' | 'upstream'; reason?: FailureReason; reasonParams?: Record<string, string>; message: string }
> {
  const params = new URLSearchParams({ q: query, limit: String(CLAWHUB_SEARCH_LIMIT) });
  const read = await readJson(`${SITE}/api/v1/search?${params.toString()}`, 'ClawHub search', fetchImpl);
  if (!read.ok) return read;
  const body = read.body as { results?: unknown } | null;
  if (!Array.isArray(body?.results)) {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'ClawHub search answered no `results` array — the endpoint changed shape' };
  }
  const entries = body.results
    .map((row) => {
      const r = row as Record<string, unknown>;
      const native = (r.native ?? {}) as Record<string, unknown>;
      const skill = (native.skill ?? {}) as Record<string, unknown>;
      const metrics = (r.metrics ?? {}) as Record<string, unknown>;
      return toEntry(r.ownerHandle, r.slug, r.displayName, r.summary, skill.topics, metrics.updatedAt, skill.stats);
    })
    .filter((entry): entry is ClawHubEntry => entry !== null);
  return { ok: true, entries };
}

/** The newest published version of one (owner, slug), or `null` when the registry lists none. */
export async function fetchClawHubLatestVersion(
  slug: string,
  ownerHandle: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; version: string | null } | { ok: false; code: 'unavailable' | 'upstream'; reason?: FailureReason; reasonParams?: Record<string, string>; message: string }> {
  const params = new URLSearchParams({ limit: '1', ownerHandle });
  const read = await readJson(`${SITE}/api/v1/skills/${encodeURIComponent(slug)}/versions?${params.toString()}`, 'ClawHub versions', fetchImpl);
  if (!read.ok) return read;
  const body = read.body as { items?: unknown } | null;
  const items = Array.isArray(body?.items) ? body.items : [];
  const first = items[0] as { version?: unknown } | undefined;
  return { ok: true, version: typeof first?.version === 'string' && first.version ? first.version : null };
}

/** The long-form half of one skill, normalized out of the registry's per-skill record. */
export interface ClawHubSkillDetail {
  slug: string;
  ownerHandle: string;
  name: string;
  summary: string | null;
  /** The published `SKILL.md` body with its YAML frontmatter removed — what a dialog renders.
   *  `null` when the record publishes no text at all (the row keeps its summary). */
  body: string | null;
  topics: string[];
  version: string | null;
  license: string | null;
  /** ms epoch, or `null` when the record carries none (never "today"). */
  publishedAtMs: number | null;
  updatedAtMs: number | null;
  /** The registry's own star/download/install tally (ClawHub's own unit, labelled as such). */
  stats: ClawHubStats | null;
}

export type ClawHubSkillRead =
  | { ok: true; detail: ClawHubSkillDetail }
  | {
      ok: false;
      code: 'no_artifact' | 'unavailable' | 'upstream';
      reason?: FailureReason;
      reasonParams?: Record<string, string>;
      message: string;
    };

/**
 * Strip a leading YAML frontmatter block (`---` … `---`) from a published `SKILL.md`.
 *
 * The registry stores the file VERBATIM, so the body a dialog renders would otherwise open with an
 * `---` rule and a wall of `key: value` lines the operator did not ask for. Only a block that
 * actually opens the document is removed — a horizontal rule further down is content.
 */
export function stripFrontmatter(text: string): string {
  const body = text.replace(/\r\n/g, '\n');
  if (!body.startsWith('---\n')) return body;
  const end = body.indexOf('\n---', 3);
  if (end < 0) return body;
  // The closing delimiter's own newline, plus the blank line authors put after it, are part of the
  // header block — the body starts at the first line that carries text.
  return body.slice(end + 4).replace(/^\n+/, '');
}

const msOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/**
 * Read ONE skill's own record (`GET /api/v1/skills/<slug>?ownerHandle=`).
 *
 * The identity is the pair the row already carries (`ownerHandle` + `slug`), and the answer is
 * checked against it: the registry's per-slug endpoint resolves a slug to ONE publisher, so a record
 * whose `owner.handle` is not the owner we asked for is not this row's skill — it is refused rather
 * than rendered under the wrong name.
 */
export async function fetchClawHubSkill(
  slug: string,
  ownerHandle: string,
  fetchImpl: typeof fetch = fetch
): Promise<ClawHubSkillRead> {
  const params = new URLSearchParams({ ownerHandle });
  const read = await readJson(
    `${SITE}/api/v1/skills/${encodeURIComponent(slug)}?${params.toString()}`,
    'ClawHub skill',
    fetchImpl
  );
  if (!read.ok) {
    if (read.reason === 'http' && read.reasonParams?.status === '404') {
      return {
        ok: false,
        code: 'no_artifact',
        reason: 'http',
        reasonParams: { status: '404' },
        message: `ClawHub lists no skill '${ownerHandle}/${slug}'`,
      };
    }
    return read;
  }

  const body = read.body as {
    skill?: Record<string, unknown>;
    latestVersion?: Record<string, unknown>;
    owner?: Record<string, unknown>;
  } | null;
  const skill = body?.skill;
  if (!skill || typeof skill.slug !== 'string') {
    return {
      ok: false,
      code: 'upstream',
      reason: 'badPayload',
      message: 'ClawHub skill answered no `skill` record — the endpoint changed shape',
    };
  }
  const answeredOwner = typeof body?.owner?.handle === 'string' ? body.owner.handle : null;
  if (answeredOwner && answeredOwner.toLowerCase() !== ownerHandle.toLowerCase()) {
    return {
      ok: false,
      code: 'no_artifact',
      message: `ClawHub resolved '${slug}' to '${answeredOwner}', not '${ownerHandle}'`,
    };
  }

  const latest = body?.latestVersion ?? {};
  const tags = (skill.tags ?? {}) as Record<string, unknown>;
  const description = typeof skill.description === 'string' ? stripFrontmatter(skill.description).trim() : '';
  return {
    ok: true,
    detail: {
      slug,
      ownerHandle,
      name: textOrNull(skill.displayName) ?? slug,
      summary: textOrNull(skill.summary),
      body: description === '' ? null : description,
      topics: Array.isArray(skill.topics) ? skill.topics.filter((t): t is string => typeof t === 'string') : [],
      version: textOrNull(latest.version) ?? textOrNull(tags.latest),
      license: textOrNull(latest.license),
      publishedAtMs: msOrNull(latest.createdAt),
      updatedAtMs: msOrNull(skill.updatedAt),
      stats: toStats(skill.stats),
    },
  };
}

export type ClawHubDownload =
  | { ok: true; zip: Buffer }
  | {
      ok: false;
      code: 'no_artifact' | 'ambiguous' | 'too_large' | 'unavailable' | 'upstream';
      reason?: FailureReason;
      reasonParams?: Record<string, string>;
      message: string;
      candidates?: string[];
    };

/**
 * Download one pinned version's ZIP (`GET /api/v1/download?slug=&ownerHandle=&version=`).
 *
 * The bytes are the install payload, so the caps here guard MEMORY the way the GitHub adapter's
 * guard the tarball: a declared length past the cap is refused before buffering. A 200 that answers
 * JSON instead of ZIP is the registry's `public-github` handoff for GitHub-backed skills — its shape
 * is undocumented, so the reader refuses it by name instead of guessing.
 */
export async function downloadClawHubZip(
  slug: string,
  ownerHandle: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  sleep?: (ms: number) => Promise<void>
): Promise<ClawHubDownload> {
  const params = new URLSearchParams({ slug, ownerHandle, version });
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${SITE}/api/v1/download?${params.toString()}`,
      { headers: { Accept: 'application/zip, application/json', 'User-Agent': 'omnicellrouter-harness' } },
      undefined,
      // `sleep` is net.ts's own test seam: a fixture answering 404/409 must not spend the market
      // policy's real backoff to prove a status mapping.
      sleep ? { fetchImpl, sleep } : { fetchImpl }
    );
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('ClawHub download', e) };
  }
  if (res.status === 404) {
    return { ok: false, code: 'no_artifact', message: `ClawHub lists no skill '${ownerHandle}/${slug}'` };
  }
  if (res.status === 409) {
    const text = await res.text().catch(() => '');
    let candidates: string[] = [];
    try {
      const body = JSON.parse(text) as { matches?: { ownerHandle?: unknown; slug?: unknown }[] };
      candidates = (body.matches ?? [])
        .map((m) => (typeof m.ownerHandle === 'string' && typeof m.slug === 'string' ? `${m.ownerHandle}/${m.slug}` : ''))
        .filter((ref) => ref !== '');
    } catch {
      // A plain-text 409 still means "several publishers use this slug" — report it without candidates.
    }
    return {
      ok: false,
      code: 'ambiguous',
      message: `slug '${slug}' is published by several owners — pick one`,
      ...(candidates.length > 0 ? { candidates } : {}),
    };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, code: 'unavailable', reason: 'unavailable', message: `ClawHub download returned HTTP ${res.status} — try again later` };
  }
  if (!res.ok) {
    return { ok: false, code: 'upstream', reason: 'http', reasonParams: { status: String(res.status) }, message: `ClawHub download returned HTTP ${res.status}` };
  }
  const declaredLength = Number(res.headers.get('content-length') ?? 0);
  if (declaredLength > CLAWHUB_MAX_BYTES) {
    return { ok: false, code: 'too_large', message: `${Math.round(declaredLength / 1024 / 1024)} MiB archive exceeds the 8 MiB cap` };
  }
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const archive = Buffer.from(await res.arrayBuffer());
  if (archive.length > CLAWHUB_MAX_BYTES) {
    return { ok: false, code: 'too_large', message: `${Math.round(archive.length / 1024 / 1024)} MiB archive exceeds the 8 MiB cap` };
  }
  if (type.includes('json')) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'badPayload',
      message: 'registry answered a public-github handoff descriptor — this skill is GitHub-backed; install it through the GitHub source',
    };
  }
  if (!type.includes('zip') && archive.subarray(0, 2).toString('latin1') !== 'PK') {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'ClawHub download answered neither ZIP bytes nor a known descriptor' };
  }
  return { ok: true, zip: archive };
}

export interface ZipEntry {
  path: string;
  data: Buffer;
}

/**
 * A payload that passed the compressed-size check but breaks a cap once expanded (file count or
 * expanded bytes). Distinct from a corrupt archive so the caller can answer `too_large` — "this
 * artifact is too big" and "this archive is broken" are different facts to the user.
 */
export class ZipTooLargeError extends Error {}

/**
 * Minimal ZIP reader for ClawHub's skill archives — the counterpart of the GitHub adapter's tar
 * reader: 32-bit ZIP only (stored + deflate), no Zip64, no encryption, no data descriptors, and no
 * CRC verification. The trust posture is the one ADR-0015 already states for third-party content —
 * files are DATA written under caps (200 files / 8 MiB, enforced by the caller) and never executed —
 * and an integrity check would not change it; the manifest's content hash is computed over what
 * actually landed, which is what "is this copy still ours?" answers from.
 *
 * Central-directory driven (one pass, no per-entry scans): EOCD is searched from the tail, each
 * central record names its entry, and the DATA offset comes from the LOCAL header's own name/extra
 * lengths — the central copy may disagree with it.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  let eocd = -1;
  const minEocd = Math.max(0, buffer.length - 22 - 65_536);
  for (let i = buffer.length - 22; i >= minEocd; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
  // Both caps are enforced HERE, before any decompression: the entry count is known from the EOCD,
  // and the expanded-byte budget bounds every `inflateRawSync` call (a deflate stream can expand
  // ~1000:1, so a compressed-size check alone is not a memory bound).
  if (count > CLAWHUB_MAX_FILES) throw new ZipTooLargeError(`${count} entries exceeds the ${CLAWHUB_MAX_FILES}-file cap`);
  const out: ZipEntry[] = [];
  let expanded = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 0x0001) throw new Error(`encrypted entry '${name}' is not supported`);
    if (method !== 0 && method !== 8) throw new Error(`entry '${name}' uses an unsupported compression method (${method})`);
    if (compSize === 0xffffffff) throw new Error('zip64 archives are not supported');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`corrupt local header for '${name}'`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buffer.length) throw new Error(`truncated entry '${name}'`);
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    const room = CLAWHUB_MAX_BYTES - expanded;
    if (room <= 0) throw new ZipTooLargeError(`expanded archive exceeds the ${CLAWHUB_MAX_BYTES}-byte cap`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: room });
      } catch (e) {
        // `ERR_BUFFER_TOO_LARGE` is the cap doing its job; anything else is a broken stream.
        if ((e as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') throw e;
        throw new ZipTooLargeError(`expanded archive exceeds the ${CLAWHUB_MAX_BYTES}-byte cap`);
      }
    }
    if (data.length > room) throw new ZipTooLargeError(`expanded archive exceeds the ${CLAWHUB_MAX_BYTES}-byte cap`);
    expanded += data.length;
    out.push({ path: name, data });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ClawHub market (browse + source view)
// ---------------------------------------------------------------------------

/** ClawHub pages and cursor chains — a cursor API has no offset, so page N is only reachable by
 *  walking N-1 recorded cursors. */
const clawhubPages = new Map<string, { at: number; items: MarketItem[]; next: string | null }>();
const clawhubCursors = new Map<string, { at: number; cursors: string[] }>();

/** Drop ClawHub's own two cache families (row pages and the cursor chain that reaches them). */
export function evictClawHubCache(): void {
  clawhubPages.clear();
  clawhubCursors.clear();
}

function toClawHubItem(entry: ClawHubEntry): MarketItem {
  return {
    id: `clawhub:${entry.ownerHandle}/${entry.slug}`,
    sourceId: 'clawhub',
    key: `clawhub:${entry.ownerHandle}/${entry.slug}`,
    installKind: 'skill',
    name: entry.name,
    description: entry.summary,
    // The registry's usage terms ask third-party directories to link the canonical page, which is
    // also where the operator can read the skill's own record before installing it.
    url: `https://clawhub.ai/${entry.ownerHandle}/skills/${entry.slug}`,
    stars: null,
    ...(entry.stats ? { registryStats: entry.stats } : {}),
    updatedAt: entry.updatedAtMs !== null ? new Date(entry.updatedAtMs).toISOString() : '',
    topics: entry.topics,
  };
}

/** One catalog page as market rows, cached by its own upstream index so a page costs one read. */
async function clawhubCatalogPage(
  sort: string,
  size: number,
  index: number,
  cursor: string
): Promise<{ ok: true; items: MarketItem[]; next: string | null } | { ok: false; code: 'upstream' | 'unavailable'; reason?: FailureReason; reasonParams?: Record<string, string>; message: string }> {
  const cacheKey = `clawhub|${sort}|${size}|${index}`;
  const hit = clawhubPages.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, items: hit.items, next: hit.next };
  const read = await fetchClawHubCatalogPage(sort, size, cursor || null);
  if (!read.ok) return read;
  const items = read.entries.map(toClawHubItem);
  clawhubPages.set(cacheKey, { at: Date.now(), items, next: read.next });
  return { ok: true, items, next: read.next };
}

/**
 * ClawHub (source `clawhub`) — the browse half of this module.
 *
 * TWO reads, and which one answers depends on the query:
 *  - an EMPTY query is answered from the catalog endpoint (`/api/v1/skills`), cursor-paged, so a
 *    console page walks the recorded cursor chain — page N costs N reads once, then the chain
 *    remembers them, and a page past the walk limit is a typed refusal. The registry publishes no
 *    count for the listing, so the console shows the page number without inventing a total.
 *  - a typed query goes to `/api/v1/search`, which has NO paging parameter: one answer is the whole
 *    reach of the query (`totalScope: 'window'`), sliced locally.
 *  - Every row installs from ClawHub's own versioned store (`clawhub:<owner>/<slug>`): the registry
 *    pins by version, not by commit, so no repo is claimed and `stars` stays `null` — the registry's
 *    own star/download/install tally travels in `registryStats` instead, where the console can label
 *    it as ClawHub's own, never under the star column.
 */
export async function browseClawHub(query: string, limit = 24, page = 1, sort = 'downloads'): Promise<BrowseResult> {
  const q = query.trim();
  const size = Math.min(Math.max(limit, 1), 50);
  const at = Math.max(page, 1);

  if (q) {
    const cacheKey = `clawhub|q|${q.toLowerCase()}`;
    let rows: MarketItem[];
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      rows = hit.items;
    } else {
      const read = await fetchClawHubSearch(q);
      if (!read.ok) return read;
      rows = read.entries.map(toClawHubItem);
      cache.set(cacheKey, { at: Date.now(), items: rows });
    }
    const offset = (at - 1) * size;
    const items = rows.slice(offset, offset + size);
    // The search endpoint ignores every paging parameter, so its answer count is a WINDOW: the pager
    // keeps the number for its page buttons but the summary stays hidden (`totalScope`).
    return {
      ok: true,
      items,
      hasMore: offset + items.length < rows.length,
      total: rows.length,
      totalScope: 'window',
      note: `full-catalog ClawHub search — at most ${CLAWHUB_SEARCH_LIMIT} matches per query (the endpoint has no paging)`,
      noteCode: 'clawhub-search',
      noteParams: { n: String(CLAWHUB_SEARCH_LIMIT) },
    };
  }

  // The catalog walk: extend the (sort, size) chain in place so later pages are one read each.
  if (at > CLAWHUB_WALK_MAX) {
    return {
      ok: false,
      code: 'unavailable',
      reason: 'unavailable',
      message: `page ${at} is past the ${CLAWHUB_WALK_MAX}-page cursor walk limit`,
    };
  }
  const chainKey = `clawhub|cursors|${sort}|${size}`;
  let chain = clawhubCursors.get(chainKey);
  if (!chain || Date.now() - chain.at >= CACHE_TTL_MS) {
    chain = { at: Date.now(), cursors: [''] };
    clawhubCursors.set(chainKey, chain);
  }
  while (chain.cursors.length - 1 < at - 1) {
    const prev = await clawhubCatalogPage(sort, size, chain.cursors.length - 1, chain.cursors[chain.cursors.length - 1]!);
    if (!prev.ok) return prev;
    if (prev.next === null) break;
    chain.cursors.push(prev.next);
  }
  const index = at - 1;
  const beyond = index > chain.cursors.length - 1;
  const read = beyond ? null : await clawhubCatalogPage(sort, size, index, chain.cursors[index]!);
  if (read && !read.ok) return read;
  return {
    ok: true,
    items: read?.items ?? [],
    hasMore: read !== null && read.next !== null,
    note: 'ClawHub community registry — rows install from the registry\u2019s own store, pinned to a version',
    noteCode: 'clawhub-catalog',
  };
}

/** The ClawHub chip (ADR-0015 §D10): the ONLY skill-axis directory by owner decision — a curated
 *  registry, not a wide-net search. Rows carry no GitHub repo, so no star count is ever claimed. */
export const CLAWHUB_VIEW: HarnessSourceView = {
  id: 'clawhub',
  // Its OWN built-in catalog, not the unnamed 'default' bucket: the skill market groups rows by
  // where they come from, and ClawHub is a directory, so the console's catalog picker names it.
  catalog: 'ClawHub',
  label: 'ClawHub',
  kinds: ['skill'],
  trust: 'community',
  auth: 'none',
  enabled: true,
  browsable: true,
  sorts: ['downloads', 'stars', 'updated'],
  browse: browseClawHub,
};

registerBrowseCache('clawhub', evictClawHubCache);

registerBrowseView(CLAWHUB_VIEW);

catalogRegistry.register({
  id: 'clawhub',
  catalog: 'ClawHub',
  label: 'ClawHub',
  kinds: ['skill'],
  trust: 'community',
  builtin: true,
  sorts: ['downloads', 'stars', 'updated'],
  browse: browseClawHub,
});
