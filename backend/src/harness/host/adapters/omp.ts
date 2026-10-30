import path from 'node:path';
import { defineHost } from './declarative.js';
import { home } from './skills-paths.js';

/**
 * omp (oh-my-pi) — its own `.omp/skills` directory plus the shared cross-agent tree.
 *
 * The native provider discovers `<config-dir>/skills/<name>/SKILL.md` at user level and
 * `.omp/skills/<name>/SKILL.md` at project level; the config root defaults to `~/.omp` and is
 * relocated by `PI_CONFIG_DIR` (omp runtime docs: environment-variables.md resolution model).
 * The `agents` provider additionally reads the cross-agent `.agents/skills` tree, so the shared
 * directory is REFERENCED from skills-paths, never re-spelled here. No VERIFIED MCP or plugin
 * landing is declared for omp.
 */
export const ompAdapter = defineHost('omp', {
  configRootEnv: 'PI_CONFIG_DIR',
  presence: { command: 'omp', dir: path.join(home(), '.omp') },
  skills: {
    global: path.join(home(), '.omp', 'skills'),
    project: path.join('.omp', 'skills'),
    readsUniversal: true,
  },
});
