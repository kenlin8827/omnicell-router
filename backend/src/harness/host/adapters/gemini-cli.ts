import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/**
 * Gemini CLI — own skills directories plus the shared universal tree. Measured 2026-12 against
 * google-gemini/gemini-cli source (`packages/core/src/config/storage.ts`: `getUserSkillsDir()` →
 * `~/.gemini/skills`, `getProjectSkillsDir()` → `.gemini/skills`; `.agents/skills` is an explicit
 * alias tier on both scopes) and geminicli.com/docs/cli/skills.
 */
export class GeminiCliAdapter extends BaseHostAdapter {
  readonly id = 'gemini-cli' as const;
  readonly presence = { command: 'gemini', dir: path.join(home(), '.gemini') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.gemini', 'skills'),
    project: path.join('.gemini', 'skills'),
    readsUniversal: true,
  };
}

export const geminiCliAdapter = new GeminiCliAdapter();
