/**
 * Body admission — the ONE place that decides what the gateway accepts as a
 * request body, and what it says when it refuses.
 *
 * WHY THIS MODULE EXISTS: before it, "what is the body limit" was written in
 * four places (the Fastify route option, the node-http read loop, the h2 preface
 * buffer, and a local `MiB` literal used to format the message) and "what does a
 * rejection look like" in two (the surface envelope on the native leg, a bare
 * string on the MITM leg). That is exactly how the original bug happened: the
 * native leg silently inherited Fastify's 1 MiB framework default while the MITM
 * leg admitted 32 MB, so the SAME request from the SAME client was 413 on one
 * path and 200 on the other. Numbers, messages and envelopes now come from here.
 *
 * THE TIERS (values declared in config/defaults.ts, never re-declared here):
 *   - inference  GATEWAY_MAX_BODY_BYTES — both inference legs;
 *   - admin      ADMIN_MAX_BODY_BYTES  — the Fastify instance default, so no
 *                console/API route can silently inherit 1 MiB;
 *   - upload     IMPORT_BODY_LIMIT_BYTES / PLUGIN_PACKAGE_MAX_BYTES — declared
 *                per route, because those bodies are archives, not prompts.
 *
 * COMPRESSION: a client may send the body gzipped/deflate/br. Two things follow,
 * both handled here so both legs behave identically:
 *   1. the cap bounds the DECOMPRESSED body (Fastify measures the stream a
 *      `preParsing` hook returns; the MITM leg passes `maxOutputLength` to zlib),
 *      so a compressed bomb cannot inflate past the limit;
 *   2. an encoding we cannot decode is an explicit 415, never a silent
 *      pass-through that surfaces as a misleading "Invalid JSON body" 400.
 */
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib';
import type { Duplex, Readable } from 'node:stream';
import type http from 'node:http';
import type { FastifyError, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { ADMIN_MAX_BODY_BYTES, GATEWAY_MAX_BODY_BYTES, REQUEST_BODY_IDLE_TIMEOUT_MS } from '../config/defaults.js';
import type { BodyLimitsConfig } from '../config/types.js';

/** Bytes per MiB — declared once so no consumer writes `1024 * 1024` inline. */
export const BYTES_PER_MIB = 1024 * 1024;

/** Rejection classes this module can produce. `code` is the machine-readable
 *  half of the envelope and is stable API; the message text is not. */
export type BodyAdmissionCode =
  | 'payload_too_large'
  | 'unsupported_content_encoding'
  | 'unsupported_media_type'
  | 'invalid_json_body'
  // Not a size or shape verdict: the client STOPPED. Kept in this union because it
  // is answered by the same gate, on the same legs, with the same envelope.
  | 'request_body_timeout'
  | 'invalid_content_length';

/**
 * A body that will not be admitted. It carries its own HTTP status and surface
 * `code` so BOTH legs answer identically: the Fastify route `errorHandler` reads
 * `statusCode`/`code` off the error, the node-http adapter passes the same pair
 * to `sendPreDispatchError`. Neither leg keeps a private message template.
 *
 * `headers` carries the negotiation headers RFC 9110 tells a rejecting server it
 * MAY/CAN send (see ACCEPT_ENCODING_ADVERTISEMENT / ACCEPT_MEDIA_ADVERTISEMENT):
 * they ride on the error, not on the senders, so an admission refusal answers them
 * on both legs and no other 4xx accidentally grows them.
 */
export class BodyAdmissionError extends Error {
  readonly statusCode: number;
  readonly code: BodyAdmissionCode;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    statusCode: number,
    code: BodyAdmissionCode,
    message: string,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'BodyAdmissionError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers ?? admissionNegotiationHeaders(code);
  }
}

/** 33554432 -> "32 MiB"; 512000 -> "500 KiB". Whole units only: a limit stated
 *  as "33554432 bytes" is never actionable for a human reading a 413. */
export function formatByteLimit(bytes: number): string {
  if (bytes >= BYTES_PER_MIB && bytes % BYTES_PER_MIB === 0) return `${bytes / BYTES_PER_MIB} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/** The 413 sentence, shared by the native leg, the MITM leg and the h2 preface
 *  guard. Names the author (the gateway), the number, and the fix.
 *
 *  No `Retry-After` is sent on purpose: RFC 9110 15.5.14 defines that header for
 *  when "the request condition is likely to be temporary" (rate limits, maintenance
 *  windows). An oversized body is not temporary — it stays oversized until the
 *  client changes the request — so a delay would only invite pointless retries of
 *  the same refusal. */
export function bodyTooLargeMessage(capBytes: number): string {
  return (
    `OmniCellRouter: request body exceeds the gateway limit of ${formatByteLimit(capBytes)}. ` +
    'Shorten the conversation history, or reference large media by URL/file id instead of inlining base64.'
  );
}

/**
 * The admission caps THIS process enforces. They start at the shipped constants and
 * are replaced once at boot by `configureBodyLimits` from `client.bodyLimits`, so a
 * build with no config (standalone CLI, a test that boots a bare server) behaves
 * exactly as it did before the knobs existed.
 *
 * Boot-frozen on purpose, not by omission: Fastify reads a route's `bodyLimit` at
 * REGISTRATION time, and a request already being parsed cannot be policed against a
 * number that changed mid-flight. A new value therefore applies on the next
 * controlled restart (ADR-0007), which is also the only moment the h2 preface and
 * MITM drain guards are re-sized. Reading the caps through these two accessors —
 * instead of importing the constants at each site — is what keeps the six admission
 * legs on ONE number, which is the whole point of this module.
 */
let effectiveGatewayCap = GATEWAY_MAX_BODY_BYTES;
let effectiveAdminCap = ADMIN_MAX_BODY_BYTES;

/** Install the configured caps (called once from `createServer`) and return what
 *  will actually be enforced, so the caller can log the effective number. Junk
 *  (non-finite, <= 0) falls back to the shipped constant: the cleaner in
 *  `resolveBodyLimits` already clamps a loaded file, so this is the guard for a
 *  hand-built config object, not a second policy. */
export function configureBodyLimits(limits?: BodyLimitsConfig): Required<BodyLimitsConfig> {
  const sane = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  effectiveGatewayCap = sane(limits?.maxBytes, GATEWAY_MAX_BODY_BYTES);
  effectiveAdminCap = sane(limits?.adminMaxBytes, ADMIN_MAX_BODY_BYTES);
  return { maxBytes: effectiveGatewayCap, adminMaxBytes: effectiveAdminCap };
}

/** The enforced cap of one plane. Read at call time, never captured at module load. */
export function bodyLimitFor(plane: 'gateway' | 'admin'): number {
  return plane === 'admin' ? effectiveAdminCap : effectiveGatewayCap;
}

export function payloadTooLarge(capBytes: number = bodyLimitFor('gateway')): BodyAdmissionError {
  return new BodyAdmissionError(413, 'payload_too_large', bodyTooLargeMessage(capBytes));
}

/**
 * A body that stopped arriving. 408 (RFC 9110 15.5.9), NOT another 413: nothing is
 * oversized on this path, and the two verdicts ask the client for opposite fixes —
 * shrink the payload versus send the same one again. `connection: close` rides with
 * it because a stalled connection is exactly the thing we are reaping.
 */
export function requestBodyTimeout(idleMs: number = REQUEST_BODY_IDLE_TIMEOUT_MS): BodyAdmissionError {
  return new BodyAdmissionError(
    408,
    'request_body_timeout',
    `OmniCellRouter: the request body stalled — no bytes arrived for ${Math.round(idleMs / 1000)}s. Retry the request, or raise the client's write timeout.`,
    { connection: 'close' }
  );
}

/** A body that arrived as text but is not JSON. Lives here so both legs use the
 *  same words as Fastify's own parser-failure path. */
export function invalidJsonBody(): BodyAdmissionError {
  return new BodyAdmissionError(400, 'invalid_json_body', 'Invalid JSON body');
}

/**
 * Content encodings this gateway decodes on the way IN. gzip/deflate/br are what
 * agent SDKs actually send (the Anthropic SDK gzips system-prompt-heavy requests;
 * opencode does it for large bodies). `zstd` is deliberately absent — Node ships
 * no zstd binding — and an undecodable body must be refused by name rather than
 * parsed as garbage.
 */
const DECODABLE_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

/**
 * What we advertise as acceptable request codings, derived from the decode table
 * so the advertisement and the decoder cannot drift. `x-gzip` is the same coding
 * under a legacy name, so it is not advertised; `identity` needs no mention
 * (RFC 9110 8.4.1: a coding token of `identity` is always acceptable).
 *
 * RFC 9110 15.5.16: a 415 response "CAN" list what the server accepts. The coding
 * refusal is the 415 where that list is Content-Encoding, and 8.4.1 is explicit
 * that the media-type 415 MUST NOT carry it — "an incorrectly generated
 * Accept-Encoding header field would be interpreted by the client as an
 * indication that the server supports the listed content codings" — which is why
 * this header rides on the error object instead of on the shared send path.
 */
export const ACCEPT_ENCODING_ADVERTISEMENT = [...DECODABLE_ENCODINGS]
  .filter((coding) => coding !== 'x-gzip')
  .join(', ');

/** The media-type 415 gets the other half of the same sentence: the media type
 *  whose body we will actually parse. `text/plain` is tolerated in the parser but
 *  not advertised, because it is a mis-declaration allowance, not a contract. */
export const ACCEPT_MEDIA_ADVERTISEMENT = 'application/json';

/** The codings a client may declare on the way in — the same table the decoders
 *  use, so the 415 message and the Accept-Encoding advertisement cannot drift. */
export const SUPPORTED_REQUEST_CODINGS: readonly string[] = [...DECODABLE_ENCODINGS].filter(
  (coding) => coding !== 'x-gzip'
);

/**
 * The two headers a rejecting gateway is allowed to advertise, keyed by the code
 * that fired. RFC 9110 15.5.16: a 415 "MUST NOT include a Content-Encoding"-family
 * negotiation field for the rejected payload — it may include `Accept`; 12.5.3
 * gives `Accept-Encoding` to the coding refusal. Attaching the wrong one is not
 * cosmetic: `Accept-Encoding` on a 415 tells the client the media type was fine.
 *
 * Returns undefined for the codes that negotiate nothing (413, 400), so the send
 * sites never have to know which code means what.
 */
export function admissionNegotiationHeaders(code: BodyAdmissionCode): Record<string, string> | undefined {
  if (code === 'unsupported_content_encoding') return { 'accept-encoding': ACCEPT_ENCODING_ADVERTISEMENT };
  if (code === 'unsupported_media_type') return { accept: ACCEPT_MEDIA_ADVERTISEMENT };
  return undefined;
}

/** True when the client declared `Expect: 100-continue` (token match, so an
 *  extension expectation alongside it does not confuse the guard). */
export function expects100Continue(headers: http.IncomingHttpHeaders): boolean {
  const raw = headers.expect;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values.some((v) => /(^|[,\s])100-continue([,\s]|$)/i.test(v));
}

/** The body size a client declared, or undefined when it declared none (chunked
 *  transfer, or a junk `Content-Length` — both are settled while reading). */
export function declaredBodyBytes(headers: http.IncomingHttpHeaders): number | undefined {
  const raw = headers['content-length'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return undefined;
  const n = Number(first.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Answer an `Expect: 100-continue` request BEFORE its body is transferred.
 *
 * RFC 9110 10.1.1 is not permissive here: a server that has the headers and a
 * 100-continue expectation "MUST send either: an immediate response with a final
 * status code, if that status can be determined by examining just the method,
 * target URI, and header fields, or an immediate 100 (Continue) response". When the
 * declared length is already over the cap the 413 IS that determinable status, so
 * answering now is the required branch -- and it is what the mechanism exists for
 * ("allows the client to wait for an indication that it is worthwhile to send the
 * content ... can improve efficiency when the data is huge"). A body that declares
 * no length (chunked) cannot be judged from headers, so it still gets the streamed
 * guard.
 *
 * INSTALLING A `checkContinue` LISTENER TAKES THE EXCHANGE OVER. Verified on both
 * runtimes this gateway runs on (Bun 1.3.14 and Node 24): once a listener exists,
 * the server fires `checkContinue` INSTEAD of `request` and never delivers the
 * request afterwards -- so a listener that only calls `writeContinue()` hangs the
 * client until timeout, which is worse than the 413 we are trying to avoid.
 * Returning false therefore means "continue, and YOU dispatch it": the caller must
 * hand `req`/`res` to its own request flow (the native leg re-emits `request` on
 * the underlying server; the MITM legs call their inner handler).
 *
 * The same guard answers a header-known 415 (`unsupported_media_type`,
 * `unsupported_content_encoding`) through `preflightBodyAdmission`: the format
 * problem is fully determinable from the headers, it is the first MUST branch above,
 * and RFC 9110 15.5.16 exists precisely so a client can tell a coding problem from a
 * media-type problem from the response fields — so the refusal carries the negotiation
 * header its code owns (`Accept-Encoding` for a coding refusal, `Accept` for a media
 * one; 12.5.3 makes the coding field a MUST NOT when the cause is unrelated to
 * codings, and a 413 gets neither: §15.5.14 names no negotiation field, and a smaller
 * body in an unsupported coding is still unsupported, so advertising codings there
 * would invite a retry that cannot succeed). `Retry-After` is deliberately absent on a
 * 413: 15.5.14 asks for it only "if the condition is temporary", and a standing byte
 * cap is not.
 *
 * The rejection says `connection: close` because 10.1.1 requires a server that
 * answers before reading the content to "SHOULD indicate whether it intends to close
 * the connection ... or continue reading the request content" -- we are not reading
 * the rest, and leaving the pipe open would make the arriving body look like the
 * next pipelined request.
 *
 * `resolveRoute` maps the request target to the cap and envelope that WOULD have
 * handled it; undefined means "not an admission-guarded route, just continue". The
 * cap MUST be the route's own: the two admin upload routes are registered above the
 * inference cap, and a hard-coded guess here would refuse a body the route accepts.
 * Returns true when this guard answered.
 */
export interface ContinueAdmissionRoute {
  capBytes: number;
  errorBody: (err: BodyAdmissionError) => unknown;
  /** Which transport refused it (AGENTS.md: leg vocabulary is discipline-bearing). */
  leg?: 'native' | 'mitm';
  log?: { warn: (obj: unknown, msg: string) => void };
  /**
   * Close the transport after the refusal. On the MITM leg `res.end()` alone leaves
   * the terminated TLS socket open (Bun), so the forward proxy passes the terminator
   * abort hook here; the native leg needs nothing extra (`connection: close`).
   */
  refuse?: () => void;
}

export function settleContinuationExpectation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  resolveRoute: (url: string) => ContinueAdmissionRoute | undefined
): boolean {
  // A response already in flight (or a request that never set the expectation) is
  // not ours to settle; write the continue only if the reply is still open.
  if (!expects100Continue(req.headers) || res.writableEnded || res.headersSent) {
    if (!res.writableEnded && !res.headersSent) res.writeContinue();
    return false;
  }
  const target = req.url || '';
  const route = resolveRoute(target);
  if (!route) {
    res.writeContinue();
    return false;
  }
  // Format first, then size: both are settled by the headers, and the order matches
  // the post-body gate, so a client gets the same code whether or not it used the
  // expectation.
  const declared = declaredBodyBytes(req.headers);
  const err =
    preflightBodyAdmission(req.headers, route.capBytes) ??
    (declared !== undefined && declared > route.capBytes ? payloadTooLarge(route.capBytes) : undefined);
  if (!err) {
    res.writeContinue();
    return false;
  }
  logBodyRejection(
    {
      leg: route.leg ?? 'native',
      path: target,
      err,
      capBytes: route.capBytes,
      receivedBytes: 0,
      encoding: requestContentEncoding(req.headers),
    },
    route.log
  );
  try {
    const body = JSON.stringify(route.errorBody(err));
    res.writeHead(err.statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      connection: 'close',
      ...(err.headers ?? {}),
    });
    res.end(body);
  } catch {
    // Dead peer: the client saved the upload either way. Never let a continuation
    // guard throw into the server's event loop (R-3: log, do not swallow silently).
    logWriteFailure(err);
    try {
      res.destroy();
    } catch {}
  }
  try {
    route.refuse?.();
  } catch {}
  return true;
}

function logWriteFailure(err: unknown): void {
  console.error('[body-admission] continuation rejection write failed', err);
}

/** The encoding token of a request, normalised (`GZIP ` -> `gzip`). Missing,
 *  empty or `identity` all mean "no transformation" and return undefined. */
export function requestContentEncoding(headers: http.IncomingHttpHeaders): string | undefined {
  const raw = headers['content-encoding'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return undefined;
  const token = first.trim().toLowerCase();
  return token.length > 0 && token !== 'identity' ? token : undefined;
}

function unsupportedEncoding(encoding: string): BodyAdmissionError {
  return new BodyAdmissionError(
    415,
    'unsupported_content_encoding',
    `Unsupported Content-Encoding '${encoding}'. The gateway decodes: ${[...DECODABLE_ENCODINGS].join(', ')}.`,
    { 'accept-encoding': ACCEPT_ENCODING_ADVERTISEMENT }
  );
}

/**
 * Media types whose body this gateway reads as JSON. `application/json` (and any
 * `+json` structured type) is the rule and `text/plain` is tolerated, because real
 * agents do mis-declare and the body is unambiguous once you look at it.
 *
 * Anything else — form-urlencoded (what bare `curl -d` sends), multipart, XML, a
 * binary type — and a MISSING header are refused with 415 on BOTH legs, before the
 * body is buffered. Two reasons: an inference gateway has no business accepting a
 * 30 MB upload it will never parse, and the native leg cannot be lenient here (that
 * is Fastify's own content-type gate, which answers 415 for an undeclared type), so
 * the stricter rule is the one that keeps the legs identical — the asymmetry is the
 * bug family this whole pass is about. The refusal names the fix, so a hand-rolled
 * request learns `Content-Type: application/json` instead of a mystery 400.
 */
const JSON_MEDIA_TYPE = /^application\/([\w.+-]+\+)?json\b/i;
const TOLERATED_MEDIA_TYPE = /^text\/plain\b/i;

export function requestMediaType(headers: http.IncomingHttpHeaders): string | undefined {
  const raw = headers['content-type'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return undefined;
  const token = first.trim();
  return token.length > 0 ? token : undefined;
}

function unsupportedMediaType(received: string | undefined): BodyAdmissionError {
  return new BodyAdmissionError(
    415,
    'unsupported_media_type',
    received
      ? `Unsupported Media Type '${received}'. The gateway reads a JSON request body (Content-Type: ${ACCEPT_MEDIA_ADVERTISEMENT}).`
      : `Missing Content-Type. The gateway reads a JSON request body (Content-Type: ${ACCEPT_MEDIA_ADVERTISEMENT}).`,
    { accept: ACCEPT_MEDIA_ADVERTISEMENT }
  );
}

/** True when this request's declared media type is one whose body we will parse.
 *  An absent header is NOT acceptable — it is the one case where leniency on one
 *  leg and a framework gate on the other would disagree silently. */
export function mediaTypeAcceptable(headers: http.IncomingHttpHeaders): boolean {
  const ct = requestMediaType(headers);
  if (ct === undefined) return false;
  return JSON_MEDIA_TYPE.test(ct) || TOLERATED_MEDIA_TYPE.test(ct);
}

/**
 * The MITM leg's media-type gate, thrown (not replied) so answering and logging
 * stay on the single admission path in `model-gateway.ts`. Called BEFORE the body
 * is read, which is the point: reject the type, not the size.
 */
export function assertJsonMediaType(headers: http.IncomingHttpHeaders): void {
  if (!mediaTypeAcceptable(headers)) throw unsupportedMediaType(requestMediaType(headers));
}

/**
 * Decide from the HEADERS alone whether this request could ever be admitted:
 * framing first (an ambiguous `Content-Length` is not a message we may forward,
 * RFC 9112 6.3), then media type (cheap, and independent of size), then the
 * content coding, by asking the same decoder table `decompressBody` uses against
 * an empty buffer -- an undecodable coding throws there and here, with the same
 * 415, so the two checks cannot disagree about which codings exist. Also the
 * header-only half of `settleContinuationExpectation`, which is why it returns
 * the error instead of throwing it.
 *
 * Returns the rejection, or undefined when the request may proceed. The MITM legs
 * call it BEFORE the body is drained, so a request we intend to refuse never pays
 * for its own upload (the counterpart of the `Expect: 100-continue` guard, which
 * cannot help a chunked body or a client that ignores the expectation).
 */
export function preflightBodyAdmission(
  headers: http.IncomingHttpHeaders,
  capBytes: number = bodyLimitFor('gateway')
): BodyAdmissionError | undefined {
  // FRAMING FIRST (RFC 9112 6.3): when `Content-Length` cannot be determined
  // unambiguously the message must be rejected, never processed and never
  // forwarded. Node's parser refuses a duplicated CL on its own, but BUN ACCEPTS
  // two identical values and hands the application an ARRAY -- so without this
  // check the gateway would relay the duplicate framing upstream and become the
  // smuggle carrier. A non-numeric value is the same defect (no route to the
  // framework's length error on either runtime).
  const declaredLength = headers['content-length'];
  if (declaredLength !== undefined && (Array.isArray(declaredLength) || !/^\d+$/.test(declaredLength))) {
    return invalidContentLength();
  }
  try {
    assertJsonMediaType(headers);
    if (requestContentEncoding(headers)) decompressBody(Buffer.alloc(0), headers, capBytes);
    return undefined;
  } catch (err) {
    return isBodyAdmissionError(err) ? err : undefined;
  }
}

/** A `Content-Length` the server could not frame: duplicated values, a non-numeric
 *  value, or bytes that do not match the declaration. 400 because the framing, not
 *  the payload, is broken (RFC 9110 8.6 makes a message with conflicting
 *  Content-Length values an error, not something to guess at). The declared numbers
 *  are deliberately NOT echoed: a mismatch gives the client nothing to fix beyond
 *  "reframe the request", and repeating a caller-chosen length into a response and a
 *  log line is free noise. */
export function invalidContentLength(): BodyAdmissionError {
  return new BodyAdmissionError(
    400,
    'invalid_content_length',
    'The request declares an invalid or duplicated Content-Length. Send exactly one Content-Length, or use a chunked body.'
  );
}

/**
 * Normalize what Fastify handed the handler.
 *
 * A `text/plain` (or any tolerated-but-not-json) declaration makes Fastify's own
 * parser deliver a raw STRING, and passing that to the pipeline produced the
 * misleading `"messages" array is required` 400 for a perfectly valid body. Parse
 * it here so the native leg agrees with the MITM leg, and reject a top-level
 * non-object the same way the MITM leg does.
 */
export function normalizeNativeBody(body: unknown): unknown {
  const parsed = typeof body === 'string' ? parseJsonBody(body) : body;
  if (!parsed || typeof parsed !== 'object') throw invalidJsonBody();
  return parsed;
}

/**
 * Streaming decoder for the native leg, returned from a Fastify `preParsing`
 * hook. Returning a stream (instead of buffering) keeps the request on Fastify's
 * normal parse path.
 *
 * The limit is deliberately NOT passed here: Fastify measures the stream this
 * hook returns and enforces `bodyLimit` against its OUTPUT length, so an
 * inflated bomb is refused at the same ceiling as a plain body.
 *
 * `receivedEncodedLength` is defined as a live getter over the COMPRESSED bytes:
 * Fastify compares it against the `Content-Length` header and reads it after each
 * chunk, so a static 0 makes the request fail as a length mismatch.
 */
export function createBodyDecompressor(headers: http.IncomingHttpHeaders, payload: Readable): Readable {
  const encoding = requestContentEncoding(headers);
  if (!encoding) return payload;
  if (!DECODABLE_ENCODINGS.has(encoding)) throw unsupportedEncoding(encoding);

  const decoder: Duplex =
    encoding === 'br'
      ? createBrotliDecompress()
      : encoding === 'gzip' || encoding === 'x-gzip'
        ? createGunzip()
        : createInflate();

  let compressed = 0;
  payload.on('data', (chunk: Buffer | string) => {
    compressed += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  });
  Object.defineProperty(decoder, 'receivedEncodedLength', {
    configurable: true,
    get: () => compressed,
  });

  // `.pipe` alone would swallow a source error (a truncated or corrupt gzip
  // stream) and leave Fastify waiting on a decoder that never ends, so the
  // source error is forwarded as a destroy: the request then fails as a 400
  // instead of hanging until socket timeout.
  payload.pipe(decoder);
  payload.on('error', (err: Error) => {
    if (!decoder.destroyed) decoder.destroy(err);
  });
  return decoder;
}

/** Buffer decoder for the MITM leg, which already holds the whole body.
 *  `maxOutputLength` is the bomb guard: zlib aborts with ERR_BUFFER_TOO_LARGE
 *  rather than inflating past the cap, and that is reported as the SAME 413 the
 *  native leg produces. */
export function decompressBody(
  raw: Buffer,
  headers: http.IncomingHttpHeaders,
  capBytes: number = bodyLimitFor('gateway')
): Buffer {
  const encoding = requestContentEncoding(headers);
  if (!encoding) return raw;
  if (!DECODABLE_ENCODINGS.has(encoding)) throw unsupportedEncoding(encoding);

  const opts = { maxOutputLength: capBytes };
  try {
    switch (encoding) {
      case 'br':
        return brotliDecompressSync(raw, opts);
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(raw, opts);
      default:
        // HTTP `deflate` is the zlib format (RFC 1950). Raw deflate (RFC 1951)
        // has no valid zlib header but is sent in the wild, so sniff instead of
        // rejecting: a 400 for a body we can actually read would be a lie.
        return looksLikeZlibStream(raw) ? inflateSync(raw, opts) : inflateRawSync(raw, opts);
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') throw payloadTooLarge(capBytes);
    throw invalidJsonBody(); // undecodable bytes: the body itself is broken
  }
}

/** zlib stream header check (RFC 1950): CM must be 8 and (CMF<<8|FLG) % 31 === 0. */
function looksLikeZlibStream(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x78 && (((buf[0] << 8) | buf[1]) % 31 === 0);
}

/** Parse an admitted JSON body, rejecting with the shared 400 rather than a raw
 *  SyntaxError whose message leaks byte offsets to the client. */
export function parseJsonBody(body: Buffer | string): unknown {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw invalidJsonBody();
  }
}

/**
 * One operator-facing line per admission rejection. Without it a 413/415 is
 * invisible: capture records nothing on this path (ADR-0008 — 400/413 precede
 * processing) and Fastify request logging is disabled, so an operator debugging
 * "my agent fails on long sessions" has no server-side evidence at all.
 * `log` is the request logger when available; the fallback keeps the line in the
 * process log for the legs that have no pino child.
 */
export function logBodyRejection(
  info: {
    leg: 'native' | 'mitm';
    path: string;
    err: BodyAdmissionError;
    capBytes: number;
    receivedBytes?: number;
    encoding?: string;
  },
  log?: { warn: (obj: unknown, msg: string) => void }
): void {
  const record = {
    type: 'body_rejected',
    leg: info.leg,
    path: info.path,
    status: info.err.statusCode,
    code: info.err.code,
    capBytes: info.capBytes,
    receivedBytes: info.receivedBytes,
    contentEncoding: info.encoding ?? 'identity',
  };
  if (log) log.warn(record, `body rejected (${info.err.code}) on ${info.leg} leg ${info.path}`);
  else console.warn(`[body-admission] body rejected (${info.err.code}) on ${info.leg} leg ${info.path}`, record);
}

/** Narrowing helper for the answering layers on both legs. */
export function isBodyAdmissionError(err: unknown): err is BodyAdmissionError {
  return err instanceof BodyAdmissionError;
}

/**
 * Fastify codes for the failures the content parser raises BEFORE a handler runs.
 * They must be answered here because at that point no transport and no capture
 * event exists (ADR-0008: 400/413 precede process), so the only thing left to
 * shape the response with is the surface's error envelope.
 */
const FRAMEWORK_BODY_CODES = new Set(['FST_ERR_CTP_BODY_TOO_LARGE']);
const FRAMEWORK_JSON_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);
// Two producers, one meaning: Fastify's content-type gate on the native leg, and
// Node's own media-type abort on the raw/MITM leg (node/lib/_http_server.js).
const FRAMEWORK_MEDIA_CODES = new Set(['FST_ERR_CTP_INVALID_MEDIA_TYPE', 'ERR_HTTP_INVALID_MEDIA_TYPE']);
// Framing errors on the raw legs: the LLM client cannot act on "your lengths
// disagree", but it can reframe -- and silence (Node aborts with no response) is
// worse than a 400 that says so.
const FRAMEWORK_LENGTH_CODES = new Set([
  'ERR_REQUEST_CONTENT_LENGTH_COUNT',
  'ERR_REQUEST_CONTENT_LENGTH_INVALID',
  'ERR_REQUEST_CONTENT_LENGTH_INVALID_CHAR',
  'ERR_REQUEST_CONTENT_LENGTH_MISMATCH',
]);

/** Minimal view of a protocol surface, so this module does not import the table
 *  (which would cycle back through the transports). */
interface EnvelopeOwner {
  routePath: string;
  errorBody(status: number, message: string, code?: string): unknown;
}

/**
 * Route options that give the NATIVE leg the same admission policy the MITM leg
 * applies by hand: decode `Content-Encoding` on the way in, cap the DECOMPRESSED
 * body at the configured inference cap (`bodyLimitFor('gateway')`), and answer every
 * rejection in the surface's own envelope with a machine-readable `code`.
 *
 * `preParsing` is registered per route rather than app-wide on purpose — an
 * app-wide hook would also decompress admin/upload bodies it knows nothing about.
 */
export function surfaceBodyAdmissionOptions(surface: EnvelopeOwner): RouteShorthandOptions {
  const capBytes = bodyLimitFor('gateway');
  return {
    bodyLimit: capBytes,
    preParsing(request, _reply, payload, done) {
      try {
        done(null, createBodyDecompressor(request.headers, payload) as never);
      } catch (err) {
        // A 415 for an encoding we cannot decode. Passing it to `done` (rather
        // than replying from the hook) keeps ONE answering path for every
        // rejection and leaves Fastify to drain/close the socket.
        done(err as Error);
      }
    },
    errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
      // One translation call covers the framework's own refusals, including
      // FST_ERR_CTP_INVALID_MEDIA_TYPE: Fastify answers that with its own
      // string-`error` envelope, which Anthropic-style clients cannot parse, so it
      // is re-answered here naming the type that was actually received.
      const admission = isBodyAdmissionError(err)
        ? err
        : frameworkBodyError(err, capBytes, requestMediaType(request.headers));
      if (!admission) throw err; // not ours: delegate to the parent handler
      logBodyRejection(
        {
          leg: 'native',
          path: request.url,
          err: admission,
          capBytes,
          encoding: requestContentEncoding(request.headers),
        },
        request.log
      );
      return reply
        .status(admission.statusCode)
        .headers(admissionHeaders(admission))
        .send(surface.errorBody(admission.statusCode, admission.message, admission.code));
    },
  };
}

/**
 * App-level `errorHandler` for the ADMIN plane (everything that is not a
 * protocol surface). The console reads failures as `{ success: false, message }`;
 * Fastify's default shape is `{ statusCode, code, error, message }` whose
 * `error` is a reason phrase, which the UI renders as the bare
 * `Error: 413 "Payload Too Large"` this whole module exists to kill.
 *
 * Non-admission errors are RE-THROWN, which hands them to Fastify's default
 * handler (fastify/docs/Reference/Errors.md) — this handler must not become a
 * second, worse error serializer for validation and 5xx paths it knows nothing
 * about, and it never echoes a stack or an upstream body.
 */
export function adminBodyErrorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const capBytes = bodyLimitFor('admin');
  const admission = isBodyAdmissionError(err)
    ? err
    : frameworkBodyError(err, capBytes, requestMediaType(request.headers));
  if (!admission) throw err;
  logBodyRejection(
    {
      leg: 'native',
      path: request.url,
      err: admission,
      capBytes,
      encoding: requestContentEncoding(request.headers),
    },
    request.log
  );
  return reply
    .status(admission.statusCode)
    .headers(admissionHeaders(admission))
    .send({ success: false, message: admission.message });
}

/** Fastify types `reply.headers()` against its known-header union; the admission
 *  headers are a fixed set of literal names built in this file, so widening is
 *  safe and keeps the send sites free of a cast. Returns an empty object when the
 *  rejection advertises nothing (every 413, 400). */
type ReplyHeaders = Parameters<FastifyReply['headers']>[0];

function admissionHeaders(err: BodyAdmissionError): ReplyHeaders {
  return (err.headers ?? {}) as ReplyHeaders;
}

/** Translate a framework content-parser failure into this module's error type, so
 *  one message builder and one `code` cover both producers. Returns undefined for
 *  errors that belong to somebody else. */
function frameworkBodyError(
  err: { code?: string },
  capBytes: number,
  receivedMediaType?: string
): BodyAdmissionError | undefined {
  if (FRAMEWORK_BODY_CODES.has(err.code ?? '')) return payloadTooLarge(capBytes);
  if (FRAMEWORK_JSON_CODES.has(err.code ?? '')) return invalidJsonBody();
  // A refused media type from the framework does not name what was SENT (our own
  // gate does, via unsupportedMediaType(received)), so this variant says what the
  // server accepts instead; the `Accept` header carries the same answer.
  if (FRAMEWORK_MEDIA_CODES.has(err.code ?? '')) return unsupportedMediaType(receivedMediaType);
  if (FRAMEWORK_LENGTH_CODES.has(err.code ?? '')) return invalidContentLength();
  // A body that ENDS SHORT of its declared length is deliberately NOT mapped: Node
  // (and Bun) abort the request and no response is written at all -- there is
  // nothing here to shape (verified on both runtimes). The reachable truncation case
  // is the reverse, a declared length SHORTER than the bytes sent: the parser sees a
  // truncated JSON document and answers `invalid_json_body` above.
  return undefined;
}
