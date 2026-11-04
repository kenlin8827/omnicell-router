import { defaultExec } from './writers/plugin.js';
import type { McpRuntimeHostReport, McpRuntimeServer, McpRuntimeStatus } from './adapters/types.js';

/**
 * Live MCP status from claude's own health check (`claude mcp list`).
 *
 * The config file proves a server was WRITTEN; it never proves the runtime connected to it. Claude
 * Code already owns that answer — `claude mcp list` runs its own health check per server and prints
 * the vendor-documented verdicts `✔ Connected` / `! Needs authentication` / `✘ Failed to connect`
 * (code.claude.com/docs/en/mcp) — so the console reads it from the runtime instead of inferring
 * health from disk (ADR-0015 §D8.8).
 *
 * Read-only and bounded. The output is human-readable text (no `--json` flag exists), so the parser
 * is deliberately TOLERANT: only lines that carry one of the three documented verdicts become
 * rows, every other line (banner, scope notes, future formats) is ignored, and a parse that yields
 * nothing answers `reachable: false` — "no live claim", never a failure verdict.
 */

const PROBE_TIMEOUT_MS = 60_000;

const VERDICTS: { marker: RegExp; status: McpRuntimeStatus }[] = [
  { marker: /[✔✓]\s*Connected/i, status: 'connected' },
  { marker: /!\s*Needs authentication/i, status: 'needs_auth' },
  { marker: /[✘✗x]\s*Failed to connect/i, status: 'failed' },
];

/** One `name: … - <verdict>` line, or null when the line is not a server verdict. */
function readLine(line: string): McpRuntimeServer | null {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const name = line.slice(0, colon).trim();
  // The name grammar is the runtime's own add-only one; anything else is not a server line.
  if (!/^[\w.-]+$/.test(name)) return null;
  const verdict = VERDICTS.find(({ marker }) => marker.test(line));
  if (!verdict) return null;
  const error = verdict.status === 'failed' ? 'claude reports: failed to connect' : undefined;
  return { name, status: verdict.status, ...(error ? { error } : {}) };
}

export async function probeClaudeMcpRuntime(
  execImpl: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }> = defaultExec
): Promise<McpRuntimeHostReport> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await execImpl('claude', ['mcp', 'list'], PROBE_TIMEOUT_MS);
  } catch (error) {
    return { reachable: false, message: error instanceof Error ? error.message : String(error), servers: [] };
  }
  if (!result.stdout.trim()) {
    return { reachable: false, message: 'claude mcp list produced no output', servers: [] };
  }
  const servers = result.stdout
    .split(/\r?\n/)
    .map(readLine)
    .filter((server): server is McpRuntimeServer => server !== null);
  if (servers.length === 0) {
    return { reachable: false, message: 'claude mcp list matched no server verdict lines', servers: [] };
  }
  return { reachable: true, servers };
}
