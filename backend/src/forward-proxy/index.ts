import path from 'node:path';
import { resolveCaDir } from './ca.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { ForwardProxyConfig } from '../config/types.js';
import { DEFAULT_FORWARD_PROXY_PORT, DEFAULT_FORWARD_PROXY_HOST, DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS } from '../config/defaults.js';
import { getRuntimeConfigRef } from '../config/index.js';
import { createForwardProxyServer, type ForwardProxyHandle } from './server.js';
import { createProxyInterceptor } from './interceptor.js';
import { setGatewayChatServices, buildGatewayChatServices } from '../surfaces/gateway-chat.js';
import { setProxyAccessLogSettingsReader, setProxyAccessLogPersistDir, initProxyAccessLogPersistence } from './access-log.js';
import { setUpstreamTlsReader } from './upstream-tls.js';

/**
 * Refuse to expose an UNAUTHENTICATED MITM proxy beyond loopback.
 *
 * Full capture means the proxy decrypts and records whatever its clients send;
 * with no auth token, anyone who can reach the port inherits that. Loopback is
 * the trust boundary, so a non-loopback bind requires a token. Throws (the
 * caller turns it into a visible start failure, never a silent downgrade).
 */
export function assertForwardProxyBindSafety(host: string, authToken: string | undefined): void {
  // Deliberately NOT `isLoopbackHost`: that helper counts 0.0.0.0 as "loopback"
  // for MITM cycle-safety (an unspecified target is never decrypted), which is
  // the exact opposite of what a BIND gate needs — 0.0.0.0 means every
  // interface. Only a literal loopback address is safe without a token.
  const h = (host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const loopback =
    !h || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  if (loopback) return;
  if (authToken && authToken.trim()) return;
  throw new Error(
    `forwardProxy.host is "${host}" (not loopback) but forwardProxy.authToken is unset — ` +
      'an unauthenticated MITM proxy must not be exposed beyond this machine. ' +
      'Set forwardProxy.authToken (clients then send Proxy-Authorization: Basic user:token) or bind 127.0.0.1.'
  );
}

/**
 * Start the inbound forward proxy (HTTP_PROXY / HTTPS_PROXY server).
 * Enabled via config.yaml `forwardProxy.enabled`; defaults: port 4555,
 * loopback-only, CA under ~/.omnicell-router/forward-proxy/.
 */
export async function startForwardProxy(
  cfg: ForwardProxyConfig,
  orchestrator: PipelineOrchestrator
): Promise<ForwardProxyHandle> {
  const host = cfg.host?.trim() || DEFAULT_FORWARD_PROXY_HOST;
  // Bind-safety gate BEFORE anything listens: no token + non-loopback = refuse.
  assertForwardProxyBindSafety(host, cfg.authToken);
  const caDir = resolveCaDir(cfg.caDir);
  const intercept = createProxyInterceptor(orchestrator);
  // Gateway-plugin chat seam (ADR-0017): the services ride the same
  // orchestrator the interceptor uses, so plugins dispatch through the
  // identical routing pipeline as the native legs.
  setGatewayChatServices(buildGatewayChatServices(orchestrator));
  // Hot-apply seam: the access-log flags re-read the live runtime ref per
  // request, so console saves need no restart.
  setProxyAccessLogPersistDir(path.join(caDir, 'access-log'));
  initProxyAccessLogPersistence();
  setProxyAccessLogSettingsReader(() => {
    const fp = getRuntimeConfigRef()?.forwardProxy;
    return {
      enabled: fp?.accessLog?.enabled !== false,
      bodyBytes: fp?.accessLog?.bodyBytes,
      persist: fp?.accessLog?.persist !== false,
      persistDays: fp?.accessLog?.persistDays ?? DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS,
    };
  });
  // Upstream TLS trust (ADR-0019): resolved per origin leg off the live config,
  // so a console save hot-applies. A `caFile` is re-stat'ed on a short TTL, so a
  // rotated bundle is picked up too.
  setUpstreamTlsReader(() => getRuntimeConfigRef()?.forwardProxy?.upstreamTls);
  if (cfg.upstreamTls?.insecure === true) {
    console.warn(
      '[ForwardProxy] forwardProxy.upstreamTls.insecure is TRUE — upstream certificates are NOT verified. ' +
        'Any origin (including a MITM on the path) is accepted; use it only to get past a broken chain, never as a resting state.'
    );
  }
  const handle = await createForwardProxyServer({
    port: cfg.port ?? DEFAULT_FORWARD_PROXY_PORT,
    host,
    caDir,
    maxConnections: cfg.maxConnections,
    authToken: cfg.authToken,
    rules: cfg.rules,
    // Hot-apply seam: rules / unresolvedModel re-read the runtime ref per
    // request, so console saves need no restart.
    liveForwardProxy: () => getRuntimeConfigRef()?.forwardProxy,
    intercept,
    log: (m) => console.log(`[ForwardProxy] ${m}`),
  });
  console.log(`[ForwardProxy] ready on http://${host}:${handle.port} — MITM CA: ${path.join(caDir, 'ca.pem')}`);
  const rules = cfg.rules || [];
  if (rules.length) {
    const catchAll = rules.some((r) => r.match === '*');
    const tunnels = rules.filter((r) => r.ingress === 'passthrough').length;
    console.log(
      `[ForwardProxy] rules: ${rules.length} rule(s) (${tunnels} blind-tunnel), ` +
        `${catchAll ? 'catch-all present' : 'NO catch-all → unmatched hosts go DIRECT'}`
    );
    if (rules.some((r) => r.egress === 'proxy') && getRuntimeConfigRef()?.proxy?.enabled !== true) {
      console.warn(
        '[ForwardProxy] the rule table has "proxy" rules but proxy.enabled is not true — every proxied host falls back to DIRECT.'
      );
    }
  }
  return handle;
}
