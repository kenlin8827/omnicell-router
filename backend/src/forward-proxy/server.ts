import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { CertMinter, ensureCa } from './ca.js';
import { peekClientHello } from './sni.js';
import { splice, type SpliceDirection } from './relay.js';
import {
  DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS,
  FORWARD_PROXY_HANG_TIMEOUT_MS,
  FORWARD_PROXY_KEEPALIVE_MS,
} from '../config/defaults.js';
import type { ForwardProxyConfig } from '../config/types.js';
import {
  describeUpstreamFailure,
  filterHeaders,
  isRuleRejected,
  openViaProxy,
  parseProxy,
  ruleTunnels,
  setBootRules,
  setLiveForwardProxy,
  transitEgressFor,
  transitProxyFor,
  UPSTREAM_TIMEOUT_CODE,
  upstreamServernameOption,
} from './egress.js';
import { resolveUpstreamTls, type UpstreamTlsOptions } from './upstream-tls.js';
import type { ForwardProxyRule } from '../config/types.js';
import { createAccessTap, recordProxyConnect, recordProxyTunnel, type AccessTap } from './access-log.js';
import { closeH2Pool, forwardH2, type H2UpstreamTls } from './h2-forward.js';
import { createWsObserver } from './ws-frames.js';
import { findGateway, listGatewayHosts } from '../plugins/gateways.js';
import http2 from 'node:http2';

/**
 * Inbound forward proxy (the HTTP_PROXY / HTTPS_PROXY server).
 *
 * Design (settled & validated on Bun 1.3.14):
 *  - INTERCEPT by default: every HTTPS CONNECT is MITM'd. The decrypted
 *    request is inspected — LLM-protocol traffic (via `intercept`) enters the
 *    routing pipeline; everything else is forwarded transparently.
 *  - ONE ordered rule table decides both halves per host (ADR-0018,
 *    `forwardProxy.rules`): two fields per row — `ingress` = intercept (MITM,
 *    the default posture) / passthrough (blind tunnel) / reject, `egress` =
 *    direct / proxy. First match wins; loopback is
 *    always passthrough (cycle safety + local dev); an unmatched host
 *    falls back to direct + intercepted. `reject` is answered 403 on admission
 *    — before any tunnel is opened or certificate minted.
 *  - Bun node:tls gaps worked around (all verified experimentally):
 *      * no SNICallback → per-host tls.Server with an explicit cert, cached;
 *        the servername is read by peeking the raw ClientHello (sni.ts);
 *      * socket.pipe() from a TLSSocket does not flush buffered data →
 *        explicit relay (relay.ts);
 *      * tlsServer/httpServer.emit('connection', socket) is not honored →
 *        the decrypted stream is spliced over a loopback socket into an
 *        inner http.Server that does native Bun HTTP parsing;
 *      * the node:http 'upgrade' event is unusable (the handler's socket
 *        swallows every write and the parser then answers 505) → an
 *        `Upgrade:` handshake is caught on the decrypted stream before the
 *        inner server and relayed byte-verbatim (relayUpgrade).
 *  - Per-host terminators and minted certs are LRU-bounded
 *    (MAX_HOST_TERMINATORS / MAX_CACHED_CERTS): full capture sees every host
 *    a client visits, so an unbounded cache is an fd leak per host.
 *  - Transport-complete MITM: the decrypted stream is parsed by an h1 inner
 *    OR an h2 inner (prior-knowledge h2c loopback), picked by sniffing the
 *    first decrypted bytes for the h2 connection preface. Both inners run the
 *    SAME intercept chain and the SAME transparent forward — an h2 request is
 *    re-originated upstream over h2 (h2-forward.ts) so gRPC/Connect framing,
 *    trailers and bidi streams survive the hop, with an h1 fallback when the
 *    upstream refuses h2.
 *  - ALPN: every host offers both protocols, ordered by who is talking. Bun
 *    honours the SERVER's preference, so an unclaimed host offers
 *    ['http/1.1','h2'] (dual-offer clients keep the h1 path — zero regression;
 *    h2-only clients get h2) while a gateway-claimed host offers
 *    ['h2','http/1.1']. The negotiated protocol is only a hint: the preface is
 *    the authority (Bun does not reliably surface alpnProtocol at callback
 *    time).
 *
 * No-request-loss rule: the client's decoded stream may emit data the moment
 * the handshake completes — the 'data' listener is attached SYNCHRONOUSLY in
 * the secureConnection callback; pre-connect chunks are buffered.
 */

const MAX_HELLO_BYTES = 32 * 1024;
/** Bound on the buffered HTTP/1 request head examined for an `Upgrade:`
 *  handshake; a head that outgrows it goes to the inner server unexamined. */
const MAX_HEAD_BYTES = 32 * 1024;
/** LRU bound on per-host TLS terminators (each = one listening loopback socket
 *  + one minted leaf cert). Full capture sees EVERY host a client visits, so an
 *  unbounded map leaks one file descriptor per host for the life of the process. */
const MAX_HOST_TERMINATORS = 256;
/**
 * Grace window for an evicted terminator: long enough for a CONNECT that
 * already resolved its port to finish dialing, short enough to keep the fd
 * budget bounded. `server.close()` never touches established connections, so
 * this is the ONLY cost of eviction.
 */
const TERMINATOR_DRAIN_MS = 30_000;
/** Hard cap on the draining set — eviction must not become a second cache. */
const MAX_DRAINING_TERMINATORS = 64;
/**
 * One ledger row per this window, per terminator. A client that rejects the
 * intercepted leaf (pinning, missing CA) reconnects in a tight loop; without
 * the dedupe it would flush every real row out of the access ring.
 */
const CLIENT_TLS_ERROR_DEDUPE_MS = 5_000;
/**
 * Upper bound on "the error envelope is on its way" — the abort normally fires
 * the moment the envelope chunk reaches the client transport; this only covers
 * the case where no chunk ever arrives.
 */
const MITM_ABORT_FLUSH_MS = 1_000;
/**
 * How long a blind tunnel waits for client bytes before recording its decision
 * row without an identity. Never a relay delay — the tunnel is already flowing;
 * this only bounds the observation window for a server-speaks-first protocol.
 */
const CLIENT_ERROR_RESPONSE = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';
/** Raw-socket 403 for a CONNECT whose host a rule rejects (ADR-0018).
 *  Answered on the raw socket BEFORE the 200, so no tunnel and no minted
 *  certificate ever exist for a rejected host. */
const RULE_REJECT_RESPONSE =
  'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
/** Realm for the proxy-auth challenge (407). */
const PROXY_AUTH_REALM = 'OmniCellRouter';
/** Raw-socket 407: a CONNECT may arrive before any TLS material, so the only
 *  thing we can write is a plain HTTP/1.1 status line. */
const PROXY_AUTH_REQUIRED_RESPONSE =
  'HTTP/1.1 407 Proxy Authentication Required\r\n' +
  `Proxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"\r\n` +
  'Content-Length: 0\r\nConnection: close\r\n\r\n';
/**
 * Dedupe window for pre-admission ledger rows (407 / cap / bad request line).
 * A client failing auth or hammering the cap reconnects in a tight loop; the
 * row is the audit signal, not a per-attempt count — one row per window per
 * host keeps a hostile client from flushing real rows out of the access ring.
 */
const PRE_ADMISSION_ROW_DEDUPE_MS = CLIENT_TLS_ERROR_DEDUPE_MS;
const preAdmissionRowAt = new Map<string, number>();
/** true = this pre-admission row should be recorded; false = deduped. */
function shouldRecordPreAdmission(key: string): boolean {
  const now = Date.now();
  const last = preAdmissionRowAt.get(key) ?? 0;
  if (now - last < PRE_ADMISSION_ROW_DEDUPE_MS) return false;
  preAdmissionRowAt.set(key, now);
  if (preAdmissionRowAt.size > 512) {
    // Bounded: drop expired entries instead of growing per hostile host.
    for (const [k, t] of preAdmissionRowAt) if (now - t >= PRE_ADMISSION_ROW_DEDUPE_MS) preAdmissionRowAt.delete(k);
    if (preAdmissionRowAt.size > 512) preAdmissionRowAt.clear();
  }
  return true;
}

// (hop-by-hop header filtering and the proxy egress policy live in
//  egress.ts, shared with the pipeline's direct-forward relay.)

export interface ForwardProxyDeps {
  port: number;
  host: string;
  caDir: string;
  /**
   * Rule table (ADR-0018): ordered, first match wins — two fields per row:
   * `ingress` = intercept (MITM) / passthrough (blind tunnel) / reject,
   * `egress` = direct / proxy. Loopback is always passthrough. Boot snapshot —
   * `liveForwardProxy` (when provided) wins per request, so a console save
   * hot-applies.
   */
  rules?: ForwardProxyRule[];
  /**
   * Concurrent inbound socket cap; sockets opened past it are destroyed. Boot
   * snapshot — `liveForwardProxy` (when provided) wins per socket.
   */
  maxConnections?: number;
  /**
   * Basic proxy-auth token (any username). When set, every CONNECT and plain
   * request must carry a matching `Proxy-Authorization` header or it gets 407.
   * Unset = auth off (only legal on a loopback bind — see
   * `assertForwardProxyBindSafety`). Boot snapshot — `liveForwardProxy` wins.
   */
  authToken?: string;
  /**
   * Live `forwardProxy` config reader (the hot-apply runtime ref). When
   * present, `rules` is re-read per request — console saves take effect without
   * a gateway restart. Port/host/CA stay boot-frozen (they shape the listening
   * socket and cert material).
   */
  liveForwardProxy?: () => ForwardProxyConfig | undefined;
  /** Returns true when the request was fully handled (intercepted). */
  intercept: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  log?: (msg: string) => void;
  /**
   * Extra TLS options for an upstream TLS client we originate (the transparent
   * h2 forward and the Upgrade relay). Production leaves this unset — the
   * system trust store validates real upstream certificates; tests inject a
   * local CA so those legs can be exercised against a real TLS server.
   */
  upstreamTls?: H2UpstreamTls;
  /**
   * LRU bound on cached per-host TLS terminators (tests shrink it so eviction
   * is observable in a few connections); default MAX_HOST_TERMINATORS.
   */
  maxHostTerminators?: number;
}

export interface ForwardProxyHandle {
  port: number;
  caCertPem: string;
  /** Live inbound-socket count (the `maxConnections` accounting; tests use it). */
  activeConnections(): number;
  close(): Promise<void>;
}

interface ForwardTarget {
  host: string;
  port: number;
  path: string;
  secure: boolean;
  /** Access-log tap (non-intercepted forwards only); undefined = no capture. */
  tap?: AccessTap;
  /**
   * Body bytes already consumed by a failed h2 relay attempt (h2-forward.ts).
   * Written upstream BEFORE the live pipe so the h1 fallback never loses the
   * head of the body.
   */
  preface?: { chunks: Buffer[]; ended: boolean };
}

/** Split a `host[:port]` header value (bracketed IPv6 supported). */
function splitHostPort(value: string, defaultPort: number): { host: string; port: number } {
  const raw = (value || '').trim();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    const host = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    return { host, port: rest.startsWith(':') ? parseInt(rest.slice(1), 10) || defaultPort : defaultPort };
  }
  const colon = raw.lastIndexOf(':');
  // Exactly one colon ⇒ host:port; a bare IPv6 literal (several colons) has none.
  if (colon > 0 && raw.indexOf(':') === colon) {
    return { host: raw.slice(0, colon), port: parseInt(raw.slice(colon + 1), 10) || defaultPort };
  }
  return { host: raw, port: defaultPort };
}

/** One cached per-host TLS terminator (listening loopback socket + its port). */
interface HostTerminator {
  srv: tls.Server;
  port: number;
  /** `draining` = evicted from the LRU, still accepting the CONNECT already in flight. */
  state: 'live' | 'draining';
}

/**
 * The CONNECT authority an intercepted connection was opened for. Carried from
 * the CONNECT admission through the terminator into the inner request so the
 * upstream target keeps the client's port even when the request head omits it.
 */
interface MitmTarget {
  host: string;
  port: number;
  /**
   * Close the CLIENT transport for this connection.
   *
   * Needed because Bun's `res.socket.end()` on the inner http server is a no-op
   * for the loopback connection (verified 1.3.14: `writable` does not even
   * flip, the peer never sees FIN), so an error envelope written through the
   * inner server would otherwise leave the client's TLS session open — every
   * non-streaming client hangs on a response it already received in full.
   */
  abort: () => void;
}

/** Per-response slot carrying the connection's abort hook to `proxyFail`. */
const MITM_ABORT = Symbol('ocr.forwardProxy.mitmAbort');

/** One origin-form request head that carries an `Upgrade:` handshake. */
interface UpgradeHead {
  method: string;
  path: string;
  host: string;
  port: number;
  headers: http.IncomingHttpHeaders;
}

/**
 * Parse a request head that carries an `Upgrade:` handshake, else null.
 *
 * The head is read off the DECRYPTED stream (see `relayUpgrade` for why the
 * runtime's own upgrade event cannot be used). Only the target and the method
 * are extracted — the head itself is relayed byte-verbatim, so nothing about
 * the handshake (subprotocols, extensions, cookies) is ever re-serialized.
 */
function parseUpgradeHead(head: string, defaultPort: number): UpgradeHead | null {
  const lines = head.split('\r\n');
  const requestLine = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
  if (!requestLine) return null;
  const headers: http.IncomingHttpHeaders = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const upgrade = headers.upgrade;
  const connection = headers.connection;
  const hostHeader = headers.host;
  if (!upgrade || !connection || !hostHeader) return null;
  const tokens = String(connection).toLowerCase().split(',').map((v) => v.trim());
  if (!tokens.includes('upgrade')) return null;
  // Same port precedence as the request leg (ADR-0018 §3a): an explicit Host
  // port > the CONNECT authority's port > 443. A WebSocket client sends the
  // plain host name, so defaulting to 443 sent an upgrade for a non-443 target
  // to the wrong port.
  const { host, port } = splitHostPort(String(hostHeader), defaultPort);
  if (!host) return null;
  return { method: requestLine[1], path: requestLine[2], host, port, headers };
}

/** Send the request body upstream: the h2 relay's captured preface first (if
 *  any), then a straight pipe (non-intercepted forwards never had their
 *  stream consumed). With a tap, chunks tee into the access log alongside the
 *  pipe (both consumers see every chunk). */
function pumpRequestBody(
  req: http.IncomingMessage,
  upstream: http.ClientRequest,
  tap?: AccessTap,
  preface?: { chunks: Buffer[]; ended: boolean }
): void {
  if (preface) {
    for (const chunk of preface.chunks) {
      tap?.onReqChunk(chunk);
      upstream.write(chunk);
    }
    if (preface.ended) {
      upstream.end();
      return;
    }
  }
  if (tap) req.on('data', (d: Buffer) => tap.onReqChunk(d));
  req.pipe(upstream);
  req.on('error', () => {
    try {
      upstream.destroy();
    } catch {}
  });
}

/** Pipe the upstream response to the client, teeing chunks into the tap. */
function pipeUpResponse(up: http.IncomingMessage, res: http.ServerResponse, tap?: AccessTap): void {
  if (tap) up.on('data', (d: Buffer) => tap.onResChunk(d));
  up.pipe(res);
}

function forwardTo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t: ForwardTarget,
  upstreamTls: UpstreamTlsOptions
): Promise<void> {
  const egress = transitEgressFor(t.host);
  const proxyUrl = transitProxyFor(egress.proxy);
  if (proxyUrl) {
    return t.secure
      ? forwardSecureViaProxy(req, res, t, proxyUrl, upstreamTls)
      : forwardPlainViaProxy(req, res, t, proxyUrl, upstreamTls);
  }
  return forwardDirect(req, res, t, upstreamTls);
}

/**
 * Arm the kernel probe on an upstream socket (see `FORWARD_PROXY_KEEPALIVE_MS`).
 * A relayed leg has no application-level idle timeout — an SSE stream that has
 * gone quiet is indistinguishable from one between tokens — so the peer that
 * disappeared without FIN/RST is reaped by TCP keepalive instead. Failure is
 * non-fatal: some injected test sockets are not real handles.
 */
/**
 * The synthetic error our hang guard destroys a request with. It carries a CODE
 * so `describeUpstreamFailure` classifies it as a timeout (504) without string
 * matching a message that any future edit could reword.
 */
function hangGuardError(): Error & { code: string } {
  const err = new Error('upstream timeout') as Error & { code: string };
  err.code = UPSTREAM_TIMEOUT_CODE;
  return err;
}

function armUpstreamKeepalive(req: http.ClientRequest): void {
  req.on('socket', (s) => {
    try {
      s.setKeepAlive(true, FORWARD_PROXY_KEEPALIVE_MS);
    } catch {}
  });
}

function forwardDirect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t: ForwardTarget,
  upstreamTls: UpstreamTlsOptions
): Promise<void> {
  return new Promise((resolve) => {
    const transport = t.secure ? https : http;
    const upstream = transport.request(
      {
        host: t.host,
        port: t.port,
        method: req.method,
        path: t.path,
        headers: filterHeaders(req.headers),
        ...(t.secure ? { ...upstreamServernameOption(t.host), ...(upstreamTls.opts || {}) } : {}),
      } as https.RequestOptions,
      (up) => {
        // Headers arrived — the request is alive; clear the hang-protection
        // timer so long-lived streams (SSE direct forwards) are never killed.
        // Keepalive is what still reaps a half-dead peer (see relay.ts).
        upstream.setTimeout(0);
        res.writeHead(up.statusCode || 502, filterHeaders(up.headers as http.IncomingHttpHeaders));
        pipeUpResponse(up, res, t.tap);
        up.on('end', () => {
          t.tap?.finish(up.statusCode, up.headers);
          resolve();
        });
        up.on('error', () => {
          try {
            res.destroy();
          } catch {}
          t.tap?.finish(up.statusCode, up.headers, 'upstream error mid-response');
          resolve();
        });
      }
    );
    armUpstreamKeepalive(upstream);
    // Hang protection: a blackholed upstream (packets dropped, no RST — e.g. a
    // blocked host) would otherwise stall the client forever. Applies only
    // until response headers arrive.
    upstream.setTimeout(FORWARD_PROXY_HANG_TIMEOUT_MS, () => {
      upstream.destroy(hangGuardError());
    });
    upstream.on('error', (err: any) => {
      const failure = describeUpstreamFailure(err);
      t.tap?.finish(undefined, undefined, failure.note);
      proxyFail(res, failure.status, failure.message);
      resolve();
    });
    pumpRequestBody(req, upstream, t.tap, t.preface);
  });
}


/**
 * Answer with an error envelope and CLOSE the connection.
 *
 * `Connection: close` is not decoration: on Bun an error answer written through
 * the MITM inner server left the client's TLS session open (verified 1.3.14), so
 * a client that waits for the stream to end — every non-streaming HTTP client —
 * hung on a response it had already received in full. An error envelope is
 * terminal; the connection must say so.
 */
function proxyFail(res: http.ServerResponse, code: number, msg: string): void {
  try {
    if (!res.headersSent) {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    }
    res.end(msg);
    // An error envelope is terminal: close the client transport. On the MITM
    // leg the only working handle is the terminator's abort hook (the inner
    // server's `res.socket.end()` is inert on Bun); on the plain-proxy leg the
    // socket is ours to end. Never touch the h2 session socket — it is
    // multiplexed, and the stream's own end is the answer; the h2 guard must
    // run BEFORE the abort hook, which end()s the whole session.
    // Runtime-attached fields the declared `res` type cannot express.
    const resExt = res as unknown as { stream?: unknown; [MITM_ABORT]?: () => void };
    if (Boolean(resExt.stream)) return;
    const abort = resExt[MITM_ABORT];
    if (abort) {
      abort();
      return;
    }
    const endSocket = (): void => {
      try {
        if (res.socket && !res.socket.destroyed) res.socket.end();
      } catch {}
    };
    // After 'finish', not right after `end()`: the envelope must be on the wire
    // before the socket closes, or the client sees a truncated body.
    if (res.writableFinished) endSocket();
    else res.once('finish', endSocket);
  } catch {}
}
/**
 * HTTPS target via an outbound HTTP proxy: CONNECT tunnel → one-shot loopback
 * relay → https.request over the relay (TLS runs end-to-end through the
 * tunnel, so the real target certificate is what gets validated).
 */
function forwardSecureViaProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t: ForwardTarget,
  proxyUrl: string,
  upstreamTls: UpstreamTlsOptions
): Promise<void> {
  return new Promise((resolve) => {
    openViaProxy(proxyUrl, t.host, t.port)
      .then((pipeSock) => {
        const relay = net.createServer((c) => {
          c.pipe(pipeSock);
          pipeSock.pipe(c);
        });
        const cleanup = (): void => {
          try {
            relay.close();
          } catch {}
          try {
            pipeSock.destroy();
          } catch {}
        };
        relay.on('error', cleanup);
        relay.listen(0, '127.0.0.1', () => {
          const relayPort = (relay.address() as net.AddressInfo).port;
          const upstream = https.request(
            {
              host: '127.0.0.1',
              port: relayPort,
              method: req.method,
              path: t.path,
              headers: filterHeaders(req.headers),
              ...upstreamServernameOption(t.host),
              ...(upstreamTls.opts || {}),
            } as https.RequestOptions,
            (up) => {
              upstream.setTimeout(0);
              res.writeHead(up.statusCode || 502, filterHeaders(up.headers as http.IncomingHttpHeaders));
              pipeUpResponse(up, res, t.tap);
              up.on('end', () => {
                t.tap?.finish(up.statusCode, up.headers);
                cleanup();
                resolve();
              });
              up.on('error', () => {
                try {
                  res.destroy();
                } catch {}
                t.tap?.finish(up.statusCode, up.headers, 'upstream error mid-response');
                cleanup();
                resolve();
              });
            }
          );
          armUpstreamKeepalive(upstream);
          upstream.setTimeout(FORWARD_PROXY_HANG_TIMEOUT_MS, () => {
            upstream.destroy(hangGuardError());
          });
          upstream.on('error', (err: any) => {
            const failure = describeUpstreamFailure(err, { proxied: true });
            t.tap?.finish(undefined, undefined, failure.note);
            proxyFail(res, failure.status, failure.message);
            cleanup();
            resolve();
          });
          pumpRequestBody(req, upstream, t.tap, t.preface);
        });
      })
      .catch((err: any) => {
        // The CONNECT to the outbound proxy itself failed — a different class
        // from an origin failure, and the note must say so.
        t.tap?.finish(undefined, undefined, `outbound proxy connect failed: ${err?.code || err?.message || err}`);
        proxyFail(res, 502, `Forward proxy: outbound proxy connection failed (${err?.message || err})`);
        resolve();
      });
  });
}

/** Plain-HTTP target via an outbound HTTP proxy (absolute-URI request form). */
function forwardPlainViaProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t: ForwardTarget,
  proxyUrl: string,
  upstreamTls: UpstreamTlsOptions
): Promise<void> {
  return new Promise((resolve) => {
    const p = parseProxy(proxyUrl);
    if (!p) {
      void forwardDirect(req, res, t, upstreamTls).then(resolve);
      return;
    }
    const headers = filterHeaders(req.headers);
    if (p.auth) headers['proxy-authorization'] = p.auth;
    const upstream = http.request(
      {
        host: p.host,
        port: p.port,
        method: req.method,
        path: `http://${t.host}:${t.port}${t.path}`,
        headers,
      },
      (up) => {
        upstream.setTimeout(0);
        res.writeHead(up.statusCode || 502, filterHeaders(up.headers as http.IncomingHttpHeaders));
        pipeUpResponse(up, res, t.tap);
        up.on('end', () => {
          t.tap?.finish(up.statusCode, up.headers);
          resolve();
        });
        up.on('error', () => {
          try {
            res.destroy();
          } catch {}
          t.tap?.finish(up.statusCode, up.headers, 'upstream error mid-response');
          resolve();
        });
      }
    );
    armUpstreamKeepalive(upstream);
    upstream.setTimeout(FORWARD_PROXY_HANG_TIMEOUT_MS, () => {
      upstream.destroy(hangGuardError());
    });
    upstream.on('error', (err: any) => {
      const failure = describeUpstreamFailure(err, { proxied: true });
      t.tap?.finish(undefined, undefined, failure.note);
      proxyFail(res, failure.status, failure.message);
      resolve();
    });
    pumpRequestBody(req, upstream, t.tap, t.preface);
  });
}

export async function createForwardProxyServer(deps: ForwardProxyDeps): Promise<ForwardProxyHandle> {
  const log = deps.log ?? (() => {});
  setLiveForwardProxy(deps.liveForwardProxy);
  setBootRules(deps.rules);
  const ca = ensureCa(deps.caDir);
  const minter = new CertMinter(ca);

  // ── inner HTTP server: parses decrypted MITM traffic, intercept-or-forward ──
  const inner = http.createServer((req, res) => {
    void handleInnerRequest(req, res, false);
  });
  inner.on('clientError', (_err, socket) => {
    try {
      socket.end(CLIENT_ERROR_RESPONSE);
    } catch {}
  });
  // ── h2 loopback inner (prior-knowledge h2c): the transport-complete half of
  //  the MITM leg. EVERY host may reach it (see the ALPN offer below) — h2 is
  //  not a vendor feature but the base transport of gRPC/Connect clients, and
  //  a proxy that terminates TLS must re-originate the protocol it accepted.
  //  Both legs dispatch through the same intercept chain, and the http2
  //  compatibility API mirrors the node-http req/res shape the gateway
  //  contract consumes.
  const h2Inner = http2.createServer();
  h2Inner.on('request', (req, res) => {
    void handleInnerRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      true
    );
  });
  h2Inner.on('sessionError', (err) => {
    log(`h2 inner session error: ${err?.message || err}`);
  });

  async function handleInnerRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    h2Leg: boolean
  ): Promise<void> {
    try {
      if (await deps.intercept(req, res)) return;
      // h2 compatibility requests carry the target in `:authority` (there is
      // no `host` header) — accept either so gateway-declined h2 traffic can
      // still fall through to transparent forward.
      const hostHeader = String(req.headers[':authority'] || req.headers.host || '');
      // Port precedence: an explicit Host/`:authority` port > the CONNECT
      // authority's port > 443. HTTPS clients routinely omit the port from the
      // request head (they assume 443), so `CONNECT host:8443` + `Host: host`
      // used to be forwarded to 443 — a silent wrong-port forward. The CONNECT
      // port rides in on the per-connection `mitmTargets` entry (see
      // onDecryptedConnection), keyed by the loopback source port.
      const mitmTarget = mitmTargets.get(req.socket?.remotePort ?? -1);
      const connectPort = mitmTarget?.port;
      if (mitmTarget) {
        (res as unknown as Record<symbol, () => void>)[MITM_ABORT] = mitmTarget.abort;
      }
      const { host, port } = splitHostPort(hostHeader, connectPort ?? 443);
      if (!host) {
        proxyFail(res, 400, 'Forward proxy: missing Host header');
        return;
      }
      const tap = createAccessTap({
        host,
        port,
        method: req.method,
        path: req.url || '/',
        // h2 pseudo-headers are transport framing, not wire headers — the row
        // already carries host/method/path from them.
        requestHeaders: h2Leg
          ? (Object.fromEntries(
              Object.entries(req.headers).filter(([k]) => !k.startsWith(':'))
            ) as http.IncomingHttpHeaders)
          : req.headers,
      });
      const target: ForwardTarget = { host, port, path: req.url || '/', secure: true, tap };
      // Rule admission on the MITM leg: the inner Host can differ from the
      // CONNECT target, so the same gate runs here (403 lands in the ledger).
      if (isRuleRejected(host)) {
        tap?.finish(403, undefined, 'rejected by rule');
        proxyFail(res, 403, 'Forward proxy: host rejected by rule');
        return;
      }
      // Protocol fidelity: an h2 client is answered upstream over h2 (gRPC and
      // Connect cannot survive an h1 hop). `forwardH2` reports false when the
      // upstream is not h2 — nothing has reached the client at that point, so
      // the h1 forwarder takes over (ADR-0017 §3).
      const upstreamTls = resolveUpstreamTls(deps.upstreamTls);
      if (h2Leg) {
        const relay = await forwardH2(req, res, target, upstreamTls);
        if (relay.owned) return;
        target.preface = relay.preface;
      }
      await forwardTo(req, res, target, upstreamTls);
    } catch {
      proxyFail(res, 502, 'Forward proxy error');
    }
  }

  // ── per-host TLS terminators (explicit certs; SNICallback unsupported on Bun) ──
  // EVERY host advertises h2; the ORDER is what differs. Bun honours the
  // SERVER's preference (verified: server ['http/1.1','h2'] + client
  // ['h2','http/1.1'] negotiates http/1.1), so:
  //   * unclaimed host  → ['http/1.1','h2']: dual-offer clients (curl, browsers,
  //     most SDKs) keep the h1 path untouched, while h2-only clients
  //     (gRPC/Connect — Cursor included) get h2 instead of a broken h1
  //     downgrade. h1 interception therefore has ZERO regression surface.
  //   * gateway-claimed host → ['h2','http/1.1']: the plugin wants h2 even
  //     from dual-offer clients (it speaks the vendor's h2 wire).
  // The negotiated protocol is only a hint — the preface sniff below is the
  // authority. Ports are assigned at the bottom (before any CONNECT arrives).
  let innerH1Port = 0;
  let innerH2Port = 0;
  // Per-host terminators, LRU-bounded (see MAX_HOST_TERMINATORS): insertion
  // order IS the LRU order — a hit re-inserts. Eviction closes the listener
  // only, never an established connection (server.close stops accepting).
  const terminators = new Map<string, HostTerminator>();
  const pendingTerminators = new Map<string, Promise<HostTerminator>>();
  /**
   * Evicted terminators still finishing their grace window (see
   * evictTerminators). Bounded: the whole point of the LRU is a finite fd
   * budget, so draining may not become a second unbounded cache.
   */
  const drainingTerminators = new Map<string, HostTerminator>();
  /**
   * Per-connection CONNECT authority, keyed by the loopback source port of the
   * connection this proxy dials into the inner server (= the inner server's
   * `remotePort`). Entries live exactly as long as their connection.
   */
  const mitmTargets = new Map<number, MitmTarget>();

  function hostTlsPort(host: string, targetPort: number): Promise<number> {
    const h2First = listGatewayHosts().has(host);
    // Cache by host + CONNECT port + ALPN mode: a runtime gateway install flips
    // a host's ALPN order and a second CONNECT to another port of the same host
    // needs its own authority context, so neither may reuse a stale terminator.
    const cacheKey = `${host}:${targetPort}|${h2First ? 'gateway' : 'plain'}`;
    const live = terminators.get(cacheKey);
    if (live) {
      terminators.delete(cacheKey);
      terminators.set(cacheKey, live);
      return Promise.resolve(live.port);
    }
    const inflight = pendingTerminators.get(cacheKey);
    if (inflight) return inflight.then((t) => t.port);
    const created = createTerminator(host, targetPort, h2First, cacheKey).then(
      (t) => {
        pendingTerminators.delete(cacheKey);
        return t;
      },
      (err) => {
        // Never cache a FAILED creation — a transient listen error (e.g. an
        // ephemeral-port collision) must not permanently degrade this host to
        // the blind-tunnel fallback; the next connection retries from scratch.
        pendingTerminators.delete(cacheKey);
        throw err;
      }
    );
    pendingTerminators.set(cacheKey, created);
    return created.then((t) => t.port);
  }

  function createTerminator(
    host: string,
    targetPort: number,
    h2First: boolean,
    cacheKey: string
  ): Promise<HostTerminator> {
    return new Promise<HostTerminator>((resolve, reject) => {
      const { key, cert } = minter.get(host);
      const target: Omit<MitmTarget, 'abort'> = { host, port: targetPort };
      let clientErrorLoggedAt = 0;
      /** One ledger row per dedupe window for a client that never got a request through. */
      const reportClientFailure = (reason: string): void => {
        const now = Date.now();
        if (now - clientErrorLoggedAt < CLIENT_TLS_ERROR_DEDUPE_MS) return;
        clientErrorLoggedAt = now;
        recordProxyConnect({ host, port: targetPort, note: `connect (${reason})` });
      };
      const srv = tls.createServer(
        { key, cert, ALPNProtocols: h2First ? ['h2', 'http/1.1'] : ['http/1.1', 'h2'] },
        (tlsSock) => onDecryptedConnection(tlsSock, target, reportClientFailure)
      );
      // A client that REJECTS our leaf (certificate pinning, a missing CA in its
      // trust store) fails inside the handshake and never sends a request, so
      // this is the only place that failure is visible. The operator's question
      // is always "why does this app not work through the proxy" — a console
      // log line nobody tails is not an answer, so it lands in the ledger.
      //
      // Bun 1.3.14 does NOT emit `tlsClientError` when the client rejects the
      // certificate (verified: the server sees `secureConnection` and then a
      // bare socket close), so the abort is also caught on the decrypted stream
      // (see onDecryptedConnection). Both paths share this dedupe: a pinned
      // client retries in a tight loop and would otherwise evict every real row
      // from the ring.
      srv.on('tlsClientError', (e: any) => {
        const message = String(e?.message || e);
        log(`tlsClientError ${host}:${targetPort}: ${message}`);
        reportClientFailure(`client TLS handshake failed: ${message}`);
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const terminator: HostTerminator = {
          srv,
          port: (srv.address() as net.AddressInfo).port,
          state: 'live',
        };
        terminators.set(cacheKey, terminator);
        evictTerminators();
        resolve(terminator);
      });
    });
  }

  /**
   * Retire the LRU tail into a DRAINING set instead of closing it outright.
   *
   * `srv.close()` stops accepting but leaves established connections alone —
   * however a CONNECT that already resolved this terminator's port and has not
   * dialed yet would hit ECONNREFUSED and degrade to a blind tunnel, silently
   * losing interception for that exchange. The grace window covers exactly that
   * window; a drained terminator is never reused for a NEW CONNECT (it is out
   * of `terminators`, so `hostTlsPort` misses and mints a fresh one).
   */
  function evictTerminators(): void {
    const bound = deps.maxHostTerminators ?? MAX_HOST_TERMINATORS;
    while (terminators.size > bound) {
      const oldest = terminators.keys().next();
      if (oldest.done) return;
      const victim = terminators.get(oldest.value);
      terminators.delete(oldest.value);
      if (!victim) continue;
      victim.state = 'draining';
      drainingTerminators.set(oldest.value, victim);
      const timer = setTimeout(() => {
        drainingTerminators.delete(oldest.value);
        try {
          victim.srv.close();
        } catch {}
      }, TERMINATOR_DRAIN_MS);
      // Never hold the process open for a drained listener.
      (timer as unknown as { unref?: () => void }).unref?.();
      while (drainingTerminators.size > MAX_DRAINING_TERMINATORS) {
        const stale = drainingTerminators.keys().next();
        if (stale.done) break;
        const forced = drainingTerminators.get(stale.value);
        drainingTerminators.delete(stale.value);
        try {
          forced?.srv.close();
        } catch {}
      }
      log(`terminator evicted (LRU bound ${bound}), draining: ${oldest.value}`);
    }
  }

  /**
   * Decrypted-stream entry for one TLS session: decide h2 / h1 / Upgrade, then
   * hand the bytes on.
   *
   * Attach SYNCHRONOUSLY — a Bun TLSSocket may drop data that arrives with no
   * listener; buffer until the loopback conn is ready. Bun does not reliably
   * expose alpnProtocol on the server side at callback time, so the negotiated
   * ALPN is only a hint — the h2 connection preface ('PRI * HTTP/2.0') is the
   * authority. On the h1 path the request head is buffered until it is
   * complete so an `Upgrade:` handshake can be caught BEFORE the inner server
   * (relayUpgrade); a head that outgrows MAX_HEAD_BYTES goes to the inner
   * server unexamined.
   */
  function onDecryptedConnection(
    tlsSock: tls.TLSSocket,
    target: Omit<MitmTarget, 'abort'>,
    reportClientFailure: (reason: string) => void
  ): void {
    const pending: Buffer[] = [];
    let conn: net.Socket | null = null;
    let decided = false;
    /** Decrypted bytes seen so far — zero at close means the client never spoke. */
    let decryptedBytes = 0;
    /**
     * Set when the inner request answered with a terminal error envelope: the
     * client transport is closed as soon as that envelope has been handed over.
     * The next chunk the inner server emits IS the envelope, so this is exact —
     * no flush timing guesswork (an immediate `end()` truncated the response;
     * the inner server's own socket `end()` is inert on Bun).
     */
    let abortRequested = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const finishAbort = (): void => {
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
        abortTimer = undefined;
      }
      if (!abortRequested) return;
      abortRequested = false;
      try {
        tlsSock.end();
      } catch {}
    };

    const onDecrypted = (d: Buffer): void => {
      decryptedBytes += d.length;
      if (conn) {
        if (!conn.write(d)) {
          tlsSock.pause();
          conn.once('drain', () => tlsSock.resume());
        }
        return;
      }
      pending.push(d);
      if (decided) return;
      const buf = Buffer.concat(pending);
      const isH2 =
        tlsSock.alpnProtocol === 'h2' || buf.subarray(0, 14).toString('latin1') === 'PRI * HTTP/2.0';
      if (!isH2) {
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd === -1) {
          // No complete head yet: keep buffering ONLY while the bytes still
          // look like an HTTP/1 request — a non-HTTP tunnel payload (or a head
          // past MAX_HEAD_BYTES) must not wait for a head that never arrives.
          const lineEnd = buf.indexOf('\r\n');
          const firstLine = (lineEnd === -1 ? buf.subarray(0, 64) : buf.subarray(0, lineEnd)).toString('latin1');
          const looksHttp =
            lineEnd === -1
              ? /^[A-Z]{1,8}( [^\r\n]*)?$/.test(firstLine) // still mid request-line
              : /^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(firstLine);
          if (buf.length <= MAX_HEAD_BYTES && looksHttp) return;
        } else {
          const parsed = parseUpgradeHead(buf.subarray(0, headEnd + 4).toString('latin1'), target.port);
          if (parsed) {
            decided = true;
            tlsSock.removeListener('data', onDecrypted);
            void relayUpgrade(tlsSock, buf, parsed);
            return;
          }
        }
      }
      decided = true;
      conn = net.connect(isH2 ? innerH2Port : innerH1Port, '127.0.0.1', () => {
        // Register the CONNECT target BEFORE the first byte reaches the inner
        // server — the inner request must never run without its authority
        // context. The key is this loopback connection's source port, which is
        // exactly the inner server's `remotePort` for the same TCP connection.
        const localPort = conn!.localPort;
        if (localPort) {
          mitmTargets.set(localPort, {
            host: target.host,
            port: target.port,
            abort: () => {
              if (abortRequested) return;
              abortRequested = true;
              // Safety net: an envelope that never produces a chunk (or a
              // response already mid-flight) still closes, just not instantly.
              abortTimer = setTimeout(finishAbort, MITM_ABORT_FLUSH_MS);
              (abortTimer as unknown as { unref?: () => void }).unref?.();
            },
          });
        }
        for (const p of pending) conn!.write(p);
        pending.length = 0;
        conn!.on('data', (d2: Buffer) => {
          if (!tlsSock.write(d2)) {
            conn!.pause();
            tlsSock.once('drain', () => {
              conn!.resume();
              finishAbort();
            });
            return;
          }
          finishAbort();
        });
        conn!.on('end', () => {
          try {
            tlsSock.end();
          } catch {}
        });
        conn!.on('error', () => {
          try {
            tlsSock.destroy();
          } catch {}
        });
      });
      conn.on('close', () => {
        const localPort = conn?.localPort;
        if (localPort) mitmTargets.delete(localPort);
      });
      conn.on('error', () => {
        try {
          tlsSock.destroy();
        } catch {}
      });
    };

    tlsSock.on('data', onDecrypted);
    tlsSock.on('end', () => {
      try {
        conn?.end();
      } catch {}
    });
    // The pinning signal Bun actually gives us: a TLS session that closes
    // WITHOUT a single decrypted byte. A client that rejects our leaf aborts
    // right after the handshake, so no request head ever arrives.
    tlsSock.on('close', () => {
      if (decryptedBytes === 0) {
        reportClientFailure(
          'client closed the intercepted TLS session before any request (certificate rejected or client abort)'
        );
      }
    });
    tlsSock.on('error', () => {
      try {
        conn?.destroy();
      } catch {}
    });
  }

  // ── tunnel (no decryption) ──
  function tunnel(socket: net.Socket, host: string, port: number, replay?: Buffer): void {
    // Egress comes from the ordered rule table (ADR-0018).
    const egress = transitEgressFor(host);
    const proxyUrl = transitProxyFor(egress.proxy);
    // Tunnel observation (ADR-0020): a blind tunnel is opaque BY DESIGN, so the
    // identity we can see without decrypting (SNI, offered ALPN), the byte
    // totals and the lifetime are the whole story. The peek rides the relay's
    // own tap — it can never steal bytes from the splice.
    const started = Date.now();
    let reqBytes = replay?.length ?? 0;
    let respBytes = 0;
    let identity: string | undefined;
    let identityDone = false;
    const hello: Buffer[] = [];
    let helloTotal = 0;
    const observe = (dir: SpliceDirection, chunk: Buffer): void => {
      if (dir === 'b2a') {
        respBytes += chunk.length;
        return;
      }
      reqBytes += chunk.length;
      if (identityDone) return;
      hello.push(chunk);
      helloTotal += chunk.length;
      const peek = peekClientHello(Buffer.concat(hello, helloTotal));
      if (!peek.isTls) {
        identityDone = true;
        identity = 'not tls';
        return;
      }
      if (peek.complete || helloTotal > MAX_HELLO_BYTES) {
        identityDone = true;
        // The peek buffer is only needed until the identity is known; a tunnel
        // can outlive it by hours, so do not pin the hello bytes.
        hello.length = 0;
        if (!peek.complete) return;
        const bits = [peek.sni ? `sni ${peek.sni}` : 'no sni'];
        // Space-separated: a protocol id may itself contain '/', so a slash
        // separator would make "h2" + "http/1.1" unreadable.
        if (peek.alpn?.length) bits.push(`alpn ${peek.alpn.join(' ')}`);
        identity = bits.join(', ');
      }
    };
    let closed = false;
    const closeRow = (note: string): void => {
      if (closed) return;
      closed = true;
      recordProxyTunnel({
        host,
        port,
        note: identity ? `${note}, ${identity}` : note,
        reqBytes,
        respBytes,
        durationMs: Date.now() - started,
      });
    };
    socket.on('close', () => closeRow('connect (tunnel closed)'));
    if (proxyUrl) {
      openViaProxy(proxyUrl, host, port)
        .then((up) => {
          up.on('close', () => closeRow('connect (tunnel via outbound proxy closed)'));
          if (replay && replay.length) up.write(replay);
          splice(socket, up, observe);
        })
        .catch((err: any) => {
          log(`tunnel via outbound proxy failed for ${host}:${port}: ${err?.message || err}`);
          closeRow(`connect (tunnel failed: outbound proxy ${err?.code || err?.message || err})`);
          try {
            socket.destroy();
          } catch {}
        });
      return;
    }
    const up = net.connect(port, host, () => {
      if (replay && replay.length) up.write(replay);
      splice(socket, up, observe);
    });
    up.on('close', () => closeRow('connect (tunnel closed)'));
    up.on('error', (err: any) => closeRow(`connect (tunnel failed: ${err?.code || err?.message || err})`));
    up.on('error', () => {
      try {
        socket.destroy();
      } catch {}
    });
    socket.on('error', () => {
      try {
        up.destroy();
      } catch {}
    });
  }

  /**
   * WebSocket / generic `Upgrade:` relay on the MITM leg.
   *
   * Bun's node:http 'upgrade' event is NOT usable (verified on 1.3.14: the
   * socket handed to the handler swallows every write and the parser keeps
   * running, answering 505 to whatever the client sends next), so the
   * handshake is caught on the DECRYPTED stream before it reaches the inner
   * server and relayed byte-verbatim: request head (+ any bytes the client
   * already pipelined after it) → origin socket, then a raw bidirectional
   * splice. Nothing is re-serialized — an upgrade is a single hop, so the
   * client's own handshake headers are exactly what the origin must see, and
   * any upgrade protocol rides this path, not just WebSocket.
   *
   * Non-TLS `ws://` through the plain proxy port is NOT covered: that leg
   * never decrypts, and the same runtime gap blocks its 'upgrade' event.
   */
  async function relayUpgrade(tlsSock: tls.TLSSocket, head: Buffer, parsed: UpgradeHead): Promise<void> {
    const { host, port } = parsed;
    // A client gateway may OWN the handshake (a WS-native vendor wire). Without
    // this hook an upgrade on a claimed host is relayed verbatim and the plugin
    // never sees it — the same host would be handled for requests but not for
    // sockets. Returning false (or throwing) falls through to the relay.
    const gateway = findGateway({ method: parsed.method, url: parsed.path, headers: parsed.headers });
    if (gateway?.handleUpgrade) {
      try {
        const owned = await gateway.handleUpgrade({
          socket: tlsSock,
          head,
          host,
          port,
          method: parsed.method,
          path: parsed.path,
          headers: parsed.headers,
        });
        if (owned) return;
      } catch {
        // Ownership was ambiguous — never leave the client hanging on a socket
        // nobody drives; the gateway already had its chance to answer.
        try {
          tlsSock.destroy();
        } catch {}
        return;
      }
    }
    const tap = createAccessTap({
      host,
      port,
      method: parsed.method,
      path: parsed.path,
      requestHeaders: parsed.headers,
    });
    let status: number | undefined;
    let finished = false;
    const finish = (note?: string): void => {
      if (finished) return;
      finished = true;
      tap?.finish(status, undefined, note);
    };
    // Only answer with an error envelope while the origin has said nothing —
    // once its bytes are flowing, the client owns the stream.
    const fail = (note: string): void => {
      finish(note);
      if (status !== undefined) {
        try {
          tlsSock.destroy();
        } catch {}
        return;
      }
      try {
        tlsSock.write(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nForward proxy: ${note}`
        );
        tlsSock.end();
      } catch {}
    };
    /**
     * The same answer, built from a classified origin failure (ADR-0019): status,
     * client-facing sentence and ledger note all come from
     * `describeUpstreamFailure`, so an upgrade leg reports a TLS trust failure
     * exactly like the h1 and h2 legs do.
     */
    const failWith = (failure: { status: number; message: string; note: string }): void => {
      finish(failure.note);
      if (status !== undefined) {
        try {
          tlsSock.destroy();
        } catch {}
        return;
      }
      try {
        tlsSock.write(
          `HTTP/1.1 ${failure.status} ${failure.status === 504 ? 'Gateway Timeout' : 'Bad Gateway'}\r\n` +
            'Content-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n' +
            failure.message
        );
        tlsSock.end();
      } catch {}
    };

    const onOrigin = (origin: net.Socket): void => {
      // Hang guard until the origin answers: a blackholed upgrade must not
      // hold the client's socket open forever. Cleared on the first byte so a
      // long-lived WebSocket is never killed.
      const hang = setTimeout(() => {
        try {
          origin.destroy();
        } catch {}
        fail('upgrade upstream timed out');
      }, FORWARD_PROXY_HANG_TIMEOUT_MS);
      // Frame-level observation (ADR-0020): the relay stays byte-verbatim, the
      // observer only counts what crosses it. Frames begin after the origin
      // response head, so the first chunk is split at its CRLFCRLF marker.
      const ws = createWsObserver();
      let responseHeadSeen = false;
      // The response head is accumulated across chunks: an origin may split it,
      // and the frames start at its end — guessing from a single chunk either
      // lost the status or fed handshake bytes to the frame parser.
      let responseHead = '';
      const noteFor = (): string => (status === 101 ? ws.note() : '');
      origin.on('data', (d: Buffer) => {
        clearTimeout(hang);
        tap?.onResChunk(d);
        if (!responseHeadSeen) {
          responseHead += d.toString('latin1');
          const end = responseHead.indexOf('\r\n\r\n');
          if (end === -1) {
            if (responseHead.length > MAX_HEAD_BYTES) responseHeadSeen = true;
            return;
          }
          responseHeadSeen = true;
          if (status === undefined) {
            const m = /^HTTP\/1\.[01] (\d{3})/.exec(responseHead.slice(0, 16));
            if (m) status = Number(m[1]);
          }
          const rest = responseHead.slice(end + 4);
          if (rest.length) ws.push('s2c', Buffer.from(rest, 'latin1'));
          return;
        }
        ws.push('s2c', d);
      });
      tlsSock.on('data', (d: Buffer) => {
        tap?.onReqChunk(d);
        ws.push('c2s', d);
      });
      origin.on('close', () => {
        clearTimeout(hang);
        finish(noteFor());
      });
      tlsSock.on('close', () => {
        clearTimeout(hang);
        finish(noteFor());
      });
      origin.write(head);
      splice(tlsSock, origin);
    };

    const egress = transitEgressFor(host);
    const proxyUrl = transitProxyFor(egress.proxy);
    const upstreamTls = resolveUpstreamTls(deps.upstreamTls).opts;
    if (proxyUrl) {
      openViaProxy(proxyUrl, host, port)
        .then((tunnelSock) => {
          try {
            const origin = tls.connect(
              { socket: tunnelSock, ...upstreamServernameOption(host), ...(upstreamTls || {}) },
              () => onOrigin(origin)
            );
            origin.once('error', (err: any) => failWith(describeUpstreamFailure(err, { proxied: true })));
          } catch {
            // A synchronous TLS-option throw (bad servername, bad material) must
            // not escape a socket callback — answer the client instead.
            try {
              tunnelSock.destroy();
            } catch {}
            fail('upgrade upstream TLS setup failed');
          }
        })
        .catch((err: any) => fail(`upgrade outbound proxy connection failed${err?.code ? ` (${err.code})` : ''}`));
      return;
    }
    try {
      const origin = tls.connect(
        { host, port, ...upstreamServernameOption(host), ...(upstreamTls || {}) },
        () => onOrigin(origin)
      );
      origin.once('error', (err: any) => failWith(describeUpstreamFailure(err)));
    } catch {
      fail('upgrade upstream TLS setup failed');
    }
  }

  // ── CONNECT: peek ClientHello → MITM, else blind tunnel ──
  function handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    // Bracket-aware: `[::1]:8443` is a valid authority, and `rawHost` becomes
    // the CERTIFICATE IDENTITY for a no-SNI client (see the MITM branch), so a
    // naive `split(':')` would mint a leaf for `[`.
    const { host: rawHost, port } = splitHostPort(String(req.url || ''), 443);
    if (!rawHost) {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {}
      return;
    }
    if (!authorize(req.headers['proxy-authorization'])) {
      if (shouldRecordPreAdmission(`407:${rawHost}`)) {
        recordProxyConnect({ host: rawHost, port, note: 'connect (407, missing or bad proxy auth)' });
      }
      try {
        socket.end(PROXY_AUTH_REQUIRED_RESPONSE);
      } catch {}
      return;
    }
    if (!admit(socket)) {
      // A raw socket may not be TLS-ready yet, so there is no status line to
      // write — closing it is the only honest answer.
      if (shouldRecordPreAdmission(`cap:${rawHost}`)) {
        recordProxyConnect({ host: rawHost, port, note: 'connect (503-equivalent, connection cap reached)' });
      }
      try {
        socket.destroy();
      } catch {}
      return;
    }
    // Rule admission (ADR-0018): a rejected host is answered 403 on the raw
    // socket BEFORE the 200, so no tunnel is opened and no certificate is
    // minted for a host this machine refuses to reach.
    if (isRuleRejected(rawHost)) {
      log(`reject CONNECT ${rawHost}:${port} (egress rule)`);
      recordProxyConnect({ host: rawHost, port, note: 'connect (rejected by rule)' });
      try {
        socket.end(RULE_REJECT_RESPONSE);
      } catch {}
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) socket.unshift(head);

    if (ruleTunnels(rawHost)) {
      recordProxyConnect({ host: rawHost, port, note: 'connect (blind tunnel)' });
      // Any bytes that arrived with the CONNECT are ALREADY back in the socket's
      // read buffer (the unshift above), so no replay is passed here: doing so
      // would duplicate the client's first bytes upstream. The identity peek
      // rides the relay's tap, which is attached at dial time.
      tunnel(socket, rawHost, port);
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let decided = false;
    const onData = (d: Buffer): void => {
      if (decided) return;
      chunks.push(d);
      total += d.length;
      const buf = Buffer.concat(chunks, total);
      const peek = peekClientHello(buf);
      if (!peek.isTls) {
        // Not a TLS handshake at all (SSH, IMAPS, a bespoke protocol): relay it
        // NOW. Waiting for a ClientHello that can never arrive used to stall
        // such a tunnel until 32 KiB had accumulated on the socket.
        decided = true;
        socket.pause();
        socket.removeListener('data', onData);
        log(`tunnel ${rawHost}:${port} (not tls)`);
        recordProxyConnect({ host: rawHost, port, note: 'connect (not tls, blind tunnel)' });
        tunnel(socket, rawHost, port, buf);
        return;
      }
      if (peek.complete) {
        // A ClientHello WITHOUT SNI is still interceptable: the CONNECT
        // authority is the only identity the client offered (IP-literal
        // targets can never carry SNI — RFC 6066 forbids an IP there). Falling
        // back to a blind tunnel here let any client opt out of interception
        // simply by omitting the extension.
        const identity = peek.sni || rawHost;
        decided = true;
        socket.pause();
        socket.removeListener('data', onData);
        log(peek.sni ? `MITM ${identity}` : `MITM ${identity} (no SNI, authority identity)`);
        void startMitm(socket, buf, identity, port, peek.sni ? 'sni' : 'authority');
        return;
      }
      if (total > MAX_HELLO_BYTES) {
        decided = true;
        socket.pause();
        socket.removeListener('data', onData);
        log(`tunnel ${rawHost}:${port} (ClientHello never completed)`);
        recordProxyConnect({ host: rawHost, port, note: 'connect (hello incomplete, blind tunnel)' });
        tunnel(socket, rawHost, port, buf);
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {}
    });
  }

  async function startMitm(
    socket: net.Socket,
    hello: Buffer,
    identity: string,
    connectPort: number,
    by: 'sni' | 'authority'
  ): Promise<void> {
    try {
      const port = await hostTlsPort(identity, connectPort);
      recordProxyConnect({
        host: identity,
        port: connectPort,
        note: by === 'sni' ? 'connect (mitm)' : 'connect (mitm by authority, no sni)',
      });
      const up = net.connect(port, '127.0.0.1', () => {
        up.write(hello);
        splice(socket, up);
      });
      up.on('error', () => {
        try {
          socket.destroy();
        } catch {}
      });
      socket.on('error', () => {
        try {
          up.destroy();
        } catch {}
      });
    } catch (err: any) {
      log(`MITM setup failed for ${identity}: ${err?.message || err} — blind tunnel fallback`);
      recordProxyConnect({ host: identity, port: connectPort, note: 'connect (mitm setup failed, blind tunnel fallback)' });
      tunnel(socket, identity, connectPort);
    }
  }

  // ── outer proxy server: CONNECT + plain-HTTP absolute-URI requests ──
  const proxy = http.createServer((req, res) => {
    void handlePlainProxyRequest(req, res);
  });
  proxy.on('connect', handleConnect);
  proxy.on('clientError', (_err, socket) => {
    try {
      socket.end(CLIENT_ERROR_RESPONSE);
    } catch {}
  });

  // ── inbound proxy auth (407) ──
  // When `forwardProxy.authToken` is set, every CONNECT and plain request must
  // present `Proxy-Authorization: Basic <base64 anyuser:token>`. The comparison
  // is constant-time: the header comes off the network, and a byte-at-a-time
  // compare leaks the token's length and prefix through timing.
  const currentAuthToken = (): string | undefined => {
    const live = deps.liveForwardProxy?.()?.authToken;
    const token = String(live ?? deps.authToken ?? '').trim();
    return token || undefined;
  };
  const authorize = (header: string | string[] | undefined): boolean => {
    const expected = currentAuthToken();
    if (!expected) return true;
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) return false;
    const scheme = /^Basic\s+(.+)$/i.exec(raw.trim());
    if (!scheme) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(scheme[1], 'base64').toString('utf8');
    } catch {
      return false;
    }
    // Any username is accepted — the token is the secret (browsers and several
    // SDKs cannot set a proxy username at all).
    const colon = decoded.indexOf(':');
    const presented = Buffer.from(colon === -1 ? decoded : decoded.slice(colon + 1));
    const want = Buffer.from(expected);
    return presented.length === want.length && crypto.timingSafeEqual(presented, want);
  };

  // ── inbound socket cap ──
  // Every tunneled/MITM'd socket costs TWO fds (the accepted socket plus its
  // decrypted loopback peer) and, when MITM'd, a TLS terminator — so an
  // unbounded proxy listener is a local fd-exhaustion vector: one client can
  // open CONNECTs faster than the OS reclaims them.
  //
  // The cap is enforced at ADMISSION (the two points where the proxy starts
  // spending resources: a CONNECT tunnel and a plain-HTTP request), not at
  // accept time, because Bun's node:http exposes none of the accept-side hooks
  // (verified on 1.3.14: no `'connection'` event on http.Server, and both
  // `server.maxConnections` and `server.timeout` are inert). A socket that
  // never sends a byte is therefore bounded only by the listen backlog; the
  // admission cap covers the part that multiplies. The cap is read per
  // admission, so a console save hot-applies.
  const liveSockets = new Set<net.Socket>();
  let capWarnedAt = 0;
  const currentCap = (): number =>
    deps.liveForwardProxy?.()?.maxConnections ?? deps.maxConnections ?? DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS;
  /** true = this socket may proceed; false = it was already refused. */
  const admit = (socket: net.Socket): boolean => {
    if (liveSockets.has(socket)) return true;
    const cap = currentCap();
    if (liveSockets.size >= cap) {
      const now = Date.now();
      if (now - capWarnedAt > CLIENT_TLS_ERROR_DEDUPE_MS) {
        capWarnedAt = now;
        log(`connection cap reached (${cap}) — refusing new exchanges`);
      }
      return false;
    }
    liveSockets.add(socket);
    // Bun emits 'end' but NOT 'close' on the socket it hands to an http.Server
    // 'connect' handler (verified on 1.3.14), so releasing only on 'close'
    // would leak a slot per finished tunnel and wedge the cap shut. All three
    // terminal signals release; a double release is a no-op on a Set.
    const release = (): void => {
      liveSockets.delete(socket);
    };
    socket.once('close', release);
    socket.once('end', release);
    socket.once('error', release);
    return true;
  };

  async function handlePlainProxyRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!authorize(req.headers['proxy-authorization'])) {
      const plainAuthHost = String(req.headers.host || req.socket.remoteAddress || 'unknown').split(':')[0];
      if (shouldRecordPreAdmission(`407:${plainAuthHost}`)) {
        recordProxyConnect({
          host: plainAuthHost,
          port: req.socket.remotePort || 0,
          note: `plain ${req.method || '?'} (407, missing or bad proxy auth)`,
        });
      }
      try {
        res.writeHead(407, {
          'proxy-authenticate': `Basic realm="${PROXY_AUTH_REALM}"`,
          'content-length': '0',
          connection: 'close',
        });
        res.end();
      } catch {}
      return;
    }
    let target: URL;
    let target0: URL;
    try {
      target = new URL(req.url || '');
      target0 = target;
    } catch {
      const badReqHost = String(req.headers.host || req.socket.remoteAddress || 'unknown').split(':')[0];
      if (shouldRecordPreAdmission(`badreq:${badReqHost}`)) {
        recordProxyConnect({
          host: badReqHost,
          port: req.socket.remotePort || 0,
          note: `plain ${req.method || '?'} (400, not an absolute-form request URI)`,
        });
      }
      proxyFail(res, 400, 'Forward proxy requires an absolute-form request URI');
      return;
    }
    if (!admit(req.socket)) {
      if (shouldRecordPreAdmission(`cap:${target0.hostname}`)) {
        recordProxyConnect({
          host: target0.hostname,
          port: parseInt(target0.port || '0', 10),
          note: `plain ${req.method} (503, connection cap reached)`,
        });
      }
      proxyFail(res, 503, 'Forward proxy: connection limit reached');
      return;
    }
    const intercept = !ruleTunnels(target.hostname);
    try {
      // `ingress: 'passthrough'` = a blind tunnel: the intercept chain never
      // runs and the exchange is forwarded transparently.
      if (intercept && (await deps.intercept(req, res))) return;
      const tap = createAccessTap({
        host: target.hostname,
        port: parseInt(target.port || (target.protocol === 'https:' ? '443' : '80'), 10),
        method: req.method,
        path: req.url || '/',
        requestHeaders: req.headers,
      });
      if (isRuleRejected(target.hostname)) {
        tap?.finish(403, undefined, 'rejected by rule');
        proxyFail(res, 403, 'Forward proxy: host rejected by rule');
        return;
      }
      await forwardTo(
        req,
        res,
        {
          host: target.hostname,
          port: parseInt(target.port || (target.protocol === 'https:' ? '443' : '80'), 10),
          path: target.pathname + target.search,
          secure: target.protocol === 'https:',
          tap,
        },
        resolveUpstreamTls(deps.upstreamTls)
      );
    } catch {
      proxyFail(res, 502, 'Forward proxy error');
    }
  }

  await listen(inner);
  innerH1Port = (inner.address() as net.AddressInfo).port;
  await listen(h2Inner as unknown as net.Server);
  innerH2Port = (h2Inner.address() as net.AddressInfo).port;
  try {
    await listen(proxy, deps.port, deps.host);
  } catch (err) {
    // Fault-tolerance: never leak the inner listeners when our public listen
    // fails (port busy etc.) — the caller logs the error and the gateway
    // keeps running without the proxy.
    try {
      inner.close();
    } catch {}
    try {
      h2Inner.close();
    } catch {}
    throw err;
  }
  const port = (proxy.address() as net.AddressInfo).port;
  log(`listening on ${deps.host}:${port} (inner h1 ${innerH1Port}, h2 ${innerH2Port})`);

  return {
    port,
    caCertPem: ca.caCertPem,
    activeConnections: () => liveSockets.size,
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const terminator of terminators.values()) {
          try {
            terminator.srv.close();
          } catch {}
        }
        for (const terminator of drainingTerminators.values()) {
          try {
            terminator.srv.close();
          } catch {}
        }
        drainingTerminators.clear();
        try {
          proxy.close();
        } catch {}
        try {
          inner.close();
        } catch {}
        try {
          h2Inner.close();
        } catch {}
        closeH2Pool();
        resolve();
      });
    },
  };
}

/**
 * Listen with one EADDRINUSE retry. Port 0 means the OS picks a free port, so
 * a collision should be impossible — but under concurrent test workers Bun has
 * been observed racing the ephemeral allocation (EADDRINUSE on port 0). The
 * retry keeps that infrastructure flake from masking real regressions.
 */
async function listen(server: net.Server, port = 0, host = '127.0.0.1'): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return;
    } catch (err: any) {
      if (attempt > 0 || err?.code !== 'EADDRINUSE') throw err;
      // Detach the dead listener state before retrying the same server.
      try {
        server.close();
      } catch {}
    }
  }
}