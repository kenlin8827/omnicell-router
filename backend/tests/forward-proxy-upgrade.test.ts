import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { ensureCa, CertMinter } from '../src/forward-proxy/ca.js';
import { upstreamServernameOption } from '../src/forward-proxy/egress.js';
import { commitGateways, removeGateway, stageGateway } from '../src/plugins/gateways.js';
import type { ClientGatewayPlugin } from '../src/plugins/types.js';

/**
 * WebSocket / generic `Upgrade:` relay on the MITM leg (`relayUpgrade`,
 * ADR-0008 §3).
 *
 * REAL sockets end-to-end: CONNECT → MITM terminator → decrypted head sniff →
 * TLS to the origin → byte splice. The point of the path is that an upgrade is
 * relayed BYTE-VERBATIM: `Connection: upgrade` and `Upgrade:` are hop-by-hop by
 * RFC, so the ordinary forwarder's `filterHeaders` would strip exactly the two
 * headers that ARE the handshake. These tests pin that, plus the pipelined-bytes
 * case (a client may send frames the instant the handshake completes) and the
 * two terminal paths (origin refuses, origin unreachable).
 *
 * The origin is reachable only through `lookup` (the same `deps.upstreamTls`
 * seam the h2 relay uses for its test CA): the proxy dials the name carried by
 * the Host header, which is the whole point of a forward proxy, so the test
 * maps it to loopback instead of inventing a DNS entry.
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-ws-'));
}

const toLoopback = ((_hostname: string, _opts: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
  cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as tls.ConnectionOptions['lookup'];

/** Send CONNECT through the proxy; resolve once the 200 is received. */
function connectViaProxy(proxyPort: number, targetHost: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${targetHost}:${port} HTTP/1.1\r\nHost: ${targetHost}:${port}\r\n\r\n`);
    });
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        resolve(sock);
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

/** TLS handshake over an established CONNECT socket (validates against ca). */
function tlsOver(socket: net.Socket, servername: string, ca: string, alpn?: string[]): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect(
      { socket, servername, ca, rejectUnauthorized: true, ...(alpn ? { ALPNProtocols: alpn } : {}) },
      () => resolve(t)
    );
    t.on('error', reject);
  });
}

/** Accumulate everything the decrypted client socket receives. */
function collector(sock: tls.TLSSocket): { text: () => string; waitFor: (needle: string, ms?: number) => Promise<void> } {
  let buf = '';
  sock.on('data', (d: Buffer) => {
    buf += d.toString('latin1');
  });
  return {
    text: () => buf,
    waitFor: (needle: string, ms = 5000) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = (): void => {
          if (buf.includes(needle)) return resolve();
          if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${needle}; got: ${buf}`));
          setTimeout(tick, 10);
        };
        tick();
      }),
  };
}

const WS_HANDSHAKE = [
  'GET /socket HTTP/1.1',
  'Host: {host}',
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Protocol: chat',
  '',
  '',
].join('\r\n');

const UPGRADED_RESPONSE =
  'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';

interface Origin {
  port: number;
  head: () => string;
  frames: () => string[];
  close: () => Promise<void>;
}

/**
 * A TLS origin that completes the upgrade and then ECHOES every byte with an
 * `echo:` marker, so a test can tell client→origin from origin→client traffic.
 * `certHost` is the SAN the leaf is minted for — an IP origin must be minted
 * for that IP, because no SNI is sent for it (RFC 6066).
 */
function upgradeOrigin(args: {
  reply?: string;
  ca: ReturnType<typeof ensureCa>;
  certHost?: string;
}): Promise<Origin> {
  const leaf = new CertMinter(args.ca).get(args.certHost ?? 'ws.test');
  let head = '';
  const frames: string[] = [];
  const srv = tls.createServer({ key: leaf.key, cert: leaf.cert }, (s) => {
    let buf = '';
    let done = false;
    const answer = args.reply ?? UPGRADED_RESPONSE;
    s.on('data', (d: Buffer) => {
      if (done) {
        frames.push(d.toString('latin1'));
        s.write('echo:' + d.toString('latin1'));
        return;
      }
      buf += d.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      done = true;
      head = buf.slice(0, idx + 4);
      const pipelined = buf.slice(idx + 4);
      s.write(answer);
      // Bytes the client sent right behind the handshake must survive too.
      if (pipelined) {
        frames.push(pipelined);
        s.write('echo:' + pipelined);
      }
    });
    s.on('error', () => {});
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        head: () => head,
        frames: () => frames,
        close: () =>
          new Promise((done) => {
            try {
              srv.close(() => done());
            } catch {
              done();
            }
            setTimeout(done, 500);
          }),
      });
    });
  });
}

describe('forward-proxy: upstream SNI for an IP-literal origin', () => {
  it('omits servername for IPv4/IPv6 literals and keeps it for names', () => {
    // RFC 6066 forbids an IP in SNI and Node/Bun THROW on it — this helper is
    // the single place that decides, so the throw can never reach a socket
    // callback (it used to kill the connection silently).
    assert.deepEqual(upstreamServernameOption('127.0.0.1'), {});
    assert.deepEqual(upstreamServernameOption('10.0.0.7'), {});
    assert.deepEqual(upstreamServernameOption('::1'), {});
    assert.deepEqual(upstreamServernameOption('[::1]'), {});
    assert.deepEqual(upstreamServernameOption('api2.cursor.sh'), { servername: 'api2.cursor.sh' });
    assert.deepEqual(upstreamServernameOption(''), {});
  });

  it('relays an upgrade to an IP-addressed origin instead of throwing', async () => {
    const caDir = tmpCaDir();
    const ca = ensureCa(caDir);
    // The origin is addressed by IP, so its leaf carries the IP SAN and the
    // proxy must NOT send SNI for it.
    const origin = await upgradeOrigin({ ca, certHost: '127.0.0.1' });
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'ws.test', origin.port);
    const tlsSock = await tlsOver(sock, 'ws.test', ca.caCertPem);
    const seen = collector(tlsSock);

    try {
      // The Host header is what the relay dials — an IP literal is the exact
      // shape that used to throw synchronously inside the socket callback.
      tlsSock.write(WS_HANDSHAKE.replace('{host}', `127.0.0.1:${origin.port}`) + 'ip-frame');
      await seen.waitFor('101 Switching Protocols');
      await seen.waitFor('echo:ip-frame');
      assert.match(origin.head(), /^GET \/socket HTTP\/1\.1\r\n/);
    } finally {
      tlsSock.destroy();
      sock.destroy();
      await handle.close();
      await origin.close();
    }
  });
});

describe('forward-proxy: client-gateway upgrade hook', () => {
  it('a gateway claiming the host owns the handshake — the relay never dials upstream', async () => {
    const caDir = tmpCaDir();
    const ca = ensureCa(caDir);
    const seen: { host?: string; path?: string; headBytes?: number } = {};
    const gateway: ClientGatewayPlugin = {
      hosts: ['gw.test'],
      match: () => true,
      handle: async (_req, res) => {
        res.writeHead(501);
        res.end();
      },
      handleUpgrade: (ctx) => {
        seen.host = ctx.host;
        seen.path = ctx.path;
        seen.headBytes = ctx.head.length;
        ctx.socket.write(UPGRADED_RESPONSE);
        ctx.socket.on('data', (d: Buffer) => ctx.socket.write('gw:' + d.toString('latin1')));
        return true;
      },
    };
    stageGateway('test-gw', gateway);
    commitGateways();

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'gw.test', 443);
    // A CLAIMED host offers h2 first (ADR-0017 §3), so force h1 to exercise the
    // upgrade path rather than the h2 inner.
    const tlsSock = await tlsOver(sock, 'gw.test', ca.caCertPem, ['http/1.1']);
    const replies = collector(tlsSock);

    try {
      tlsSock.write(WS_HANDSHAKE.replace('{host}', 'gw.test'));
      await replies.waitFor('101 Switching Protocols');
      // Frames sent AFTER the handshake reach the gateway through its own
      // socket listener (pipelined bytes would already be inside `head`).
      tlsSock.write('plugin-frame');
      await replies.waitFor('gw:plugin-frame');

      assert.equal(seen.host, 'gw.test');
      assert.equal(seen.path, '/socket');
      assert.ok((seen.headBytes ?? 0) > 0, 'the gateway receives the raw head bytes');
      assert.ok(
        !replies.text().includes('502'),
        `the transparent relay must not run for an owned handshake: ${replies.text()}`
      );
    } finally {
      tlsSock.destroy();
      sock.destroy();
      await handle.close();
      removeGateway('test-gw');
      commitGateways();
    }
  });
});

describe('forward-proxy: WebSocket / Upgrade relay on the MITM leg', () => {
  it('relays the handshake byte-verbatim, keeps pipelined bytes, and stays bidirectional', async () => {
    const caDir = tmpCaDir();
    const ca = ensureCa(caDir);
    const origin = await upgradeOrigin({ ca });
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'ws.test', origin.port);
    const tlsSock = await tlsOver(sock, 'ws.test', ca.caCertPem);
    const seen = collector(tlsSock);

    try {
      tlsSock.write(WS_HANDSHAKE.replace('{host}', `ws.test:${origin.port}`) + 'early-frame');
      await seen.waitFor('101 Switching Protocols');
      await seen.waitFor('echo:early-frame');

      // The handshake itself, as the ORIGIN saw it: nothing re-serialized, and
      // crucially `upgrade` / `connection` / `sec-websocket-*` all present.
      const head = origin.head();
      assert.match(head, /^GET \/socket HTTP\/1\.1\r\n/, `origin head: ${head}`);
      assert.match(head, /\r\nupgrade: websocket\r\n/i, 'Upgrade header must reach the origin');
      assert.match(head, /\r\nconnection: Upgrade\r\n/i, 'Connection: upgrade must reach the origin');
      assert.match(head, /\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n/i);
      assert.match(head, /\r\nsec-websocket-protocol: chat\r\n/i, 'subprotocol negotiation must survive');

      // Liveness AFTER the handshake: the splice is bidirectional, not one-shot.
      tlsSock.write('later-frame');
      await seen.waitFor('echo:later-frame');
      assert.deepEqual(origin.frames().slice(-1), ['later-frame']);
    } finally {
      tlsSock.destroy();
      sock.destroy();
      await handle.close();
      await origin.close();
    }
  });

  it('passes a refused upgrade (non-101) through to the client unchanged', async () => {
    const caDir = tmpCaDir();
    const ca = ensureCa(caDir);
    const origin = await upgradeOrigin({
      ca,
      reply: 'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nnope',
    });
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'ws.test', origin.port);
    const tlsSock = await tlsOver(sock, 'ws.test', ca.caCertPem);
    const seen = collector(tlsSock);

    try {
      tlsSock.write(WS_HANDSHAKE.replace('{host}', `ws.test:${origin.port}`));
      await seen.waitFor('400 Bad Request');
      await seen.waitFor('nope');
      assert.ok(!seen.text().includes('502'), `proxy must not substitute its own error: ${seen.text()}`);
    } finally {
      tlsSock.destroy();
      sock.destroy();
      await handle.close();
      await origin.close();
    }
  });

  it('answers 502 when the upgrade origin is unreachable', async () => {
    // Reserve a port, then close it — nothing is listening there.
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));

    const caDir = tmpCaDir();
    const ca = ensureCa(caDir);
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'ws.test', deadPort);
    const tlsSock = await tlsOver(sock, 'ws.test', ca.caCertPem);
    const seen = collector(tlsSock);

    try {
      tlsSock.write(WS_HANDSHAKE.replace('{host}', `ws.test:${deadPort}`));
      await seen.waitFor('502 Bad Gateway');
      // The answer now carries the CLASSIFIED failure (ADR-0019): the origin
      // leg's error code rides along instead of a generic "connection failed".
      assert.match(seen.text(), /upstream connection failed/);
      assert.match(seen.text(), /ECONNREFUSED|upstream connection failed \(/);
    } finally {
      tlsSock.destroy();
      sock.destroy();
      await handle.close();
    }
  });

  it('a plain request head without Upgrade still reaches the interceptor (no sniff regression)', async () => {
    const caDir = tmpCaDir();
    const ca = ensureCa(caDir);
    let intercepted = 0;
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async (_req, res) => {
        intercepted += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return true;
      },
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'plain.test', 443);
    const tlsSock = await tlsOver(sock, 'plain.test', ca.caCertPem);
    const seen = collector(tlsSock);

    try {
      tlsSock.write('POST /v1/chat/completions HTTP/1.1\r\nHost: plain.test\r\nContent-Length: 2\r\n\r\n{}');
      await seen.waitFor('{"ok":true}');
      assert.equal(intercepted, 1, 'the head sniff must not swallow ordinary requests');
    } finally {
      tlsSock.destroy();
      sock.destroy();
      await handle.close();
    }
  });
});
