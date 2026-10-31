import { adapterFor, isMcpHost } from './adapters/index.js';
import { HOSTS } from './hosts.js';
import type { HarnessHostId } from '../types.js';
import type { McpRuntimeHostReport } from './adapters/types.js';

/**
 * Live MCP status across every MCP-capable host that exposes a runtime surface.
 *
 * The inventory scan answers "what is written"; this answers "what is RUNNING". They stay separate
 * endpoints because the second one talks to a daemon and may be slow or absent — an unreachable
 * runtime contributes no rows here (its on-disk claim remains untouched), and a host whose runtime
 * exposes no status surface is simply absent. Callers must treat a missing host as UNKNOWN, never
 * as healthy or failed (ADR-0015 §D8.8).
 */

export interface McpRuntimeHostView extends McpRuntimeHostReport {
  host: HarnessHostId;
}

export interface McpRuntimeReport {
  probedAt: number;
  hosts: McpRuntimeHostView[];
}

export async function probeMcpRuntimes(): Promise<McpRuntimeReport> {
  const targets = HOSTS.flatMap(({ id }) => {
    const adapter = adapterFor(id);
    return adapter && isMcpHost(adapter) && adapter.mcpRuntime ? [adapter] : [];
  });
  const hosts = await Promise.all(
    targets.map(async (adapter): Promise<McpRuntimeHostView> => {
      try {
        return { host: adapter.id, ...(await adapter.mcpRuntime!()) };
      } catch (error) {
        return {
          host: adapter.id,
          reachable: false,
          message: error instanceof Error ? error.message : String(error),
          servers: [],
        };
      }
    })
  );
  return { probedAt: Date.now(), hosts };
}
