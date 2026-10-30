import type { ExtDiscoveryOrigin, HarnessHostId, HarnessScope, ResolvedRoot } from '../../types.js';

/**
 * Host adaptation surface — one module per harness, capabilities as SEPARATE interfaces
 * (ADR-0015 §D3 R3, §D8.8).
 *
 * WHY capabilities instead of one fat `HarnessHost` with `list/install/uninstall × skill|mcp|ext`:
 * the capability matrix is wildly asymmetric. In the current catalog twelve hosts have a skills
 * location, ONE has a verified MCP landing (opencode) and TWO have a verified plugin landing
 * (opencode, pi). A nine-method flat interface would be 117 slots of which ~72 are `throw new
 * Error('unsupported')`, and a caller still cannot tell "this host cannot do MCP" from "this host
 * forgot to implement it". Capability interfaces make absence a TYPE fact, not a runtime throw.
 *
 * WHY installation verbs are NOT here: install/uninstall are one pipeline — plan → confirm → apply →
 * ledger → claims (ADR-0015 gates 2/3) — implemented once per KIND in `writers/`, not once per host.
 * An adapter that owned `installPlugin` would either duplicate that pipeline fourteen times or
 * become a forwarder. The split is: **the adapter answers WHERE, the writer answers HOW.**
 *
 * WHY skills are not a host capability at all: a skill lands in a DIRECTORY, and one directory is
 * read by up to ten hosts (`readsUniversal` / `skillOwner`). "Install this skill into this host"
 * would invite writing the same tree ten times; skills live on the location level
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
  /** The subprocess install's argument grammar (`claude plugin install <id> --scope user`). */
  subprocessArgs?: (spec: string, scope: HarnessScope) => string[];
  /** The declared store is an object map (`installed_plugins.json`), not a string array. */
  storeShape?: 'map';
  /** Spec prefix grammar for a map store's canonical keys (`claude:`). */
  specPrefix?: string;
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
   * Install-presence markers: how the console answers "is this runtime on this machine". Either
   * marker suffices — the executable on PATH or its config directory on disk. A host whose
   * runtime reads a skills directory is ALSO present once that directory exists (a runtime may
   * keep its skills tree after the executable is gone, and its rows must stay manageable).
   */
  readonly presence?: HostPresence;
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
  /** Declaration files a package-manager install records itself in. */
  declarations(): { file: string; key: string }[];
  /** Lock file answering exact versions, when the host's package manager writes one. */
  lock(): string | undefined;
  /** Loose plugin directories the runtime loads files from directly, for one scope. */
  looseDirs(ctx: AdapterContext, scope: HarnessScope): string[];
  /** Where an install for this host + scope lands (or the refusal reason). */
  writeTarget(ctx: AdapterContext, scope: HarnessScope): PluginWriteTarget;
}

/** A host whose MCP servers merge into a config file it owns. */
export interface McpHost extends HostAdapter {
  /** Container key the server entries merge into. */
  readonly container: string;
  /** The config file an MCP landing writes, or why this scope has none. */
  configPath(
    ctx: AdapterContext,
    scope: HarnessScope
  ): { ok: true; path: string } | { ok: false; reason: string };
}

/** Capability probe — absence is a TYPE fact, so no caller needs a try/catch around "unsupported". */
export function isSkillsHost(adapter: HostAdapter | undefined): adapter is SkillsHost {
  return !!adapter && typeof (adapter as Partial<SkillsHost>).skillRoots === 'function';
}

/** Capability probe for the plugin landing. */
export function isPluginHost(adapter: HostAdapter | undefined): adapter is PluginHost {
  return !!adapter && typeof (adapter as Partial<PluginHost>).readSources === 'function';
}

/** Capability probe for the MCP landing. */
export function isMcpHost(adapter: HostAdapter | undefined): adapter is McpHost {
  return !!adapter && typeof (adapter as Partial<McpHost>).configPath === 'function';
}
