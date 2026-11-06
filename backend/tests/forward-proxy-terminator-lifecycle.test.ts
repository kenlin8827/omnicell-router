import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import {
  clearProxyAccessLog,
  listProxyAccessEvents,
  setProxyAccessLogSettingsReader,
} from '../src/forward-proxy/access-log.js';

/**
 * Terminator lifecycle + interception observability (ADR-0018 §3a, ADR-0019).
 *
 * Two failures this pins:
 *  1. EVICTION USED TO KILL A LIVE TARGET. Terminators are LRU-bounded because
 *     full capture sees every host a client visits; the old eviction closed the
 *     listener immediately, so a CONNECT that had already resolved that
 *     terminator's port could hit ECONNREFUSED and silently degrade to a blind
 *     tunnel. Eviction now drains (accept still works for the in-flight
 *     CONNECT, the entry is never reused for a NEW one).
 *  2. A CLIENT REJECTING OUR LEAF WAS INVISIBLE. Certificate pinning / a
 *     missing CA aborts inside the handshake, so no request is ever made and
 *     nothing reached the ledger — the operator saw a broken app and a console
 *     line. It is now a `connect` row.
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-term-'));
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

function tlsOver(socket: net.Socket, opts: { servername: string; ca?: string; rejectUnauthorized?: boolean }): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, ...opts }, () => resolve(t));
    t.on('error', reject);
  });
}

function request(sock: tls.TLSSocket, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    let buf = '';
    sock.on('data', (d: Buffer) => (buf += d.toString()));
    sock.on('end', () => resolve(buf));
    sock.on('close', () => resolve(buf));
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

const notes = (): string[] => listProxyAccessEvents(200).map((e) => e.note ?? '');

describe('forward-proxy: terminator lifecycle', () => {
  it('an evicted terminator keeps serving the CONNECT already in flight', async () => {
    setProxyAccessLogSettingsReader(() => ({ enabled: true, persist: false, persistDays: 1 }));
    clearProxyAccessLog();

    let intercepted = 0;
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      maxHostTerminators: 2,
      intercept: async (_req, res) => {
        intercepted += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return true;
      },
    });

    const roundTrip = async (host: string): Promise<string> => {
      const sock = await connectViaProxy(handle.port, host, 443);
      const tlsSock = await tlsOver(sock, { servername: host, ca: handle.caCertPem });
      const resp = await request(tlsSock, host);
      tlsSock.destroy();
      return resp;
    };

    // Fill the LRU (bound 2) with two hosts, then push a third through — the
    // first host's terminator is evicted into the draining set.
    for (const host of ['a.term.test', 'b.term.test', 'c.term.test']) {
      assert.ok((await roundTrip(host)).includes('{"ok":true}'), `${host} must be intercepted`);
    }
    // The evicted host must still be interceptable: either its draining
    // listener answered, or a fresh terminator was minted — never a blind
    // tunnel fallback.
    assert.ok((await roundTrip('a.term.test')).includes('{"ok":true}'), 'evicted host must stay intercepted');
    assert.equal(intercepted, 4);

    const seen = notes();
    assert.equal(
      seen.filter((n) => n.includes('mitm setup failed')).length,
      0,
      `no blind-tunnel degradation allowed: ${JSON.stringify(seen)}`
    );
    assert.equal(seen.filter((n) => n === 'connect (mitm)').length, 4);

    await handle.close();
  });
});

describe('forward-proxy: client-rejected certificate', () => {
  it('records a ledger row when the client refuses the intercepted leaf', async () => {
    setProxyAccessLogSettingsReader(() => ({ enabled: true, persist: false, persistDays: 1 }));
    clearProxyAccessLog();

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async (_req, res) => {
        res.writeHead(200);
        res.end('{}');
        return true;
      },
    });

    const sock = await connectViaProxy(handle.port, 'pinned.test', 443);
    // A pinning client: it validates against ITS trust store, which does not
    // hold our CA, so it aborts the handshake after seeing the leaf.
    await assert.rejects(tlsOver(sock, { servername: 'pinned.test', rejectUnauthorized: true }));
    sock.destroy();

    await waitFor(() => notes().some((n) => n.includes('closed the intercepted TLS session')));
    const row = listProxyAccessEvents(50).find((e) => (e.note ?? '').includes('closed the intercepted TLS session'));
    assert.ok(row, `expected a pinning row, got: ${JSON.stringify(notes())}`);
    assert.equal(row!.kind, 'connect');
    assert.equal(row!.host, 'pinned.test');
    assert.equal(row!.port, 443);

    await handle.close();
  });
});
