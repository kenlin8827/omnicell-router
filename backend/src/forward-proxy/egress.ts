import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { InterceptPosture, ForwardProxyConfig, ForwardProxyRule } from '../config/types.js';
import { DEFAULT_FORWARD_PROXY_INTERCEPT } from '../config/defaults.js';
import { listGatewayHosts } from '../plugins/gateways.js';
import { resolveHost, type RuleDecision } from './rules.js';
import { outboundProxyUrl } from '../utils/proxy.js';

/**
 * Shared egress plumbing for everything that forwards bytes to an ORIGINAL
 * dial target: the forward-proxy's forwarders and tunnels (server.ts,
 * h2-forward.ts) and the pipeline's direct-forward relay
 * (surfaces/direct-forward.ts).
 *
 * `transitProxyFor` turns a rule decision into the outbound proxy URL. The table
 * itself (ADR-0018) is read through `transitEgressFor`, which consults the LIVE
 * config per request so a console save hot-applies without a restart.
 * Module-level because only one forward proxy instance exists per process
 * (last created wins — createForwardProxyServer sets them).
 */

let liveForwardProxy: (() => ForwardProxyConfig | undefined) | undefined;
/** Boot snapshot of the rule table (the live reader wins per request). */
let bootRules: ForwardProxyRule[] | undefined;
/** Boot snapshot of the interception posture (same fallback order). */
let bootIntercept: InterceptPosture = DEFAULT_FORWARD_PROXY_INTERCEPT;

export function setLiveForwardProxy(reader: (() => ForwardProxyConfig | undefined) | undefined): void {
  liveForwardProxy = reader;
}

/** Boot snapshot of the rule table + posture — only one forward proxy exists per process. */
export function setBootRules(rules: ForwardProxyRule[] | undefined, intercept?: InterceptPosture): void {
  bootRules = rules;
  bootIntercept = intercept ?? DEFAULT_FORWARD_PROXY_INTERCEPT;
}

/** The rule table in force for this request (live config first, boot snapshot second). */
export function currentRules(): ForwardProxyRule[] | undefined {
  return liveForwardProxy?.()?.rules ?? bootRules;
}

/** The interception posture in force for this request (live config first, boot snapshot second). */
export function currentInterceptPosture(): InterceptPosture {
  return liveForwardProxy?.()?.intercept ?? bootIntercept;
}

/**
 * The full decision for one host. Every leg and the console preview call this
 * (directly or through the thin helpers below), so they cannot disagree.
 *
 * Claims are read from the LIVE plugin registry on every call (the host swaps it
 * atomically on install/uninstall/disable, ADR-0017), and the posture comes from
 * the live config ref — so neither a plugin install nor a console save needs a
 * restart.
 */
export function ruleDecision(host: string): RuleDecision {
  return resolveHost(host, currentRules(), {
    claimed: listGatewayHosts(),
    intercept: currentInterceptPosture(),
  });
}

/**
 * Admission gate: true when a rule rejects this host. Every proxy leg consults
 * this BEFORE opening a tunnel or minting a certificate.
 */
export function isRuleRejected(host: string): boolean {
  return ruleDecision(host).action === 'reject';
}

/** True when the host must NOT be intercepted (blind tunnel). */
export function ruleTunnels(host: string): boolean {
  return ruleDecision(host).tunnel;
}

/**
 * The `action` half of the decision, in the shape `transitProxyFor` consumes.
 *
 * A table decision is host-scoped and FINAL: the provider/model-scoped
 * `proxy.includes` / `proxy.excludes` gate must never downgrade it to direct —
 * that silent downgrade is exactly the lie the table exists to prevent, so the
 * proxy URL is resolved straight from the outbound proxy settings.
 */
export interface TransitEgress {
  /** Rule-table egress for this host: true = via the outbound proxy, false = direct, undefined = no table installed. */
  proxy?: boolean;
}

export function transitEgressFor(host: string): TransitEgress {
  const rules = currentRules();
  if (!rules || rules.length === 0) return {};
  return { proxy: ruleDecision(host).action === 'proxy' };
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
    // HTTP/2 pseudo-headers (`:method`, `:path`, `:authority`, …) are transport
    // framing. The h2→h1 fallback reuses the same request object, and Node's
    // h1 client throws ERR_INVALID_HTTP_TOKEN on them.
    if (k.startsWith(':')) continue;
    if (HOP_BY_HOP[k.toLowerCase()]) continue;
    out[k] = v;
  }
  return out;
}

export function transitProxyFor(proxy?: boolean): string | undefined {
  // proxy: the rule-table egress for this host (see transitEgressFor);
  // undefined = no table installed, which means direct.
  if (proxy !== true) return undefined;
  return outboundProxyUrl();
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

/**
 * `servername` for an upstream TLS client we originate on a proxied client's
 * behalf — empty for an IP literal.
 *
 * RFC 6066 forbids an IP address in SNI, and Node/Bun do not degrade quietly:
 * `tls.connect({ servername: '127.0.0.1' })` THROWS synchronously (verified on
 * Bun 1.3.14: "Setting the TLS ServerName to an IP address is not permitted").
 * Thrown from a socket 'data' listener that is an uncaught exception, so an
 * IP-addressed origin (an IP literal in the request line, a passthrough-rule
 * host, an
 * internal service) used to kill the connection silently. An IP origin needs
 * no SNI: the certificate is validated against its IP SAN instead.
 */
export function upstreamServernameOption(host: string): { servername?: string } {
  const h = (host || '').trim().replace(/^\[|\]$/g, '');
  if (!h) return {};
  // Dotted IPv4 or a bare IPv6 literal (colons never appear in a DNS name).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return {};
  return { servername: h };
}

/**
 * ONE honest sentence for a failed origin leg, shared by every forwarder (h1
 * direct, h1 through the outbound proxy, the h2 relay and the Upgrade relay).
 *
 * Every failure used to collapse into "upstream connection failed", throwing
 * away the only information that identifies the cause: a TLS TRUST failure (a
 * private CA the operator has to trust — ADR-0019), a DNS failure, a refused
 * port. The error code now rides in the message the client sees AND in the
 * ledger note, so "why did this host stop working" is answerable from the
 * console instead of from a packet capture.
 */
export interface UpstreamFailure {
  status: number;
  message: string;
  /** Ledger note (a stable prefix + the code), never user-facing prose. */
  note: string;
}

/** Codes that mean "we could not verify the origin's certificate". */
const TLS_TRUST_CODES: Record<string, true> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: true,
  SELF_SIGNED_CERT_IN_CHAIN: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true,
  UNABLE_TO_GET_ISSUER_CERT: true,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: true,
  CERT_HAS_EXPIRED: true,
  CERT_NOT_YET_VALID: true,
  CERT_UNTRUSTED: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true,
  ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED: true,
};

/**
 * TLS failures that are NOT a trust decision — a version/cipher mismatch, a
 * broken handshake. Grouped with the trust codes for the ledger, but the
 * operator must not be told to "trust the issuing CA" for them.
 */
const TLS_HANDSHAKE_CODES: Record<string, true> = {
  ERR_TLS_INVALID_PROTOCOL_VERSION: true,
  ERR_TLS_HANDSHAKE_TIMEOUT: true,
  ERR_SSL_WRONG_VERSION_NUMBER: true,
  ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION: true,
  ERR_SSL_NO_SHARED_CIPHER: true,
};

/** Our own hang guard's code (never a socket error). */
export const UPSTREAM_TIMEOUT_CODE = 'OCR_UPSTREAM_TIMEOUT';

const DNS_CODES: Record<string, true> = { ENOTFOUND: true, EAI_AGAIN: true, EAI_FAIL: true, EAI_NONAME: true };

/**
 * Classify an origin-leg error.
 *
 * `timedOut` is passed by the callers that arm their own hang guard (the guard
 * destroys the request with a synthetic `upstream timeout` error, so the code
 * is ours, not the socket's).
 */
export function describeUpstreamFailure(
  err: unknown,
  opts: { proxied?: boolean; timedOut?: boolean; prefix?: string } = {}
): UpstreamFailure {
  const via = opts.proxied ? ' (via outbound proxy)' : '';
  const prefix = opts.prefix ?? 'Forward proxy';
  const code = String((err as { code?: string })?.code ?? '');
  const message = String((err as { message?: string })?.message ?? err ?? '');
  const timedOut = opts.timedOut === true || code === UPSTREAM_TIMEOUT_CODE || message === 'upstream timeout';
  if (timedOut) {
    return {
      status: 504,
      message: `${prefix}: upstream timed out${via} (target unreachable from this machine?)`,
      note: 'upstream timeout',
    };
  }
  if (code && TLS_TRUST_CODES[code]) {
    return {
      status: 502,
      message:
        `${prefix}: upstream TLS certificate rejected (${code})${via} — ` +
        'trust the issuing CA via forwardProxy.upstreamTls.caFile',
      note: `upstream tls: ${code}`,
    };
  }
  if (code && TLS_HANDSHAKE_CODES[code]) {
    return {
      status: 502,
      message: `${prefix}: upstream TLS handshake failed (${code})${via} — the origin does not accept this client's protocol or cipher`,
      note: `upstream tls: ${code}`,
    };
  }
  if (code && DNS_CODES[code]) {
    return {
      status: 502,
      message: `${prefix}: upstream host could not be resolved (${code})${via}`,
      note: `upstream dns: ${code}`,
    };
  }
  return {
    status: 502,
    message: `${prefix}: upstream connection failed${code ? ` (${code})` : ''}${via}`,
    note: `upstream connect: ${code || message || 'unknown'}`,
  };
}
