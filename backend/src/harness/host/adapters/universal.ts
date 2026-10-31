import { BaseHostAdapter } from './base.js';
import { UNIVERSAL_SKILLS } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/**
 * Universal (`.agents`) — the shared cross-agent SKILLS directory owner.
 * Location-only entry representing the shared directory every readsUniversal host reads.
 */
export class UniversalAdapter extends BaseHostAdapter {
  readonly id = 'universal' as const;

  protected readonly skillsSpec: SkillsSpec = {
    global: UNIVERSAL_SKILLS.global,
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };
}

export const universalAdapter = new UniversalAdapter();
