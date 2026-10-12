import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseClientHelloSNI } from '../src/forward-proxy/sni.js';
import { isLoopbackHost, matchBypass } from '../src/forward-proxy/bypass.js';
import { ensureCa, CertMinter } from '../src/forward-proxy/ca.js';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { createProxyInterceptor } from '../src/forward-proxy/interceptor.js';
import { loadConfig } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';

/**
 * Forward-proxy suite. NOTE: run per-file (`bun test tests/forward-proxy.test.ts`)
 * — the full-suite node:test describe-nesting cascade on this machine is noisy.
 * These tests exercise the REAL sockets/TLS handshakes (the Bun-specific MITM
 * plumbing cannot be faithfully mocked).
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-'));
}

/** Send CONNECT through the proxy; resolve once the 200 is received. */
function connectViaProxy(proxyPort: number, targetHost: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${targetHost}:${port} HTTP/1.1\r\nHost: ${targetHost}:${port}\r\n\r\n`);
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

/** TLS handshake over an established CONNECT socket (validates against ca). */
function tlsOver(socket: net.Socket, servername: string, ca: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, ca, rejectUnauthorized: true }, () => resolve(t));
    t.on('error', reject);
  });
}

/** One HTTP/1.1 request over a TLS socket; resolves the full raw response. */
function httpRequest(tlsSock: tls.TLSSocket, host: string, method: string, p: string, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers = [`${method} ${p} HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
    if (body !== undefined) {
      headers.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
    }
    tlsSock.write(headers.join('\r\n') + '\r\n\r\n' + (body ?? ''));
    let buf = '';
    tlsSock.on('data', (d: Buffer) => (buf += d.toString()));
    tlsSock.on('end', () => resolve(buf));
    tlsSock.on('close', () => resolve(buf));
    tlsSock.on('error', reject);
  });
}

describe('forward-proxy: SNI probing + bypass policy', () => {
  it('parseClientHelloSNI extracts the servername from a real ClientHello', async () => {
    const captured = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      const srv = net.createServer((sock) => {
        sock.once('data', (d: Buffer) => {
          clearTimeout(timer);
          resolve(d);
          sock.destroy();
          srv.close();
        });
      });
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as net.AddressInfo).port;
        const c = tls.connect({ host: '127.0.0.1', port, servername: 'sni.example.com', rejectUnauthorized: false });
        c.on('error', () => {}); // handshake never completes
      });
    });
    assert.equal(parseClientHelloSNI(captured), 'sni.example.com');
    assert.equal(parseClientHelloSNI(Buffer.from('not-tls')), null);
  });

  it('bypass matcher: loopback always bypasses; globs match hosts', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('api.openai.com'), false);

    assert.equal(matchBypass('api.openai.com', []).bypassed, false);
    assert.equal(matchBypass('api.openai.com', undefined).bypassed, false);
    assert.equal(matchBypass('api.openai.com', ['*.internal']).bypassed, false);
    assert.equal(matchBypass('db.internal', ['*.internal']).bypassed, true);
    assert.equal(matchBypass('1.2.3.4', []).bypassed, false);
    assert.equal(matchBypass('127.0.0.1', ['nothing-matches']).bypassed, true);

    // matchBypass: per-host egress flag (object entries); loopback stays direct
    assert.deepEqual(matchBypass('api.openai.com', []), { bypassed: false, viaProxy: false });
    assert.deepEqual(matchBypass('api.openai.com', ['*.openai.com']), { bypassed: true, viaProxy: false });
    assert.deepEqual(matchBypass('api.openai.com', [{ host: 'api.openai.com', viaProxy: true }]), { bypassed: true, viaProxy: true });
    assert.deepEqual(matchBypass('127.0.0.1', [{ host: '127.*', viaProxy: true }]), { bypassed: true, viaProxy: false });
  });
});

describe('forward-proxy: CA + certificate minting', () => {
  it('generates a persistent CA and leaf certs that verify + hostname-match', () => {
    const dir = tmpCaDir();
    const ca = ensureCa(dir);
    assert.ok(fs.existsSync(path.join(dir, 'ca.pem')));
    assert.ok(fs.existsSync(path.join(dir, 'ca-key.pem')));

    const minter = new CertMinter(ca);
    const minted = minter.get('api.example.com');
    const x509 = new crypto.X509Certificate(minted.cert);
    const caX509 = new crypto.X509Certificate(ca.caCertPem);
    assert.equal(x509.verify(caX509.publicKey), true, 'leaf must verify against the CA');
    assert.equal(x509.checkHost('api.example.com'), 'api.example.com');
    assert.notEqual(x509.checkHost('other.example.com'), 'other.example.com');

    // Cache: same cert returned for the same host
    assert.equal(minter.get('api.example.com').cert, minted.cert);

    // Reload from disk — same CA material
    const ca2 = ensureCa(dir);
    assert.equal(ca2.caCertPem, ca.caCertPem);
  });
});

describe('forward-proxy: full MITM chain', () => {
  it('CONNECT → MITM → inner http → intercept handler sees the request', async () => {
    const dir = tmpCaDir();
    let seen: { method?: string; url?: string; host?: string } = {};
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: dir,
      intercept: async (req, res) => {
        seen = { method: req.method, url: req.url, host: req.headers.host };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
    });

    const sock = await connectViaProxy(handle.port, 'mitm.test', 443);
    const tlsSock = await tlsOver(sock, 'mitm.test', handle.caCertPem);
    const resp = await httpRequest(tlsSock, 'mitm.test', 'POST', '/v1/chat/completions', '{"x":1}');

    assert.ok(resp.includes('200 OK'), `response: ${resp}`);
    assert.ok(resp.includes('{"ok":true}'), `response: ${resp}`);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.host, 'mitm.test');

    tlsSock.destroy();
    await handle.close();
  });

  it('loopback targets are blind-tunneled — the interceptor never runs', async () => {
    const echo = net.createServer((s) => {
      s.on('data', (d) => s.write(d));
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as net.AddressInfo).port;

    let intercepted = 0;
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => {
        intercepted += 1;
        return false;
      },
    });

    const sock = await connectViaProxy(handle.port, '127.0.0.1', echoPort);
    const echoed = await new Promise<string>((resolve) => {
      sock.once('data', (d: Buffer) => resolve(d.toString()));
      sock.write('ping');
    });
    assert.equal(echoed, 'ping');
    assert.equal(intercepted, 0);

    sock.destroy();
    echo.close();
    await handle.close();
  });
});

describe('forward-proxy: LLM protocol interceptor', () => {
  it('chat wire hit → orchestrator → JSON response + X-OCR headers', async () => {
    const calls: any[] = [];
    const stub = {
      process: async (request: any, ctx: any) => {
        calls.push({ request, ctx });
        return {
          response: {
            id: 'mock-cmpl',
            object: 'chat.completion',
            created: 1,
            model: 'mock-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
          tierUsed: 'lite',
          modelUsed: 'mock-1',
          fallbackOccurred: false,
          sessionId: 'sess-1',
          traceId: 'trace-1',
          latencyMs: 5,
        };
      },
    } as any;

    const intercept = createProxyInterceptor(stub);
    const srv = http.createServer((req, res) => {
      void intercept(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('passthrough');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;

    // 1) LLM request → intercepted
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.choices[0].message.content, 'hi');
    assert.equal(res.headers.get('x-ocr-model'), 'mock-1');
    assert.equal(res.headers.get('x-ocr-tier'), 'lite');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.wire, 'chat');

    // 2) non-LLM path → not intercepted (transparent forward territory)
    const res2 = await fetch(`http://127.0.0.1:${port}/some/other/api`, { method: 'POST', body: 'x' });
    assert.equal(res2.status, 404);
    assert.equal(await res2.text(), 'passthrough');
    assert.equal(calls.length, 1);

    // 3) streaming chat → SSE with [DONE]
    const res3 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await res3.text();
    assert.ok(text.includes('data: '), text);
    assert.ok(text.includes('[DONE]'), text);

    // 4) anthropic wire → converted to anthropic message shape
    const res4 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res4.status, 200);
    const body4: any = await res4.json();
    assert.equal(body4.type, 'message');
    assert.equal(body4.content[0].text, 'hi');

    srv.close();
  });

  it('MITM leg records the ORIGINAL request line/headers into the capture exchange', async () => {
    const calls: any[] = [];
    const finalized: any[] = [];
    const stub = {
      process: async (request: any, ctx: any) => {
        calls.push(ctx);
        // Mirror the real orchestrator's capture branch: hand the exchange
        // context back through onClientExchange so the interceptor wires the
        // response finalization.
        ctx.onClientExchange?.({
          recorder: {
            recordEvent: (ev: any) => finalized.push(ev),
            isEnabled: () => true,
          },
          spanId: 'span-1',
          traceId: 'trace-1',
          pending: {
            sessionId: 'sess-1',
            model: 'auto',
            requestWire: { requestLine: 'POST /v1/chat/completions HTTP/1.1' },
            responded: false,
          },
        });
        return {
          response: {
            id: 'm', object: 'chat.completion', created: 1, model: 'mock-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
          tierUsed: 'lite', modelUsed: 'mock-1', fallbackOccurred: false,
          sessionId: 'sess-1', traceId: 'trace-1', latencyMs: 1,
        };
      },
    } as any;

    const intercept = createProxyInterceptor(stub);
    const srv = http.createServer((req, res) => {
      void intercept(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('passthrough');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'opencode/2.0.15/cli' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    // Let the 'finish' event fire on the server response.
    await new Promise((r) => setTimeout(r, 20));

    // Request side: the ORIGINAL line + headers reach the capture context.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].clientRequest.method, 'POST');
    assert.ok(calls[0].clientRequest.url.includes('/v1/chat/completions'));
    assert.equal(calls[0].clientRequest.headers['user-agent'], 'opencode/2.0.15/cli');

    // Response side: the 'finish' finalization emitted a paired response event.
    assert.ok(finalized.length >= 1);
    const responseEvent = finalized.find((e) => e.phase === 'response');
    assert.ok(responseEvent, 'gateway-response event emitted');
    assert.equal(responseEvent.wire.status, 200);
    assert.equal(responseEvent.wire.requestLine, 'POST /v1/chat/completions HTTP/1.1');
    assert.ok(responseEvent.wire.responseBody.includes('ok'));
    // Normal completion must NOT synthesize the client-abort 499 (writableEnded).
    assert.ok(!finalized.some((e) => e.phase === 'response' && e.wire.status === 499));

    srv.close();
  });

  it('chat-intercept disk capture REDACTS authorization + bare-key headers end-to-end', async () => {
    // F1 (security P2-1/P2-3): the MITM leg's ORIGINAL request headers reach
    // the capture through the REAL orchestrator's sanitizer — header NAMES
    // survive, credential-shaped VALUES must persist as [REDACTED] on disk.
    // `key:` (no hyphen, no prefix) pins the DENY_HEADER_SUBSTRINGS
    // additions; `authorization` pins the pre-existing rule on this e2e path.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-redact-'));
    const config = loadConfig();
    config.requestCapture = {
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 64,
      maxBodyBytes: 65536,
    };
    const registry = new ProviderRegistry(config, true); // mockMode — no real upstream dial
    const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());

    const intercept = createProxyInterceptor(orchestrator);
    const srv = http.createServer((req, res) => {
      void intercept(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('passthrough');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;

    const marker = `FP-REDACT-${Date.now()}`;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-real-upstream-secret',
        key: 'bare-key-secret',
      },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: marker }] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    // Poll the JSONL archive (<dir>/<date>/<session>.jsonl) for this turn's
    // client REQUEST event — writes are async-persisted by the recorder.
    const readAllEvents = (): any[] => {
      const out: any[] = [];
      if (!fs.existsSync(tmp)) return out;
      for (const day of fs.readdirSync(tmp)) {
        const dayDir = path.join(tmp, day);
        if (!fs.statSync(dayDir).isDirectory()) continue;
        for (const f of fs.readdirSync(dayDir)) {
          for (const line of fs.readFileSync(path.join(dayDir, f), 'utf8').split('\n').filter(Boolean)) {
            out.push(JSON.parse(line));
          }
        }
      }
      return out;
    };
    let requestEvent: any;
    const deadline = Date.now() + 2500;
    while (!requestEvent && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      requestEvent = readAllEvents().find(
        (ev) =>
          ev.eventType === 'http-exchange' &&
          ev.direction === 'client' &&
          ev.phase === 'request' &&
          String(ev.wire?.requestBody ?? '').includes(marker)
      );
    }
    assert.ok(requestEvent, 'client request event landed on disk');

    const h = requestEvent.wire.requestHeaders;
    assert.equal(h.authorization, '[REDACTED]', 'authorization value redacted in the MITM capture');
    assert.equal(h.key, '[REDACTED]', 'bare `key` header redacted (A1 deny-list addition)');
    assert.equal(h['content-type'], 'application/json', 'non-credential header passes through untouched');
    // Raw secrets must be nowhere in the archive (any event, any file).
    const all = readAllEvents().map((ev) => JSON.stringify(ev)).join('\n');
    assert.ok(!all.includes('sk-real-upstream-secret'), 'upstream secret never persists');
    assert.ok(!all.includes('bare-key-secret'), 'bare-key value never persists');

    srv.close();
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('MITM leg synthesizes a 499 capture when the socket died before the response', async () => {
    // NOTE on fidelity: a real client abort AFTER the body was fully received
    // is UNDETECTABLE on Bun — no req 'aborted' / socket 'close' fires and
    // socket.destroyed stays false (verified with a minimal repro). The 499
    // branch is therefore exercised by explicitly destroying the socket (the
    // state Node's runtime produces on abort), which is the same code path
    // finalizeCapture evaluates. `req.on('aborted')` remains wired for Node
    // runtimes where the event is reliable.
    const finalized: any[] = [];
    let heldRes: http.ServerResponse | null = null;
    let releaseProcess: (() => void) | undefined;
    const stub = {
      process: async (request: any, ctx: any) => {
        ctx.onClientExchange?.({
          recorder: { recordEvent: (ev: any) => finalized.push(ev), isEnabled: () => true },
          spanId: 'span-9',
          traceId: 'trace-9',
          pending: {
            sessionId: 'sess-9',
            model: 'auto',
            requestWire: { requestLine: 'POST /v1/chat/completions HTTP/1.1' },
            responded: false,
          },
        });
        // Hold the handler open; the test kills the socket mid-flight.
        await new Promise<void>((r) => (releaseProcess = r));
        return {
          response: {
            id: 'm', object: 'chat.completion', created: 1, model: 'mock-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'never' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
          tierUsed: 'lite', modelUsed: 'mock-1', fallbackOccurred: false,
          sessionId: 'sess-9', traceId: 'trace-9', latencyMs: 1,
        };
      },
    } as any;

    const intercept = createProxyInterceptor(stub);
    const srv = http.createServer((req, res) => {
      heldRes = res;
      void intercept(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('passthrough');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;

    const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    }).catch(() => {});
    // Wait until the handler is holding, then kill the socket mid-flight —
    // the state a real client abort produces under Node.
    await new Promise((r) => setTimeout(r, 30));
    heldRes?.socket?.destroy();
    releaseProcess?.();
    await new Promise((r) => setTimeout(r, 20));

    const abortEvent = finalized.find((e) => e.phase === 'response' && e.wire.status === 499);
    assert.ok(abortEvent, 'synthetic 499 response event emitted when socket destroyed');
    assert.equal(abortEvent.wire.requestLine, 'POST /v1/chat/completions HTTP/1.1');
    // Exactly ONE response event — the dead-socket finalize must not
    // double-emit after the 499 synthesis.
    assert.equal(finalized.filter((e) => e.phase === 'response').length, 1);

    srv.close();
  });

  // ===== step-3c ADDITIVE cells (the four cases above are frozen) =====
  // The MITM leg now dispatches through the SAME surfaces pipeline as the
  // Fastify routes, which brings the approved convergences (contract §4 C-1
  // / C-2) and the per-wire encodings that only land via dispatchSurface.

  interface MitmHarness {
    port: number;
    close: () => void;
    calls: Array<{ request: any; ctx: any }>;
  }

  async function mitmHarness(
    processImpl: (request: any, ctx: any) => Promise<any>
  ): Promise<MitmHarness> {
    const calls: Array<{ request: any; ctx: any }> = [];
    const stub = {
      process: async (request: any, ctx: any) => {
        calls.push({ request, ctx });
        return processImpl(request, ctx);
      },
    } as any;
    const intercept = createProxyInterceptor(stub);
    const srv = http.createServer((req, res) => {
      void intercept(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('passthrough');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    return { port, close: () => srv.close(), calls };
  }

  const mitmChatCompletion = (content: string) => ({
    response: {
      id: 'mock-cmpl', object: 'chat.completion', created: 1, model: 'mock-1',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    tierUsed: 'lite', modelUsed: 'mock-1', fallbackOccurred: false,
    sessionId: 'sess-h', traceId: 'trace-h', latencyMs: 1,
  });

  it('MITM anthropic stream: full message_start…message_stop frame sequence', async () => {
    const h = await mitmHarness(async () => mitmChatCompletion('hi'));
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const text = await res.text();
    for (const frame of [
      'event: message_start',
      'event: content_block_start',
      'event: content_block_delta',
      'event: content_block_stop',
      'event: message_delta',
      'event: message_stop',
    ]) {
      assert.ok(text.includes(frame), `missing ${frame} in ${text.slice(0, 200)}`);
    }
    // R-5 frozen posture: no CORS/Connection headers on the MITM SSE wire.
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    h.close();
  });

  it('MITM responses wire: create → previous_response_id roundtrip + stream (C-2)', async () => {
    const stamp = Date.now();
    const h = await mitmHarness(async () => mitmChatCompletion('ok'));

    const t1 = await fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', input: `RESP-FIRST-${stamp}` }),
    });
    assert.equal(t1.status, 200);
    const j1: any = await t1.json();
    assert.match(j1.id, /^resp_/);
    assert.equal(j1.object, 'response');
    assert.equal(j1.output[0].content[0].text, 'ok');

    // The RespStore append ran on the MITM leg (surface.afterResult) — the
    // continuation resolves instead of the old "Invalid request: input is
    // required"-style rejection the pre-pipeline interceptor produced.
    const t2 = await fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', previous_response_id: j1.id, input: `RESP-SECOND-${stamp}` }),
    });
    assert.equal(t2.status, 200, 'previous_response_id resolves — shared RespStore on MITM too');
    const history: any[] = h.calls[1].request.messages;
    assert.ok(
      history.some((m) => String(m.content || '').includes(`RESP-FIRST-${stamp}`)),
      'rebuilt history carries turn 1'
    );
    assert.ok(
      history.some((m) => String(m.content || '').includes(`RESP-SECOND-${stamp}`)),
      'delta carries turn 2'
    );

    const t3 = await fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: true, input: `RESP-STREAM-${stamp}` }),
    });
    assert.equal(t3.status, 200);
    const text = await t3.text();
    assert.ok(text.includes('response.created'));
    assert.ok(text.includes('response.output_text.delta'));
    assert.ok(text.includes('response.completed'));
    h.close();
  });

  it('MITM execution error maps per-surface: bad variant id → 404 OpenAI envelope (C-1)', async () => {
    const h = await mitmHarness(async () => {
      throw Object.assign(new Error("Model 'nonexistent#badvariant' not found."), { statusCode: 404 });
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nonexistent#badvariant', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // Pre-flip MITM always answered 500/api_error; the pipeline maps the
    // tagged status through the chat surface (400,600) → pass-through.
    assert.equal(res.status, 404);
    const j: any = await res.json();
    assert.equal(j.error.type, 'invalid_request_error');
    assert.match(j.error.message, /not found/);
    h.close();
  });
});

describe('forward-proxy: over-the-wire routing (interceptor + MITM combined)', () => {
  it('a proxied client POST /v1/chat/completions is routed through the orchestrator', async () => {
    const stub = {
      process: async () => ({
        response: {
          id: 'mock-cmpl-2',
          object: 'chat.completion',
          created: 1,
          model: 'mock-2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
        tierUsed: 'plus',
        modelUsed: 'mock-2',
        fallbackOccurred: false,
        sessionId: 'sess-2',
        traceId: 'trace-2',
        latencyMs: 9,
      }),
    } as any;

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: createProxyInterceptor(stub),
    });

    const sock = await connectViaProxy(handle.port, 'llm.example.com', 443);
    const tlsSock = await tlsOver(sock, 'llm.example.com', handle.caCertPem);
    const resp = await httpRequest(
      tlsSock,
      'llm.example.com',
      'POST',
      '/v1/chat/completions',
      JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    );

    assert.ok(resp.includes('200 OK'), resp);
    assert.ok(resp.toLowerCase().includes('x-ocr-model: mock-2'), resp);
    assert.ok(resp.toLowerCase().includes('x-ocr-tier: plus'), resp);
    assert.ok(resp.includes('"content":"hi"'), resp);

    tlsSock.destroy();
    await handle.close();
  });
});

describe('forward-proxy: outbound-proxy transit (per-host viaProxy)', () => {
  it('object entries with viaProxy tunnel through the proxy; bare strings stay direct', async () => {
    // Fake echo target (stands in for the real blocked host)
    const echo = net.createServer((s) => {
      s.on('data', (d) => s.write(d));
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as net.AddressInfo).port;

    // Fake CONNECT proxy: records the CONNECT line, tunnels to the echo server
    const proxyConnects: string[] = [];
    const fakeProxy = net.createServer((client) => {
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        client.removeListener('data', onData);
        proxyConnects.push(buf.split('\r\n')[0]);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const up = net.connect(echoPort, '127.0.0.1');
        up.on('connect', () => {
          const rest = buf.slice(buf.indexOf('\r\n\r\n') + 4);
          if (rest) up.write(Buffer.from(rest, 'latin1'));
          client.pipe(up);
          up.pipe(client);
        });
        up.on('error', () => client.destroy());
      };
      client.on('data', onData);
      client.on('error', () => {});
    });
    await new Promise<void>((r) => fakeProxy.listen(0, '127.0.0.1', () => r()));
    const proxyPort = (fakeProxy.address() as net.AddressInfo).port;

    const { initProxyConfig } = await import('../src/utils/proxy.js');
    initProxyConfig({ enabled: true, url: `http://127.0.0.1:${proxyPort}` });
    try {
      // 1) Object entry viaProxy:true → tunnel egresses through the outbound proxy
      const h1 = await createForwardProxyServer({
        port: 0,
        host: '127.0.0.1',
        caDir: tmpCaDir(),
        bypassHosts: [{ host: 'blocked.example', viaProxy: true }],
        intercept: async () => false,
      });
      const s1 = await connectViaProxy(h1.port, 'blocked.example', 443);
      const echoed = await new Promise<string>((resolve) => {
        s1.once('data', (d: Buffer) => resolve(d.toString()));
        s1.write('ping-through-proxy');
      });
      assert.equal(echoed, 'ping-through-proxy');
      assert.ok(
        proxyConnects.some((l) => l.includes('blocked.example:443')),
        `expected a CONNECT for blocked.example:443, got: ${proxyConnects.join(' | ')}`
      );
      s1.destroy();
      await h1.close();

      // 2) Bare string entry → tunnel stays DIRECT even with the global flag on
      const before = proxyConnects.length;
      const h2 = await createForwardProxyServer({
        port: 0,
        host: '127.0.0.1',
        caDir: tmpCaDir(),
        bypassHosts: ['blocked.example'],
        viaOutboundProxy: true,
        intercept: async () => false,
      });
      const s2 = await connectViaProxy(h2.port, 'blocked.example', 443);
      await new Promise<void>((resolve) => {
        s2.on('close', () => resolve());
        s2.on('error', () => resolve());
        s2.write('x');
        setTimeout(resolve, 5000);
      });
      assert.equal(
        proxyConnects.length,
        before,
        'bare-string bypass entries must NOT egress via the outbound proxy'
      );
      await h2.close();
    } finally {
      initProxyConfig(undefined);
      fakeProxy.close();
      echo.close();
    }
  });
});