import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { home } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/**
 * omp (oh-my-pi) — its own `.omp/skills` directory plus the shared cross-agent tree.
 * Relocated by `PI_CONFIG_DIR`.
 */
export class OmpAdapter extends BaseHostAdapter {
  readonly id = 'omp' as const;
  readonly configRootEnv = 'PI_CONFIG_DIR';
  readonly presence = { command: 'omp', dir: path.join(home(), '.omp') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.omp', 'skills'),
    project: path.join('.omp', 'skills'),
    readsUniversal: true,
  };
}

export const ompAdapter = new OmpAdapter();
