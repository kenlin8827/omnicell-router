import type { SourceAdapter, ResolveOptions, ResolveOutcome } from '../../spi.js';
import { describeFetchFailure } from '../../net.js';
import { mcpServerNameFromPackage } from '../mcp-entry.js';

/**
 * PyPI registry adapter (ADR-0015 §8 amendment) — the Python MCP install path.
 *
 * PyPI is authoritative for the package's existence, its canonical name and the concrete version it
 * serves; it is NOT authoritative for whether the package is an MCP server — that is the operator's
 * selection, and the install never claims otherwise. The adapter therefore resolves `mcp` only: a
 * Python package has no plugin/skill payload this house can lay down.
 *
 * Reference grammar: `name` or `name==version` (PEP 440 pin). A name is resolved to the version the
 * registry serves at probe time and the LAUNCH carries that exact pin, so the spawned command cannot
 * drift to a later release without a fresh resolve. `uvx` is the launcher (ADR-0015 §8), the Python
 * twin of `npx -y`.
 */

const REGISTRY = 'https://pypi.org';
const TIMEOUT_MS = 30_000;

function headers(): Record<string, string> {
  return { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' };
}

interface ProjectDoc {
  info?: { name?: string; version?: string; summary?: string | null };
}

type Fetched<T> = { ok: true; body: T } | { ok: false; code: 'no_artifact' | 'unavailable' | 'upstream'; message: string };

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, what: string): Promise<Fetched<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, code: 'upstream', message: describeFetchFailure(`PyPI registry for ${what}`, e) };
  }
  if (res.status === 404) return { ok: false, code: 'no_artifact', message: `${what} is not in the registry` };
  // 429 = throttled, 5xx = registry trouble: both are "try later", never "no such package".
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, code: 'unavailable', message: `${what}: registry returned HTTP ${res.status}` };
  }
  if (!res.ok) return { ok: false, code: 'upstream', message: `${what}: registry returned HTTP ${res.status}` };
  try {
    return { ok: true, body: (await res.json()) as T };
  } catch {
    return { ok: false, code: 'upstream', message: `${what}: registry returned non-JSON content` };
  }
}

/** PEP 440 release segment as a URL path: anything else (`>=1`, `1.*`, a range) names no exact
 *  release, so the registry would answer a 404 that says nothing true about the package. */
const PEP440 = /^\d+(?:\.\d+)*(?:[._-]?(?:a|b|rc|post|dev)\d+)?(?:\+[0-9A-Za-z.]+)?$/i;

export const pypiAdapter: SourceAdapter = {
  id: 'pypi',
  kinds: ['mcp'],
  trust: 'community',

  async resolve(ref: string, kind: 'skill' | 'mcp' | 'plugin', opts: ResolveOptions = {}): Promise<ResolveOutcome> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    if (kind !== 'mcp') {
      return {
        ok: false,
        code: 'unsupported_kind',
        message: `source 'pypi' resolves mcp packages (kind '${kind}' has no Python payload reader)`,
      };
    }
    const raw = ref.trim();
    const pinAt = raw.indexOf('==');
    const name = (pinAt === -1 ? raw : raw.slice(0, pinAt)).trim();
    const requestedVersion = pinAt === -1 ? null : raw.slice(pinAt + 2).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || (requestedVersion !== null && requestedVersion === '')) {
      return { ok: false, code: 'no_artifact', message: `invalid PyPI reference '${ref}'` };
    }
    if (requestedVersion !== null && !PEP440.test(requestedVersion)) {
      return {
        ok: false,
        code: 'no_artifact',
        message: `'${name}' can only pin an exact release (a range must be resolved to a version first)`,
      };
    }

    const url =
      requestedVersion === null
        ? `${REGISTRY}/pypi/${encodeURIComponent(name)}/json`
        : `${REGISTRY}/pypi/${encodeURIComponent(name)}/${encodeURIComponent(requestedVersion)}/json`;
    const doc = await fetchJson<ProjectDoc>(fetchImpl, url, `package '${requestedVersion === null ? name : `${name}==${requestedVersion}`}'`);
    if (!doc.ok) return doc;
    const info = doc.body.info ?? {};
    const version = info.version ?? requestedVersion;
    if (!version) return { ok: false, code: 'no_artifact', message: `package '${name}' publishes no version` };
    const canonical = info.name ?? name;
    // The server KEY is the host config's entry key: a PyPI name may carry dots, which pi refuses,
    // so it is derived with the intersection grammar. The canonical package name stays in
    // `canonicalKey`, and the launch keeps the real requirement spec.
    const serverName = mcpServerNameFromPackage(canonical);
    // uvx takes the PEP 440 pin as one argument: `name==version` is the requirement spec the
    // resolver guarantees is installed, exactly like npm's `name@version`.
    return {
      ok: true,
      canonicalKey: `pypi:${canonical}`,
      name: serverName,
      description: info.summary?.trim() || null,
      payload: { kind: 'mcp', name: serverName, launch: { command: 'uvx', args: [`${canonical}==${version}`] } },
      pin: { pypi: { version } },
    };
  },
};
