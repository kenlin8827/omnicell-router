import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/** Gemini CLI — own skills directory plus the shared universal directory. */
export class GeminiCliAdapter extends BaseHostAdapter {
  readonly id = 'gemini-cli' as const;
  readonly presence = { command: 'gemini', dir: path.join(home(), '.gemini') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.gemini', 'skills'),
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };
}

export const geminiCliAdapter = new GeminiCliAdapter();
