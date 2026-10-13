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
}

export interface ClientModelSlot {
  /** Slot key: 'main' | 'opus' | 'sonnet' | 'haiku' | 'fable' | 'subagent' (frontend labels via i18n clients.slot*) */
  key: string;
  /** Currently pinned model id read from the client config; undefined = auto */
  value?: string;
  /** Recommended default for this role (e.g. haiku → 'auto-lite', opus → 'auto-pro'); used for UI seeding and reset */
  default?: string;
}
