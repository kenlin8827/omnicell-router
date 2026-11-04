import fs from 'node:fs';
import path from 'node:path';
import { home } from './skills-paths.js';
import type { HarnessScope } from '../../types.js';
import { probeClaudeMcpRuntime } from '../claude-mcp-runtime.js';
import type { McpRuntimeHostReport, PluginSpec, SkillsSpec } from './types.js';
import { BaseHostAdapter, runNativeMarketplaceCmd, type HostMcpSpec, type MarketplaceSyncResult, type NativeMarketplaceInfo } from './base.js';
import type { McpLaunch } from '../../spi.js';

/**
 * The env/header map one claude CLI entry carries: a value the operator typed is written verbatim
 * (the registry-form exception, gate 4); every other KEY NAME becomes claude's own `${KEY}`
 * reference, which Claude expands from its environment at startup.
 */
function envValueMap(launch: McpLaunch): Record<string, string> {
  const keys = 'command' in launch ? launch.envKeys : launch.headerKeys;
  const values = 'command' in launch ? launch.envValues : launch.headerValues;
  return Object.fromEntries(
    [...new Set([...(keys ?? []), ...Object.keys(values ?? {})])].map((key) => {
      const typed = values?.[key];
      return [key, typeof typed === 'string' && typed.length > 0 ? typed : `\${${key}}`];
    })
  );
}

/**
 * Claude Code (Anthropic) — skills directory plus native plugin CLI landing.
 * Native installs:
 * - GitHub marketplace: `claude plugin marketplace add <repo>`, `claude plugin install <plugin>@<marketplace>`
 * - npm: `claude plugin install <id> --scope user`
 */

/**
 * MCP landing (ADR-0015 §D8.13): Claude's MCP servers live in its `mcpServers` block
 * (`~/.claude.json`, user scope) — but that file is RUNTIME-OWNED STATE (onboarding flags, project
 * list) that Claude rewrites itself, so this gateway never reserializes it. Writes go through
 * Claude's own CLI (`claude mcp add-json` / `claude mcp remove`, user scope), which is why the
 * landing's `${KEY}` secret references stay consistent: `add-json` stores the entry verbatim, and
 * Claude expands `${VAR}` from its own environment at startup.
 */
export class ClaudeAdapter extends BaseHostAdapter {
  readonly id = 'claude' as const;
  readonly extensionDir = '.claude-plugin';
  readonly presence = { command: 'claude', dir: path.join(home(), '.claude') };

  /** Live status from claude's own health check; writes only ever prove the config member (§D8.8). */
  mcpRuntime(execImpl?: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>): Promise<McpRuntimeHostReport> {
    return probeClaudeMcpRuntime(execImpl);
  }

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.claude', 'skills'),
    project: path.join('.claude', 'skills'),
  };

  protected readonly mcpSpec: HostMcpSpec = {
    configGlobal: path.join(home(), '.claude.json'),
    configProject: '.mcp.json',
    container: 'mcpServers',
    shape: 'mcpServers',
    secretRef: 'shell',
    cli: {
      command: 'claude',
      // `claude mcp add-json <name> '<entry>' --scope user` — the entry is the host's own JSON
      // spelling (stdio `{command, args, env}`; remote `{type: 'http', url, headers}`), composed
      // here so the CLI never sees a shape the runtime would load as broken.
      addArgs(launch, name, scope) {
        if ('command' in launch) {
          const env = envValueMap(launch);
          const entry: Record<string, unknown> = {
            command: launch.command,
            ...(launch.args && launch.args.length > 0 ? { args: [...launch.args] } : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
          };
          return { ok: true, args: ['mcp', 'add-json', name, JSON.stringify(entry), '--scope', scope === 'project' ? 'project' : 'user'] };
        }
        const headers = envValueMap(launch);
        const entry: Record<string, unknown> = {
          type: 'http',
          url: launch.url,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        };
        return { ok: true, args: ['mcp', 'add-json', name, JSON.stringify(entry), '--scope', scope === 'project' ? 'project' : 'user'] };
      },
      removeArgs(name, scope) {
        return { ok: true, args: ['mcp', 'remove', name, '--scope', scope === 'project' ? 'project' : 'user'] };
      },
    },
  };

  protected readonly extSpec: PluginSpec = {
    subprocess: 'claude',
    subprocessArgs: (spec: string, scope: HarnessScope) => [
      'plugin',
      'install',
      spec,
      '--scope',
      scope === 'project' ? 'project' : 'user',
    ],
    marketplace: {
      commands: [
        ['claude', 'plugin', 'marketplace', 'add', '{repo}'],
        ['claude', 'plugin', 'install', '{plugin}@{marketplace}', '--scope', '{scope}'],
      ],
    },
    declared: { global: path.join(home(), '.claude', 'plugins', 'installed_plugins.json'), key: 'plugins' },
    storeShape: 'map',
    specPrefix: 'claude:',
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github', 'npm'];
  }

  override async listNativeMarketplaces(): Promise<NativeMarketplaceInfo[]> {
    const list: NativeMarketplaceInfo[] = [];
    const files = [
      path.join(home(), '.claude', 'plugins', 'known_marketplaces.json'),
      path.join(home(), '.claude', 'plugins', 'installed_plugins.json'),
    ];
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const entries = (obj.marketplaces && typeof obj.marketplaces === 'object' ? obj.marketplaces : obj) as Record<string, unknown>;
        for (const [key, val] of Object.entries(entries)) {
          const valObj = val && typeof val === 'object' ? (val as Record<string, unknown>) : {};
          const source = typeof valObj.source === 'string' ? valObj.source : key;
          const repo = source.replace(/^(github:|https:\/\/github\.com\/)/, '').replace(/\.git$/, '');
          if (repo.includes('/') && !list.some((m) => m.repo === repo)) {
            list.push({
              name: typeof valObj.name === 'string' ? valObj.name : repo.split('/')[1] ?? repo,
              repo,
              type: 'github',
              origin: 'native-config',
            });
          }
        }
      } catch {
        // ignore malformed file
      }
    }
    return list;
  }

  override async syncMarketplaceToHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'add', entry.repo, ['claude', 'plugin', 'marketplace', 'add', entry.repo], execImpl);
  }

  override async removeMarketplaceFromHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'remove', entry.repo, ['claude', 'plugin', 'marketplace', 'remove', entry.repo], execImpl);
  }
}

export const claudeAdapter = new ClaudeAdapter();
