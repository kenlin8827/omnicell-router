import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import {
  chatSurface,
} from '../../src/surfaces/chat.js';
import {
  readRequestBody,
  sendPreDispatchError,
} from '../../src/surfaces/transport-node-http.js';
import { loadConfig } from '../../src/config/index.js';
import { createServer } from '../../src/server.js';
import { ADMIN_MAX_BODY_BYTES, GATEWAY_MAX_BODY_BYTES } from '../../src/config/defaults.js';
import { IMPORT_BODY_LIMIT_BYTES } from '../../src/config/env-archive.js';
import {
  createBodyDecompressor,
  decompressBody,
  BodyAdmissionError,
  formatByteLimit,
  isBodyAdmissionError,
  parseJsonBody,
  preflightBodyAdmission,
  settleContinuationExpectation,
  requestContentEncoding,
  configureBodyLimits,
  type ContinueAdmissionRoute,
} from '../../src/surfaces/body-admission.js';
import { filterHeaders } from '../../src/forward-proxy/egress.js';

/**
 * Request-body admission policy — ONE implementation shared by the native
 * (Fastify) and MITM (raw node:http) legs, plus the admin plane.
 *
 * WHY THIS EXISTS: a production gateway is judged by what it does at the edges
 * of its limits, and every one of these behaviours used to be either missing or
 * leg-specific: `Content-Encoding` was never decoded (so a gzipped context paid
 * compressed bytes against the cap and then died in JSON.parse as a misleading
 * 400), an encoding we cannot decode was silently mis-reported as a malformed
 * body, the cap had two different messages depending on the leg, an admin POST
 * over the limit answered with Fastify's default `{error: "Payload Too Large"}`
 * string envelope, and a rejection left no trace in the log.
 *
 * The HTTP-level cases below are driven through a raw socket rather than
 * `fetch` because fetch transparently decompresses `Content-Encoding` on the
 * response and refuses to set some of these headers — the request under test
 * must be byte-exact.
 */
const TEST_KEY = 'sk-ocr-bodyadmission-test';

describe('body-admission policy', () => {
  const config = loadConfig();
  config.host = '127.0.0.1';
  config.webAuth = { enabled: false };
  config.apiKeys = [
    {
      id: 'key-bodyadmission-test',
      name: 'body-admission.test fixture',
      key: TEST_KEY,
      role: 'user',
      enabled: true,
      createdAt: new Date().toISOString(),
    },
  ];
  const { app } = createServer(config, true); // mockMode = true
  let port = 0;

  before(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  after(async () => {
    await app.close();
  });

  /** Send a byte-exact request and return the status line, headers and body. */
  const rawRequest = (
    path: string,
    headers: Record<string, string>,
    body: Buffer | string
  ): Promise<{ status: number; json: any; text: string }> =>
    new Promise((resolve, reject) => {
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      // A caller-supplied header REPLACES its default rather than duplicating it:
      // two `content-type` lines reach the server joined (so the media-type case
      // would test the wrong string) and two `content-length` lines make Node
      // reject the request outright — the case never reaches the route at all.
      const overridden = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
      const lines = [
        `POST ${path} HTTP/1.1`,
        `host: 127.0.0.1:${port}`,
        `authorization: Bearer ${TEST_KEY}`,
        ...(overridden.has('content-type') ? [] : ['content-type: application/json']),
        // Without this the server keeps the connection open after answering and
        // the reader below never sees `end`.
        'connection: close',
        ...(overridden.has('content-length') ? [] : [`content-length: ${payload.length}`]),
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ].join('\r\n');
      // Written in two parts on purpose: `lines + payload` would stringify the
      // Buffer as UTF-8 and corrupt a binary (gzip/brotli) body.
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(lines);
        socket.write(payload);
      });
      const chunks: Buffer[] = [];
      // Resolve on a COMPLETE response, not on `end`: when the framework rejects
      // a body mid-upload (the inflated-bomb path) it answers and then leaves the
      // socket open, so waiting for FIN would hang the case that matters most.
      const settle = () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const split = text.indexOf('\r\n\r\n');
        if (split === -1) return false;
        const head = text.slice(0, text.indexOf('\r\n'));
        const status = Number(head.split(' ')[1]);
        const raw = text.slice(split + 4);
        const declared = Number(/content-length: *(\d+)/i.exec(text.slice(0, split))?.[1] ?? NaN);
        if (!Number.isNaN(declared) && Buffer.byteLength(raw) < declared) return false;
        // Chunked responses carry the terminal 0-length frame after the JSON;
        // parse from the first brace to the last one.
        const start = raw.indexOf('{');
        let json: any = null;
        if (start !== -1) {
          const end = raw.lastIndexOf('}');
          try {
            json = JSON.parse(raw.slice(start, end + 1));
          } catch {}
        }
        socket.destroy();
        resolve({ status, json, text: raw });
        return true;
      };
      socket.on('data', (c) => {
        chunks.push(c as Buffer);
        settle();
      });
      socket.on('close', () => {
        if (!settle()) resolve({ status: 0, json: null, text: '' });
      });
      socket.on('error', () => {
        if (!settle()) resolve({ status: 0, json: null, text: '' });
      });
      socket.setTimeout(15000, () => socket.destroy(new Error('raw request timed out')));
    });

  const chatBody = (bytes: number): string =>
    JSON.stringify({
      model: 'auto',
      messages: [{ role: 'system', content: 'a'.repeat(bytes) }, { role: 'user', content: 'hi' }],
    });

  /**
   * The same byte-exact request, but returning the RAW response: the final status
   * line, its header fields, and every interim status line that preceded it. Two
   * of the RFC rules under test live in bytes the parsed body hides — a refusal
   * must advertise the right codings (12.5.3) or media types (15.5.16), and a
   * `100 (Continue)` that should never have been sent (10.1.1) is only visible as
   * an interim line. `body` is optional so a case can declare a length and never
   * upload it, which is exactly what 10.1.1 is about.
   */
  const rawExchange = (
    path: string,
    headers: Record<string, string>,
    body?: Buffer | string
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    interim: number[];
    json: any;
    raw: string;
  }> =>
    new Promise((resolve) => {
      const payload =
        body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      const overridden = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
      const lines = [
        `POST ${path} HTTP/1.1`,
        `host: 127.0.0.1:${port}`,
        `authorization: Bearer ${TEST_KEY}`,
        ...(overridden.has('content-type') ? [] : ['content-type: application/json']),
        'connection: close',
        ...(payload !== null && !overridden.has('content-length')
          ? [`content-length: ${payload.length}`]
          : []),
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ].join('\r\n');
      const chunks: Buffer[] = [];
      const settle = (forced: boolean) => {
        const all = Buffer.concat(chunks).toString('utf8');
        const interim: number[] = [];
        let cursor = 0;
        for (;;) {
          const split = all.indexOf('\r\n\r\n', cursor);
          if (split === -1) {
            if (forced) resolve({ status: 0, headers: {}, interim, json: null, raw: all });
            return true;
          }
          const block = all.slice(cursor, split);
          const status = Number(block.split(' ')[1]);
          if (status >= 100 && status < 200) {
            interim.push(status);
            cursor = split + 4;
            continue;
          }
          const fields: Record<string, string> = {};
          for (const line of block.split('\r\n').slice(1)) {
            const colon = line.indexOf(':');
            if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
          const rest = all.slice(split + 4);
          const declared = Number(fields['content-length'] ?? NaN);
          if (!forced) {
            if (!Number.isNaN(declared) && Buffer.byteLength(rest) < declared) return false;
            // Chunked: wait for the terminal frame (or for `close`).
            if (Number.isNaN(declared) && !/\r\n0\r\n/i.test(rest) && !rest.trimEnd().endsWith('}')) {
              return false;
            }
          }
          let json: any = null;
          const start = rest.indexOf('{');
          const end = rest.lastIndexOf('}');
          if (start !== -1 && end > start) {
            try {
              json = JSON.parse(rest.slice(start, end + 1));
            } catch {}
          }
          resolve({ status, headers: fields, interim, json, raw: rest });
          return true;
        }
      };
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(lines);
        // An `Expect: 100-continue` client would wait for the interim response
        // before uploading; these cases are about the decision made from the
        // headers, so the body (when given) goes out immediately instead — a
        // server that refuses late still refuses, just wastefully.
        if (payload) socket.write(payload);
      });
      socket.on('data', (c) => {
        chunks.push(c as Buffer);
        settle(false);
      });
      socket.on('close', () => settle(true));
      socket.on('error', () => settle(true));
      socket.setTimeout(15000, () => socket.destroy());
    });

  describe('native leg — Content-Encoding', () => {
    it('refuses a gzip body whose INFLATED size is over the cap', async () => {
      // ~34 MiB of JSON compresses to a few KB, so the wire size is far under
      // the cap while the decompressed size is over it. This is the
      // compressed-bomb shape: the admission ceiling must apply to what the
      // model would actually receive.
      const gz = zlib.gzipSync(Buffer.from(chatBody(34 * 1024 * 1024), 'utf8'));
      assert.ok(gz.length < 1024 * 1024, `bomb fixture must be small on the wire: ${gz.length}`);
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-encoding': 'gzip' },
        gz
      );
      assert.equal(status, 413, JSON.stringify(json));
      assert.equal(typeof json?.error, 'object', JSON.stringify(json));
      assert.match(String(json.error.message), /32 MiB/);
      assert.equal(json.error.code, 'payload_too_large');
    });

    it('admits a gzip body under the cap', async () => {
      const gz = zlib.gzipSync(Buffer.from(chatBody(2 * 1024 * 1024), 'utf8'));
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-encoding': 'gzip' },
        gz
      );
      assert.notEqual(status, 413, JSON.stringify(json));
      assert.notEqual(status, 400, JSON.stringify(json));
    });

    it('admits a brotli body under the cap', async () => {
      const br = zlib.brotliCompressSync(Buffer.from(chatBody(2 * 1024 * 1024), 'utf8'));
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-encoding': 'br' },
        br
      );
      assert.notEqual(status, 413, JSON.stringify(json));
      assert.notEqual(status, 400, JSON.stringify(json));
    });

    it('answers 415 for an encoding it cannot decode, instead of a misleading 400', async () => {
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-encoding': 'zstd' },
        Buffer.from(chatBody(1024), 'utf8')
      );
      assert.equal(status, 415, JSON.stringify(json));
      assert.equal(typeof json?.error, 'object', JSON.stringify(json));
      assert.equal(json.error.code, 'unsupported_content_encoding');
      assert.match(String(json.error.message), /zstd/);
    });

    it('answers 415 for an unknown encoding token as well (never a silent passthrough)', async () => {
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-encoding': 'weird-thing' },
        Buffer.from('{"model":"auto","messages":[{"role":"user","content":"hi"}]}', 'utf8')
      );
      assert.equal(status, 415, JSON.stringify(json));
      assert.match(String(json?.error?.message), /weird-thing/);
    });
  });

  describe('media type — one policy for both legs', () => {
    it('refuses a declared non-JSON type with 415 in the surface envelope', async () => {
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-type': 'application/x-www-form-urlencoded' },
        'model=auto&messages=[]'
      );
      assert.equal(status, 415, JSON.stringify(json));
      assert.equal(typeof json?.error, 'object', JSON.stringify(json));
      assert.equal(json.error.code, 'unsupported_media_type');
      assert.match(String(json.error.message), /x-www-form-urlencoded/);
    });

    it('refuses a missing Content-Type the same way (no silent asymmetry)', async () => {
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-type': '' },
        chatBody(64)
      );
      assert.equal(status, 415, JSON.stringify(json));
      assert.equal(json?.error?.code, 'unsupported_media_type');
    });

    it('accepts a valid body declared text/plain, like the MITM leg does', async () => {
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-type': 'text/plain' },
        chatBody(64)
      );
      // Before this pass Fastify handed the handler a raw STRING and the pipeline
      // answered `"messages" array is required` for a perfectly good body.
      assert.notEqual(json?.error?.message, '"messages" array is required', JSON.stringify(json));
      assert.ok(status === 200 || status === 502, `unexpected ${status}: ${JSON.stringify(json)}`);
    });

    it('reports a text/plain body that is not JSON as invalid_json_body, not a schema error', async () => {
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-type': 'text/plain' },
        'hello, not json at all'
      );
      assert.equal(status, 400, JSON.stringify(json));
      assert.equal(json?.error?.code, 'invalid_json_body');
    });

    it('answers a body shorter than its declared length as truncated JSON', async () => {
      // The opposite case — declaring MORE than you send — gets no answer at all:
      // Node and Bun both abort a request whose body ends before `Content-Length`
      // is satisfied, so Fastify never reaches its own length check (verified on
      // both runtimes: the socket simply closes). Declaring LESS is what a real
      // truncation looks like on the wire, and the parser then hands us a
      // cut-off document, which must be a shaped 400 and never a stack leak.
      const body = chatBody(4096);
      const { status, json } = await rawRequest(
        '/v1/chat/completions',
        { 'content-length': String(Buffer.byteLength(body) - 1200) },
        body
      );
      assert.equal(status, 400, JSON.stringify(json));
      assert.equal(json?.error?.code, 'invalid_json_body', JSON.stringify(json));
      assert.equal(typeof json?.error, 'object', JSON.stringify(json));
    });
  });

  describe('admin plane', () => {
    const adminPost = async (path: string, body: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' },
        body,
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json };
    };

    it('admits an admin body above the old 1 MiB framework default', async () => {
      const { status, json } = await adminPost(
        '/api/admin/config/raw',
        JSON.stringify({ yaml: '#'.repeat(2 * 1024 * 1024) })
      );
      assert.notEqual(status, 413, `2 MiB admin body must not be rejected: ${JSON.stringify(json)}`);
    });

    it('rejects past ADMIN_MAX_BODY_BYTES in the admin envelope, naming the limit', async () => {
      const body = JSON.stringify({ yaml: '#'.repeat(ADMIN_MAX_BODY_BYTES + 64 * 1024) });
      const { status, json } = await adminPost('/api/admin/config/raw', body);
      assert.equal(status, 413, JSON.stringify(json));
      // The admin plane's error key is a STRING message — never the framework
      // default whose `error` is the reason phrase, and never the surface
      // envelope's object shape. frontend/src/lib/api.ts:3480 reads `err.message`.
      assert.equal(typeof json?.error, 'undefined', JSON.stringify(json));
      assert.equal(json.success, false);
      assert.match(String(json.message), /8 MiB/);
    });
  });

  describe('shared helpers (the MITM leg calls these directly)', () => {
    it('formats byte limits as MiB', () => {
      assert.equal(formatByteLimit(GATEWAY_MAX_BODY_BYTES), '32 MiB');
      assert.equal(formatByteLimit(ADMIN_MAX_BODY_BYTES), '8 MiB');
      assert.equal(formatByteLimit(512 * 1024), '512 KiB');
      assert.equal(formatByteLimit(1500), '1500 bytes');
    });

    it('reads Content-Encoding verbatim, normalised, and refuses to guess a chain', () => {
      assert.equal(requestContentEncoding({ 'content-encoding': 'GZIP' }), 'gzip');
      // A chain is NOT collapsed to its head: decoding the wrong layer would
      // produce garbage that fails as a misleading 400, so the full token is
      // returned and the caller rejects it as unsupported.
      assert.equal(requestContentEncoding({ 'content-encoding': ' gzip, identity' }), 'gzip, identity');
      assert.equal(requestContentEncoding({}), undefined);
      assert.equal(requestContentEncoding({ 'content-encoding': 'identity' }), undefined);
    });

    it('decompresses a buffered body and enforces the cap on the inflated size', () => {
      const plain = Buffer.from('{"ok":true}', 'utf8');
      const gz = zlib.gzipSync(plain);
      assert.deepEqual(decompressBody(gz, { 'content-encoding': 'gzip' }, 1024), plain);
      assert.deepEqual(decompressBody(gz, {}, 1024), gz, 'no header means no decoding');
      const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024, 7));
      assert.throws(
        () => decompressBody(bomb, { 'content-encoding': 'gzip' }, 8 * 1024),
        (err: unknown) => err instanceof BodyAdmissionError && err.statusCode === 413
      );
      assert.throws(
        () => decompressBody(Buffer.from('x'), { 'content-encoding': 'zstd' }, 1024),
        (err: unknown) => err instanceof BodyAdmissionError && err.statusCode === 415
      );
    });

    it('reports malformed JSON as a 400 with a stable code', () => {
      assert.throws(
        () => parseJsonBody('{"a":'),
        (err: unknown) =>
          err instanceof BodyAdmissionError &&
          err.statusCode === 400 &&
          err.code === 'invalid_json_body'
      );
      assert.deepEqual(parseJsonBody(Buffer.from('{"a":1}', 'utf8')), { a: 1 });
    });

    it('passes an uncompressed stream through untouched', async () => {
      const { Readable } = await import('node:stream');
      const src = Readable.from([Buffer.from('abc'), Buffer.from('defg')]);
      const out = createBodyDecompressor({}, src);
      assert.equal(out, src, 'identity encoding must not wrap the stream');
      const text = (await collect(out)).toString('utf8');
      assert.equal(text, 'abcdefg');
    });

    it('decodes a gzip stream and reports the compressed length for Content-Length matching', async () => {
      const { Readable } = await import('node:stream');
      const plain = Buffer.from('the quick brown fox'.repeat(200), 'utf8');
      const gz = zlib.gzipSync(plain);
      const out = createBodyDecompressor({ 'content-encoding': 'gzip' }, Readable.from([gz]));
      assert.deepEqual(await collect(out), plain);
      // The getter must see the compressed byte count, not the inflated one:
      // Fastify compares it against the Content-Length header.
      assert.equal((out as { receivedEncodedLength?: number }).receivedEncodedLength, gz.length);
    });

    it('forwards a source error to the decoder instead of hanging', async () => {
      const { Readable } = await import('node:stream');
      const src = new Readable({ read() {} });
      const out = createBodyDecompressor({ 'content-encoding': 'gzip' }, src);
      const settled = Promise.race([
        new Promise<string>((resolve) => out.once('error', () => resolve('decoder-error'))),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);
      src.emit('error', new Error('socket reset'));
      assert.equal(
        await settled,
        'decoder-error',
        'a source error must reach the decoder as an error, not a stall'
      );
    });

    // The continuation guard is exercised over a real socket on the native leg, but
    // the MITM leg installs the SAME function against a route table it builds itself,
    // and standing up a CA + TLS + CONNECT harness to prove that would test the
    // transport rather than the policy. So the guard is pinned here against stubs,
    // with the shape the MITM caller passes: `leg: 'mitm'` and a surface envelope.
    it('settles a header-decidable refusal for the MITM leg without a continue', () => {
      const logged: Array<Record<string, unknown>> = [];
      const route: ContinueAdmissionRoute = {
        capBytes: 4096,
        leg: 'mitm',
        errorBody: (err) => ({ error: { message: err.message, code: err.code } }),
        log: { warn: (obj) => logged.push(obj as Record<string, unknown>) },
      };
      const events: Array<{ type: string; status?: number; headers?: Record<string, string>; body?: string }> = [];
      const res = {
        writableEnded: false,
        headersSent: false,
        writeContinue: () => void events.push({ type: 'continue' }),
        writeHead: (status: number, headers: Record<string, string>) => {
          events.push({ type: 'head', status, headers });
          return res;
        },
        end: (body?: string) => void events.push({ type: 'end', body }),
      };
      const req = {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          expect: '100-continue',
          'content-type': 'application/json',
          'content-encoding': 'zstd',
          'content-length': '64',
        },
      };

      const answered = settleContinuationExpectation(
        req as never,
        res as never,
        () => route
      );
      assert.equal(answered, true, 'a refusal must be answered before dispatch');
      assert.deepEqual(
        events.map((e) => e.type),
        ['head', 'end'],
        'no continue may precede a refusal'
      );
      assert.equal(events[0].status, 415);
      assert.equal(events[0].headers?.['accept-encoding'], 'gzip, deflate, br');
      assert.equal(events[0].headers?.connection, 'close');
      assert.match(String(events.find((e) => e.type === 'end')?.body), /unsupported_content_encoding/);
      // The leg is discipline-bearing vocabulary: a MITM refusal logged as `native`
      // would send an operator to the wrong listener.
      assert.equal(logged.length, 1, JSON.stringify(logged));
      assert.equal(logged[0].leg, 'mitm');
      assert.equal(logged[0].path, '/v1/chat/completions');
      assert.equal(logged[0].contentEncoding, 'zstd');
    });

    it('hands an admissible expectation back to the caller that owns the body', () => {
      const events: string[] = [];
      const res = {
        writableEnded: false,
        headersSent: false,
        writeContinue: () => void events.push('continue'),
        writeHead: () => void events.push('head'),
        end: () => void events.push('end'),
      };
      const req = {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { expect: '100-continue', 'content-type': 'application/json', 'content-length': '64' },
      };
      assert.equal(settleContinuationExpectation(req as never, res as never, () => ({ capBytes: 4096, errorBody: () => ({}) })) as boolean, false);
      assert.deepEqual(events, ['continue']);

      // And a cap no route declared is never refused on a guess: an unknown path (an
      // admin or plugin route) keeps its continue even when the declared size dwarfs
      // the inference ceiling, because ITS registration owns the number.
      const unknown = settleContinuationExpectation(req as never, res as never, () => undefined);
      assert.equal(unknown, false);
      assert.deepEqual(events, ['continue', 'continue']);
    });
  });

  describe('negotiation headers on refusals (RFC 9110 12.5.3 / 15.5.16)', () => {
    it('advertises the accepted codings when it refuses a Content-Encoding', async () => {
      const { status, headers } = await rawExchange(
        '/v1/chat/completions',
        { 'content-encoding': 'zstd' },
        Buffer.from(chatBody(256), 'utf8')
      );
      assert.equal(status, 415, JSON.stringify(headers));
      // The client learns what to send instead of guessing. `x-gzip` is accepted
      // as a legacy alias but deliberately NOT advertised (12.5.3 lists it only
      // as an example of an alias), and `deflate` stays in the decode set while
      // 9110 dropped it, because the Anthropic SDK historically sent it.
      assert.equal(headers['accept-encoding'], 'gzip, deflate, br');
      assert.equal(headers['accept'], undefined, 'a coding refusal is not a media-type refusal');
    });

    it('advertises Accept for a media-type refusal and MUST NOT send Accept-Encoding', async () => {
      const { status, headers } = await rawExchange(
        '/v1/chat/completions',
        { 'content-type': 'application/x-www-form-urlencoded' },
        'model=auto&messages=[]'
      );
      assert.equal(status, 415, JSON.stringify(headers));
      assert.equal(headers['accept'], 'application/json');
      // RFC 9110 12.5.3: "servers that fail a request with a 415 status for reasons
      // unrelated to content codings MUST NOT include the Accept-Encoding header
      // field" (15.5.16 pairs each cause with its own field: Accept-Encoding for a
      // coding, Accept for a media type), and 15.5.14 says nothing about codings on a
      // size refusal — advertising them invites a retry that cannot succeed.
      assert.equal(headers['accept-encoding'], undefined);
    });

    it('sends neither on an oversized refusal: the body was fine, its size was not', async () => {
      const gz = zlib.gzipSync(Buffer.from(chatBody(34 * 1024 * 1024), 'utf8'));
      const { status, headers, json } = await rawExchange(
        '/v1/chat/completions',
        { 'content-encoding': 'gzip' },
        gz
      );
      assert.equal(status, 413, JSON.stringify(json));
      assert.equal(headers['accept-encoding'], undefined);
      assert.equal(headers['accept'], undefined);
      // 15.5.14 asks for Retry-After only "if the condition is temporary", and a
      // standing byte cap is not one: a retry of the same payload fails again, so
      // promising a time would be a lie.
      assert.equal(headers['retry-after'], undefined);
    });
  });

  describe('Expect: 100-continue — refusals settled by the headers', () => {
    it('refuses an undecodable content coding without promising a continue', async () => {
      // 10.1.1's first MUST branch is not size-only: a coding the gateway cannot
      // decode is fully determinable from the headers, so answering now is required
      // and the upload is pointless. 15.5.16 wants the answer to name the codings it
      // would have taken, and no 100 may be sent for a request being refused.
      const { status, headers, interim, json } = await rawExchange(
        '/v1/chat/completions',
        { expect: '100-continue', 'content-encoding': 'zstd' },
        chatBody(2048)
      );
      assert.equal(interim.length, 0, `a refusal must not be preceded by a continue: ${JSON.stringify(interim)}`);
      assert.equal(status, 415, JSON.stringify(json));
      assert.equal(json?.error?.code, 'unsupported_content_encoding');
      assert.equal(headers['accept-encoding'], 'gzip, deflate, br');
      assert.equal(headers['connection'], 'close');
    });

    it('refuses an unsupported media type on the expectation and advertises Accept only', async () => {
      const { status, headers, interim, json } = await rawExchange(
        '/v1/chat/completions',
        { expect: '100-continue', 'content-type': 'application/x-www-form-urlencoded' },
        'model=auto&messages=[]'
      );
      assert.equal(interim.length, 0, JSON.stringify(interim));
      assert.equal(status, 415, JSON.stringify(json));
      assert.equal(json?.error?.code, 'unsupported_media_type');
      assert.equal(headers['accept'], 'application/json');
      // Same 12.5.3 MUST NOT as the post-body gate; the early answer inherits it.
      assert.equal(headers['accept-encoding'], undefined);
    });
  });

  describe('Expect: 100-continue (RFC 9110 10.1.1)', () => {
    it('refuses an oversized declared body without ever sending 100', async () => {
      // Headers only: 10.1.1 says a server holding the expectation MUST send
      // either an immediate final status — when the method, target URI and
      // header fields already determine it — or an immediate 100. A declared
      // length over the cap determines the 413, and Node's default behaviour
      // (automatic 100, then read the body, then reject) is the wrong branch.
      const { status, headers, interim, json } = await rawExchange('/v1/chat/completions', {
        expect: '100-continue',
        'content-length': String(GATEWAY_MAX_BODY_BYTES + 1024),
      });
      assert.equal(interim.length, 0, `no interim continue may be sent: ${JSON.stringify(interim)}`);
      assert.equal(status, 413, JSON.stringify(json));
      assert.equal(json?.error?.code, 'payload_too_large');
      assert.match(String(json?.error?.message), /32 MiB/);
      // 10.1.1 also wants the server to say whether it will read the content:
      // we will not, and leaving the pipe open would make the arriving body
      // parse as the next pipelined request.
      assert.equal(headers['connection'], 'close');
    });

    it('continues a request it intends to serve', async () => {
      const body = chatBody(4096);
      const { status, interim, json } = await rawExchange(
        '/v1/chat/completions',
        { expect: '100-continue' },
        body
      );
      assert.deepEqual(interim, [100], 'an admissible body must get the continue');
      assert.notEqual(status, 413, JSON.stringify(json));
      assert.notEqual(status, 400, JSON.stringify(json));
    });

    it('judges an upload route by ITS OWN cap, not the inference ceiling', async () => {
      // The trap this guards: a hard-coded 32 MiB guess here would refuse a
      // 40 MiB book archive that the route is registered to accept, turning a
      // transport guard into data loss. The cap therefore comes from the
      // route's own registration, recorded by an `onRoute` hook.
      const { status, interim, json } = await rawExchange('/api/admin/environments/import', {
        expect: '100-continue',
        'content-length': String(IMPORT_BODY_LIMIT_BYTES + 1024),
      });
      assert.equal(interim.length, 0, 'over its own cap: refuse immediately');
      assert.equal(status, 413, JSON.stringify(json));
      assert.match(String(json?.message ?? json?.error?.message), /64 MiB/, JSON.stringify(json));
    });

    it('does not refuse on a cap no route declared (unknown path keeps the continue)', async () => {
      const { status, interim, json } = await rawExchange('/api/admin/no-such-route', {
        expect: '100-continue',
        'content-length': String(4 * 1024 * 1024 * 1024),
      });
      // The guard owns only paths whose registration stated a cap. This one declared
      // none, so it MUST receive the continue: refusing here would be the guard
      // inventing a limit no route agreed to, and the two upload routes (which accept
      // MORE than the inference ceiling) are exactly where that guess would cost an
      // operator a legitimate import.
      assert.equal(interim.length, 1, 'no early refusal without a declared route cap');
      // A refusal may still follow from the plane's OWN default once reading starts,
      // and its message proves whose limit fired -- the admin plane's, not the
      // inference ceiling the guard would have guessed.
      if (status === 413) {
        assert.match(String(json?.message ?? json?.error?.message), /8 MiB/, JSON.stringify(json));
      } else {
        assert.equal(status, 404, JSON.stringify(json));
      }
    });
  });

  describe('per-surface error vocabulary', () => {
    it('answers an anthropic 413 with Anthropic\'s own type, not a generic one', async () => {
      const gz = zlib.gzipSync(Buffer.from(chatBody(2 * 1024 * 1024), 'utf8'));
      const over = zlib.gzipSync(Buffer.from(chatBody(34 * 1024 * 1024), 'utf8'));
      // A valid small request on the same wire must pass, so the case below
      // proves the size rule and not a broken fixture.
      assert.notEqual((await rawExchange('/v1/messages', { 'content-encoding': 'gzip' }, gz)).status, 413);
      const { status, json } = await rawExchange('/v1/messages', { 'content-encoding': 'gzip' }, over);
      assert.equal(status, 413, JSON.stringify(json));
      // `request_too_large` is Anthropic's documented type for 413; folding it
      // into invalid_request_error teaches Claude Code to shrink the context
      // instead of resending the identical request.
      assert.equal(json?.error?.type, 'request_too_large', JSON.stringify(json));
    });

    it('keeps the chat wire on OpenAI\'s invalid_request_error for the same 413', async () => {
      const over = zlib.gzipSync(Buffer.from(chatBody(34 * 1024 * 1024), 'utf8'));
      const { status, json } = await rawExchange('/v1/chat/completions', { 'content-encoding': 'gzip' }, over);
      assert.equal(status, 413, JSON.stringify(json));
      assert.equal(json?.error?.type, 'invalid_request_error', JSON.stringify(json));
      // The machine-readable code stays our own vocabulary on every surface, so
      // the console/ledger can group by cause across wires.
      assert.equal(json?.error?.code, 'payload_too_large');
    });
  });
});

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * The two P0 findings from the RFC-alignment review, pinned at the socket level.
 * Both bugs were "the client got a reset instead of an answer": the MITM leg
 * tore its own socket down while trying to refuse an oversized body, and the
 * proxy legs' framing-level reply was (a) lost under bun, which drops a
 * synchronous write from inside a `clientError` listener, and (b) hardcoded 400
 * for a header overflow, which RFC 9110 15.5.21 answers with 431.
 */
describe('MITM-leg mid-stream overflow', () => {
  const CAP = 8 * 1024;
  let srv: http.Server | undefined;
  let port = 0;

  before(async () => {
    // Same call createServer makes at boot, only with an operator-sized ceiling
    // so the test can cross it with 24 KiB instead of 32 MiB.
    configureBodyLimits({ maxBytes: CAP });
    srv = http.createServer((req, res) => {
      void (async () => {
        try {
          const pre = preflightBodyAdmission(req.headers);
          if (pre) throw pre;
          const raw = await readRequestBody(req);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ received: raw.length }));
        } catch (err) {
          // Exactly what plugins/builtin/model-gateway.ts does on this path.
          if (!isBodyAdmissionError(err)) {
            sendPreDispatchError(res, chatSurface, 400, 'Unreadable request body');
            return;
          }
          sendPreDispatchError(res, chatSurface, err.statusCode, err.message, err.code, err.headers);
        }
      })();
    });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', () => r()));
    port = (srv!.address() as AddressInfo).port;
  });

  after(async () => {
    srv?.close();
    // Module state is process-global: a later case in this file must not inherit
    // a 8 KiB ceiling (the isolated runner gives each FILE its own process).
    configureBodyLimits(undefined);
  });

  const sendChunked = (): Promise<{ head: string; text: string; ended: boolean }> =>
    new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          `POST /v1/chat/completions HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n`
        );
        // Three chunks past the ceiling: the refusal must fire WHILE the body is
        // still arriving, which is the case a Content-Length gate cannot cover.
        const payload = 'a'.repeat(CAP);
        for (let i = 0; i < 3; i++) {
          sock.write(`${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n`);
        }
      });
      let buf = '';
      const finish = (ended: boolean): void => {
        sock.destroy();
        const split = buf.indexOf('\r\n\r\n');
        resolve({ head: buf.slice(0, split), text: split < 0 ? '' : buf.slice(split + 4), ended });
      };
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('}')) finish(true);
      });
      sock.on('close', () => finish(false));
      sock.setTimeout(5000, () => finish(false));
    });

  it('answers a body that crosses the ceiling mid-stream with a delivered 413', async () => {
    const { head, text, ended } = await sendChunked();
    assert.ok(head.startsWith('HTTP/1.1 413 '), `status line: ${JSON.stringify(head)}`);
    assert.match(head, /content-type: application\/json/i);
    assert.match(head, /connection: close/i);
    const json = JSON.parse(text) as { error?: { code?: string; message?: string } };
    assert.equal(json.error?.code, 'payload_too_large');
    assert.match(json.error?.message ?? '', /8 KiB/, JSON.stringify(json));
    // The connection is dropped AFTER the answer, never instead of it: a reset
    // with no bytes is what the client used to get.
    assert.ok(ended, 'the refused connection must be closed by the gateway');
  });
});

describe('pre-dispatch envelope across transports', () => {
  /** Minimal stand-in for the two res shapes the MITM leg actually hands us. */
  const stubRes = (isH2: boolean): { calls: Array<{ status: number; headers: Record<string, string> }>, ended: boolean, destroyed: boolean } => {
    const shape: any = {
      calls: [] as Array<{ status: number; headers: Record<string, string> }>,
      ended: false,
      destroyed: false,
      headersSent: false,
      writableEnded: false,
      writeHead(status: number, headers: Record<string, string>) {
        this.calls.push({ status, headers });
        this.headersSent = true;
        return this;
      },
      end() {
        this.ended = true;
        this.writableEnded = true;
      },
      destroySoon() {
        this.destroyed = true;
      },
    };
    if (isH2) shape.stream = {};
    return shape;
  };

  it('closes an HTTP/1 refusal with `connection: close` and flushes before closing', () => {
    const res = stubRes(false);
    sendPreDispatchError(res as unknown as http.ServerResponse, chatSurface, 413, 'too large', 'payload_too_large');
    assert.equal(res.calls[0]?.headers.connection, 'close');
    assert.ok(res.ended, 'the envelope must be flushed');
    assert.ok(res.destroyed, 'an unread body makes the connection unusable');
  });

  it('omits connection-specific fields on the http2 compatibility leg', () => {
    const res = stubRes(true);
    sendPreDispatchError(res as unknown as http.ServerResponse, chatSurface, 413, 'too large', 'payload_too_large');
    // h2 forbids `connection` (node throws ERR_HTTP2_INVALID_CONNECTION_HEADERS
    // at writeHead, which used to swallow the whole envelope on that leg).
    assert.equal(res.calls[0]?.headers.connection, undefined);
    assert.equal(res.calls[0]?.headers['connection'], undefined);
    assert.ok(res.ended && res.destroyed);
  });

  it('carries the refusal reason through the negotiation headers', () => {
    const res = stubRes(false);
    const coding = new BodyAdmissionError(415, 'unsupported_content_encoding', 'unsupported coding', {
      'accept-encoding': 'gzip, deflate, br',
    });
    sendPreDispatchError(res as unknown as http.ServerResponse, chatSurface, coding.statusCode, coding.message, coding.code, coding.headers);
    assert.equal(res.calls[0]?.headers['accept-encoding'], 'gzip, deflate, br');
    assert.ok(!/"retry-after"/i.test(JSON.stringify(res.calls[0]?.headers ?? {})), 'no Retry-After on an admission refusal');
  });
});

describe('ambiguous Content-Length (RFC 9112 6.3)', () => {
  it('refuses a duplicated or non-numeric length from the headers alone', () => {
    // Node's parser rejects a duplicated Content-Length on its own; BUN ACCEPTS
    // two identical values and hands the application an ARRAY. The gate must
    // notice, or the proxy relays framing it cannot determine (smuggle carrier).
    assert.equal(preflightBodyAdmission({ 'content-length': ['2', '2'], 'content-type': 'application/json' })?.code, 'invalid_content_length');
    assert.equal(preflightBodyAdmission({ 'content-length': '3, 3', 'content-type': 'application/json' })?.code, 'invalid_content_length');
    assert.equal(preflightBodyAdmission({ 'content-length': '12', 'content-type': 'application/json' }), undefined);
    assert.equal(preflightBodyAdmission({ 'content-type': 'application/json' }), undefined);
  });

  it('never relays ambiguous framing upstream, and drops the consumed Expect', () => {
    const strip = filterHeaders({
      'content-length': ['2', '2'],
      expect: '100-continue',
      'content-type': 'application/json',
    } as never);
    assert.equal(strip['content-length'], undefined, 'duplicate length is not relayed');
    assert.equal(strip['expect'], undefined, 'Expect is hop-by-hop (RFC 9110 7.6.1)');
    const keep = filterHeaders({ 'content-length': '1200', host: 'origin.test' } as never);
    assert.equal(keep['content-length'], '1200', 'a single well-formed length is end-to-end');
  });
});

describe('stalled request body on the MITM transport (408)', () => {
  // A real socket, a real body reader, only the idle clock shortened: this is the
  // path `plugins/builtin/model-gateway.ts` takes, so it proves the ANSWER reaches
  // the client (pause + envelope + close), not just that a promise rejects.
  const IDLE_MS = 300;
  let srv: http.Server | undefined;
  let port = 0;

  before(async () => {
    srv = http.createServer((req, res) => {
      void (async () => {
        try {
          const raw = await readRequestBody(req, IDLE_MS);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ received: raw.length }));
        } catch (err) {
          if (!isBodyAdmissionError(err)) {
            sendPreDispatchError(res, chatSurface, 400, 'Unreadable request body');
            return;
          }
          sendPreDispatchError(res, chatSurface, err.statusCode, err.message, err.code, err.headers);
        }
      })();
    });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', () => r()));
    port = (srv!.address() as AddressInfo).port;
  });

  after(async () => {
    srv?.close();
  });

  /** Declare a body, send a PREFIX of it, then stop talking. */
  const sendAndStall = (): Promise<{ head: string; text: string }> =>
    new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          `POST /v1/chat/completions HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\ncontent-length: 4096\r\n\r\n`
        );
        sock.write('{"messages":[{"role":"user","content":"half');
      });
      let buf = '';
      const finish = (): void => {
        sock.destroy();
        const split = buf.indexOf('\r\n\r\n');
        resolve({ head: buf.slice(0, split), text: split < 0 ? '' : buf.slice(split + 4) });
      };
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('}')) finish();
      });
      sock.on('close', finish);
      sock.setTimeout(6000, finish);
    });

  it('refuses a body that stops arriving, and closes the socket', async () => {
    const { head, text } = await sendAndStall();
    assert.ok(head.startsWith('HTTP/1.1 408 '), `status line: ${JSON.stringify(head)}`);
    assert.match(head, /connection: close/i);
    const json = JSON.parse(text) as { error?: { code?: string; type?: string } };
    assert.equal(json.error?.code, 'request_body_timeout', JSON.stringify(json));
    assert.equal(json.error?.type, 'invalid_request_error');
  });
});
