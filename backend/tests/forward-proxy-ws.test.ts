import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { ensureCa, CertMinter } from '../src/forward-proxy/ca.js';
import { createWsObserver } from '../src/forward-proxy/ws-frames.js';
import {
  clearProxyAccessLog,
  listProxyAccessEvents,
  setProxyAccessLogSettingsReader,
} from '../src/forward-proxy/access-log.js';

/**
 * WebSocket: frame observation (RFC 6455) on the upgrade relay (ADR-0020).
 *
 * The relay stays BYTE-VERBATIM — an upgrade is a single hop, and vendor
 * semantics belong to a client-gateway plugin (ADR-0017), never to the core
 * proxy. What the core owes the operator is observation: "the socket is open"
 * is not an answer when a realtime API misbehaves. The observer counts frames,
 * messages, control frames and the close code WITHOUT buffering or rewriting a
 * byte, and it never throws on a hostile or partial stream.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const toLoopback = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
  cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as tls.ConnectionOptions['lookup'];

const CRLF = '\r\n';

/** Build one WebSocket frame (masked by default — what a client must send). */
function wsFrame(opcode: number, payload: Buffer, opts: { fin?: boolean; mask?: boolean } = {}): Buffer {
  const fin = opts.fin !== false;
  const mask = opts.mask !== false;
  const len = payload.length;
  const header: number[] = [(fin ? 0x80 : 0x00) | opcode];
  if (len < 126) {
    header.push((mask ? 0x80 : 0) | len);
  } else {
    header.push((mask ? 0x80 : 0) | 126, (len >> 8) & 0xff, len & 0xff);
  }
  if (!mask) return Buffer.concat([Buffer.from(header), payload]);
  const key = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i % 4];
  return Buffer.concat([Buffer.from(header), key, masked]);
}

function connectViaProxy(proxyPort: number, targetHost: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${targetHost}:${port} HTTP/1.1${CRLF}Host: ${targetHost}:${port}${CRLF}${CRLF}`);
    });
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1');
      if (buf.includes(CRLF + CRLF)) {
        sock.removeListener('data', onData);
        resolve(sock);
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
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

describe('forward-proxy: WebSocket frame observer', () => {
  it('counts messages, control frames and the close code without touching bytes', () => {
    const obs = createWsObserver();
    obs.push('c2s', wsFrame(0x1, Buffer.from('hello')));
    obs.push('s2c', wsFrame(0x2, Buffer.from([1, 2, 3]), { mask: false }));
    obs.push('c2s', wsFrame(0x9, Buffer.from('p'), { mask: true }));
    obs.push('s2c', wsFrame(0xa, Buffer.from('p'), { mask: false }));
    // A fragmented message: text + continuation.
    obs.push('c2s', wsFrame(0x1, Buffer.from('ab'), { fin: false }));
    obs.push('c2s', wsFrame(0x0, Buffer.from('cd'), { fin: true }));
    obs.push('s2c', wsFrame(0x8, Buffer.from([0x03, 0xe8, 0x62, 0x79, 0x65]), { mask: false }));

    const o = obs.observation();
    assert.equal(o.text, 2, 'two text messages (the fragmented one counts once)');
    assert.equal(o.binary, 1);
    assert.equal(o.ping, 1);
    assert.equal(o.pong, 1);
    assert.equal(o.close?.code, 1000);
    assert.equal(o.close?.reason, 'bye');
    assert.equal(o.truncated, false);
    assert.match(obs.note(), /ws: 3 msg \(2 text \/ 1 binary\)/);
    assert.match(obs.note(), /close 1000/);
  });

  it('survives a partial frame and a hostile length without throwing', () => {
    const obs = createWsObserver();
    const frame = wsFrame(0x1, Buffer.from('hello'));
    obs.push('c2s', frame.subarray(0, 3)); // partial header
    assert.equal(obs.observation().frames, 0);
    obs.push('c2s', frame.subarray(3)); // completes it
    assert.equal(obs.observation().frames, 1);
    // A declared 2^40-byte frame: the observer stops instead of allocating.
    obs.push('s2c', Buffer.from([0x82, 0xff, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]));
    assert.equal(obs.observation().truncated, true);
  });
});

describe('forward-proxy: WebSocket frame stats on the h1 upgrade leg', () => {
  it('records frame counts for a relayed upgrade without touching its bytes', async () => {
    setProxyAccessLogSettingsReader(() => ({ enabled: true, persist: false, persistDays: 1 }));
    clearProxyAccessLog();

    const caDir = tmpDir('ocr-fp-wsstats-ca-');
    const ca = ensureCa(caDir);
    const leaf = new CertMinter(ca).get('wsstats.test');

    // Origin: completes the h1 upgrade, then echoes every byte verbatim.
    // After the client's text frame is echoed, it also sends an UNMASKED
    // server close (RFC 6455: server frames are never masked), so the s2c
    // close path is exercised with a real, unmasked close code.
    let originSock: net.Socket | undefined;
    const origin = tls.createServer({ key: leaf.key, cert: leaf.cert }, (s) => {
      originSock = s;
      let buf = '';
      let upgraded = false;
      s.on('data', (d: Buffer) => {
        if (upgraded) {
          s.write(d);
          return;
        }
        buf += d.toString('latin1');
        const end = buf.indexOf(CRLF + CRLF);
        if (end === -1) return;
        upgraded = true;
        s.write(
          'HTTP/1.1 101 Switching Protocols' + CRLF + 'Upgrade: websocket' + CRLF + 'Connection: Upgrade' + CRLF +
            'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=' + CRLF + CRLF
        );
        const rest = buf.slice(end + 4);
        if (rest) s.write(Buffer.from(rest, 'latin1'));
      });
      s.on('error', () => {});
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
    const originPort = (origin.address() as net.AddressInfo).port;

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async () => false,
      upstreamTls: { ca: ca.caCertPem, lookup: toLoopback },
    });

    const sock = await connectViaProxy(handle.port, 'wsstats.test', originPort);
    const client = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const t = tls.connect({ socket: sock, servername: 'wsstats.test', ca: ca.caCertPem }, () => resolve(t));
      t.on('error', reject);
    });
    const textFrame = wsFrame(0x1, Buffer.from('hi'));
    let upgradedSeen = '';
    client.on('data', (d: Buffer) => {
      // Wait on the ECHO, not the request: the client frame is masked with
      // key [1,2,3,4], so "hi" (0x68 0x69) travels as 0x69 0x6b — a pattern
      // the 101 banner never contains.
      upgradedSeen += d.toString('latin1');
    });
    client.write(
      'GET /socket HTTP/1.1' + CRLF + 'Host: wsstats.test' + CRLF + 'Upgrade: websocket' + CRLF +
        'Connection: Upgrade' + CRLF + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' + CRLF +
        'Sec-WebSocket-Version: 13' + CRLF + CRLF
    );
    await waitFor(() => upgradedSeen.includes('101 Switching Protocols'));
    client.write(textFrame);
    await waitFor(() => upgradedSeen.includes('\x69\x6b'));
    originSock!.write(wsFrame(0x8, Buffer.from([0x03, 0xe8, 0x62, 0x79, 0x65]), { mask: false }));
    client.destroy();
    sock.destroy();

    await waitFor(() => listProxyAccessEvents(100).some((e) => (e.note ?? '').includes('ws:')));
    const row = listProxyAccessEvents(100).find((e) => (e.note ?? '').includes('ws:'));
    assert.ok(row, `expected a ws note, got: ${JSON.stringify(listProxyAccessEvents(10).map((e) => e.note))}`);
    assert.equal(row!.status, 101, 'the upgrade response status lands on the row');
    // 2 text = the client frame (c2s) AND its verbatim echo (s2c); the close
    // code comes from the origin's unmasked server close, not a masked echo.
    assert.match(String(row!.note), /2 text/, `both directions' text frames counted: ${row!.note}`);

    await handle.close();
    await new Promise<void>((r) => origin.close(() => r()));
  });
});
