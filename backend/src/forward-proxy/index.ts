import path from 'node:path';
import crypto from 'node:crypto';
import { CA_CERT_FILENAME, resolveCaDir } from './ca.js';
import { getOcrHomeDir } from '../cli/paths.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { ForwardProxyConfig } from '../config/types.js';
import { DEFAULT_FORWARD_PROXY_PORT, DEFAULT_FORWARD_PROXY_HOST, DEFAULT_FORWARD_PROXY_INTERCEPT, DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS } from '../config/defaults.js';
import { getRuntimeConfigRef, loadConfig } from '../config/index.js';
import { isApiKeyUsable } from '../auth/api-keys.js';
import { createForwardProxyServer, type ForwardProxyHandle } from './server.js';
import { createProxyInterceptor } from './interceptor.js';
import { setGatewayChatServices, buildGatewayChatServices } from '../surfaces/gateway-chat.js';
import { setProxyAccessLogSettingsReader, setProxyAccessLogPersistDir, initProxyAccessLogPersistence } from './access-log.js';
import { listGatewayHosts } from '../plugins/gateways.js';
import { setUpstreamTlsReader } from './upstream-tls.js';

/** Literal loopback bind/listen address — 0.0.0.0/:: count as exposed. */
function isLiteralLoopbackHost(host: string): boolean {
  const h = (host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return !h || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * Refuse a listener that could serve proxy traffic without a credential.
 *
 * Full capture means the proxy decrypts and records whatever its clients send;
 * a credential-less listener lets anyone who can reach it inherit that. Two
 * ways in: a non-loopback bind (every interface) or
 * `forwardProxy.requireCredential` (loopback included). Both need at least one
 * enabled OCR API key, since its secret IS the proxy password. Throws (the
 * caller turns it into a visible start failure, never a silent downgrade).
 */
export function assertForwardProxyBindSafety(
  host: string,
  hasApiKeys: boolean,
  requireCredential = false
): void {
  // Deliberately NOT `isLoopbackHost`: that helper counts 0.0.0.0 as "loopback"
  // for MITM cycle-safety (an unspecified target is never decrypted), which is
  // the exact opposite of what a BIND gate needs — 0.0.0.0 means every
  // interface. Only a literal loopback address is safe without a credential.
  const loopback = isLiteralLoopbackHost(host);
  if (loopback && !requireCredential) return;
  if (hasApiKeys) return;
  throw new Error(
    loopback
      ? 'forwardProxy.requireCredential is on but no enabled API key exists — every proxy request would be refused (407). ' +
          'Create an API key first (clients send Proxy-Authorization: Basic <any:keySecret>).'
      : `forwardProxy.host is "${host}" (not loopback) but no enabled API key exists — ` +
          'an unauthenticated MITM proxy must not be exposed beyond this machine. ' +
          'Create an API key (clients then send Proxy-Authorization: Basic <any:keySecret>) or bind 127.0.0.1.'
  );
}

/**
 * Start the inbound forward proxy (HTTP_PROXY / HTTPS_PROXY server).
 * Enabled via config.yaml `forwardProxy.enabled`; defaults: port 4555,
 * loopback-only. The MITM CA lives in the machine-wide shared dir (see
 * `resolveCaDir`); the access log stays under this book-set's home.
 */
export async function startForwardProxy(
  cfg: ForwardProxyConfig,
  orchestrator: PipelineOrchestrator
): Promise<ForwardProxyHandle> {
  const host = cfg.host?.trim() || DEFAULT_FORWARD_PROXY_HOST;
  const bootConfig = getRuntimeConfigRef() ?? loadConfig();
  const bootNow = Date.now();
  const bootKeys = (bootConfig.apiKeys ?? []).filter(
    (k) => typeof k.key === 'string' && k.key.length > 0 && isApiKeyUsable(k, bootNow)
  );
  // Bind-safety gate BEFORE anything listens: API-key auth is the only proxy
  // credential, so a credential-less listener (non-loopback bind, or
  // `requireCredential` on loopback) without a usable key is refused.
  assertForwardProxyBindSafety(host, bootKeys.length > 0, cfg.requireCredential === true);
  // Non-loopback must always authenticate; boot-frozen so deleting every key
  // later fails closed (407) instead of opening the listener.
  // `forwardProxy.requireCredential` is read live by the server (hot-applies).
  const loopbackBind = isLiteralLoopbackHost(host);
  const caDir = resolveCaDir(cfg.caDir);
  const intercept = createProxyInterceptor(orchestrator);
  // Gateway-plugin chat seam (ADR-0017): the services ride the same
  // orchestrator the interceptor uses, so plugins dispatch through the
  // identical routing pipeline as the native legs.
  // Key binding (ADR-0017): resolve the plugin's `accountKeyId` against the
  // LIVE config snapshot so console edits apply without a restart.
  const liveKey = (id: string) => (getRuntimeConfigRef() ?? loadConfig()).apiKeys?.find((k) => k.id === id);
  setGatewayChatServices(buildGatewayChatServices(orchestrator, liveKey));
  // Proxy CONNECT credentials (ADR-0017): the Basic password IS an OCR API key
  // secret. Matched in constant time against the live config; disabled/expired
  // keys resolve to undefined. The username is ignored (names are not unique).
  const resolveApiKey = (secret: string): { id: string; name: string } | undefined => {
    // An empty presented password must never match an empty configured key —
    // that would turn `Basic anything:` into a credential.
    if (!secret) return undefined;
    const keys = (getRuntimeConfigRef() ?? loadConfig()).apiKeys ?? [];
    const presented = Buffer.from(secret);
    let found: (typeof keys)[number] | undefined;
    for (const key of keys) {
      // A hand-edited config may carry null/non-string entries; skip them
      // instead of throwing inside a CONNECT handler.
      if (typeof key.key !== 'string' || key.key.length === 0) continue;
      const want = Buffer.from(key.key);
      if (want.length === presented.length && crypto.timingSafeEqual(want, presented)) found = key;
    }
    if (!found || !isApiKeyUsable(found)) return undefined;
    return { id: found.id, name: found.name };
  };
  // Hot-apply seam: the access-log flags re-read the live runtime ref per
  // request, so console saves need no restart.
  setProxyAccessLogPersistDir(path.join(getOcrHomeDir(), 'forward-proxy', 'access-log'));
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
  // Interception posture (ADR-0018 Revision 4): the default decrypts only
  // plugin-claimed hosts and explicit `ingress: intercept` rows. `all` is the
  // audit posture — a standing machine-wide decryption the operator must be
  // told about in the log, not just in a YAML value.
  if (cfg.intercept === 'all') {
    console.warn(
      '[ForwardProxy] forwardProxy.intercept is "all" — EVERY host proxied here is decrypted (machine-wide TLS interception, audit mode). ' +
        'Every client trust store must carry this CA; set `intercept: claims` to decrypt only plugin-claimed hosts.'
    );
  }
  const handle = await createForwardProxyServer({
    port: cfg.port ?? DEFAULT_FORWARD_PROXY_PORT,
    host,
    caDir,
    maxConnections: cfg.maxConnections,
    resolveApiKey,
    authRequired: !loopbackBind,
    rules: cfg.rules,
    interceptPosture: cfg.intercept,
    // Hot-apply seam: rules / intercept re-read the runtime ref per
    // request, so console saves need no restart.
    liveForwardProxy: () => getRuntimeConfigRef()?.forwardProxy,
    intercept,
    log: (m) => console.log(`[ForwardProxy] ${m}`),
  });
  console.log(`[ForwardProxy] ready on http://${host}:${handle.port} — MITM CA: ${path.join(caDir, CA_CERT_FILENAME)}`);
  // One line that answers "who gets decrypted on this machine?" — the posture
  // and the claim count are the whole answer under the default (ADR-0018
  // Revision 4), so they belong in the boot log next to the table summary.
  const rules = cfg.rules || [];
  const posture = cfg.intercept ?? DEFAULT_FORWARD_PROXY_INTERCEPT;
  const claimedCount = listGatewayHosts().size;
  const catchAll = rules.find((r) => r.match === '*');
  console.log(
    `[ForwardProxy] rules: ${rules.length} rule(s) (${rules.filter((r) => r.ingress === 'passthrough').length} blind-tunnel), ` +
      `${catchAll ? 'catch-all present' : 'NO catch-all → unmatched hosts go DIRECT'}, ` +
      `intercept: ${posture} (${posture === 'all' ? 'EVERY host decrypted' : `${claimedCount} claimed host(s) + explicit intercept rows decrypted`})`
  );
  if (catchAll?.ingress === 'intercept' && posture !== 'all') {
    console.warn(
      '[ForwardProxy] the catch-all row says `ingress: intercept` but intercept is "claims" — it only decrypts hosts a gateway plugin claims. ' +
        'Write `intercept: all` for machine-wide decryption, or `ingress: passthrough` on the catch-all to say what actually happens.'
    );
  }
  if (rules.some((r) => r.egress === 'proxy') && getRuntimeConfigRef()?.proxy?.enabled !== true) {
    console.warn(
      '[ForwardProxy] the rule table has "proxy" rules but proxy.enabled is not true — every proxied host falls back to DIRECT.'
    );
  }
  return handle;
}
