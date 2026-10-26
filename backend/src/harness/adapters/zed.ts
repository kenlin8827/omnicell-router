import path from 'node:path';
import { defineHost } from './declarative.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';

/** Zed — reads the shared cross-agent skills directory; its extension packages are editor-built. */
export const zedAdapter = defineHost('zed', {
  presence: { command: 'zed', dir: path.join(home(), '.zed') },
  skills: { global: UNIVERSAL_SKILLS.global, project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
