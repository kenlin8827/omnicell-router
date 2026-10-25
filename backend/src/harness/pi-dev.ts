/**
 * pi.dev package catalog reader — the OFFICIAL Pi source.
 *
 * `pi.dev/packages` is Pi's own catalog of npm packages: extensions, skills, prompt templates and
 * themes, each printed with the exact command that installs it (`pi install npm:<pkg>`). It publishes
 * no JSON API — the page is SERVER-RENDERED — so this reader keys off the machine-readable attributes
 * the catalog's own filter/sort script already consumes (`data-package-card`, `data-package-name`,
 * `data-package-types`, `data-package-date`, `data-package-path`, `data-package-downloads`) plus the
 * printed `pi install npm:` command.
 *
 * Those attributes are an UNMEASURED-BY-CONTRACT surface: measured 2026-10-25, documented nowhere. So
 * the reader fails LOUD: a page that carries neither package cards nor the result-count marker, or
 * cards that yield no usable row, answers `upstream` rather than an empty list — "no packages" and
 * "the markup moved" are different claims and the market must not confuse them.
 *
 * `data-package-downloads` is the catalog's own ordering key and is deliberately NOT mapped onto a
 * market row: the market's popularity field is GitHub stars (left `null` here, and resolvable on
 * demand from the row's repo by `harness/stars.ts`), and printing a download count under it
 * would relabel one number as another. Ordering still follows the official ranking, because the
 * request asks for `sort=downloads`.
 *
 * PAGING is the catalog's own: 50 cards per page, `&page=<n>` (measured 2026-10-25; `p`/`offset` are
 * ignored), so walking the catalog means walking ITS pages. The count marker above the grid
 * (`1-50 / 286 (of 5338)`) answers both questions the caller needs — how many rows match, and whether
 * a successor page exists — without asking for a page that would come back empty.
 */

import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from './net.js';

const CATALOG_URL = 'https://pi.dev/packages';

/** Cards per server-rendered page (measured; the site ignores any page-size parameter). */
export const PI_DEV_PAGE_SIZE = 50;

export interface PiDevEntry {
  /** npm package name the catalog prints in its install command. */
  packageName: string;
  description: string | null;
  /** Catalog type chips (`extension`, `skill`, `theme`, `prompt`); empty for an untyped package. */
  types: string[];
  /** First non-issue GitHub link on the card. */
  repoUrl?: string;
  /** The catalog's own page for this package. */
  url: string;
  /** ISO publication time from the card's epoch-ms attribute; `''` when absent. */
  publishedAt: string;
}

export type PiDevRead =
  | {
      ok: true;
      entries: PiDevEntry[];
      /** Rows the catalog says match this query — the SOURCE's count, not this market's row count
       *  (callers that filter rows must not pass it on as their own total). */
      total: number | null;
      /** The catalog has a successor page for this query. */
      more: boolean;
    }
  | { ok: false; code: 'unavailable' | 'upstream'; reason: FailureReason; reasonParams?: Record<string, string>; message: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the handful of HTML entities a card can carry (descriptions are escaped upstream). */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole: string, body: string): string => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Readable prose from a card fragment.
 *
 * A description is sometimes not prose at all: the author published markdown/HTML, so the card shows
 * escaped markup (`&lt;p&gt; &lt;img …&gt;`). Decode first, then drop tags — what survives is the
 * honest text, and an image-only banner leaves nothing, which becomes `null` rather than markup soup.
 */
function plainText(fragment: string): string {
  return decodeEntities(fragment)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same grammar the npm adapter enforces: `[@scope/]name`, no shell-shaped characters. */
const PACKAGE_GRAMMAR = /^(@[\w.-]+\/)?[\w.-]+$/;

function attr(block: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(block)?.[1];
}

/**
 * Split one server-rendered catalog page into entries. Exported for tests: the fixture is a page
 * fragment, and the mapping to a market row is the caller's business.
 *
 * `cards` and `marker` let the caller tell "the page had no results" from "the page is not a catalog
 * any more" — see the fail-loud note at the top of this module.
 */
export function parsePiDevCatalog(html: string): { entries: PiDevEntry[]; cards: number; marker: boolean } {
  const marker = /class="packages-count"/.test(html);
  const blocks = html.split(/<article\b/).filter((block) => block.includes('data-package-card="true"'));
  const entries: PiDevEntry[] = [];

  for (const block of blocks) {
    const declared = attr(block, 'data-package-name');
    if (!declared) continue;
    // The printed install command is the catalog's own statement of the package it installs; the npm
    // link is the fallback and the card name the last resort (all three agree on every measured row).
    const printed = /pi install npm:([^\s<]+)/.exec(block)?.[1];
    const npmLink = /npmjs\.com\/package\/([^"\s?#]+)/.exec(block)?.[1];
    const packageName = decodeEntities(printed ?? npmLink ?? declared);
    if (!PACKAGE_GRAMMAR.test(packageName)) continue;

    const repoUrl = [...block.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g)]
      .map((m) => m[0])
      .find((url) => !/\/issues(\/|$)/.test(url));

    const dateMs = Number(attr(block, 'data-package-date'));
    const publishedAt = Number.isFinite(dateMs) && dateMs > 0 ? new Date(dateMs).toISOString() : '';
    const desc = /<p class="packages-desc">([\s\S]*?)<\/p>/.exec(block)?.[1];
    const path = attr(block, 'data-package-path');

    entries.push({
      packageName,
      description: desc === undefined ? null : plainText(desc) || null,
      types: (attr(block, 'data-package-types') ?? '').split(/\s+/).filter(Boolean),
      ...(repoUrl ? { repoUrl } : {}),
      url: path && /^\/[\w./@-]+$/.test(path) ? `https://pi.dev${path}` : `https://pi.dev/packages/${packageName}`,
      publishedAt,
    });
  }

  return { entries, cards: blocks.length, marker };
}

/**
 * The grid's count marker — `1-50 / 286 (of 5338)` — answers two questions: how many rows the query
 * matches, and whether a successor page exists. Parsing it beats "ask for page N+1 and see if it is
 * empty": that costs a request and cannot tell an exhausted catalog from a broken one.
 */
export function parsePiDevCount(html: string): { total: number | null; more: boolean } {
  const m = /class="packages-count"[^>]*>\s*(\d+)-(\d+)\s*\/\s*([\d,]+)(?:\s*\(of\s*([\d,]+)\))?/.exec(html);
  if (!m) return { total: null, more: false };
  const end = Number(m[2]);
  const total = Number(m[3]!.replace(/,/g, ''));
  if (!Number.isFinite(total)) return { total: null, more: false };
  return { total, more: Number.isFinite(end) && end < total };
}

/**
 * Read ONE catalog page. `query` is passed verbatim as the catalog's own `name` filter; `page` is the
 * catalog's own 1-based page (50 cards each). Page 1 leaves the parameter off, so the request stays
 * exactly the URL that was measured.
 */
/** The catalog's OWN order values, read from its sort control (`Most downloads` / `Recently
 *  published` / `A-Z`). Any other value is ignored by the site — measured 2026-10-25: unknown
 *  values fall back to the downloads order — so this adapter never sends one it has not seen work. */
const PI_DEV_SORTS = new Set(['downloads', 'recent', 'name']);

export async function fetchPiDevCatalog(
  query: string,
  page = 1,
  fetchImpl: typeof fetch = fetch,
  sort = 'downloads'
): Promise<PiDevRead> {
  const typed = query.trim();
  const at = Math.max(page, 1);
  const paged = at > 1 ? `&page=${at}` : '';
  const order = PI_DEV_SORTS.has(sort) ? sort : 'downloads';
  const url = `${CATALOG_URL}?sort=${order}${paged}${typed ? `&name=${encodeURIComponent(typed)}` : ''}`;
  let res: Response;
  try {
    // The CDN drops bursts from some environments, so a transient failure is asked again under the
    // shared policy; `upstream` + a reason is what a caller sees once the budget is spent.
    res = await fetchWithRetry(
      url,
      { headers: { Accept: 'text/html', 'User-Agent': 'omnicellrouter-harness' } },
      undefined,
      { fetchImpl }
    );
  } catch (e) {
    // Connection resets are measured from this environment (the CDN drops bursts): "try later", never
    // "no such package".
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('pi.dev catalog', e) };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, code: 'unavailable', reason: 'unavailable', message: `pi.dev catalog returned HTTP ${res.status} — try again later` };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: String(res.status) },
      message: `pi.dev catalog returned HTTP ${res.status}`,
    };
  }

  let html: string;
  try {
    html = await res.text();
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('pi.dev catalog', e) };
  }

  const parsed = parsePiDevCatalog(html);
  if (parsed.cards === 0 && !parsed.marker) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'markupChanged',
      message: 'pi.dev catalog markup changed — no package cards or result count',
    };
  }
  if (parsed.cards > 0 && parsed.entries.length === 0) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'markupChanged',
      message: 'pi.dev catalog markup changed — package cards carried no package name',
    };
  }
  const count = parsePiDevCount(html);
  return { ok: true, entries: parsed.entries, total: count.total, more: count.more };
}
