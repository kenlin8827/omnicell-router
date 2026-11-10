import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { assertForwardProxyBindSafety } from '../src/forward-proxy/index.js';
import { isApiKeyUsable } from '../src/auth/api-keys.js';
import { markProxyCaller, proxyCallerOf, runWithProxyCaller, getProxyCaller } from '../src/forward-proxy/caller-context.js';

/**
 * Inbound proxy auth (407) and the bind-safety gate — ADR-0008 §3.
 *
 * Full capture means the proxy decrypts and records whatever its clients send,
 * so "who may use it" is a security boundary, not a convenience. The gate is
 * deliberately blunt: loopback needs no token, anything else REQUIRES one, and
 * the start is refused rather than silently downgraded.
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-auth-'));
}

/** Open a raw socket to the proxy and resolve with everything it answers. */
function rawExchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(request));
    let buf = '';
    sock.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
    });
    sock.on('error', reject);
    sock.on('close', () => resolve(buf));
    setTimeout(() => {
      sock.destroy();
      resolve(buf);
    }, 1500);
  });
}

function basic(token: string): string {
  return 'Basic ' + Buffer.from(`ocr:${token}`).toString('base64');
}

describe('forward-proxy: bind safety gate', () => {
  it('loopback is fine without a key; anything else needs an enabled key', () => {
    assert.doesNotThrow(() => assertForwardProxyBindSafety('127.0.0.1', false));
    assert.doesNotThrow(() => assertForwardProxyBindSafety('localhost', false));
    assert.doesNotThrow(() => assertForwardProxyBindSafety('::1', false));
    assert.doesNotThrow(() => assertForwardProxyBindSafety('', false));

    // An unauthenticated MITM proxy must never be reachable off-box.
    assert.throws(() => assertForwardProxyBindSafety('0.0.0.0', false), /API key/);
    assert.throws(() => assertForwardProxyBindSafety('192.168.1.10', false), /API key/);

    // At least one enabled key is the only valid gate (ADR-0017).
    assert.doesNotThrow(() => assertForwardProxyBindSafety('0.0.0.0', true));

    // Strict mode (`forwardProxy.requireCredential`) turns the loopback
    // exemption off: without a key there would be nothing to authenticate.
    assert.throws(() => assertForwardProxyBindSafety('127.0.0.1', false, true), /requireCredential/);
    assert.doesNotThrow(() => assertForwardProxyBindSafety('127.0.0.1', true, true));
  });
});

describe('forward-proxy: inbound proxy auth (407)', () => {
  it('with no credential configured the loopback proxy stays open (historical posture)', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => false,
    });
    try {
      const plain = await rawExchange(handle.port, 'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
      assert.match(plain, /^HTTP\/1\.1 200 Connection Established/, plain);
    } finally {
      await handle.close();
    }
  });

  it('strict mode requires a credential on loopback and hot-applies from the live config', async () => {
    let requireCredential = false;
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => false,
      liveForwardProxy: () => ({ enabled: true, requireCredential }),
      resolveApiKey: (secret) => (secret === 'sk-ocr-test' ? { id: 'key-1', name: 'Cursor' } : undefined),
    });
    try {
      const open = await rawExchange(handle.port, 'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
      assert.match(open, /^HTTP\/1\.1 200 Connection Established/, open);

      requireCredential = true;
      const denied = await rawExchange(handle.port, 'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
      assert.match(denied, /^HTTP\/1\.1 407 /, denied);

      const ok = await rawExchange(
        handle.port,
        `CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: ${basic('sk-ocr-test')}\r\n\r\n`
      );
      assert.match(ok, /^HTTP\/1\.1 200 Connection Established/, ok);
    } finally {
      await handle.close();
    }
  });

  it('retires an OPEN credential-less tunnel (both halves) when strict mode switches on', async () => {
    let requireCredential = false;
    // A real origin lets the assertion cover the tunnel's UPSTREAM half too: a
    // sweep that only closes the client socket would leak the peer.
    const upstream = net.createServer();
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const accepted = new Promise<net.Socket>((resolve) => upstream.once('connection', resolve));
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => false,
      liveForwardProxy: () => ({ enabled: true, requireCredential }),
      resolveApiKey: () => undefined,
    });
    const sock = net.connect(handle.port, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
      const established = new Promise<string>((resolve) => {
        sock.once('data', (d: Buffer) => resolve(d.toString('latin1')));
      });
      sock.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
      assert.match(await established, /^HTTP\/1\.1 200 Connection Established/);
      const peer = await accepted;
      const peerClosed = new Promise<void>((resolve) => peer.once('close', resolve));

      // Admission already happened; the tunnel must die from the live flag
      // rather than lingering with full capture until the client hangs up.
      // Integration against the real listener: the retirement sweep is a
      // production 1s interval driving real sockets, so fake timers cannot
      // exercise it. The guard only turns a hung regression into a failure.
      requireCredential = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tunnel stayed open')), 3000);
        sock.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await peerClosed;
    } finally {
      sock.destroy();
      upstream.close();
      await handle.close();
    }
  });
});

describe('forward-proxy: API-key credentials (ADR-0017)', () => {
  it('accepts an OCR key as the Basic password and rejects anything else', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => false,
      authRequired: true,
      resolveApiKey: (secret) => (secret === 'sk-ocr-test' ? { id: 'key-1', name: 'Cursor' } : undefined),
    });
    try {
      const missing = await rawExchange(handle.port, 'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
      assert.match(missing, /^HTTP\/1\.1 407 /, missing);

      const wrong = await rawExchange(
        handle.port,
        `CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: ${basic('sk-ocr-nope')}\r\n\r\n`
      );
      assert.match(wrong, /^HTTP\/1\.1 407 /, wrong);

      const ok = await rawExchange(
        handle.port,
        `CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: ${basic('sk-ocr-test')}\r\n\r\n`
      );
      assert.match(ok, /^HTTP\/1\.1 200 Connection Established/, ok);
    } finally {
      await handle.close();
    }
  });

  it('requires a credential when authRequired is set', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => false,
      authRequired: true,
      resolveApiKey: () => undefined,
    });
    try {
      const plain = await rawExchange(handle.port, 'GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\n\r\n');
      assert.match(plain, /407 Proxy Authentication Required/, plain);
    } finally {
      await handle.close();
    }
  });
});

describe('forward-proxy: caller context', () => {
  it('keeps the caller scoped to the async gateway turn and off the request map afterwards', () => {
    const req = {} as http.IncomingMessage;
    markProxyCaller(req, { keyId: 'key-1', name: 'Cursor' });
    assert.deepEqual(proxyCallerOf(req), { keyId: 'key-1', name: 'Cursor' });

    assert.equal(getProxyCaller(), undefined);
    const seen = runWithProxyCaller(proxyCallerOf(req), () => getProxyCaller());
    assert.deepEqual(seen, { keyId: 'key-1', name: 'Cursor' });
    assert.equal(getProxyCaller(), undefined, 'scope must not leak outside the turn');
  });
});

describe('forward-proxy: key usability', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('requires enabled and unexpired keys, and never expires an unparseable date', () => {
    assert.equal(isApiKeyUsable({ enabled: true }, now), true);
    assert.equal(isApiKeyUsable({ enabled: false }, now), false);
    assert.equal(isApiKeyUsable({ enabled: true, expiresAt: '2025-12-31T23:59:59Z' }, now), false);
    assert.equal(isApiKeyUsable({ enabled: true, expiresAt: '2026-01-01T00:00:01Z' }, now), true);
    assert.equal(isApiKeyUsable({ enabled: true, expiresAt: 'not-a-date' }, now), true);
    assert.equal(isApiKeyUsable(undefined, now), false);
  });
});
