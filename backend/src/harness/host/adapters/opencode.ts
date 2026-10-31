import path from 'node:path';
import { opencodeConfigCandidates, resolveDefaultPaths } from '../../../opencode/credentials/paths.js';
import { BaseHostAdapter, type HostMcpSpec } from './base.js';
import { UNIVERSAL_SKILLS, xdgConfig } from './skills-paths.js';
import type { PluginSpec, SkillsSpec } from './types.js';

const CONFIG_CANDIDATES: string[] = opencodeConfigCandidates(resolveDefaultPaths());
const CONFIG_DIR = path.dirname(CONFIG_CANDIDATES[0]!);

/**
 * OpenCode — supports all three capabilities (Skills, MCP, Plugins).
 * Native plugin installs:
 * - GitHub: `opencode plugin add github:<repo>`
 * - npm: `opencode.json` config array merge
 */
export class OpencodeAdapter extends BaseHostAdapter {
  readonly id = 'opencode' as const;
  readonly configRootEnv = 'OPENCODE_CONFIG_DIR';
  readonly extensionDir = '.opencode';
  readonly presence = { command: 'opencode', dir: CONFIG_DIR };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(xdgConfig(), 'opencode', 'skills'),
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };

  protected readonly mcpSpec: HostMcpSpec = {
    configGlobal: [path.join(CONFIG_DIR, 'opencode.json')],
    configProject: ['opencode.json'],
    container: 'mcp',
  };

  protected readonly extSpec: PluginSpec = {
    configGlobal: CONFIG_CANDIDATES,
    configProject: ['opencode.json', 'opencode.jsonc'],
    container: 'plugin',
    containerAliases: ['plugins'],
    looseDir: {
      global: [path.join(CONFIG_DIR, 'plugins'), path.join(CONFIG_DIR, 'plugin')],
      project: ['.opencode/plugin', '.opencode/plugins'],
    },
    marketplace: { commands: [['opencode', 'plugin', 'add', 'github:{repo}']] },
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github', 'npm'];
  }
}

export const opencodeAdapter = new OpencodeAdapter();
