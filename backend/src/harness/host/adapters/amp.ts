import path from 'node:path';
import { defineHost } from './declarative.js';
import { UNIVERSAL_SKILLS, xdgConfig } from './skills-paths.js';

/** Amp — own XDG skills directory (does not read `.agents`); no MCP or plugin landing. */
export const ampAdapter = defineHost('amp', {
  presence: { command: 'amp', dir: path.join(xdgConfig(), 'agents') },
  skills: { global: path.join(xdgConfig(), 'agents', 'skills'), project: UNIVERSAL_SKILLS.project },
});
