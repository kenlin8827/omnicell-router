import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { UNIVERSAL_SKILLS, xdgConfig } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/** Amp — own XDG skills directory; no MCP or plugin landing. */
export class AmpAdapter extends BaseHostAdapter {
  readonly id = 'amp' as const;
  readonly presence = { command: 'amp', dir: path.join(xdgConfig(), 'agents') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(xdgConfig(), 'agents', 'skills'),
    project: UNIVERSAL_SKILLS.project,
  };
}

export const ampAdapter = new AmpAdapter();
