import fs from 'node:fs';
import path from 'node:path';
import { BaseHostAdapter, runNativeMarketplaceCmd, type MarketplaceSyncResult, type NativeMarketplaceInfo } from './base.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';
import type { PluginSpec, SkillsSpec } from './types.js';

/**
 * Codex (OpenAI) — shared cross-agent skills directory plus native plugin CLI.
 * Native install commands:
 * - `codex plugin marketplace add <repo> --ref main`
 * - `codex plugin marketplace upgrade <marketplace>`
 * - `codex plugin add <plugin>@<marketplace>`
 */
export class CodexAdapter extends BaseHostAdapter {
  readonly id = 'codex' as const;
  readonly extensionDir = '.codex-plugin';
  readonly presence = { command: 'codex', dir: path.join(home(), '.codex') };

  protected readonly skillsSpec: SkillsSpec = {
    global: UNIVERSAL_SKILLS.global,
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };

  protected readonly extSpec: PluginSpec = {
    marketplace: {
      commands: [
        ['codex', 'plugin', 'marketplace', 'add', '{repo}', '--ref', 'main'],
        ['codex', 'plugin', 'marketplace', 'upgrade', '{marketplace}'],
        ['codex', 'plugin', 'add', '{plugin}@{marketplace}'],
      ],
    },
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github'];
  }

  override async listNativeMarketplaces(): Promise<NativeMarketplaceInfo[]> {
    const list: NativeMarketplaceInfo[] = [];
    const files = [
      path.join(home(), '.codex', 'plugins', 'marketplaces.json'),
      path.join(home(), '.codex', 'marketplaces.json'),
    ];
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const entries = (Array.isArray(obj) ? obj : (obj.marketplaces ?? obj)) as unknown;
        if (Array.isArray(entries)) {
          for (const item of entries) {
            const itemObj = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
            const repo = typeof itemObj.repo === 'string' ? itemObj.repo : typeof itemObj.source === 'string' ? itemObj.source : '';
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
    return runNativeMarketplaceCmd(this.id, 'add', entry.repo, ['codex', 'plugin', 'marketplace', 'add', entry.repo, '--ref', 'main'], execImpl);
  }

  override async removeMarketplaceFromHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'remove', entry.repo, ['codex', 'plugin', 'marketplace', 'remove', entry.repo], execImpl);
  }
}

export const codexAdapter = new CodexAdapter();
