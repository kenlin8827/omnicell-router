import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { ensureCa, CertMinter } from '../src/forward-proxy/ca.js';
import { peekClientHello } from '../src/forward-proxy/sni.js';

/**
 * MITM admission: WHO the certificate is minted for, and WHICH PORT the
 * intercepted request is forwarded to.
 *
 * Two silent-wrong-answer classes are pinned here:
 *  1. the CONNECT authority's port used to be dropped on the MITM leg — the
 *     inner request re-derived the target from its `Host` header with a
 *     hardcoded 443 default, so `CONNECT host:8443` + `Host: host` (what every
 *     HTTPS client sends) was forwarded to 443;
 *  2. a ClientHello WITHOUT SNI used to fall back to a blind tunnel, which let
 *     any client opt out of interception by omitting the extension. The
 *     CONNECT authority is the identity to use instead — the only one the
 *     client offered, and the only one an IP-literal target can offer.
 *
 * REAL sockets end-to-end: the origin is reachable only through `lookup` (the
 * `deps.upstreamTls` seam), because a forward proxy dials the name from the
 * request head and the test must not invent DNS entries.
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-authority-'));
}

const toLoopback = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
  cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as tls.ConnectionOptions['lookup'];

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

/** TLS handshake over an established CONNECT socket. `servername` omitted ⇒ no SNI. */
function tlsOver(
  socket: net.Socket,
  opts: { servername?: string; ca?: string; rejectUnauthorized?: boolean }
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, ...opts }, () => resolve(t));
    t.on('error', reject);
  });
}

function httpRequest(sock: tls.TLSSocket, hostHeader: string, p = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    sock.write(`GET ${p} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    let buf = '';
    sock.on('data', (d: Buffer) => (buf += d.toString()));
    sock.on('end', () => resolve(buf));
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
  });
}

/** A TLS origin that answers every request with `body`, on its own random port. */
function tlsOrigin(ca: ReturnType<typeof ensureCa>, certHost: string, body: string) {
  const leaf = new CertMinter(ca).get(certHost);
  const hits: string[] = [];
  const srv = tls.createServer({ key: leaf.key, cert: leaf.cert }, (s) => {
    let buf = '';
    s.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      hits.push(buf.split('\r\n')[0]);
      s.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
    s.on('error', () => {});
  });
  return new Promise<{ port: number; hits: () => string[]; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        hits: () => hits,
        close: () =>
          new Promise((done) => {
            try {
              srv.close(() => done());
            } catch {
              done();
            }
            setTimeout(done, 500);
          }),
      })
    );
  });
}

describe('forward-proxy: ClientHello peek', () => {
  it('classifies non-TLS bytes immediately (never buffers them)', () => {
    assert.deepEqual(peekClientHello(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n')), { isTls: false, complete: false });
    assert.deepEqual(peekClientHello(Buffer.from('GET / HTTP/1.1\r\n')), { isTls: false, complete: false });
    // A TLS record header that is not a handshake (application data) is not ours.
    assert.deepEqual(peekClientHello(Buffer.from([0x17, 0x03, 0x03, 0x00, 0x05, 1, 2, 3, 4, 5])), {
      isTls: false,
      complete: false,
    });
  });

  it('reports an incomplete handshake record as TLS-but-not-complete', () => {
    // type=handshake, version=3.1, declared length 100, no body yet
    const partial = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x64, 0x01, 0x00]);
    assert.deepEqual(peekClientHello(partial), { isTls: true, complete: false });
  });

  it('parses a real SNI-bearing hello and a real SNI-less hello', async () => {
    const captured: Buffer[] = [];
    const srv = net.createServer((sock) => {
      sock.once('data', (d: Buffer) => {
        captured.push(d);
        sock.destroy();
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;

    // With SNI
    await new Promise<void>((resolve) => {
      const c = tls.connect({ host: '127.0.0.1', port, servername: 'sni.example.com', rejectUnauthorized: false });
      c.on('error', () => {});
      setTimeout(resolve, 150);
    });
    // Without SNI (IP-literal style: no servername option at all)
    await new Promise<void>((resolve) => {
      const c = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
      c.on('error', () => {});
      setTimeout(resolve, 150);
    });
    srv.close();

    assert.equal(captured.length, 2, 'both hellos captured');
    const withSni = peekClientHello(captured[0]);
    assert.equal(withSni.isTls, true);
    assert.equal(withSni.complete, true);
    assert.equal(withSni.sni, 'sni.example.com');

    const noSni = peekClientHello(captured[1]);
    assert.equal(noSni.isTls, true);
    assert.equal(noSni.complete, true, 'a ClientHello without SNI is still complete');
    assert.equal(noSni.sni, undefined);
  });
});

describe('forward-proxy: MITM target port', () => {
  it('forwards to the CONNECT port when the request head omits one', async () => {
    const caDir = tmpCaDir();
    const ca = ensureCa(caDir);
    // A non-443 origin: the client CONNECTs to this port and then sends
    // `Host: port.test` (no port) — the classic HTTPS client shape.
    const origin = await tlsOrigin(ca, 'port.test', 'from-origin-port');

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'port.test', origin.port);
    const tlsSock = await tlsOver(sock, { servername: 'port.test', ca: ca.caCertPem });
    const resp = await httpRequest(tlsSock, 'port.test');
    assert.ok(resp.includes('from-origin-port'), `expected the origin body, got: ${resp}`);
    assert.equal(origin.hits().length, 1, 'the origin on the CONNECT port must be the one dialed');

    tlsSock.destroy();
    await origin.close();
    await handle.close();
  });

  it('lets an explicit Host port win over the CONNECT port', async () => {
    const caDir = tmpCaDir();
    const ca = ensureCa(caDir);
    const connectOrigin = await tlsOrigin(ca, 'two.test', 'from-connect-port');
    const hostOrigin = await tlsOrigin(ca, 'two.test', 'from-host-port');

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'two.test', connectOrigin.port);
    const tlsSock = await tlsOver(sock, { servername: 'two.test', ca: ca.caCertPem });
    const resp = await httpRequest(tlsSock, `two.test:${hostOrigin.port}`);
    assert.ok(resp.includes('from-host-port'), `expected the Host-port origin, got: ${resp}`);
    assert.equal(connectOrigin.hits().length, 0, 'the CONNECT-port origin must not be dialed');

    tlsSock.destroy();
    await connectOrigin.close();
    await hostOrigin.close();
    await handle.close();
  });
});

describe('forward-proxy: no-SNI interception', () => {
  it('intercepts a ClientHello without SNI using the CONNECT authority', async () => {
    const caDir = tmpCaDir();
    let intercepted = 0;
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async (_req, res) => {
        intercepted += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"intercepted":true}');
        return true;
      },
    });

    const sock = await connectViaProxy(handle.port, 'authority.test', 443);
    // No `servername` ⇒ the ClientHello carries no SNI extension. The
    // certificate is minted for the CONNECT authority, so no hostname
    // verification is possible (nor meaningful) here.
    const tlsSock = await tlsOver(sock, { rejectUnauthorized: false });
    const resp = await httpRequest(tlsSock, 'authority.test');
    assert.ok(resp.includes('{"intercepted":true}'), `expected interception, got: ${resp}`);
    assert.equal(intercepted, 1);

    tlsSock.destroy();
    await handle.close();
  });
});
