import { defineHost } from './declarative.js';
import { UNIVERSAL_SKILLS } from './skills-paths.js';

/** Codex — reads the shared cross-agent skills directory; no MCP or extension landing. */
export const codexAdapter = defineHost('codex', {
  skills: { global: UNIVERSAL_SKILLS.global, project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
