import type http from 'node:http';
import type { ClientGatewayPlugin, PluginClaimEgress } from './types.js';

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

/**
 * The outbound-leg opinions each live gateway holds for its claimed hosts,
 * keyed by plugin id. It rides the SAME staging/commit/prune cycle as
 * `gateways`, so it can never outlive a claim: an uninstalled or disabled
 * plugin stops declaring on the same swap that stops it intercepting. A
 * parallel map is deliberate — the two tiers in here are what the MANIFEST and
 * the OPERATOR said, and a gateway's own code must not be able to rewrite them.
 */
const claimEgress = new Map<string, ClaimEgressSources>();

/** What the non-code tiers said about this gateway's hosts. `operator` is the
 *  value stored in `plugins/config/<id>.json`; it outranks the code. */
export interface ClaimEgressSources {
  manifest?: PluginClaimEgress;
  operator?: PluginClaimEgress;
}

/** The three tiers, RUNTIME data so the console mirror can be parity-checked
 *  instead of drifting silently (the drawer translates each one by name). */
export const CLAIM_EGRESS_SOURCES = ['operator', 'code', 'manifest'] as const;

/** Which tier of the claim answered for a host (ADR-0018 Revision 5). The console
 *  prints this, because "the plugin routes it" and "the operator told it to"
 *  are different things an operator is entitled to tell apart. */
export type ClaimEgressSource = (typeof CLAIM_EGRESS_SOURCES)[number];

/** Decrypted-request shape both proxy legs can provide (h1 native, h2 compat layer). */
export interface GatewayRequestInfo {
  method?: string;
  /** Request target (`:path` on the h2 compat layer), never lowercased. */
  url?: string;
  headers: http.IncomingHttpHeaders;
}

/** Atomic-rebuild staging map (plugins/host.ts owns the rebuild cycle). */
const nextGateways = new Map<string, ClientGatewayPlugin>();
const nextClaimEgress = new Map<string, ClaimEgressSources>();

/** Register one gateway under its plugin id (staging side of the swap).
 *  `egress` holds what the two NON-CODE tiers said about this gateway's hosts:
 *  the manifest's default leg and the operator's plugin-level switch. An
 *  `inherit` or absent tier stores nothing, so a host with no opinion from that
 *  tier is simply not represented rather than present with a no-op value. */
export function stageGateway(
  id: string,
  gateway: ClientGatewayPlugin,
  egress?: ClaimEgressSources
): void {
  nextGateways.set(id, gateway);
  const manifest = egress?.manifest && egress.manifest !== 'inherit' ? egress.manifest : undefined;
  const operator = egress?.operator && egress.operator !== 'inherit' ? egress.operator : undefined;
  if (manifest || operator) nextClaimEgress.set(id, { manifest, operator });
  else nextClaimEgress.delete(id);
}

/** Replace only the OPERATOR tier for a live gateway (config hot-apply).
 *
 * A config save must take effect on the next request, and the full
 * stage/commit cycle is the wrong tool: it rebuilds every gateway from the
 * packages on disk, which drags in unrelated load failures and re-runs each
 * plugin's activation hooks for a value that lives in a JSON file. The instance
 * is left alone — the switch is a vote about the transport under it, not a
 * reason to hand the plugin a new one. The staging side needs no write because
 * the rebuild re-reads the stored config, which this call runs after. */
export function setGatewayOperatorEgress(id: string, egress?: PluginClaimEgress): void {
  const value = egress && egress !== 'inherit' ? egress : undefined;
  const manifest = claimEgress.get(id)?.manifest;
  if (!value && !manifest) claimEgress.delete(id);
  else claimEgress.set(id, { manifest, operator: value });
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
  for (const id of [...nextClaimEgress.keys()]) {
    if (!loadedIds.has(id)) nextClaimEgress.delete(id);
  }
}

/** Swap the staged set into the live registry (end of a host rebuild). */
export function commitGateways(): void {
  gateways.clear();
  claimEgress.clear();
  for (const [k, v] of nextGateways) gateways.set(k, v);
  for (const [k, v] of nextClaimEgress) claimEgress.set(k, v);
  nextGateways.clear();
  nextClaimEgress.clear();
}

/** Drop one gateway immediately (disable/uninstall hot-unplug half). */
export function removeGateway(id: string): void {
  gateways.delete(id);
  claimEgress.delete(id);
  nextGateways.delete(id);
  nextClaimEgress.delete(id);
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

/**
 * Who decides the outbound leg of a host a client gateway claims, and in what
 * order (ADR-0018 Revision 5). Once a package claims a host, the leg under that host
 * is the package's business:
 *
 *   1. the OPERATOR's plugin-level switch (`plugins/config/<id>.json`), when it
 *      explicitly picked a leg — the operator outranks the code they installed;
 *   2. the gateway's own CODE (`egressFor`), which may answer host by host and
 *      change its mind per request;
 *   3. the MANIFEST's declared default leg.
 *
 * `undefined` means the claim has no opinion, which is the only way the rule
 * table's `egress` reaches a claimed host.
 *
 * Two refusals keep the blast radius equal to the claim:
 *  - a WILDCARD claim never votes. `'*'` is a read permission over every host
 *    the machine reaches, not a statement about any one of them;
 *  - a host two gateways answer OPPOSITELY yields no opinion, not a winner.
 *    Order between two installed packages is a load artifact, and a silent pick
 *    is how one plugin ends up routing another vendor's traffic.
 */
export function claimEgressFor(
  host: string
): { action: 'proxy' | 'direct'; source: ClaimEgressSource } | undefined {
  const h = String(host || '').toLowerCase();
  if (!h || h === WILDCARD_HOST_CLAIM) return undefined;
  const votes: Array<{ action: 'proxy' | 'direct'; source: ClaimEgressSource }> = [];
  for (const [id, gw] of gateways) {
    if (claimsWildcard(gw)) continue;
    if (!gw.hosts.some((x) => String(x).toLowerCase() === h)) continue;
    const tiered = claimEgress.get(id);
    const byOperator = tiered?.operator;
    const byCode = byOperator ? undefined : codeEgress(gw, h);
    const action = byOperator ?? byCode ?? tiered?.manifest;
    if (action !== 'proxy' && action !== 'direct') continue;
    votes.push({ action, source: byOperator ? 'operator' : byCode ? 'code' : 'manifest' });
  }
  if (votes.length === 0) return undefined;
  if (votes.some((v) => v.action !== votes[0].action)) return undefined;
  // When several gateways agree, the console says who SPOKE, and an explicit
  // operator switch outranks a package's code the same way it does within one
  // package — otherwise the row would credit a manifest default the operator
  // actually overrode.
  const byTier: ClaimEgressSource[] = ['operator', 'code', 'manifest'];
  const speaker = byTier.find((t) => votes.some((v) => v.source === t));
  return { action: votes[0].action, source: speaker! };
}

/** The gateway's own per-host answer. A throwing hook is silence, not a
 *  routing decision: a plugin bug must not strand the transport of the host it
 *  claims (same contract as `match()` declining in `accepts()`). */
function codeEgress(gw: ClientGatewayPlugin, host: string): PluginClaimEgress | undefined {
  if (!gw.egressFor) return undefined;
  try {
    const v = gw.egressFor({ host });
    return v === 'proxy' || v === 'direct' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every concretely claimed host whose claim currently speaks about the leg.
 * A snapshot, so the table LINT can ask "is this row's `egress` reachable?"
 * without treating plugin code as a lint input; routing itself asks
 * `claimEgressFor()` per request.
 */
export function listClaimedEgress(): Map<string, 'proxy' | 'direct'> {
  const out = new Map<string, 'proxy' | 'direct'>();
  for (const gw of gateways.values()) {
    if (claimsWildcard(gw)) continue;
    for (const host of gw.hosts) {
      const h = String(host).toLowerCase();
      if (h === WILDCARD_HOST_CLAIM || out.has(h)) continue;
      const claim = claimEgressFor(h);
      if (claim) out.set(h, claim.action);
    }
  }
  return out;
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
