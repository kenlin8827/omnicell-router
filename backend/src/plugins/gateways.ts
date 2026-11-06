import type http from 'node:http';
import type { ClientGatewayPlugin } from './types.js';

/**
 * Registry of client-gateway plugins (the second plugin type, ADR-0017).
 *
 * A client gateway CLAIMS whole SNI hosts on the inbound forward proxy
 * (e.g. `api2.cursor.sh`) and answers/relays the decrypted traffic of those
 * hosts itself, speaking the vendor's native wire (Connect/protobuf for
 * Cursor). Claims are host-scoped and opt-in by plugin installation — the
 * ADR-0008 inference-surface table stays CLOSED; gateway routes never become
 * rows there because they only exist behind the MITM leg, never as direct
 * `/v1` endpoints.
 *
 * The registry is a plain module-level map, rebuilt atomically by the plugin
 * host on every load/reload (same pattern as plugins/host.ts's registry):
 * readers (forward-proxy TLS terminator, interceptor) never observe a
 * half-swapped set.
 */

const gateways = new Map<string, ClientGatewayPlugin>();

/** Decrypted-request shape both proxy legs can provide (h1 native, h2 compat layer). */
export interface GatewayRequestInfo {
  method?: string;
  /** Request target (`:path` on the h2 compat layer), never lowercased. */
  url?: string;
  headers: http.IncomingHttpHeaders;
}

/** Atomic-rebuild staging map (plugins/host.ts owns the rebuild cycle). */
const nextGateways = new Map<string, ClientGatewayPlugin>();

/** Register one gateway under its plugin id (staging side of the swap). */
export function stageGateway(id: string, gateway: ClientGatewayPlugin): void {
  nextGateways.set(id, gateway);
}

/** Swap the staged set into the live registry (end of a host rebuild). */
export function commitGateways(): void {
  gateways.clear();
  for (const [k, v] of nextGateways) gateways.set(k, v);
  nextGateways.clear();
}

/** Drop one gateway immediately (disable/uninstall hot-unplug half). */
export function removeGateway(id: string): void {
  gateways.delete(id);
  nextGateways.delete(id);
}

/** The SNI hosts claimed by any live gateway. */
export function listGatewayHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const gw of gateways.values()) for (const h of gw.hosts) hosts.add(h);
  return hosts;
}

/** Live gateway instance by plugin id (config-change hot-apply hook). */
export function getGatewayById(id: string): ClientGatewayPlugin | undefined {
  return gateways.get(id);
}

/** First gateway claiming the request's host whose match() accepts it. The
 *  host scope is enforced HERE (never trusted to the plugin): `:authority`
 *  on the h2 compat layer, `host` on h1, port stripped, case-insensitive. */
export function findGateway(info: GatewayRequestInfo): ClientGatewayPlugin | undefined {
  const raw = String(info.headers[':authority'] || info.headers.host || '');
  const host = raw.split(':')[0].toLowerCase();
  if (!host) return undefined;
  for (const gw of gateways.values()) {
    if (!gw.hosts.some((h) => h.toLowerCase() === host)) continue;
    try {
      if (gw.match(info)) return gw;
    } catch {
      // A throwing match() must not break the proxy leg — treat as no-match.
    }
  }
  return undefined;
}
