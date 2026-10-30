import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/** Windsurf — its own skills directory (project `.windsurf/skills`); no MCP or plugin landing. */
export class WindsurfAdapter extends BaseHostAdapter {
  readonly id = 'windsurf' as const;
  readonly extensionDir = '.windsurf';
  readonly presence = { command: 'windsurf', dir: path.join(home(), '.codeium') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.codeium', 'windsurf', 'skills'),
    project: path.join('.windsurf', 'skills'),
  };
}

export const windsurfAdapter = new WindsurfAdapter();
