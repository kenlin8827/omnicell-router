import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/** Zed — reads the shared cross-agent skills directory. */
export class ZedAdapter extends BaseHostAdapter {
  readonly id = 'zed' as const;
  readonly presence = { command: 'zed', dir: path.join(home(), '.zed') };

  protected readonly skillsSpec: SkillsSpec = {
    global: UNIVERSAL_SKILLS.global,
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };
}

export const zedAdapter = new ZedAdapter();
