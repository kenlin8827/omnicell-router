import path from 'node:path';
import { defineHost } from './declarative.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';

/** Gemini CLI — own skills directory plus the shared one; no MCP or extension landing. */
export const geminiCliAdapter = defineHost('gemini-cli', {
  presence: { command: 'gemini', dir: path.join(home(), '.gemini') },
  skills: { global: path.join(home(), '.gemini', 'skills'), project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
