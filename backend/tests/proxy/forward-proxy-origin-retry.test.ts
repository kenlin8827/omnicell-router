import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import http from 'node:http';
import { createForwardProxyServer } from '../../src/forward-proxy/server.js';
import { shouldRetryOriginLeg } from '../../src/forward-proxy/egress.js';
import { CertMinter, type CaMaterial } from '../../src/forward-proxy/ca.js';
import { ensureTestCa } from '../helpers/test-ca.js';
import { initProxyConfig } from '../../src/utils/proxy.js';
import { setUpstreamTlsReader } from '../../src/forward-proxy/upstream-tls.js';

/**
 * Origin-leg retry. An outbound proxy (mihomo/Clash) closes freshly opened
 * tunnels; the relay must retry ONCE on a fresh tunnel, but only when nothing
 * was delivered to the origin — replaying a partially written request would
 * double-execute it.
 *
 * The first half pins the predicate; the second half drives a real failed
 * tunnel through a fake outbound proxy that drops its first CONNECT.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const toLoopback = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
  cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as tls.ConnectionOptions['lookup'];

describe('shouldRetryOriginLeg', () => {
  it('retries a provably unsent leg exactly once', () => {
    const err = { code: 'ERR_SOCKET_CLOSED' };
    assert.equal(shouldRetryOriginLeg(err, { headersSent: false, sentBytes: 0, attempts: 0 }), true);
    assert.equal(shouldRetryOriginLeg({ code: 'ECONNRESET' }, { headersSent: false, sentBytes: 0, attempts: 0 }), true);
  });

  it('never replays a leg that carried bytes or a response', () => {
    assert.equal(shouldRetryOriginLeg({ code: 'ERR_SOCKET_CLOSED' }, { headersSent: false, sentBytes: 1, attempts: 0 }), false);
    assert.equal(shouldRetryOriginLeg({ code: 'ERR_SOCKET_CLOSED' }, { headersSent: true, sentBytes: 0, attempts: 0 }), false);
  });

  it('gives up after one retry and ignores non-transport failures', () => {
    assert.equal(shouldRetryOriginLeg({ code: 'ERR_SOCKET_CLOSED' }, { headersSent: false, sentBytes: 0, attempts: 1 }), false);
    assert.equal(shouldRetryOriginLeg({ code: 'CERT_HAS_EXPIRED' }, { headersSent: false, sentBytes: 0, attempts: 0 }), false);
    assert.equal(shouldRetryOriginLeg('boom', { headersSent: false, sentBytes: 0, attempts: 0 }), false);
  });
});

/** A fake outbound proxy: the first CONNECT is accepted, then dropped once the
 *  client body has had time to arrive (so a pump that starts too early has
 *  already consumed it — the exact mis-replay the retry must not do). */
function flakyProxy(): Promise<{ port: number; connects: () => number; close: () => Promise<void> }> {
  let connects = 0;
  const srv = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  srv.on('connect', (req, socket) => {
    connects += 1;
    const [host, port] = String(req.url).split(':');
    if (connects === 1) {
      // Flush the 200, then let the origin's TLS ClientHello arrive on this
      // tunnel and drop it WITHOUT forwarding anything. Event-driven (not a
      // sleep): the drop lands exactly when the handshake starts, which is
      // after a mis-started pump would have consumed the client body.
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n', () => {
        socket.once('data', () => socket.destroy());
      });
      return;
    }
    // The authority is a fabricated name (the real origin listens on loopback
    // and the proxy reaches it through the `lookup` seam); the fake proxy must
    // not try to resolve it on its own.
    void host;
    const up = net.connect(Number(port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        connects: () => connects,
        close: () =>
          new Promise((done) => {
            srv.close(() => done());
            // Safety net only: a lingering socket must not hang the suite.
            setTimeout(done, 300);
          }),
      });
    });
  });
}

function originServer(ca: CaMaterial): Promise<{ port: number; close: () => Promise<void> }> {
  const leaf = new CertMinter(ca).get('origin.retry.test');
  const srv = tls.createServer({ key: leaf.key, cert: leaf.cert }, (s) => {
    let buf = Buffer.alloc(0);
    let answered = false;
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0 || answered) return;
      const head = buf.subarray(0, idx).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(head);
      const want = m ? Number(m[1]) : 0;
      // Only answer once the WHOLE declared body arrived: a retry that lost
      // the request prefix leaves the origin waiting, and the client sees no
      // response instead of a plausible-looking partial answer.
      if (buf.length - (idx + 4) < want) return;
      answered = true;
      const payload = `safe:${String(want).padStart(8, '0')}`;
      s.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
      );
    });
    s.on('error', () => {});
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            try {
              srv.close(() => done());
            } catch {
              done();
            }
            // Safety net only: a lingering socket must not hang the suite.
            setTimeout(done, 300);
          }),
      });
    });
  });
}

describe('forward-proxy: a dropped origin tunnel is retried once', () => {
  after(() => {
    initProxyConfig(undefined);
    setUpstreamTlsReader(() => undefined);
  });

  it('answers 200 with the WHOLE body when the first CONNECT dies before any byte', async () => {
    const ca = ensureTestCa(tmpDir('ocr-fp-retry-ca-'));
    const origin = await originServer(ca);
    const fake = await flakyProxy();
    initProxyConfig({ enabled: true, mode: 'manual', url: `http://127.0.0.1:${fake.port}` });
    setUpstreamTlsReader(() => ({ insecure: true }));
    const proxy = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpDir('ocr-fp-retry-ca-dir-'),
      rules: [{ match: '*', ingress: 'intercept', egress: 'proxy' }],
      interceptPosture: 'all',
      intercept: async () => false,
      upstreamTls: { lookup: toLoopback },
    });
    try {
      const sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(proxy.port, '127.0.0.1', () => {
          s.write(`CONNECT origin.retry.test:${origin.port} HTTP/1.1\r\nHost: origin.retry.test:${origin.port}\r\n\r\n`);
        });
        let buf = '';
        const onData = (d: Buffer): void => {
          buf += d.toString('latin1');
          if (buf.includes('\r\n\r\n')) {
            s.removeListener('data', onData);
            resolve(s);
          }
        };
        s.on('data', onData);
        s.on('error', reject);
      });
      const client = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({ socket: sock, servername: 'origin.retry.test', rejectUnauthorized: false }, () => resolve(t));
        t.on('error', reject);
      });
      // A body big enough that a retry which lost the already-consumed prefix
      // cannot be mistaken for a success: the origin only answers once the
      // whole declared Content-Length arrived.
      const body = 'a'.repeat(64 * 1024);
      const resp = await new Promise<string>((resolve, reject) => {
        client.write(
          `POST /v1internal:loadCodeAssist HTTP/1.1\r\nHost: origin.retry.test\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
        );
        let buf = '';
        client.on('data', (d: Buffer) => (buf += d.toString()));
        client.on('end', () => resolve(buf));
        client.on('close', () => resolve(buf));
        client.on('error', reject);
        // Hang guard only: the awaited signal is `end`/`close`, never this.
        client.setTimeout(5000, () => client.destroy(new Error('origin never answered — the retried body was incomplete')));
      });
      client.destroy();
      assert.match(resp, /^HTTP\/1\.1 200/);
      assert.match(resp, new RegExp(`safe:${String(body.length).padStart(8, '0')}$`));
      assert.equal(fake.connects(), 2, 'one dropped tunnel, one healthy retry');
    } finally {
      await proxy.close();
      await fake.close();
      await origin.close();
    }
  });
});
