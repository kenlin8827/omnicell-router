import fs from 'node:fs';
import path from 'node:path';
import { BaseHostAdapter, runNativeMarketplaceCmd, type MarketplaceSyncResult, type NativeMarketplaceInfo } from './base.js';
import { home } from './skills-paths.js';
import type { HarnessScope } from '../../types.js';
import type { PluginSpec, SkillsSpec } from './types.js';

/**
 * Claude Code (Anthropic) — skills directory plus native plugin CLI landing.
 * Native installs:
 * - GitHub marketplace: `claude plugin marketplace add <repo>`, `claude plugin install <plugin>@<marketplace>`
 * - npm: `claude plugin install <id> --scope user`
 */
export class ClaudeAdapter extends BaseHostAdapter {
  readonly id = 'claude' as const;
  readonly extensionDir = '.claude-plugin';
  readonly presence = { command: 'claude', dir: path.join(home(), '.claude') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.claude', 'skills'),
    project: path.join('.claude', 'skills'),
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
