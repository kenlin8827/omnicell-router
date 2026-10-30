import { installArtifact } from './install.js';
import type { HarnessHostId, HarnessKind } from '../types.js';
import type { InstallResult } from './install.js';
import type { HarnessHostAdapter, HostInstallRequest } from './request.js';

/**
 * The host adapters (ADR-0015 §D11). One per harness the gateway writes into; every install —
 * whatever market surface produced the row — funnels through this axis. The concrete classes
 * exist so harness-specific behavior has a home; today they share the base engine (the install
 * orchestrator already parameterizes per host), and the class boundary is where host-specific
 * pre/post steps land as they appear.
 *
 * Channel mapping (`github` | `npm` | `local` → the orchestrator's request shape):
 *  - github: the key passes through verbatim (`github:…`, `mp-<slug>:…`) — the SPI resolves it;
 *  - npm:    the key passes through (`npm:<pkg>`), or a bare spec is promoted to `npm:<spec>`;
 *  - local:  plugin → `manualSpec` (trust `manual`), MCP → `manualPayload`; skill has no local
 *    channel (a skill's bytes always come from a repository or a package).
 */

export class BaseHostAdapter implements HarnessHostAdapter {
  constructor(readonly harness: HarnessHostId) {}

  installPlugin(req: HostInstallRequest): Promise<InstallResult> {
    return this.run(req, 'plugin');
  }

  installMcp(req: HostInstallRequest): Promise<InstallResult> {
    return this.run(req, 'mcp');
  }

  installSkill(req: HostInstallRequest): Promise<InstallResult> {
    return this.run(req, 'skill');
  }

  install(req: HostInstallRequest): Promise<InstallResult> {
    if (req.kind === 'plugin') return this.installPlugin(req);
    if (req.kind === 'mcp') return this.installMcp(req);
    return this.installSkill(req);
  }

  private run(req: HostInstallRequest, kind: HarnessKind): Promise<InstallResult> {
    const base = {
      kind,
      hosts: [this.harness] as HarnessHostId[],
      // A plugin installs into exactly ONE host and the harness is part of its identity (§D5) —
      // the single-host request is the host axis' contract, not the caller's to widen.
      scope: req.scope ?? ('global' as const),
      ...(req.projectRoot ? { projectRoot: req.projectRoot } : {}),
      ...(req.confirm ? { confirm: true } : {}),
      ...(req.listedOn ? { listedOn: req.listedOn } : {}),
      ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}),
      ...(req.execImpl ? { execImpl: req.execImpl } : {}),
    };
    if (req.channel === 'local') {
      if (kind === 'plugin') {
        if (!req.localSpec) return Promise.resolve({ ok: false, code: 'bad_request', message: 'local plugin install requires localSpec' } as const);
        return installArtifact({ ...base, manualSpec: req.localSpec });
      }
      if (kind === 'mcp') {
        if (!req.localName || !req.localLaunch) {
          return Promise.resolve({ ok: false, code: 'bad_request', message: 'local MCP install requires localName and localLaunch' } as const);
        }
        return installArtifact({ ...base, manualPayload: { name: req.localName, launch: req.localLaunch } });
      }
      return Promise.resolve({ ok: false, code: 'bad_request', message: 'skill installs have no local channel — use github or npm' } as const);
    }
    if (!req.key) {
      return Promise.resolve({ ok: false, code: 'bad_request', message: `${req.channel} install requires key` } as const);
    }
    // npm accepts a bare spec (promote it); github keys must already carry their source prefix.
    const key = req.channel === 'npm' && !req.key.includes(':') ? `npm:${req.key}` : req.key;
    return installArtifact({ ...base, key });
  }
}

export class ClaudeHostAdapter extends BaseHostAdapter {
  constructor() {
    super('claude');
  }
}

export class PiHostAdapter extends BaseHostAdapter {
  constructor() {
    super('pi');
  }
}

export class OpencodeHostAdapter extends BaseHostAdapter {
  constructor() {
    super('opencode');
  }
}

const SINGLETONS: Partial<Record<HarnessHostId, HarnessHostAdapter>> = {};

/** The host adapter for one harness. Every served harness gets one — the class boundary is where
 *  host-specific install behavior lands; until it diverges, the base engine serves. */
export function getHostAdapter(harness: HarnessHostId): HarnessHostAdapter {
  const hit = SINGLETONS[harness];
  if (hit) return hit;
  const made =
    harness === 'claude'
      ? new ClaudeHostAdapter()
      : harness === 'pi'
        ? new PiHostAdapter()
        : harness === 'opencode'
          ? new OpencodeHostAdapter()
          : new BaseHostAdapter(harness);
  SINGLETONS[harness] = made;
  return made;
}

export type { HarnessHostAdapter, HostInstallRequest, InstallChannel } from './request.js';
