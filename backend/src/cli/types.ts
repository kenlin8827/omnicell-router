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
  | 'env'
  | 'version'
  | 'help';

export type SupportedClient = 'opencode' | 'opencode-proxy' | 'claude' | 'codex' | 'pi' | 'dsh';

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

export interface ClientHookStatus {
  name: SupportedClient;
  displayName: string;
  configPath: string;
  exists: boolean;
  hooked: boolean;
  backupExists: boolean;
  details: string;
  /** This client's model slots as declared by the adapter (value undefined/'auto' = intelligent routing) */
  modelSlots: ClientModelSlot[];
  /** Extra concrete models exposed in the client's model switcher (opencode provider models list) */
  extraModels?: string[];
  /**
   * Last-applied model profile (opencode only), echoed from the OCR sidecar
   * meta: profile id + the agent-name → modelRef map actually written into the
   * config ('' id = no profile; the bindings are informational echo — the
   * config's agent node is the live truth).
   */
  profile?: ModelProfileBinding;
}

/** Sidecar echo of the last-applied model profile: which profile filled which agent with which modelRef. */
export interface ModelProfileBinding {
  id: string;
  bindings: Record<string, string>;
}

/**
 * Virtual tier aliases the gateway resolves natively. Every adapter injects
 * these fixed into the client's model switcher, so they must never surface as
 * user-managed extra entries (write dedupe + status echo filter both key off
 * this list).
 */
export const VIRTUAL_AUTO_IDS: ReadonlySet<string> = new Set([
  'auto',
  'auto-lite',
  'auto-plus',
  'auto-pro',
  'auto-ultra',
]);

export interface ClientModelSlot {
  /** Slot key: 'main' | 'opus' | 'sonnet' | 'haiku' | 'fable' (claude), role names (pi subagents); frontend labels via i18n clients.slot* */
  key: string;
  /** Currently pinned model id read from the client config; undefined = auto */
  value?: string;
  /** Recommended default for this role (e.g. haiku → 'auto-lite', opus → 'auto-pro'); used for UI seeding and reset */
  default?: string;
}
