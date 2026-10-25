import path from 'node:path';
import { defineHost } from './declarative.js';
import { home } from './skills-paths.js';

/** Claude Code — its own skills directory; no VERIFIED MCP or extension landing (§D2/§D8). */
export const claudeAdapter = defineHost('claude', {
  skills: { global: path.join(home(), '.claude', 'skills'), project: path.join('.claude', 'skills') },
});
