import type { SourceAdapter, ResolveOptions, ResolveOutcome } from '../spi.js';
import { describeFetchFailure, fetchWithRetry } from '../net.js';
import { normalizeName } from '../spi.js';

/**
 * MCP official registry adapter (ADR-0015 §D6) — authoritative identity + launch spec.
 *
 * Endpoints measured 2026-10-25, anonymous:
 *  - `GET /v0/servers/<name>/versions/latest` → 200 `{ server: {…} }` — the identity lookup used here.
 *  - `GET /v0/servers/<name>` → 404 `Endpoint not found` — the bare path is NOT served, so a per-server
 *    read must go through `versions/latest`.
 *  - `GET /v0/servers?limit=&search=&cursor=&version=latest` → 200 — the browse surface (`browse.ts`).
 *
 * The body is the author's published `server.json`, whose package fields are camelCase
 * (`registryType` / `runtimeArguments` / `environmentVariables` / `runtimeHint`). If a measured field
 * ever drifts from the schema, THIS adapter is the single place to fix.
 */

const API = 'https://registry.modelcontextprotocol.io/v0/servers';

interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  /** The runner the author declares (measured: `npx`). */
  runtimeHint?: string;
  runtimeArguments?: { value?: string }[];
  environmentVariables?: { name?: string }[];
}

interface RegistryRemote {
  type?: string;
  url?: string;
}

interface RegistryRecord {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    packages?: RegistryPackage[];
    remotes?: RegistryRemote[];
  };
}

function headers(): Record<string, string> {
  return { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' };
}

/**
 * The server key inside a host's MCP container.
 *
 * Derived from the FULL reverse-DNS registry name, not its last path segment: measured names such as
 * `ac.inference.sh/mcp` and `ac.snag/mcp` end in the same generic segment, so the segment alone would
 * make two different servers collide on one config key (the second merge would silently replace the
 * first). The registry name is unique by construction, so normalizing all of it is collision-free.
 */
function serverName(name: string): string {
  return normalizeName(name);
}

/** A `runtimeHint` is honored only when it is a bare command token — never a shell-shaped string. */
function runner(hint: string | undefined, fallback: string): string {
  return hint && /^[a-z][a-z0-9._-]*$/.test(hint) ? hint : fallback;
}

export const mcpOfficialAdapter: SourceAdapter = {
  id: 'mcp-official',
  kinds: ['mcp'],
  trust: 'official',

  async resolve(ref: string, kind: 'skill' | 'mcp' | 'extension', opts: ResolveOptions = {}): Promise<ResolveOutcome> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    if (kind !== 'mcp') {
      return { ok: false, code: 'unsupported_kind', message: `source 'mcp-official' cannot resolve kind '${kind}'` };
    }
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(ref)) {
      return { ok: false, code: 'no_artifact', message: `invalid server reference '${ref}'` };
    }
    let res: Response;
    try {
      // Shared market-retry policy: every failed answer is retried; the last one is answered as it came.
      res = await fetchWithRetry(
        `${API}/${encodeURIComponent(ref)}/versions/latest`,
        { headers: headers() },
        undefined,
        { fetchImpl }
      );
    } catch (e) {
      return { ok: false, code: 'upstream', message: describeFetchFailure('MCP registry', e) };
    }
    if (res.status === 404) return { ok: false, code: 'no_artifact', message: `server '${ref}' is not in the registry` };
    if (!res.ok) return { ok: false, code: 'upstream', message: `registry returned HTTP ${res.status}` };
    let record: RegistryRecord;
    try {
      record = (await res.json()) as RegistryRecord;
    } catch {
      return { ok: false, code: 'upstream', message: 'registry returned non-JSON content' };
    }
    const server = record.server;
    if (!server?.name) return { ok: false, code: 'no_artifact', message: 'registry record has no server identity' };

    // Launch derivation: an npm package runs through the author's declared runner (npx by default); a
    // remote is used verbatim. Env/header declarations contribute KEY NAMES only (gate 4).
    const npmPackage = server.packages?.find((p) => p.registryType === 'npm' && p.identifier);
    if (npmPackage?.identifier) {
      const args = [
        npmPackage.identifier,
        ...(npmPackage.runtimeArguments ?? []).map((a) => a.value).filter((v): v is string => typeof v === 'string'),
      ];
      return {
        ok: true,
        canonicalKey: `mcp-official:${server.name}`,
        name: serverName(server.name),
        description: server.description?.trim() || null,
        payload: {
          kind: 'mcp',
          name: server.name,
          launch: {
            command: runner(npmPackage.runtimeHint, 'npx'),
            args,
            envKeys: (npmPackage.environmentVariables ?? [])
              .map((v) => v.name)
              .filter((n): n is string => typeof n === 'string'),
          },
        },
        pin: { adopted: true },
      };
    }
    const remote = server.remotes?.find((r) => r.url);
    if (remote?.url) {
      const transport = remote.type === 'sse' ? 'sse' : 'http';
      return {
        ok: true,
        canonicalKey: `mcp-official:${server.name}`,
        name: serverName(server.name),
        description: server.description?.trim() || null,
        payload: { kind: 'mcp', name: server.name, launch: { url: remote.url, transport } },
        pin: { adopted: true },
      };
    }
    return { ok: false, code: 'no_artifact', message: 'registry record carries neither an npm package nor a remote' };
  },
};
