import type { SourceAdapter, ResolveOptions, ResolveOutcome } from '../../spi.js';
import { describeFetchFailure } from '../../net.js';

/**
 * npm registry adapter (ADR-0015 §8) — the plugin install path.
 *
 * The registry is authoritative for the package SPEC and its integrity hash, not for whether the
 * package is a real plugin of a given runtime: that is the harness's own business, which is why this
 * adapter declares `hosts` nowhere (any runtime with a package-manager landing may take it) and the
 * install orchestrator enforces "exactly one harness".
 *
 * Measured 2026-10-24: anonymous 200 for both the packument and a single version document.
 * Reference grammar: `[@scope/]name[@version]` — no shell-shaped characters, because the spec is
 * inserted VERBATIM into the runtime's install command by the plugin writer. The `@version`
 * segment may be a concrete version or a dist-tag; the adapter always answers a spec pinned to a
 * concrete version plus `dist.integrity`.
 *
 * `resolve` answers `plugin` (the package spec the runtime's installer consumes) and `mcp` (a
 * launch spec: the minimal non-interactive npx invocation of the pinned version — the registry
 * publishes no author runtime arguments, so none are invented). `skill` is declared in `kinds` for
 * the market chip (browse lists package-shaped skills too), but an npm skill payload needs a
 * tarball reader that does not exist yet — a typed `unsupported_kind` is honest, a half-read
 * package is not.
 */

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 30_000;

/** Registry path segment: scoped names keep the `@`, the scope separator is percent-encoded. */
function registryPath(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : name;
}

interface VersionDoc {
  name?: string;
  version?: string;
  description?: string;
  dist?: { integrity?: string };
}

interface Packument {
  name?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, VersionDoc>;
}

/**
 * A CONCRETE version the registry serves at `/pkg/<version>`. Anything else a spec may carry — a
 * dist-tag (`beta`, `next`) or a range (`1.x`, `^1.2.0`) — is not a version path segment, so asking
 * the registry for it produces a 404 that says nothing true about the package.
 */
const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function headers(): Record<string, string> {
  return { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' };
}

type Fetched<T> = { ok: true; body: T } | { ok: false; code: 'no_artifact' | 'unavailable' | 'upstream'; message: string };

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, what: string): Promise<Fetched<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, code: 'upstream', message: describeFetchFailure(`npm registry for ${what}`, e) };
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

export const npmAdapter: SourceAdapter = {
  id: 'npm',
  kinds: ['skill', 'plugin', 'mcp'],
  trust: 'community',

  async resolve(ref: string, kind: 'skill' | 'mcp' | 'plugin', opts: ResolveOptions = {}): Promise<ResolveOutcome> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    if (kind !== 'plugin' && kind !== 'mcp') {
      return {
        ok: false,
        code: 'unsupported_kind',
        message: `source 'npm' resolves plugin and mcp packages (kind '${kind}' has no npm payload reader yet)`,
      };
    }
    if (!/^[@\w./-]+$/.test(ref)) {
      return { ok: false, code: 'no_artifact', message: `invalid npm reference '${ref}'` };
    }
    // Split the trailing `@version` without mistaking the leading scope `@` for it.
    const at = ref.indexOf('@', 1);
    const name = at === -1 ? ref : ref.slice(0, at);
    const requestedVersion = at === -1 ? undefined : ref.slice(at + 1);
    if (!name || (requestedVersion !== undefined && requestedVersion === '')) {
      return { ok: false, code: 'no_artifact', message: `invalid npm reference '${ref}'` };
    }

    // Resolve the reference to a CONCRETE version before any version-document request:
    //  - no version  → the `latest` dist-tag;
    //  - semver      → that version, requested as-is;
    //  - anything else (dist-tag, range) → looked up in the packument's `dist-tags`. A range is not
    //    a tag, so it lands on the same honest "no such tag" answer instead of a bogus 404.
    let version: string;
    if (requestedVersion === undefined) {
      const packument = await fetchJson<Packument>(fetchImpl, `${REGISTRY}/${registryPath(name)}`, `package '${name}'`);
      if (!packument.ok) return packument;
      const latest = packument.body['dist-tags']?.latest;
      if (!latest) return { ok: false, code: 'no_artifact', message: `package '${name}' publishes no latest version` };
      version = latest;
    } else if (SEMVER.test(requestedVersion)) {
      version = requestedVersion;
    } else {
      const packument = await fetchJson<Packument>(fetchImpl, `${REGISTRY}/${registryPath(name)}`, `package '${name}'`);
      if (!packument.ok) return packument;
      const tagged = packument.body['dist-tags']?.[requestedVersion];
      if (!tagged) {
        return {
          ok: false,
          code: 'no_artifact',
          message: `package '${name}' has no dist-tag '${requestedVersion}' (a range must be resolved to a version first)`,
        };
      }
      version = tagged;
    }

    const doc = await fetchJson<VersionDoc>(
      fetchImpl,
      `${REGISTRY}/${registryPath(name)}/${encodeURIComponent(version)}`,
      `package '${name}@${version}'`
    );
    if (!doc.ok) return doc;
    const integrity = doc.body.dist?.integrity;
    if (!integrity) {
      return { ok: false, code: 'upstream', message: `package '${name}@${version}' carries no dist.integrity to pin` };
    }
    // The spec names the CONCRETE version we pinned — a dist-tag or `1.x` reference must not let the
    // installed code drift away from the integrity hash recorded beside it.
    const resolvedVersion = doc.body.version ?? version;
    const spec = `${name}@${resolvedVersion}`;
    const pkgName = doc.body.name ?? name;
    // The version document carries the package's own one-liner; an empty string is "none claimed".
    const description = doc.body.description?.trim() || null;
    if (kind === 'mcp') {
      // No author runtime arguments exist off-registry, so the launch is the minimal non-interactive
      // npx invocation of the PINNED spec — the `-y` the house MCP configs carry (writers/mcp), and a
      // version+integrity pair the spawned command cannot drift away from.
      return {
        ok: true,
        canonicalKey: `npm:${name}`,
        name: pkgName,
        description,
        payload: { kind: 'mcp', name: pkgName, launch: { command: 'npx', args: ['-y', spec] } },
        pin: { npm: { integrity } },
      };
    }
    return {
      ok: true,
      canonicalKey: `npm:${name}`,
      name: pkgName,
      description,
      payload: { kind: 'plugin', name: pkgName, pm: 'npm', spec },
      pin: { npm: { integrity } },
    };
  },
};
