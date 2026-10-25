import { fetchSmitheryServer } from '../smithery.js';
import { normalizeName, type ResolveOptions, type ResolveOutcome, type SourceAdapter } from '../spi.js';

/**
 * Smithery install adapter (ADR-0015 §D6) — the one aggregator that owns its launch spec.
 *
 * Smithery does not merely index servers: it HOSTS them (`<slug>.run.tools`, and the equivalent
 * `server.smithery.ai/<qualifiedName>/mcp`). Both endpoints were measured on 2026-10-25 to answer an
 * MCP `initialize` with `401 {"error":"invalid_token","error_description":"Missing Authorization
 * header"}`, so the launch this adapter emits is (a) the hosted URL the record names and (b) an
 * `Authorization` env reference — never a token, never a value (gate 4). The operator supplies
 * `Authorization` (`Bearer <smithery key>`) in their own environment.
 *
 * Two refusals keep the market honest:
 *  - a server whose connection declares required CONFIG (`configSchema.required`, e.g. `braveApiKey`)
 *    is refused: the MCP writer can reference environment KEY names in a header or a command's env,
 *    but it cannot carry a per-connection config OBJECT, and installing one would write a server that
 *    answers 401/tool-errors while looking healthy;
 *  - a server Smithery knows but does not host (no `deploymentUrl`, `remote: false`) has no MCP launch
 *    here — its local package is Smithery's own distribution, not a config merge.
 *
 * Arbitration (§D6): when the official registry ALSO carries the server, the official record wins —
 * this adapter never overrides it, because the console resolves one source at a time and the row's
 * `key` names the source that answered.
 */

/** The header the hosted endpoints require, as an env KEY (`{env:Authorization}` in the config). */
const AUTH_HEADER_KEY = 'Authorization';

export const smitheryAdapter: SourceAdapter = {
  id: 'smithery',
  kinds: ['mcp'],
  trust: 'aggregator',

  async resolve(ref: string, kind: 'skill' | 'mcp' | 'extension', opts: ResolveOptions = {}): Promise<ResolveOutcome> {
    if (kind !== 'mcp') {
      return { ok: false, code: 'unsupported_kind', message: `source 'smithery' resolves MCP servers only (kind '${kind}')` };
    }
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(ref)) {
      return { ok: false, code: 'no_artifact', message: `invalid server reference '${ref}'` };
    }
    const fetchImpl = opts.fetchImpl ?? fetch;
    const read = await fetchSmitheryServer(ref, fetchImpl);
    if (!read.ok) {
      // A missing record is an artifact problem, not an outage: the page must not claim Smithery is down.
      if (read.reason === 'http' && read.reasonParams?.status === '404') {
        return { ok: false, code: 'no_artifact', message: `server '${ref}' is not in the Smithery registry` };
      }
      return { ok: false, code: read.code, message: read.message };
    }
    const { detail } = read;
    const requiredKeys = [...new Set(detail.connections.flatMap((c) => c.requiredKeys ?? []))].sort();
    if (requiredKeys.length > 0) {
      return {
        ok: false,
        code: 'no_artifact',
        message: `Smithery server '${ref}' requires configuration (${requiredKeys.join(', ')}); this console writes env KEY references only, so add it at https://smithery.ai/servers/${ref}`,
      };
    }
    const hosted = detail.connections.find((c) => c.deploymentUrl);
    const url = hosted?.deploymentUrl ?? (detail.remote ? `https://server.smithery.ai/${ref}/mcp` : undefined);
    if (!url) {
      return {
        ok: false,
        code: 'no_artifact',
        message: `Smithery lists '${ref}' but hosts no deployment for it — there is no MCP endpoint to merge`,
      };
    }
    const transport = hosted?.type === 'sse' ? 'sse' : 'http';
    return {
      ok: true,
      canonicalKey: `smithery:${detail.qualifiedName}`,
      // The WHOLE qualified name: the last segment alone (`github`, `gmail`, `news`) is shared by many
      // publishers, and two servers merging onto one config key would silently replace each other.
      name: normalizeName(detail.qualifiedName),
      description: detail.description?.trim() || null,
      payload: {
        kind: 'mcp',
        name: detail.qualifiedName,
        launch: { url, transport, headerKeys: [AUTH_HEADER_KEY] },
      },
      pin: { adopted: true },
    };
  },
};
