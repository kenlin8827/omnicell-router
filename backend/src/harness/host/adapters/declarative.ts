import { BaseHostAdapter, extPaths, writeLanding, type HostMcpSpec } from './base.js';
import type { HostAdapter, HostPresence, McpHost, PluginHost, PluginSpec, SkillsHost, SkillsSpec } from './types.js';
import type { HarnessHostId } from '../../types.js';

export { BaseHostAdapter, extPaths, writeLanding };

export interface HostSpec {
  configRootEnv?: string;
  extensionDir?: string;
  presence?: HostPresence;
  skills?: SkillsSpec;
  mcp?: HostMcpSpec;
  ext?: PluginSpec;
}

export type DefinedHost = HostAdapter & Partial<SkillsHost & McpHost & PluginHost>;

class DeclarativeHostAdapter extends BaseHostAdapter {
  readonly id: HarnessHostId;
  readonly configRootEnv?: string;
  readonly extensionDir?: string;
  readonly presence?: HostPresence;
  protected readonly skillsSpec?: SkillsSpec;
  protected readonly mcpSpec?: HostMcpSpec;
  protected readonly extSpec?: PluginSpec;

  constructor(id: HarnessHostId, spec: HostSpec = {}) {
    super();
    this.id = id;
    this.configRootEnv = spec.configRootEnv;
    this.extensionDir = spec.extensionDir;
    this.presence = spec.presence;
    this.skillsSpec = spec.skills;
    this.mcpSpec = spec.mcp;
    this.extSpec = spec.ext;
  }

  supportedPluginSources(): ('github' | 'npm')[] {
    if (this.extSpec?.subprocess === 'pi') return ['npm'];
    if (this.extSpec?.subprocess === 'claude') return ['github', 'npm'];
    if (this.extSpec?.container) return ['github', 'npm'];
    if (this.extSpec?.marketplace) return ['github'];
    return [];
  }
}

export function defineHost(id: HarnessHostId, spec: HostSpec = {}): DefinedHost {
  return new DeclarativeHostAdapter(id, spec) as unknown as DefinedHost;
}

export function defineFullHost(
  id: HarnessHostId,
  spec: {
    skills: SkillsSpec;
    mcp: NonNullable<HostSpec['mcp']>;
    ext: PluginSpec;
    configRootEnv?: string;
    extensionDir?: string;
    presence?: HostPresence;
  }
): SkillsHost & McpHost & PluginHost {
  return new DeclarativeHostAdapter(id, spec) as unknown as SkillsHost & McpHost & PluginHost;
}
