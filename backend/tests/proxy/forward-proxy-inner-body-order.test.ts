import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../../src/forward-proxy/server.js';
import { CertMinter, type CaMaterial } from '../../src/forward-proxy/ca.js';
import { ensureTestCa } from '../helpers/test-ca.js';

/**
 * Body ordering on the MITM inner hop.
 *
 * The decrypted client stream is relayed to a loopback `net.connect` that feeds
 * the inner HTTP server. A large request body arrives as MANY TLS records, and
 * the loopback socket only finishes connecting on a later tick — so any chunk
 * written to that socket before `connect` resolves queues AHEAD of the buffered
 * request head. The parser then reads body text where it expects a request line
 * (`HPE_INVALID_METHOD`) and the client sees a 400 with an empty body: the
 * "request failed with empty body (code 400)" a Go client reports for a large
 * prompt. Small bodies hide it (one chunk, one write, no inversion), which is
 * why this must be pinned with a body that spans several records.
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-body-order-'));
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

function tlsOver(socket: net.Socket, opts: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, ...opts }, () => resolve(t));
    t.on('error', reject);
  });
}

/** Origin that answers with the exact number of body bytes it parsed. */
async function byteCountingOrigin(ca: CaMaterial, certHost: string): Promise<{ port: number; close: () => Promise<void> }> {
  const leaf = new CertMinter(ca).get(certHost);
  const srv = tls.createServer({ key: leaf.key, cert: leaf.cert }, (s) => {
    let head = '';
    let bodyBytes = 0;
    let declared = -1;
    s.on('data', (d: Buffer) => {
      if (declared === -1) {
        head += d.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        const match = /content-length: *(\d+)/i.exec(head.slice(0, end));
        declared = match ? Number(match[1]) : 0;
        bodyBytes += Buffer.byteLength(head.slice(end + 4), 'latin1');
        head = '';
      } else {
        bodyBytes += d.length;
      }
      if (bodyBytes >= declared) {
        const body = `declared=${declared} received=${bodyBytes}`;
        s.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      }
    });
    s.on('error', () => {});
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (srv.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((done) => {
        try {
          srv.close(() => done());
        } catch {
          done();
        }
      }),
  };
}

describe('forward-proxy: MITM inner body ordering', () => {
  it('delivers a multi-record body ahead of nothing and parses the request intact', async () => {
    const caDir = tmpCaDir();
    const ca = ensureTestCa(caDir);
    const origin = await byteCountingOrigin(ca, 'big-body.test');
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      interceptPosture: 'all',
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'big-body.test', origin.port);
    const secure = await tlsOver(sock, { servername: 'big-body.test', ca: ca.caCertPem });

    // 160 KiB: many TLS records, written as ONE client write so the records
    // reach the decrypted stream back-to-back — the exact shape that queued
    // body chunks ahead of the head before the ordering fix.
    const body = Buffer.from('{"prompt":"' + 'x'.repeat(160 * 1024) + '"}');
    const response = await new Promise<string>((resolve, reject) => {
      let buf = '';
      secure.on('data', (d: Buffer) => {
        buf += d.toString();
      });
      secure.on('end', () => resolve(buf));
      secure.on('close', () => resolve(buf));
      secure.on('error', reject);
      secure.write(`POST /v1internal:streamGenerateContent HTTP/1.1\r\nHost: big-body.test\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`);
      // Slice the body so TLS emits one record per write, the shape a Go client
      // produces: the head lands alone, then the tail arrives while the inner
      // hop is still connecting.
      for (let i = 0; i < body.length; i += 8192) secure.write(body.subarray(i, i + 8192));
    });

    assert.match(response, /^HTTP\/1\.1 200 /, `expected the origin's 200, got: ${response.slice(0, 120)}`);
    assert.ok(
      response.includes(`declared=${body.length} received=${body.length}`),
      `the origin must parse the body exactly once, got: ${response.slice(-80)}`,
    );

    secure.destroy();
    await origin.close();
    await handle.close();
  });
});
