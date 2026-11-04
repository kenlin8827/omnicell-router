import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { describeFetchFailure } from '../net.js';
import type { McpValueFormat } from './mcp-registry.js';

/**
 * CLI flag discovery for an MCP server run by a package manager (ADR-0015 §D8 amendment,
 * 2026-11-01).
 *
 * The official registry describes DBHub with environment variables only and declares no
 * `runtimeArguments`, so a registry-driven form cannot offer `--transport` / `--port` / `--dsn`.
 * This module reads the PUBLISHED PACKAGE instead: it downloads the npm tarball (npx / bunx) or the
 * PyPI source archive (uvx), keeps it in memory, and scans the shipped source for the flags the
 * package itself parses. Nothing is written and nothing is executed — the package never runs here.
 *
 * The scan is a heuristic, deliberately narrow:
 *   - JavaScript: a file counts as CLI-parsing only when it mentions `process.argv`; inside those
 *     files `args.<name>`, `args["<name>"]`, literal `'--name'` and `requireFlagValue("name", …)`
 *     are candidates;
 *   - Python: `add_argument("--name"`, `click.option("--name"` and `Option("--name"` are candidates;
 *   - `=== "x"` / `choices=[…]` yield choices, `parseInt` / `type=int` mark a number, `required=True`
 *     marks a required input, and a nearby `process.env.NAME` / `os.environ.get("NAME")` is reported
 *     as the environment fallback; a name matching the DSN pattern (`dsn`, `connection-string`,
 *     `database-url`, …) marks a `dsn` format the console renders as a structured builder; a ternary
 *     fallback (`args.x === "a" ? … : "b"`) contributes `b` as well — that branch is a value the
 *     parser handles but never compares against;
 *   - JavaScript prototype properties, `--help` / `--version` and a plain boolean switch are dropped
 *     from the choices they would otherwise suggest.
 * A package that hides its flags behind an interpreter (a config DSL, a minified vendor blob)
 * simply yields fewer options; the caller keeps whatever the registry declared as well.
 *
 * `choices` is therefore a HINT SET of literals the scan saw, never a closed enum: a conditional
 * fallback, a `switch`, or a value computed at runtime may be handled by the package and still be
 * missing here. The console treats the list as suggestions and its value editor accepts a typed
 * value outside it.
 */

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 20_000;
const MAX_META_BYTES = 2_000_000;
const MAX_TARBALL_BYTES = 25_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_OPTIONS = 64;
const MAX_CHOICES = 8;

/** Names that are JavaScript properties, not package flags. */
const NOISE = new Set(['length', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']);
/** Flags every CLI framework adds and no launch config needs. */
const BUILTIN = new Set(['help', 'version']);
/** A flag whose value is a connection string — the console renders a DSN builder, not a plain field. */
// Mirrored as DSN_FLAG_RE in frontend/src/lib/dsn.ts — the console classifies an EXISTING launch's
// argv rows with it (the edit sheet has no probe result). Change both together.
const DSN_NAME = /\bdsn\b|connection[\s_-]?string|conn[\s_-]?str|database[\s_-]?url|db[\s_-]?url/i;

/** The CLI probe's value vocabulary is the registry's plus `dsn` — a connection-string flag the
 *  probe classifies by NAME; the registry never declares `dsn`, so it only arrives via this path. */
export type McpCliFormat = McpValueFormat | 'dsn';

/** Immutable per version: a repeat click must not download the same tarball again. */
const probeCache = new Map<string, McpCliProbeResult>();

function rememberProbe(key: string, answer: McpCliProbeResult): McpCliProbeResult {
  if (probeCache.size >= 20) probeCache.delete(probeCache.keys().next().value as string);
  probeCache.set(key, answer);
  return answer;
}

/** One flag the package's own parser reads. `name` carries no dashes. */
export interface McpCliOption {
  name: string;
  /** Example value the package prints for a missing argument (`127.0.0.1`). */
  valueHint?: string;
  choices?: string[];
  format?: McpCliFormat;
  secret?: boolean;
  /** Environment variable the package falls back to when the flag is absent. */
  env?: string;
  /** The parser refuses to start without it (`required=True` / `isRequired`). */
  required?: boolean;
}

/** Which package registry the runner resolves against: npx/bunx → npm, uvx → PyPI. */
export type McpCliRegistry = 'npm' | 'pypi';

export type McpCliProbeResult =
  | { ok: true; package: string; version: string; bin?: string; options: McpCliOption[]; files: number }
  | { ok: false; code: 'bad_request' | 'not_found' | 'upstream' | 'too_large'; message: string };

interface PackageSpec {
  name: string;
  version: string;
}

const NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const VERSION_RE = /^[\w.-]+$/;

/** Split `@scope/name@1.2.3` (or `name@latest`) and refuse anything that is not a package spec. */
function splitSpec(raw: string): PackageSpec | null {
  const spec = raw.trim();
  if (!spec || spec.length > 214 || /\s/.test(spec)) return null;
  const at = spec.lastIndexOf('@');
  const scoped = spec.startsWith('@');
  if (!scoped) {
    const name = at === -1 ? spec : spec.slice(0, at);
    const version = at === -1 ? 'latest' : spec.slice(at + 1);
    return NAME_RE.test(name) && VERSION_RE.test(version) ? { name, version } : null;
  }
  const slash = spec.indexOf('/');
  if (slash <= 1) return null;
  // `@scope/name@version`: the version separator is the LAST `@`, never the scope one.
  if (at > slash) {
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    return NAME_RE.test(name) && VERSION_RE.test(version) ? { name, version } : null;
  }
  return NAME_RE.test(spec) ? { name: spec, version: 'latest' } : null;
}

/** Keep a decoded tar in memory: header name/prefix, octal size, then the body. */
function tarFiles(buffer: Buffer): Array<{ name: string; body: Buffer }> {
  const out: Array<{ name: string; body: Buffer }> = [];
  let offset = 0;
  let longName = '';
  while (offset + 512 <= buffer.length && out.length < 4096) {
    const header = buffer.subarray(offset, offset + 512);
    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    if (!rawName) break;
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const sizeText = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + (Number.isFinite(size) && size > 0 ? size : 0);
    if (bodyEnd > buffer.length) break;
    const body = buffer.subarray(bodyStart, bodyEnd);
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/, '');
    } else if (type === '0' || type === '\0' || type === '') {
      out.push({ name: longName || (prefix ? `${prefix}/${rawName}` : rawName), body });
      longName = '';
    }
    offset = bodyStart + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
  }
  return out;
}

const SCANNABLE = /\.(?:js|mjs|cjs)$/;
const SKIPPED = /(?:^|\/)(?:node_modules|public|\.bin)\//;
const SOURCE_MAP = /\.map$/;

/** Read the tarball's JavaScript files up to the scan budget, bin entry first. */
function candidates(files: Array<{ name: string; body: Buffer }>, bin?: string): string[] {
  const js = files.filter(
    (file) => SCANNABLE.test(file.name) && !SKIPPED.test(file.name) && !SOURCE_MAP.test(file.name) && file.body.length <= MAX_FILE_BYTES
  );
  const ordered: typeof js = [];
  if (bin) {
    const hit = js.find((file) => file.name.endsWith(`/${bin}`) || file.name.endsWith(bin));
    if (hit) ordered.push(hit);
  }
  for (const file of js) if (!ordered.includes(file)) ordered.push(file);
  return ordered.map((file) => file.body.toString('utf8'));
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Draft {
  name: string;
  choices: Set<string>;
  number: boolean;
  dsn: boolean;
  secret: boolean;
  required: boolean;
  env?: string;
  valueHint?: string;
}

/** Choices the parser compares against (or falls back to), `parseInt` calls, env fallback and example value. */
function inspect(text: string, name: string, draft: Draft): void {
  const escaped = escapeRe(name);
  const read = `args(?:\\.${escaped}|\\[["'\`]${escaped}["'\`]\\])`;
  for (const match of text.matchAll(new RegExp(`${read}\\s*===\\s*["'\`]([^"'\`]+)["'\`]`, 'g'))) {
    if (draft.choices.size < MAX_CHOICES) draft.choices.add(match[1]!);
  }
  // `args.x === "http" ? "http" : "stdio"` — the ELSE branch is another value the parser handles,
  // but it never sits on the right of `===` (DBHub's default), so the loop above cannot see it.
  const ternary = new RegExp(
    `${read}\\s*===\\s*["'\`][^"'\`]+["'\`]\\s*\\?[^:;\\n]{0,120}:\\s*["'\`]([^"'\`]+)["'\`]`,
    'g'
  );
  for (const match of text.matchAll(ternary)) {
    if (draft.choices.size < MAX_CHOICES) draft.choices.add(match[1]!);
  }
  if (new RegExp(`(?:parseInt|Number)\\(\\s*${read}`).test(text)) draft.number = true;
  const example = new RegExp(
    `requireFlagValue\\(\\s*["'\`]${escaped}["'\`]\\s*,\\s*args\\s*,\\s*["'\`]([^"'\`]+)["'\`]`,
    'g'
  ).exec(text);
  if (example && example[1]!.length <= 120) draft.valueHint = example[1]!;
  if (!draft.env) {
    // DBHub-style resolvers read the flag and its environment fallback side by side.
    const at = text.search(new RegExp(read));
    const anchor =
      at >= 0
        ? at
        : text.search(new RegExp(`requireFlagValue\\(\\s*["'\`]${escaped}["'\`]`));
    if (anchor >= 0) {
      for (const match of text.slice(anchor, anchor + 600).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
        const env = match[1]!;
        const normalized = env.toLowerCase().replace(/_/g, '-');
        if (normalized === name || normalized.endsWith(`-${name}`)) {
          draft.env = env;
          break;
        }
      }
    }
  }
}

function addCandidate(options: Map<string, Draft>, name: string): Draft {
  const existing = options.get(name);
  if (existing) return existing;
  const draft: Draft = {
    name,
    choices: new Set(),
    number: false,
    dsn: DSN_NAME.test(name),
    secret: /password|passphrase|token|secret|dsn/.test(name),
    required: false,
  };
  options.set(name, draft);
  return draft;
}

/** Common shape for an npm or PyPI draft list. */
function finalizeDrafts(drafts: Iterable<Draft>): McpCliOption[] {
  return [...drafts].slice(0, MAX_OPTIONS).map((draft) => {
    // `args.demo === "true"` is a switch, not a two-value dropdown.
    const choices = [...draft.choices].filter((choice) => !/^(?:true|false)$/i.test(choice));
    return {
      name: draft.name,
      ...(draft.valueHint ? { valueHint: draft.valueHint } : {}),
      ...(choices.length > 0 ? { choices } : {}),
      ...(draft.number ? { format: 'number' as const } : {}),
      ...(draft.dsn && !draft.number ? { format: 'dsn' as const } : {}),
      ...(draft.secret ? { secret: true } : {}),
      ...(draft.env ? { env: draft.env } : {}),
      ...(draft.required ? { required: true } : {}),
    };
  });
}

/** Flags parsed by the package's own CLI files; literal flags everywhere when none is found. */
function scan(sources: string[]): McpCliOption[] {
  const cliFiles = sources.filter((text) => text.includes('process.argv'));
  const options = new Map<string, Draft>();
  if (cliFiles.length > 0) {
    for (const text of cliFiles) {
      for (const match of text.matchAll(/\bargs\.([a-z][a-z0-9-]{1,30})\b/g)) {
        const name = match[1]!;
        if (NOISE.has(name) || BUILTIN.has(name)) continue;
        inspect(text, name, addCandidate(options, name));
      }
      for (const match of text.matchAll(/\bargs\[["'`]([a-z][a-z0-9-]{1,30})["'`]\]/g)) {
        const name = match[1]!;
        if (NOISE.has(name) || BUILTIN.has(name)) continue;
        inspect(text, name, addCandidate(options, name));
      }
      // A helper-style parser names the flag in a call instead of reading `args.<name>`.
      for (const match of text.matchAll(/requireFlagValue\(\s*["'`]([a-z][a-z0-9-]{1,30})["'`]/g)) {
        const name = match[1]!;
        if (NOISE.has(name) || BUILTIN.has(name)) continue;
        inspect(text, name, addCandidate(options, name));
      }
      for (const match of text.matchAll(/(["'`])--([a-z][a-z0-9-]{1,30})\1/g)) {
        const name = match[2]!;
        if (NOISE.has(name) || BUILTIN.has(name)) continue;
        addCandidate(options, name);
      }
    }
  } else {
    // No parser shape to anchor on: only quoted `--flag` literals are trustworthy.
    for (const text of sources) {
      for (const match of text.matchAll(/(["'`])--([a-z][a-z0-9-]{1,30})\1/g)) {
        const name = match[2]!;
        if (NOISE.has(name) || BUILTIN.has(name)) continue;
        addCandidate(options, name);
      }
    }
  }
  return finalizeDrafts(options.values());
}

/**
 * Download one published package and list the CLI flags its parser reads.
 *
 * `registry` picks the package source: `npm` for npx / bunx (the default), `pypi` for uvx.
 *
 * @param rawSpec npm: `name`, `name@1.2.3`, `@scope/name`, `@scope/name@latest`;
 *                PyPI: `name`, `name==1.2.3`
 */
export async function probeMcpCli(
  rawSpec: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; registry?: McpCliRegistry } = {}
): Promise<McpCliProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (options.registry === 'pypi') return probePyPI(rawSpec, fetchImpl, timeoutMs);
  const spec = splitSpec(rawSpec);
  if (!spec) return { ok: false, code: 'bad_request', message: 'not a valid npm package spec' };
  const cacheKey = `${spec.name}@${spec.version}`;
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;
  const path = spec.name.startsWith('@') ? spec.name.replace('/', '%2F') : spec.name;

  let meta: Response;
  try {
    meta = await fetchImpl(`${REGISTRY}/${path}/${encodeURIComponent(spec.version)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('npm registry', error) };
  }
  if (meta.status === 404) return { ok: false, code: 'not_found', message: `npm has no ${spec.name}@${spec.version}` };
  if (!meta.ok) return { ok: false, code: 'upstream', message: `npm registry answered HTTP ${meta.status}` };

  let doc: { version?: unknown; bin?: unknown; dist?: { tarball?: unknown } };
  try {
    const body = await meta.text();
    if (body.length > MAX_META_BYTES) return { ok: false, code: 'too_large', message: 'package metadata is too large' };
    doc = JSON.parse(body) as typeof doc;
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('npm registry', error) };
  }
  const tarball = typeof doc.dist?.tarball === 'string' ? doc.dist.tarball : '';
  const version = typeof doc.version === 'string' ? doc.version : spec.version;
  // A published tarball always comes from the registry; anything else is not what npm published.
  if (!/^https:\/\/registry\.npmjs\.org\/[^\s]+$/.test(tarball)) {
    return { ok: false, code: 'upstream', message: 'package metadata carries no registry tarball' };
  }
  const bin = typeof doc.bin === 'string'
    ? doc.bin.replace(/^\.\//, '')
    : doc.bin && typeof doc.bin === 'object' && !Array.isArray(doc.bin)
      ? (Object.values(doc.bin as Record<string, unknown>).find((value) => typeof value === 'string') as string | undefined)?.replace(/^\.\//, '')
      : undefined;

  let archive: Response;
  try {
    archive = await fetchImpl(tarball, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('npm tarball', error) };
  }
  if (!archive.ok) return { ok: false, code: 'upstream', message: `npm tarball answered HTTP ${archive.status}` };
  let compressed: Buffer;
  try {
    compressed = Buffer.from(await archive.arrayBuffer());
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('npm tarball', error) };
  }
  if (compressed.length > MAX_TARBALL_BYTES) return { ok: false, code: 'too_large', message: 'package tarball is too large' };

  let files: Array<{ name: string; body: Buffer }>;
  try {
    files = tarFiles(gunzipSync(compressed));
  } catch {
    return { ok: false, code: 'upstream', message: 'package tarball is not a readable gzip archive' };
  }

  const sources = candidates(files, bin);
  let budget = MAX_SCAN_BYTES;
  const kept: string[] = [];
  for (const text of sources) {
    if (budget <= 0) break;
    kept.push(text);
    budget -= text.length;
  }
  const result = scan(kept);
  const answer: McpCliProbeResult = {
    ok: true,
    package: spec.name,
    version,
    ...(bin ? { bin } : {}),
    options: result,
    files: kept.length,
  };
  // A click re-probes the same package often; the tarball is immutable per version.
  return rememberProbe(cacheKey, answer);
}

// ── PyPI (uvx) ────────────────────────────────────────────────────────────────────────────────
// `uvx name` resolves on PyPI, whose JSON API lists one archive per release. The source archive
// (sdist) is preferred because that is where the argparse / click parser is written; a wheel is
// read only when the release publishes no sdist, and its `.py` members carry the same code.

const PYPI_REGISTRY = 'https://pypi.org/pypi';
const PYPI_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const PY_SKIPPED = /(?:^|\/)(?:tests?|docs?|examples?|\.git)\//;
/** The parser usually lives in one of these; read them before the rest of the package. */
const PY_ENTRY = /(?:^|\/)(?:cli|main|__main__|app|server)\.py$/;

interface PypiSpec {
  name: string;
  version?: string;
}

interface PypiFile {
  filename?: unknown;
  url?: unknown;
  packagetype?: unknown;
}

/** `name`, `name==1.2.3` — the two uvx forms a form field can express. */
function splitPypiSpec(raw: string): PypiSpec | null {
  const spec = raw.trim();
  if (!spec || spec.length > 214 || /\s/.test(spec)) return null;
  const at = spec.indexOf('==');
  const name = at === -1 ? spec : spec.slice(0, at);
  const version = at === -1 ? undefined : spec.slice(at + 2);
  if (!PYPI_NAME_RE.test(name)) return null;
  if (version !== undefined && !VERSION_RE.test(version)) return null;
  return { name, ...(version ? { version } : {}) };
}

/** Source archive first, then a zip sdist, then a wheel — and only from PyPI's own file host. */
function pypiArchive(files: PypiFile[]): { url: string; zip: boolean } | null {
  const published = files.filter(
    (file) =>
      typeof file.url === 'string' &&
      typeof file.filename === 'string' &&
      /^https:\/\/files\.pythonhosted\.org\//.test(file.url)
  );
  const pick = (test: (name: string) => boolean): { url: string; zip: boolean } | null => {
    const hit = published.find((file) => test(file.filename as string));
    if (!hit) return null;
    return { url: hit.url as string, zip: /\.(?:whl|zip)$/i.test(hit.filename as string) };
  };
  return pick((name) => name.endsWith('.tar.gz')) ?? pick((name) => name.endsWith('.zip')) ?? pick((name) => name.endsWith('.whl'));
}

/** The `.py` members worth scanning, parser-looking files first. */
function pyCandidates(files: Array<{ name: string; body: Buffer }>): string[] {
  return files
    .filter((file) => file.name.endsWith('.py') && !PY_SKIPPED.test(file.name) && file.body.length <= MAX_FILE_BYTES)
    .sort((a, b) => Number(PY_ENTRY.test(b.name)) - Number(PY_ENTRY.test(a.name)))
    .map((file) => file.body.toString('utf8'));
}

/** `choices=[…]`, `type=int`, `required=True`, a string default and an `os.environ` fallback. */
function inspectPython(call: string, context: string, name: string, draft: Draft): void {
  const choices = /choices\s*=\s*[\[(]([^\])]*)[\])]/.exec(call);
  if (choices) {
    for (const match of choices[1]!.matchAll(/["']([^"']{1,40})["']/g)) {
      if (draft.choices.size < MAX_CHOICES) draft.choices.add(match[1]!);
    }
  }
  if (/type\s*=\s*(?:int|float)|type\s*=\s*click\.(?:INT|FLOAT)/.test(call)) draft.number = true;
  if (/required\s*=\s*True/.test(call)) draft.required = true;
  const literal = /default\s*=\s*["']([^"']{1,120})["']/.exec(call);
  const numeric = /default\s*=\s*(\d{1,10})\b/.exec(call);
  if (literal) draft.valueHint = literal[1]!;
  else if (numeric) draft.valueHint = numeric[1]!;
  if (!draft.env) {
    for (const match of context.matchAll(/os\.(?:environ\.get|getenv)\(\s*["']([A-Z][A-Z0-9_]+)["']/g)) {
      const env = match[1]!;
      const normalized = env.toLowerCase().replace(/_/g, '-');
      if (normalized === name || normalized.endsWith(`-${name}`)) {
        draft.env = env;
        break;
      }
    }
  }
}

/** The one call starting at `start`, balanced to its closing parenthesis. */
function callSlice(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length && i < start + 2000; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth <= 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start, start + 600);
}

/** argparse / click / typer declarations across the shipped Python files. */
function scanPython(sources: string[]): McpCliOption[] {
  const options = new Map<string, Draft>();
  const patterns = [
    /add_argument\(\s*["'](--[a-z][a-z0-9-]{1,30})["']/g,
    /(?:\.option|Option)\(\s*["'](--[a-z][a-z0-9-]{1,30})["']/g,
  ];
  for (const text of sources) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1]!.slice(2);
        if (BUILTIN.has(name)) continue;
        const start = match.index!;
        inspectPython(callSlice(text, start), text.slice(start, start + 800), name, addCandidate(options, name));
      }
    }
  }
  return finalizeDrafts(options.values());
}

async function probePyPI(rawSpec: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<McpCliProbeResult> {
  const spec = splitPypiSpec(rawSpec);
  if (!spec) return { ok: false, code: 'bad_request', message: 'not a valid PyPI package spec' };
  const cacheKey = `pypi:${spec.name.toLowerCase()}@${spec.version ?? 'latest'}`;
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;
  const base = `${PYPI_REGISTRY}/${encodeURIComponent(spec.name)}`;
  const url = spec.version ? `${base}/${encodeURIComponent(spec.version)}/json` : `${base}/json`;

  let meta: Response;
  try {
    meta = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('PyPI', error) };
  }
  if (meta.status === 404) {
    return { ok: false, code: 'not_found', message: `PyPI has no ${spec.name}${spec.version ? ` ${spec.version}` : ''}` };
  }
  if (!meta.ok) return { ok: false, code: 'upstream', message: `PyPI answered HTTP ${meta.status}` };

  let doc: { info?: { version?: unknown }; urls?: unknown };
  try {
    const body = await meta.text();
    if (body.length > MAX_META_BYTES) return { ok: false, code: 'too_large', message: 'package metadata is too large' };
    doc = JSON.parse(body) as typeof doc;
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('PyPI', error) };
  }

  const version = typeof doc.info?.version === 'string' ? doc.info.version : spec.version ?? 'unknown';
  const archive = pypiArchive(Array.isArray(doc.urls) ? (doc.urls as PypiFile[]) : []);
  if (!archive) return { ok: false, code: 'upstream', message: 'package publishes no source archive' };

  let res: Response;
  try {
    res = await fetchImpl(archive.url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('PyPI archive', error) };
  }
  if (!res.ok) return { ok: false, code: 'upstream', message: `PyPI archive answered HTTP ${res.status}` };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    return { ok: false, code: 'upstream', message: describeFetchFailure('PyPI archive', error) };
  }
  if (bytes.length > MAX_TARBALL_BYTES) return { ok: false, code: 'too_large', message: 'package archive is too large' };

  let files: Array<{ name: string; body: Buffer }>;
  try {
    files = archive.zip
      ? Object.entries(unzipSync(new Uint8Array(bytes))).map(([name, body]) => ({ name, body: Buffer.from(body) }))
      : tarFiles(gunzipSync(bytes));
  } catch {
    return { ok: false, code: 'upstream', message: 'package archive is not readable' };
  }

  let budget = MAX_SCAN_BYTES;
  const kept: string[] = [];
  for (const text of pyCandidates(files)) {
    if (budget <= 0) break;
    kept.push(text);
    budget -= text.length;
  }
  return rememberProbe(cacheKey, {
    ok: true,
    package: spec.name,
    version,
    options: scanPython(kept),
    files: kept.length,
  });
}
