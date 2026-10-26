import path from 'node:path';
import { defineHost } from './declarative.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';

/**
 * Cursor — skills in `.cursor/skills` plus the shared directory. Its extension model is owned by the
 * editor's own marketplace, so no extension landing is declared until ADR-0015 §D8 verifies one.
 */
export const cursorAdapter = defineHost('cursor', {
  presence: { command: 'cursor', dir: path.join(home(), '.cursor') },
  skills: { global: path.join(home(), '.cursor', 'skills'), project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
