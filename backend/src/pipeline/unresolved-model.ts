import type { ForwardProxyConfig, UnresolvedModelConfig } from '../config/types.js';

/**
 * forwardProxy.unresolvedModel policy (ADR-0003): on the MITM forward-proxy
 * leg, what happens when the client's `model` name matches NO registered
 * model, combo, variant or tier alias — after the full bare-name resolution
 * chain (exact id → variant → host-pinned upstream name → combo) has run
 * and missed. The native /v1 leg NEVER consults this: a client dialing the
 * gateway directly keeps the historical classifier behavior unconditionally.
 *
 * - `fail`   : loud 404 — no invisible model drift.
 * - `direct` : forward the request to the ORIGINAL destination the client
 *   dialed — the turn RUNS THROUGH the pipeline (normalization, zero-header
 *   session id, capture, compression: rtk + headroom + caveman, fail-open)
 *   but every model-bound stage is skipped (routing, ratchet, route-entry
 *   experience, breaker, failover, FinOps, turn registration) and the turn
 *   ends as a `DirectForwardPlan`: the transport relays the response from
 *   the ORIGINAL destination, original model id and the client's own
 *   Authorization header riding along (surfaces/direct-forward.ts).
 *   Loopback targets are refused (recursion guard) and degrade to `auto`.
 * - any modelRef : the miss resolves to that ref — `auto`/tier alias/
 *   combo id/registered model id — exactly as if the client had sent it.
 *   `auto` IS the default: leaving `onMiss` unset and naming `auto`
 *   explicitly both resolve to the default cascade.
 */
export type UnresolvedModelAction = 'auto' | 'fail' | 'direct' | { ref: string };

/** Normalize the operator's raw YAML: trim values, lowercase host keys,
 *  drop empty entries. */
export function normalizeUnresolvedModelConfig(
  raw: UnresolvedModelConfig | undefined
): UnresolvedModelConfig | undefined {
  if (!raw) return undefined;
  const onMiss = typeof raw.onMiss === 'string' ? raw.onMiss.trim() : undefined;
  const hosts: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.hosts ?? {})) {
    const key = k.trim().toLowerCase();
    const val = typeof v === 'string' ? v.trim() : '';
    if (key && val) hosts[key] = val;
  }
  return {
    ...(onMiss ? { onMiss } : {}),
    ...(Object.keys(hosts).length > 0 ? { hosts } : {}),
  };
}

/** Evaluate the policy for one MITM-leg request. A `hosts` override for the
 *  original-dial host wins over the global `onMiss`. */
export function resolveUnresolvedModelAction(
  forwardProxy: ForwardProxyConfig | undefined,
  upstreamHost: string | undefined
): UnresolvedModelAction {
  const cfg = forwardProxy?.unresolvedModel;
  if (cfg && upstreamHost) {
    // The Host header may carry a non-default port (`api.example.com:8443`);
    // operator overrides are keyed by bare hostname (same normalization the
    // loopback guard applies below), so strip the port suffix first.
    const host = upstreamHost.trim().toLowerCase().replace(/:\d+$/, '');
    const override = cfg.hosts?.[host];
    if (override) return toAction(override);
  }
  if (cfg?.onMiss) return toAction(cfg.onMiss);
  return 'auto';
}

function toAction(v: string): UnresolvedModelAction {
  const t = v.trim();
  // `auto` names the default cascade — the same value the function returns
  // when no policy is configured.
  if (t === 'auto' || t === 'fail' || t === 'direct') return t;
  return { ref: t };
}
