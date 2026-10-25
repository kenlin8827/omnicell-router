import { defineHost } from './declarative.js';
import { UNIVERSAL_SKILLS } from './skills-paths.js';

/** Zed — reads the shared cross-agent skills directory; its extension packages are editor-built. */
export const zedAdapter = defineHost('zed', {
  skills: { global: UNIVERSAL_SKILLS.global, project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
