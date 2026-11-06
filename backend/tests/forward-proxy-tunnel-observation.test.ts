import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { ensureCa, CertMinter } from '../src/forward-proxy/ca.js';
import {
  clearProxyAccessLog,
  listProxyAccessEvents,
  setProxyAccessLogSettingsReader,
} from '../src/forward-proxy/access-log.js';

/**
 * Blind-tunnel observation (ADR-0020).
 *
 * A tunnel is opaque BY DESIGN — TCP is passthrough-only — but "opaque" is not
 * "invisible". Two things are pinned here:
 *  1. the identity that costs no decryption (SNI, offered ALPN) is recorded, so
 *     "which host did this app actually reach" is answerable for traffic the
 *     proxy deliberately does not intercept;
 *  2. the byte totals + lifetime of a finished tunnel are recorded, so "opened
 *     and carried nothing" is distinguishable from "opened and moved data".
 *
 * The peek rides the relay's own tap: attaching a separate 'data' listener
 * before the splice would swallow everything that arrives during the dial.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('forward-proxy: blind-tunnel observation', () => {
  it('records SNI, ALPN, byte totals and lifetime for a tunnel it never decrypts', async () => {
    setProxyAccessLogSettingsReader(() => ({ enabled: true, persist: false, persistDays: 1 }));
    clearProxyAccessLog();

    const ca = ensureCa(tmpDir('ocr-fp-obs-ca-'));
    const leaf = new CertMinter(ca).get('obs.test');
    // A TLS echo origin on loopback: the CONNECT target is loopback, so the rule
    // table's loopback invariant blind-tunnels it — exactly the traffic this
    // observation exists for.
    const origin = tls.createServer({ key: leaf.key, cert: leaf.cert, ALPNProtocols: ['h2', 'http/1.1'] }, (s) => {
      s.on('data', (d) => s.write(d));
      s.on('error', () => {});
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
    const originPort = (origin.address() as net.AddressInfo).port;

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpDir('ocr-fp-obs-'),
      intercept: async () => false,
    });

    const sock = await connectViaProxy(handle.port, '127.0.0.1', originPort);
    const client = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const t = tls.connect(
        { socket: sock, servername: 'obs.test', rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] },
        () => resolve(t)
      );
      t.on('error', reject);
    });
    const echoed = await new Promise<string>((resolve) => {
      client.once('data', (d: Buffer) => resolve(d.toString('latin1')));
      client.write('ping');
    });
    assert.equal(echoed, 'ping', 'the tunnel must relay bytes untouched');
    client.destroy();
    sock.destroy();

    await waitFor(() => listProxyAccessEvents(100).some((e) => (e.note ?? '').startsWith('connect (tunnel closed')));
    const rows = listProxyAccessEvents(100);
    assert.ok(
      rows.some((e) => e.note === 'connect (blind tunnel)'),
      `the decision row must exist: ${JSON.stringify(rows.map((r) => r.note))}`
    );
    const closing = rows.find((e) => (e.note ?? '').startsWith('connect (tunnel closed'));
    assert.ok(closing, `expected a closing row, got: ${JSON.stringify(rows.map((r) => r.note))}`);
    assert.match(String(closing!.note), /sni obs\.test/, `identity missing: ${closing!.note}`);
    assert.match(String(closing!.note), /alpn h2 http\/1\.1/, `ALPN missing: ${closing!.note}`);
    assert.ok(closing!.reqBytes > 0, 'request bytes must be counted');
    assert.ok(closing!.respBytes > 0, 'response bytes must be counted');
    assert.ok((closing!.durationMs ?? 0) >= 0);

    await handle.close();
    await new Promise<void>((r) => origin.close(() => r()));
  });
});
