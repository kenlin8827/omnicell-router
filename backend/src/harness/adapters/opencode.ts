import path from 'node:path';
import { opencodeConfigCandidates, resolveDefaultPaths } from '../../opencode/credentials/paths.js';
import { defineFullHost } from './declarative.js';
import { UNIVERSAL_SKILLS, xdgConfig } from './skills-paths.js';
import type { ExtensionHost, McpHost, SkillsHost } from './types.js';

/**
 * OpenCode — the only host with all three capabilities (ADR-0015 §D2, §D8.8).
 *
 * SKILLS: `<configRoot>/skills`, plus the shared `.agents/skills` directory (project scope IS
 * `.agents/skills`). `OPENCODE_CONFIG_DIR` relocates the config root.
 *
 * MCP: servers merge into `opencode.json`. v2 also reads `opencode.jsonc`, but moving the MCP write
 * target is an ADR-0010/§D2 decision with its own blast radius, not an adapter refactor.
 *
 * EXTENSIONS: two majors disagree about BOTH spellings, and a gateway has to serve either install:
 *
 *   | | config file | plugin key | loose plugin dir |
 *   | :--- | :--- | :--- | :--- |
 *   | v2 | `opencode.jsonc` | `plugins` | `plugins/` |
 *   | v1 | `opencode.json` | `plugin` | `plugin/` |
 *
 * So the read ladder carries all three config candidates (v2 jsonc, v1 json, legacy `~/.opencode`),
 * the container list carries both keys, and the loose-dir ladder carries both directories. The write
 * landing stays plain JSON: the merge writer refuses a JSONC round-trip (§D8.2), so an install can
 * never silently eat the operator's comments.
 *
 * The config ladder is NOT restated here — `opencodeConfigCandidates` is the credential layer's
 * single candidate table (ADR-0006/0010) and already honours `OPENCODE_CONFIG_DIR`.
 */

const CONFIG_CANDIDATES: string[] = opencodeConfigCandidates(resolveDefaultPaths());
const CONFIG_DIR = path.dirname(CONFIG_CANDIDATES[0]!);

// The spec declares all three capabilities; `defineFullHost`'s parameter type makes that a compile-
// time requirement rather than a comment.
export const opencodeAdapter: SkillsHost & McpHost & ExtensionHost = defineFullHost('opencode', {
  configRootEnv: 'OPENCODE_CONFIG_DIR',
  skills: {
    global: path.join(xdgConfig(), 'opencode', 'skills'),
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  },
  mcp: {
    configGlobal: [path.join(CONFIG_DIR, 'opencode.json')],
    configProject: ['opencode.json'],
    container: 'mcp',
  },
  ext: {
    configGlobal: CONFIG_CANDIDATES,
    configProject: ['opencode.json', 'opencode.jsonc'],
    container: 'plugin',
    containerAliases: ['plugins'],
    looseDir: {
      global: [path.join(CONFIG_DIR, 'plugins'), path.join(CONFIG_DIR, 'plugin')],
      project: ['.opencode/plugin', '.opencode/plugins'],
    },
  },
});
