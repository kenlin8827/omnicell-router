import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { CertMinter, ensureCa } from './ca.js';
import { parseClientHelloSNI } from './sni.js';
import { splice } from './relay.js';
import { matchBypass, type BypassEntry } from './bypass.js';
import { resolveProxyUrl } from '../utils/proxy.js';
import { FORWARD_PROXY_HANG_TIMEOUT_MS } from '../config/defaults.js';

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

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ForwardProxyDeps {
  port: number;
  host: string;
  caDir: string;
  /**
   * Bypass list: bare strings = pure tunnel (direct); `{ host, viaProxy }`
   * entries choose the egress per host (viaProxy → through the outbound
   * proxy policy).
   */
  bypassHosts?: (string | BypassEntry)[];
  /**
   * Route transit (bypass tunnels + non-intercepted forwards) through the
   * outbound proxy policy (`config.proxy` — url/includes/excludes). Default
   * false = direct egress. Recommended on for network-blocked targets.
   */
  viaOutboundProxy?: boolean;
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

function filterHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// ── outbound-proxy transit (config.proxy policy) ──────────────────────────
// When enabled, bypass tunnels and non-intercepted forwards egress through
// the configured outbound proxy (e.g. clash/v2ray) via CONNECT, so
// network-blocked targets become reachable without touching interception.
// Module-level because only one forward proxy instance exists per process;
// createForwardProxyServer sets it (last created wins).
let transitViaOutboundProxy = false;

function transitProxyFor(host: string, port: number, force?: boolean): string | undefined {
  // force: per-host egress choice (bypass entries carry it); undefined = the
  // global `viaOutboundProxy` flag (non-intercepted forwards).
  const enabled = force === undefined ? transitViaOutboundProxy : force;
  if (!enabled) return undefined;
  return resolveProxyUrl(`https://${host}:${port}/`, { model: host });
}

function parseProxy(proxyUrl: string): { host: string; port: number; auth?: string } | null {
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
function openViaProxy(proxyUrl: string, host: string, port: number): Promise<net.Socket> {
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

/** Stream one http request to its real target and pipe the response back. */
function forwardTo(req: http.IncomingMessage, res: http.ServerResponse, t: ForwardTarget): Promise<void> {
  const proxyUrl = transitProxyFor(t.host, t.port, t.viaProxy);
  if (proxyUrl) {
    return t.secure ? forwardSecureViaProxy(req, res, t, proxyUrl) : forwardPlainViaProxy(req, res, t, proxyUrl);
  }
  return forwardDirect(req, res, t);
}

/** Direct upstream request (no outbound proxy involved). */
function forwardDirect(req: http.IncomingMessage, res: http.ServerResponse, t: ForwardTarget): Promise<void> {
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
        // timer so long-lived streams (SSE passthrough) are never killed.
        upstream.setTimeout(0);
        res.writeHead(up.statusCode || 502, filterHeaders(up.headers as http.IncomingHttpHeaders));
        up.pipe(res);
        up.on('end', resolve);
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
    req.pipe(upstream);
    req.on('error', () => {
      try {
        upstream.destroy();
      } catch {}
    });
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
          req.pipe(upstream);
          req.on('error', () => {
            try {
              upstream.destroy();
            } catch {}
          });
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
        up.on('end', resolve);
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
    req.pipe(upstream);
    req.on('error', () => {
      try {
        upstream.destroy();
      } catch {}
    });
  });
}

export async function createForwardProxyServer(deps: ForwardProxyDeps): Promise<ForwardProxyHandle> {
  const log = deps.log ?? (() => {});
  transitViaOutboundProxy = deps.viaOutboundProxy === true;
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

    const bb = matchBypass(rawHost, deps.bypassHosts);
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
    const bb = matchBypass(target.hostname, deps.bypassHosts);
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