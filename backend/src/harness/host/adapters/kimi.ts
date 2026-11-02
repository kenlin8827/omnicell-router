import path from 'node:path';
import { BaseHostAdapter, type HostMcpSpec } from './base.js';
import { probeKimiMcpRuntime } from '../kimi-mcp-runtime.js';
import { home } from './skills-paths.js';
import type { McpRuntimeHostReport, PluginSpec, SkillsSpec } from './types.js';
/**
 * Kimi Code (Moonshot) — plugin host whose install surface is the vendor's LOCAL WEB API.
 * `kimi web` (kap-server) exposes `POST /api/v1/plugins {source}`, the same PluginManager the
 * TUI `/plugins install` slash command drives — verified against the MoonshotAI/kimi-code source
 * and the shipped v2.4.1 binary (2026-11-01). The slash command itself stays session-only
 * (`kimi -p` does not parse slash commands, proven by experiment); the web API is the vendor's
 * non-interactive form of the same install — the web UI calls these routes too. The writer boots
 * a transient server, posts the source, and tears the server down (writers/kimi-web.ts), so the
 * install runs entirely in vendor code and this adapter never writes vendor state. Cursor is now
 * the only session-only plugin runtime.
 * Skills land in `~/.kimi-code/skills` (relocated by `KIMI_CODE_HOME`), and the runtime also reads
 * the shared cross-agent `.agents/skills` tree.
 */

/** Kimi's config root, relocated by the vendor's own `KIMI_CODE_HOME`. */
function kimiHome(): string {
  const override = process.env.KIMI_CODE_HOME?.trim();
  return override ? path.resolve(override) : path.join(home(), '.kimi-code');
}

/**
 * MCP landing (ADR-0015 §D8): a DEDICATED plain-JSON config file the runtime only reads —
 * `~/.kimi-code/mcp.json` (relocated by `KIMI_CODE_HOME`), project `.kimi-code/mcp.json` — with the
 * standard `mcpServers` spelling (`{command, args, env}` stdio; `{url, headers}` HTTP; the legacy
 * `transport: 'sse'` form is never produced). Verified against the vendor docs (2026-11-02).
 * Kimi documents NO env/header expansion, so the landing refuses an unnamed secret key instead of
 * writing a reference the runtime would never resolve (`literalEnv`).
 */
export class KimiAdapter extends BaseHostAdapter {
  readonly id = 'kimi' as const;
  readonly configRootEnv = 'KIMI_CODE_HOME';
  readonly extensionDir = '.kimi-plugin';
  readonly presence = { command: 'kimi', dir: path.join(home(), '.kimi-code') };

  protected readonly mcpSpec: HostMcpSpec = {
    configGlobal: path.join(kimiHome(), 'mcp.json'),
    configProject: path.join('.kimi-code', 'mcp.json'),
    container: 'mcpServers',
    shape: 'mcpServers',
    literalEnv: true,
  };

  /** Live status from kimi's own per-server connection test; a binary without the `mcp` subcommand (shipped v2.4.1) answers "no live claim" instead of fake failures. Writes only prove the config member (§D8.8). */
  mcpRuntime(execImpl?: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>): Promise<McpRuntimeHostReport> {
    return probeKimiMcpRuntime(execImpl);
  }
  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(kimiHome(), 'skills'),
    project: path.join('.kimi-code', 'skills'),
    readsUniversal: true,
  };

  protected readonly extSpec: PluginSpec = {
    webApi: { serverCommand: 'kimi web', tokenFile: 'server.token', apiPrefix: '/api/v1' },
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['github'];
  }
}

export const kimiAdapter = new KimiAdapter();
