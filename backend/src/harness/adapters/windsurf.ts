import path from 'node:path';
import { defineHost } from './declarative.js';
import { home } from './skills-paths.js';

/** Windsurf — its own skills directory (project `.windsurf/skills`); no MCP or extension landing. */
export const windsurfAdapter = defineHost('windsurf', {
  presence: { command: 'windsurf', dir: path.join(home(), '.codeium') },
  skills: {
    global: path.join(home(), '.codeium', 'windsurf', 'skills'),
    project: path.join('.windsurf', 'skills'),
  },
});
