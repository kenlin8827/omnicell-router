import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type {
  CaptureKeyIdentity,
  CaptureRecorder,
  HttpExchangeEvent,
  RawWireCapture,
  WireBody,
} from '../capture/recorder.js';
import type { ApiKeyConfig } from '../config/types.js';
import { redactProxyUrl } from '../utils/proxy.js';

/**
 * Credential-bearing header deny-list. ANY header whose name contains one of
 * these substrings (case-insensitive) has its VALUE replaced with the literal
 * string `[REDACTED]` before capture — the header NAME is kept so the
 * captured record still tells you "the request had an `x-api-key` field",
 * which is what you need to debug upstream rejection ("we got 401 because
 * you didn't send Authorization" vs "you sent the wrong key value").
 *
 * Substring match (not exact match) because vendors vary: `Authorization`,
 * `Proxy-Authorization`, `X-Api-Key`, `x-goog-api-key`, `X-Amz-Security-
 * Token`, etc. — same substring shape.
 */
const DENY_HEADER_SUBSTRINGS = [
  'authorization',
  'api-key',
  'apikey',
  'api_key',
  'x-goog-api-key',
  // Catch-all for vendor key headers outside the list above (custom
  // provider config.headers): `Ocp-Apim-Subscription-Key`,
  // `X-Functions-Key`, `X-Api-Key`, ... — any header ending in `-key` is
  // credential-shaped.
  '-key',
  'cookie',
  'set-cookie',
  'token',
  'secret',
  'password',
  'bearer',
  'signature',
  'credential',
  'x-auth',
  'proxy-auth',
  // Bare substrings (security review P2-1): credential-shaped names without
  // hyphens or known prefixes — `Key:`, `AccessKey`, custom provider
  // config.headers — must redact too. Over-matching is deliberate: a header
  // NAME containing "key"/"auth" is credential-shaped in practice, and
  // masking a rare false positive harms nothing (the name stays visible).
  'key',
  'auth',
];

/** Sentinel value written in place of a credential-bearing header value. */
export const REDACTED = '[REDACTED]';

/**
 * Pass every header through (full name preserved, lowercased), but
 * substitute any value whose name matches the deny-list. Accepts a `Headers`
 * object (fetch API) because that's what `proxiedFetch` exposes; for
 * Fastify request/reply headers, the caller should pre-flatten them via
 * `Object.fromEntries(Object.entries(raw))` so the iteration is uniform.
 */
function sanitizeHeadersForCapture(raw: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  raw.forEach((value, key) => {
    const lc = key.toLowerCase();
    if (DENY_HEADER_SUBSTRINGS.some(s => lc.includes(s))) {
      out[lc] = REDACTED;
    } else {
      out[lc] = value;
    }
  });
  return out;
}

/** Plain-object variant for Fastify header maps (already lowercased). */
function sanitizePlainHeadersForCapture(
  raw: Record<string, string | string[] | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lc = key.toLowerCase();
    const v = Array.isArray(value) ? value[0] : value;
    if (DENY_HEADER_SUBSTRINGS.some(s => lc.includes(s))) {
      out[lc] = REDACTED;
    } else {
      out[lc] = v;
    }
  }
  return out;
}

/**
 * Encode a body to the wire-capture body form. UTF-8 / JSON chat-completions
 * traffic stores as a plain string; non-UTF-8 payloads fall back to a hex
 * encoding so the field is still inspectable. `undefined` and empty inputs
 * become an empty string — the wire has a `\r\n\r\n` separator but no body
 * bytes when Content-Length is 0.
 */
function encodeWireBody(body: string | Uint8Array | undefined | null): WireBody {
  if (body === undefined || body === null || body === '') return '';
  if (typeof body === 'string') return body;
  // Binary: try UTF-8 decode first; only fall back to hex if it isn't valid.
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return decoded;
  } catch {
    return { hex: Buffer.from(body).toString('hex') };
  }
}

/** Query params whose VALUES carry credentials (?key=, ?token=, ?auth=,
 *  ?sig=, ...). Word-boundary-ish match so `monkey=` / `keywords=` /
 *  `tokenize=` don't get redacted (their values are harmless, but mangling
 *  them would corrupt the recorded request line). `apikey` is listed
 *  explicitly: the boundary trick cannot see through the compound — the 'i'
 *  before 'key' is a letter, so `(^|[^a-z])key` misses it (security review
 *  P2-2; /i also covers `apiKey`). `signature` stays covered by its own
 *  alternation, listed ahead of the added bare `sig` (verified — no double
 *  add needed). */
const QUERY_AUTH_PARAM_RE = /(^|[^a-z])(key|apikey|token|secret|signature|credential|password|auth|sig)([^a-z]|$)/i;

function redactQueryAuth(u: URL): void {
  // Defense-in-depth: auth-by-query (Google-style `?key=AIza...`) must
  // never persist raw — redact the value, keep the param name.
  for (const name of [...new Set(u.searchParams.keys())]) {
    if (QUERY_AUTH_PARAM_RE.test(name)) u.searchParams.set(name, REDACTED);
  }
}

function pathnameAndQuery(url: string): string {
  // req.url is `/path?query`. proxiedFetch sees absolute URLs. Both should
  // produce the path-with-query form for the request line.
  try {
    const u = new URL(url, 'http://ocr.local');
    redactQueryAuth(u);
    return u.pathname + (u.search || '');
  } catch {
    // Near-unreachable: WHATWG URL with a base accepts any `/path?query` —
    // raw pass-through is the inherited pre-refactor shape, kept for parity.
    return url;
  }
}

/** Absolute-form URL for the upstream request line: the origin (host) stays
 *  visible so the archive shows which provider endpoint was dialed, with
 *  auth-by-query params redacted exactly like the origin-form line. */
function absoluteFormUrl(url: string): string {
  try {
    const u = new URL(url);
    redactQueryAuth(u);
    return u.origin + u.pathname + (u.search || '');
  } catch {
    // Near-unreachable: callers pass fetch()-valid absolute URLs and WHATWG
    // URL is tolerant; raw pass-through is the inherited pre-refactor shape.
    return url;
  }
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  499: 'Client Closed Request',
};

function statusTextFor(status: number): string {
  return STATUS_TEXT[status] ?? 'Unknown';
}

/* ============================================================
 * Event-stream emission helpers (split req / resp — independent).
 * Each helper writes one JSONL line synchronously. Callers fire the
 * request event the moment the wire side is constructed (no wait for
 * the response), and the response event the moment the response bytes
 * arrive. This replaces the old turn-centric single-record model.
 * ============================================================ */

/**
 * Module-private Symbol used to stash the client exchange context on the
 * Fastify request. Using a Symbol (not a string key like `__clientExchangeCtx`)
 * makes the property:
 *   - **non-enumerable by default**: doesn't leak into JSON.stringify or
 *     Fastify's request inspection that walks own properties;
 *   - **collision-free**: no other module can read or overwrite it;
 *   - **GC-eligible**: the request holds the only reference to the context,
 *     so when Fastify releases the request, the context is reclaimed.
 */
const CLIENT_EXCHANGE_CTX = Symbol.for('ocr.clientExchangeContext');

/** Read the client exchange context off a Fastify request. */
export function getClientExchangeContext(req: FastifyRequest): ClientExchangeContext | undefined {
  return (req as any)[CLIENT_EXCHANGE_CTX];
}

/** Attach the client exchange context to a Fastify request. */
export function setClientExchangeContext(req: FastifyRequest, ctx: ClientExchangeContext): void {
  (req as any)[CLIENT_EXCHANGE_CTX] = ctx;
}

/** Opaque context carried from the handler to the transport adapter's
 *  gateway-response finalization (Fastify: terminal sends; MITM: the
 *  onClientExchange callback). */
export interface ClientExchangeContext {
  recorder: CaptureRecorder;
  /** Stable id shared by the request event AND its matching response event. */
  spanId: string;
  /** Stable id shared by all four events of one inference turn. */
  traceId: string;
  /** Filled by `emitClientRequest` and finalized by `emitGatewayResponse`. */
  pending: {
    sessionId: string;
    model: string;
    /** Deterministic conversation key (content-addressed, see HttpExchangeEvent.conversationKey). */
    conversationKey?: string;
    /** Client API-key identity resolved at request-emit time (undefined for
     *  master-key / MITM legs) — reused by the gateway-response event so both
     *  client-leg events carry the same attribution. */
    apiKey?: CaptureKeyIdentity;
    /** Request-side wire (lines + headers + body) — fully known at handler entry. */
    requestWire: RawWireCapture;
    /**
     * Response body stash, filled by the transport adapters' terminal sends
     * (whole-JSON payload in `sendJson`, accumulated chunks in the SSE
     * branches) before `emitGatewayResponse` runs at finalize. Capped at
     * GATEWAY_RESPONSE_BODY_CAP chars so a runaway stream can't exhaust
     * memory — the recorder truncates further down to maxBodyBytes.
     */
    responseBody?: string;
    /** Set once the response event has been emitted — guards against a
     *  double-emit when both the terminal send and the abort listener try
     *  to finalize. */
    responded?: boolean;
  };
}

/** Cap for the accumulated gateway response body (chars). */
const GATEWAY_RESPONSE_BODY_CAP = 1024 * 1024;

/**
 * Append a response-body chunk to the pending gateway response. Used by the
 * transport adapters (whole-JSON payload in `sendJson`, per-chunk in the SSE
 * branches). No-op once the cap is reached.
 */
export function appendGatewayResponseChunk(ctx: ClientExchangeContext, chunk: string): void {
  const cur = ctx.pending.responseBody ?? '';
  if (cur.length >= GATEWAY_RESPONSE_BODY_CAP) return;
  ctx.pending.responseBody = (cur + chunk).slice(0, GATEWAY_RESPONSE_BODY_CAP);
}

/**
 * Emit the client request event (client → gateway, request side). Called
 * by the inference handler at process() entry — at this point the
 * request side is fully known and can be emitted IMMEDIATELY (no wait
 * for the response). The returned context is attached to the Fastify
 * request (or handed to the MITM adapter via onClientExchange) so the
 * transport adapter can finalize the response event at its terminal send.
 */
/**
 * Minimal transport surface needed to record the request line + headers.
 * `FastifyRequest` satisfies it structurally; the MITM forward-proxy
 * interceptor passes an `http.IncomingMessage`-shaped object (its
 * `req.headers` carries the ORIGINAL target host — see `interceptor.ts`).
 */
export type CaptureClientRequest = {
  method: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Read the client API-key identity off an auth-processed request. The auth
 * preHandler (server.ts) attaches `validateApiKey()`'s result to
 * `req.authInfo`; master-key access and MITM tunnels (`CaptureClientRequest`
 * shape) carry no `authInfo` → undefined, leaving capture events without key
 * attribution (exactly the pre-field behavior). Only `id` + `name` are read —
 * the token value is never touched, mirroring the credential deny-list.
 */
export function captureKeyIdentity(
  req: FastifyRequest | CaptureClientRequest | undefined
): CaptureKeyIdentity | undefined {
  const keyConfig = (req as { authInfo?: { keyConfig?: ApiKeyConfig } } | undefined)?.authInfo
    ?.keyConfig;
  return keyConfig ? { id: keyConfig.id, name: keyConfig.name } : undefined;
}

export function emitClientRequest(args: {
  recorder: CaptureRecorder;
  req?: FastifyRequest | CaptureClientRequest | undefined;
  body: unknown;
  sessionId: string;
  traceId: string;
  model: string;
  conversationKey?: string;
}): ClientExchangeContext {
  const spanId = cryptoRandom();
  const apiKey = captureKeyIdentity(args.req);
  const requestLine = args.req
    ? `${args.req.method} ${pathnameAndQuery(args.req.url ?? '')} HTTP/1.1`
    : '';
  const requestHeaders = args.req
    ? sanitizePlainHeadersForCapture(args.req.headers as any)
    : {};
  const requestWire: RawWireCapture = {
    requestLine,
    requestHeaders,
    requestBody: encodeWireBody(typeof args.body === 'string' ? args.body : JSON.stringify(args.body)),
    responseLine: '',
    status: 0,
    responseHeaders: {},
    responseBody: '',
  };
  void args.recorder.recordEvent({
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'request',
    spanId,
    traceId: args.traceId,
    sessionId: args.sessionId,
    model: args.model,
    status: 'ok',
    wire: requestWire,
    ...(args.conversationKey ? { conversationKey: args.conversationKey } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  return {
    recorder: args.recorder,
    spanId,
    traceId: args.traceId,
    pending: {
      sessionId: args.sessionId,
      model: args.model,
      requestWire,
      apiKey,
      conversationKey: args.conversationKey,
    },
  };
}

/**
 * Finalize the client exchange when the gateway response is sent. Called
 * by the transport adapters (Fastify: at its terminal send; MITM: from the
 * interceptor's finalize callback) — at this point the response side is
 * fully known and emitted as an independent event. The request event was
 * already emitted synchronously at handler entry.
 */
export function emitGatewayResponse(
  ctx: ClientExchangeContext,
  reply: {
    statusCode: number;
    statusText?: string;
    statusMessage?: string;
    getHeader(name: string): unknown;
    getHeaders?(): Record<string, unknown>;
  }
): void {
  if (ctx.pending.responded) return; // both finalize paths raced — first wins
  ctx.pending.responded = true;
  // Full response header map when available (Fastify reply.getHeaders());
  // SSE branches write via reply.raw.writeHead which bypasses Fastify's
  // header map, so fall back to the raw socket's headers. Last resort:
  // content-type only (minimal reply-like objects in tests).
  let headersMap: Record<string, string> = {};
  const rawHeaders = typeof reply.getHeaders === 'function' ? reply.getHeaders() : {};
  const rawNodeHeaders =
    Object.keys(rawHeaders).length === 0 && typeof (reply as any).raw?.getHeaders === 'function'
      ? (reply as any).raw.getHeaders()
      : rawHeaders;
  if (Object.keys(rawNodeHeaders).length > 0) {
    for (const [k, v] of Object.entries(rawNodeHeaders)) {
      if (v === undefined) continue;
      headersMap[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
    }
  } else {
    const ct = reply.getHeader('content-type');
    if (ct !== undefined) headersMap['content-type'] = typeof ct === 'string' ? ct : Array.isArray(ct) ? ct[0] : String(ct);
  }
  const statusText = reply.statusText ?? reply.statusMessage ?? statusTextFor(reply.statusCode);
  const responseWire: RawWireCapture = {
    requestLine: ctx.pending.requestWire.requestLine,
    requestHeaders: ctx.pending.requestWire.requestHeaders,
    requestBody: ctx.pending.requestWire.requestBody,
    responseLine: `HTTP/1.1 ${reply.statusCode} ${statusText}`,
    status: reply.statusCode,
    responseHeaders: sanitizePlainHeadersForCapture(headersMap),
    // Stashed by the transport adapters' terminal sends — '' when the reply
    // went out through a path that bypasses them (e.g. raw socket errors).
    responseBody: encodeWireBody(ctx.pending.responseBody ?? ''),
  };
  void ctx.recorder.recordEvent({
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'response',
    spanId: ctx.spanId,
    traceId: ctx.traceId,
    sessionId: ctx.pending.sessionId,
    model: ctx.pending.model,
    status: reply.statusCode >= 200 && reply.statusCode < 400 ? 'ok' : 'error',
    wire: responseWire,
    ...(ctx.pending.conversationKey ? { conversationKey: ctx.pending.conversationKey } : {}),
    ...(ctx.pending.apiKey ? { apiKey: ctx.pending.apiKey } : {}),
  });
}

function cryptoRandom(): string {
  // node:crypto is available on every supported runtime (Bun + Node).
  // 8 bytes (16 hex chars) — 64 bits of entropy is sufficient for
  // per-exchange span uniqueness within a single inference turn; collision
  // risk across turns is negligible at the gateway's request volume.
  // Fallback to Math.random is intentionally NOT used.
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Emit the upstream request event (gateway → upstream provider, request
 * side). Called by the provider adapter immediately after building the
 * wire payload — the request goes out to the wire right after, so the
 * event must be durable BEFORE the fetch fires. Independent of any
 * response.
 */
export function emitUpstreamRequest(args: {
  recorder: CaptureRecorder;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  sessionId: string;
  traceId: string;
  model: string;
  /** Optional pre-mint spanId to share with the response event. */
  spanId?: string;
  /** Raw proxy URL when routed via proxy; redacted to origin before persisting. */
  proxy?: string;
  /** Non-default call label (e.g. 'l2-judge') so UI/log can tell the leg apart. */
  purpose?: HttpExchangeEvent['purpose'];
  /** Client API-key identity of the owning turn (see HttpExchangeEvent.apiKey). */
  apiKey?: CaptureKeyIdentity;
  /** Deterministic conversation key of the owning turn (see HttpExchangeEvent.conversationKey). */
  conversationKey?: string;
}): string {
  const spanId = args.spanId ?? cryptoRandom();
  void args.recorder.recordEvent({
    eventType: 'http-exchange',
    direction: 'upstream',
    phase: 'request',
    spanId,
    traceId: args.traceId,
    sessionId: args.sessionId,
    model: args.model,
    status: 'ok',
    wire: {
      // Absolute-form request line (RFC 7230 §5.3.2 — the legal wire form for
      // a proxy's outbound hop): the upstream HOST is part of the captured
      // line, so the archive shows which provider endpoint was dialed without
      // cross-referencing the headers. Query-auth params redacted in place.
      requestLine: `${args.method.toUpperCase()} ${absoluteFormUrl(args.url)} HTTP/1.1`,
      requestHeaders: sanitizePlainHeadersForCapture(args.requestHeaders),
      requestBody: encodeWireBody(args.requestBody),
      responseLine: '',
      status: 0,
      responseHeaders: {},
      responseBody: '',
    },
    ...(args.proxy ? { proxy: redactProxyUrl(args.proxy) } : {}),
    ...(args.purpose ? { purpose: args.purpose } : {}),
    ...(args.conversationKey ? { conversationKey: args.conversationKey } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
  });
  return spanId;
}

/**
 * Emit the upstream response event (provider → gateway, response side).
 * Called by the provider adapter immediately after `await res.text()`
 * succeeds (or fails) — independent of any other event. Pairs with the
 * matching `emitUpstreamRequest` call (same `spanId`).
 */
export function emitUpstreamResponse(args: {
  recorder: CaptureRecorder;
  url: string;
  method: string;
  status: number;
  statusText: string;
  responseHeaders: Headers;
  responseBody: string;
  sessionId: string;
  traceId: string;
  model: string;
  spanId: string;
  routing?: HttpExchangeEvent['routing'];
  error?: string;
  /** Non-default call label (e.g. 'l2-judge') so UI/log can tell the leg apart. */
  purpose?: HttpExchangeEvent['purpose'];
  /** Client API-key identity of the owning turn (see HttpExchangeEvent.apiKey). */
  apiKey?: CaptureKeyIdentity;
  /** Deterministic conversation key of the owning turn (see HttpExchangeEvent.conversationKey). */
  conversationKey?: string;
}): void {
  void args.recorder.recordEvent({
    eventType: 'http-exchange',
    direction: 'upstream',
    phase: 'response',
    spanId: args.spanId,
    traceId: args.traceId,
    sessionId: args.sessionId,
    model: args.model,
    status: args.status >= 200 && args.status < 400 ? 'ok' : 'error',
    wire: {
      // Absolute-form — mirrors emitUpstreamRequest; host stays visible here
      // even when the response event is inspected on its own.
      requestLine: `${args.method.toUpperCase()} ${absoluteFormUrl(args.url)} HTTP/1.1`,
      requestHeaders: {},
      requestBody: '',
      responseLine: `HTTP/1.1 ${args.status} ${args.statusText || statusTextFor(args.status)}`,
      status: args.status,
      responseHeaders: sanitizeHeadersForCapture(args.responseHeaders),
      responseBody: encodeWireBody(args.responseBody),
    },
    ...(args.routing ? { routing: args.routing } : {}),
    ...(args.error ? { error: args.error } : {}),
    ...(args.purpose ? { purpose: args.purpose } : {}),
    ...(args.conversationKey ? { conversationKey: args.conversationKey } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
  });
}