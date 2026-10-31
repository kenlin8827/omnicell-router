/**
 * TCP reachability for the console's DSN builder (ADR-0015 §D11 amendment, 2026-11).
 *
 * This helper answers ONE question — can this machine open a TCP connection to `host:port` — which
 * is exactly the class of mistake the operator cannot see in a string: a mistyped host, a wrong
 * port, a service that is not listening, a firewall. It carries no credential: only the derived
 * host and port are sent. PostgreSQL and MySQL instead get a REAL login in `db-probe.ts`; the dial
 * here is what every other scheme gets.
 *
 * What it must never claim: authentication, database existence and TLS mode are NOT verified here.
 * `sslmode=require` against a plain-TCP server still connects; a wrong password still connects.
 * The authoritative verdict stays the runtime's own MCP status after the server is landed.
 */

import net from 'node:net';

/** The dial concludes inside one console interaction; a refused answer arrives immediately. */
export const TCP_PROBE_TIMEOUT_MS = 4_000;

/** Longest legal DNS name, mirroring the hostname limit. */
const MAX_HOST_LENGTH = 253;

export interface TcpProbeResult {
  reachable: boolean;
  /** The socket's own failure text (`ECONNREFUSED: …`, `timeout after …`); absent when reachable. */
  message?: string;
}

/**
 * Validate a dial target without resolving it. A bare host or an IPv6 literal (brackets allowed)
 * passes; anything carrying whitespace, a path or a userinfo separator is not a host.
 */
export function isProbeHost(host: string): boolean {
  const value = host.trim();
  return value !== '' && value.length <= MAX_HOST_LENGTH && !/[\s/@]/.test(value);
}

/**
 * Dial `host:port` once and close. Resolves — never rejects — with `reachable: false` and the
 * socket's message for every failure path, so a caller reports one shape.
 */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs: number = TCP_PROBE_TIMEOUT_MS
): Promise<TcpProbeResult> {
  // ES2022 lib (backend tsconfig): Promise.withResolvers is unavailable — executor form.
  return new Promise((resolve) => {
    if (!isProbeHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ reachable: false, message: 'invalid target' });
      return;
    }
    // WHATWG `URL.hostname` keeps the brackets around an IPv6 literal; `net.connect` wants the
    // bare address.
    const address = host.trim().replace(/^\[(.*)\]$/, '$1');
    const socket = net.connect({ host: address, port });
    let settled = false;
    const finish = (result: TcpProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true }));
    socket.once('timeout', () => finish({ reachable: false, message: `timeout after ${timeoutMs} ms` }));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish({
        reachable: false,
        message: error.code ? `${error.code}: ${error.message}` : error.message,
      })
    );
    // A server that accepts and immediately closes still proved the port answers; the `connect`
    // result already settled above. Only a close BEFORE connect is a failure.
    socket.once('close', () => finish({ reachable: false, message: 'connection closed before connect' }));
  });
}
