import { discoverOpencodeServiceConfig, type OpencodeV2ServiceConfig } from '../../opencode/credentials/opencode-v2-store.js';
import { resolveDefaultPaths } from '../../opencode/credentials/paths.js';
import type { McpRuntimeHostReport, McpRuntimeServer, McpRuntimeStatus } from './adapters/types.js';

/**
 * Live MCP status from the running opencode v2 service (`GET /api/mcp`).
 *
 * The config file proves a server was WRITTEN; it never proves the runtime connected to it. opencode
 * already owns that answer — it connects at load time and reports `connected` / `pending` /
 * `disabled` / `needs_auth` / `failed` (with the failure text) per server — so the console reads it
 * from the runtime instead of inferring health from disk (ADR-0015 §D8.8).
 *
 * Read-only and bounded: no service credentials, an unreachable daemon and an older endpoint all
 * answer `reachable: false`. That means "no live claim", never "the server failed" — a status the
 * console cannot verify must not be presented as a verdict.
 */

const PROBE_TIMEOUT_MS = 5_000;
const mcpRuntimeStatus = (value: string): McpRuntimeStatus | null =>
  value === 'connected' || value === 'pending' || value === 'disabled' || value === 'needs_auth' || value === 'failed'
    ? value
    : null;

/** One `Mcp.Server` from the service, or null when the shape is not one we can honestly report. */
function readServer(raw: unknown): McpRuntimeServer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  const statusEntry = record.status;
  const status = typeof statusEntry === 'string'
    ? statusEntry
    : statusEntry && typeof statusEntry === 'object' && !Array.isArray(statusEntry)
      ? (statusEntry as Record<string, unknown>).status
      : undefined;
  const parsed = typeof status === 'string' ? mcpRuntimeStatus(status) : null;
  if (!name || !parsed) return null;
  const error = statusEntry && typeof statusEntry === 'object' && !Array.isArray(statusEntry)
    ? (statusEntry as Record<string, unknown>).error
    : undefined;
  return {
    name,
    status: parsed,
    ...(typeof error === 'string' && error ? { error } : {}),
  };
}

export async function probeOpencodeMcpRuntime(
  opts: {
    fetchImpl?: typeof fetch;
    /** Test seam: `undefined` = discover the live service; `null` = answer "no service". */
    config?: OpencodeV2ServiceConfig | null;
  } = {}
): Promise<McpRuntimeHostReport> {
  const cfg = 'config' in opts
    ? opts.config
    : await discoverOpencodeServiceConfig(resolveDefaultPaths());
  if (!cfg) {
    return { reachable: false, message: 'opencode v2 service credentials not found', servers: [] };
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${cfg.baseUrl}/api/mcp`, {
      redirect: 'manual',
      headers: { Authorization: cfg.authHeader, Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { reachable: false, message: `opencode /api/mcp answered HTTP ${res.status}`, servers: [] };
    }
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) {
      return { reachable: false, message: 'opencode /api/mcp returned an unexpected shape', servers: [] };
    }
    const servers = body.data.map(readServer).filter((server): server is McpRuntimeServer => server !== null);
    return { reachable: true, servers };
  } catch (error) {
    return {
      reachable: false,
      message: error instanceof Error ? error.message : String(error),
      servers: [],
    };
  }
}
