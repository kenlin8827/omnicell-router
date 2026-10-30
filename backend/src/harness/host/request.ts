import type { HarnessHostId, HarnessKind } from '../types.js';
import type { McpLaunch } from '../spi.js';
import type { ExecImpl } from './writers/plugin.js';
import type { InstallResult } from './install.js';

/**
 * The HOST axis of the two-axis split (ADR-0015 §D11): everything that WRITES into a client lives
 * here, per harness. A market adapter only discovers rows; when one is installed, the discovery
 * layer hands the row to THIS adapter, and the host owns the whole install — resolve, payload,
 * writer, manifest — through the shared `installArtifact` engine.
 *
 * Channels mirror where a row's bytes can come from:
 *  - `github`   — a repository ref (`github:<owner/repo>[#dir]`, `mp-<slug>:<repo>#<dir>`); the
 *                 source SPI resolves and fetches the tarball.
 *  - `npm`      — a registry package (`npm:<pkg>` or a bare spec); resolved through the npm source.
 *  - `registry` — a dedicated skill registry that serves its own download (`clawhub:<slug>`);
 *                 the key passes through verbatim, like `github`, but the provenance is not GitHub.
 *  - `local`    — no upstream at all: an operator-typed spec (plugin) or launch (MCP), trust `manual`.
 */

export type InstallChannel = 'github' | 'npm' | 'registry' | 'local';

export interface HostInstallRequest {
  kind: HarnessKind;
  channel: InstallChannel;
  /** The portable install handle for `github`/`npm` channels (`<sourceId>:<ref>`). */
  key?: string;
  /** `local` plugin channel: the package spec, inserted verbatim by the host's plugin writer. */
  localSpec?: string;
  /** `local` MCP channel: server name + launch, merged into the runtime's own config. */
  localName?: string;
  localLaunch?: McpLaunch;
  scope?: 'global' | 'project';
  projectRoot?: string;
  /** MCP/plugin gate: without confirmation nothing is written — the answer carries the plan. */
  confirm?: boolean;
  /** Where the row was browsed, for the manifest's provenance (§D9 listedOn). */
  listedOn?: string[];
  fetchImpl?: typeof fetch;
  execImpl?: ExecImpl;
}

export interface HarnessHostAdapter {
  readonly harness: HarnessHostId;
  installPlugin(req: HostInstallRequest): Promise<InstallResult>;
  installMcp(req: HostInstallRequest): Promise<InstallResult>;
  installSkill(req: HostInstallRequest): Promise<InstallResult>;
  /** Dispatch by the request's own kind — the entry market adapters call. */
  install(req: HostInstallRequest): Promise<InstallResult>;
}
