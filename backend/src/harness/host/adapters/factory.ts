import { BaseHostAdapter, runNativeMarketplaceCmd, type MarketplaceSyncResult } from './base.js';
import type { PluginSpec } from './types.js';

/**
 * Factory Droid — native plugin marketplace landing.
 * Native install commands:
 * - `droid plugin marketplace add <url>`
 * - `droid plugin install <plugin>@<marketplace> --scope user`
 */
export class FactoryAdapter extends BaseHostAdapter {
  readonly id = 'factory' as const;
  readonly extensionDir = '.factory-plugin';
  readonly presence = { command: 'droid' };

  protected readonly extSpec: PluginSpec = {
    marketplace: {
      commands: [
        ['droid', 'plugin', 'marketplace', 'add', '{urlGit}'],
        ['droid', 'plugin', 'install', '{plugin}@{marketplace}', '--scope', '{scope}'],
      ],
    },
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github'];
  }

  override async syncMarketplaceToHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'add', entry.repo, ['droid', 'plugin', 'marketplace', 'add', `https://github.com/${entry.repo}.git`], execImpl);
  }

  override async removeMarketplaceFromHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'remove', entry.repo, ['droid', 'plugin', 'marketplace', 'remove', `https://github.com/${entry.repo}.git`], execImpl);
  }
}

export const factoryAdapter = new FactoryAdapter();
