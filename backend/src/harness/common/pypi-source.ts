import { describeFetchFailure } from '../net.js';

/**
 * PyPI marketplace source (ADR-0015 §D9 amendment): the operator registers ONE package, and the
 * package's own metadata is the whole listing — PyPI has no scope concept, so there is no "whole
 * namespace" form to register. Discovery is a registry read; INSTALL stays the pypi resolver
 * (`pypi:<name>`), so a row registered here and the same package browsed elsewhere share one identity.
 *
 * A project PAGE URL is accepted as the same input: pypi.org displays the normalized name the JSON
 * API answers for, so normalizing it adds no second identity — the link an operator copies is just
 * another spelling of `name`. A file/release URL names an archive, not the project, and stays invalid.
 */

const REGISTRY = 'https://pypi.org';
const TIMEOUT_MS = 30_000;

export type PypiQuery = { ok: true; name: string } | { ok: false; message: string };

/** The project name a pypi.org page URL displays, or null when the URL is not such a page. */
function nameFromUrl(value: string): string | null {
  const page = /^https?:\/\/(?:www\.)?pypi\.org\/project\/([^/?#]+)/i.exec(value);
  if (!page?.[1]) return null;
  try {
    return decodeURIComponent(page[1]);
  } catch {
    return page[1];
  }
}

/**
 * Parse the operator's input. PEP 503 normalized names are lowercase and dash-separated, but the
 * registry answers either spelling, so the name is kept as typed. Anything carrying a version
 * (`name==1.0`), an extra (`name[cli]`), or a shell character is refused: a source is one package,
 * and its version is resolved at install time, never frozen into the source's identity.
 */
export function parsePypiSource(raw: string): PypiQuery {
  const trimmed = raw.trim().replace(/^pypi:/i, '');
  const value = nameFromUrl(trimmed) ?? trimmed;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return { ok: true, name: value };
  return { ok: false, message: `invalid PyPI package name '${raw}' (one package name, no version or extra)` };
}

export interface PypiPackageRow {
  name: string;
  description: string | null;
  version: string | null;
}

export type PypiProbeOutcome = { ok: true; pkg: PypiPackageRow } | { ok: false; message: string };

interface ProjectDoc {
  info?: { name?: string; version?: string; summary?: string | null };
}

/** Read one project's metadata: existence, canonical name, latest version and its summary. */
export async function probePypiSource(query: PypiQuery, fetchImpl: typeof fetch = fetch): Promise<PypiProbeOutcome> {
  if (!query.ok) return { ok: false, message: query.message };
  const url = `${REGISTRY}/pypi/${encodeURIComponent(query.name)}/json`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, message: describeFetchFailure(`PyPI registry for '${query.name}'`, e) };
  }
  if (res.status === 404) return { ok: false, message: `'${query.name}' is not in the PyPI registry` };
  if (!res.ok) return { ok: false, message: `'${query.name}': PyPI returned HTTP ${res.status}` };
  let doc: ProjectDoc;
  try {
    doc = (await res.json()) as ProjectDoc;
  } catch {
    return { ok: false, message: `'${query.name}': PyPI returned non-JSON content` };
  }
  const info = doc.info ?? {};
  const name = info.name ?? query.name;
  return {
    ok: true,
    pkg: { name, description: info.summary?.trim() || null, version: info.version ?? null },
  };
}
