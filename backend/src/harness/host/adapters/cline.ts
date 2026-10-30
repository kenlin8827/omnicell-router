import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/** Cline — reads the shared cross-agent skills directory; no native MCP or plugin landing. */
export class ClineAdapter extends BaseHostAdapter {
  readonly id = 'cline' as const;
  readonly extensionDir = '.clinerules';
  readonly presence = { command: 'code', dir: path.join(home(), '.cline') };

  protected readonly skillsSpec: SkillsSpec = {
    global: UNIVERSAL_SKILLS.global,
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };
}

export const clineAdapter = new ClineAdapter();
