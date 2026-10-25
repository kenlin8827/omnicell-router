import { describeFetchFailure, fetchFailureReason, fetchWithRetry, type FailureReason } from './net.js';

/**
 * Smithery MCP registry — a HOSTING aggregator (ADR-0015 §D6).
 *
 * Measured 2026-10-25, anonymous:
 *  - `GET /servers?page=&pageSize=&q=&verified=` → 200
 *    `{ servers: [...], pagination: { currentPage, pageSize, totalPages, totalCount } }`.
 *  - `GET /servers/<qualifiedName>` → 200 with `connections[]` (`type`, `deploymentUrl`,
 *    `configSchema`) plus `tools`/`prompts`/`resources` counts.
 *  - The listing serves at most **500 rows** however it is page-sliced (pageSize 20 → 25 pages,
 *    pageSize 2 → 250 pages, page 26 → empty) while `totalCount` reports ~20 765: the console must
 *    say which number it can reach instead of promising rows the API will never return.
 *
 * Smithery's deployments live on its OWN hosting (`<slug>.run.tools`, and the equivalent
 * `server.smithery.ai/<qualifiedName>/mcp`): both were measured to answer an MCP `initialize` with
 * `401 {"error":"invalid_token","error_description":"Missing Authorization header"}`. That is why this
 * is the one aggregator whose launch spec is authoritative for itself — but arbitration with the
 * official registry still prefers the official record when one exists (§D6).
 *
 * PRIVACY/SECRETS: only config KEY NAMES are read (`configSchema.required`); no value, no token and no
 * owner identity is carried out of this module (gate 4).
 */

const SERVERS = 'https://registry.smithery.ai/servers';
/** `pageSize` ceiling this adapter forwards (the market never asks more than 50). */
const PAGE_SIZE_MAX = 100;

/** One hosted connection: where it listens, and which config KEYS it needs (never values). */
export interface SmitheryConnection {
  type?: string;
  deploymentUrl?: string;
  requiredKeys?: string[];
}

/** A listing row, narrowed to the fields this build reads. */
export interface SmitheryEntry {
  qualifiedName?: string;
  displayName?: string;
  description?: string;
  homepage?: string;
  verified?: boolean;
  useCount?: number;
  remote?: boolean;
  isDeployed?: boolean;
  createdAt?: string;
}

export interface SmitheryPage {
  servers: SmitheryEntry[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
}

/** The per-server record's install-relevant half. */
export interface SmitheryDetail {
  qualifiedName: string;
  description?: string;
  /** True when Smithery publishes a hosted deployment for this server. */
  remote: boolean;
  connections: SmitheryConnection[];
}

export type SmitheryRead<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: 'unavailable' | 'upstream';
      reason: FailureReason;
      reasonParams?: Record<string, string>;
      message: string;
    };

const HEADERS = { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' };

/** One GET under the shared market retry policy, with the status → failure mapping every reader uses. */
async function readJson(
  url: string,
  fetchImpl: typeof fetch,
  subject: string
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: 'unavailable' | 'upstream'; reason: FailureReason; reasonParams?: Record<string, string>; message: string }
> {
  let res: Response;
  try {
    res = await fetchWithRetry(url, { headers: HEADERS }, undefined, { fetchImpl });
  } catch (e) {
    return { ok: false, code: 'upstream', reason: fetchFailureReason(e), message: describeFetchFailure(subject, e) };
  }
  if (res.status === 404) {
    return { ok: false, code: 'upstream', reason: 'http', reasonParams: { status: '404' }, message: `${subject} has no such record` };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, code: 'unavailable', reason: 'unavailable', message: `${subject} returned HTTP ${res.status} — try again later` };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'upstream',
      reason: 'http',
      reasonParams: { status: String(res.status) },
      message: `${subject} returned HTTP ${res.status}`,
    };
  }
  try {
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, code: 'upstream', reason: 'badPayload', message: `${subject} answered an unexpected payload shape` };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: `${subject} answered non-JSON content` };
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Copy a listing row onto the narrow shape — an explicit field pick, never a spread. */
function narrowEntry(row: Record<string, unknown>): SmitheryEntry {
  return {
    ...(str(row.qualifiedName) ? { qualifiedName: str(row.qualifiedName)! } : {}),
    ...(str(row.displayName) ? { displayName: str(row.displayName)! } : {}),
    ...(str(row.description) ? { description: str(row.description)! } : {}),
    ...(str(row.homepage) ? { homepage: str(row.homepage)! } : {}),
    ...(typeof row.verified === 'boolean' ? { verified: row.verified } : {}),
    ...(num(row.useCount) !== undefined ? { useCount: num(row.useCount)! } : {}),
    ...(typeof row.remote === 'boolean' ? { remote: row.remote } : {}),
    ...(typeof row.isDeployed === 'boolean' ? { isDeployed: row.isDeployed } : {}),
    ...(str(row.createdAt) ? { createdAt: str(row.createdAt)! } : {}),
  };
}

/**
 * One page of the listing. `pageSize`/`page` travel verbatim so the console's page numbers are the
 * registry's own, and `q` is its full-text query (measured: `q=github` → 140 matches).
 */
export async function fetchSmitheryServers(
  opts: { q?: string; page?: number; pageSize?: number } = {},
  fetchImpl: typeof fetch = fetch
): Promise<SmitheryRead<{ page: SmitheryPage }>> {
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 24, 1), PAGE_SIZE_MAX);
  const url = new URL(SERVERS);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  const q = opts.q?.trim();
  if (q) url.searchParams.set('q', q);

  const read = await readJson(url.toString(), fetchImpl, 'Smithery');
  if (!read.ok) return read;
  const rows = read.body.servers;
  if (!Array.isArray(rows)) {
    return { ok: false, code: 'upstream', reason: 'badPayload', message: 'Smithery answered no server list' };
  }
  const pagination = (read.body.pagination ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    page: {
      servers: rows
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
        .map(narrowEntry)
        .filter((entry) => entry.qualifiedName !== undefined),
      page: num(pagination.currentPage) ?? page,
      pageSize: num(pagination.pageSize) ?? pageSize,
      totalPages: num(pagination.totalPages) ?? page,
      totalCount: num(pagination.totalCount) ?? 0,
    },
  };
}

/**
 * One server's record: its hosted connections and the config KEYS they require.
 *
 * A connection with no `deploymentUrl` (a stdio-only server Smithery knows but does not host) yields a
 * `remote: false` detail, which the adapter refuses — Smithery's local packages are its own npm
 * distribution, not an MCP launch this writer can merge.
 */
export async function fetchSmitheryServer(
  qualifiedName: string,
  fetchImpl: typeof fetch = fetch
): Promise<SmitheryRead<{ detail: SmitheryDetail }>> {
  const read = await readJson(`${SERVERS}/${encodeURIComponent(qualifiedName)}`, fetchImpl, 'Smithery');
  if (!read.ok) return read;
  const connections: SmitheryConnection[] = (Array.isArray(read.body.connections) ? read.body.connections : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => {
      const schema = (c.configSchema ?? {}) as Record<string, unknown>;
      const required = Array.isArray(schema.required)
        ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string')
        : [];
      return {
        ...(str(c.type) ? { type: str(c.type)! } : {}),
        ...(str(c.deploymentUrl) ? { deploymentUrl: str(c.deploymentUrl)! } : {}),
        ...(required.length > 0 ? { requiredKeys: [...new Set(required)].sort() } : {}),
      };
    });
  return {
    ok: true,
    detail: {
      qualifiedName: str(read.body.qualifiedName) ?? qualifiedName,
      ...(str(read.body.description) ? { description: str(read.body.description)! } : {}),
      remote: read.body.remote === true || connections.some((c) => c.deploymentUrl !== undefined),
      connections,
    },
  };
}
