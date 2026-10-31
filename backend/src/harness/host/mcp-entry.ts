import type { McpLaunch } from '../spi.js';
import fs from 'node:fs';
import TOML from '@iarna/toml';

/**
 * MCP launch ⇄ host config entry (ADR-0015 §D8, gate 4).
 *
 * The install writer materializes a launch into an entry; the edit path reads one back, lets the
 * operator change it, and merges the result. Both directions live here so the two write paths can
 * never disagree about what a server entry means.
 *
 * Secret discipline: a read answers KEY NAMES only. Existing env/header VALUES are never returned to
 * a caller (they may be literal secrets an operator typed by hand) — but the merge PRESERVES a value
 * already stored under a key that survives the edit, because rewriting it to `{env:KEY}` would
 * silently replace a working literal with an unset variable.
 *
 * Every runtime spells the same two things differently, so both are declared by the host adapter and
 * threaded through here (ADR-0015 §D8: a landing is verified only when its path, entry shape,
 * secret-reference syntax and inverse removal all agree):
 *   - entry shape — opencode's `{type, command[], environment}` vs the `mcpServers` spelling every
 *     other verified runtime uses (`{command, args[], env}`);
 *   - secret reference — `{env:KEY}` (opencode) vs `${KEY}` (pi, omp; claude writes the same
 *     spelling, but its config is not a landing yet — the file is runtime-owned state).
 */


/** UTF-8 byte-order mark, stripped before parsing. */
const BOM = '\uFEFF';
export type McpEntryShape = 'opencode' | 'mcpServers';
export type McpSecretRef = 'opencode' | 'shell';

export interface McpEntrySpec {
  shape: McpEntryShape;
  secretRef: McpSecretRef;
}

/** The landing spelling of a host that declares nothing: opencode was the first and still defaults. */
export const OPENCODE_ENTRY_SPEC: McpEntrySpec = { shape: 'opencode', secretRef: 'opencode' };

/**
 * Read + validate one landing config file in the format the host declares. Refuses anything a
 * plain-JSON round-trip would silently mangle (comments, trailing garbage) — the same refusal the
 * JSON writer applies, applied to every landing read (ADR-0015 §D8.13: a landing file is observed,
 * and only a CLI landing's runtime writes it anyway).
 */
export function readMcpLandingFile(
  file: string,
  format: 'json' | 'toml'
): { ok: true; config: Record<string, unknown> } | { ok: false; reason: string } {
  if (!fs.existsSync(file)) return { ok: true, config: {} };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: `cannot read config: ${e instanceof Error ? e.message : e}` };
  }
  if (text.startsWith(BOM)) text = text.slice(1);
  if (format === 'toml') {
    try {
      const parsed = TOML.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'config root is not a table' };
      }
      return { ok: true, config: parsed as Record<string, unknown> };
    } catch (e) {
      return { ok: false, reason: `config is not valid TOML: ${e instanceof Error ? e.message : e}` };
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'config root is not a JSON object' };
    }
    return { ok: true, config: parsed as Record<string, unknown> };
  } catch {
    const commentish = /(^|[^:"'\\])\/\/|\/\*/.test(text);
    return {
      ok: false,
      reason: commentish
        ? 'config contains comments (JSONC) — a JSON rewrite would drop them; refusing'
        : 'config is not valid JSON; refusing',
    };
  }
}

/** Package runners whose argv carries an MCP server package spec as a standalone token. */
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'uvx', 'uv']);

/** True for `npx`/`bunx`/`uvx`/`uv`, also when spelled with a path or a Windows extension. */
export function isPackageRunnerCommand(command: string): boolean {
  const base = command.split(/[\\/]/).pop() ?? '';
  return PACKAGE_RUNNERS.has(base.toLowerCase().replace(/\.(cmd|exe|bat)$/, ''));
}

/** Server names become object KEYS: these rewrite the prototype instead. */
const RESERVED_SERVER_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * The UNION grammar a server key may use. A host with a narrower rule declares its own pattern
 * (pi rejects a dot, omp allows one), and `planMcp` refuses the target instead of writing a key the
 * runtime itself would then fail to load.
 */
export const MCP_SERVER_NAME = /^[\w.-]+$/;

/** omp's schema bound (`^[A-Za-z0-9_.-]{1,100}$`); the other two hosts declare no length. */
const MCP_SERVER_NAME_MAX = 100;

/**
 * The entry key a PACKAGE-derived MCP install can actually land.
 *
 * A registry identity is package vocabulary, not a runtime's: `@bytebase/dbhub` carries `@` and `/`,
 * and pi additionally refuses a dot (`pi mcp add foo.bar` → `invalid server name`), so every host
 * would refuse the raw name and the install would fail with "invalid server name". The derivation
 * uses the INTERSECTION grammar — letters, digits, `_`, `-` — so one key lands in every verified
 * host, keeps the scope (`@scope/name` → `scope-name`, never a bare `name` two scopes could share)
 * and stays the same string the console prefills into its read-only name field.
 */
export function mcpServerNameFromPackage(pkg: string): string {
  const name = pkg
    .trim()
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name.slice(0, MCP_SERVER_NAME_MAX).replace(/-+$/, '');
}

/** The reference a runtime expands for a secret the operator supplies in its own environment. */
export function secretReference(key: string, ref: McpSecretRef): string {
  return ref === 'shell' ? `\${${key}}` : `{env:${key}}`;
}

/** The one refusal string both manual install and edit answer for an unusable launch shape. */
export const INVALID_MCP_LAUNCH =
  'invalid manual launch: expected {command, args?, envKeys?, envValues?} or {url, transport?, headerKeys?, headerValues?}';

/** Bounds on the value maps a launch may carry (gate 5: a request cannot grow the config). */
const MAX_VALUE_KEYS = 64;
const MAX_VALUE_CHARS = 8192;
/** A stored value that is exactly an environment reference leaves the value to the runtime. */
const ENV_REF_RE = /^(\{env:[A-Za-z0-9_]+\}|\$\{[A-Za-z0-9_]+\})$/;

/** A plain `{key: string}` map, bounded — anything else would put an arbitrary value in the file. */
function validValueMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_VALUE_KEYS) return false;
  return entries.every(
    ([key, item]) => key.length > 0 && key.length <= 128 && typeof item === 'string' && item.length <= MAX_VALUE_CHARS
  );
}

/** Why a typed server name cannot be an entry key, or null when it can. */
export function mcpServerNameError(raw: string, pattern: RegExp = MCP_SERVER_NAME): string | null {
  const name = raw.trim();
  if (!name || !pattern.test(name)) return `invalid server name '${raw}'`;
  if (RESERVED_SERVER_NAMES.has(name)) return `reserved server name '${name}'`;
  return null;
}

/** Shape-validate a launch BEFORE any writer sees it — a primitive would break entry composition. */
export function validMcpLaunch(launch: unknown): launch is McpLaunch {
  if (!launch || typeof launch !== 'object') return false;
  const l = launch as Record<string, unknown>;
  const stringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (typeof l.command === 'string' && l.command.trim() !== '') {
    return (
      (l.args === undefined || stringArray(l.args)) &&
      (l.envKeys === undefined || stringArray(l.envKeys)) &&
      (l.envValues === undefined || validValueMap(l.envValues))
    );
  }
  if (typeof l.url === 'string' && l.url.trim() !== '') {
    return (
      (l.transport === undefined || ['http', 'sse', 'stdio'].includes(l.transport as string)) &&
      (l.headerKeys === undefined || stringArray(l.headerKeys)) &&
      (l.headerValues === undefined || validValueMap(l.headerValues))
    );
  }
  return false;
}

/**
 * A command launch is the host's stdio pipe: every verified landing spawns the child and speaks
 * JSON-RPC over its pipes. When that child is a PACKAGE RUNNER, argv names an MCP server package and
 * `--transport` selects the server's wire transport — `http`/`sse` starts a network listener and
 * never answers the pipe, which the host reads as a timeout. `stdio` (usually the default) is the
 * only value this entry shape can honor.
 *
 * A custom command is left alone: it is the operator's own executable or wrapper, whose
 * `--transport` may mean something else entirely, so a name-based guess must not refuse it.
 */
export function mcpStdioTransportError(launch: unknown): string | null {
  if (!launch || typeof launch !== 'object') return null;
  const l = launch as Record<string, unknown>;
  if (typeof l.command !== 'string' || l.command.trim() === '' || !Array.isArray(l.args)) return null;
  if (!isPackageRunnerCommand(l.command)) return null;
  const args = l.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    const inline = /^--transport=(.+)$/i.exec(arg);
    if (inline) {
      const value = inline[1]!.trim();
      if (!/^stdio$/i.test(value)) return transportConflict(value);
      continue;
    }
    if (/^--transport$/i.test(arg)) {
      const next = args[i + 1];
      if (typeof next === 'string' && !next.startsWith('-') && !/^stdio$/i.test(next)) {
        return transportConflict(next);
      }
    }
  }
  return null;
}

function transportConflict(value: string): string {
  return `local MCP launches speak stdio over the host's pipe; argv passes '--transport ${value}' — use a remote (url) entry for HTTP/SSE transports`;
}

/** Key NAMES of an env/header object — values stay behind. */
function keyNames(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Keys whose stored value is NOT a bare `{env:KEY}` reference: a literal the operator typed, or a
 * `{file:...}` reference. The console shows these as "already set" without ever receiving the value
 * itself, and re-submitting the form unchanged keeps them (gate 4).
 */
function setKeyNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item !== 'string' || !ENV_REF_RE.test(item))
    .map(([key]) => key);
}

export type McpEntryRead =
  | { ok: true; launch: McpLaunch; setKeys: string[] }
  | { ok: false; reason: string };

/**
 * Read one host entry back into the launch vocabulary. Only the shapes the writer can produce (and
 * the two hand-written spellings a runtime accepts) are understood; anything else is refused rather
 * than guessed, so the console never opens a form over an entry it would then rewrite differently.
 */
export function mcpLaunchFromEntry(entry: unknown): McpEntryRead {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: 'entry is not an object' };
  }
  const record = entry as Record<string, unknown>;
  // `environment` is opencode's spelling, `env` the one every `mcpServers` runtime uses. A read is
  // shape-agnostic on purpose: discovery opens whichever config it found, and the writer decides
  // the shape on the way back out.
  const envMap = record.environment ?? record.env;
  const envKeys = keyNames(envMap);
  const envSet = setKeyNames(envMap);

  if (Array.isArray(record.command)) {
    const parts = record.command;
    if (parts.length === 0 || !parts.every((part) => typeof part === 'string' && part !== '')) {
      return { ok: false, reason: 'entry command is not a non-empty string array' };
    }
    const [command, ...args] = parts as string[];
    return {
      ok: true,
      setKeys: envSet,
      launch: { command: command!, ...(args.length > 0 ? { args } : {}), ...(envKeys ? { envKeys } : {}) },
    };
  }

  if (typeof record.command === 'string' && record.command !== '') {
    const args = Array.isArray(record.args) && record.args.every((part) => typeof part === 'string')
      ? (record.args as string[])
      : undefined;
    return {
      ok: true,
      setKeys: envSet,
      launch: { command: record.command, ...(args && args.length > 0 ? { args } : {}), ...(envKeys ? { envKeys } : {}) },
    };
  }

  if (typeof record.url === 'string' && record.url !== '') {
    const headerKeys = keyNames(record.headers);
    return {
      ok: true,
      setKeys: setKeyNames(record.headers),
      // The runtime has no transport field of its own; HTTP-style endpoints are all the same
      // shape, and the writer ignores which spelling the form chose.
      launch: { url: record.url, transport: 'sse', ...(headerKeys ? { headerKeys } : {}) },
    };
  }

  return { ok: false, reason: 'entry carries neither a command nor a url' };
}

/**
 * Compose the next entry for one launch from the CURRENT entry.
 *
 * Unknown fields (`timeout`, `cwd`, a hand-written note the runtime understands) and `enabled` are
 * preserved: an edit changes the launch, not the whole record. Fields belonging to the other shape
 * are dropped, so a stdio ⇄ remote switch cannot leave a stale `command` or `url` behind.
 */
export function mcpEntryForLaunch(
  existing: unknown,
  launch: McpLaunch,
  spec: McpEntrySpec = OPENCODE_ENTRY_SPEC
): Record<string, unknown> {
  const prev =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...prev };

  if (spec.shape === 'mcpServers') {
    // The `mcpServers` spelling: command and args are separate fields, env/headers keep their names.
    if ('command' in launch) {
      next.command = launch.command;
      if (launch.args && launch.args.length > 0) next.args = [...launch.args];
      else delete next.args;
      delete next.url;
      delete next.headers;
      const refs = referenceMap(prev.env, launch.envKeys, launch.envValues, spec);
      if (Object.keys(refs).length > 0 || prev.env !== undefined) next.env = refs;
      else delete next.env;
    } else {
      next.url = launch.url;
      delete next.command;
      delete next.args;
      delete next.env;
      const refs = referenceMap(prev.headers, launch.headerKeys, launch.headerValues, spec);
      if (Object.keys(refs).length > 0 || prev.headers !== undefined) next.headers = refs;
      else delete next.headers;
    }
    return next;
  }

  if ('command' in launch) {
    next.type = 'local';
    next.command = [launch.command, ...(launch.args ?? [])];
    delete next.url;
    delete next.headers;
    const refs = referenceMap(prev.environment, launch.envKeys, launch.envValues, spec);
    // An edit does not INVENT an empty map on an entry that never had one — re-submitting the form
    // unchanged must stay a no-op. A surviving empty map (the operator cleared every key) is written.
    if (Object.keys(refs).length > 0 || prev.environment !== undefined) next.environment = refs;
    else delete next.environment;
  } else {
    next.type = 'remote';
    next.url = launch.url;
    delete next.command;
    delete next.args;
    delete next.environment;
    const refs = referenceMap(prev.headers, launch.headerKeys, launch.headerValues, spec);
    if (Object.keys(refs).length > 0 || prev.headers !== undefined) next.headers = refs;
    else delete next.headers;
  }
  return next;
}

/**
 * `{KEY: value}` for every surviving key: a value the form typed wins, then the value already stored
 * under that key (never rewritten to a reference, which would silently unset a working literal), then
 * `{env:KEY}` for a newly named key.
 *
 * `Object.fromEntries` is deliberate: it creates own data properties, so a key named `__proto__`
 * (a legal environment variable name) can never reach the prototype chain.
 */
function referenceMap(
  existing: unknown,
  keys: string[] | undefined,
  values: Record<string, string> | undefined,
  spec: McpEntrySpec = OPENCODE_ENTRY_SPEC
): Record<string, string | unknown> {
  const prev =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const names = [...new Set([...(keys ?? []), ...Object.keys(values ?? {})])];
  return Object.fromEntries(
    names.map((key) => {
      const typed = values?.[key];
      if (typeof typed === 'string' && typed.length > 0) return [key, typed];
      return [key, Object.prototype.hasOwnProperty.call(prev, key) ? prev[key] : secretReference(key, spec.secretRef)];
    })
  );
}

/** Key-order-insensitive equality — a re-merged identical entry must read as a no-op. */
export function sameMcpEntry(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([key, v]) => [key, stable(v)])
      );
    }
    return value;
  };
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
