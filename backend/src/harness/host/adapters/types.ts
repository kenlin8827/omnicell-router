import type { ExtDiscoveryOrigin, HarnessHostId, HarnessKind, HarnessScope, ResolvedRoot } from '../../types.js';
import type { McpEntrySpec } from '../mcp-entry.js';
import type { McpLaunch } from '../../spi.js';

/**
 * Host adaptation surface — one module per harness, capabilities as SEPARATE interfaces
 * (ADR-0015 §D3 R3, §D8.8).
 *
 * WHY capabilities instead of one fat `HarnessHost` with `list/install/uninstall × skill|mcp|ext`:
 * the capability matrix is wildly asymmetric. In the current catalog fifteen hosts have a skills
 * location, EIGHT have a verified MCP landing (four file merges: opencode, pi, omp, kimi; four
 * CLI-materialized: claude, codex, grok, openclaw) and ELEVEN have a verified plugin landing (any
 * declared write path: local config, subprocess or marketplace chain). A nine-method flat interface would be 162
 * slots of which ~120 are `throw new Error('unsupported')`, and a caller still cannot tell "this
 * host cannot do MCP" from "this host forgot to implement it". Capability interfaces make absence a
 * TYPE fact, not a runtime throw.
 *
 * WHY installation verbs are NOT here: install/uninstall are one pipeline — plan → confirm → apply →
 * ledger → claims (ADR-0015 gates 2/3) — implemented once per KIND in `writers/`, not once per host.
 * An adapter that owned `installPlugin` would either duplicate that pipeline eighteen times or
 * become a forwarder. The split is: **the adapter answers WHERE, the writer answers HOW.**
 *
 * WHY skills are not a host capability at all: a skill lands in a DIRECTORY, and one directory is
 * read by up to fourteen hosts (`readsUniversal` / `skillOwner`). "Install this skill into this host"
 * would invite writing the same tree fourteen times; skills live on the location level
 * (`skillRoots` / `skillTarget` on this interface, aggregated by `skillLocationRoots`).
 *
 * WHY one adapter per VERSION is not modelled: `opencode` v1 and v2 differ in landing SPELLINGS
 * (`opencode.json`/`plugin`/`plugin/` vs `opencode.jsonc`/`plugins`/`plugins/`), not in a proven
 * plugin-API split. Plugin identity is `plugin:<harness>:<canonicalKey>` (§D7), so two adapter
 * ids would split one installed plugin into two artifacts — and during a mid-major migration the
 * same machine carries both spellings at once and would report the plugin twice. The version ladder
 * therefore lives INSIDE one adapter (`PluginSpec` path lists), and only a proven API incompatibility
 * would be a reason to change identity — which is an ADR-0015 §D7 amendment, not an adapter detail.
 */

/**
 * Where a discovered row was read from — the runtime's own record, never a manifest entry.
 * (Re-exported here so a host adapter can name its source shape without importing the scanner.)
 */
export type ExtSourceOrigin = ExtDiscoveryOrigin;

/** One place a host records its own plugins, as the scan reads it. */
export interface ExtSource {
  host: HarnessHostId;
  scope: HarnessScope;
  origin: ExtSourceOrigin;
  kind: 'config-array' | 'declared' | 'loose-dir';
  /** The config/declaration file, or the loose-file directory. */
  path: string;
  /**
   * Container key(s) inside `path` — `plugin`/`plugins` for a config array, `packages` for a
   * declaration. A list because a runtime may have renamed the key between majors.
   */
  key?: string | string[];
  /** Lock file resolving this source's `npm:` specs to the version actually installed. */
  lockPath?: string;
  /** Store shape: `array` (a JSON string array, the default) or `map` (claude's
   *  `installed_plugins.json` object map, keyed `<name>@<marketplace>`). */
  containerShape?: 'array' | 'map';
  /** Spec prefix grammar for a map store (`claude:`) — the canonicalKey prefix and the parse
   *  grammar the row's key obeys. */
  specPrefix?: string;
}

/** Everything an adapter needs to answer for a scope. */
export interface AdapterContext {
  /** Project root a project-scope landing resolves against (the gateway process cwd by default). */
  projectRoot: string;
}

/**
 * Data an plugin host declares about its landing — paths are `string | string[]`: a list is a
 * VERSION LADDER (newest spelling first), never a duplicate, so a machine that migrated mid-major
 * still resolves.
 */
export interface PluginSpec {
  /** Array-shaped config landing: every file the runtime reads, newest spelling first. */
  configGlobal?: string | string[];
  configProject?: string | string[];
  /** Container key the host's OWN schema names — the write default. */
  container?: string;
  /** Alternate container spellings an older/newer runtime reads (`plugin` vs `plugins`). */
  containerAliases?: string[];
  /** Declaration file a package-manager landing records itself in. */
  declared?: { global: string | string[]; project?: string | string[]; key: string };
  /** Directory of loose plugin files the runtime loads directly. */
  looseDir?: { global: string | string[]; project?: string | string[] };
  /** Lock file resolving `npm:` specs to the exact version actually installed. */
  lock?: string;
  /** Package-manager command that owns the install (`pi install …`), when the host is one. */
  subprocess?: string;
  /** The subprocess install's argument grammar (`claude plugin install <id> --scope user`). A host
   *  that declares `subprocess` but no grammar refuses npm specs — the writer never invents one. */
  subprocessArgs?: (spec: string, scope: HarnessScope) => string[];
  /** The runtime's OWN marketplace install chain (ADR-0015 §D9 amendment, 2026-10-31): a git-backed
   *  plugin is installed by registering its repository as a marketplace and then installing
   *  `<plugin>@<marketplace>` — never by copying payload files. */
  marketplace?: PluginMarketplaceSpec;
  /** The runtime ships a LOCAL REST install API (ADR-0015 §D9 amendment, 2026-11-01): a loopback
   *  server — booted transiently by the writer — whose `POST <apiPrefix>/plugins {source}` runs
   *  the vendor's own install code (the same manager the TUI slash command drives). The writer
   *  never writes the vendor's state itself. Kimi Code (`kimi web`, kap-server) is the first. */
  webApi?: { serverCommand: string; tokenFile: string; apiPrefix: string };
  /** The declared store is an object map (`installed_plugins.json`), not a string array. */
  storeShape?: 'map';
  /** Spec prefix grammar for a map store's canonical keys (`claude:`). */
  specPrefix?: string;
  /**
   * EXPLICIT scope capability override (ADR-0015 §D2). When absent, `supportedScopes('plugin')`
   *  derives the answer from this spec's own declarations; set it when a declaration is a READ
   *  surface the derivation cannot tell apart from a write path (openclaw's loose
   *  `.openclaw/extensions` discovery roots are auto-discovered by the runtime but never
   *  installed into by this gateway).
   */
  scopes?: readonly HarnessScope[];
}

/**
 * One runtime's native marketplace install chain. Each entry is an argv TEMPLATE; the writer
 * substitutes the tokens below and runs the templates in order, stopping at the first failure.
 * Nothing is ever handed to a shell: the command and every argument stay separate argv items.
 *
 *   {repo}        `owner/repo` of the plugin source
 *   {url}         `https://github.com/owner/repo`
 *   {urlGit}      `https://github.com/owner/repo.git`
 *   {plugin}      the plugin name the source declares (`postman`)
 *   {marketplace} the marketplace name the source declares (`postman`, `claude-plugins-official`)
 *   {scope}       the runtime's own scope word (`user` for global, `project` for project)
 */
export interface PluginMarketplaceSpec {
  commands: string[][];
  /**
   * The runtime installs only from INSIDE a session (cursor's `/add-plugin`). The console still
   * renders the exact command as gate-3 evidence, but apply never spawns it — the operator runs
   * it themselves. (Kimi Code answered this way until 2026-11-01; it now installs through its
   * local web API, §ADR-0015 D9 amendment.)
   */
  interactive?: boolean;
}

/** The chain a runtime declares for git-backed plugin rows, or null when it has no CLI form. */
export interface PluginMarketplaceInstall {
  commands: string[][];
  interactive: boolean;
}

/** Where an install writes, or why it refuses. */
export type PluginWriteTarget =
  | { ok: true; op: 'config'; path: string; container: string }
  | {
      ok: true;
      op: 'subprocess';
      command: string;
      /** The runtime's OWN argument grammar — the adapter spells it, the writer never invents one. */
      args?: (spec: string, scope: HarnessScope) => string[];
    }
  | { ok: false; reason: string };

/**
 * The minimum every host answers: its identity, plus the env var that relocates its config root
 * (`OPENCODE_CONFIG_DIR`, `DSH_HOME`) when it honours one. Present even for hosts whose only wired
 * capability is skills — "this host exists and declares no MCP/plugin landing" is a measured
 * statement, and the console renders it as such instead of an empty row.
 */
export interface HostAdapter {
  readonly id: HarnessHostId;
  /** Env var that relocates this runtime's config root, when it honours one. */
  readonly configRootEnv?: string;
  /**
   * The repository directory this runtime's ecosystem publishes its form in (`pi-extension`,
   * `.claude-plugin`, …). It belongs to the HOST because it is a property of the runtime's
   * distribution convention, spelled once in this host's file; the plugin market pre-fills it and
   * a source registered with it is scanned inside that directory only.
   */
  readonly extensionDir?: string;
  /**
   * Install-presence markers: how the console answers "is this runtime on this machine". Either
   * marker suffices — the executable on PATH or its config directory on disk. A host whose
   * runtime reads a skills directory is ALSO present once that directory exists (a runtime may
   * keep its skills tree after the executable is gone, and its rows must stay manageable).
   */
  readonly presence?: HostPresence;
  /** Verified plugin landing (any declared write path, base.ts). */
  hasPluginLanding?(): boolean;
  /**
   * The scopes an artifact kind can land in for THIS host (ADR-0015 §D2 "Scope") — derived from
   *  the kind's own spec declarations, with `spec.scopes` as the explicit override. An empty list
   *  means the host has no landing for the kind at all. The install writers refuse a scope absent
   *  from this list: landing global while recording `project` would make the manifest, the
   *  inventory and uninstall disagree about where the copy lives.
   */
  supportedScopes(kind: HarnessKind): readonly HarnessScope[];
}

/** One way to detect an installed runtime; `dir` is an absolute path. */
export interface HostPresence {
  /** Executable name probed on PATH (extensionless; the probe adds platform suffixes). */
  command?: string;
  /** The runtime's config/agent directory, e.g. `~/.claude`. */
  dir?: string;
}

/** Where a host's skills land: one directory per scope, relocated by the host's env root when set. */
export interface SkillsSpec {
  global: string;
  project: string;
  /** True when the runtime also reads the shared cross-agent `.agents/skills` directory. */
  readsUniversal?: boolean;
}

/** A host that loads agent skills from directories it reads. */
export interface SkillsHost extends HostAdapter {
  /**
   * Candidate skills roots for one scope, highest precedence first. Global scope may include the
   * cross-agent `.agents/skills` directory when the runtime reads it (`readsUniversal`); project
   * scope lists the private project root first and, for a `readsUniversal` host with a private
   * project root, the shared project tree second (omp reads both `.omp/skills` and `.agents/skills`).
   */
  skillRoots(ctx: AdapterContext, scope: HarnessScope): ResolvedRoot[];
  /** Where one skill NAME lands in this host, refusing anything that escapes its root. */
  skillTarget(
    ctx: AdapterContext,
    scope: HarnessScope,
    name: string
  ): { ok: true; root: ResolvedRoot; path: string } | { ok: false; reason: string };
  /** True when this runtime also reads the shared cross-agent skills directory. */
  readonly readsUniversalSkills: boolean;
}

/** A host that loads plugin code and records it somewhere (config array or its own store). */
export interface PluginHost extends HostAdapter {
  /** Every place this host records its own plugins for one scope. */
  readSources(ctx: AdapterContext, scope: HarnessScope): ExtSource[];
  /** Container keys the host's array record may live under, write default first. */
  containers(): string[];
  /** Declaration files a package-manager install records itself in, for one scope. */
  declarations(ctx: AdapterContext, scope: HarnessScope): { file: string; key: string }[];
  /** Lock file answering exact versions, when the host's package manager writes one. */
  lock(): string | undefined;
  /** Loose plugin directories the runtime loads files from directly, for one scope. */
  looseDirs(ctx: AdapterContext, scope: HarnessScope): string[];
  /** Where an install for this host + scope lands (or the refusal reason). */
  writeTarget(ctx: AdapterContext, scope: HarnessScope): PluginWriteTarget;
  /** The runtime's native marketplace install chain, or null when it has no CLI form. Present on
   *  a host that can install a git-backed plugin by registering the repository as a marketplace. */
  marketplaceSpec?(): PluginMarketplaceInstall | null;
  /** The runtime's local REST install API, or null when it has none. Present on a host whose
   *  vendor ships a loopback server exposing the same install manager as its TUI (kimi web). */
  webApiSpec?(): NonNullable<PluginSpec['webApi']> | null;
}

/**
 * Live MCP server state as the RUNTIME itself reports it (`Mcp.Status` in opencode's HTTP API).
 *
 * This is deliberately NOT a `CopyState`/`CopyPlacement` value: those answer "what do we own and is
 * it intact", while this answers "did the runtime actually connect to the server". A config member
 * can be present and intact (`clean`) and still fail at runtime — the console must not call that
 * healthy (ADR-0015 §D8.8).
 */
export type McpRuntimeStatus = 'connected' | 'pending' | 'disabled' | 'needs_auth' | 'failed';

/**
 * A CLI-materialized MCP landing (ADR-0015 §D8.13, the prerequisite for claude/codex).
 *
 * Claude's `~/.claude.json` is runtime state it rewrites itself and codex's config is
 * comment-carrying TOML — neither may be reserialized by this gateway. Writes therefore run the
 * runtime's OWN CLI (gate 3: the exact argv is echoed in the plan and confirmed before apply; the
 * runtime's store is the truth, so the copy is recorded `external` like a package-manager plugin),
 * and removal runs the runtime's own remove verb.
 */
export interface McpCliSpec {
  /** The host's own CLI executable (the presence command). */
  command: string;
  /** argv for ADDING one server. The launch is validated and the name grammar-checked before this runs. */
  addArgs(launch: McpLaunch, name: string, scope: HarnessScope): { ok: true; args: string[] } | { ok: false; reason: string };
  /** argv for REMOVING one server (the runtime's own inverse verb). */
  removeArgs(name: string, scope: HarnessScope): { ok: true; args: string[] } | { ok: false; reason: string };
}

export interface McpRuntimeServer {
  name: string;
  status: McpRuntimeStatus;
  /** The runtime's own failure text (`failed` / `needs_auth`); absent for other states. */
  error?: string;
}

/** One host's live answer. `reachable: false` means "no live status", never "servers failed". */
export interface McpRuntimeHostReport {
  reachable: boolean;
  /** Why the runtime could not answer (service absent, transport error, unsupported endpoint). */
  message?: string;
  servers: McpRuntimeServer[];
}

/** A host whose MCP servers merge into a config file it owns. */
export interface McpHost extends HostAdapter {
  /** Container key the server entries merge into. */
  readonly container: string;
  /** Entry spelling + secret-reference syntax this runtime requires (ADR-0015 §D8 landing gate). */
  mcpEntrySpec(): McpEntrySpec;
  /** Server-name grammar this runtime accepts for a new key. */
  mcpNamePattern(): RegExp;
  /** Refuse unnamed secret keys: this runtime's config has no env/header expansion. */
  mcpLiteralEnv?(): boolean;
  /** Config-file syntax this landing reads; absent = plain JSON. `json5` marks a JSON5 config whose
   *  only legal writer is the runtime's own CLI (§D8.13) — a file merge is refused, never lossy. */
  mcpLandingFormat?(): 'json' | 'toml' | 'json5';
  /**
   * The runtime's own MCP CLI, when writes are CLI-materialized (§D8.13): present = the writer
   * composes the runtime's add/remove argv instead of merging the config file, and the copy is
   * recorded `external`. Absent = the config-merge write mode.
   */
  mcpCliSpec?(): McpCliSpec | null;
  /** The config file an MCP landing writes, or why this scope has none. */
  configPath(
    ctx: AdapterContext,
    scope: HarnessScope
  ): { ok: true; path: string } | { ok: false; reason: string };
  /**
   * Live server status from the runtime's own service, when it exposes one. Absent = this host has
   * no status surface, and the console keeps its on-disk claim only (it never invents a state).
   */
  mcpRuntime?(): Promise<McpRuntimeHostReport>;
}

/** Capability probe — absence is a TYPE fact, so no caller needs a try/catch around "unsupported". */
export function isSkillsHost(adapter: HostAdapter | undefined): adapter is SkillsHost {
  return (
    !!adapter &&
    typeof (adapter as Partial<SkillsHost>).skillRoots === 'function' &&
    ((adapter as { isSkillsSupported?: () => boolean }).isSkillsSupported?.() ?? true)
  );
}

/** Capability probe for the plugin landing — any declared write path, local or subprocess or
 *  marketplace chain (`hasPluginLanding`, base.ts). */
export function isPluginHost(adapter: HostAdapter | undefined): adapter is PluginHost {
  return !!adapter && (adapter.hasPluginLanding?.() ?? false);
}

/** Capability probe for the MCP landing. */
export function isMcpHost(adapter: HostAdapter | undefined): adapter is McpHost {
  return (
    !!adapter &&
    typeof (adapter as Partial<McpHost>).configPath === 'function' &&
    ((adapter as { isMcpSupported?: () => boolean }).isMcpSupported?.() ?? true)
  );
}
