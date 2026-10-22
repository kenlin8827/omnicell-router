import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RequestCaptureConfig } from '../config/types.js';
import { getEnvPaths } from '../config/env.js';
import { DEFAULT_MAX_BODY_BYTES } from '../config/defaults.js';

/**
 * One captured turn — a single JSONL line in the per-session archive file.
 * `request` is the PRE-compression snapshot (what the client actually sent);
 * `response` is the full upstream payload. Either becomes a plain string with
 * `truncated: true` when it exceeds the per-body byte budget (a truncated
 * JSON document is no longer valid JSON, so it is stored as a string).
 * Request headers are captured in SANITIZED form only: every header name is
 * kept, credential-shaped values are replaced with `[REDACTED]` (deny-list:
 * `DENY_HEADER_SUBSTRINGS` in `observability/http-exchange.ts`).
 *
 * `upstreamRequest` is the REAL outbound wire body the provider actually
 * sent — translated through the wire (OpenAI / Anthropic / Google / Responses
 * / OpenCode-proxy), with `model.upstreamModel` substituted and routing-only
 * fields (`router_options`, `stream_options`) stripped. Shape varies by
 * wire (see provider adapter payload builders).
 *
 * `upstreamHttp` is the HTTP-level observation of the SUCCESSFUL outbound
 * call (last-write-wins across in-place retries and failover hops): the
 * resolved URL, HTTP status, a SAFE subset of response headers
 * (retry-after / request-id / content-type / ratelimit trio), TTFB, total
 * duration, and the wire kind. Header capture excludes all credential-
 * bearing fields.
 */
interface UpstreamHttpRecord {
  url: string;
  method: string;
  status: number;
  /**
   * All response headers from the upstream call — full header names are kept
   * so the captured record is a faithful snapshot of the wire. VALUES whose
   * name matches the credential deny-list (api-key / authorization / cookie /
   * token / secret / password / bearer / signature / credential / x-auth /
   * proxy-auth / x-goog-api-key) are replaced with the literal string
   * `[REDACTED]` so API keys never reach the disk. The deny-list is case-
   * insensitive substring match — see `sanitizeHeadersForCapture` in
   * `observability/http-exchange.ts`.
   */
  responseHeaders?: Record<string, string>;
  /** First-byte latency (ms). null when no body byte arrived (pre-body error). */
  ttfbMs: number | null;
  /** Total round-trip latency (ms) from request fire to fetch resolve. */
  durationMs: number;
  /** 1-based index of the successful attempt inside the candidate chain. */
  attemptIndex: number;
  wireKind: 'openai' | 'anthropic' | 'google' | 'responses' | 'opencode-proxy';
}

/**
 * Raw HTTP wire capture: the byte-faithful snapshot of one HTTP exchange.
 * The shape mirrors a standard HTTP wire dump (RFC 7230 §3): request line,
 * header block, blank line, body — for both the request and the response.
 * Captured so debug can answer "what did the upstream actually receive"
 * without parsing through the gateway's transformations, and vice versa.
 *
 * Bodies are stored as UTF-8 strings when they parse cleanly (typical for
 * JSON chat-completions traffic). Non-UTF-8 payloads fall back to a hex
 * encoding under `{ hex: string }` so binary upstream responses (e.g.
 * audio / image generators) are still inspectable.
 */
export type WireBody = string | { hex: string };

export interface RawWireCapture {
  /** "POST /v1/chat/completions HTTP/1.1" — the wire request line. */
  requestLine: string;
  /** All request headers — full names preserved, credential values masked. */
  requestHeaders: Record<string, string>;
  /** Request body — JSON-stringified chat completions, or hex for binary. */
  requestBody: WireBody;
  /** "HTTP/1.1 200 OK" — the wire status line as the server wrote it. */
  responseLine: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: WireBody;
}

/**
 * @deprecated Use `HttpExchangeEvent` instead. The turn-centric schema
 * pre-dates the HTTP exchange event stream; new capture JSONL files
 * only write `HttpExchangeEvent`. The fields below remain readable for
 * back-compat with already-written archives but the orchestrator no
 * longer writes them — every field is best-effort, last-write-wins
 * semantics that no longer match how capture actually works.
 */
interface CaptureRecord {
  id: string; // cap_<hex>
  ts: number; // epoch ms
  sessionId: string; // raw (unsanitized) session id
  status: 'ok' | 'error';
  model: string; // client-requested model id
  request?: unknown;
  /** @deprecated read-only back-compat — see HttpExchangeEvent.wire.requestBody. */
  upstreamRequest?: unknown;
  /**
   * @deprecated read-only back-compat — see HttpExchangeEvent.wire.responseBody
   * (one outbound-response event per HTTP exchange).
   */
  upstreamResponse?: unknown;
  /**
   * @deprecated read-only back-compat — replaced by the HTTP exchange event
   * stream (one outbound-response event with status / headers / body).
   */
  upstreamHttp?: UpstreamHttpRecord;
  /** @deprecated see HttpExchangeEvent.wire. */
  upstreamWire?: RawWireCapture;
  /** @deprecated see HttpExchangeEvent.wire. */
  inboundWire?: RawWireCapture;
  /** @deprecated see outbound-failure events with status + body. */
  upstreamError?: unknown;
  response?: unknown;
  error?: string;
  routing?: {
    tierUsed?: string;
    layerUsed?: string;
    modelUsed?: string;
    provider?: string;
    fallbackOccurred?: boolean;
    failoverPath?: string[];
  };
  usage?: unknown;
  latencyMs?: number;
  truncated?: boolean;
}

/**
 * One HTTP-exchange event in the capture event stream. Replaces the
 * turn-centric `CaptureRecord` model: every HTTP exchange now emits TWO
 * independent events (request + response) instead of one combined record.
 *
 * Benefits over the turn model:
 *   - **Request events persist even when no response arrives** (timeout,
 *     client cancel, provider unreachable) — the request side is captured
 *     synchronously before the wire call returns, so failure is recorded.
 *   - **Request / response timing** becomes a first-class pair. Two events
 *     with the same `spanId` describe one exchange; their `ts`
 *     delta IS the request→response latency, computed at read time.
 *   - **Symmetry across client and upstream legs**: each direction emits
 *     its own request + response event, all four sharing one
 *     `traceId` so the full picture joins back together.
 *
 * A single inference turn produces 2-4 events sharing the same
 * `traceId`: client-request, gateway-response, upstream-request,
 * upstream-response. File layout keeps the per-turn grouping (same
 * `sessionId`) so the existing turn-based session browser keeps working
 * while the events are now individually retrievable.
 *
 * Direction naming follows the gateway's POV:
 *   - `client`     = client ↔ gateway (the request that arrived, the response
 *                    that was sent back to the client)
 *   - `upstream`   = gateway ↔ upstream provider (the request the gateway
 *                    sent upstream, the response that came back)
 * This matches OpenTelemetry conventions for proxy/gateway roles.
 */
export interface HttpExchangeEvent {
  id: string; // evt_<hex>
  ts: number; // epoch ms — when THIS phase fired (request send / response recv)
  /** Always 'http-exchange' for this event type. */
  eventType: 'http-exchange';
  /** 'client' = client ↔ gateway; 'upstream' = gateway ↔ provider. */
  direction: 'client' | 'upstream';
  /** 'request' = the wire side that's being sent; 'response' = the side that's being received. */
  phase: 'request' | 'response';
  /**
   * Stable per-exchange id (OpenTelemetry spanId) shared by the request
   * event AND its matching response event (same direction). E.g. one
   * client exchange = one `spanId` with two events (req + resp).
   */
  spanId: string;
  /**
   * Stable trace id (OpenTelemetry traceId) shared across all four
   * events of one inference turn (the client-request, client-response,
   * upstream-request, upstream-response all share one `traceId`).
   * Sourced from the inbound request's `traceparent` / `x-request-id`
   * when present, otherwise minted as 32-hex (see resolveTraceId).
   */
  traceId: string;
  /** Session id from session-manager (or synthetic `ocr-turn-<id>` when no session exists yet). */
  sessionId: string;
  /**
   * Deterministic conversation key — `sha256(apiKey identity + FULL first
   * user message)` (see `SessionManager.conversationKey`), content-addressed
   * and stable across session-id churn and gateway restarts. Lets the
   * archive regroup an application's turns into conversations even when
   * zero-header resolution minted a fresh session id mid-loop. Never
   * credential material — a hash of conversation content, same disclosure
   * class as the anchor keys. Absent when the request carries no first user
   * text (e.g. a bare system prompt) or predates this field.
   */
  conversationKey?: string;
  /** Client-requested model id (from inbound request body's `model` field). */
  model: string;
  /** Status of THIS event — request side rarely errors; response side mirrors the wire status. */
  status: 'ok' | 'error' | 'pending';
  /** The wire dump for THIS side only (request side OR response side — the other side fields are empty). */
  wire: RawWireCapture;
  /** Optional routing decision, attached when known (mostly on upstream-response). */
  routing?: {
    tierUsed?: string;
    layerUsed?: string;
    modelUsed?: string;
    provider?: string;
    fallbackOccurred?: boolean;
    failoverPath?: string[];
  };
  /**
   * Client API-key identity (`sk-ocr-*` entry from `config.apiKeys`) that
   * authenticated this turn. Attached to EVERY event of the turn (client
   * request/response + upstream request/response) so a whole turn is
   * attributable to one application. Only the stable `id` and the display
   * `name` are persisted — the token value is never stored, consistent with
   * the credential deny-list in `observability/http-exchange.ts` (the raw
   * Authorization / x-api-key header values stay `[REDACTED]`).
   * Absent (`undefined`) when the leg has no key identity: master-key
   * (`adminApiKey`) access, MITM forward-proxy tunnels (CONNECT-authenticated),
   * or requests archived before this field existed.
   */
  apiKey?: CaptureKeyIdentity;
  /** Error message if THIS phase errored (e.g. upstream request never got a response). */
  error?: string;
  /**
   * Redacted proxy origin (`scheme://host:port`) when this upstream call was
   * routed through a proxy; absent for direct connections. Only meaningful
   * on `direction='upstream'` events. Userinfo is never persisted.
   */
  proxy?: string;
  /**
   * Why this exchange happened when it is NOT the turn's ordinary client or
   * candidate-execution traffic. `l2-decision` marks the HTTP leg the Layer 2
   * decision layer fires inside a routed turn (upstream direction, attached to the
   * outer request's trace/session). Absent = ordinary traffic.
   */
  purpose?: ExchangePurpose;
  /**
   * Completion-token total derived at read time from the response body (last
   * usage occurrence — streaming SSE repeats it, the final chunk is the
   * cumulative total). Lets metadata-only reads (`bodies=none`, bodies
   * stripped) still render per-turn tok/s chips without shipping the body.
   * Absent for hex/binary bodies or bodies without a usage block.
   */
  completionTokens?: number;
  /**
   * Epoch ms of the FIRST streamed body chunk of this response — stamped at
   * the wire reader (upstream SSE loop / gateway SSE write) when the first
   * chunk crosses. Paired with the event `ts` (response received / finalized)
   * it yields the TTFT and the decode window (see CaptureTurnSummary).
   * Undefined for buffered single-shot responses and for events recorded
   * before the stamp existed.
   */
  firstByteTs?: number;
}

/** Label for capture events that carry a non-default call purpose. */
export type ExchangePurpose = 'l2-decision';

/**
 * Stable identity of the client API key that authenticated a turn — the
 * non-secret half of `ApiKeyConfig` (id + application name). Persisted onto
 * capture events and session rows; NEVER the token value.
 */
export interface CaptureKeyIdentity {
  id: string;
  name: string;
}

/**
 * One logical inference turn: the four http-exchange events joined by
 * `traceId` / `spanId` (see `groupEventsIntoTurns`).
 */
export interface CaptureTurnSummary {
  traceId: string;
  sessionId: string;
  model: string;
  clientRequest?: HttpExchangeEvent;
  gatewayResponse?: HttpExchangeEvent;
  upstreamRequest?: HttpExchangeEvent;
  upstreamResponse?: HttpExchangeEvent;
  /**
   * The Layer 2 decision layer's HTTP leg when one fired inside this turn
   * (`purpose: 'l2-decision'` upstream events). Kept in SEPARATE slots — never
   * merged into the serving upstream pair — so the console can show both
   * calls and tell them apart (the decision layer call precedes candidate execution
   * and would otherwise be overwritten by the last-write-wins serving leg).
   */
  decisionRequest?: HttpExchangeEvent;
  decisionResponse?: HttpExchangeEvent;
  /** Any of the four events with an error field set; "first error wins". */
  error?: string;
  /** Decision-leg cycle latency (decision-resp.ts - decision-req.ts). */
  decisionLatencyMs?: number;
  /** Gateway cycle latency (client-resp.ts - client-req.ts). */
  gatewayLatencyMs?: number;
  /** Upstream cycle latency (upstream-resp.ts - upstream-req.ts). */
  upstreamLatencyMs?: number;
  /** TTFT / decode window for the L2 decision leg (same derivation as upstream). */
  decisionTtftMs?: number;
  decisionGenMs?: number;
  /**
   * TTFT / decode window, derived from the response event's firstByteTs and
   * the matching request event's ts — the industry TTFT/TPS split, measured
   * at the wire on EACH leg. Undefined when the leg was not streamed
   * (buffered exchange) or the event predates the stamp.
   */
  gatewayTtftMs?: number;
  gatewayGenMs?: number;
  upstreamTtftMs?: number;
  upstreamGenMs?: number;
}

interface CaptureDateRow {
  date: string; // YYYY-MM-DD (local time)
  sessions: number;
  bytes: number;
}

interface CaptureSessionRow {
  file: string; // safe file name (already sanitized at write time)
  sessionId: string; // same as file minus the .jsonl suffix
  bytes: number;
  mtimeMs: number;
  turns: number; // total captured turns
  failed: number; // turns with status === 'error'
  lastStatus?: 'ok' | 'error'; // status of the most recent turn (badge dot)
  /** First user-message text of the session (single line, capped) so the console list is human-identifiable. */
  preview?: string;
  /**
   * DISTINCT client API-key identities seen in this archive, in write order —
   * normally a single entry (one archive, one application); more when the app
   * rotated keys mid-session. The FIRST element doubles as the display anchor
   * (no separate singular field — it would be derivable). Absent on legacy
   * archives written before key attribution existed and on key-less legs
   * (MITM, master-key access).
   */
  apiKeys?: CaptureKeyIdentity[];
  /**
   * Deterministic conversation key seen on this archive's events (first
   * occurrence). Stable across session-id churn — the join key that regroups
   * a conversation split by per-turn cold-start mints. Absent on key-less /
   * legacy archives.
   */
  conversationKey?: string;
}

/**
 * One archive-file hit for a session id, located by NAME across all date
 * directories. Coordinates only (enough to read/delete the archive) — row
 * metadata (turns/preview/apiKey) comes from listSessions, never from a
 * name-only find.
 */
interface CaptureSessionMatch {
  date: string; // YYYY-MM-DD directory the archive lives in
  file: string; // archive file name (safe id verbatim, or h_<hash>.jsonl)
}

interface CaptureStatus {
  enabled: boolean;
  dir: string;
  retentionDays: number;
  maxTotalMB: number;
  maxBodyBytes: number;
  maxSessionMB: number;
  storeMedia: boolean;
  totalBytes: number;
  dateCount: number;
}

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
// Session ids that are already filesystem-safe are kept verbatim for
// browsability; anything else (path traversal, separators, excess length)
// falls back to a stable content hash.
const SAFE_SESSION_RE = /^[\w.@:-]{1,80}$/;
// Reserves the hash output namespace: ids literally shaped like sessionFileName()'s
// own digest output go through the hash branch (hash-of-hash), never verbatim —
// closing the alias-collision vector where a crafted id `h_<16hex>` would name
// the same archive as some unsafe id's hash. Case-insensitive because the
// verbatim branch accepts uppercase hex, which aliases the lowercase digest
// file on case-insensitive filesystems (Windows/macOS).
const HASH_NAME_RE = /^h_[0-9a-f]{16}$/i;
const JSONL_SUFFIX = '.jsonl';
const TRUNCATION_SUFFIX = '...[TRUNCATED]';
// Binary-media offload sub-directory inside each date archive (content-
// addressed, deduped by sha256 name). Retention sweeps whole date dirs, so
// the media files ride the same daily cleanup batch — and every directory
// listing in this class filters on isFile()/.jsonl, so it never surfaces as
// a "session".
const MEDIA_SUBDIR = 'media';
// Reader-side shape of the stored file name: `<64hex>.<ext>` — the route
// accepts the bare hash (16–64 hex) and prefix-matches it against this.
const MEDIA_FILE_RE = /^[0-9a-f]{16,64}\.[a-z0-9]{1,8}$/;
// A bare (no data-URL prefix) base64 payload worth scrubbing: ≥256 chars of
// strict alphabet. Prose, code, or paths carry spaces/punctuation and never
// match — the guard's false-positive class is "long base64-ish token", which
// is exactly what image/audio/document blobs look like.
const BASE64_SHAPE_RE = /^[A-Za-z0-9+/]{256,}={0,2}$/;
/** media_type → file extension for the offloaded payload (unknown → bin). */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};
/** Reverse map for the read route's Content-Type. */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain',
};

const MEDIA_HASH_RE = /^[0-9a-f]{16,64}$/;

/** `1.2 MB` style size for the placeholder's human-readable field. */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
// Tail-read window bounds for one archive file. The effective window scales
// with maxBodyBytes (see readWindowBytes): a raised per-body cap must not
// silently shrink replay to a handful of turns. Full history always via
// export (readRawArchive is uncapped).
// The window read is async (fs.promises) and parsing is yield-paced in
// batches, so a large window no longer stalls the event loop while an
// archive read is in flight.
const READ_WINDOW_FLOOR_BYTES = 8 * 1024 * 1024;
const READ_WINDOW_CEIL_BYTES = 48 * 1024 * 1024;

/**
 * Last "completion_tokens" / "output_tokens" occurrence in a response body —
 * streaming SSE repeats it and the final chunk carries the cumulative total
 * (Anthropic message_delta / OpenAI final usage chunk). Derived at read time
 * so metadata-only responses (`bodies=none`) still render per-turn tok/s
 * chips without shipping the body. Hex (binary) bodies are skipped. Manual
 * exec loop: no match-all array for chunked SSE bodies with thousands of
 * usage repeats.
 */
const COMPLETION_TOKENS_RE = /"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g;
const deriveCompletionTokens = (ev: HttpExchangeEvent): void => {
  if (ev.phase !== 'response') return;
  const body = ev.wire?.responseBody;
  if (typeof body !== 'string') return;
  let last: string | null = null;
  COMPLETION_TOKENS_RE.lastIndex = 0;
  for (let m = COMPLETION_TOKENS_RE.exec(body); m; m = COMPLETION_TOKENS_RE.exec(body)) last = m[1];
  if (last !== null) ev.completionTokens = Number(last);
};

/**
 * bodies='none' strips the wire bodies (lines, status, headers kept) —
 * metadata-first reads return KB instead of MB so the console paints the
 * turn list immediately; full bodies arrive on demand via readTurn (per
 * turn) or a bodies=full re-read (conversation lens).
 */
const stripBodies = (events: HttpExchangeEvent[]): void => {
  for (const ev of events) {
    // Partial view of the wire: RawWireCapture declares the bodies required
    // (they are, on disk) — the stripped in-memory copy drops them.
    const wire = ev.wire as Partial<RawWireCapture> | undefined;
    if (wire) {
      delete wire.requestBody;
      delete wire.responseBody;
    }
  }
};

/**
 * Full request/response capture recorder (opt-in audit log).
 *
 * Archives are plain append-only JSONL files, laid out for O(1) retention:
 *   <rootDir>/<YYYY-MM-DD>/<sanitized-sessionId>.jsonl
 * Retention sweeps delete whole date directories — at boot and on an hourly
 * unref'd timer — first by age (retentionDays), then by total size
 * (maxTotalMB, oldest date first).
 *
 * All I/O fails open: a capture problem must never break an inference request.
 * Keeps full bodies (images scrubbed) rather than a redacted summary.
 */
export class CaptureRecorder {
  private enabled: boolean;
  private retentionDays: number;
  private maxTotalBytes: number;
  private maxBodyBytes: number;
  private maxSessionBytes: number;
  private storeMedia: boolean;
  // Per-session seal bookkeeping: cached byte size per archive path + which
  // archives already got their terminal `archive-overflow` line.
  private fileBytesCache = new Map<string, number>();
  private sealedFiles = new Set<string>();
  private rootDir: string;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(config?: RequestCaptureConfig) {
    this.enabled = config?.enabled ?? false;
    this.retentionDays = config?.retentionDays ?? 7;
    // Fallbacks mirror DEFAULT_CONFIG (2048 MB pool / 512 MB per session /
    // 16 MB per body) — a bare `new CaptureRecorder()` must not enforce
    // looser limits than the config.
    this.maxTotalBytes = (config?.maxTotalMB ?? 2048) * 1024 * 1024;
    this.maxBodyBytes = config?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.maxSessionBytes = (config?.maxSessionMB ?? 512) * 1024 * 1024;
    this.storeMedia = config?.storeMedia ?? true;
    this.rootDir = path.resolve(config?.dir || getEnvPaths().captureDir);

    if (this.enabled) {
      this.ensureDir(this.rootDir);
      this.sweep();
      this.startSweepTimer();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getDir(): string {
    return this.rootDir;
  }

  public stop(): void {
    this.stopSweepTimer();
  }

  /**
   * Hot-apply a new capture config at runtime (console toggle / settings save).
   * Persisted separately via saveConfig(); call applyConfig AFTER a successful
   * save so memory matches disk. Enabling creates the archive dir and runs an
   * immediate retention sweep; disabling stops accepting new records and the
   * sweep timer. Existing archive files are never deleted by disabling.
   */
  public applyConfig(cfg?: RequestCaptureConfig): void {
    this.enabled = cfg?.enabled ?? this.enabled;
    this.retentionDays = cfg?.retentionDays ?? this.retentionDays;
    this.maxTotalBytes = (cfg?.maxTotalMB ?? this.maxTotalBytes / (1024 * 1024)) * 1024 * 1024;
    this.maxBodyBytes = cfg?.maxBodyBytes ?? this.maxBodyBytes;
    this.maxSessionBytes = (cfg?.maxSessionMB ?? this.maxSessionBytes / (1024 * 1024)) * 1024 * 1024;
    this.storeMedia = cfg?.storeMedia ?? this.storeMedia;
    const newDir = path.resolve(cfg?.dir || this.rootDir);
    if (newDir !== this.rootDir) {
      this.rootDir = newDir;
      // Seal bookkeeping is keyed by absolute paths under the old root.
      this.fileBytesCache.clear();
      this.sealedFiles.clear();
    }

    if (this.enabled) {
      this.ensureDir(this.rootDir);
      this.startSweepTimer();
      this.sweep();
    } else {
      this.stopSweepTimer();
    }
  }

  /** Idempotent hourly retention sweep timer (unref'd, never blocks exit). */
  private startSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 3_600_000);
    this.sweepTimer.unref?.();
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * @deprecated Use `recordEvent()` instead. The turn-centric `CaptureRecord`
   * model has been superseded by `HttpExchangeEvent` (one event per HTTP
   * side, request and response are independent). `record()` is kept only
   * for back-compat with already-written archive files; the orchestrator
   * no longer calls it. New code MUST use `recordEvent()`.
   */
  public async record(entry: Omit<CaptureRecord, 'id' | 'ts'>): Promise<void> {
    if (!this.enabled) return;

    const request = this.truncateField(entry.request);
    const upstreamRequest = this.truncateField(entry.upstreamRequest);
    const upstreamError = this.truncateField(entry.upstreamError);
    const response = this.truncateField(entry.response);
    // upstreamHttp is a fixed-shape HTTP summary (URL/method/status/headers/
    // ttfb/duration/attemptIndex/wireKind) — bounded by header whitelist, no
    // body payload, so it never approaches maxBodyBytes. Pass through.
    const record: CaptureRecord = {
      ...entry,
      id: `cap_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      ts: Date.now(),
      request: request.value,
      upstreamRequest: upstreamRequest.value,
      upstreamError: upstreamError.value,
      response: response.value,
      truncated:
        request.truncated || upstreamRequest.truncated || upstreamError.truncated || response.truncated || undefined,
    };

    const file = path.join(
      this.rootDir,
      CaptureRecorder.localDateDir(new Date(record.ts)),
      CaptureRecorder.sessionFileName(record.sessionId)
    );

    try {
      this.ensureDir(path.dirname(file));
      await fs.promises.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
    } catch (err: any) {
      console.warn(`[Capture] Failed to append to ${file}: ${err.message}`);
    }
  }

  /**
   * Append one HTTP-exchange event to the event stream. Each HTTP exchange
   * emits TWO events (one request, one response) sharing the same
   * `spanId`. One inference turn typically produces 2-4 events
   * sharing the same `traceId`. Synchronous callers (handler scope,
   * provider scope) can fire this the moment the wire side is known —
   * there is no longer a "wait for the response" barrier before the
   * request side is recorded.
   *
   * Same fail-open contract as `record()`: a capture failure must never
   * break the inference hot path.
   */
  public async recordEvent(event: Omit<HttpExchangeEvent, 'id' | 'ts'>): Promise<void> {
    if (!this.enabled) return;
    const ts = Date.now();

    // Bound wire bodies at the same maxBodyBytes cap as the legacy turn
    // schema — a 10MB request body must not blow past the per-line JSONL
    // budget and starve retention. `WireBody` is `string | { hex: string }`
    // — we count bytes in BOTH forms (UTF-8 string length, hex bytes via
    // halving). Truncation yields the same shape so the field type stays
    // stable for readers.
    const truncateBody = (body: WireBody | undefined): { value: WireBody | undefined; truncated: boolean } => {
      if (body === undefined || body === '') return { value: body, truncated: false };
      const isHex = typeof body === 'object' && body !== null && 'hex' in body;
      const byteLen = isHex ? Math.floor(body.hex.length / 2) : Buffer.byteLength(body as string, 'utf8');
      if (byteLen <= this.maxBodyBytes) return { value: body, truncated: false };
      if (isHex) {
        const hexChars = this.maxBodyBytes * 2;
        return { value: { hex: (body as { hex: string }).hex.slice(0, hexChars) + '...[TRUNCATED]' }, truncated: true };
      }
      // Slice on a BYTE boundary, not a UTF-16 code-unit boundary: CJK text
      // is 3 bytes/char in UTF-8, so `body.slice(0, maxBodyBytes)` could
      // overshoot the byte budget ~3x AND split a surrogate pair. Buffer
      // subarray + toString ends cleanly; a partial trailing codepoint
      // surfaces as U+FFFD — drop it so the byte budget stays strict.
      const buf = Buffer.from(body as string, 'utf8');
      let sliced = buf.subarray(0, this.maxBodyBytes).toString('utf8');
      if (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1);
      return { value: sliced + '...[TRUNCATED]', truncated: true };
    };

    // Scrub base64 media payloads BEFORE the byte-budget cut: the placeholder
    // is ~120 bytes, so the maxBodyBytes window keeps conversation text
    // instead of a resent screenshot's base64, and truncation can no longer
    // slice a payload mid-stream into an unrecoverable fragment. Request
    // bodies only — responses are one-shot per turn, and a generated-image
    // payload in one IS the captured content.
    const dateDir = CaptureRecorder.localDateDir(new Date(ts));
    const truncatedReq = truncateBody(this.scrubMedia(event.wire?.requestBody, dateDir));
    const truncatedResp = truncateBody(event.wire?.responseBody);
    const truncated = truncatedReq.truncated || truncatedResp.truncated || undefined;
    const wire: RawWireCapture = {
      ...event.wire,
      requestBody: truncatedReq.value ?? '',
      responseBody: truncatedResp.value ?? '',
    };

    const full: HttpExchangeEvent & { truncated?: boolean } = {
      ...event,
      id: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      ts,
      wire,
      ...(truncated ? { truncated: true } : {}),
    };

    const file = path.join(
      this.rootDir,
      CaptureRecorder.localDateDir(new Date(ts)),
      CaptureRecorder.sessionFileName(full.sessionId)
    );
    try {
      // Serialization stays INSIDE the try: every call site is
      // `void recorder.recordEvent(...)` with no rejection handler, so a throw
      // here (BigInt / exotic value in an event) would be an unhandled
      // rejection and kill the gateway — capture must fail open, always.
      const line = JSON.stringify(full) + '\n';
      this.ensureDir(path.dirname(file));
      // Per-session seal: agent loops resend full history every turn (O(turns²)
      // growth); one runaway session must not starve the shared retention pool.
      // The budget is SOFT: concurrent events on the same file can each observe
      // the pre-append size, overshooting by roughly one line — the seal exists
      // to bound a runaway loop, not to be an exact quota.
      let bytes = this.fileBytesCache.get(file);
      if (bytes === undefined) {
        try {
          bytes = fs.statSync(file).size;
        } catch {
          bytes = 0;
        }
      }
      if (bytes >= this.maxSessionBytes) {
        if (!this.sealedFiles.has(file)) {
          const seal = JSON.stringify({
            eventType: 'archive-overflow',
            sessionId: full.sessionId,
            traceId: full.traceId,
            ts,
            bytes,
            maxSessionMB: Math.round(this.maxSessionBytes / (1024 * 1024)),
          });
          await fs.promises.appendFile(file, seal + '\n', 'utf8');
          // Only mark sealed AFTER the terminal line lands: if the write fails
          // (disk full) the next event retries the marker instead of leaving
          // the archive permanently undocumented.
          this.sealedFiles.add(file);
          console.warn(`[Capture] Session archive sealed at ${this.maxSessionBytes} bytes (further events dropped): ${file}`);
        }
        return;
      }
      await fs.promises.appendFile(file, line, 'utf8');
      this.fileBytesCache.set(file, bytes + Buffer.byteLength(line, 'utf8'));
    } catch (err: any) {
      console.warn(`[Capture] Failed to append event to ${file}: ${err.message}`);
    }
  }

  /* -------------------------------------------------------------- queries */

  /**
   * Effective tail-read window: 3× the per-body cap (worst case a few turns
   * per window line set), floored at the historical 8 MB and ceilinged at
   * 48 MB so console reads stay memory-bounded at any cap.
   */
  private readWindowBytes(): number {
    return Math.min(Math.max(READ_WINDOW_FLOOR_BYTES, this.maxBodyBytes * 3), READ_WINDOW_CEIL_BYTES);
  }

  public getStatus(): CaptureStatus {
    const dates = this.listDates();
    return {
      enabled: this.enabled,
      dir: this.rootDir,
      retentionDays: this.retentionDays,
      maxTotalMB: Math.round(this.maxTotalBytes / (1024 * 1024)),
      maxBodyBytes: this.maxBodyBytes,
      maxSessionMB: Math.round(this.maxSessionBytes / (1024 * 1024)),
      storeMedia: this.storeMedia,
      totalBytes: dates.reduce((sum, d) => sum + d.bytes, 0),
      dateCount: dates.length,
    };
  }

  /** Date directories, newest first. */
  public listDates(): CaptureDateRow[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const rows: CaptureDateRow[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !DATE_DIR_RE.test(e.name)) continue;
      let sessions = 0;
      let bytes = 0;
      try {
        for (const f of fs.readdirSync(path.join(this.rootDir, e.name), { withFileTypes: true })) {
          if (!f.isFile() || !f.name.endsWith(JSONL_SUFFIX)) continue;
          sessions++;
          try {
            bytes += fs.statSync(path.join(this.rootDir, e.name, f.name)).size;
          } catch {
            // File vanished mid-sweep — skip.
          }
        }
      } catch {
        continue;
      }
      rows.push({ date: e.name, sessions, bytes });
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }

  /** Session archive files inside one date directory, most recently written first.
   *  `apiKeyFilter` (optional) keeps sessions whose events carry the given key:
   *  membership over the archive's DISTINCT key set (a session that rotated
   *  keys mid-way is found under both old and new id — the row's `apiKey`
   *  display anchor is only the first). Match: exact id OR case-insensitive
   *  name substring — the console's per-application retrieval. */
  public listSessions(date: string, apiKeyFilter?: string): CaptureSessionRow[] {
    if (!DATE_DIR_RE.test(date)) return [];
    // Self-defensive trim: retrieval semantics must not depend on caller
    // discipline (the routes trim, but the public API owns its contract).
    apiKeyFilter = apiKeyFilter?.trim() || undefined;
    const dir = path.join(this.rootDir, date);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const rows: CaptureSessionRow[] = [];
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith(JSONL_SUFFIX)) continue;
      try {
        const filePath = path.join(dir, f.name);
        const st = fs.statSync(filePath);
        // Per-session outcome tally for the console badges. Two line formats
        // share the archive:
        //   - legacy cap_ turn records (one line per turn): counted directly.
        //   - evt_ http-exchange events (2-4 lines per turn): collected and
        //     grouped via groupEventsIntoTurns, so a turn counts once no
        //     matter how many of its events carry an error status.
        let turns = 0;
        let failed = 0;
        let lastStatus: 'ok' | 'error' | undefined;
        let preview: string | undefined;
        // Key attribution: collect the DISTINCT identities seen in the
        // archive (write order). Single-key sessions → one entry; rotated /
        // mixed-key sessions → the full set so per-app retrieval matches
        // every app that contributed. Legacy lines carry no apiKey.
        const seenKeys = new Map<string, CaptureKeyIdentity>();
        let conversationKey: string | undefined;
        const streamEvents: HttpExchangeEvent[] = [];
        try {
          // Ceiling: the tally needs EVERY line, so this is an uncapped
          // synchronous read bounded only by the per-session seal
          // (maxSessionMB, default 512 MB) — a date full of sealed-maximum
          // sessions can stall the event loop for seconds per listing.
          // Accepted: admin-console surface, operator-initiated, and the seal
          // is what keeps the worst case finite. Upgrade path: stream the file
          // in chunks (createReadStream + line splitter) or keep an on-disk
          // per-file turn counter.
          const content = fs.readFileSync(filePath, 'utf8');
          for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const rec = JSON.parse(line);
              // Terminal seal marker — metadata, never a turn. Skipping it here
              // keeps the legacy else-branch below from counting it as a
              // phantom turn (the same bug class as event lines vs turns).
              if (rec.eventType === 'archive-overflow') continue;
              if (rec.eventType === 'http-exchange') {
                streamEvents.push(rec as HttpExchangeEvent);
                if (rec.apiKey && rec.apiKey.id && !seenKeys.has(String(rec.apiKey.id))) {
                  seenKeys.set(String(rec.apiKey.id), {
                    id: String(rec.apiKey.id),
                    name: String(rec.apiKey.name ?? ''),
                  });
                }
                if (conversationKey === undefined && typeof rec.conversationKey === 'string' && rec.conversationKey) {
                  conversationKey = rec.conversationKey;
                }
                // First client request body = the session's opening turn.
                // extractSessionPreview also accepts the raw string form
                // (it strips a "...[TRUNCATED]" tail and repairs the cut
                // JSON), so pass the wire body through unparsed.
                if (
                  preview === undefined &&
                  rec.direction === 'client' &&
                  rec.phase === 'request' &&
                  rec.wire?.requestBody !== undefined
                ) {
                  preview = CaptureRecorder.extractSessionPreview(rec.wire.requestBody);
                }
              } else {
                turns++;
                const status = rec.status;
                if (status === 'error') failed++;
                if (status === 'ok' || status === 'error') lastStatus = status;
                // Files are append-only, so the first line with a request body
                // is the session's opening turn — capture its user text once.
                if (preview === undefined && rec.request !== undefined) {
                  preview = CaptureRecorder.extractSessionPreview(rec.request);
                }
              }
            } catch {
              // Corrupt line — counts as a turn but not a failure.
              turns++;
            }
          }
          // groupEventsIntoTurns returns chronological turns; iterate in
          // order so lastStatus reflects the FINAL turn's outcome.
          for (const t of CaptureRecorder.groupEventsIntoTurns(streamEvents)) {
            turns++;
            const hasError =
              Boolean(t.error) ||
              [t.clientRequest, t.gatewayResponse, t.upstreamRequest, t.upstreamResponse]
                .some(e => e?.status === 'error');
            if (hasError) failed++;
            if (t.gatewayResponse) lastStatus = t.gatewayResponse.status === 'error' ? 'error' : 'ok';
            else if (hasError) lastStatus = 'error';
          }
        } catch {
          // Read failed — return metadata without the tally.
        }
        const keyList = [...seenKeys.values()];
        rows.push({
          file: f.name,
          sessionId: f.name.slice(0, -JSONL_SUFFIX.length),
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          turns,
          failed,
          lastStatus,
          preview,
          ...(keyList.length ? { apiKeys: keyList } : {}),
          ...(conversationKey ? { conversationKey } : {}),
        });
      } catch {
        // Vanished mid-listing — skip.
      }
    }
    const filtered = !apiKeyFilter
      ? rows
      : rows.filter(r =>
          // Membership over the distinct key set — a session that rotated
          // keys stays findable under every key that contributed.
          r.apiKeys?.some(k => k.id === apiKeyFilter || k.name.toLowerCase().includes(apiKeyFilter.toLowerCase()))
        );
    return filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * Read records from one archive file, newest `limit` records in
   * chronological order. Reads at most the last readWindowBytes() of the file.
   */
  public readRecords(
    date: string,
    file: string,
    limit = 200
  ): { records: CaptureRecord[]; totalLines: number; fileTruncated: boolean } {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return { records: [], totalLines: 0, fileTruncated: false };

    try {
      const st = fs.statSync(filePath);
      const readSize = Math.min(st.size, this.readWindowBytes());
      const fd = fs.openSync(filePath, 'r');
      let text: string;
      try {
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, st.size - readSize);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }

      const lines = text.split(/\r?\n/);
      const fileTruncated = readSize < st.size;
      // Drop the first (likely partial) line when sliced mid-line.
      if (fileTruncated && lines.length > 0) lines.shift();

      const records: CaptureRecord[] = [];
      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const rec = JSON.parse(raw);
          // The seal marker is metadata, not a turn — the legacy timeline must
          // not grow a phantom record for it.
          if (rec?.eventType === 'archive-overflow') continue;
          records.push(rec);
        } catch {
          // Corrupt/partial line — skip, never fail the whole read.
        }
      }
      return { records: records.slice(-Math.max(1, limit)), totalLines: records.length, fileTruncated };
    } catch {
      return { records: [], totalLines: 0, fileTruncated: false };
    }
  }

  /**
   * Read the last `readWindowBytes()` of one archive and parse its
   * http-exchange events. Async and yield-paced: the window can be tens of
   * MB and per-line JSON.parse is CPU-bound — parsing in batches with
   * event-loop yields keeps the gateway responsive while an archive read is
   * in flight. Never fails: corrupt lines are skipped.
   */
  private async readWindowEvents(
    date: string,
    file: string
  ): Promise<{ events: HttpExchangeEvent[]; fileTruncated: boolean }> {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return { events: [], fileTruncated: false };

    let text: string;
    let fileTruncated = false;
    try {
      const st = await fs.promises.stat(filePath);
      const readSize = Math.min(st.size, this.readWindowBytes());
      const fh = await fs.promises.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(readSize);
        await fh.read(buf, 0, readSize, st.size - readSize);
        text = buf.toString('utf8');
      } finally {
        await fh.close();
      }
      fileTruncated = readSize < st.size;
    } catch {
      return { events: [], fileTruncated: false };
    }

    const lines = text.split(/\r?\n/);
    if (fileTruncated && lines.length > 0) lines.shift();

    const events: HttpExchangeEvent[] = [];
    const yieldLoop = () => new Promise<void>(r => setImmediate(r));
    const BATCH = 128; // lines per event-loop slice
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj.eventType === 'http-exchange') {
          const ev = obj as unknown as HttpExchangeEvent;
          deriveCompletionTokens(ev);
          events.push(ev);
        }
        // cap_xxx entries (turn-centric) are skipped — the console reads
        // those via /api/admin/capture/:date/:file (readRecords path).
      } catch {
        // Corrupt/partial line — skip, never fail the whole read.
      }
      if ((i + 1) % BATCH === 0) await yieldLoop();
    }
    return { events, fileTruncated };
  }

  /**
   * Read HTTP exchange events from one archive file, newest `limit` events
   * in chronological order. Returns events + a `turns` summary that
   * groups the events by `traceId` (spanId-aware) so the console can
   * render them as logical turns. The underlying file is also bounded at
   * readWindowBytes() (pathologically large archives are tailed; the tail is
   * what matters). `bodies='none'` strips wire bodies for metadata-first
   * console reads — the tok/s chips keep working via the derived
   * `completionTokens` field, and full bodies come back on demand
   * (readTurn / bodies='full').
   */
  public async readEvents(
    date: string,
    file: string,
    limit = 500,
    bodies: 'full' | 'none' = 'full'
  ): Promise<{
    events: HttpExchangeEvent[];
    turns: CaptureTurnSummary[];
    totalLines: number;
    /** Logical turn count over ALL events in the read window (totalLines is
     * raw event lines — 2-4 per turn — so it must never be shown as turns). */
    totalTurns: number;
    fileTruncated: boolean;
  }> {
    const { events, fileTruncated } = await this.readWindowEvents(date, file);
    if (bodies === 'none') stripBodies(events);

    let newest = events.slice(-Math.max(1, limit));
    // Don't cut a turn in half: when the window starts mid-turn, the
    // leading events (upstream/gateway responses whose client-request fell
    // outside the window) would form a phantom incomplete turn with no
    // latency — drop everything before the first turn-start in the window.
    const firstTurnStart = newest.findIndex(e => e.direction === 'client' && e.phase === 'request');
    if (firstTurnStart > 0) newest = newest.slice(firstTurnStart);
    const turns = CaptureRecorder.groupEventsIntoTurns(newest);
    // Total logical turns over the whole read window — the header's turn count
    // must use this, not totalLines (raw event lines, 2-4 per turn).
    const totalTurns = CaptureRecorder.groupEventsIntoTurns(events).length;
    return { events: newest, turns, totalLines: events.length, totalTurns, fileTruncated };
  }

  /**
   * Read one turn's FULL wire bodies by the id of any of its events (the
   * console passes the client-request event id). The metadata-first console
   * flow fetches the heavy bodies here when a turn is opened. Returns null
   * when the id is unknown or falls outside the read window.
   */
  public async readTurn(
    date: string,
    file: string,
    eventId: string
  ): Promise<{ turn: CaptureTurnSummary } | null> {
    const { events } = await this.readWindowEvents(date, file);
    const anchor = events.find(e => e.id === eventId);
    if (!anchor) return null;
    const subset = events.filter(e => e.traceId === anchor.traceId);
    const turns = CaptureRecorder.groupEventsIntoTurns(subset);
    const turn = turns.find(t =>
      [t.clientRequest, t.gatewayResponse, t.upstreamRequest, t.upstreamResponse, t.decisionRequest, t.decisionResponse].some(
        e => e?.id === eventId
      )
    );
    return turn ? { turn } : null;
  }

  /**
   * Group a flat list of HTTP exchange events into logical turns via
   * `traceId`. Each turn joins its four events: client-direction events
   * pair by `spanId`, upstream events attach to the trace's active turn
   * (last-write-wins across failover hops). SpanId-aware because a client
   * that sends a CONSTANT `x-request-id` on every request would otherwise
   * collapse the whole session into one turn.
   * Pure function — exported for unit tests.
   */
  public static groupEventsIntoTurns(events: HttpExchangeEvent[]): CaptureTurnSummary[] {
    const byTrace = new Map<string, CaptureTurnSummary[]>();
    /** traceId → the turn upstream events should attach to (the latest). */
    const activeByTrace = new Map<string, CaptureTurnSummary>();

    const newTurn = (ev: HttpExchangeEvent): CaptureTurnSummary => {
      const t: CaptureTurnSummary = { traceId: ev.traceId, sessionId: ev.sessionId, model: ev.model };
      let list = byTrace.get(ev.traceId);
      if (!list) {
        list = [];
        byTrace.set(ev.traceId, list);
      }
      list.push(t);
      return t;
    };

    for (const ev of events) {
      let t: CaptureTurnSummary | undefined;
      if (ev.direction === 'client' && ev.phase === 'request') {
        // A client request ALWAYS starts a new turn — even when the traceId
        // was already seen (a client sending a constant x-request-id on
        // every request gets one turn per request, not one giant merged
        // turn with last-write-wins fields).
        t = newTurn(ev);
        t.clientRequest = ev;
        activeByTrace.set(ev.traceId, t);
      } else if (ev.direction === 'client' && ev.phase === 'response') {
        // Pair by spanId with the matching client request (newest first —
        // the common case is the latest turn of the trace).
        const list = byTrace.get(ev.traceId) ?? [];
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].clientRequest?.spanId === ev.spanId) {
            t = list[i];
            break;
          }
        }
        if (!t) t = newTurn(ev); // response whose request fell outside the read window
        t.gatewayResponse = ev;
      } else if (ev.purpose === 'l2-decision') {
        // The L2 decision layer's HTTP leg shares the routed turn's trace but is NOT
        // failover traffic — route it to dedicated slots so the serving
        // leg's last-write-wins below never overwrites it. The decision layer fires
        // BEFORE candidate execution, so a plain upstream merge would erase
        // it and the console would only ever show one upstream call.
        t = activeByTrace.get(ev.traceId);
        if (!t) {
          t = newTurn(ev);
          activeByTrace.set(ev.traceId, t);
        }
        if (ev.phase === 'request') t.decisionRequest = ev;
        else t.decisionResponse = ev;
      } else {
        // Upstream events attach to the trace's active turn. Failover hops
        // overwrite each other (last-write-wins) — the final attempt is
        // the one that produced the gateway response.
        t = activeByTrace.get(ev.traceId);
        if (!t) {
          t = newTurn(ev);
          activeByTrace.set(ev.traceId, t);
        }
        if (ev.phase === 'request') t.upstreamRequest = ev;
        else t.upstreamResponse = ev;
      }
      if (ev.error && !t.error) t.error = ev.error;
    }
    const all: CaptureTurnSummary[] = [];
    for (const list of byTrace.values()) all.push(...list);
    for (const t of all) {
      if (t.clientRequest && t.gatewayResponse) {
        t.gatewayLatencyMs = t.gatewayResponse.ts - t.clientRequest.ts;
      }
      if (t.upstreamRequest && t.upstreamResponse) {
        t.upstreamLatencyMs = t.upstreamResponse.ts - t.upstreamRequest.ts;
      }
      if (t.decisionRequest && t.decisionResponse) {
        t.decisionLatencyMs = t.decisionResponse.ts - t.decisionRequest.ts;
      }
      // TTFT / decode window per leg: the response event's firstByteTs splits
      // the cycle latency into wait-for-first-token and decode phases. Derived
      // only when the stamp exists (streamed legs; pre-stamp events stay
      // undefined so the console shows '—' instead of a synthesized split).
      const derive = (req: HttpExchangeEvent, resp: HttpExchangeEvent): { ttft?: number; gen?: number } => {
        if (resp.firstByteTs === undefined) return {};
        return {
          ttft: Math.max(0, resp.firstByteTs - req.ts),
          gen: Math.max(0, resp.ts - resp.firstByteTs),
        };
      };
      if (t.clientRequest && t.gatewayResponse) {
        const d = derive(t.clientRequest, t.gatewayResponse);
        t.gatewayTtftMs = d.ttft;
        t.gatewayGenMs = d.gen;
      }
      if (t.upstreamRequest && t.upstreamResponse) {
        const d = derive(t.upstreamRequest, t.upstreamResponse);
        t.upstreamTtftMs = d.ttft;
        t.upstreamGenMs = d.gen;
      }
      if (t.decisionRequest && t.decisionResponse) {
        const d = derive(t.decisionRequest, t.decisionResponse);
        t.decisionTtftMs = d.ttft;
        t.decisionGenMs = d.gen;
      }
    }
    return all.sort((a, b) => {
      const aTs = a.clientRequest?.ts ?? a.upstreamRequest?.ts ?? 0;
      const bTs = b.clientRequest?.ts ?? b.upstreamRequest?.ts ?? 0;
      return aTs - bTs;
    });
  }

  /**
   * Read the raw JSONL archive verbatim (for export/download). Unlike
   * readRecords this is NOT capped at the read window — exports should be
   * complete; per-line size is already bounded by maxBodyBytes at write time,
   * and total size by the per-session seal (maxSessionMB). The whole file is
   * read synchronously: a max-sealed session is a 512 MB buffer on the admin
   * route. Accepted for an operator-initiated export; upgrade path is a
   * streaming download (createReadStream piped to the reply).
   *
   * When `exclude` is non-empty, body fields are stripped and the rest is
   * re-serialized — metadata (ts/status/model/routing/ids) always survives.
   * Handles both line formats:
   *   - legacy cap_ turn records: `request` / `upstreamRequest` / `response`
   *     / `upstreamError` fields are deleted directly.
   *   - evt_ http-exchange events: the same exclude names map onto the
   *     matching wire side (`request` → client request body,
   *     `upstreamRequest`/`upstreamHttp` → upstream request body,
   *     `response`/`upstreamError` → response bodies + the error field).
   * Corrupt lines are kept verbatim, same fail-open policy as every read.
   */
  public readRawArchive(date: string, file: string, exclude?: string[]): string | null {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!exclude || exclude.length === 0) return raw;
      const drop = new Set(exclude);
      const out: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as Record<string, any>;
          if (rec.eventType === 'http-exchange' && rec.wire) {
            if (drop.has('request') && rec.direction === 'client' && rec.phase === 'request') {
              rec.wire.requestBody = '';
            }
            if ((drop.has('upstreamRequest') || drop.has('upstreamHttp')) && rec.direction === 'upstream' && rec.phase === 'request') {
              rec.wire.requestBody = '';
            }
            if ((drop.has('response') || drop.has('upstreamError')) && rec.phase === 'response') {
              rec.wire.responseBody = '';
            }
            if (drop.has('upstreamError')) delete rec.error;
          } else {
            for (const f of drop) delete rec[f];
          }
          out.push(JSON.stringify(rec));
        } catch {
          out.push(line);
        }
      }
      return out.length > 0 ? out.join('\n') + '\n' : '';
    } catch {
      return null;
    }
  }

  /**
   * Find archive files for one session id across ALL date directories.
   * The raw id goes to sessionFileName() unmodified — the exact call the
   * write path makes — so read and write names are equal by construction.
   * Deliberately no trim/length cap here: the write side applies neither,
   * and silently bailing on long ids used to blind the cascade to every
   * hashed archive over 512 chars. Hashed names keep long ids path-safe.
   * Boundary normalization (trim/require) stays in the route handlers that
   * own the input (console find-session; session ids are already trimmed at
   * resolveSessionId intake). Name-only readdir scan — zero body reads
   * (listSessions would parse every archive just to match a file name).
   * Exact name match: sessionFileName is deterministic, so case-insensitive
   * FS variants cannot diverge. Newest archive first (listDates is newest-first).
   */
  public findBySession(sessionId: string): CaptureSessionMatch[] {
    if (typeof sessionId !== 'string' || sessionId === '') return [];
    const fileName = CaptureRecorder.sessionFileName(sessionId);
    const matches: CaptureSessionMatch[] = [];
    for (const d of this.listDates()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(this.rootDir, d.date), { withFileTypes: true });
      } catch {
        continue; // Date dir vanished mid-scan — fail open like listDates.
      }
      if (entries.some(e => e.isFile() && e.name === fileName)) {
        matches.push({ date: d.date, file: fileName });
      }
    }
    return matches;
  }

  /**
   * Drop the per-session seal bookkeeping for one archive path, or for every
   * path under a directory prefix. Must run whenever a file disappears
   * (console delete, retention sweep) or the root moves: a cached size from a
   * deleted file would seal its replacement at the first event, and a stale
   * `sealedFiles` entry would suppress the seal marker forever. Sizes cached
   * under an old root are keyed by absolute path, so they are simply dropped.
   */
  private forgetSealState(target: string, asDir = false): void {
    const drop = (p: string) => {
      this.fileBytesCache.delete(p);
      this.sealedFiles.delete(p);
    };
    if (!asDir) {
      drop(target);
      return;
    }
    const prefix = path.resolve(target) + path.sep;
    for (const p of [...this.fileBytesCache.keys()]) if (p.startsWith(prefix)) drop(p);
  }

  /** Delete one whole date directory. Returns true when it existed. */
  public deleteDate(date: string): boolean {
    if (!DATE_DIR_RE.test(date)) return false;
    const dir = path.join(this.rootDir, date);
    if (!path.resolve(dir).startsWith(path.resolve(this.rootDir) + path.sep)) return false;
    if (!fs.existsSync(dir)) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      this.forgetSealState(dir, true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete one session archive file inside a date directory. Returns true
   * when it existed. resolveArchiveFile validates date/file (suffix,
   * traversal) and existence, so this cannot escape the date dir.
   */
  public deleteSession(date: string, file: string): boolean {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return false;
    try {
      fs.rmSync(filePath, { force: true });
      this.forgetSealState(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------ retention */

  /**
   * Sweep retention: delete date directories older than the retention window,
   * then — if the archive still exceeds maxTotalBytes — delete oldest dates
   * first until it fits. Whole-directory deletes keep this O(dirs), not
   * O(records).
   */
  public sweep(): void {
    let dates: CaptureDateRow[];
    try {
      dates = this.listDates();
    } catch {
      return;
    }
    if (dates.length === 0) return;

    // 1. Age-based: cutoff date string compares correctly in YYYY-MM-DD form.
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000);
    const cutoffStr = CaptureRecorder.localDateDir(cutoff);
    const kept: CaptureDateRow[] = [];
    for (const d of dates) {
      if (d.date < cutoffStr) {
        this.deleteDate(d.date);
      } else {
        kept.push(d);
      }
    }

    // 2. Size-based: listDates is newest-first, so trim from the tail (oldest).
    let totalBytes = kept.reduce((sum, d) => sum + d.bytes, 0);
    for (let i = kept.length - 1; i >= 0 && totalBytes > this.maxTotalBytes; i--) {
      if (this.deleteDate(kept[i].date)) {
        totalBytes -= kept[i].bytes;
      }
    }
  }

  /* ------------------------------------------------------------- helpers */

  private truncateField(value: unknown): { value: unknown; truncated: boolean } {
    if (value === undefined || value === null) return { value: undefined, truncated: false };
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      return { value: '[unserializable]', truncated: false };
    }
    if (Buffer.byteLength(json, 'utf8') <= this.maxBodyBytes) {
      return { value, truncated: false };
    }
    // Approximate byte-budget slicing on the JSON string; stored as a plain
    // string because truncated JSON is not parseable anyway.
    return { value: json.slice(0, this.maxBodyBytes) + '...[TRUNCATED]', truncated: true };
  }

  /* ------------------------------------------------------------ media scrub */

  /**
   * Replace base64 media payloads in a JSON request body with `[MEDIA …]`
   * placeholders and offload the bytes to content-addressed files under
   * `<rootDir>/<dateDir>/media/<sha256>.<ext>` (when storeMedia is on).
   * Handles OpenAI `image_url.url` data URLs, Anthropic `image`/`document`
   * `source.data` blocks, and any long base64-shaped string as a fallback.
   * Fail-open on every level: non-string bodies (hex dumps), non-JSON text,
   * and parse errors all pass through UNTOUCHED — a capture problem must
   * never break the inference hot path, and never silently drop the payload
   * either (worst case the archive keeps the base64 it started with).
   */
  private scrubMedia(body: WireBody | undefined, dateDir: string): WireBody | undefined {
    if (typeof body !== 'string') return body;
    // Cheap guard: the two substrings that must appear for any handled shape
    // (the 'base64' tag/type and the data-URL prefix). Bodies without them
    // are archived without a parse pass.
    if (!body.includes('base64') && !body.includes('data:image')) return body;
    try {
      const obj = JSON.parse(body) as unknown;
      if (!obj || typeof obj !== 'object') return body;
      return this.walkScrubMedia(obj, dateDir) ? JSON.stringify(obj) : body;
    } catch {
      return body;
    }
  }

  /** Recursive walk; mutates matching string values in place. Returns changed. */
  private walkScrubMedia(node: unknown, dateDir: string, depth = 0): boolean {
    if (depth > 24 || node === null || typeof node !== 'object') return false;
    let changed = false;
    if (Array.isArray(node)) {
      for (const item of node) changed = this.walkScrubMedia(item, dateDir, depth + 1) || changed;
      return changed;
    }
    const o = node as Record<string, any>;
    // OpenAI chat: {type:'image_url', image_url:{url:'data:image/png;base64,…'}}
    if (o.image_url && typeof o.image_url === 'object' && typeof o.image_url.url === 'string') {
      const rep = this.scrubMediaValue(o.image_url.url, dateDir);
      if (rep !== null) {
        o.image_url.url = rep;
        changed = true;
      }
    }
    // Anthropic: {type:'image'|'document', source:{type:'base64', media_type, data}}
    if ((o.type === 'image' || o.type === 'document') && o.source && typeof o.source === 'object') {
      const mime = typeof o.source.media_type === 'string' ? o.source.media_type : undefined;
      if (o.source.type === 'base64' && typeof o.source.data === 'string') {
        const rep = this.scrubMediaValue(o.source.data, dateDir, mime);
        if (rep !== null) {
          o.source.data = rep;
          changed = true;
        }
      }
    }
    // Generic fallback: any strict-alphabet ≥256-char string value (audio
    // blobs, inline tool payloads) — replaces the bytes, mime unknown.
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (BASE64_SHAPE_RE.test(v) || (v.startsWith('data:') && v.includes(';base64,'))) {
          const rep = this.scrubMediaValue(v, dateDir);
          if (rep !== null) {
            o[k] = rep;
            changed = true;
          }
        }
      } else {
        changed = this.walkScrubMedia(v, dateDir, depth + 1) || changed;
      }
    }
    return changed;
  }

  /**
   * Build the placeholder for one base64 payload (optionally inside a data
   * URL), offloading the bytes when storeMedia is on. Returns null when the
   * value is not a scrubbable payload (http(s) data URL, short string,
   * non-base64) so callers keep the original.
   */
  private scrubMediaValue(s: string, dateDir: string, mimeHint?: string): string | null {
    let mime = mimeHint;
    let payload = s;
    if (s.startsWith('data:')) {
      const comma = s.indexOf(',');
      if (comma < 0) return null;
      const meta = s.slice(5, comma); // e.g. "image/png;base64"
      if (!/;base64$/i.test(meta)) return null; // non-base64 data URL — keep
      mime = mime || meta.replace(/;base64$/i, '') || undefined;
      payload = s.slice(comma + 1);
    }
    if (!BASE64_SHAPE_RE.test(payload)) return null;
    // node's base64 decode never throws (lenient); a fully-ignored payload
    // yields an empty buffer and is kept unscrubbed rather than placeholdered.
    const raw = Buffer.from(payload, 'base64');
    if (raw.length === 0) return null;
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    const ext = MIME_TO_EXT[(mime ?? '').toLowerCase()] ?? 'bin';
    const file = this.storeMediaFile(raw, sha, ext, dateDir);
    const head = `[MEDIA ${mime ?? 'unknown'} ${humanBytes(raw.length)} sha256=${sha.slice(0, 16)}`;
    // No file= segment when the switch is off or the write failed — the
    // placeholder still marks the payload and its identity.
    return file ? `${head} file=${file}]` : `${head}]`;
  }

  /**
   * Persist one decoded payload under the date dir's media/ (atomic
   * tmp+rename; the existsSync short-circuit is the dedupe: a screenshot
   * resent across 20 turns lands once). Returns the archive-relative
   * pointer, or null on any failure (fail-open: caller emits the
   * placeholder without file=).
   */
  private storeMediaFile(raw: Buffer, sha: string, ext: string, dateDir: string): string | null {
    if (!this.storeMedia) return null;
    const dir = path.join(this.rootDir, dateDir, MEDIA_SUBDIR);
    const name = `${sha}.${ext}`;
    const fp = path.join(dir, name);
    try {
      if (fs.existsSync(fp)) return `${MEDIA_SUBDIR}/${name}`;
      this.ensureDir(dir);
      const tmp = `${fp}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      try {
        fs.writeFileSync(tmp, raw);
        fs.renameSync(tmp, fp);
      } catch (inner: any) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* tmp already gone */
        }
        console.warn(`[Capture] media write failed for ${name}: ${inner.message}`);
        return null;
      }
      return `${MEDIA_SUBDIR}/${name}`;
    } catch (err: any) {
      console.warn(`[Capture] media store error for ${name}: ${err.message}`);
      return null;
    }
  }

  /**
   * Read one offloaded media file by its date dir + hash prefix (16–64 hex,
   * matched against the content-addressed file name `<hash>.<ext>`). The
   * strict regexes make path traversal impossible: neither date nor hash can
   * carry separators or dots. Null = not found / invalid.
   */
  public getMediaFile(date: string, hash: string): { data: Buffer; contentType: string; fileName: string } | null {
    if (!DATE_DIR_RE.test(date) || !MEDIA_HASH_RE.test(hash)) return null;
    const dir = path.join(this.rootDir, date, MEDIA_SUBDIR);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const name = names
      .sort()
      .find(n => {
        const stem = n.slice(0, n.lastIndexOf('.'));
        // Full hash hits exactly; a shorter (16-hex) placeholder hash hits the
        // unique stem that carries it as a prefix.
        return stem === hash || (stem.length === 64 && stem.startsWith(hash));
      });
    if (!name || !MEDIA_FILE_RE.test(name)) return null;
    try {
      const data = fs.readFileSync(path.join(dir, name));
      const ext = name.slice(name.lastIndexOf('.') + 1);
      return { data, contentType: EXT_TO_MIME[ext] ?? 'application/octet-stream', fileName: name };
    } catch {
      return null;
    }
  }

  private resolveArchiveFile(date: string, file: string): string | null {
    if (!DATE_DIR_RE.test(date)) return null;
    if (!file || !file.endsWith(JSONL_SUFFIX)) return null;
    if (file.includes('/') || file.includes('\\') || file.includes('..') || file.includes('\0')) return null;
    const dir = path.join(this.rootDir, date);
    const filePath = path.join(dir, file);
    // Defense in depth: the resolved path must stay inside the date dir.
    if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) return null;
    return fs.existsSync(filePath) ? filePath : null;
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // Ignore mkdir errors — appendFile will fail open with a warn.
      }
    }
  }

  /**
   * Filesystem-safe archive file name for a (client-controlled) session id.
   * Single source of truth for write AND read naming (findBySession calls
   * this verbatim) — names match by construction, no per-side normalization.
   * HASH_NAME_RE (see definition) forces literal `h_<16hex>` ids through the
   * hash branch so they can never alias another session's hashed archive.
   * Migration: archives written before that guard for a literal `h_<16hex>`
   * id keep their old verbatim name and become read-side orphans (findBySession
   * now resolves that id to the hash-of-hash name). They stay visible and
   * deletable through the captures directory browser, and the retention sweep
   * backstops them — existing files are never rewritten or migrated.
   */
  public static sessionFileName(sessionId: string): string {
    if (SAFE_SESSION_RE.test(sessionId) && !HASH_NAME_RE.test(sessionId)) return sessionId + JSONL_SUFFIX;
    const hash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    return `h_${hash}${JSONL_SUFFIX}`;
  }

  /**
   * First user-message text from a captured request body — what makes a
   * session recognizable in the console list. Handles the shapes that reach
   * the archive: OpenAI/Anthropic chat (`messages`, content as string or
   * text-part array), Responses API (`input`), and the truncated-string
   * form stored when a body exceeded maxBodyBytes. Fails open to undefined.
   */
  public static extractSessionPreview(request: unknown, cap = 120): string | undefined {
    const text = CaptureRecorder.firstUserText(request);
    if (!text) return undefined;
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return undefined;
    return flat.length <= cap ? flat : flat.slice(0, cap - 1) + '…';
  }

  private static firstUserText(request: unknown, depth = 0): string | undefined {
    if (request === null || request === undefined || depth > 2) return undefined;
    if (typeof request === 'string') {
      // Truncated bodies are stored as `JSON.slice(0, cap) + '...[TRUNCATED]'`
      // — strip the suffix, then try verbatim parse, then a bracket-repair
      // pass (long sessions exceed maxBodyBytes often, and their opening
      // user message is usually inside the intact prefix).
      const trimmed = request.endsWith(TRUNCATION_SUFFIX)
        ? request.slice(0, -TRUNCATION_SUFFIX.length)
        : request;
      try {
        return CaptureRecorder.firstUserText(JSON.parse(trimmed), depth + 1);
      } catch {
        const repaired = CaptureRecorder.repairTruncatedJson(trimmed);
        if (repaired !== null) return CaptureRecorder.firstUserText(repaired, depth + 1);
        return trimmed.slice(0, 300);
      }
    }
    if (typeof request !== 'object') return undefined;
    const body = request as Record<string, unknown>;
    if (Array.isArray(body.messages)) return CaptureRecorder.userTextFromMessages(body.messages);
    if (Array.isArray(body.input)) return CaptureRecorder.userTextFromMessages(body.input);
    if (typeof body.input === 'string') return body.input;
    return undefined;
  }

  /**
   * Best-effort recovery of the largest well-formed prefix of a truncated
   * JSON document: walk once tracking string state and the brace stack,
   * recording every position where the structure was balanced, then try
   * candidates newest-first — cut there and close the remaining open
   * containers. Newest-first matters: the newest balanced prefix may end on
   * a value-less key (e.g. `{"a":1,"more"`), which is unparseable, while an
   * older candidate closes cleanly. Returns null when nothing parseable can
   * be salvaged.
   */
  private static repairTruncatedJson(s: string): string | null {
    const stack: string[] = [];
    const cuts: { end: number; stack: string[] }[] = [];
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') {
          inStr = false;
          cuts.push({ end: i, stack: [...stack] });
        }
      } else if (c === '"') {
        inStr = true;
      } else if (c === '{' || c === '[') {
        stack.push(c === '{' ? '}' : ']');
      } else if (c === '}' || c === ']') {
        stack.pop();
        cuts.push({ end: i, stack: [...stack] });
      }
    }
    for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 16; k--) {
      const { end, stack: open } = cuts[k];
      const repaired = s.slice(0, end + 1) + open.slice().reverse().join('');
      try {
        JSON.parse(repaired);
        return repaired;
      } catch {
        // Try the next-older balanced prefix.
      }
    }
    return null;
  }

  /** First role === 'user' entry; content as string or text-part array. */
  private static userTextFromMessages(messages: unknown[]): string | undefined {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const msg = m as Record<string, unknown>;
      if (msg.role !== 'user') continue;
      const content = msg.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const parts = content
          .map(p => (p && typeof p === 'object' && typeof (p as any).text === 'string' ? (p as any).text : ''))
          .filter(Boolean);
        if (parts.length > 0) return parts.join(' ');
        continue; // non-text parts only (images etc.) — try the next user message
      }
      continue; // missing/non-text content (tool calls etc.) — try the next user message
    }
    return undefined;
  }

  /** Local-timezone YYYY-MM-DD — retention is by calendar day as users see it. */
  public static localDateDir(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
