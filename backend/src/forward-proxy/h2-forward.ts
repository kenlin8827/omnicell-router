import http2 from 'node:http2';
import tls from 'node:tls';
import type http from 'node:http';
import { DEFAULT_MAX_BODY_BYTES, FORWARD_PROXY_HANG_TIMEOUT_MS, FORWARD_PROXY_KEEPALIVE_MS } from '../config/defaults.js';
import {
  describeUpstreamFailure,
  openViaProxy,
  transitEgressFor,
  transitProxyFor,
  upstreamServernameOption,
} from './egress.js';
import type { UpstreamTlsOptions } from './upstream-tls.js';
import type { AccessTap } from './access-log.js';

/**
 * Transparent forward over HTTP/2 — the faithful half of the MITM leg.
 *
 * The forward proxy terminates TLS and parses the decrypted stream with an
 * http.Server (h1) or an http2 compat server (h2). Whatever the client spoke
 * must be re-originated UPSTREAM, or the proxy silently becomes a protocol
 * downgrader: an h1-only upstream leg cannot carry what an h2 client sent
 * (gRPC/Connect framing, response trailers such as `grpc-status`, bidi
 * streams, multiplexing). That is why this module exists — the h1 forwarders
 * in server.ts remain the h1 leg's path, and the h2 leg relays here.
 *
 * Not vendor knowledge: this is plain HTTP/2 transport, so it belongs to the
 * core proxy rather than to a client-gateway plugin (ADR-0017 §3). Plugins
 * still own vendor SEMANTICS on the hosts they claim.
 *
 * Return contract: `forwardH2` resolves `{owned:false}` when the upstream will
 * not speak h2 (h1-only server, TLS/ALPN failure) — the caller then runs the h1
 * forwarder, handing it the `preface` bytes already captured. It only reports
 * false BEFORE any byte reaches the client, so the fallback can never
 * double-answer.
 */

export interface H2ForwardTarget {
  host: string;
  port: number;
  /** Request target as received (`:path` — path + query, never lowercased). */
  path: string;
  /** Access-log tap (non-intercepted forwards only); undefined = no capture. */
  tap?: AccessTap;
  /** Body bytes already consumed by the caller's route decision. */
  preface?: { chunks: Buffer[]; ended?: boolean };
}

/** Outcome of one h2 relay attempt. */
export interface H2RelayResult {
  /** true = this leg owns the exchange; false = the caller must run the h1 forwarder. */
  owned: boolean;
  /**
   * Body bytes already consumed from the inbound stream before the fallback
   * decision (Bun's h2 compat layer cannot be left unread across an await).
   * The h1 forwarder MUST write these upstream first — dropping them would
   * silently truncate the body head.
   */
  preface?: { chunks: Buffer[]; ended: boolean };
}

/**
 * Extra TLS options for the upstream h2 client. Production leaves this unset
 * (system trust store); tests inject the local CA so the relay can be
 * exercised against a real TLS server without touching the OS trust store.
 */
export type H2UpstreamTls = tls.ConnectionOptions;

/**
 * Hop-by-hop headers that must never cross a proxy hop. `te` and `trailer` are
 * DELIBERATELY absent: gRPC requires `te: trailers` to reach the upstream, and
 * h2 carries trailers natively (`transfer-encoding` is the h1-only mechanism
 * that does get stripped).
 */
const H2_STRIP: Record<string, true> = {
  connection: true,
  'proxy-connection': true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  'transfer-encoding': true,
  upgrade: true,
};

/** Idle session lifetime — a reused h2 session avoids a TLS handshake per RPC. */
const SESSION_IDLE_CLOSE_MS = 30_000;

interface PoolEntry {
  session: http2.ClientHttp2Session;
  streams: number;
  idle?: ReturnType<typeof setTimeout>;
}

/** Live sessions keyed `host:port`; dropped on close/goaway/error. */
const pool = new Map<string, PoolEntry>();

function dropSession(key: string, session: http2.ClientHttp2Session): void {
  const entry = pool.get(key);
  if (entry && entry.session === session) pool.delete(key);
  if (entry?.idle) clearTimeout(entry.idle);
}

/** Close every pooled session (forward-proxy shutdown). */
export function closeH2Pool(): void {
  for (const [key, entry] of pool) {
    if (entry.idle) clearTimeout(entry.idle);
    try {
      entry.session.close();
    } catch {}
    pool.delete(key);
  }
}

function authorityOf(t: H2ForwardTarget): string {
  const host = t.host.includes(':') && !t.host.startsWith('[') ? `[${t.host}]` : t.host;
  return t.port === 443 ? host : `${host}:${t.port}`;
}

/** Request headers for the upstream stream: pseudo-headers rebuilt from the
 *  target, hop-by-hop stripped, everything else (including `te: trailers`)
 *  carried verbatim. */
function outboundHeaders(req: http.IncomingMessage, t: H2ForwardTarget): http2.OutgoingHttpHeaders {
  const out: http2.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k.startsWith(':')) continue; // inbound pseudo-headers — ours are authoritative
    if (H2_STRIP[k]) continue;
    out[k] = v as string | string[];
  }
  out[':method'] = req.method ?? 'GET';
  out[':path'] = t.path;
  out[':authority'] = authorityOf(t);
  out[':scheme'] = 'https';
  return out;
}

/** Response headers for the client: pseudo-headers dropped (`:status` is
 *  written via writeHead), hop-by-hop stripped. */
function responseHeaders(headers: http2.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':') || v === undefined) continue;
    if (H2_STRIP[k]) continue;
    out[k] = v as string | string[];
  }
  return out;
}

/**
 * Pool identity for one target: host + port + EGRESS + TLS TRUST.
 *
 * All four matter, and leaving any of them out reuses a session established
 * under a different policy — the previous key was `host:port`, so flipping a
 * host from direct to proxied (a rule save) or rotating the upstream CA kept
 * riding the old connection, silently answering with the wrong egress or the
 * old trust decision.
 */
function sessionKey(t: H2ForwardTarget, upstreamTls: UpstreamTlsOptions, proxyUrl: string | undefined): string {
  return `${t.host}:${t.port}|${proxyUrl ?? 'direct'}|${upstreamTls.key}`;
}

/**
 * Acquire a reusable h2 session for the target, or null when the upstream does
 * not speak h2. Egress follows the same proxy policy as the h1 leg
 * (`transitProxyFor` + a CONNECT tunnel carrying TLS).
 */
function acquireSession(
  t: H2ForwardTarget,
  upstreamTls: UpstreamTlsOptions,
  key: string
): Promise<http2.ClientHttp2Session | null> {
  const hit = pool.get(key);
  if (hit && !hit.session.closed && !hit.session.destroyed) {
    if (hit.idle) {
      clearTimeout(hit.idle);
      hit.idle = undefined;
    }
    return Promise.resolve(hit.session);
  }
  if (hit) pool.delete(key);

  return new Promise<http2.ClientHttp2Session | null>((resolve) => {
    const authority = `https://${authorityOf(t)}`;
    const connectOpts: http2.SecureClientSessionOptions = { ...(upstreamTls.opts || {}), ALPNProtocols: ['h2'] };
    let settled = false;
    const settle = (session: http2.ClientHttp2Session | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(session);
    };
    const timer = setTimeout(() => settle(null), FORWARD_PROXY_HANG_TIMEOUT_MS);

    const adopt = (session: http2.ClientHttp2Session): void => {
      const entry: PoolEntry = { session, streams: 0 };
      pool.set(key, entry);
      // Same probe as the h1 legs (see relay.ts): a pooled h2 session that lost
      // its peer without FIN/RST would otherwise sit in the pool forever.
      try {
        session.socket.setKeepAlive(true, FORWARD_PROXY_KEEPALIVE_MS);
      } catch {}
      session.on('goaway', () => dropSession(key, session));
      session.on('close', () => dropSession(key, session));
      session.on('error', () => dropSession(key, session));
      settle(session);
    };

    const egress = transitEgressFor(t.host);
    const proxyUrl = transitProxyFor(egress.proxy);
    if (!proxyUrl) {
      const session = http2.connect(authority, connectOpts);
      session.once('connect', () => adopt(session));
      session.once('error', () => {
        try {
          session.destroy();
        } catch {}
        settle(null);
      });
      return;
    }

    // Outbound-proxy egress: CONNECT tunnel, then TLS inside it — the session
    // rides the tunnel through `createConnection`, exactly like the h1 leg's
    // relay does (server.ts forwardSecureViaProxy).
    openViaProxy(proxyUrl, t.host, t.port)
      .then((sock) => {
        const tlsSock = tls.connect(
          { socket: sock, ...upstreamServernameOption(t.host), ...(upstreamTls.opts || {}), ALPNProtocols: ['h2'] }
        );
        tlsSock.once('error', () => {
          try {
            tlsSock.destroy();
          } catch {}
          settle(null);
        });
        tlsSock.once('secureConnect', () => {
          if (tlsSock.alpnProtocol !== 'h2') {
            try {
              tlsSock.destroy();
            } catch {}
            settle(null);
            return;
          }
          const session = http2.connect(authority, { ...connectOpts, createConnection: () => tlsSock });
          session.once('connect', () => adopt(session));
          session.once('error', () => {
            try {
              session.destroy();
            } catch {}
            settle(null);
          });
        });
      })
      .catch(() => settle(null));
  });
}

/** Decrement the session's live-stream count; arm the idle close at zero. */
function releaseStream(key: string, session: http2.ClientHttp2Session): void {
  const entry = pool.get(key);
  if (!entry || entry.session !== session) return;
  entry.streams = Math.max(0, entry.streams - 1);
  if (entry.streams > 0) return;
  if (entry.idle) clearTimeout(entry.idle);
  const idle = setTimeout(() => {
    dropSession(key, session);
    try {
      session.close();
    } catch {}
  }, SESSION_IDLE_CLOSE_MS);
  // Never hold the process open for an idle keep-alive session.
  (idle as unknown as { unref?: () => void }).unref?.();
  entry.idle = idle;
}

function failPlain(res: http.ServerResponse, code: number, msg: string): void {
  try {
    if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(msg);
  } catch {}
}

/**
 * Relay one decrypted h2 request upstream over h2 and stream the answer back —
 * headers, body (both directions, backpressure-preserving), trailers.
 */
export async function forwardH2(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t: H2ForwardTarget,
  upstreamTls: UpstreamTlsOptions
): Promise<H2RelayResult> {
  // Bun's h2 compatibility IncomingMessage DROPS chunks emitted while nobody is
  // listening (verified — the h1 leg does not). The session handshake below is
  // async, so the body is captured SYNCHRONOUSLY here, before any await, and
  // replayed into the upstream stream once it exists.
  //
  // The h2→h1 fallback must ALSO drain the body to END before handing off:
  // the h1 forwarder attaches only after its own TLS handshake, and `pause()`
  // is not a safe hold — Bun's compat layer drops the buffered tail when the
  // stream resumes through `pipe()` (a 512 KB body lost ~230 KB). Draining
  // keeps the listeners attached and hands the h1 leg a complete preface.
  const held: Buffer[] = t.preface ? [...t.preface.chunks] : [];
  let heldBytes = held.reduce((total, chunk) => total + chunk.length, 0);
  let overflow = false;
  let upstreamStream: http2.ClientHttp2Stream | undefined;
  let heldEnd = t.preface?.ended === true;
  let resolveEnd: () => void = () => {};
  const bodyEnded = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  if (heldEnd) resolveEnd();
  const onBody = (chunk: Buffer): void => {
    if (!upstreamStream) {
      heldBytes += chunk.length;
      if (heldBytes > DEFAULT_MAX_BODY_BYTES) {
        overflow = true;
        req.destroy();
        return;
      }
      held.push(chunk);
      return;
    }
    t.tap?.onReqChunk(chunk);
    if (!upstreamStream.write(chunk)) {
      req.pause();
      upstreamStream.once('drain', () => req.resume());
    }
  };
  const onBodyEnd = (): void => {
    heldEnd = true;
    resolveEnd();
    if (upstreamStream) {
      try {
        upstreamStream.end();
      } catch {}
    }
  };
  req.on('data', onBody);
  req.on('end', onBodyEnd);
  req.on('close', resolveEnd);
  req.on('error', () => {
    try {
      upstreamStream?.close(http2.constants.NGHTTP2_CANCEL);
    } catch {}
  });

  const egress = transitEgressFor(t.host);
  const proxyUrl = transitProxyFor(egress.proxy);
  const key = sessionKey(t, upstreamTls, proxyUrl);
  const session = await acquireSession(t, upstreamTls, key);
  if (!session) {
    // h1 upstreams cannot carry bidi: drain the bounded body, then hand a
    // complete preface to the h1 leg. The timeout is the proxy's hang guard;
    // the 16 MB cap prevents buffering an unbounded upload.
    if (!heldEnd && !overflow) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        bodyEnded,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FORWARD_PROXY_HANG_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    req.removeListener('data', onBody);
    req.removeListener('end', onBodyEnd);
    req.removeListener('close', resolveEnd);
    if (overflow) {
      failPlain(res, 413, `Forward proxy: request body exceeds ${DEFAULT_MAX_BODY_BYTES} bytes on an h1 upstream`);
      return { owned: true };
    }
    if (!heldEnd) {
      failPlain(res, 504, 'Forward proxy: request body did not complete for the h1 upstream');
      return { owned: true };
    }
    return { owned: false, ...(held.length ? { preface: { chunks: held, ended: true } } : {}) };
  }
  if (overflow) {
    failPlain(res, 413, `Forward proxy: request body exceeds ${DEFAULT_MAX_BODY_BYTES} bytes`);
    return { owned: true };
  }

  const entry = pool.get(key);
  if (entry && entry.session === session) {
    entry.streams += 1;
    if (entry.idle) {
      clearTimeout(entry.idle);
      entry.idle = undefined;
    }
  }

  return new Promise<H2RelayResult>((resolve) => {
    let settled = false;
    const finish = (status?: number, headers?: http2.IncomingHttpHeaders, note?: string): void => {
      t.tap?.finish(status, headers as unknown as http.IncomingHttpHeaders | undefined, note);
    };
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hang);
      releaseStream(key, session);
      resolve({ owned: true });
    };

    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request(outboundHeaders(req, t));
    } catch {
      // The session died between acquire and request. The inbound body is
      // already ours, so an honest 502 is the only safe answer (handing back
      // to the h1 leg would replay a partially consumed stream).
      req.removeListener('data', onBody);
      req.removeListener('end', onBodyEnd);
      finish(undefined, undefined, 'upstream h2 session lost');
      failPlain(res, 502, 'Forward proxy: upstream h2 session was lost before the request started');
      releaseStream(key, session);
      resolve({ owned: true });
      return;
    }

    // Hang protection: a blackholed upstream must not stall the client forever.
    // Cleared as soon as response headers arrive, so long-lived streams (gRPC
    // bidi, SSE-over-h2) are never killed.
    const hang = setTimeout(() => {
      try {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      } catch {}
      finish(undefined, undefined, 'upstream timeout');
      failPlain(res, 504, 'Forward proxy: upstream timed out (target unreachable from this machine?)');
      done();
    }, FORWARD_PROXY_HANG_TIMEOUT_MS);

    // Hand the captured head of the body to the live stream, then let the
    // synchronous handler above carry the rest.
    upstreamStream = stream;
    for (const chunk of held) {
      t.tap?.onReqChunk(chunk);
      if (!stream.write(chunk)) {
        req.pause();
        stream.once('drain', () => req.resume());
      }
    }
    held.length = 0;
    if (heldEnd) {
      try {
        stream.end();
      } catch {}
    }

    stream.on('response', (headers) => {
      clearTimeout(hang);
      const status = Number(headers[':status']) || 502;
      try {
        res.writeHead(status, responseHeaders(headers));
      } catch {}
      if (t.tap) stream.on('data', (d: Buffer) => t.tap!.onResChunk(d));
      stream.pipe(res);
      stream.on('end', () => finish(status, headers));
    });

    // Trailers are the whole point for gRPC (`grpc-status` rides here, not in
    // the headers). They arrive before 'end', so addTrailers still lands
    // ahead of the implicit end() from the pipe. Bun's h1 ServerResponse
    // addTrailers is a wire no-op — trailers exist only on the h2 leg, which
    // is exactly where gRPC lives.
    stream.on('trailers', (trailers) => {
      try {
        (res as http.ServerResponse & { addTrailers?: (t: http.OutgoingHttpHeaders) => void }).addTrailers?.(trailers);
      } catch {}
    });

    stream.on('error', (err: any) => {
      clearTimeout(hang);
      if (!res.headersSent) {
        const failure = describeUpstreamFailure(err);
        finish(undefined, undefined, failure.note);
        failPlain(res, failure.status, failure.message);
      } else {
        finish(res.statusCode, undefined, 'upstream h2 stream error mid-response');
        try {
          res.destroy();
        } catch {}
      }
      done();
    });

    stream.on('close', () => done());

    // Client gone (tab closed, RPC cancelled): cancel the upstream stream
    // instead of letting it run to completion.
    res.on('close', () => {
      if (!stream.closed) {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {}
      }
    });
  });
}
