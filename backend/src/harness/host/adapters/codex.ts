import fs from 'node:fs';
import path from 'node:path';
import { BaseHostAdapter, runNativeMarketplaceCmd, type HostMcpSpec, type MarketplaceSyncResult, type NativeMarketplaceInfo } from './base.js';
import { home, UNIVERSAL_SKILLS } from './skills-paths.js';
import type { PluginSpec, SkillsSpec } from './types.js';

/**
 * Codex (OpenAI) — the shared cross-agent skills tree is its PRIMARY user location; vendor-private
 * dirs measured 2026-12 in openai/codex `codex-rs/ext/skills/src/host_roots.rs`: user
 * `$CODEX_HOME/skills` exists but is deprecated (backward compat), project `.codex/skills`
 * (ConfigLayerSource::Project) and a per-directory `.agents/skills` walk are both read.
 * Global therefore stays the shared tree; the project landing is the vendor dir.
 * Native install commands:
 * - `codex plugin marketplace add <repo> --ref main`
 * - `codex plugin marketplace upgrade <marketplace>`
 * - `codex plugin add <plugin>@<marketplace>`
 */

/**
 * MCP landing (ADR-0015 §D8.13): codex keeps its MCP servers in `~/.codex/config.toml` under
 * `[mcp_servers.<name>]` — comment-carrying TOML this gateway must not reserialize. Writes run the
 * runtime's own CLI: `codex mcp add <name> [--env K=V…] -- <command…>` for stdio,
 * `codex mcp add <name> --url <url>` for streamable HTTP, and `codex mcp remove <name>` for the
 * inverse. Two hard limits of that grammar shape the refusals below: TOML env values are LITERAL
 * (no `${KEY}` expansion, so an unnamed secret cannot be referenced), and remote servers accept no
 * custom headers — only `--bearer-token-env-var`.
 */
export class CodexAdapter extends BaseHostAdapter {
  readonly id = 'codex' as const;
  readonly extensionDir = '.codex-plugin';
  readonly presence = { command: 'codex', dir: path.join(home(), '.codex') };

  protected readonly skillsSpec: SkillsSpec = {
    global: UNIVERSAL_SKILLS.global,
    project: path.join('.codex', 'skills'),
    readsUniversal: true,
  };

  protected readonly mcpSpec: HostMcpSpec = {
    configGlobal: path.join(home(), '.codex', 'config.toml'),
    configProject: path.join('.codex', 'config.toml'),
    container: 'mcp_servers',
    shape: 'mcpServers',
    format: 'toml',
    // The project FILE exists for read observation, but `codex mcp add` has no project-scope
    // grammar (see addArgs below) — a project MCP install has no write path, so the capability
    // is global-only (ADR-0015 §D2).
    scopes: ['global'],
    cli: {
      command: 'codex',
      addArgs(launch, name, scope) {
        // `codex mcp add` has no scope grammar — it always writes the global config.toml. Refusing
        // here keeps the plan, the CLI and the manifest from disagreeing about where it landed.
        if (scope === 'project') {
          return { ok: false, reason: 'codex mcp add has no project-scope grammar — it always writes the global config.toml' };
        }
        if ('command' in launch) {
          // TOML env values are literal: an unnamed secret has no reference syntax to defer with,
          // so the operator must type the value (the registry-form exception, gate 4).
          for (const key of launch.envKeys ?? []) {
            if (typeof launch.envValues?.[key] !== 'string' || launch.envValues[key] === '') {
              return { ok: false, reason: `codex env values are literal (no \${KEY} expansion) — provide a value for '${key}'` };
            }
          }
          const envArgs = Object.entries(launch.envValues ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
          return { ok: true, args: ['mcp', 'add', name, ...envArgs, '--', launch.command, ...(launch.args ?? [])] };
        }
        if ((launch.headerKeys?.length ?? 0) > 0 || Object.keys(launch.headerValues ?? {}).length > 0) {
          return { ok: false, reason: 'codex remote servers carry no custom headers — only --bearer-token-env-var' };
        }
        return { ok: true, args: ['mcp', 'add', name, '--url', launch.url] };
      },
      removeArgs(name, scope) {
        if (scope === 'project') {
          return { ok: false, reason: 'codex mcp remove has no project-scope grammar — it always edits the global config.toml' };
        }
        return { ok: true, args: ['mcp', 'remove', name] };
      },
    },
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
