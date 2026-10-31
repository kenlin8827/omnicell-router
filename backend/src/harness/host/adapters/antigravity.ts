import { BaseHostAdapter } from './base.js';
import type { PluginMarketplaceInstall, PluginSpec } from './types.js';

/**
 * Antigravity (Google) — plugin-only host adapter.
 * Published plugin form is `.antigravity-plugin/plugin.json`.
 * Native install command: `agy plugin install https://github.com/<repo>`.
 */
export class AntigravityAdapter extends BaseHostAdapter {
  readonly id = 'antigravity' as const;
  readonly extensionDir = '.antigravity-plugin';
  readonly presence = { command: 'agy' };

  protected readonly extSpec: PluginSpec = {
    marketplace: { commands: [['agy', 'plugin', 'install', '{url}']] },
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github'];
  }

  override marketplaceSpec(): PluginMarketplaceInstall | null {
    return { commands: [['agy', 'plugin', 'install', '{url}']], interactive: false };
  }
}

export const antigravityAdapter = new AntigravityAdapter();
