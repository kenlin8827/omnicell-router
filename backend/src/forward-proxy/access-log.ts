import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventRing, nextRingEventId, PROXY_ACCESS_RING_CAPACITY } from '../utils/event-ring.js';
import zlib from 'node:zlib';
import { DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES, DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS } from '../config/defaults.js';
import { sanitizePlainHeadersForCapture } from '../observability/http-exchange.js';

/**
 * Forward-proxy access log — the fourth observation ledger. Records EVERY
 * request that transits the inbound forward proxy, including the traffic the
 * LLM interceptor does NOT claim (non-model requests: metadata fetches,
 * webhooks, plain browsing through the proxy). LLM-protocol traffic keeps its
 * rich http-exchange capture in the /traces archive and is NOT duplicated
 * here; this ledger covers only the transparent-forward path plus the
 * CONNECT tunnels that never decrypt.
 *
 * The ring is the hot view; events are ALSO persisted as daily JSONL files
 * under `<ocrHome>/forward-proxy/access-log/` (`access-log-YYYYMMDD.jsonl`)
 * and reloaded into the ring on startup, so the console keeps history across
 * restarts. Auto-cleanup deletes files older than
 * `forwardProxy.accessLog.persistDays` at startup and then daily.
 * Bodies are bounded per side by `forwardProxy.accessLog.bodyBytes` (absent =
 * the finite default `DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES`, 0 = headers only):
 * the bytes inside the cap are decoded inline, and a body that outgrows it
 * spills WHOLE to a raw body file (see BodyCapture) so full capture never
 * costs an unbounded heap. Headers
 * pass the shared credential deny-list as the request-capture archive
 * (`sanitizePlainHeadersForCapture`), and the archive's redaction policy
 * (`setCaptureSecretRedaction`) applies here too.
 *
 * Hot switch: `forwardProxy.accessLog.enabled` is re-read per request via the
 * live config ref (same hot-apply seam as forwardProxy.rules).
 */

export interface ProxyAccessEvent {
  id: string;
  ts: number;
  /** `connect` = a CONNECT tunnel (blind tunnel / MITM setup); `http` = one decrypted HTTP exchange. */
  kind: 'connect' | 'http';
  host: string;
  port: number;
  method?: string;
  /** Origin-form path for MITM legs, absolute URL for plain-proxy legs. */
  path?: string;
  status?: number;
  durationMs?: number;
  reqBytes: number;
  respBytes: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** bodies-dir ref (`<day>/<name>.bin`) when THAT binary body was persisted as a raw file. */
  reqBodyFile?: string;
  resBodyFile?: string;
  /** Sniffed MIME for the persisted binary body file. */
  reqBodyMime?: string;
  resBodyMime?: string;
  /** Display text of the captured request/response body (decompressed, charset-decoded; binary bodies live in files instead). */
  requestBody?: string;
  responseBody?: string;
  /** 'hex' when THAT side's stored body is a hex dump of binary content, not decoded text. */
  reqBodyFormat?: 'hex';
  resBodyFormat?: 'hex';
  /** true when either side hit the body cap and bytes were dropped. */
  truncated?: boolean;
  /** CONNECT routing note (free-form, e.g. 'connect (blind tunnel)'). */
  note?: string;
}

/** Image container sniffing from magic bytes; everything else is octet-stream. */
function sniffMime(b: Buffer): string {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return 'application/octet-stream';
}

interface AccessLogSettings {
  enabled: boolean;
  /** Per-side inline capture cap (absent in config = the finite default); 0 = headers only. */
  bodyBytes?: number;
  persist: boolean;
  persistDays: number;
}

/**
 * Decompression bomb guard: a captured body is already capped on the wire, but
 * `gzip`/`br`/`deflate` inflate by an arbitrary factor — the inflate call needs
 * its own ceiling or a tiny hostile body becomes a multi-GB allocation.
 */
const MAX_INFLATE_BYTES = 32 * 1024 * 1024;

let settingsReader: (() => AccessLogSettings | undefined) | undefined;

/** Wired once by forward-proxy/index.ts; reads the live config ref per event. */
export function setProxyAccessLogSettingsReader(reader: (() => AccessLogSettings | undefined) | undefined): void {
  settingsReader = reader;
}

function settings(): AccessLogSettings {
  const s = settingsReader?.();
  return {
    enabled: s?.enabled ?? false,
    // Absent in config = the finite default cap (never unlimited: this ledger
    // is fed by a full-capture proxy, so "no cap" means "whole downloads in
    // the heap"). An explicit 0 still means headers-only.
    bodyBytes: s?.bodyBytes ?? DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES,
    persist: s?.persist ?? true,
    persistDays: s?.persistDays ?? DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS,
  };
}

const ring = new EventRing<ProxyAccessEvent>(undefined, PROXY_ACCESS_RING_CAPACITY);
export function proxyAccessLogSettings(): AccessLogSettings {
  return settings();
}

export function listProxyAccessEvents(): ProxyAccessEvent[] {
  return ring.rows().reverse();
}

export function clearProxyAccessLog(): void {
  // Operator "clear" means wipe: drop the ring, day files AND body files.
  const stale = listProxyAccessEvents();
  ring.clear();
  try {
    for (const f of persistedFiles(persistDir)) fs.unlinkSync(f);
    if (persistDir) fs.rmSync(path.join(persistDir, 'bodies'), { recursive: true, force: true });
  } catch {
    // Best effort — the ring is already clear.
  }
  removeBodyFiles(stale.flatMap((e) => [e.reqBodyFile, e.resBodyFile]));
}

function append(ev: ProxyAccessEvent): void {
  ring.append(ev);
  persistEvent(ev);
}

// ── disk persistence ────────────────────────────────────────────────────────

let persistDir: string | null = null;

/** Wired once by forward-proxy/index.ts with `<ocrHome>/forward-proxy/access-log/`. */
export function setProxyAccessLogPersistDir(dir: string): void {
  persistDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

// ── raw binary body files ───────────────────────────────────────────────────
// Binary bodies do NOT go inline as hex text: they are written as raw files
// under `<dir>/bodies/<day>/<event>-<side>.bin` and referenced from the
// JSONL / ring row. The console fetches them through readProxyAccessBodyFile.

const dayStamp = (ts: number): string => new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');

/** Absolute path + ring ref (`<day>/<name>.bin`) of one persisted body file. */
function bodyFileTarget(id: string, ts: number, side: 'req' | 'res'): { path: string; ref: string } {
  const day = dayStamp(ts);
  const name = `${id}-${side}.bin`;
  return { path: path.join(persistDir!, 'bodies', day, name), ref: `${day}/${name}` };
}

function writeBodyFile(id: string, ts: number, side: 'req' | 'res', buf: Buffer): string {
  const target = bodyFileTarget(id, ts, side);
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  fs.writeFileSync(target.path, buf);
  return target.ref;
}

const BODY_REF_RE = /^(\d{8})\/(pa-[a-z0-9-]+-(?:req|res))\.bin$/;

/** Console-side fetch of a persisted binary body; null when missing/invalid. */
export function readProxyAccessBodyFile(ref: string): Buffer | null {
  if (!persistDir) return null;
  const m = BODY_REF_RE.exec(ref);
  if (!m) return null;
  try {
    return fs.readFileSync(path.join(persistDir, 'bodies', m[1], `${m[2]}.bin`));
  } catch {
    return null;
  }
}

function removeBodyFiles(refs: (string | undefined)[]): void {
  for (const ref of refs) {
    if (!ref) continue;
    const m = BODY_REF_RE.exec(ref);
    if (!m) continue;
    try {
      fs.unlinkSync(path.join(persistDir!, 'bodies', m[1], `${m[2]}.bin`));
    } catch {
      // Best effort.
    }
  }
}

const dayFile = (dir: string, ts: number): string =>
  path.join(dir, `access-log-${dayStamp(ts)}.jsonl`);

function persistedFiles(dir: string | null): string[] {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^access-log-\d{8}\.jsonl$/.test(f))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function persistEvent(ev: ProxyAccessEvent): void {
  if (!persistDir || !settings().persist) return;
  try {
    fs.appendFileSync(dayFile(persistDir, ev.ts), JSON.stringify(ev) + '\n');
  } catch {
    // Disk trouble must never take the proxy path down.
  }
}

/**
 * Reload persisted events into the ring and start the daily cleanup that
 * deletes day files older than `persistDays`. Files replay OLDEST-first in
 * chronological line order: EventRing.append trims the EARLIEST-appended
 * rows when over capacity, so chronological replay leaves the most recent
 * events resident (reversing the order would keep the stalest history and
 * evict the newest).
 */
export function initProxyAccessLogPersistence(): void {
  if (!persistDir) return;
  for (const f of persistedFiles(persistDir)) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          ring.append(JSON.parse(line) as ProxyAccessEvent);
        } catch {
          // A torn last line (crash mid-append) — skip it.
        }
      }
    } catch {
      // Unreadable file — skip.
    }
  }
  const cleanup = (): void => {
    const cutoff = Date.now() - settings().persistDays * 86_400_000;
    for (const f of persistedFiles(persistDir)) {
      const m = /access-log-(\d{8})\.jsonl$/.exec(f);
      if (!m) continue;
      const dayTs = Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T00:00:00Z`);
      if (Number.isFinite(dayTs) && dayTs < cutoff) {
        try {
          fs.unlinkSync(f);
        } catch {
          // Already gone or locked — next sweep retries.
        }
      }
    }
  };
  cleanup();
  setInterval(cleanup, 24 * 3600_000).unref();
}

/** Record one CONNECT tunnel decision (no decrypted content exists). */
export function recordProxyConnect(args: {
  host: string;
  port: number;
  note: string;
}): void {
  if (!settings().enabled) return;
  append({
    id: nextRingEventId('pa-', Date.now()),
    ts: Date.now(),
    kind: 'connect',
    host: args.host,
    port: args.port,
    reqBytes: 0,
    respBytes: 0,
    note: args.note,
  });
}

/**
 * Record one FINISHED blind tunnel — the byte totals a `connect` decision row
 * cannot know yet.
 *
 * A tunnel is opaque on purpose (ADR-0020: TCP is passthrough-only), so the
 * counts and the lifetime are the entire observation. Without them "the tunnel
 * was opened" and "the tunnel carried nothing for six hours" look identical on
 * the console.
 */
export function recordProxyTunnel(args: {
  host: string;
  port: number;
  note: string;
  reqBytes: number;
  respBytes: number;
  durationMs: number;
}): void {
  if (!settings().enabled) return;
  const now = Date.now();
  append({
    id: nextRingEventId('pa-', now),
    ts: now,
    kind: 'connect',
    host: args.host,
    port: args.port,
    reqBytes: args.reqBytes,
    respBytes: args.respBytes,
    durationMs: args.durationMs,
    note: args.note,
  });
}

/**
 * A live tap on one non-intercepted HTTP exchange. The forwarders feed it
 * request/response chunks; `finish` lands the ring row exactly once.
 */
const BINARY_CT_RE = /^(?:image|audio|video|font)\//i;

/** Binary content types beyond the media families (framed / object formats). */
const BINARY_CT_EXTRA_RE = /octet-stream|protobuf|msgpack|cbor|grpc/i;

function isBinaryBody(buf: Buffer, contentType: string | undefined): boolean {
  if (contentType && (BINARY_CT_RE.test(contentType) || BINARY_CT_EXTRA_RE.test(contentType))) return true;
  // NUL byte in the sampled window — text decoders never emit NUL for real text.
  return buf.subarray(0, 4096).includes(0);
}

/** Canonical 16-bytes-per-row hex dump: offset, hex cells, ASCII gutter. */
function toHexDump(buf: Buffer): string {
  const rows: string[] = [];
  for (let off = 0; off < buf.length; off += 16) {
    const slice = buf.subarray(off, off + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0'));
    const cells: string[] = [];
    for (let i = 0; i < 16; i += 8) cells.push(hex.slice(i, i + 8).join(' ').padEnd(23, ' '));
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${off.toString(16).padStart(8, '0')}  ${cells.join('  ')}  |${ascii}|`);
  }
  return rows.join('\n');
}

/** First value of a header (case-insensitive), or undefined when absent. */
function headerValue(headers: http.IncomingHttpHeaders | undefined, name: string): string | undefined {
  const v = headers?.[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' ? first.toLowerCase() : undefined;
}

/** Charset label from a Content-Type header, kept when it looks like a valid decoder label. */
function charsetOf(contentType: string | undefined): string | undefined {
  const m = /charset\s*=\s*"?([a-z0-9_-]+)"?/i.exec(contentType ?? '');
  const label = m?.[1];
  return label && /^[a-z0-9_-]+$/i.test(label) ? label : undefined;
}

/**
 * One captured body, display-ready. `hex` marks binary content: the text is
 * a hex dump of the raw (decompressed) bytes instead of decoded text.
 */
interface DecodedBody {
  text?: string;
  hex?: boolean;
  /** Raw (decompressed) bytes — set for binary bodies so they can hit disk. */
  bytes?: Buffer;
  mime?: string;
}

/**
 * Decode a captured body for display. Compressed bodies (gzip / deflate /
 * br) are decompressed first — raw compressed bytes would land in the log
 * as mojibake. Decompression only applies to a COMPLETE body: a body cut at
 * the capture cap cannot be inflated, so it falls back to the raw bytes.
 * Binary content (media types, framed formats, or anything containing NUL)
 * becomes a hex dump capped only when a bodyBytes cap is configured; text is
 * decoded with the declared charset when Node supports it (utf-8 fallback).
 */
function decodeCaptureBody(parts: Buffer[], cap: number, encoding: string | undefined, contentType: string | undefined, truncated: boolean): DecodedBody {
  if (parts.length === 0) return { text: undefined };
  let buf = Buffer.concat(parts);
  try {
    if (!truncated && buf.length > 0) {
      const inflate = { maxOutputLength: MAX_INFLATE_BYTES };
      if (encoding === 'gzip' || encoding === 'x-gzip') buf = zlib.gunzipSync(buf, inflate);
      else if (encoding === 'br') buf = zlib.brotliDecompressSync(buf, inflate);
      else if (encoding === 'deflate') {
        try {
          buf = zlib.inflateSync(buf, inflate);
        } catch {
          buf = zlib.inflateRawSync(buf, inflate);
        }
      }
    }
  } catch {
    // Truncated or corrupt stream — keep the raw bytes as-is.
  }
  if (isBinaryBody(buf, contentType)) {
    return { hex: true, bytes: buf, mime: sniffMime(buf) };
  }
  if (buf.length > cap) buf = buf.subarray(0, cap);
  try {
    return { text: new TextDecoder(charsetOf(contentType) ?? 'utf-8').decode(buf) };
  } catch {
    return { text: buf.toString('utf8') };
  }
}

/**
 * One side's captured body: decoded inline content, or a raw body-file ref
 * when the capture outgrew the inline cap (see BodyCapture).
 */
interface CapturedSide {
  text?: string;
  hex?: boolean;
  bytes?: Buffer;
  mime?: string;
  fileRef?: string;
  fileMime?: string;
  truncated: boolean;
}

/**
 * Bounded body capture for ONE side of an exchange.
 *
 * `cap` is the INLINE budget (finite by default — DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES):
 * the bytes that fit are buffered for the decoded text/hex rendering the
 * console shows. The moment a body outgrows the cap, the WHOLE body (buffered
 * prefix + the rest) is spilled to a raw body file and every later chunk is
 * appended straight to disk — full capture without an unbounded heap. With no
 * disk sink (persistence off) the tail is dropped and the row is marked
 * truncated.
 */
class BodyCapture {
  private parts: Buffer[] = [];
  private buffered = 0;
  private total = 0;
  private spilled = false;
  private spillFd: number | undefined;
  private spillRef: string | undefined;
  private spillMime: string | undefined;
  private truncated = false;

  constructor(
    private readonly cap: number,
    private readonly spill?: { id: string; ts: number; side: 'req' | 'res' }
  ) {}

  get byteCount(): number {
    return this.total;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.cap === 0) return; // headers-only capture
    if (this.spilled) {
      if (this.spillFd === undefined) {
        this.truncated = true; // the spill died mid-body — the tail is gone
        return;
      }
      this.writeSpill(chunk);
      return;
    }
    if (this.buffered + chunk.length <= this.cap) {
      this.parts.push(chunk);
      this.buffered += chunk.length;
      return;
    }
    if (this.openSpill()) {
      this.writeSpill(chunk);
      return;
    }
    // No disk sink: keep what fits the cap, drop the tail, flag the row.
    const room = this.cap - this.buffered;
    if (room > 0) {
      this.parts.push(chunk.subarray(0, room));
      this.buffered += room;
    }
    this.truncated = true;
  }

  /** Decode this side: inline text/hex, or a raw body-file ref. */
  finish(encoding: string | undefined, contentType: string | undefined): CapturedSide {
    if (this.spilled) {
      this.closeSpill();
      return { fileRef: this.spillRef, fileMime: this.spillMime, truncated: this.truncated };
    }
    const body = decodeCaptureBody(this.parts, this.cap, encoding, contentType, this.truncated);
    if (body.hex && body.bytes) {
      // Binary content: a persisted body lands as a raw file, never inline.
      if (this.spill && persistDir) {
        try {
          const ref = writeBodyFile(this.spill.id, this.spill.ts, this.spill.side, body.bytes);
          return { fileRef: ref, fileMime: body.mime, truncated: this.truncated };
        } catch {
          // Fall through to the inline hex dump.
        }
      }
      return { hex: true, bytes: body.bytes, mime: body.mime, truncated: this.truncated };
    }
    return { text: body.text, truncated: this.truncated };
  }

  /** Open the spill file and flush the buffered prefix into it. */
  private openSpill(): boolean {
    if (!this.spill || !persistDir) return false;
    try {
      const target = bodyFileTarget(this.spill.id, this.spill.ts, this.spill.side);
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      this.spillFd = fs.openSync(target.path, 'w');
      this.spillRef = target.ref;
      if (this.buffered > 0) {
        const prefix = Buffer.concat(this.parts);
        fs.writeSync(this.spillFd, prefix);
        this.spillMime = sniffMime(prefix);
      }
      this.parts = [];
      this.buffered = 0;
      this.spilled = true;
      return true;
    } catch {
      this.closeSpill();
      return false;
    }
  }

  private writeSpill(chunk: Buffer): void {
    try {
      fs.writeSync(this.spillFd!, chunk);
    } catch {
      // Disk trouble must never break the proxy path — stop spilling.
      this.closeSpill();
      this.truncated = true;
    }
  }

  private closeSpill(): void {
    if (this.spillFd === undefined) return;
    try {
      fs.closeSync(this.spillFd);
    } catch {}
    this.spillFd = undefined;
  }
}

export interface AccessTap {
  onReqChunk(chunk: Buffer): void;
  onResChunk(chunk: Buffer): void;
  finish(status: number | undefined, responseHeaders: http.IncomingHttpHeaders | undefined, note?: string): void;
}

/** Create a tap for one decrypted exchange. Returns undefined when disabled. */
export function createAccessTap(args: {
  host: string;
  port: number;
  method: string | undefined;
  path: string;
  requestHeaders: http.IncomingHttpHeaders;
}): AccessTap | undefined {
  const s = settings();
  if (!s.enabled) return undefined;
  const started = Date.now();
  // Row id up front: a spilled body file is named after it.
  const id = nextRingEventId('pa-', started);
  const sink = (side: 'req' | 'res'): { id: string; ts: number; side: 'req' | 'res' } | undefined =>
    s.persist && persistDir !== null ? { id, ts: started, side } : undefined;
  const cap = s.bodyBytes ?? DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES;
  const reqCap = new BodyCapture(cap, sink('req'));
  const resCap = new BodyCapture(cap, sink('res'));
  return {
    onReqChunk(chunk: Buffer): void {
      reqCap.push(chunk);
    },
    onResChunk(chunk: Buffer): void {
      resCap.push(chunk);
    },
    finish(status, responseHeaders, note): void {
      const reqSide = reqCap.finish(
        headerValue(args.requestHeaders, 'content-encoding'),
        headerValue(args.requestHeaders, 'content-type')
      );
      const resSide = resCap.finish(
        headerValue(responseHeaders, 'content-encoding'),
        headerValue(responseHeaders, 'content-type')
      );
      const ev: ProxyAccessEvent = {
        id,
        ts: started,
        kind: 'http',
        host: args.host,
        port: args.port,
        method: args.method,
        path: args.path,
        status,
        durationMs: Date.now() - started,
        reqBytes: reqCap.byteCount,
        respBytes: resCap.byteCount,
        requestHeaders: sanitizePlainHeadersForCapture(args.requestHeaders),
        responseHeaders: sanitizePlainHeadersForCapture(responseHeaders as Record<string, string | string[] | undefined>),
        truncated: reqSide.truncated || resSide.truncated,
        note,
      };
      for (const [side, fileKey, mimeKey, textKey, formatKey] of [
        [reqSide, 'reqBodyFile', 'reqBodyMime', 'requestBody', 'reqBodyFormat'],
        [resSide, 'resBodyFile', 'resBodyMime', 'responseBody', 'resBodyFormat'],
      ] as const) {
        if (side.fileRef !== undefined) {
          ev[fileKey] = side.fileRef;
          if (side.fileMime !== undefined) ev[mimeKey] = side.fileMime;
        } else if (side.hex && side.bytes) {
          // Not persisting — keep the hex dump inline in the ring.
          ev[textKey] = toHexDump(side.bytes);
          ev[formatKey] = 'hex';
        } else if (side.text !== undefined) {
          ev[textKey] = side.text;
        }
      }
      append(ev);
    },
  };
}
