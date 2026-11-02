import os from 'node:os';
import path from 'node:path';
import { BaseHostAdapter, type HostMcpSpec } from './base.js';
import { home } from './skills-paths.js';
import type { HarnessScope } from '../../types.js';
import type { PluginSpec, SkillsSpec } from './types.js';

const AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

/**
 * Pi — native skill directories (`~/.pi/agent/skills` user, `.pi/skills` project, per pi's
 * resource-loader: `<agentDir>/skills` and `<cwd>/.pi/skills` are top-level resource roots)
 * plus the shared cross-agent tree (`readsUniversal`). Plugins: pi natively ONLY supports
 * npm plugin installs (`pi install npm:<spec>`).
 */
export class PiAdapter extends BaseHostAdapter {
  readonly id = 'pi' as const;
  readonly extensionDir = 'pi-extension';
  readonly presence = { command: 'pi', dir: path.join(home(), '.pi') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(AGENT_DIR, 'skills'),
    project: path.join('.pi', 'skills'),
    readsUniversal: true,
  };

  /**
   * MCP: `~/.pi/agent/mcp.json` for the agent itself, `.pi/mcp.json` for one project — both merge a
   * server into `mcpServers`, spelled `{command, args, env}` / `{url, headers}` with `${KEY}`
   * references (pi docs/mcp.md). The CLI refuses a dotted name, so the grammar is narrower than the
   * union: `invalid server name "foo.bar" (use letters, digits, "_" and "-")`.
   */
  protected readonly mcpSpec: HostMcpSpec = {
    configGlobal: path.join(AGENT_DIR, 'mcp.json'),
    configProject: path.join('.pi', 'mcp.json'),
    container: 'mcpServers',
    shape: 'mcpServers',
    secretRef: 'shell',
    namePattern: /^[A-Za-z0-9_-]+$/,
  };

  protected readonly extSpec: PluginSpec = {
    subprocess: 'pi',
    // Project scope: `pi install --local` writes the package declaration to `.pi/settings.json`
    // in the cwd (pi docs/packages.md) — honored after project trust; default is user scope.
    subprocessArgs: (spec: string, scope: HarnessScope) => [
      'install',
      `npm:${spec}`,
      ...(scope === 'project' ? ['--local'] : []),
    ],
    declared: {
      global: path.join(AGENT_DIR, 'settings.json'),
      project: path.join('.pi', 'settings.json'),
      key: 'packages',
    },
    // Drop-in extensions: `~/.pi/agent/extensions/` (user) and `.pi/extensions/` (project,
    // auto-discovered after trust — pi docs/extensions.md "Extension Locations").
    looseDir: { global: path.join(AGENT_DIR, 'extensions'), project: path.join('.pi', 'extensions') },
    lock: path.join(AGENT_DIR, 'npm', 'package-lock.json'),
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['npm'];
  }
}

export const piAdapter = new PiAdapter();
