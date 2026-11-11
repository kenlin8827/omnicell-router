import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { getProxyCaller } from '../src/forward-proxy/caller-context.js';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { createProxyInterceptor } from '../src/forward-proxy/interceptor.js';
import { stageGateway, commitGateways, removeGateway } from '../src/plugins/gateways.js';
import type { ClientGatewayPlugin } from '../src/plugins/types.js';

/**
 * Client-gateway h2 leg (ADR-0018). Exercises the REAL sockets: CONNECT → SNI
 * peek → per-host TLS terminator → ALPN h2 → h2c inner loopback → the REAL
 * createProxyInterceptor chain (gateway dispatch lives there, not in the
 * server). The stub gateway speaks a minimal Connect envelope so the
 * assertions stay byte-level.
 */

/** Minimal orchestrator: never reached — every test routes via the gateway
 *  or falls through detectSurface to transparent forward. */
const fakeOrchestrator = {
  process: async () => {
    throw new Error('orchestrator must not run in gateway-h2 tests');
  },
} as unknown as PipelineOrchestrator;

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-gw-'));
}

function withTimeout<T>(p: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('test timeout')), ms)),
  ]);
}

/** Send CONNECT through the proxy; resolve once the 200 is received. */
function connectViaProxy(proxyPort: number, targetHost: string, secret?: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      const auth = secret ? `Proxy-Authorization: Basic ${Buffer.from(`ocr:${secret}`).toString('base64')}\r\n` : '';
      sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n${auth}\r\n`);
    });
    let buf = '';
    const onData = (d: Buffer) => {
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

/** One Connect frame: [1B flags][4B BE length][payload]. */
function frame(payload: Buffer, flags = 0): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** One HTTP/2 request over a CONNECT+TLS tunnel (headers via the response
 *  event — Bun's ClientHttp2Stream.headers getter is not implemented). */
function h2Request(
  tlsSock: tls.TLSSocket,
  authority: string,
  headers: Record<string, string>,
  body: Buffer
): Promise<{ headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(authority, { createConnection: () => tlsSock as never });
    session.on('error', reject);
    const stream = session.request({ ':method': 'POST', ...headers });
    const chunks: Buffer[] = [];
    let hdrs: Record<string, unknown> = {};
    stream.on('response', (h) => {
      hdrs = h as Record<string, unknown>;
    });
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('error', reject);
    stream.on('close', () => {
      session.close();
      resolve({ headers: hdrs, body: Buffer.concat(chunks) });
    });
    stream.end(body);
  });
}

describe('forward-proxy: client-gateway h2 leg', () => {
  it('gateway-claimed host: ALPN h2 negotiated, request dispatched to the gateway over the h2 inner leg', async () => {
    const caDir = tmpCaDir();
    const payload = Buffer.from('hello-gateway', 'utf8');
    let seen: { url?: string; method?: string; host?: string; body?: Buffer } | undefined;
    const stub: ClientGatewayPlugin = {
      hosts: ['gw-h2.test'],
      match: (info) => (info.url ?? '').startsWith('/echo'),
      handle: async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const d of req) chunks.push(d as Buffer);
        seen = {
          url: req.url,
          method: req.method,
          host: String(req.headers[':authority'] ?? req.headers.host ?? ''),
          body: Buffer.concat(chunks),
        };
        res.writeHead(200, { 'content-type': 'application/connect+proto' });
        // Echo the first frame back, then a clean end-stream JSON trailer.
        const incoming = Buffer.concat(chunks);
        res.write(frame(incoming.subarray(5)));
        res.write(frame(Buffer.from('{}', 'utf8'), 0x80));
        res.end();
      },
    };
    stageGateway('test-stub', stub);
    commitGateways();

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: createProxyInterceptor(fakeOrchestrator),
    });

    try {
      const sock = await connectViaProxy(handle.port, 'gw-h2.test');
      const tlsSock = await withTimeout(
        new Promise<tls.TLSSocket>((resolve, reject) => {
          const t = tls.connect(
            { socket: sock, servername: 'gw-h2.test', ca: handle.caCertPem, ALPNProtocols: ['h2'], rejectUnauthorized: true },
            () => resolve(t)
          );
          t.on('error', reject);
        })
      );
      assert.equal(tlsSock.alpnProtocol, 'h2', 'gateway host must negotiate h2');

      const resp = await withTimeout(
        h2Request(tlsSock, 'https://gw-h2.test', { ':path': '/echo', 'content-type': 'application/connect+proto' }, frame(payload))
      );

      assert.equal(String(resp.headers[':status']), '200');
      // Wire body: [5B Connect header][payload][5B header][end-stream JSON].
      const endAt = 5 + payload.length;
      assert.equal(resp.body.readUInt32BE(1), payload.length, 'echo frame length');
      assert.equal(resp.body.subarray(5, endAt).toString(), 'hello-gateway');
      assert.equal(resp.body.readUInt8(endAt), 0x80, 'end-stream frame flag');
      assert.deepEqual(JSON.parse(resp.body.subarray(endAt + 5).toString()), {});

      assert.ok(seen, 'gateway must have handled the request');
      assert.equal(seen!.url, '/echo');
      assert.equal(seen!.host, 'gw-h2.test');
      assert.equal(seen!.body!.subarray(5).toString(), 'hello-gateway');

      tlsSock.destroy();
    } finally {
      removeGateway('test-stub');
      await handle.close();
    }
  });

  it('non-gateway host prefers h1 for a dual-offer client (server-preference ALPN, no h1 interception regression)', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => false,
    });

    try {
      const sock = await connectViaProxy(handle.port, 'plain.test');
      const tlsSock = await withTimeout(
        new Promise<tls.TLSSocket>((resolve, reject) => {
          const t = tls.connect(
            {
              socket: sock,
              servername: 'plain.test',
              ca: handle.caCertPem,
              ALPNProtocols: ['h2', 'http/1.1'],
              rejectUnauthorized: true,
            },
            () => resolve(t)
          );
          t.on('error', reject);
        })
      );
      assert.equal(tlsSock.alpnProtocol, 'http/1.1', 'an unclaimed host serves h1 to dual-offer clients (h2 stays available to h2-only clients)');
      tlsSock.destroy();
    } finally {
      await handle.close();
    }
  });

  it('interceptor: gateway match() failure on a claimed host falls through to transparent forward', async () => {
    // A claimed host whose gateway declines the path must still relay upstream
    // rather than hang — proven here with an unreachable upstream producing a
    // connect error instead of a dispatch into the gateway.
    const caDir = tmpCaDir();
    const stub: ClientGatewayPlugin = {
      hosts: ['gw-miss.test'],
      match: () => false,
      handle: async () => {
        throw new Error('must not be called when match() is false');
      },
    };
    stageGateway('test-stub-miss', stub);
    commitGateways();

    let intercepted = 0;
    const realIntercept = createProxyInterceptor(fakeOrchestrator);
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir,
      intercept: async (req, res) => {
        intercepted += 1;
        return realIntercept(req, res);
      },
    });

    try {
      const sock = await connectViaProxy(handle.port, 'gw-miss.test');
      const tlsSock = await withTimeout(
        new Promise<tls.TLSSocket>((resolve, reject) => {
          const t = tls.connect(
            { socket: sock, servername: 'gw-miss.test', ca: handle.caCertPem, ALPNProtocols: ['h2'], rejectUnauthorized: true },
            () => resolve(t)
          );
          t.on('error', reject);
        })
      );
      assert.equal(tlsSock.alpnProtocol, 'h2', 'claimed host negotiates h2 even when a path is declined');
      // h2 POST on a path the gateway declines: the interceptor chain must
      // fall through to transparent forward (unroutable upstream → 502), NOT
      // hang. Exercises the :authority fall-through on the h2 inner leg.
      const resp = await withTimeout(
        h2Request(tlsSock, 'https://gw-miss.test', { ':path': '/nope', 'content-type': 'application/connect+proto' }, frame(Buffer.from('x')))
      );
      assert.equal(String(resp.headers[':status']), '502', `expected transparent-forward 502, got ${String(resp.headers[':status'])}`);
      assert.equal(intercepted, 1, 'intercept chain ran exactly once');
      tlsSock.destroy();
    } finally {
      removeGateway('test-stub-miss');
      await handle.close();
    }
  });
  it('CONNECT key credential is inherited by the gateway handler on the same tunnel', async () => {
    let seen: { keyId?: string; name?: string } | undefined;
    const stub: ClientGatewayPlugin = {
      hosts: ['gw-caller.test'],
      match: () => true,
      handle: async (req, res) => {
        for await (const _chunk of req) {
          // drain the request body; identity is what this test asserts
        }
        seen = getProxyCaller();
        res.writeHead(200, { 'content-type': 'application/connect+proto' });
        res.write(frame(Buffer.from('{}', 'utf8'), 0x80));
        res.end();
      },
    };
    stageGateway('test-stub-caller', stub);
    commitGateways();

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: createProxyInterceptor(fakeOrchestrator),
      authRequired: true,
      resolveApiKey: (secret) => (secret === 'sk-ocr-caller' ? { id: 'key-caller', name: 'Caller' } : undefined),
    });

    try {
      const sock = await connectViaProxy(handle.port, 'gw-caller.test', 'sk-ocr-caller');
      const tlsSock = await withTimeout(
        new Promise<tls.TLSSocket>((resolve, reject) => {
          const t = tls.connect(
            { socket: sock, servername: 'gw-caller.test', ca: handle.caCertPem, ALPNProtocols: ['h2'], rejectUnauthorized: true },
            () => resolve(t)
          );
          t.on('error', reject);
        })
      );
      await withTimeout(
        h2Request(tlsSock, 'https://gw-caller.test', { ':path': '/chat' }, frame(Buffer.from('{}')))
      );
      assert.deepEqual(seen, { keyId: 'key-caller', name: 'Caller' });
      tlsSock.destroy();
    } finally {
      removeGateway('test-stub-caller');
      await handle.close();
    }
  });
});
