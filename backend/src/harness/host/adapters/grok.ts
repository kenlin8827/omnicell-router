import path from 'node:path';
import { defineHost } from './declarative.js';
import { home } from './skills-paths.js';

/**
 * Grok CLI (xAI) — its own skills directory (`~/.grok/skills`, per the runtime's bundled
 * user guide §Skills: SKILL.md packages, user + project scopes). No VERIFIED MCP or plugin
 * landing yet: the plugin store (`~/.grok/plugins`, config `[plugins]`) is unprobed (§D2/§D8),
 * so the host is served for SKILLS ONLY (`hasMcp`/`hasExt` stay false — the console never
 * offers a landing it cannot write).
 * The runtime ALSO reads `~/.claude/skills` as a lowest-priority fallback; that cross-host
 * readership is not modelled — a copy installed for `claude` is not counted as readable by
 * `grok` (see ADR-0015 §D3).
 */
export const grokAdapter = defineHost('grok', {
  extensionDir: '.grok-plugin',
  presence: { command: 'grok', dir: path.join(home(), '.grok') },
  skills: { global: path.join(home(), '.grok', 'skills'), project: path.join('.grok', 'skills') },
});
