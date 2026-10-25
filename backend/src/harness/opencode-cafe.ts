/**
 * opencode.cafe registry — a community catalog served by a Convex deployment.
 *
 * The site is a Next.js app whose data lives in Convex; the catalog query is ANONYMOUS and readable
 * (`extensions:listAllApproved`, no auth check in the upstream function). The deployment URL is the
 * one the site's own client bundle ships, so this is an undocumented contract, not a published API —
 * if the operator re-provisions the deployment or renames the function, this source answers
 * `upstream` and the console says so instead of pretending the catalog is empty.
 *
 * PRIVACY: the public query returns `author.email` for every row. This module deliberately maps each
 * row onto a narrow shape that has no field for it — the address never reaches the market, the
 * manifest or a log line.
 *
 * Caching: none here. Browsing caches the answered list in `browse.ts`; an install reads once.
 */

import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from './net.js';

const QUERY_URL = 'https://curious-quail-727.convex.cloud/api/query';

/** A catalog row, narrowed to the fields this build reads (and to no field it must not). */
export interface CafeEntry {
  productId?: string;
  type?: string;
  displayName?: string;
  description?: string;
  repoUrl?: string;
  homepageUrl?: string;
  tags?: string[];
  /** Free-form markdown install instructions; usually names the package. */
  installation?: string;
}

export type CafeRegistryResult =
  | { ok: true; entries: CafeEntry[] }
  | { ok: false; code: 'unavailable' | 'upstream'; reason: FailureReason; reasonParams?: Record<string, string>; message: string };

/**
 * Copy a row onto the narrow shape. Written as an explicit field pick (not a spread) so a field the
 * upstream adds later — a credential, an e-mail, an internal id — can never travel by accident.
 */
function narrow(row: Record<string, unknown>): CafeEntry {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  return {
    ...(str(row.productId) ? { productId: str(row.productId)! } : {}),
    ...(str(row.type) ? { type: str(row.type)! } : {}),
    ...(str(row.displayName) ? { displayName: str(row.displayName)! } : {}),
    ...(str(row.description) ? { description: str(row.description)! } : {}),
    ...(str(row.repoUrl) ? { repoUrl: str(row.repoUrl)!.trim() } : {}),
    ...(str(row.homepageUrl) ? { homepageUrl: str(row.homepageUrl)! } : {}),
    ...(str(row.installation) ? { installation: str(row.installation)! } : {}),
    ...(Array.isArray(row.tags)
      ? { tags: (row.tags as unknown[]).filter((t): t is string => typeof t === 'string') }
      : {}),
  };
}

/** Read the approved catalog. */
export async function fetchCafeExtensions(fetchImpl: typeof fetch = fetch): Promise<CafeRegistryResult> {
  let res: Response;
  try {
    // A Convex POST query is idempotent (a read), so a transient 5xx/reset is asked again under the
    // shared policy; a 429/4xx is returned untouched and mapped below.
    res = await fetchWithRetry(
      QUERY_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'omnicellrouter-harness',
        },
        body: JSON.stringify({ path: 'extensions:listAllApproved', args: {}, format: 'json' }),
      },
      undefined,
      { fetchImpl }
    );
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure('opencode.cafe', e) };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, code: 'unavailable', reason: 'unavailable', message: `opencode.cafe returned HTTP ${res.status} — try again later` };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: String(res.status) },
      message: `opencode.cafe returned HTTP ${res.status}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'opencode.cafe answered non-JSON content' };
  }
  const envelope = body as { status?: unknown; value?: unknown };
  if (envelope.status !== 'success' || !Array.isArray(envelope.value)) {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'opencode.cafe answered an unexpected payload shape' };
  }
  return {
    ok: true,
    entries: (envelope.value as unknown[])
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map(narrow),
  };
}
