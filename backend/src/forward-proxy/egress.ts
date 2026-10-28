import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { ForwardProxyConfig } from '../config/types.js';
import { resolveProxyUrl } from '../utils/proxy.js';

/**
 * Shared egress plumbing for everything that forwards bytes to an ORIGINAL
 * dial target: the forward-proxy's non-intercepted forwarders (server.ts)
 * and the pipeline's direct-forward relay (surfaces/direct-forward.ts).
 *
 * `transitProxyFor` implements the `config.proxy` outbound policy: when the
 * global `viaOutboundProxy` flag (or a per-host bypass entry's `viaProxy`)
 * is on, the egress goes through the configured outbound proxy (clash/v2ray)
 * via CONNECT so network-blocked targets stay reachable. The live reader
 * makes `viaOutboundProxy` hot-appliable per request (console save, no
 * restart); module-level because only one forward proxy instance exists per
 * process (last created wins — createForwardProxyServer sets them).
 */

let liveForwardProxy: (() => ForwardProxyConfig | undefined) | undefined;
let viaOutboundProxyFallback = false;

export function setLiveForwardProxy(reader: (() => ForwardProxyConfig | undefined) | undefined, fallback: boolean): void {
  liveForwardProxy = reader;
  viaOutboundProxyFallback = fallback;
}

export function currentBypassHosts(bootBypassHosts: (string | { host: string; viaProxy?: boolean })[] | undefined): (string | { host: string; viaProxy?: boolean })[] {
  return liveForwardProxy?.()?.bypassHosts ?? bootBypassHosts ?? [];
}

const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  'proxy-connection': true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
};

export function filterHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP[k.toLowerCase()]) continue;
    out[k] = v;
  }
  return out;
}

export function transitProxyFor(host: string, port: number, force?: boolean): string | undefined {
  // force: per-host egress choice (bypass entries carry it); undefined = the
  // global `viaOutboundProxy` flag (non-intercepted forwards + direct legs).
  const enabled =
    force === undefined ? (liveForwardProxy?.()?.viaOutboundProxy ?? viaOutboundProxyFallback) : force;
  if (!enabled) return undefined;
  return resolveProxyUrl(`https://${host}:${port}/`, { model: host });
}

export function parseProxy(proxyUrl: string): { host: string; port: number; auth?: string } | null {
  try {
    const u = new URL(proxyUrl);
    const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
    const auth = u.username
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
      : undefined;
    return { host: u.hostname, port, auth };
  } catch {
    return null;
  }
}

/**
 * Open a raw byte pipe to `host:port` through an HTTP CONNECT proxy.
 * Resolves with the tunneled socket (paused — consumers must splice/pipe,
 * which resumes it; Bun drops listener-less early data, hence the pause).
 */
export function openViaProxy(proxyUrl: string, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const p = parseProxy(proxyUrl);
    if (!p) return reject(new Error('invalid outbound proxy url'));
    const sock = net.connect(p.port, p.host);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error('outbound proxy connect timeout'));
      }
    }, 15000);
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      const head = buf.slice(0, idx);
      const rest = buf.slice(idx + 4);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        sock.destroy();
        reject(new Error(`outbound proxy rejected CONNECT: ${head.split('\r\n')[0] || 'no status'}`));
        return;
      }
      if (rest.length) sock.unshift(Buffer.from(rest, 'latin1'));
      sock.pause();
      resolve(sock);
    };
    sock.on('data', onData);
    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    sock.on('connect', () => {
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        ...(p.auth ? [`Proxy-Authorization: ${p.auth}`] : []),
        '',
        '',
      ];
      sock.write(lines.join('\r\n'));
    });
  });
}

/** Node http/https request verb for a target scheme. */
export function transportFor(secure: boolean): typeof http | typeof https {
  return secure ? https : http;
}
