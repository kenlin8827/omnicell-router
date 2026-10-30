import path from 'node:path';
import { defineHost } from './declarative.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';

/** Cline — reads the shared cross-agent skills directory; no MCP or plugin landing. */
export const clineAdapter = defineHost('cline', {
  presence: { command: 'code', dir: path.join(home(), '.cline') },
  skills: { global: UNIVERSAL_SKILLS.global, project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
