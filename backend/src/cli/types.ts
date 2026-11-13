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
  /** Passthrough launch verbs — the argument after `ocr` names the TARGET
   *  tool, not a hook id. Never fold these into `SupportedClient`: the hooks
   *  are `cursor-proxy` / `qoder-proxy`. */
  | 'cursor'
  | 'cursor-agent'
  | 'qoder'
  | 'qoder-cli'
  | 'env'
  | 'version'
  | 'help';

export type SupportedClient = 'opencode' | 'opencode-proxy' | 'claude' | 'codex' | 'pi' | 'dsh' | 'omp' | 'grok' | 'kimi' | 'openclaw' | 'workbuddy' | 'cursor-proxy' | 'qoder-proxy' | 'jetbrains-proxy';

export interface CliOptions {
  action: CliAction;
  client?: SupportedClient;
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
  name: SupportedClient;
  displayName: string;
  /** Where the hook lands, stamped by the registry from `ClientAdapter.hookKind`
   *  (`getStatus` does not produce it). */
  hookKind: ClientHookKind;
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

  /** Last-linked model profile (opencode, pi), echoed from the OCR sidecar
   * meta: profile id + the agent-name → modelRef map actually written into the
   * config ('' id = no profile; the bindings are informational echo — the
   * config's agent node is the live truth).
   */
  profile?: ModelProfileBinding;

  /** Additional files this adapter owns beyond `configPath` — Cursor publishes
   *  a second launcher for the `cursor-agent` CLI. `exists` is probed at status
   *  time so the console can list every artifact without a second round-trip.
   *  Absent for single-artifact adapters. */
  artifacts?: ClientArtifact[];

  /** Family adapters only: the product instances this machine actually has,
   *  each with its own takeover state. Absent for single-product adapters —
   *  the console then renders the card row exactly as before. */
  products?: ClientProductStatus[];
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
  /** Installed ACP agent (Junie) version for this product's config root, if any. */
  junieVersion: string | null;
  /** The files this product owns (settings, backup, per-product agents dir). */
  artifacts: ClientArtifact[];
}

/** A file an adapter owns besides its primary `configPath` (status echo only). */
export interface ClientArtifact {
  path: string;
  exists: boolean;
}

/** Sidecar echo of the last-applied model profile: which profile filled which agent with which modelRef. */
export interface ModelProfileBinding {
  id: string;
  bindings: Record<string, string>;
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
