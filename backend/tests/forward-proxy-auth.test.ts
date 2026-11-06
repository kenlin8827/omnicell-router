import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { assertForwardProxyBindSafety } from '../src/forward-proxy/index.js';

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
  it('loopback is fine without a token; anything else needs one', () => {
    assert.doesNotThrow(() => assertForwardProxyBindSafety('127.0.0.1', undefined));
    assert.doesNotThrow(() => assertForwardProxyBindSafety('localhost', undefined));
    assert.doesNotThrow(() => assertForwardProxyBindSafety('::1', undefined));
    assert.doesNotThrow(() => assertForwardProxyBindSafety('', undefined));

    // An unauthenticated MITM proxy must never be reachable off-box.
    assert.throws(() => assertForwardProxyBindSafety('0.0.0.0', undefined), /authToken is unset/);
    assert.throws(() => assertForwardProxyBindSafety('192.168.1.10', undefined), /authToken is unset/);
    assert.throws(() => assertForwardProxyBindSafety('0.0.0.0', '   '), /authToken is unset/);

    // With a token, exposing it is the operator's explicit choice.
    assert.doesNotThrow(() => assertForwardProxyBindSafety('0.0.0.0', 'sekret'));
  });
});

describe('forward-proxy: inbound proxy auth (407)', () => {
  it('CONNECT without a token is challenged, with the right token it proceeds', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => false,
      authToken: 'sekret',
    });
    try {
      const missing = await rawExchange(handle.port, 'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
      assert.match(missing, /^HTTP\/1\.1 407 Proxy Authentication Required/, missing);
      assert.match(missing, /Proxy-Authenticate: Basic realm="OmniCellRouter"/i, 'the challenge must name the scheme');

      const wrong = await rawExchange(
        handle.port,
        `CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: ${basic('nope')}\r\n\r\n`
      );
      assert.match(wrong, /^HTTP\/1\.1 407 /, wrong);

      const ok = await rawExchange(
        handle.port,
        `CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: ${basic('sekret')}\r\n\r\n`
      );
      assert.match(ok, /^HTTP\/1\.1 200 Connection Established/, ok);
    } finally {
      await handle.close();
    }
  });

  it('a plain absolute-URI request is challenged too (same boundary, same token)', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => false,
      authToken: 'sekret',
    });
    try {
      const missing = await rawExchange(handle.port, 'GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\n\r\n');
      assert.match(missing, /407 Proxy Authentication Required/, missing);
      assert.match(missing, /proxy-authenticate/i, 'the response must carry the challenge header');
    } finally {
      await handle.close();
    }
  });

  it('with no token configured the loopback proxy stays open (historical posture)', async () => {
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
});
