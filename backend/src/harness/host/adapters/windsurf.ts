import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/**
 * Windsurf — its own skills directory (project `.windsurf/skills`) plus the shared cross-agent
 * tree. Measured 2026-12 against docs.devin.ai + windsurf.com/editor/releases: `.agents/skills`
 * support landed v1.9552.21 (2026-02) at user and project level; `.windsurf/skills` SKILL.md
 * loading followed v1.9577.24 (2026-03). The global dir is CHANNEL-dependent (`windsurf` stable
 * vs `windsurf-next`/`windsurf-insiders`); the product now ships as Devin Desktop, which still
 * reads `.windsurf/skills/` as a legacy location. No MCP or plugin landing.
 */
export class WindsurfAdapter extends BaseHostAdapter {
  readonly id = 'windsurf' as const;
  readonly extensionDir = '.windsurf';
  readonly presence = { command: 'windsurf', dir: path.join(home(), '.codeium') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.codeium', 'windsurf', 'skills'),
    project: path.join('.windsurf', 'skills'),
    readsUniversal: true,
  };
}

export const windsurfAdapter = new WindsurfAdapter();
