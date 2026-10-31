import { BaseHostAdapter } from './base.js';
import type { PluginSpec } from './types.js';

/**
 * Kimi Code (Moonshot) — plugin-only host adapter.
 * Native install command: `/plugins install <url>` inside an interactive session.
 */
export class KimiAdapter extends BaseHostAdapter {
  readonly id = 'kimi' as const;
  readonly extensionDir = '.kimi-plugin';
  readonly presence = { command: 'kimi' };

  protected readonly extSpec: PluginSpec = {
    marketplace: { commands: [['/plugins', 'install', '{url}']], interactive: true },
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github'];
  }
}

export const kimiAdapter = new KimiAdapter();
