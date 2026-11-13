import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { createForwardProxyServer, forwardTo } from '../src/forward-proxy/server.js';
import { CertMinter } from '../src/forward-proxy/ca.js';
import { ensureTestCa } from './helpers/test-ca.js';
import { closeH2Pool, forwardH2 } from '../src/forward-proxy/h2-forward.js';
import type { AccessTap } from '../src/forward-proxy/access-log.js';

/**
 * Transparent h2 forward (the faithful half of the MITM leg, ADR-0017 §3).
 *
 * These are REAL sockets: a real upstream h2/TLS server, the real relay, a
 * real downstream client. What is asserted is exactly what a protocol-complete
 * proxy must preserve — request headers (`te: trailers`, the gRPC contract),
 * bidirectional bodies, response trailers (`grpc-status`) and the access-log
 * tap — plus the h1 fallback signal and the ALPN matrix of the terminator.
 *
 * The downstream leg here is h2c, mirroring the proxy's own h2 inner loopback.
 * Trailers are asserted on h2 ONLY because Bun's h1 `ServerResponse.addTrailers`
 * is a wire no-op (verified: the h1 client sees `{}`); gRPC clients are h2 by
 * definition, which is precisely why the h2 leg exists.
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-h2pass-'));
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

/** Close a server without hanging on a lingering keep-alive socket. */
function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    try {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {}
    try {
      server.close(done);
    } catch {
      done();
    }
    setTimeout(done, 1000);
  });
}

interface TapProbe extends AccessTap {
  reqBytes: number;
  resBytes: number;
  status: number | undefined;
  notes: string[];
}

function tapProbe(): TapProbe {
  const probe: TapProbe = {
    reqBytes: 0,
    resBytes: 0,
    status: undefined,
    notes: [],
    onReqChunk(chunk) {
      probe.reqBytes += chunk.length;
    },
    onResChunk(chunk) {
      probe.resBytes += chunk.length;
    },
    finish(status, _headers, note) {
      probe.status = status;
      if (note) probe.notes.push(note);
    },
  };
  return probe;
}

/** One downstream h2 (h2c) exchange against a front server running `forwardH2`. */
function driveH2(
  frontPort: number,
  args: { path: string; body: string }
): Promise<{ status: number; body: string; trailers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://127.0.0.1:${frontPort}`);
    session.on('error', reject);
    const stream = session.request({
      ':method': 'POST',
      ':path': args.path,
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    let status = 0;
    let trailers: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    stream.on('response', (h) => {
      status = Number(h[':status']) || 0;
    });
    stream.on('trailers', (t) => {
      trailers = t as Record<string, unknown>;
    });
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('error', reject);
    stream.on('close', () => {
      session.close();
      resolve({ status, body: Buffer.concat(chunks).toString(), trailers });
    });
    stream.end(Buffer.from(args.body));
  });
}

/** One downstream h1 exchange — used only where trailers do not matter. */
function driveH1(
  frontPort: number,
  args: { path: string; body: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: frontPort,
        method: 'POST',
        path: args.path,
        headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(args.body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.end(args.body);
  });
}

describe('forward-proxy: transparent h2 forward', () => {
  it('relays a gRPC-shaped exchange upstream over h2: te: trailers, body, response trailers, tap bytes', async () => {
    const ca = ensureTestCa(tmpCaDir());
    const leaf = new CertMinter(ca).get('127.0.0.1');
    const seen: { te?: string; authority?: string; path?: string; body?: string } = {};

    const upstream = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    upstream.on('request', (req, res) => {
      seen.te = req.headers.te as string | undefined;
      seen.authority = req.headers[':authority'] as string | undefined;
      seen.path = req.url;
      const chunks: Buffer[] = [];
      req.on('data', (d: Buffer) => chunks.push(d));
      req.on('end', () => {
        seen.body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/grpc' });
        res.write(Buffer.from('grpc-response'));
        // gRPC carries its verdict in the TRAILERS, never in the headers.
        res.addTrailers({ 'grpc-status': '0', 'grpc-message': 'ok' });
        res.end();
      });
    });
    const upstreamPort = await listen(upstream as unknown as net.Server);

    const tap = tapProbe();
    const front = http2.createServer((req, res) => {
      void forwardH2(
        req as unknown as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        {
          host: '127.0.0.1',
          port: upstreamPort,
          path: req.url || '/',
          tap,
        },
        { opts: { ca: ca.caCertPem }, key: 'test' }
      );
    });
    const frontPort = await listen(front as unknown as net.Server);

    try {
      const out = await driveH2(frontPort, {
        path: '/aiserver.v1.ChatService/StreamUnifiedChatWithTools',
        body: 'grpc-request',
      });

      assert.equal(out.status, 200);
      assert.equal(out.body, 'grpc-response', 'response body must be relayed byte-exact');
      assert.equal(out.trailers['grpc-status'], '0', 'grpc-status trailer must survive the hop');
      assert.equal(out.trailers['grpc-message'], 'ok');

      assert.equal(seen.te, 'trailers', 'te: trailers is REQUIRED end-to-end by gRPC — never stripped');
      assert.equal(seen.path, '/aiserver.v1.ChatService/StreamUnifiedChatWithTools');
      assert.match(String(seen.authority), /^127\.0\.0\.1:\d+$/, 'authority carries the real upstream host:port');
      assert.equal(seen.body, 'grpc-request');

      assert.equal(tap.reqBytes, Buffer.byteLength('grpc-request'), 'request body reaches the access log');
      assert.equal(tap.resBytes, Buffer.byteLength('grpc-response'), 'response body reaches the access log');
      assert.equal(tap.status, 200, 'the tap lands the upstream status');
      assert.deepEqual(tap.notes, []);
    } finally {
      closeH2Pool();
      await close(front as unknown as net.Server);
      await close(upstream as unknown as net.Server);
    }
  });

  it('captures a large body synchronously across the async upstream TLS handshake (Bun h2 drop guard)', async () => {
    const ca = ensureTestCa(tmpCaDir());
    const leaf = new CertMinter(ca).get('127.0.0.1');
    const body = 'x'.repeat(512 * 1024);
    let received = 0;

    const upstream = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    upstream.on('request', (req, res) => {
      req.on('data', (d: Buffer) => {
        received += d.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(String(received));
      });
    });
    const upstreamPort = await listen(upstream as unknown as net.Server);

    const tap = tapProbe();
    const front = http2.createServer((req, res) => {
      void forwardH2(
        req as unknown as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        { host: '127.0.0.1', port: upstreamPort, path: req.url || '/', tap },
        { opts: { ca: ca.caCertPem }, key: 'test' }
      );
    });
    const frontPort = await listen(front as unknown as net.Server);

    try {
      const out = await driveH2(frontPort, { path: '/large', body });
      assert.equal(Number(out.body), body.length, 'every request byte must survive the async TLS handshake');
      assert.equal(tap.reqBytes, body.length, 'the tap sees the whole body, not the post-handshake remainder');
    } finally {
      closeH2Pool();
      await close(front as unknown as net.Server);
      await close(upstream as unknown as net.Server);
    }
  });

  it('holds the body across the h2→h1 handoff (pause, then preface)', async () => {
    const ca = ensureTestCa(tmpCaDir());
    const leaf = new CertMinter(ca).get('127.0.0.1');
    const body = 'y'.repeat(512 * 1024);
    let received = 0;

    // h1-only TLS upstream: forces the h2 relay to hand the exchange back.
    const upstream = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      req.on('data', (d: Buffer) => {
        received += d.length;
      });
      req.on('end', () => res.end(String(received)));
    });
    const upstreamPort = await listen(upstream);

    const front = http2.createServer((req, res) => {
      const target = { host: '127.0.0.1', port: upstreamPort, path: req.url || '/', secure: true };
      const tls = { opts: { ca: ca.caCertPem }, key: 'test' };
      void forwardH2(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, target, tls).then(async (relay) => {
        if (relay.owned) return;
        // The h2→h1 handoff must be fed a COMPLETE body: the drain keeps the
        // listeners attached until END, so the preface holds every byte and the
        // h1 leg never depends on Bun's compatible-pause buffering.
        const prefaceBytes = relay.preface?.chunks.reduce((n, c) => n + c.length, 0) ?? 0;
        assert.equal(relay.preface?.ended, true);
        assert.equal(prefaceBytes, body.length);
        await forwardTo(
          req as unknown as http.IncomingMessage,
          res as unknown as http.ServerResponse,
          { ...target, preface: relay.preface },
          tls
        );
      });
    });
    const frontPort = await listen(front as unknown as net.Server);

    try {
      const out = await driveH2(frontPort, { path: '/fallback-large', body });
      assert.equal(
        Number(out.body),
        body.length,
        `the h1 fallback must receive the whole body (response ${out.body}, upstream counted ${received})`
      );
      assert.equal(received, body.length, 'no chunk may be lost in the handoff window');
    } finally {
      closeH2Pool();
      await close(front as unknown as net.Server);
      await close(upstream);
    }
  });

  it('returns false (h1 fallback) when the upstream does not speak h2 — nothing reaches the client first', async () => {
    const ca = ensureTestCa(tmpCaDir());
    const leaf = new CertMinter(ca).get('127.0.0.1');

    // h1-only TLS upstream: the ALPN offer of h2 cannot be satisfied.
    const upstream = https.createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => res.end('h1-upstream'));
    const upstreamPort = await listen(upstream);

    const results: { owned: boolean; preface?: { chunks: Buffer[]; ended: boolean } }[] = [];
    const front = http.createServer((req, res) => {
      void forwardH2(
        req,
        res,
        { host: '127.0.0.1', port: upstreamPort, path: req.url || '/' },
        { opts: { ca: ca.caCertPem }, key: 'test' }
      ).then(
        (relay) => {
          results.push(relay);
          if (!relay.owned) {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('h1-fallback');
          }
        }
      );
    });
    const frontPort = await listen(front);

    try {
      const out = await driveH1(frontPort, { path: '/x', body: 'payload' });
      assert.equal(results.length, 1);
      assert.equal(results[0].owned, false, 'a non-h2 upstream must hand the exchange back to the h1 forwarder');
      assert.equal(out.body, 'h1-fallback', 'the fallback owns the response — the h2 leg wrote nothing');
    } finally {
      closeH2Pool();
      await close(front);
      await close(upstream);
    }
  });

  it('shares ONE upstream TLS session across concurrent first requests (single flight)', async () => {
    const ca = ensureTestCa(tmpCaDir());
    const leaf = new CertMinter(ca).get('127.0.0.1');
    let handshakes = 0;

    const upstream = http2.createSecureServer({ key: leaf.key, cert: leaf.cert, allowHTTP1: false });
    upstream.on('secureConnection', () => {
      handshakes += 1;
    });
    upstream.on('stream', (stream) => {
      stream.respond({ ':status': 200 });
      stream.end('ok');
    });
    const upstreamPort = await listen(upstream as unknown as net.Server);

    const front = http2.createServer((req, res) => {
      void forwardH2(
        req as unknown as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        { host: '127.0.0.1', port: upstreamPort, path: req.url || '/', secure: true },
        { opts: { ca: ca.caCertPem }, key: 'test' }
      );
    });
    const frontPort = await listen(front as unknown as net.Server);

    const session = http2.connect(`http://127.0.0.1:${frontPort}`);
    try {
      const answers = await Promise.all(
        Array.from(
          { length: 6 },
          (_value, i) =>
            new Promise<string>((resolve, reject) => {
              const stream = session.request({ ':method': 'GET', ':path': `/s${i}` });
              let body = '';
              stream.on('data', (d: Buffer) => (body += d.toString()));
              stream.on('error', reject);
              stream.on('end', () => resolve(body));
              stream.end();
            })
        )
      );
      assert.deepEqual(answers, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
      assert.equal(handshakes, 1, 'concurrent first requests must share ONE upstream TLS handshake');
    } finally {
      session.close();
      closeH2Pool();
      await close(front as unknown as net.Server);
      await close(upstream as unknown as net.Server);
    }
  });
});

/** Send CONNECT through the proxy; resolve once the 200 is received. */
function connectViaProxy(proxyPort: number, targetHost: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`);
    });
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        resolve(sock);
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

function handshake(sock: net.Socket, caCertPem: string, servername: string, alpn: string[]): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket: sock, servername, ca: caCertPem, ALPNProtocols: alpn, rejectUnauthorized: true }, () =>
      resolve(t)
    );
    t.on('error', reject);
  });
}

describe('forward-proxy: ALPN matrix on the MITM leg', () => {
  it('unclaimed host + h2-only client negotiates h2 (gRPC/Connect clients are no longer broken)', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      interceptPosture: 'all',
      intercept: async () => false,
    });
    try {
      const sock = await connectViaProxy(handle.port, 'h2only.test');
      const tlsSock = await handshake(sock, handle.caCertPem, 'h2only.test', ['h2']);
      assert.equal(tlsSock.alpnProtocol, 'h2', 'an h2-only client must be served h2 even on an unclaimed host');
      tlsSock.destroy();
    } finally {
      await handle.close();
    }
  });

  it('unclaimed host + dual-offer client stays on h1 (server-preference ALPN — zero h1 interception regression)', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      interceptPosture: 'all',
      intercept: async () => false,
    });
    try {
      const sock = await connectViaProxy(handle.port, 'dual.test');
      const tlsSock = await handshake(sock, handle.caCertPem, 'dual.test', ['h2', 'http/1.1']);
      assert.equal(tlsSock.alpnProtocol, 'http/1.1', 'dual-offer clients keep the h1 path the surfaces pipeline knows');
      tlsSock.destroy();
    } finally {
      await handle.close();
    }
  });
});
