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
 * Reachability is decided by the FIRST test (2026-11-03, shipped v2.4.1 verified): that binary
 * has NO `mcp` subcommand at all — `kimi mcp test` answers `unknown command 'mcp'` and a
 * per-server loop would fake one failure per configured server. When the first test shows the
 * command is missing (or kimi cannot be spawned at all), the probe answers "no live claim"
 * (`reachable: false`) and the on-disk state stands alone, never a guessed verdict.
 *
 * Read-only and bounded: each test gets its own timeout, a MISSING `mcp.json` means "no servers"
 * (an unreadable config root still answers `reachable: false` — see configuredServerNames), and a
 * per-server crash answers `failed` with the CLI's own words.
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

/** `kimi` (shipped v2.4.1) has no `mcp` subcommand: the CLI answers `unknown command 'mcp'`. */
const NO_MCP_SUBCOMMAND_RE = /unknown command ['"]?mcp\b/i;

function mapResult(name: string, result: { code: number; stdout: string; stderr: string }): McpRuntimeServer {
  if (result.code === 0) return { name, status: 'connected' };
  const text = (result.stderr || result.stdout).trim().slice(0, 200);
  return { name, status: 'failed', ...(text ? { error: text } : {}) };
}

export async function probeKimiMcpRuntime(
  execImpl: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }> = defaultExec
): Promise<McpRuntimeHostReport> {
  const listed = configuredServerNames();
  if (!listed.ok) return { reachable: false, message: listed.message, servers: [] };
  if (listed.names.length === 0) return { reachable: true, servers: [] };

  // The first test doubles as the capability probe: a binary without the `mcp` subcommand (or no
  // runnable kimi at all) means this host has NO live surface — one spawn decides, never N fake
  // per-server failures.
  const [first, ...rest] = listed.names;
  let firstResult: { code: number; stdout: string; stderr: string };
  try {
    firstResult = await execImpl('kimi', ['mcp', 'test', first], PROBE_TIMEOUT_MS);
  } catch (error) {
    return {
      reachable: false,
      message: `kimi mcp test is not runnable: ${error instanceof Error ? error.message : String(error)}`,
      servers: [],
    };
  }
  if (firstResult.code !== 0 && NO_MCP_SUBCOMMAND_RE.test(`${firstResult.stderr}\n${firstResult.stdout}`)) {
    return {
      reachable: false,
      message: (firstResult.stderr || firstResult.stdout).trim().slice(0, 200),
      servers: [],
    };
  }
  const servers = await Promise.all(
    rest.map(async (name): Promise<McpRuntimeServer> => {
      try {
        return mapResult(name, await execImpl('kimi', ['mcp', 'test', name], PROBE_TIMEOUT_MS));
      } catch (error) {
        return { name, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
  return { reachable: true, servers: [mapResult(first, firstResult), ...servers] };
}
