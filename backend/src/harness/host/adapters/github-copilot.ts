import fs from 'node:fs';
import path from 'node:path';
import { BaseHostAdapter, runNativeMarketplaceCmd, type MarketplaceSyncResult, type NativeMarketplaceInfo } from './base.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';
import type { PluginSpec, SkillsSpec } from './types.js';

/**
 * GitHub Copilot CLI — skills directory plus native plugin marketplace CLI form.
 * Native install commands:
 * - `copilot plugin marketplace add <repo>`
 * - `copilot plugin install <plugin>@<marketplace>`
 */
export class GithubCopilotAdapter extends BaseHostAdapter {
  readonly id = 'github-copilot' as const;
  readonly extensionDir = '.github/plugin';
  readonly presence = { command: 'copilot', dir: path.join(home(), '.vscode') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.copilot', 'skills'),
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };

  protected readonly extSpec: PluginSpec = {
    marketplace: {
      commands: [
        ['copilot', 'plugin', 'marketplace', 'add', '{repo}'],
        ['copilot', 'plugin', 'install', '{plugin}@{marketplace}'],
      ],
    },
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github'];
  }

  override async listNativeMarketplaces(): Promise<NativeMarketplaceInfo[]> {
    const list: NativeMarketplaceInfo[] = [];
    const file = path.join(home(), '.copilot', 'marketplaces.json');
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const entries = Array.isArray(raw) ? raw : (raw.marketplaces ?? []);
        if (Array.isArray(entries)) {
          for (const item of entries) {
            const itemObj = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
            const repo = typeof itemObj.repo === 'string' ? itemObj.repo : '';
            if (repo.includes('/') && !list.some((m) => m.repo === repo)) {
              list.push({
                name: typeof itemObj.name === 'string' ? itemObj.name : repo.split('/')[1] ?? repo,
                repo,
                type: 'github',
                origin: 'native-config',
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return list;
  }

  override async syncMarketplaceToHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'add', entry.repo, ['copilot', 'plugin', 'marketplace', 'add', entry.repo], execImpl);
  }

  override async removeMarketplaceFromHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'remove', entry.repo, ['copilot', 'plugin', 'marketplace', 'remove', entry.repo], execImpl);
  }
}

export const githubCopilotAdapter = new GithubCopilotAdapter();
