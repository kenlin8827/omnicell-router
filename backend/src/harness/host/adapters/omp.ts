import path from 'node:path';
import { BaseHostAdapter, type HostMcpSpec } from './base.js';
import { home } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/**
 * omp (oh-my-pi) — its own `.omp/skills` directory plus the shared cross-agent tree.
 * Relocated by `PI_CONFIG_DIR`.
 */
export class OmpAdapter extends BaseHostAdapter {
  readonly id = 'omp' as const;
  readonly configRootEnv = 'PI_CONFIG_DIR';
  readonly presence = { command: 'omp', dir: path.join(home(), '.omp') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.omp', 'skills'),
    project: path.join('.omp', 'skills'),
    readsUniversal: true,
  };

  /**
   * MCP: `~/.omp/agent/mcp.json` for the agent, `.omp/mcp.json` for one project (the schema names both,
   * and the discovery provider reads `mcp.json` from the agent dir). Same `mcpServers` spelling as pi
   * with `${KEY}` references, but the name grammar is the schema's broader
   * `^[a-zA-Z0-9_.-]{1,100}$` — a dot is legal here, unlike pi.
   */
  protected readonly mcpSpec: HostMcpSpec = {
    configGlobal: path.join(home(), '.omp', 'agent', 'mcp.json'),
    configProject: path.join('.omp', 'mcp.json'),
    container: 'mcpServers',
    shape: 'mcpServers',
    secretRef: 'shell',
    namePattern: /^[A-Za-z0-9_.-]{1,100}$/,
  };
}

export const ompAdapter = new OmpAdapter();
