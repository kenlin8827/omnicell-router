export type CliAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'web'
  | 'ui'
  | 'desktop'
  | 'setup'
  | 'teardown'
  | 'install-shims'
  | 'uninstall-shims'
  /** Machine-readable shim state for the desktop tray toggle (JSON + exit code). */
  | 'shims-status'
  | 'env'
  | 'version'
  | 'help';

/** Client ids have NO core vocabulary beyond the hooks this build ships
 *  (`CoreClientId`, `cli/clients/reserved.ts`): package hooks arrive with
 *  their adapters and register any string id at runtime (ADR-0027). Core code
 *  must never string-reference a package client id — presentation text,
 *  roster rank and hook exclusivity are declared by the package (manifest
 *  `clientText` / `clientRank`, `ClientAdapter.exclusiveWith`). */

export interface CliOptions {
  action: CliAction;
  client?: string;
  port?: number;
  host?: string;
  daemon?: boolean;
  force?: boolean;
  verbose?: boolean;
  args: string[];
}

export interface DaemonInfo {
  pid: number;
  port: number;
  host: string;
  /** Active environment (book-set) name this gateway booted with. */
  env?: string;
  startTime: string;
  version: string;
}

/** How an adapter applies its hook. `config` rewrites the client's own config
 *  file to point at the gateway; `launcher` publishes proxy launch scripts;
 *  `service-env` sets a managed service's environment; `proxy-config` rewrites
 *  the client's own config file to point at the inbound forward proxy (no API
 *  key, no launcher script — the file IS the takeover, undone on teardown).
 *  The last three are forward-proxy hooks: no key is written, traffic rides the
 *  inbound proxy. */
export type ClientHookKind = 'config' | 'launcher' | 'service-env' | 'proxy-config';

export interface ClientHookStatus {
  name: string;
  displayName: string;
  /** Where the hook lands, stamped by the registry from `ClientAdapter.hookKind`
   *  (`getStatus` does not produce it). */
  hookKind: ClientHookKind;
  /** Brand asset key for the console's logo (`ClientAdapter.icon`); absent =
   *  the client id is the asset name. */
  icon?: string;
  /** Bare product name for a context that implies the variant
   *  (`ClientAdapter.shortName`); absent = `displayName`. */
  shortName?: string;
  /**
   * The package that PROVIDES this hook — absent for a hook this build ships.
   * Stamped by the registry, never by the adapter: only the registry knows
   * which install the row came from, and the console needs the id to point at
   * that package (enable it, open its settings, explain why it is missing).
   */
  pluginId?: string;
  /** Package id that owns this client's model surface (`client-gateway`
   *  catalog editor); absent = the client has no gateway-owned catalog. */
  catalogPlugin?: string;
  /** Passthrough launch verbs this hook publishes (`['cursor','cursor-agent']`)
   *  — the console renders `ocr <verb>`; absent = nothing to launch. */
  launch?: string[];
  /** Retired spellings of `launch` verbs (`ClientLaunchVerb.aliases`): the CLI
   *  refuses them by name, so a copyable `ocr …` hint must never use one. */
  launchAliases?: string[];
  configPath: string;
  exists: boolean;
  hooked: boolean;
  backupExists: boolean;
  details: string;
  /**
   * Installed CLI version probe (absent when the adapter declares no
   * versionCmd or the probe fails). `meetsMin` compares against the adapter's
   * `minVersion` — the oldest release whose config contract the adapter's
   * writes still honor, NOT the newest verified version.
   */
  version?: ClientVersionInfo;

  /** This client's model slots as declared by the adapter (value undefined/'auto' = intelligent routing) */
  modelSlots: ClientModelSlot[];

  /** Extra concrete models exposed in the client's model switcher (opencode provider models list) */
  extraModels?: string[];

  /**
   * Client-owned model ids this hook OBSERVED at runtime. A client that
   * compiles its model table into its binary publishes the list only in its
   * own catalog read, so traffic is the one place it can be learned. The
   * console OFFERS these ids where an operator must name one (a mapping row's
   * left side); it never injects entries into the client's list. Absent =
   * nothing observed yet.
   */
  catalogIds?: string[];

  /** Additional files this adapter owns beyond `configPath` — Cursor publishes
   *  a second launcher for the `cursor-agent` CLI. `exists` is probed at status
   *  time so the console can list every artifact without a second round-trip.
   *  Absent for single-artifact adapters. */
  artifacts?: ClientArtifact[];

  /** Family adapters only: the product instances this machine actually has,
   *  each with its own takeover state. Absent for single-product adapters —
   *  the console then renders the card row exactly as before. */
  products?: ClientProductStatus[];

  /** Last time an inference request was fingerprinted to this client's UA
   *  (ms epoch; the auth gate's in-memory activity ledger). Absent = no
   *  observed traffic since boot. Display-only sort key — never routing
   *  state; the CLI roster table ignores it. */
  lastActiveAt?: number;
  /** Last time `setupClient()` hooked this client successfully (ms epoch).
   *  The sort fallback while a client has sent no traffic yet; absent = not
   *  hooked this boot. */
  lastSetupAt?: number;

  /** Follow-catalog auto-resync queued this client (or its catalogPlugin)
   *  because the last rewrite hit ide_running. Console-only; stamped by the
   *  roster route, never by adapters. */
  followCatalogPending?: boolean;
  /** Open follow-catalog issue for this card (pending or failed). */
  followCatalogIssue?: { status: 'pending' | 'failed'; reason: string };
}

/**
 * One product instance inside a FAMILY adapter — one installed JetBrains IDE,
 * say. Status is per instance because each product owns its own config root
 * and truststore, so "hooked" is never a family-wide verdict: IDEA can be
 * taken over while GoLand is untouched on the same machine.
 */
export interface ClientProductStatus {
  /** Stable product key (`intellij-idea`, `goland`) — the console's row key and the `--product`/`product` action target. */
  id: string;
  displayName: string;
  /** Brand asset key for the product row (`idea`, `goland`); absent = the id is
   *  the asset name. Declared by the hook, never derived by the console. */
  icon?: string;
  /** Build version the install reports (`product-info.json`), when one was found. */
  version: string | null;
  /** The file this product's takeover lands in. */
  configPath: string;
  exists: boolean;
  hooked: boolean;
  backupExists: boolean;
  /** Is the MITM root trusted where THIS product's JBR reads it — its own store
   *  or the vmoptions copy? `unknown` when the probe cannot run. */
  caTrusted: boolean | 'unknown';
  /** The ACP agent this hook provisioned for the product, if any. `name` is the
   *  agent's own identity supplied by the hook — core never names a vendor. */
  agent: { name: string; version: string } | null;
  /** The files this product owns (settings, per-product agents dir) — the
   *  `.ocr-backup` snapshot is reversible state, never an artifact. */
  artifacts: ClientArtifact[];
}

/** A file an adapter owns besides its primary `configPath` (status echo only). */
export interface ClientArtifact {
  path: string;
  exists: boolean;
}

/** Installed-version probe result: current CLI version vs the adapter's minimum-compatible floor. */
export interface ClientVersionInfo {
  current: string;
  min?: string;
  meetsMin: boolean;
}

/**
 * Virtual tier aliases the gateway resolves natively. Adapters inject these
 * into the client's model switcher; a follow-mode setup narrows the block to
 * the subset the selected key's policy admits (`virtualModels`). They must
 * never surface as user-managed extra entries (write dedupe + status echo
 * filter both key off this list).
 */
export const VIRTUAL_AUTO_IDS: ReadonlySet<string> = new Set([
  'auto',
  'lite',
  'plus',
  'pro',
  'ultra',
]);

export interface ClientModelSlot {
  /** Slot key: 'main' | 'opus' | 'sonnet' | 'haiku' | 'fable' (claude), role names (pi subagents); frontend labels via i18n clients.slot* */
  key: string;
  /** Currently pinned model id read from the client config; undefined = auto */
  value?: string;
  /** Recommended default for this role (e.g. haiku → 'lite', opus → 'pro'); used for UI seeding and reset */
  default?: string;
  /** What this role/slot is FOR, when the client itself declares it (agent
   *  frontmatter / live roster). Console-only: feeds the smart-assign decider's
   *  role context. Absent = unknown — never synthesized here, because role sets
   *  are DISCOVERED per client and change with the installed package. */
  description?: string;
}
