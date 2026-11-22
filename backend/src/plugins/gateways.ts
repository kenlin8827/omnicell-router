import type http from 'node:http';
import type { ClientGatewayPlugin } from './types.js';

/**
 * Registry of client-gateway plugins (the second plugin type, ADR-0017).
 *
 * A client gateway CLAIMS SNI hosts on the inbound forward proxy
 * (e.g. `api2.cursor.sh`) and answers/relays the decrypted traffic of those
 * hosts itself, speaking the vendor's native wire (Connect/protobuf for
 * Cursor). Claims are host-scoped and opt-in by plugin installation — the
 * ADR-0008 inference-surface table stays CLOSED; gateway routes never become
 * rows there because they only exist behind the MITM leg, never as direct
 * `/v1` endpoints.
 *
 * TWO claim shapes (ADR-0026):
 *   - an EXACT host (`api2.cursor.sh`) — a vendor owner;
 *   - the WILDCARD `*` — a universal gateway: it answers for every host no
 *     exact claim took, and its `match()` narrows that to the paths it
 *     actually wants. The canonical OpenAI / Anthropic / Responses wires are
 *     handled this way, so the interceptor itself never takes model service
 *     over.
 *
 * Ordering is the registry's, never the plugin's: all exact claims are
 * consulted first (in registration order), then installed wildcard claims,
 * then the caller's built-in FALLBACK row. A wildcard can therefore never
 * shadow a vendor plugin by manifest order, and an installed wildcard package
 * pre-empts the built-in row with no core change (the built-in is the default
 * occupant of that slot, not a privileged one).
 *
 * The built-in row deliberately lives OUTSIDE `gateways`: it is not a package,
 * owns no config artifact and cannot be uninstalled, and several consumers
 * (`listGatewayHosts()` → CONNECT admission, h2-first relay, the console's
 * claim preview) must not see a literal `'*'` in the claimed-host set. It is
 * passed to `findGateway()` by the interceptor that serves its orchestrator —
 * not stored here — because two interceptors in one process (an embedded
 * server, a test running a stub beside a real orchestrator) each own their row
 * and must not be able to re-point the other's model traffic.
 *
 * The registry is a plain module-level map, rebuilt atomically by the plugin
 * host on every load/reload (same pattern as plugins/host.ts's registry):
 * readers (forward-proxy TLS terminator, interceptor) never observe a
 * half-swapped set.
 */

/** The one wildcard claim spelling. */
export const WILDCARD_HOST_CLAIM = '*';

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

/** Drop staged gateways for ids that did NOT load (fail-closed at the commit
 *  point). The loader stages a gateway as part of loading a package; if the
 *  load then throws, the staging entry must not survive into the live map —
 *  a gateway that intercepts with no console row to disable is unreachable
 *  state, and the operator's only remedy would be editing files by hand. */
export function retainStagedGateways(loadedIds: ReadonlySet<string>): void {
  for (const id of [...nextGateways.keys()]) {
    if (!loadedIds.has(id)) nextGateways.delete(id);
  }
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

/** A plugin claims the wildcard — it answers where no exact claim did. */
export function claimsWildcard(gw: ClientGatewayPlugin): boolean {
  return gw.hosts.some((h) => h === WILDCARD_HOST_CLAIM);
}

/** The SNI hosts claimed by any live gateway, wildcard included verbatim.
 *  Consumers that want concrete hosts only must filter `'*'` themselves —
 *  the set is the truthful claim vocabulary, not a resolved host list. */
export function listGatewayHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const gw of gateways.values()) for (const h of gw.hosts) hosts.add(h);
  return hosts;
}

/** Live gateway instance by plugin id (config-change hot-apply hook). */
export function getGatewayById(id: string): ClientGatewayPlugin | undefined {
  return gateways.get(id);
}

/** All live gateways (id → instance) — read-only snapshot. The generic
 *  protocol-traffic console route enumerates dissectors from here. */
export function listGateways(): Map<string, ClientGatewayPlugin> {
  return new Map(gateways);
}

/** Ask one gateway whether it takes THIS request. The accept hook is
 *  `match()` — a throwing one is a decline, never a broken proxy leg. */
function accepts(gw: ClientGatewayPlugin, info: GatewayRequestInfo): boolean {
  try {
    return gw.match(info);
  } catch {
    return false;
  }
}

/**
 * First gateway that takes this request: exact host claims win, wildcard
 * claims answer last, and the caller's FALLBACK row (the built-in universal
 * gateway) is consulted after every installed one. The HOST SCOPE is enforced
 * here (never trusted to the plugin): `:authority` on the h2 compat layer,
 * `host` on h1, port stripped, case-insensitive.
 *
 * `fallback` is a PARAMETER, not module state, because more than one
 * interceptor can exist in a process (an embedded server, a test that runs a
 * stub and a real orchestrator side by side): each interceptor owns the
 * built-in row bound to ITS orchestrator, and one factory call must never
 * re-point another's model traffic. Callers that do not serve model traffic
 * (the upgrade relay) pass nothing.
 *
 * `match()` is the per-request ACCEPT step, which is what lets a wildcard
 * gateway exist at all: `hosts: ['*']` says "I am willing to answer for any
 * host", `match()` says "…and here is the traffic I actually recognize"
 * (canonical path, method). Traffic a wildcard declines falls through to the
 * next gateway and, ultimately, to the transparent forward — a wildcard is a
 * claim of willingness, never a capture of everything. The fallback row is
 * consulted LAST: an operator who installs a wildcard package means to replace
 * it.
 */
export function findGateway(
  info: GatewayRequestInfo,
  fallback?: ClientGatewayPlugin
): ClientGatewayPlugin | undefined {
  const raw = String(info.headers[':authority'] || info.headers.host || '');
  const host = raw.split(':')[0].toLowerCase();

  if (host) {
    for (const gw of gateways.values()) {
      if (claimsWildcard(gw)) continue;
      if (!gw.hosts.some((h) => h.toLowerCase() === host)) continue;
      if (accepts(gw, info)) return gw;
    }
  }
  for (const gw of gateways.values()) {
    if (!claimsWildcard(gw)) continue;
    if (accepts(gw, info)) return gw;
  }
  if (fallback && accepts(fallback, info)) return fallback;
  return undefined;
}
