import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { CertMinter, ensureCa } from './ca.js';
import { parseClientHelloSNI } from './sni.js';
import { splice } from './relay.js';
import { matchBypass, type BypassEntry } from './bypass.js';
import { FORWARD_PROXY_HANG_TIMEOUT_MS } from '../config/defaults.js';
import type { ForwardProxyConfig } from '../config/types.js';
import {
  currentBypassHosts,
  filterHeaders,
  openViaProxy,
  parseProxy,
  setLiveForwardProxy,
  transitProxyFor,
} from './egress.js';

/**
 * Inbound forward proxy (the HTTP_PROXY / HTTPS_PROXY server).
 *
 * Design (settled & validated on Bun 1.3.14):
 *  - FULL CAPTURE by default: every HTTPS CONNECT is MITM'd. The decrypted
 *    request is inspected — LLM-protocol traffic (via `intercept`) enters the
 *    routing pipeline; everything else is forwarded transparently.
 *  - Transit egress optionally via the outbound proxy policy
 *    (`viaOutboundProxy` — CONNECT through config.proxy, e.g. clash), so
 *    network-blocked targets stay reachable for tunnels and forwards.
 *  - Exceptions are blind-tunneled, never decrypted: loopback targets and
 *    `bypassHosts` matches.
 *  - Bun node:tls gaps worked around (all verified experimentally):
 *      * no SNICallback → per-host tls.Server with an explicit cert, cached;
 *        the servername is read by peeking the raw ClientHello (sni.ts);
 *      * socket.pipe() from a TLSSocket does not flush buffered data →
 *        explicit relay (relay.ts);
 *      * tlsServer/httpServer.emit('connection', socket) is not honored →
 *        the decrypted stream is spliced over a loopback socket into an
 *        inner http.Server that does native Bun HTTP parsing.
 *  - ALPN is pinned to http/1.1 so clients never negotiate h2 into the
 *    HTTP/1.1 inner parser.
 *
 * No-request-loss rule: the client's decoded stream may emit data the moment
 * the handshake completes — the 'data' listener is attached SYNCHRONOUSLY in
 * the secureConnection callback; pre-connect chunks are buffered.
 */

const MAX_HELLO_BYTES = 32 * 1024;
const CLIENT_ERROR_RESPONSE = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';

// (hop-by-hop header filtering and the outbound-proxy egress policy live in
//  egress.ts, shared with the pipeline's direct-forward relay.)

export interface ForwardProxyDeps {
  port: number;
  host: string;
  caDir: string;
  /**
   * Bypass list: bare strings = pure tunnel (direct); `{ host, viaProxy }`
   * entries choose the egress per host (viaProxy → through the outbound
   * proxy policy). Boot snapshot — `liveForwardProxy` (when provided) wins
   * per request, so console saves hot-apply without a restart.
   */
  bypassHosts?: (string | BypassEntry)[];
  /**
   * Route transit (bypass tunnels + non-intercepted forwards) through the
   * outbound proxy policy (`config.proxy` — url/includes/excludes). Default
   * false = direct egress. Recommended on for network-blocked targets.
   * Boot snapshot — `liveForwardProxy` (when provided) wins per request.
   */
  viaOutboundProxy?: boolean;
  /**
   * Live `forwardProxy` config reader (the hot-apply runtime ref). When
   * present, `bypassHosts` and `viaOutboundProxy` are re-read per request —
   * console saves take effect without a gateway restart. Port/host/CA stay
   * boot-frozen (they shape the listening socket and cert material).
   */
  liveForwardProxy?: () => ForwardProxyConfig | undefined;
  /** Returns true when the request was fully handled (intercepted). */
  intercept: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  log?: (msg: string) => void;
}

export interface ForwardProxyHandle {
  port: number;
  caCertPem: string;
  close(): Promise<void>;
}

interface ForwardTarget {
  host: string;
  port: number;
  path: string;
  secure: boolean;
  /** Per-request egress override (bypass entries); undefined = global flag. */
  viaProxy?: boolean;
}


/** Send the request body upstream: a straight pipe (non-intercepted
 *  forwards never had their stream consumed). */
function pumpRequestBody(req: http.IncomingMessage, upstream: http.ClientRequest): void {
  req.pipe(upstream);
  req.on('error', () => {
    try {
      upstream.destroy();
    } catch {}
  });
}

function forwardTo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t: ForwardTarget
): Promise<void> {
  const proxyUrl = transitProxyFor(t.host, t.port, t.viaProxy);
  if (proxyUrl) {
    return t.secure
      ? forwardSecureViaProxy(req, res, t, proxyUrl)
      : forwardPlainViaProxy(req, res, t, proxyUrl);
  }
  return forwardDirect(req, res, t);
}

function forwardDirect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t: ForwardTarget
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
        ...(t.secure ? { servername: t.host.replace(/^\[|\]$/g, '') } : {}),
      } as https.RequestOptions,
      (up) => {
        // Headers arrived — the request is alive; clear the hang-protection
        // timer so long-lived streams (SSE direct forwards) are never killed.
        upstream.setTimeout(0);
        res.writeHead(up.statusCode || 502, filterHeaders(up.headers as http.IncomingHttpHeaders));
        up.pipe(res);
        up.on('end', () => {
          resolve();
        });
        up.on('error', () => {
          try {
            res.destroy();
          } catch {}
          resolve();
        });
      }
    );
    // Hang protection: a blackholed upstream (packets dropped, no RST — e.g. a
    // blocked host) would otherwise stall the client forever. Applies only
    // until response headers arrive.
    upstream.setTimeout(FORWARD_PROXY_HANG_TIMEOUT_MS, () => {
      upstream.destroy(new Error('upstream timeout'));
    });
    upstream.on('error', (err: any) => {
      const timedOut = err?.message === 'upstream timeout';
      try {
        if (!res.headersSent) res.writeHead(timedOut ? 504 : 502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(timedOut ? 'Forward proxy: upstream timed out (target unreachable from this machine?)' : 'Forward proxy: upstream connection failed');
      } catch {}
      resolve();
    });
    pumpRequestBody(req, upstream);
  });
}


function proxyFail(res: http.ServerResponse, code: number, msg: string): void {
  try {
    if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(msg);
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
  proxyUrl: string
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
              servername: t.host.replace(/^\[|\]$/g, ''),
            } as https.RequestOptions,
            (up) => {
              upstream.setTimeout(0);
              res.writeHead(up.statusCode || 502, filterHeaders(up.headers as http.IncomingHttpHeaders));
              up.pipe(res);
              up.on('end', () => {
                cleanup();
                resolve();
              });
              up.on('error', () => {
                try {
                  res.destroy();
                } catch {}
                cleanup();
                resolve();
              });
            }
          );
          upstream.setTimeout(FORWARD_PROXY_HANG_TIMEOUT_MS, () => {
            upstream.destroy(new Error('upstream timeout'));
          });
          upstream.on('error', (err: any) => {
            const timedOut = err?.message === 'upstream timeout';
            proxyFail(
              res,
              timedOut ? 504 : 502,
              timedOut ? 'Forward proxy: upstream timed out (via outbound proxy)' : 'Forward proxy: upstream connection failed (via outbound proxy)'
            );
            cleanup();
            resolve();
          });
          pumpRequestBody(req, upstream);
        });
      })
      .catch((err: any) => {
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
  proxyUrl: string
): Promise<void> {
  return new Promise((resolve) => {
    const p = parseProxy(proxyUrl);
    if (!p) {
      void forwardDirect(req, res, t).then(resolve);
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
        up.pipe(res);
        up.on('end', () => {
          resolve();
        });
        up.on('error', () => {
          try {
            res.destroy();
          } catch {}
          resolve();
        });
      }
    );
    upstream.setTimeout(FORWARD_PROXY_HANG_TIMEOUT_MS, () => {
      upstream.destroy(new Error('upstream timeout'));
    });
    upstream.on('error', (err: any) => {
      const timedOut = err?.message === 'upstream timeout';
      proxyFail(
        res,
        timedOut ? 504 : 502,
        timedOut ? 'Forward proxy: upstream timed out (via outbound proxy)' : 'Forward proxy: upstream connection failed (via outbound proxy)'
      );
      resolve();
    });
    pumpRequestBody(req, upstream);
  });
}

export async function createForwardProxyServer(deps: ForwardProxyDeps): Promise<ForwardProxyHandle> {
  const log = deps.log ?? (() => {});
  setLiveForwardProxy(deps.liveForwardProxy, deps.viaOutboundProxy === true);
  const ca = ensureCa(deps.caDir);
  const minter = new CertMinter(ca);

  // ── inner HTTP server: parses decrypted MITM traffic, intercept-or-forward ──
  const inner = http.createServer((req, res) => {
    void handleInnerRequest(req, res);
  });
  inner.on('clientError', (_err, socket) => {
    try {
      socket.end(CLIENT_ERROR_RESPONSE);
    } catch {}
  });

  async function handleInnerRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (await deps.intercept(req, res)) return;
      const hostHeader = String(req.headers.host || '');
      let host = hostHeader;
      let port = 443;
      if (hostHeader.startsWith('[')) {
        const i = hostHeader.indexOf(']');
        host = hostHeader.slice(1, i);
        const rest = hostHeader.slice(i + 1);
        if (rest.startsWith(':')) port = parseInt(rest.slice(1), 10) || 443;
      } else if (hostHeader.includes(':')) {
        const [h, p] = hostHeader.split(':');
        host = h;
        port = parseInt(p, 10) || 443;
      }
      if (!host) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forward proxy: missing Host header');
        return;
      }
      await forwardTo(req, res, { host, port, path: req.url || '/', secure: true });
    } catch {
      try {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forward proxy error');
      } catch {}
    }
  }

  // ── per-host TLS terminators (explicit certs; SNICallback unsupported on Bun) ──
  const hostServers = new Map<string, tls.Server>();
  const hostPorts = new Map<string, Promise<number>>();

  function hostTlsPort(host: string): Promise<number> {
    const existing = hostPorts.get(host);
    if (existing) return existing;
    const p = new Promise<number>((resolve, reject) => {
      const { key, cert } = minter.get(host);
      const srv = tls.createServer({ key, cert, ALPNProtocols: ['http/1.1'] }, (tlsSock) => {
        // Attach SYNCHRONOUSLY — a Bun TLSSocket may drop data that arrives
        // with no listener; buffer until the loopback conn is ready.
        const pending: Buffer[] = [];
        let conn: net.Socket | null = null;
        tlsSock.on('data', (d: Buffer) => {
          if (conn) {
            if (!conn.write(d)) {
              tlsSock.pause();
              conn.once('drain', () => tlsSock.resume());
            }
          } else {
            pending.push(d);
          }
        });
        tlsSock.on('end', () => {
          try {
            conn?.end();
          } catch {}
        });
        tlsSock.on('error', () => {
          try {
            conn?.destroy();
          } catch {}
        });
        conn = net.connect(innerPort, '127.0.0.1', () => {
          for (const d of pending) conn!.write(d);
          pending.length = 0;
          conn!.on('data', (d: Buffer) => {
            if (!tlsSock.write(d)) {
              conn!.pause();
              tlsSock.once('drain', () => conn!.resume());
            }
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
        conn.on('error', () => {
          try {
            tlsSock.destroy();
          } catch {}
        });
      });
      srv.on('tlsClientError', (e: any) => log(`tlsClientError ${host}: ${e?.message || e}`));
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        hostServers.set(host, srv);
        resolve((srv.address() as net.AddressInfo).port);
      });
    });
    const guarded = p.catch((err) => {
      // Never cache a FAILED creation — a transient listen error (e.g. an
      // ephemeral-port collision) must not permanently degrade this host to
      // the blind-tunnel fallback; the next connection retries from scratch.
      hostPorts.delete(host);
      throw err;
    });
    hostPorts.set(host, guarded);
    return guarded;
  }

  // ── tunnel (no decryption) ──
  function tunnel(socket: net.Socket, host: string, port: number, replay?: Buffer, viaProxy?: boolean): void {
    // Per-host egress: bypass entries carry their own viaProxy flag (object
    // form); undefined (no-SNI/MITM-failure fallback) = global flag.
    const proxyUrl = transitProxyFor(host, port, viaProxy);
    if (proxyUrl) {
      openViaProxy(proxyUrl, host, port)
        .then((up) => {
          if (replay && replay.length) up.write(replay);
          splice(socket, up);
        })
        .catch((err: any) => {
          log(`tunnel via outbound proxy failed for ${host}:${port}: ${err?.message || err}`);
          try {
            socket.destroy();
          } catch {}
        });
      return;
    }
    const up = net.connect(port, host, () => {
      if (replay && replay.length) up.write(replay);
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
  }

  // ── CONNECT: peek ClientHello → MITM, else blind tunnel ──
  function handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const [rawHost, rawPort] = String(req.url || '').split(':');
    const port = parseInt(rawPort || '443', 10) || 443;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) socket.unshift(head);

    const bb = matchBypass(rawHost, currentBypassHosts(deps.bypassHosts));
    if (bb.bypassed) {
      tunnel(socket, rawHost, port, undefined, bb.viaProxy);
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
      const sni = parseClientHelloSNI(buf);
      if (sni) {
        decided = true;
        socket.pause();
        socket.removeListener('data', onData);
        log(`MITM ${sni}`);
        void startMitm(socket, buf, sni);
        return;
      }
      if (total > MAX_HELLO_BYTES) {
        decided = true;
        socket.pause();
        socket.removeListener('data', onData);
        log(`tunnel ${rawHost}:${port} (no SNI parsed)`);
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

  async function startMitm(socket: net.Socket, hello: Buffer, sni: string): Promise<void> {
    try {
      const port = await hostTlsPort(sni);
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
      log(`MITM setup failed for ${sni}: ${err?.message || err} — blind tunnel fallback`);
      tunnel(socket, sni, 443);
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

  async function handlePlainProxyRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url || '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forward proxy requires an absolute-form request URI');
      return;
    }
    const bb = matchBypass(target.hostname, currentBypassHosts(deps.bypassHosts));
    try {
      if (!bb.bypassed && (await deps.intercept(req, res))) return;
      await forwardTo(req, res, {
        host: target.hostname,
        port: parseInt(target.port || (target.protocol === 'https:' ? '443' : '80'), 10),
        path: target.pathname + target.search,
        secure: target.protocol === 'https:',
        viaProxy: bb.bypassed ? bb.viaProxy : undefined,
      });
    } catch {
      try {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forward proxy error');
      } catch {}
    }
  }

  await listen(inner);
  const innerPort = (inner.address() as net.AddressInfo).port;
  try {
    await listen(proxy, deps.port, deps.host);
  } catch (err) {
    // Fault-tolerance: never leak the inner listener when our public listen
    // fails (port busy etc.) — the caller logs the error and the gateway
    // keeps running without the proxy.
    try {
      inner.close();
    } catch {}
    throw err;
  }
  const port = (proxy.address() as net.AddressInfo).port;
  log(`listening on ${deps.host}:${port} (inner ${innerPort})`);

  return {
    port,
    caCertPem: ca.caCertPem,
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const srv of hostServers.values()) {
          try {
            srv.close();
          } catch {}
        }
        try {
          proxy.close();
        } catch {}
        try {
          inner.close();
        } catch {}
        resolve();
      });
    },
  };
}

function listen(server: net.Server, port = 0, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}