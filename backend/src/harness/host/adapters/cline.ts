import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/**
 * Cline — vendor-private skills directories plus the shared cross-agent tree. Measured 2026-12 in
 * cline/cline `apps/vscode/src/core/storage/skill-directories.ts`: user `~/.cline/skills` (plus the
 * `~/.agents/skills` alias), project `.cline/skills` (plus `.clinerules/skills`, `.claude/skills`,
 * `.agents/skills`). No native MCP or plugin landing.
 */
export class ClineAdapter extends BaseHostAdapter {
  readonly id = 'cline' as const;
  readonly extensionDir = '.clinerules';
  readonly presence = { command: 'code', dir: path.join(home(), '.cline') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.cline', 'skills'),
    project: path.join('.cline', 'skills'),
    readsUniversal: true,
  };
}

export const clineAdapter = new ClineAdapter();
