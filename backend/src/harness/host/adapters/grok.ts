import fs from 'node:fs';
import path from 'node:path';
import { BaseHostAdapter, runNativeMarketplaceCmd, type HostMcpSpec, type MarketplaceSyncResult, type NativeMarketplaceInfo } from './base.js';
import { probeGrokMcpRuntime } from '../grok-mcp-runtime.js';
import type { McpRuntimeHostReport } from './types.js';
import { home } from './skills-paths.js';
import type { PluginSpec, SkillsSpec } from './types.js';

/**
 * Grok Build (xAI) — own skills directory plus a native plugin CLI (verified against the
 * vendor's `plugin_cmd.rs` and user guide, 2026-11):
 * - `grok plugin install <owner/repo|git-url> --trust` — installs straight from a repository
 *   (one plugin per repo for our directory-keyed sources). `--trust` is part of the vendor's
 *   REQUIRED grammar, not a confirmation bypass: without it the CLI prints the trust warning
 *   and stops, so a non-interactive run can only ever end in refusal. Gate 3 confirms first,
 *   then the chain runs verbatim.
 * - `grok plugin marketplace add|remove <owner/repo|url>` for operator-source sync.
 * - Marketplace sources persist in `~/.grok/settings.json` under `extraKnownMarketplaces`
 *   (JSON); the `[[marketplace.sources]]` TOML form lives in `~/.grok/config.toml` and is not
 *   read here — this repo has no TOML reader, and a half-read registry would be a guess.
 *
 * Installed plugins materialize into the runtime's own trusted store (`~/.grok/plugins/`),
 * so a subprocess install records an `external` copy — the same shape as pi/claude.
 */

/**
 * MCP landing (ADR-0015 §D8.13): grok keeps its MCP servers in `~/.grok/config.toml` under
 * `[mcp_servers.<name>]` — comment-carrying TOML this gateway must not reserialize (the same rule
 * as codex). Writes run the runtime's own CLI, verified against the vendor's `mcp_cmd.rs`
 * (2026-11-02): `grok mcp add <name> [-e K=V] -- <command…>` for stdio,
 * `grok mcp add --transport http <name> <url> [-H "K: V"]` for remote (headers ARE supported,
 * unlike codex), and `grok mcp remove <name> -s user|project` for the inverse — the scope flag
 * sits BEFORE `--`, everything after it belongs to the server command. Env and header values are
 * TOML literals (no `${KEY}` expansion), so an unnamed secret is refused per target.
 */
export class GrokAdapter extends BaseHostAdapter {
  readonly id = 'grok' as const;
  readonly extensionDir = '.grok-plugin';
  readonly presence = { command: 'grok', dir: path.join(home(), '.grok') };

  // Measured 2026-12 against xai-org/grok-build (the repo renamed from grok-cli): user
  // `~/.grok/skills`, project `.grok/skills`, and the shared tree `~/.agents/skills` /
  // `.agents/skills` scanned at every tier between cwd and repo root (skills.rs:179-200).
  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.grok', 'skills'),
    project: path.join('.grok', 'skills'),
    readsUniversal: true,
  };

  protected readonly extSpec: PluginSpec = {
    marketplace: { commands: [['grok', 'plugin', 'install', '{url}', '--trust']] },
  };

  protected readonly mcpSpec: HostMcpSpec = {
    configGlobal: path.join(home(), '.grok', 'config.toml'),
    configProject: path.join('.grok', 'config.toml'),
    container: 'mcp_servers',
    shape: 'mcpServers',
    format: 'toml',
    literalEnv: true,
    cli: {
      command: 'grok',
      addArgs(launch, name, scope) {
        const scopeArgs = ['-s', scope === 'project' ? 'project' : 'user'];
        if ('command' in launch) {
          // TOML env values are literal: an unnamed secret has no reference syntax to defer with.
          for (const key of launch.envKeys ?? []) {
            if (typeof launch.envValues?.[key] !== 'string' || launch.envValues[key] === '') {
              return { ok: false, reason: `grok env values are literal (no \${KEY} expansion) — provide a value for '${key}'` };
            }
          }
          const envArgs = Object.entries(launch.envValues ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
          return { ok: true, args: ['mcp', 'add', name, ...envArgs, ...scopeArgs, '--', launch.command, ...(launch.args ?? [])] };
        }
        for (const key of launch.headerKeys ?? []) {
          if (typeof launch.headerValues?.[key] !== 'string' || launch.headerValues[key] === '') {
            return { ok: false, reason: `grok header values are literal — provide a value for '${key}'` };
          }
        }
        const headerArgs = Object.entries(launch.headerValues ?? {}).flatMap(([k, v]) => ['--header', `${k}: ${v}`]);
        return { ok: true, args: ['mcp', 'add', '--transport', 'http', name, launch.url, ...headerArgs, ...scopeArgs] };
      },
      removeArgs(name, scope) {
        return { ok: true, args: ['mcp', 'remove', name, '-s', scope === 'project' ? 'project' : 'user'] };
      },
    },
  };

  mcpRuntime(execImpl?: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>): Promise<McpRuntimeHostReport> {
    return probeGrokMcpRuntime(execImpl);
  }

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github'];
  }

  override async listNativeMarketplaces(): Promise<NativeMarketplaceInfo[]> {
    const list: NativeMarketplaceInfo[] = [];
    const file = path.join(home(), '.grok', 'settings.json');
    if (!fs.existsSync(file)) return list;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const known = raw.extraKnownMarketplaces;
      if (!known || typeof known !== 'object' || Array.isArray(known)) return list;
      for (const [name, entry] of Object.entries(known as Record<string, unknown>)) {
        const source = (entry as { source?: Record<string, unknown> } | undefined)?.source;
        if (!source || typeof source !== 'object') continue;
        const kind = source.source;
        if (kind === 'github' && typeof source.repo === 'string' && source.repo.includes('/')) {
          if (!list.some((m) => m.repo === source.repo)) {
            list.push({ name, repo: source.repo, type: 'github', origin: 'native-config' });
          }
        } else if (kind === 'git' && typeof source.url === 'string') {
          const repo = githubRepoOf(source.url);
          if (repo && !list.some((m) => m.repo === repo)) {
            list.push({ name, repo, type: 'github', origin: 'native-config' });
          }
        }
      }
    } catch {
      // ignore
    }
    return list;
  }

  override async syncMarketplaceToHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'add', entry.repo, ['grok', 'plugin', 'marketplace', 'add', entry.repo], execImpl);
  }

  override async removeMarketplaceFromHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    if (entry.type === 'npm') return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
    return runNativeMarketplaceCmd(this.id, 'remove', entry.repo, ['grok', 'plugin', 'marketplace', 'remove', entry.repo], execImpl);
  }
}

/** `https://github.com/<owner>/<repo>(.git)` / `git@github.com:<owner>/<repo>.git` → `owner/repo`. */
function githubRepoOf(url: string): string {
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?\/?$/);
  return match?.[1] ?? '';
}

export const grokAdapter = new GrokAdapter();
