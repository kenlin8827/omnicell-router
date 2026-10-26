import path from 'node:path';
import { defineHost } from './declarative.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';

/**
 * GitHub Copilot / VS Code — skills only: the VS Code extension model is vendor-owned and no MCP
 * landing is verified for this host.
 */
export const githubCopilotAdapter = defineHost('github-copilot', {
  presence: { command: 'code', dir: path.join(home(), '.vscode') },
  skills: { global: path.join(home(), '.copilot', 'skills'), project: UNIVERSAL_SKILLS.project, readsUniversal: true },
});
