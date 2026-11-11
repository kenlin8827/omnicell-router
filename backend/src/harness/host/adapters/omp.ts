import path from 'node:path';
import fs from 'node:fs';
import { BaseHostAdapter, runNativeMarketplaceCmd, type HostMcpSpec } from './base.js';
import { home } from './skills-paths.js';
import type { MarketplaceSyncResult, NativeMarketplaceInfo } from './base.js';
import type { PluginSpec, SkillsSpec } from './types.js';

/**
 * omp (oh-my-pi) — its own `.omp/skills` directory plus the shared cross-agent tree.
 * Relocated by `PI_CONFIG_DIR`.
 */
export class OmpAdapter extends BaseHostAdapter {
  readonly id = 'omp' as const;
  readonly configRootEnv = 'PI_CONFIG_DIR';
  readonly presence = { command: 'omp', dir: path.join(home(), '.omp') };
  /** The vendor's own marketplace catalog layer (`docs/skills/authoring-marketplaces.md`):
   *  `.omp-plugin/marketplace.json`, with `.claude-plugin/marketplace.json` as the fallback. */
  readonly extensionDir = '.omp-plugin';

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

  /**
   * Plugins: omp's OWN marketplace chain (oh-my-pi docs/marketplace.md). A git-backed row is
   * installed by registering the repository (`omp plugin marketplace add <repo>`) and then
   * installing `<plugin>@<marketplace>`; `--scope user|project` selects the landing — user writes
   * `~/.omp/plugins/installed_plugins.json`, project writes `<project>/.omp/plugins/` (project
   * installs shadow user installs of the same package). npm/git/link installs are user-scoped
   * only in omp itself, so an npm-spec row refuses a project landing instead of guessing.
   */
  protected readonly extSpec: PluginSpec = {
    marketplace: {
      commands: [
        ['omp', 'plugin', 'marketplace', 'add', '{repo}'],
        ['omp', 'plugin', 'install', '{plugin}@{marketplace}', '--scope', '{scope}'],
      ],
    },
    // Project-scoped extension drop-ins omp discovers at `<cwd>/.omp/extensions`.
    looseDir: { global: path.join(home(), '.omp', 'extensions'), project: path.join('.omp', 'extensions') },
  };

  override async listNativeMarketplaces(): Promise<NativeMarketplaceInfo[]> {
    const list: NativeMarketplaceInfo[] = [];
    const file = path.join(home(), '.omp', 'marketplaces.json');
    if (!fs.existsSync(file)) return list;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entries = (Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.entries(raw) : [])) as [string, unknown][] | unknown[];
      for (const pair of entries) {
        const [name, val] = Array.isArray(pair) ? pair : [undefined, pair];
        const entry = (val && typeof val === 'object' ? val : {}) as { source?: unknown; repo?: unknown; url?: unknown };
        const source = (entry.source && typeof entry.source === 'object' ? entry.source : entry) as { source?: unknown; repo?: unknown; url?: unknown };
        const repo = typeof source.repo === 'string' ? source.repo : typeof source.url === 'string' ? source.url : typeof entry.repo === 'string' ? entry.repo : undefined;
        if (typeof repo !== 'string') continue;
        const gh = repo.replace(/^(github:|https:\/\/github\.com\/)/, '').replace(/\.git$/, '');
        if (gh.includes('/') && !list.some((m) => m.repo === gh)) {
          list.push({ name: typeof name === 'string' ? name : gh.split('/')[1] ?? gh, repo: gh, type: 'github', origin: 'native-config' });
        }
      }
    } catch {
      // ignore malformed registry
    }
    return list;
  }

  override async syncMarketplaceToHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'add', entry.repo, ['omp', 'plugin', 'marketplace', 'add', entry.repo], execImpl);
  }

  override async removeMarketplaceFromHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'remove', entry.repo, ['omp', 'plugin', 'marketplace', 'remove', entry.repo], execImpl);
  }
}

export const ompAdapter = new OmpAdapter();
