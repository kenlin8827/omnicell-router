import { describeFetchFailure } from '../net.js';

/**
 * MCP Registry parameter schema (ADR-0015 §D8 amendment, 2026-11-01).
 *
 * The official registry publishes one `server.json` per server: the npm package that runs it, the
 * transport it speaks, and the environment variables / CLI arguments it accepts (`Input` and
 * `Argument` in the registry schema — name, description, format, isRequired, isSecret, default,
 * choices). That declaration is what makes a VISUAL parameter form possible for ANY server instead
 * of a per-package hand-written form; probing the process instead (`stdio_client`) cannot work,
 * because a stdio server cannot start without the parameters being discovered.
 *
 * This module is a READER only: it answers a narrow, capped shape the console can render, and it
 * never talks to a package store, never runs a server, and never writes anything. Everything here
 * is untrusted input (gate 5): arrays are capped, strings are trimmed and clipped, unknown enum
 * values fall back to the conservative member, and a malformed entry is dropped rather than
 * repaired.
 */

const ENDPOINT = 'https://registry.modelcontextprotocol.io/v0/servers';
const TIMEOUT_MS = 15_000;
/** A `server.json` payload is tens of kilobytes; anything past this is not the registry answering. */
const MAX_BYTES = 2_000_000;
const MAX_CANDIDATES = 20;
const MAX_INPUTS = 64;
const MAX_ARGUMENTS = 32;
const MAX_CHOICES = 64;
const MAX_TEXT = 500;
const MAX_VALUE = 4096;
const MAX_QUERY = 200;

export type McpValueFormat = 'string' | 'number' | 'boolean' | 'filepath';

/** One `Input` — an environment variable or a header the operator may set. */
export interface McpRegistryInput {
  name: string;
  description?: string;
  format: McpValueFormat;
  secret: boolean;
  required: boolean;
  default?: string;
  placeholder?: string;
  choices?: string[];
  /** Pinned by the registry (`Input.value`): not operator-configurable. */
  value?: string;
}

/** One `Argument`: `positional` inserts its value verbatim, `named` is a `--flag=value` element. */
export interface McpRegistryArgument {
  type: 'positional' | 'named';
  /** Positional: the value itself or its `valueHint` label; named: the flag with its dashes. */
  name: string;
  value?: string;
  valueHint?: string;
  default?: string;
  description?: string;
  format: McpValueFormat;
  secret: boolean;
  required: boolean;
  choices?: string[];
}

export interface McpRegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;
  env: McpRegistryInput[];
  args: McpRegistryArgument[];
  headers: McpRegistryInput[];
}

export interface McpRegistryCandidate {
  /** Registry name (`io.github.owner/server`). */
  name: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: string;
  packages: McpRegistryPackage[];
}

export type McpRegistryResult =
  | { ok: true; candidates: McpRegistryCandidate[] }
  | { ok: false; code: 'bad_request' | 'upstream'; message: string };

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function format(value: unknown): McpValueFormat {
  return value === 'number' || value === 'boolean' || value === 'filepath' ? value : 'string';
}

function choices(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((item) => text(item))
    .filter((item): item is string => item !== undefined)
    .slice(0, MAX_CHOICES);
  return out.length > 0 ? out : undefined;
}

function input(raw: unknown): McpRegistryInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 128);
  if (!name) return null;
  const description = text(r.description);
  const fallback = text(r.default, MAX_VALUE);
  const placeholder = text(r.placeholder);
  const pinned = text(r.value, MAX_VALUE);
  const list = choices(r.choices);
  return {
    name,
    format: format(r.format),
    secret: r.isSecret === true,
    required: r.isRequired === true,
    ...(description ? { description } : {}),
    ...(fallback ? { default: fallback } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(list ? { choices: list } : {}),
    ...(pinned ? { value: pinned } : {}),
  };
}

function inputList(raw: unknown): McpRegistryInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(input)
    .filter((item): item is McpRegistryInput => item !== null)
    .slice(0, MAX_INPUTS);
}

function argument(raw: unknown): McpRegistryArgument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = r.type === 'named' ? 'named' : r.type === 'positional' ? 'positional' : null;
  if (!type) return null;
  const flag = text(r.name, 128);
  if (type === 'named' && !flag) return null;
  const value = text(r.value, MAX_VALUE);
  const valueHint = text(r.valueHint, 128);
  const name = type === 'named' ? flag! : (valueHint ?? value ?? '');
  if (!name) return null;
  const description = text(r.description);
  const fallback = text(r.default, MAX_VALUE);
  const list = choices(r.choices);
  return {
    type,
    name,
    format: format(r.format),
    secret: r.isSecret === true,
    required: r.isRequired === true,
    ...(value ? { value } : {}),
    ...(valueHint ? { valueHint } : {}),
    ...(description ? { description } : {}),
    ...(fallback ? { default: fallback } : {}),
    ...(list ? { choices: list } : {}),
  };
}

function argumentList(raw: unknown): McpRegistryArgument[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(argument)
    .filter((item): item is McpRegistryArgument => item !== null)
    .slice(0, MAX_ARGUMENTS);
}

function transportOf(raw: unknown): 'stdio' | 'http' | 'sse' {
  const type = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).type : undefined;
  return type === 'sse' ? 'sse' : type === 'streamable-http' ? 'http' : 'stdio';
}

/** One `Package`; `registryType` stays the registry's own word so the console decides which
 *  ecosystems it can launch (`npm` via npx/bunx, `pypi` via uvx; anything else is refused there). */
function pkg(raw: unknown): McpRegistryPackage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const registryType = text(r.registryType, 32);
  const identifier = text(r.identifier, 300);
  if (!registryType || !identifier) return null;
  const version = text(r.version, 64);
  const transport = r.transport && typeof r.transport === 'object' ? (r.transport as Record<string, unknown>) : undefined;
  const url = text(transport?.url, 2000);
  return {
    registryType,
    identifier,
    transport: transportOf(r.transport),
    env: inputList(r.environmentVariables),
    args: [...argumentList(r.runtimeArguments), ...argumentList(r.packageArguments)],
    headers: inputList(transport?.headers),
    ...(version ? { version } : {}),
    ...(url ? { url } : {}),
  };
}

/** One remote-only server entry (`server.remotes`), shaped like a package the console can apply. */
function remotePkg(raw: unknown): McpRegistryPackage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const transport = r.transport && typeof r.transport === 'object' ? (r.transport as Record<string, unknown>) : undefined;
  const url = text(transport?.url, 2000);
  if (!url) return null;
  return {
    registryType: 'remote',
    identifier: url,
    transport: transportOf(r.transport) === 'stdio' ? 'sse' : transportOf(r.transport),
    url,
    env: [],
    args: [],
    headers: inputList(transport?.headers),
  };
}

function candidate(raw: unknown): McpRegistryCandidate | null {
  const server = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).server : undefined;
  if (!server || typeof server !== 'object' || Array.isArray(server)) return null;
  const s = server as Record<string, unknown>;
  const name = text(s.name, 200);
  if (!name) return null;
  const packages = [
    ...(Array.isArray(s.packages) ? s.packages.map(pkg) : []),
    ...(Array.isArray(s.remotes) ? s.remotes.map(remotePkg) : []),
  ].filter((item): item is McpRegistryPackage => item !== null);
  if (packages.length === 0) return null;
  const title = text(s.title);
  const description = text(s.description);
  const version = text(s.version, 64);
  const repository =
    s.repository && typeof s.repository === 'object'
      ? text((s.repository as Record<string, unknown>).url, 500)
      : text(s.repository, 500);
  return {
    name,
    packages,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(repository ? { repository } : {}),
  };
}

function validQuery(raw: string): string | null {
  const query = raw.trim();
  if (query.length < 2 || query.length > MAX_QUERY) return null;
  // Control characters never belong in a search term and would end up percent-encoded noise.
  if (/[\u0000-\u001f\u007f]/.test(query)) return null;
  return query;
}

/**
 * Ask the registry for the LATEST schema of every server matching `query`.
 *
 * `version=latest` is the registry's own filter; without it the answer carries every published
 * version of a server, and a console form would have to guess which one is current. Duplicate
 * names are collapsed, and the result is capped so a broad search cannot grow the dialog.
 */
export async function searchMcpRegistry(
  rawQuery: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<McpRegistryResult> {
  const query = validQuery(rawQuery);
  if (!query) return { ok: false, code: 'bad_request', message: 'query must be 2–200 printable characters' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  const direct = await searchOnce(query, fetchImpl, timeoutMs);
  if (!direct.ok || direct.candidates.length > 0) return direct;

  // The registry's search matches server NAME / description, not an npm package identifier, and
  // operators paste what they would run. So a scoped spec gets two more chances before "no match":
  // its bare form (`bytebase/dbhub`), then the package's own `mcpName` (the registry name npm
  // publishes for it), which is exactly the identity the registry indexes.
  const bare = query.replace(/^@/, '');
  if (bare !== query) {
    const stripped = await searchOnce(bare, fetchImpl, timeoutMs);
    if (!stripped.ok || stripped.candidates.length > 0) return stripped;
  }

  const pkg = npmPackageFromQuery(query);
  if (pkg) {
    const mcpName = await npmMcpName(pkg, fetchImpl, timeoutMs);
    if (mcpName) {
      const byName = await searchOnce(mcpName, fetchImpl, timeoutMs);
      if (!byName.ok || byName.candidates.length > 0) return byName;
    }
  }
  return direct;
}

/** One registry GET, normalized. The wrapper above decides how many of these an answer is worth. */
async function searchOnce(query: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<McpRegistryResult> {
  const url = `${ENDPOINT}?search=${encodeURIComponent(query)}&version=latest&limit=${MAX_CANDIDATES}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('MCP Registry', error) };
  }
  if (!response.ok) {
    return { ok: false, code: 'upstream', message: `MCP Registry answered HTTP ${response.status}` };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('MCP Registry', error) };
  }
  if (body.length > MAX_BYTES) {
    return { ok: false, code: 'upstream', message: 'MCP Registry answer is larger than this reader accepts' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, code: 'upstream', message: 'MCP Registry answered a body that is not JSON' };
  }
  const servers =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { servers?: unknown }).servers)
      ? ((parsed as { servers: unknown[] }).servers as unknown[])
      : [];

  const seen = new Set<string>();
  const candidates: McpRegistryCandidate[] = [];
  for (const entry of servers.slice(0, MAX_CANDIDATES)) {
    const item = candidate(entry);
    if (!item || seen.has(item.name)) continue;
    seen.add(item.name);
    candidates.push(item);
  }
  return { ok: true, candidates };
}

/**
 * The npm package a query names, when it is written the way `npx` accepts it (`@scope/name@ver`).
 * Only scoped or path-shaped queries qualify: an unscoped word already matched the registry search,
 * and probing npm for every miss would double the latency of a genuine "no match".
 */
function npmPackageFromQuery(query: string): string | null {
  const spec = query.trim();
  if (/\s/.test(spec)) return null;
  if (!spec.startsWith('@') && !spec.includes('/')) return null;
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash <= 1) return null;
    const rest = spec.slice(slash + 1);
    const at = rest.indexOf('@');
    const scope = spec.slice(1, slash);
    const name = at === -1 ? rest : rest.slice(0, at);
    return scope && name ? `@${scope}/${name}` : null;
  }
  const at = spec.indexOf('@');
  return (at === -1 ? spec : spec.slice(0, at)) || null;
}

/** The registry name an npm package publishes (`mcpName` in its package.json), if any. */
async function npmMcpName(pkg: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string | null> {
  const path = pkg.startsWith('@') ? pkg.replace('/', '%2F') : pkg;
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${path}/latest`, {
      headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = await response.text();
    if (body.length > MAX_BYTES) return null;
    const doc = JSON.parse(body) as { mcpName?: unknown };
    const name = typeof doc.mcpName === 'string' ? doc.mcpName.trim() : '';
    return /^[^\s/]+\/[^\s/]+$/.test(name) && name.length <= 200 ? name : null;
  } catch {
    return null;
  }
}
