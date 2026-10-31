import path from 'node:path';
import { defaultExec } from './writers/plugin.js';
import { home } from './adapters/skills-paths.js';
import { readMcpLandingFile } from './mcp-entry.js';
import type { McpRuntimeHostReport, McpRuntimeServer } from './adapters/types.js';

/**
 * Live MCP status from kimi's own connection test (`kimi mcp test <name>`, one per server).
 *
 * The config file proves a server was WRITTEN; it never proves the runtime connected to it. kimi
 * owns that answer: `kimi mcp test` starts the server exactly as a session would (same
 * `~/.kimi-code/mcp.json` merge) and reports connection plus tool count — exit 0 is the runtime's
 * own "this server works" (ADR-0015 §D8.8). There is no batch/status command (vendor docs), so the
 * probe enumerates the server keys from the dedicated `mcp.json` and tests each one in parallel.
 *
 * Read-only and bounded: each test gets its own timeout, a missing or unreadable `mcp.json` means
 * "no live claim", and a per-server crash answers `failed` with the CLI's own words — never a
 * guessed verdict.
 */

const PROBE_TIMEOUT_MS = 30_000;

/** The server names kimi would load (user scope; the only scope this gateway writes). */
function configuredServerNames(): { ok: true; names: string[] } | { ok: false; message: string } {
  const file = path.join(
    process.env.KIMI_CODE_HOME?.trim() ? path.resolve(process.env.KIMI_CODE_HOME.trim()) : path.join(home(), '.kimi-code'),
    'mcp.json'
  );
  const parsed = readMcpLandingFile(file, 'json');
  if (!parsed.ok) return { ok: false, message: parsed.reason };
  const container = parsed.config.mcpServers;
  if (container === undefined) return { ok: true, names: [] };
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return { ok: false, message: `${file} has no usable 'mcpServers' object` };
  }
  return { ok: true, names: Object.keys(container as Record<string, unknown>).filter((name) => name.length > 0) };
}

export async function probeKimiMcpRuntime(
  execImpl: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }> = defaultExec
): Promise<McpRuntimeHostReport> {
  const listed = configuredServerNames();
  if (!listed.ok) return { reachable: false, message: listed.message, servers: [] };
  const servers = await Promise.all(
    listed.names.map(async (name): Promise<McpRuntimeServer> => {
      try {
        const result = await execImpl('kimi', ['mcp', 'test', name], PROBE_TIMEOUT_MS);
        if (result.code === 0) return { name, status: 'connected' };
        const text = (result.stderr || result.stdout).trim().slice(0, 200);
        return { name, status: 'failed', ...(text ? { error: text } : {}) };
      } catch (error) {
        return { name, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
  return { reachable: true, servers };
}
