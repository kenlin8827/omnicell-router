/**
 * Runtime status of the inbound forward proxy — a module singleton so the
 * console status endpoint (/api/admin/status) can report it without threading the
 * handle through createServer(). index.ts is the ONLY writer: it records a
 * successful start (running + port/startedAt) or the failure message.
 *
 * The gateway boot NEVER blocks on the proxy (see the fire-and-forget start in
 * index.ts) — this status is how a failed start stays visible on the Proxy
 * Access page instead of silently disappearing.
 */
export interface ForwardProxyRuntimeStatus {
  running: boolean;
  port?: number;
  host?: string;
  startedAt?: number;
  error?: string;
}

let status: ForwardProxyRuntimeStatus = { running: false };

export function setForwardProxyStatus(next: ForwardProxyRuntimeStatus): void {
  status = next;
}

export function getForwardProxyStatus(): ForwardProxyRuntimeStatus {
  return { ...status };
}