import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';
import type { PluginSpec, SkillsSpec } from './types.js';

/**
 * Cursor — private skills plus shared universal directory.
 * Native plugin command: `/add-plugin <name>` (session-interactive).
 */
export class CursorAdapter extends BaseHostAdapter {
  readonly id = 'cursor' as const;
  readonly extensionDir = '.cursor-plugin';
  readonly presence = { command: 'cursor', dir: path.join(home(), '.cursor') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.cursor', 'skills'),
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };

  protected readonly extSpec: PluginSpec = {
    marketplace: { commands: [['/add-plugin', '{plugin}']], interactive: true },
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github'];
  }
}

export const cursorAdapter = new CursorAdapter();
