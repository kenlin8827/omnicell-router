import { defaultExec } from './writers/plugin.js';
import type { McpRuntimeHostReport, McpRuntimeServer } from './adapters/types.js';

/**
 * Live MCP status from grok's own doctor (`grok mcp doctor --json`, vendor `mcp_doctor.rs`).
 *
 * The config file proves a server was WRITTEN; it never proves the runtime connected to it. grok
 * already owns that answer — the doctor starts each configured stdio server and runs its checks,
 * reporting `healthy: true` or the failing checks per server — so the console reads it from the
 * runtime instead of inferring health from disk (ADR-0015 §D8.8).
 *
 * Read-only and bounded: the doctor exits 1 when any server fails (the JSON still arrives on
 * stdout), and a spawn error, a timeout or an unparsable answer all mean `reachable: false` —
 * "no live claim", never "the server failed".
 */

const PROBE_TIMEOUT_MS = 30_000;

interface GrokDoctorCheck {
  label?: unknown;
  passed?: unknown;
  detail?: unknown;
}

interface GrokDoctorServer {
  name?: unknown;
  healthy?: unknown;
  checks?: unknown;
}

interface GrokDoctorReport {
  servers?: unknown;
}

/** One `McpServerStatus` from the doctor, or null when the shape is not one we can honestly report. */
function readServer(raw: unknown): McpRuntimeServer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as GrokDoctorServer;
  if (typeof record.name !== 'string' || !record.name) return null;
  if (record.healthy === true) return { name: record.name, status: 'connected' };
  if (record.healthy !== false) return null;
  const checks = Array.isArray(record.checks) ? (record.checks as GrokDoctorCheck[]) : [];
  const failed = checks
    .filter((check) => check && typeof check === 'object' && check.passed === false)
    .map((check) => (typeof check.label === 'string' ? check.label : 'check'))
    .slice(0, 4);
  const error = failed.length > 0 ? `failed: ${failed.join(', ')}` : 'failed';
  return { name: record.name, status: 'failed', error };
}

export async function probeGrokMcpRuntime(
  execImpl: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }> = defaultExec
): Promise<McpRuntimeHostReport> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    // The doctor walks user + project configs from cwd — the same merge a session here would load.
    result = await execImpl('grok', ['mcp', 'doctor', '--json'], PROBE_TIMEOUT_MS);
  } catch (error) {
    return { reachable: false, message: error instanceof Error ? error.message : String(error), servers: [] };
  }
  // Exit 1 means "some server failed", not "the doctor failed" — the JSON is on stdout either way.
  let report: GrokDoctorReport;
  try {
    report = JSON.parse(result.stdout) as GrokDoctorReport;
  } catch {
    return { reachable: false, message: 'grok mcp doctor returned an unparsable answer', servers: [] };
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.servers)) {
    return { reachable: false, message: 'grok mcp doctor returned an unexpected shape', servers: [] };
  }
  const servers = report.servers.map(readServer).filter((server): server is McpRuntimeServer => server !== null);
  return { reachable: true, servers };
}
