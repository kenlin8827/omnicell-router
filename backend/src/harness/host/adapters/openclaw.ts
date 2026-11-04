import path from 'node:path';
import { BaseHostAdapter, type HostMcpSpec } from './base.js';
import { home } from './skills-paths.js';
import { openclawConfigPath, openclawStateDir } from '../../../cli/paths.js';
import type { AdapterContext, PluginSpec, SkillsSpec } from './types.js';
import type { McpLaunch } from '../../spi.js';

/**
 * OpenClaw — the agent runtime whose whole harness surface is centralized in ONE JSON5 config:
 * `~/.openclaw/openclaw.json` (relocated by `OPENCLAW_CONFIG_PATH`, which does NOT move the state
 * dir; `OPENCLAW_STATE_DIR` relocates state — skills, plugin registry — but not the config file).
 * The config legally carries comments and trailing commas, so every write path below runs the
 * vendor's own CLI; this gateway only OBSERVES the file (verified against the vendor docs,
 * 2026-11-03).
 *
 * Vendor behavior worth knowing before running its verbs:
 *  - `openclaw mcp add` / `unset` refuse while a local OpenClaw Gateway owns the state directory
 *    (stop-and-retry guidance) — the failure text surfaces verbatim at gate 3.
 *  - `openclaw plugins install` applies through a running Gateway when one is up, or saves for the
 *    next start — both are the vendor's own lifecycle.
 *
 * Skills: `~/.openclaw/skills` global, bare workspace `skills/` project (precedence 1), plus the
 * shared `.agents/skills` trees at both scopes (precedence 2/3) → `readsUniversal: true`.
 */

/**
 * The env/header map one `openclaw mcp add` carries: a value the operator typed is passed verbatim,
 * every other KEY NAME becomes OpenClaw's own `${KEY}` reference, which the runtime expands from
 * its environment at startup (same discipline as claude's landing).
 */
function valueMap(launch: McpLaunch): Record<string, string> {
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
 * MCP landing (ADR-0015 §D8.13, the JSON5 variant): OpenClaw keeps every saved server under
 * `mcp.servers` in `openclaw.json` — a NESTED container in a comment-carrying JSON5 file this
 * gateway must never reserialize. Writes run the vendor's own CLI (verified 2026-11-03):
 * `openclaw mcp add <name> --command C --arg A… --env K=V… [--cwd D]` for stdio,
 * `openclaw mcp add <name> --url U --transport streamable-http --header K=V…` for remote, and
 * `openclaw mcp unset <name>` for the inverse. Definitions are CENTRAL by design ("OpenClaw stores
 * the definitions centrally so those runtimes do not need their own lists") — there is no project
 * landing, so the capability is global-only (§D2). `--no-probe` keeps the save non-interactive:
 * the add probes the live server by default, and a launch whose secrets are `${KEY}` references
 * not yet satisfied in this shell would fail the probe before the entry is ever saved.
 *
 * Grammar verified against the SHIPPED 2026.10.10 binary (2026-11-03): the stdio flags, the nested
 * `mcp.servers` container and `${KEY}` references were confirmed by a real add; `--header` takes
 * `KEY=value` (a `KEY: value` spelling is rejected by the parser — the CLI's own help documents
 * `<key=value>`, which the prose examples' `--header "K: V"` form misstates).
 */
export class OpenClawAdapter extends BaseHostAdapter {
  readonly id = 'openclaw' as const;
  readonly configRootEnv = 'OPENCLAW_STATE_DIR';
  readonly extensionDir = '.openclaw';
  readonly presence = { command: 'openclaw', dir: path.join(home(), '.openclaw') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(home(), '.openclaw', 'skills'),
    project: path.join('skills'),
    readsUniversal: true,
  };

  protected readonly mcpSpec: HostMcpSpec = {
    configGlobal: openclawConfigPath(),
    // No project landing exists; the placeholder keeps the required shape, and the override below
    // refuses the scope so no source or plan ever claims one.
    configProject: openclawConfigPath(),
    container: 'mcp.servers',
    shape: 'mcpServers',
    secretRef: 'shell',
    format: 'json5',
    scopes: ['global'],
    cli: {
      command: 'openclaw',
      addArgs(launch, name, scope) {
        if (scope === 'project') {
          return { ok: false, reason: 'openclaw stores MCP servers centrally in ~/.openclaw/openclaw.json — no project landing' };
        }
        if ('command' in launch) {
          const env = valueMap(launch);
          const argv = [
            'mcp', 'add', name, '--command', launch.command,
            ...(launch.args ?? []).flatMap((arg) => ['--arg', arg]),
            ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
            '--no-probe',
          ];
          return { ok: true, args: argv };
        }
        const headers = valueMap(launch);
        return {
          ok: true,
          args: [
            'mcp', 'add', name, '--url', launch.url, '--transport', 'streamable-http',
            ...Object.entries(headers).flatMap(([key, value]) => ['--header', `${key}=${value}`]),
            '--no-probe',
          ],
        };
      },
      removeArgs(name, scope) {
        if (scope === 'project') {
          return { ok: false, reason: 'openclaw stores MCP servers centrally in ~/.openclaw/openclaw.json — no project landing' };
        }
        return { ok: true, args: ['mcp', 'unset', name] };
      },
    },
  };

  /** Central config only: refusing the project scope keeps discovery and the plan from claiming a
   *  project landing the runtime does not have (the placeholder `configProject` is never asked). */
  override configPath(
    _ctx: AdapterContext,
    scope: 'global' | 'project'
  ): { ok: true; path: string } | { ok: false; reason: string } {
    if (scope === 'project') {
      return { ok: false, reason: 'openclaw stores MCP servers centrally in ~/.openclaw/openclaw.json — no project landing' };
    }
    return { ok: true, path: openclawConfigPath() };
  }

  /**
   * Plugin landing (verified 2026-11-03 against the vendor's install docs): `openclaw plugins
   * install <spec>` with ClawHub names by default, `npm:<package>` / `git:…` source prefixes, and
   * `--marketplace <owner/repo>` for Claude-compatible marketplace plugins. `--force` is the
   * vendor's REQUIRED noninteractive confirmation for any non-ClawHub source — the same
   * gate-3-then-run-verbatim contract as grok's `--trust`, not a bypass of our own gates.
   *
   * Installs are GLOBAL-only: the managed plugin root has no project grammar. The `.openclaw/extensions`
   * trees are auto-discovery ROOTS the runtime reads directly (loose plugin/bundle directories, both
   * scopes) — a read surface, never a write path, hence the explicit `scopes` override so the loose
   * project root cannot advertise an install landing.
   */
  protected readonly extSpec: PluginSpec = {
    // A BARE package name installs through ClawHub — `npm:` selects the registry explicitly
    // (vendor install docs), so an npm-source row must never pass its spec through bare.
    subprocess: 'openclaw',
    subprocessArgs: (spec: string) => ['plugins', 'install', spec.startsWith('npm:') ? spec : `npm:${spec}`, '--force'],
    marketplace: {
      commands: [['openclaw', 'plugins', 'install', '{plugin}', '--marketplace', '{repo}', '--force']],
    },
    looseDir: { global: path.join(openclawStateDir(), 'extensions'), project: path.join('.openclaw', 'extensions') },
    scopes: ['global'],
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github', 'npm'];
  }
}

export const openclawAdapter = new OpenClawAdapter();
