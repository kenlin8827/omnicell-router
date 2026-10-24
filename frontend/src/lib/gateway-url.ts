import { DEFAULT_GATEWAY_PORT } from './defaults';

/**
 * Base URL that quick-connect snippets and copy buttons should advertise.
 *
 * The right HOST is always the address the viewer actually dialed to reach
 * this console — routable for that viewer by construction:
 *   - loopback binding (default):  127.0.0.1 / localhost
 *   - `host: 0.0.0.0` LAN binding: the LAN IP / hostname the remote viewer used
 *   - reverse proxy:               the proxy's own origin
 * `0.0.0.0` itself is undialable, so the config value can never be copied
 * verbatim — the page origin is the only honest source.
 *
 * The right PORT is the gateway's real listen port (config.yaml `port`,
 * reported by /api/admin/status as `statusPort`) — this keeps `bun run dev`
 * correct, where the Vite dev-server port is NOT the gateway port. When the
 * console is proxied over a non-http scheme, the proxy origin (its own port
 * included) is the only reachable address and the gateway port wins nothing.
 * Residual edge: an SSH/port-forwarded console (page port ≠ gateway port,
 * both http) still shows the gateway port — the status value is preferred
 * because dev mode is the everyday case, tunnels are operator-known.
 */
export function gatewayBaseUrl(statusPort?: number): string {
  const { protocol, hostname, port: pagePort, origin } = window.location;
  if (protocol !== 'http:') return origin;
  // IPv6 literals already carry their brackets in `location.hostname`
  // (URL standard) — only a bare `::1` shape needs wrapping.
  const host = hostname.startsWith('[') || !hostname.includes(':') ? hostname : `[${hostname}]`;
  const port = statusPort && statusPort > 0 ? String(statusPort) : pagePort || String(DEFAULT_GATEWAY_PORT);
  return `http://${host}:${port}`;
}
