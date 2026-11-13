/**
 * Node.js outbound proxy fetch (ADR-0022).
 *
 * Bun's `fetch(url, { proxy })` honors an HTTP proxy, including CONNECT and
 * Proxy-Authorization. Node's global fetch (undici) ignores a `proxy` option
 * on Node 18–22, so the same call silently went direct. This module is the
 * Node path: plain HTTP uses absolute-form on the proxy; HTTPS uses the
 * existing CONNECT helper (`openViaProxy`) and then speaks HTTP/1.1 on the
 * tunneled TLS socket.
 *
 * The response body is a web stream, so SSE callers keep working. gzip,
 * deflate and brotli are decoded. Redirects (up to 5) stay on the proxy
 * unless the next hop is loopback, which is fetched directly.
 */
import http from 'node:http';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { Readable, PassThrough } from 'node:stream';
import { openViaProxy, parseProxy, upstreamServernameOption } from '../forward-proxy/egress.js';
import { isLoopbackUrl } from './proxy.js';

const MAX_REDIRECTS = 5;
const HEADER_LIMIT = 64 * 1024;
const TLS_TIMEOUT_MS = 15_000;

export interface NodeProxiedFetchOptions {
  /** Test seam. Production verifies upstream certificates. */
  rejectUnauthorized?: boolean;
}

export async function nodeProxiedFetch(
  url: string,
  init: RequestInit = {},
  proxyUrl: string,
  opts: NodeProxiedFetchOptions = {},
): Promise<Response> {
  const body = await readBody(init.body);
  return follow(url, init, body, proxyUrl, opts, 0);
}

async function follow(
  url: string,
  init: RequestInit,
  body: Buffer | undefined,
  proxyUrl: string,
  opts: NodeProxiedFetchOptions,
  redirects: number,
): Promise<Response> {
  if (isLoopbackUrl(url)) return fetch(url, { ...init, body: body ? new Uint8Array(body) : undefined });
  const target = new URL(url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = headersToRecord(init.headers);
  if (!hasHeader(headers, 'accept-encoding')) headers['accept-encoding'] = 'gzip, deflate, br';
  if (!hasHeader(headers, 'connection')) headers.connection = 'close';
  if (body && !hasHeader(headers, 'content-length')) headers['content-length'] = String(body.length);

  const res = target.protocol === 'http:'
    ? await requestHttp(target, url, method, headers, body, proxyUrl, init.signal)
    : await requestHttps(target, method, headers, body, proxyUrl, init.signal, opts.rejectUnauthorized !== false);

  if (redirects >= MAX_REDIRECTS || !isRedirect(res.status)) return res;
  const location = res.headers.get('location');
  if (!location) return res;
  await res.arrayBuffer().catch(() => undefined);
  const nextUrl = new URL(location, url).toString();
  const nextMethod = redirectMethod(method, res.status);
  const nextBody = nextMethod === 'GET' || nextMethod === 'HEAD' ? undefined : body;
  const nextInit: RequestInit = { ...init, method: nextMethod };
  return follow(nextUrl, nextInit, nextBody, proxyUrl, opts, redirects + 1);
}

function requestHttp(
  target: URL,
  absoluteUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  proxyUrl: string,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  const proxy = parseProxy(proxyUrl);
  if (!proxy) return Promise.reject(new TypeError('invalid outbound proxy url'));
  const headersOut: Record<string, string> = { ...headers, host: target.host };
  if (proxy.auth) headersOut['proxy-authorization'] = proxy.auth;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxy.host,
        port: proxy.port,
        method,
        path: absoluteUrl,
        headers: headersOut,
      },
      (incoming) => {
        resolve(incomingToResponse(incoming));
      },
    );
    bindAbort(req, signal, reject);
    req.on('error', (err) => reject(asTypeError(err)));
    if (body && body.length) req.end(body);
    else req.end();
  });
}

async function requestHttps(
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  proxyUrl: string,
  signal: AbortSignal | null | undefined,
  rejectUnauthorized: boolean,
): Promise<Response> {
  const port = Number(target.port || 443);
  const raw = await openViaProxy(proxyUrl, target.hostname, port);
  if (signal?.aborted) {
    raw.destroy();
    throw new DOMException('The operation was aborted', 'AbortError');
  }
  const onAbort = (): void => {
    raw.destroy();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let tlsSock: tls.TLSSocket;
  try {
    tlsSock = tls.connect({
      socket: raw,
      rejectUnauthorized,
      ALPNProtocols: ['http/1.1'],
      ...upstreamServernameOption(target.hostname),
    });
    raw.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        tlsSock.destroy();
        reject(new TypeError('TLS handshake timeout'));
      }, TLS_TIMEOUT_MS);
      tlsSock.once('secureConnect', () => {
        clearTimeout(timer);
        resolve();
      });
      tlsSock.once('error', (err) => {
        clearTimeout(timer);
        reject(asTypeError(err));
      });
    });
  } catch (err) {
    signal?.removeEventListener('abort', onAbort);
    raw.destroy();
    throw err;
  }
  signal?.removeEventListener('abort', onAbort);
  const path = `${target.pathname || '/'}${target.search}`;
  const head = encodeRequest(method, path, { ...headers, host: target.host });
  return readHttpResponse(tlsSock, head, body, signal);
}

function encodeRequest(method: string, path: string, headers: Record<string, string>): string {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || value === '') continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push('', '');
  return lines.join('\r\n');
}

/**
 * Write one HTTP/1.1 request on an already-connected socket and stream the
 * response. Used for the post-CONNECT TLS leg, where `http.request` cannot
 * reliably adopt a socket whose `connect` event has already fired.
 */
export function readHttpResponse(
  socket: NodeJS.ReadWriteStream & { destroy?: () => void },
  head: string,
  body: Buffer | undefined,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy?.();
      reject(err instanceof DOMException ? err : asTypeError(err));
    };
    const onAbort = (): void => fail(new DOMException('The operation was aborted', 'AbortError'));
    if (signal) {
      if (signal.aborted) return fail(new DOMException('The operation was aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const onData = (chunk: Buffer | string): void => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buf.length > HEADER_LIMIT && buf.indexOf('\r\n\r\n') < 0) {
        fail(new TypeError('proxy response headers too large'));
        return;
      }
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      socket.off('data', onData);
      signal?.removeEventListener('abort', onAbort);
      let parsed: { status: number; statusText: string; headers: Headers };
      try {
        parsed = parseHead(buf.slice(0, idx).toString('latin1'));
      } catch (err) {
        fail(err);
        return;
      }
      const rest = buf.slice(idx + 4);
      settled = true;
      resolve(streamResponse(socket, rest, parsed, signal));
    };
    socket.on('data', onData);
    socket.on('error', fail);
    socket.on('end', () => fail(new TypeError('proxy closed before response headers')));
    socket.write(head);
    if (body && body.length) socket.write(body);
  });
}

function parseHead(text: string): { status: number; statusText: string; headers: Headers } {
  const lines = text.split('\r\n');
  const match = /^HTTP\/1\.[01] (\d{3})(?:[ \t](.*))?$/.exec(lines[0] || '');
  if (!match) throw new TypeError('malformed HTTP status from upstream');
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { status: Number(match[1]), statusText: match[2] || '', headers };
}

function streamResponse(
  socket: NodeJS.ReadWriteStream & { destroy?: () => void },
  rest: Buffer,
  parsed: { status: number; statusText: string; headers: Headers },
  signal: AbortSignal | null | undefined,
): Response {
  const encoding = (parsed.headers.get('content-encoding') || '').toLowerCase();
  const chunked = (parsed.headers.get('transfer-encoding') || '').toLowerCase().includes('chunked');
  const lengthHeader = parsed.headers.get('content-length');
  const contentLength = !chunked && lengthHeader != null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  const headers = new Headers(parsed.headers);
  for (const hop of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection']) {
    headers.delete(hop);
  }
  if (chunked || encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') headers.delete('content-length');
  if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') headers.delete('content-encoding');

  const raw = new PassThrough();
  if (rest.length) raw.write(rest);
  socket.on('data', (chunk: Buffer | string) => {
    raw.write(chunk);
  });
  socket.on('end', () => raw.end());
  socket.on('error', (err: Error) => raw.destroy(err));
  if (signal) {
    const onAbort = (): void => {
      socket.destroy?.();
      raw.destroy(new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const decoded = decodeTransfer(raw, { chunked, contentLength });
  const inflated = inflate(decoded, encoding);
  const web = Readable.toWeb(inflated as Readable) as ReadableStream<Uint8Array>;
  return new Response(parsed.status === 204 || parsed.status === 304 ? null : web, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers,
  });
}

function decodeTransfer(source: PassThrough, mode: { chunked: boolean; contentLength: number | null }): Readable {
  if (!mode.chunked && mode.contentLength == null) return source;
  const out = new PassThrough();
  let pending = Buffer.alloc(0);
  let remaining = mode.contentLength ?? 0;
  let done = false;
  // Chunked state: 0 = size line, 1 = data, 2 = CRLF after data, 3 = trailers.
  let phase: 0 | 1 | 2 | 3 = 0;
  let chunkLeft = 0;

  const finish = (): void => {
    if (done) return;
    done = true;
    out.end();
  };
  const fail = (err: Error): void => {
    if (done) return;
    done = true;
    out.destroy(err);
  };

  const pump = (): void => {
    if (done) return;
    if (!mode.chunked) {
      if (pending.length) {
        const take = pending.subarray(0, remaining);
        remaining -= take.length;
        pending = pending.subarray(take.length);
        if (take.length) out.write(take);
      }
      if (remaining === 0) finish();
      return;
    }
    for (;;) {
      if (phase === 0) {
        const nl = pending.indexOf('\r\n');
        if (nl < 0) return;
        const sizeHex = pending.subarray(0, nl).toString('latin1').split(';')[0].trim();
        const size = Number.parseInt(sizeHex, 16);
        if (!Number.isFinite(size) || size < 0) return fail(new TypeError('malformed chunk size'));
        pending = pending.subarray(nl + 2);
        if (size === 0) {
          phase = 3;
          continue;
        }
        chunkLeft = size;
        phase = 1;
        continue;
      }
      if (phase === 1) {
        if (!pending.length) return;
        const take = pending.subarray(0, chunkLeft);
        chunkLeft -= take.length;
        pending = pending.subarray(take.length);
        out.write(take);
        if (chunkLeft === 0) phase = 2;
        continue;
      }
      if (phase === 2) {
        if (pending.length < 2) return;
        if (pending[0] !== 13 || pending[1] !== 10) return fail(new TypeError('malformed chunk trailer'));
        pending = pending.subarray(2);
        phase = 0;
        continue;
      }
      // The 0-chunk line's CRLF is already consumed. An empty trailer block is
      // a single CRLF; a non-empty block ends at the blank line.
      if (pending.length >= 2 && pending[0] === 13 && pending[1] === 10) {
        finish();
        return;
      }
      if (pending.indexOf('\r\n\r\n') >= 0) {
        finish();
        return;
      }
      return;
    }
  };

  source.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    pump();
  });
  source.on('end', () => {
    if (done) return;
    if (!mode.chunked && remaining === 0) finish();
    else if (!mode.chunked && mode.contentLength == null) finish();
    // A chunked body whose last chunk was the 0-chunk is complete even when
    // the peer closes without the trailer CRLF.
    else if (mode.chunked && phase === 3) finish();
    else fail(new TypeError('upstream closed before the body finished'));
  });
  source.on('error', fail);
  return out;
}

function inflate(source: Readable, encoding: string): Readable {
  if (encoding === 'gzip') return source.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return source.pipe(zlib.createInflate());
  if (encoding === 'br') return source.pipe(zlib.createBrotliDecompress());
  return source;
}

function incomingToResponse(res: http.IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'content-length' || lower === 'connection') continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.append(key, value);
  }
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
  let stream: Readable = res;
  if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
  else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
  else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
  const web = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  const status = res.statusCode || 502;
  return new Response(status === 204 || status === 304 ? null : web, {
    status,
    statusText: res.statusMessage,
    headers,
  });
}

function bindAbort(req: http.ClientRequest, signal: AbortSignal | null | undefined, reject: (err: unknown) => void): void {
  if (!signal) return;
  const abort = (): void => {
    req.destroy();
    reject(new DOMException('The operation was aborted', 'AbortError'));
  };
  if (signal.aborted) {
    abort();
    return;
  }
  signal.addEventListener('abort', abort, { once: true });
}

async function readBody(body: RequestInit['body'] | null | undefined): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      if (step.value) parts.push(step.value);
    }
    return Buffer.concat(parts);
  }
  if (typeof (body as Blob).arrayBuffer === 'function') {
    return Buffer.from(await (body as Blob).arrayBuffer());
  }
  throw new TypeError('unsupported request body');
}

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) out[key] = String(value);
  }
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const needle = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === needle);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectMethod(method: string, status: number): string {
  if (status === 303) return method === 'HEAD' ? 'HEAD' : 'GET';
  if ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD') return 'GET';
  return method;
}

function asTypeError(err: unknown): TypeError {
  if (err instanceof TypeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TypeError(message);
}
