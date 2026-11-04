/**
 * Shared vocabulary for the runtime's live MCP answer (backend `McpRuntimeStatus`, ADR-0015 §D8.8).
 *
 * Two console surfaces read the same probe — the Installed list's row badge and the sources
 * drawer's per-source verdict — so the label, the tone and the "worth flagging" rule live here
 * once. `disabled` and `pending` are real runtime states, not defects; only `failed` and
 * `needs_auth` make a row worth attention. A missing verdict stays unknown: the console never
 * turns an absent or unreachable answer into "healthy".
 */
import type { McpRuntimeStatus } from './api';

/** One host's verdict for one server key. `error` is the runtime's own failure text. */
export interface McpRuntimeVerdict {
  host: string;
  status: McpRuntimeStatus;
  error?: string;
}


/** Label + tone for each runtime state. `needs_auth`/`failed` are the row's abnormal states. */
export const RUNTIME_BADGE: Record<McpRuntimeStatus, { key: string; className: string }> = {
  connected: { key: 'harness.mcpRuntimeConnected', className: 'badge badge-success' },
  pending: { key: 'harness.mcpRuntimePending', className: 'badge badge-info' },
  disabled: { key: 'harness.mcpRuntimeDisabled', className: 'badge' },
  needs_auth: { key: 'harness.mcpRuntimeNeedsAuth', className: 'badge badge-warning' },
  failed: { key: 'harness.mcpRuntimeFailed', className: 'badge badge-danger' },
};

/** The states that make a row unhealthy: the server did not connect, or it needs a login. */
export const runtimeNeedsAttention = (runtime?: McpRuntimeVerdict): boolean =>
  runtime?.status === 'failed' || runtime?.status === 'needs_auth';
