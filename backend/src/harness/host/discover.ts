import fs from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { HOST_ADAPTERS, isPluginHost, isMcpHost } from './adapters/index.js';
import type { ExtSource } from './adapters/types.js';
import type {
  CopyView,
  DiscoveredArtifact,
  DiscoveredRemoval,
  HarnessHostId,
  HarnessScope,
} from '../types.js';

export type { ExtSource } from './adapters/types.js';

/**
 * Plugin discovery — the observation layer (ADR-0015 §D8.8).
 *
 * The plugin page used to show only what THIS gateway installed (`<env>/harness/manifest.json`),
 * so a machine full of runtime-installed plugins rendered as "nothing installed". Discovery closes
 * that gap, and each row carries its own `removal` descriptor: observation is not ownership, but an
 * installed plugin is an installed plugin — the console can undo it by editing the runtime's
 * own record (the declaration it reads), never by inventing a command for it.
 *
 * Sources come from the HOST ADAPTERS, never from a second path table (§D3 R3): each host declares
 * its own landing once (`adapters/<host>.ts`), and this module only knows the three SHAPES a source
 * can have:
 *   · `config-array` — the array we merge into IS the record (`opencode` v1 `plugin[]` /
 *     `opencode.json`, v2 `plugins[]` / `opencode.jsonc`), read through the same landing ladder the
 *     writer resolves, so discovery can never disagree with install about where the landing is.
 *   · `declared` / `loose-dir` — a package-manager landing materializes into the runtime's own
 *     store: the declaration file lists specs, the lock file answers versions, and loose plugin
 *     files are read from disk as themselves.
 *
 * Parsing is tolerant by construction: a run-time rewrites its own config while we read it (`pi`
 * rewrites `settings.json` from memory), so a malformed or half-written file answers "no rows for
 * this source" and never throws — one broken store must not blank the page. JSONC is parsed as JSONC:
 * `opencode.jsonc` is a documented config spelling, and refusing its comments would report a fully
 * populated install as empty (§D8.8).
 */

export interface DiscoveryDeps {
  exists: (p: string) => boolean;
  readJson: (p: string) => unknown;
  readDir: (p: string) => string[];
  /** A path-shaped entry may name a plugin DIRECTORY, so a row has to know which shape it got. */
  isDir: (p: string) => boolean;
  /** The first `maxBytes` of a text file, or null when it cannot be read. */
  readTextHead: (p: string, maxBytes: number) => string | null;
}

/**
 * Parse a runtime-written config file, tolerating comments and trailing commas.
 *
 * Observation reads what the RUNTIME wrote, and `opencode.jsonc` is a first-class spelling of it —
 * comments are not corruption. Genuine syntax damage still throws, and the caller answers "no rows
 * for this source" (§D8.8), so one hand-broken store never blanks the page.
 */
function parseConfigText(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) throw new SyntaxError(`unparsable config (${errors.length} parse errors)`);
  return value;
}

/**
 * Read only the head of a file: a card line needs the header comment, not a 50 KB bundle.
 *
 * Returns null on any IO failure — an unreadable local plugin still belongs on the page, it just
 * cannot describe itself.
 */
function readTextHead(p: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytes).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the read already answered; a failed close changes nothing we report */
      }
    }
  }
}

const FS_DEPS: DiscoveryDeps = {
  exists: (p) => fs.existsSync(p),
  readJson: (p) => parseConfigText(fs.readFileSync(p, 'utf8')),
  readDir: (p) => fs.readdirSync(p),
  isDir: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readTextHead,
};

/** Loose plugin files the runtimes load directly (type/JS module, never data). */
const LOOSE_FILE = /\.(?:ts|mts|js|mjs|cjs)$/i;

/**
 * Every place a host records its own plugins, for BOTH scopes — asked of the adapters, so a host
 * that has no verified landing contributes nothing and a host with a version ladder contributes every
 * spelling it declares.
 *
 * This is the ADAPTER-side enumeration, deliberately exhaustive: `scanInventory` filters it through
 * `ENABLED_SCOPES` (project discovery is deferred, ADR-0015 §D2 "Scope"), so the project declarations
 * stay the seam instead of being re-spelled when project support ships.
 *
 * Project-scope roots use the gateway process's cwd — the same limitation the skill scan already has
 * (`scanInventory`), and the same reason: the gateway cannot see a shell that launched a runtime
 * somewhere else (ADR-0015 §D2).
 */
export function pluginSources(projectRoot: string = process.cwd()): ExtSource[] {
  const out: ExtSource[] = [];
  const seen = new Set<string>();
  const ctx = { projectRoot };
  const push = (source: ExtSource): void => {
    const id = `${source.kind}|${source.scope}|${source.path}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(source);
  };

  for (const adapter of HOST_ADAPTERS) {
    if (!isPluginHost(adapter)) continue;
    for (const scope of ['global', 'project'] as HarnessScope[]) {
      for (const source of adapter.readSources(ctx, scope)) push(source);
    }
  }
  return out;
}

export interface ParsedSpec {
  /** Same namespace as `ArtifactRecord.canonicalKey` (`npm:<name>` / `git:<url>` / `file:<path>`). */
  canonicalKey: string;
  /** Package name, repo path, or file basename — the row's display identity. */
  name: string;
  version?: string;
  /** Absolute path when the entry points at a file on disk rather than at a package. */
  local?: string;
}

const SPEC_CHARS = /^[@\w./-]+$/;

/** `npm:` / `git:` prefixed specs, bare package names, and path-shaped entries. */
export function parsePluginSpec(spec: string): ParsedSpec | null {
  const raw = spec.trim();
  if (!raw) return null;

  if (raw.startsWith('npm:')) {
    const rest = raw.slice(4);
    // Split the trailing `@version` without mistaking a leading scope `@` for it.
    const at = rest.indexOf('@', 1);
    const name = at === -1 ? rest : rest.slice(0, at);
    if (!name || !SPEC_CHARS.test(name)) return null;
    const version = at === -1 ? undefined : rest.slice(at + 1) || undefined;
    return { canonicalKey: `npm:${name}`, name, ...(version ? { version } : {}) };
  }

  // A runtime-store plugin id (`claude:<name>@<marketplace>`): the MAP key IS the identity — the
  // marketplace part must not be mistaken for an npm version. One `@`, both halves non-empty.
  const claude = /^claude:([^@/\\]+)@([^@/\\]+)$/.exec(raw);
  if (claude) {
    return { canonicalKey: raw, name: claude[1]! };
  }
  if (raw.startsWith('claude:')) return null;

  if (raw.startsWith('git:')) {
    const rest = raw.slice(4).replace(/\.git$/, '').replace(/\/+$/, '');
    if (!rest) return null;
    const name = rest.split('/').pop() ?? rest;
    return { canonicalKey: `git:${rest}`, name };
  }

  // A path-shaped entry (opencode allows a local plugin file in `plugin[]`).
  if (/^(?:\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(raw)) {
    const local = path.resolve(raw);
    const base = path.basename(local).replace(/\.[^.]+$/, '');
    return { canonicalKey: `file:${local}`, name: base || local, local };
  }

  // A bare name is an npm package: `plugin[]` accepts `pkg` and `pkg@1.2.3` without the prefix.
  if (!SPEC_CHARS.test(raw)) return null;
  const at = raw.indexOf('@', 1);
  const name = at === -1 ? raw : raw.slice(0, at);
  if (!name) return null;
  const version = at === -1 ? undefined : raw.slice(at + 1) || undefined;
  return { canonicalKey: `npm:${name}`, name, ...(version ? { version } : {}) };
}

/** `<host>|<canonicalKey>` — the dedupe key against manifest records (one runtime = one artifact). */
export function trackedKey(host: HarnessHostId, canonicalKey: string): string {
  return `${host}|${canonicalKey}`;
}

/** Exact versions the runtime actually installed, from every lock file a discovery source names. */
function lockVersions(sources: ExtSource[], deps: DiscoveryDeps): Map<string, string> {
  const versions = new Map<string, string>();
  for (const lockPath of new Set(sources.map((s) => s.lockPath).filter((p): p is string => !!p))) {
    if (!deps.exists(lockPath)) continue;
    let parsed: unknown;
    try {
      parsed = deps.readJson(lockPath);
    } catch {
      continue;
    }
    const packages = (parsed as { packages?: Record<string, { version?: string }> } | null)?.packages;
    if (!packages || typeof packages !== 'object') continue;
    for (const [key, value] of Object.entries(packages)) {
      // Only top-level installs: `node_modules/pkg` — a nested `…/node_modules/dep` is transitive.
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (!match) continue;
      const version = value?.version;
      if (typeof version === 'string' && version) versions.set(match[1]!, version);
    }
  }
  return versions;
}

/**
 * The package's OWN one-line description, read from its INSTALLED manifest.
 *
 * A discovery row carries no source metadata: the scan never talks to a registry (that would cost
 * one round-trip per row). But the runtime's store already holds the package's `package.json`, and
 * its `description` is the same line the registry would answer — one local read, no network, no
 * scan-length regression. Without it a machine full of runtime-installed plugins renders as a wall
 * of blank cards even though every one of them documents itself on disk.
 */
function packageDescription(source: ExtSource, name: string, deps: DiscoveryDeps): string | null {
  if (!source.lockPath) return null;
  try {
    const dir = path.join(path.dirname(source.lockPath), 'node_modules', name);
    if (!deps.exists(dir)) return null;
    const pkg = deps.readJson(path.join(dir, 'package.json')) as { description?: unknown } | null;
    return oneLine(pkg?.description);
  } catch {
    return null;
  }
}

/** A card line, not a README: fold whitespace and cap the length. */
const DESCRIPTION_MAX = 300;

function oneLine(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}

/** Header-comment budget: enough for every license banner and doc block seen in the wild. */
const HEAD_BYTES = 4096;

/**
 * One-line description for a LOCAL path — a loose `plugins/*.ts` file, a path-shaped `plugin[]` entry.
 *
 * A local path has no manifest and no registry, but its author documents it on disk, in the two
 * places this reads and nowhere else:
 *   · a path naming a DIRECTORY (a plugin shipped as `plugins/foo/`) — that directory's
 *     `package.json` `description`, the same self-description an installed package answers;
 *   · a path naming a FILE — the file's own header comment, which is where a plugin states what it
 *     does before any code runs.
 * Nothing is invented: no header comment and no manifest means null, exactly like a package that
 * ships no description. The FIRST block comment in the head counts as the header.
 */
function localDescription(target: string, deps: DiscoveryDeps): string | null {
  if (deps.isDir(target)) {
    const manifestPath = path.join(target, 'package.json');
    if (!deps.exists(manifestPath)) return null;
    try {
      return oneLine((deps.readJson(manifestPath) as { description?: unknown } | null)?.description);
    } catch {
      return null;
    }
  }
  const head = deps.readTextHead(target, HEAD_BYTES);
  return head === null ? null : headerComment(head);
}

/** A map-store member answers from the installed copy's OWN manifest (`plugin.json`, then
 *  `package.json`): local reads only, and no manifest means null — never a guess. */
function mapDescription(installPath: string, deps: DiscoveryDeps): string | null {
  if (!installPath) return null;
  for (const rel of ['.claude-plugin/plugin.json', 'package.json']) {
    const file = path.join(installPath, rel);
    if (!deps.exists(file)) continue;
    try {
      const desc = (deps.readJson(file) as { description?: unknown } | null)?.description;
      if (typeof desc === 'string' && desc.trim()) return oneLine(desc);
    } catch {
      // an unreadable manifest falls through to the next candidate
    }
  }
  return null;
}

/** The first block comment's first paragraph — the file's own one-liner, decorations stripped. */
function headerComment(head: string): string | null {
  const block = /\/\*\*([\s\S]*?)\*\//.exec(head);
  if (!block) return null;
  const paragraph: string[] = [];
  for (const raw of block[1]!.split('\n')) {
    // Every line of a block comment carries its own `*` margin; the text is what is left.
    const line = raw.replace(/^[\t ]*\*?[\t ]?/, '').trim();
    if (!line) {
      // The first paragraph ends at the first blank line — a README body is not a card line.
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }
  return oneLine(paragraph.join(' '));
}

function copyFor(source: ExtSource, parsed: ParsedSpec): CopyView {
  // A package owns no path of ours: `path` is an identity token, never a location (ADR-0015 §D8.9).
  // A path-shaped entry or a loose file IS a location, so it keeps its real path.
  if (parsed.local) {
    return { scope: source.scope, host: source.host, rootId: 'default', path: parsed.local, state: 'untracked', placement: 'materialized' };
  }
  return {
    scope: source.scope,
    host: source.host,
    rootId: 'default',
    path: `${parsed.canonicalKey}#${source.host}`,
    external: true,
    state: 'untracked',
    placement: 'unverified',
  };
}

/**
 * The inverse of the record this row was read from — computed here, where the shape is known.
 *
 * The SHAPE decides, never the console:
 *   · a loose file the runtime loads from disk (`plugins/*.ts`) IS a location, so its inverse is
 *     the trash — the same op a skill directory gets;
 *   · everything else is one string inside a JSON string array: `plugin[]` (the array our own writer
 *     merges into) or pi's `packages[]` declaration. Dropping that string is the exact inverse of
 *     adding it, and it is also the safe op for a path-shaped `plugin[]` entry: removing the LOAD
 *     reference touches nothing on disk, while deleting a file the entry merely names could take
 *     something other configs also read.
 */
function removalFor(source: ExtSource, spec: string, container?: string): DiscoveredRemoval | undefined {
  if (source.kind === 'loose-dir') return { op: 'trash-path', path: spec };
  if (!container) return undefined;
  // A MAP-shaped runtime store owns its members (claude's `installed_plugins.json`): dropping the
  // member by its store key (NO spec prefix) is the exact inverse of the runtime's own install.
  if (source.containerShape === 'map') return { op: 'drop-server', file: source.path, container, entry: spec };
  return { op: 'drop-entry', file: source.path, container, entry: spec };
}

function rowFor(
  source: ExtSource,
  parsed: ParsedSpec,
  version: string | undefined,
  spec: string,
  container?: string,
  description: string | null = null
): DiscoveredArtifact {
  const removal = removalFor(source, spec, container);
  return {
    kind: 'plugin',
    harness: source.host,
    name: parsed.name,
    // Read from the package's own installed `package.json` (see `packageDescription`): the scan
    // stays local and instant, and an installed plugin still says what it does.
    description,
    copies: [copyFor(source, parsed)],
    hosts: [source.host],
    origin: source.origin,
    observedFrom: source.path,
    ...(version ? { version } : {}),
    canonicalKey: parsed.canonicalKey,
    ...(removal ? { removal } : {}),
  };
}

/**
 * Read every source and answer one row per package/file, minus what the manifest already tracks.
 *
 * `tracked` carries `<host>|<canonicalKey>` for plugin artifacts in the active environment: an
 * plugin this gateway installed must appear ONCE, as its tracked row (with its real state), so
 * the same signal cannot be reported twice under two different owners.
 */
export function discoverPlugins(
  sources: ExtSource[],
  opts: { tracked?: Iterable<string>; trackedNames?: Iterable<string>; deps?: Partial<DiscoveryDeps> } = {}
): DiscoveredArtifact[] {
  const deps: DiscoveryDeps = { ...FS_DEPS, ...(opts.deps ?? {}) };
  const tracked = new Set(opts.tracked ?? []);
  /**
   * `host|name` for git-marketplace artifacts this environment installed. A MAP-shaped store keys
   * its members by `<name>@<marketplace>`, and the marketplace name need not be recorded in older
   * manifests — the plugin NAME is the one shared fact, so it is the fallback that keeps one
   * `claude plugin install` from being counted twice.
   */
  const trackedNames = new Set(opts.trackedNames ?? []);
  const versions = lockVersions(sources, deps);
  const rows: DiscoveredArtifact[] = [];
  const seen = new Set<string>();
  /** One manifest read per (store, package), not per source entry that names it. */
  const described = new Map<string, string | null>();
  const describe = (source: ExtSource, name: string): string | null => {
    const key = `${source.lockPath ?? ''}|${name}`;
    if (!described.has(key)) described.set(key, packageDescription(source, name, deps));
    return described.get(key) ?? null;
  };

  const add = (source: ExtSource, spec: string, container?: string): void => {
    const parsed = parsePluginSpec(spec);
    if (!parsed) return;
    const key = trackedKey(source.host, parsed.canonicalKey);
    if (tracked.has(key) || seen.has(key)) return;
    seen.add(key);
    const version = parsed.version ?? versions.get(parsed.name);
    // Two different self-descriptions, by what the row points at: a package in the runtime's store
    // answers from its own manifest, a local path from the material itself (`localDescription`).
    const description = parsed.local ? localDescription(parsed.local, deps) : describe(source, parsed.name);
    rows.push(rowFor(source, parsed, version, spec, container, description));
  };

  for (const source of sources) {
    if (source.kind === 'loose-dir') {
      if (!deps.exists(source.path)) continue;
      let entries: string[];
      try {
        entries = deps.readDir(source.path);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('.') || !LOOSE_FILE.test(entry)) continue;
        add(source, path.join(source.path, entry));
      }
      continue;
    }

    if (!deps.exists(source.path)) continue;
    let parsed: unknown;
    try {
      parsed = deps.readJson(source.path);
    } catch {
      // A half-written or hand-broken store is reported as "no rows", never as a thrown error.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    // A MAP-shaped runtime store (claude's `installed_plugins.json`): one member per entry, the
    // key `<name>@<marketplace>` IS the identity (`claude:` prefix), the entry value carries the
    // version and the on-disk install path whose own manifest answers the description.
    if (source.containerShape === 'map') {
      const container = Array.isArray(source.key) ? source.key[0] : source.key;
      const map = (parsed as Record<string, unknown>)[container ?? ''] as Record<string, unknown> | undefined;
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      const prefix = source.specPrefix ?? `${source.host}:`;
      for (const [storeKey, value] of Object.entries(map)) {
        if (!storeKey.includes('@') || !value || typeof value !== 'object') continue;
        const entry = value as { version?: unknown; installPath?: unknown };
        const parsedSpec = parsePluginSpec(`${prefix}${storeKey}`);
        if (!parsedSpec) continue;
        // The gateway installed a git-marketplace plugin under a market key this store cannot name;
        // the plugin name is the shared fact. Without this, one install answers two rows.
        if (trackedNames.has(`${source.host}|${parsedSpec.name}`)) continue;
        const key = trackedKey(source.host, parsedSpec.canonicalKey);
        if (tracked.has(key) || seen.has(key)) continue;
        seen.add(key);
        const description = mapDescription(String(entry.installPath ?? ''), deps);
        rows.push(rowFor(source, parsedSpec, typeof entry.version === 'string' ? entry.version : undefined, storeKey, container, description));
      }
      continue;
    }
    // Every container spelling the host declares is read: v1 `plugin[]` and v2 `plugins[]` hold the
    // same signal, and a machine migrated mid-version may still carry both.
    const containers = source.key === undefined ? [] : Array.isArray(source.key) ? source.key : [source.key];
    for (const container of containers) {
      const entries = (parsed as Record<string, unknown>)[container];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) if (typeof entry === 'string') add(source, entry, container);
    }
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.hosts[0]!.localeCompare(b.hosts[0]!));
}

/**
 * One config file a host merges MCP servers into, for one scope.
 *
 * Same rule as `ExtSource` (§D3 R3): the path and the container come from the host adapter, never
 * from a second table here — `adapter.container` IS the key our writer merges into, so the scan and
 * the write can never disagree about where a server lives.
 */
export interface McpSource {
  host: HarnessHostId;
  scope: HarnessScope;
  /** Absolute config path as the adapter resolves it (project spellings resolved by the adapter). */
  path: string;
  container: string;
}

/** `<host>|<serverKey>` — the dedupe key against manifest MCP copies. */
export function mcpTrackedKey(host: HarnessHostId, name: string): string {
  return `${host}|${name}`;
}

/**
 * Every MCP landing the host adapters declare, for BOTH scopes, deduplicated.
 *
 * A host whose `configPath` refuses a scope contributes nothing for it (the refusal is a measured
 * answer, not an error), and only hosts implementing `McpHost` are asked at all — absence of the
 * capability is a type fact (`isMcpHost`), so a skills-only host can never fake a landing.
 *
 * Like `pluginSources`, this answers the adapter side and stays exhaustive; the inventory filters
 * it through `ENABLED_SCOPES` (project discovery is deferred, ADR-0015 §D2 "Scope").
 */
export function mcpSources(projectRoot: string = process.cwd()): McpSource[] {
  const out: McpSource[] = [];
  const seen = new Set<string>();
  const ctx = { projectRoot };
  for (const adapter of HOST_ADAPTERS) {
    if (!isMcpHost(adapter)) continue;
    for (const scope of ['global', 'project'] as HarnessScope[]) {
      const landing = adapter.configPath(ctx, scope);
      if (!landing.ok) continue;
      const abs = path.resolve(landing.path);
      const id = `${scope}|${abs}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ host: adapter.id, scope, path: abs, container: adapter.container });
    }
  }
  return out;
}

/**
 * A one-line description read from the ENTRY ITSELF (`local` → its command, `remote` → its url).
 *
 * Discovery is a local scan: an MCP server has no installed manifest to describe it, and inventing a
 * registry round-trip here would make the page slow and the claim unverified. Null when the entry
 * carries neither — a hand-written record we can neither run nor reach is still listed, it just
 * cannot describe itself.
 */
function mcpDescription(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const command = Array.isArray(record.command)
    ? record.command.filter((part): part is string => typeof part === 'string').join(' ')
    : null;
  const url = typeof record.url === 'string' ? record.url : null;
  const target = command || url;
  const type = typeof record.type === 'string' ? record.type : null;
  if (!target) return type;
  return type ? `${type} · ${target}` : target;
}

/**
 * Read every MCP container and answer one row per SERVER KEY we did not install ourselves.
 *
 * The mirror of `discoverPlugins` for the object-shaped landing (ADR-0015 §D8.10): the runtime's
 * own config is observation, never ownership, and the row carries the exact inverse of the record it
 * was read from (`drop-server` — the member leaves its own file, siblings and comments stay).
 *
 * Tolerant by construction: a config rewritten while we read it answers "no rows" for that source,
 * never throws; a container that is not an object (a hand-typed string, an array) contributes nothing;
 * and a `(host, serverKey)` the manifest already tracks is EXCLUDED, so one install is never reported
 * twice under two different owners.
 */
export function discoverMcp(
  sources: McpSource[],
  opts: { tracked?: Iterable<string>; deps?: Partial<DiscoveryDeps> } = {}
): DiscoveredArtifact[] {
  const deps: DiscoveryDeps = { ...FS_DEPS, ...(opts.deps ?? {}) };
  const tracked = new Set(opts.tracked ?? []);
  const rows: DiscoveredArtifact[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (!deps.exists(source.path)) continue;
    let parsed: unknown;
    try {
      parsed = deps.readJson(source.path);
    } catch {
      // A half-written or hand-broken config is "no rows", never a thrown error.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const container = (parsed as Record<string, unknown>)[source.container];
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;

    for (const [name, entry] of Object.entries(container as Record<string, unknown>)) {
      if (!name) continue;
      const key = mcpTrackedKey(source.host, name);
      if (tracked.has(key) || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        kind: 'mcp',
        harness: source.host,
        name,
        description: mcpDescription(entry),
        copies: [
          {
            scope: source.scope,
            host: source.host,
            rootId: 'default',
            // A server IS a member of this file: the config path is the real location (unlike a
            // package-manager copy, whose path would be an identity token), so the row can show where
            // it was read from and the plan can name the file it edits.
            path: source.path,
            state: 'untracked',
            placement: 'materialized',
          },
        ],
        hosts: [source.host],
        origin: 'runtime-store',
        observedFrom: source.path,
        removal: { op: 'drop-server', file: source.path, container: source.container, entry: name },
      });
    }
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.hosts[0]!.localeCompare(b.hosts[0]!));
}
