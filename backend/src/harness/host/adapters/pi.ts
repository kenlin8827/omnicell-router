import os from 'node:os';
import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';
import type { PluginSpec, SkillsSpec } from './types.js';

const AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

/**
 * Pi — shared skills directory plus native package-manager plugin landing.
 * Pi natively ONLY supports npm plugin installs (`pi install npm:<spec>`).
 */
export class PiAdapter extends BaseHostAdapter {
  readonly id = 'pi' as const;
  readonly extensionDir = 'pi-extension';
  readonly presence = { command: 'pi', dir: path.join(home(), '.pi') };

  protected readonly skillsSpec: SkillsSpec = {
    global: UNIVERSAL_SKILLS.global,
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };

  protected readonly extSpec: PluginSpec = {
    subprocess: 'pi',
    subprocessArgs: (spec: string) => ['install', `npm:${spec}`],
    declared: { global: path.join(AGENT_DIR, 'settings.json'), key: 'packages' },
    looseDir: { global: path.join(AGENT_DIR, 'extensions') },
    lock: path.join(AGENT_DIR, 'npm', 'package-lock.json'),
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['npm'];
  }
}

export const piAdapter = new PiAdapter();
