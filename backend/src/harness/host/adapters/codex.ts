import path from 'node:path';
import { defineHost } from './declarative.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';

/** Codex — reads the shared cross-agent skills directory; no MCP or plugin landing. */
export const codexAdapter = defineHost('codex', {
  presence: { command: 'codex', dir: path.join(home(), '.codex') },
  skills: { global: UNIVERSAL_SKILLS.global, project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
