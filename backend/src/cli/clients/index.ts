import { ClientAdapter } from './base.js';
import { OpenCodeClientAdapter } from './opencode.js';
import { OpenCodeProxyClientAdapter } from './opencode-proxy.js';
import { ClaudeClientAdapter } from './claude.js';
import { CodexClientAdapter } from './codex.js';
import { ClientHookStatus, SupportedClient } from '../types.js';

const adapters: Record<SupportedClient, ClientAdapter> = {
  opencode: new OpenCodeClientAdapter(),
  'opencode-proxy': new OpenCodeProxyClientAdapter(),
  claude: new ClaudeClientAdapter(),
  codex: new CodexClientAdapter(),
};

export function getClientAdapter(name: string): ClientAdapter | null {
  const normalized = name.toLowerCase().trim() as SupportedClient;
  return adapters[normalized] || null;
}

export function getAllClientAdapters(): ClientAdapter[] {
  return Object.values(adapters);
}

export async function getAllClientStatuses(): Promise<ClientHookStatus[]> {
  return Promise.all(getAllClientAdapters().map(adapter => adapter.getStatus()));
}

export async function setupClient(
  name: string,
  options?: { port?: number; models?: Record<string, string> }
): Promise<{ success: boolean; message: string }> {
  const adapter = getClientAdapter(name);
  if (!adapter) {
    return {
      success: false,
      message: `Unknown client '${name}'. Supported clients: ${Object.keys(adapters).join(', ')}`,
    };
  }
  // The two opencode hooks are mutually exclusive — provider injection owns
  // opencode.json(c), proxy mode owns the service env. Enabling one decouples
  // the other first (only when actually hooked) so `hooked` status never shows
  // both at once; a failed sibling teardown is surfaced in the result message
  // instead of silently swallowed.
  let siblingNote = '';
  if (name === 'opencode' || name === 'opencode-proxy') {
    const sibling = name === 'opencode' ? 'opencode-proxy' : 'opencode';
    const siblingAdapter = getClientAdapter(sibling);
    if (siblingAdapter && (await siblingAdapter.getStatus()).hooked) {
      const r = await teardownClient(sibling).catch((err: unknown) => ({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      }));
      if (!r.success) siblingNote = ` (note: previous ${sibling} hook teardown failed: ${r.message})`;
    }
  }
  const result = await adapter.setup(options);
  return siblingNote && result.success ? { ...result, message: result.message + siblingNote } : result;
}

export async function teardownClient(name: string): Promise<{ success: boolean; message: string }> {
  const adapter = getClientAdapter(name);
  if (!adapter) {
    return {
      success: false,
      message: `Unknown client '${name}'. Supported clients: ${Object.keys(adapters).join(', ')}`,
    };
  }
  return adapter.teardown();
}
