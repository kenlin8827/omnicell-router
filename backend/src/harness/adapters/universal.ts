import { defineHost } from './declarative.js';
import { UNIVERSAL_SKILLS } from './skills-paths.js';

/**
 * Universal (`.agents`) — the shared cross-agent SKILLS directory other runtimes read. It owns that
 * directory (the single declaration every `readsUniversal` host references) and has no MCP or
 * extension landing: it is a location, not a runtime with a plugin API.
 */
export const universalAdapter = defineHost('universal', {
  skills: { global: UNIVERSAL_SKILLS.global, project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
