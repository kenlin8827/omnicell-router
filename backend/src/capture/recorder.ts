import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RequestCaptureConfig } from '../config/types.js';
import { getEnvPaths } from '../config/env.js';
import { renameWithRetry } from '../utils/atomic-write.js';
import { DEFAULT_MAX_BODY_BYTES } from '../config/defaults.js';
import { setCaptureSecretRedaction } from '../observability/http-exchange.js';
import { displayPromptText, firstDisplayText } from '../utils/client-envelope.js';
import { NO_TURN, type TurnDecision, type TurnIdentity } from './turn-boundary.js';
import { migrateArchiveRoot } from './migrate/index.js';

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
 * One capture EVENT — a single JSONL line = one phase (`request` or
 * `response`) of one HTTP exchange. ADR-0024 five-layer ladder:
 * `session ⊃ turn ⊃ request ⊃ exchange ⊃ event`.
 *
 * Every line is self-describing: it names its `requestId` (the request
 * layer), `exchangeId` (the exchange layer), `turnIndex` (the turn layer)
 * and `sessionId` (the session layer). No reader reconstructs a boundary
 * from bodies, prompt text or message counts — all of those are written here.
 *
 * `direction` names the LEG, not a vector: `client` = client ↔ gateway,
 * `upstream` = gateway ↔ provider. A response event carries the same
 * `direction` as its request. There is no `gateway` leg.
 */
export const CAPTURE_SCHEMA = 2;

export interface CaptureEvent {
  id: string; // evt_<hex>
  ts: number; // epoch ms — when THIS phase fired (request send / response recv)
  /** Always 'http-exchange' for this event type. */
  eventType: 'http-exchange';
  /** 'client' = client ↔ gateway; 'upstream' = gateway ↔ provider. */
  direction: 'client' | 'upstream';
  /** 'request' = the wire side that's being sent; 'response' = the side that's being received. */
  phase: 'request' | 'response';
  /** Archive schema version. Every line in a capture archive carries 2. */
  schema: 2;
  /**
   * Provenance of a line that was upgraded by the archive migration chain:
   * the schema it was ORIGINALLY written at (`1` for the unmarked baseline).
   * Absent on lines the writer produced directly — which is exactly what
   * distinguishes a gate-stamped turn identity from one reconstructed during
   * migration. Stamped by the engine, never by a step.
   */
  migratedFrom?: number;
  /**
   * 1-based, monotonic turn ordinal WITHIN this `sessionId`, allocated once
   * at the inbound admission gate and copied onto every event of the request.
   * `null` is a first-class value: a request with no user prompt (standalone
   * decision surface, probe, replay) belongs to no turn. Never derived at
   * read time.
   */
  turnIndex: number | null;
  /** True only on the request that OPENED the turn. */
  isPromptStart: boolean;
  /** Structural provenance for the boundary decision (see turn-boundary.ts). */
  turnDecision: TurnDecision;
  /**
   * 1-based attempt ordinal WITHIN (requestId, leg). One client exchange is
   * always 1; every upstream failover hop / in-place retry increments it.
   * Written at emit time, never inferred at read time.
   */
  attempt: number;
  /**
   * Gateway-minted id of THIS HTTP exchange, shared by the request event AND
   * its matching response event (same direction): one client exchange = one
   * `exchangeId` with two events. Not a W3C span id — the gateway never
   * adopts a caller-supplied exchange identity.
   */
  exchangeId: string;
  /**
   * The CALLER's correlation value (W3C `traceparent` trace-id,
   * `x-request-id`, …), when it sent one. Correlation only: a trace spans
   * many requests, so this value may repeat across events and turns. Absent
   * when the caller sent none — the gateway does not invent one.
   */
  clientRequestId?: string;
  /**
   * Gateway-owned id of the REQUEST these events belong to (ADR-0021) —
   * the request-join key. Every event of one client request carries it;
   * `clientRequestId` above may be shared by several requests.
   */
  requestId: string;
  /**
   * The upstream provider's OWN id for the call, when its response exposes
   * one (`id` / `x-request-id`). Present only on upstream events.
   */
  upstreamRequestId?: string;
  /** Gateway session id (session-manager entry, or a synthetic turn id). */
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
   * Absent (`undefined`) when the leg has no key identity: keyless /v1 calls
   * or MITM forward-proxy tunnels (CONNECT-authenticated), plus requests
   * archived before this field existed.
   */
  apiKey?: CaptureKeyIdentity;
  /**
   * Display-only flattened last user message of the client-request body,
   * capped. Stamped on client-request events at write time so metadata-only
   * reads (`bodies=none`) can render a prompt. PRESENTATION ONLY: it never
   * decides a turn boundary — `isPromptStart` / `turnDecision` do.
   */
  promptSummary?: string;
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
   * outer request's requestId/sessionId). Absent = ordinary traffic.
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
   * chunk crosses. Undefined for buffered single-shot responses.
   *
   * TIMING CONTRACT (single definition, no second "end" field): `ts` is the
   * moment THIS event was recorded — request events fire before the wire
   * call, response events fire when the response side is fully known
   * (finalized). Therefore `response.ts - request.ts` is the whole exchange
   * duration, `firstByteTs - request.ts` is TTFT and
   * `response.ts - firstByteTs` is the decode window.
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

/** A leg of one request. There is no `gateway` leg — ADR-0024 §5. */
export type CaptureExchangeLeg = 'client' | 'upstream' | 'decision';

/**
 * ONE HTTP exchange = one request event + its response event, paired by
 * `exchangeId`. A request owns 2-N of these (client, upstream, every failover
 * attempt, the Layer-2 decision pair). `attempt` is 1-based within
 * `(requestId, leg)`; no hop is ever overwritten.
 */
export interface CaptureExchange {
  leg: CaptureExchangeLeg;
  attempt: number;
  exchangeId: string;
  purpose?: ExchangePurpose;
  request?: CaptureEvent;
  response?: CaptureEvent;
  /** response.ts - request.ts (whole exchange duration). */
  latencyMs?: number;
  /** firstByteTs - request.ts; undefined for buffered replies. */
  ttftMs?: number;
  /** response.ts - firstByteTs (decode window). */
  genMs?: number;
}

/** The last exchange of a leg — the one that served the client. */
export function primaryExchange(
  summary: CaptureRequestSummary,
  leg: CaptureExchangeLeg
): CaptureExchange | undefined {
  let found: CaptureExchange | undefined;
  for (const ex of summary.exchanges) {
    if (ex.leg === leg && (found === undefined || ex.attempt >= found.attempt)) found = ex;
  }
  return found;
}

/** Convenience projection: one side of the primary exchange of a leg. */
export function exchangeEvent(
  summary: CaptureRequestSummary,
  leg: CaptureExchangeLeg,
  phase: 'request' | 'response'
): CaptureEvent | undefined {
  return primaryExchange(summary, leg)?.[phase];
}

/**
 * One REQUEST: all HTTP exchanges sharing one `requestId`, plus the
 * write-time turn identity copied from its events. Read-plane projection
 * over `exchanges[]` — no turn boundary, prompt or ordinal is derived here.
 */
export interface CaptureRequestSummary {
  /** Gateway request id (ADR-0021) — the join key. */
  requestId: string;
  /** Caller correlation value, carried over from the client-request event. */
  clientRequestId?: string;
  sessionId: string;
  model: string;
  /** Write-time turn identity. `null` = this request belongs to no turn. */
  turnIndex: number | null;
  isPromptStart: boolean;
  turnDecision: TurnDecision;
  /** Display-only prompt text, stamped on the sole prompt-start request. */
  promptSummary?: string;
  /** 1-based REQUEST ordinal inside the read window. The pager's unit. */
  requestNumber?: number;
  /** Every exchange of this request, in wire order. Never last-write-wins. */
  exchanges: CaptureExchange[];
  /** First error across all events ("first error wins"). */
  error?: string;
}

/**
 * One TURN over the WHOLE archive, indexed by the WRITE-TIME `turnIndex`.
 * `firstRequest` / `lastRequest` are 1-based chronological request numbers.
 */
export interface CaptureTurnIndexEntry {
  /** The immutable write-time turn ordinal inside its session. */
  turnIndex: number;
  /** New user message that opened the turn. */
  prompt?: string;
  /** Request send time (epoch ms) of the turn's first request. */
  startTs?: number;
  /** Requests in this turn (prompt request + tool-loop hops). */
  requests: number;
  firstRequest: number;
  lastRequest: number;
}

/** Exact whole-archive totals + the write-time turn index (metadata only). */
export interface CaptureArchiveSummary {
  requests: number;
  fragments: number;
  turns: CaptureTurnIndexEntry[];
}

interface RequestIndexState {
  requests: number;
  turns: CaptureTurnIndexEntry[];
  /** sessionId + turnIndex -> index into `turns` (a turn may span shards). */
  byKey: Map<string, CaptureTurnIndexEntry>;
}

const newRequestIndexState = (): RequestIndexState => ({
  requests: 0,
  turns: [],
  byKey: new Map(),
});

/** Targeted line scans: the archive is compact JSON written by this recorder. */
const RE_CAPTURE_SESSION_ID = /"sessionId":"((?:[^"\\]|\\.)*)"/;
const RE_CAPTURE_TS = /"ts":(\d+)/;
const RE_CAPTURE_PROMPT_SUMMARY = /"promptSummary":("(?:[^"\\]|\\.)*")/;
const RE_CAPTURE_TURN_INDEX = /"turnIndex":(\d+)/;
const RE_CAPTURE_IS_PROMPT_START = /"isPromptStart":true/;

interface CaptureDateRow {
  date: string; // YYYY-MM-DD (local time)
  sessions: number;
  bytes: number;
}

/**
 * Inbound protocols a captured session can carry (see CaptureSessionRow.protocol).
 * Every recognized surface gets an explicit label — chat included (rendered
 * as the quiet neutral default) — legacy archives without request lines
 * (or unrecognized paths) stay undefined = unbadged.
 */
export type CaptureSessionProtocol = 'chat' | 'anthropic' | 'responses' | 'systemone';

interface CaptureSessionRow {
  file: string; // safe file name (already sanitized at write time)
  sessionId: string; // same as file minus the .jsonl suffix
  bytes: number;
  mtimeMs: number;
  requests: number; // total captured requests (ADR-0024 request layer)
  failed: number; // requests with an error outcome
  lastStatus?: 'ok' | 'error'; // status of the most recent request (badge dot)
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
  /**
   * Inbound protocol discriminator, derived at list time from the FIRST
   * client-request event's request line (`POST /v1/messages HTTP/1.1` →
   * 'anthropic'). Every recognized surface is labeled explicitly — chat
   * included. Undefined = a legacy archive without request lines or an
   * unrecognized path — the console renders absence as unbadged.
   */
  protocol?: CaptureSessionProtocol;
}

/**
 * One archive-file hit for a session id, located by NAME across all date
 * directories. Coordinates only (enough to read/delete the archive) — row
 * metadata (requests/preview/apiKey) comes from listSessions, never from a
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
  redactSecrets: boolean;
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
// Startup migration does NOT wait out the quiet window: at boot this process
// holds no append handle yet, and every rewrite re-checks the file right
// before the swap (see migrate/engine.ts), so a request that lands mid-pass
// makes the rewrite back off instead of losing bytes. An upgrading
// installation therefore sees its history immediately, not up to an hour
// later. The hourly sweep keeps the quiet window — by then the recorder IS
// appending, and a recently written shard is simply retried next hour.
const BOOT_MIGRATION_HOT_MS = 0;
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
/** Hard ceiling for the GROWING read window (page-driven growth, not the
 *  default window). Growth is requested by the console's pager, so it must
 *  stay memory-bounded regardless of how deep a click reaches: past this the
 *  response clamps `page`/`totalPages` and the pager self-heals. */
const READ_WINDOW_GROWTH_CEIL_BYTES = 3 * READ_WINDOW_CEIL_BYTES;

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
const deriveCompletionTokens = (ev: CaptureEvent): void => {
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
 * turn list immediately; full bodies arrive on demand via readRequest (per
 * turn) or a bodies=full re-read (conversation lens).
 */
const stripBodies = (events: CaptureEvent[]): void => {
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
 * `bodies='chat'` retention: the conversation replay needs each ROUND
 * OPENER's client-request body (it carries the full history up to that
 * prompt) plus every response body; the multi-MB continuation request bodies
 * repeat the same history and only bloat memory. Upstream request bodies are
 * byte-identical to their client counterpart, so they always go.
 */
const stripBodiesForChat = (events: CaptureEvent[], keepRequests: Set<CaptureEvent>): void => {
  for (const ev of events) {
    const wire = ev.wire as Partial<RawWireCapture> | undefined;
    if (!wire) continue;
    if (ev.phase === 'response') {
      delete wire.requestBody;
      continue;
    }
    delete wire.responseBody;
    if (!(ev.direction === 'client' && keepRequests.has(ev))) delete wire.requestBody;
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
  private redactSecrets: boolean;
  // Per-session SIZE-CAP bookkeeping: cached byte size per archive path, plus
  // which archives already got their terminal `archive-overflow` line. This
  // "seal" caps one runaway session; it has nothing to do with schema
  // migration, which has no seal — a migrated archive always stays in the live
  // root and stays readable.
  private fileBytesCache = new Map<string, number>();
  private sealedFiles = new Set<string>();
  /** Whole-archive request/round summaries keyed by file stat signature. */
  private summaryCache = new Map<string, CaptureArchiveSummary>();
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
    setCaptureSecretRedaction(config?.redactSecrets ?? true);
    this.redactSecrets = config?.redactSecrets ?? true;
    this.rootDir = path.resolve(config?.dir || getEnvPaths().captureDir);

    if (this.enabled) {
      this.ensureDir(this.rootDir);
      this.sweep();
      void this.migrateArchives(BOOT_MIGRATION_HOT_MS);
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
    setCaptureSecretRedaction(cfg?.redactSecrets ?? true);
    this.redactSecrets = cfg?.redactSecrets ?? true;
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
      void this.migrateArchives(BOOT_MIGRATION_HOT_MS);
    } else {
      this.stopSweepTimer();
    }
  }

  /** Idempotent hourly retention sweep timer (unref'd, never blocks exit). */
  private startSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweep();
      void this.migrateArchives();
    }, 3_600_000);
    this.sweepTimer.unref?.();
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * `schema`, `turnIndex`, `isPromptStart`, `turnDecision` and `attempt` are
   * stamped HERE — the single write point — so every archive line is fully
   * self-describing. Production emitters pass an explicit `TurnIdentity`
   * allocated at the admission gate; emitters that have none (standalone
   * surfaces, tests) get `NO_TURN`, the first-class "no prompt" value.
   * Readers never fill these in.
   */
  public async recordEvent(
    event: Omit<CaptureEvent, 'id' | 'ts' | 'schema' | 'attempt' | keyof TurnIdentity> &
      Partial<TurnIdentity> & { attempt?: number }
  ): Promise<void> {
    if (!this.enabled) return;
    const ts = Date.now();

    // Bound wire bodies at the maxBodyBytes cap — a 10MB request body must
    // not blow past the per-line JSONL budget and starve retention. `WireBody` is `string | { hex: string }`
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

    // A prompt-start client request gets a DISPLAY-ONLY prompt stamp. An
    // emitter that supplied one (e.g. a harness surface with a non-chat body)
    // keeps its own text; the stamp is never a boundary signal.
    const stampedPrompt =
      event.direction === 'client' &&
      event.phase === 'request' &&
      event.isPromptStart &&
      event.promptSummary === undefined
        ? CaptureRecorder.turnPromptStamp(truncatedReq.value ?? '')
        : undefined;
    const full: CaptureEvent & { truncated?: boolean } = {
      ...NO_TURN,
      ...event,
      schema: CAPTURE_SCHEMA,
      attempt: event.attempt ?? 1,
      id: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      ts,
      wire,
      ...(stampedPrompt !== undefined ? { promptSummary: stampedPrompt } : {}),
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
            requestId: full.requestId,
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
      redactSecrets: this.redactSecrets,
      totalBytes: dates.reduce((sum, d) => sum + d.bytes, 0),
      dateCount: dates.length,
    };
  }

  /** Date directories, newest first. */
  public listDates(): CaptureDateRow[] {
    return this.scanDates();
  }

  private scanDates(): CaptureDateRow[] {
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

  /**
   * Cross-date continuation metadata for every archive in ONE date directory:
   * a name-only scan across ALL date dirs marks each row whose session file
   * also exists under other dates (a conversation that crossed midnight —
   * same sanitized file name, appends sharded by write-time date). Cheap:
   * readdir only, zero body parses. `spanDates` is newest-first (listDates
   * order) INCLUDING this row's own date; attached only when it spans >1.
   */
  public listSessionsWithSpans(date: string, apiKeyFilter?: string): (CaptureSessionRow & { spanDates?: string[] })[] {
    const rows = this.listSessions(date, apiKeyFilter);
    if (rows.length === 0) return rows;
    // One pass over all date dirs builds the fileName → dates map; each date
    // dir is readdir'd once regardless of row count.
    const byFile = new Map<string, string[]>();
    for (const d of this.listDates()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(this.rootDir, d.date), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(JSONL_SUFFIX)) continue;
        const list = byFile.get(e.name);
        if (list) list.push(d.date);
        else byFile.set(e.name, [d.date]);
      }
    }
    return rows.map(r => {
      const spans = byFile.get(r.file);
      return spans && spans.length > 1 ? { ...r, spanDates: spans } : r;
    });
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
        // Per-REQUEST outcome tally for the console badges. Every line is a
        // schema-2 http-exchange event; events are grouped by requestId so a
        // failover with 6 legs still counts as one request and one outcome.
        let requests = 0;
        let failed = 0;
        let lastStatus: 'ok' | 'error' | undefined;
        let preview: string | undefined;
        let protocol: CaptureSessionProtocol | undefined;
        // DISTINCT api-key identities seen in this archive, in write order.
        const seenKeys = new Map<string, CaptureKeyIdentity>();
        let conversationKey: string | undefined;
        const streamEvents: CaptureEvent[] = [];
        try {
          // Ceiling: the tally needs EVERY line, so this is an uncapped
          // synchronous read bounded only by the per-session seal
          // (maxSessionMB, default 512 MB). Admin-console surface,
          // operator-initiated.
          const content = fs.readFileSync(filePath, 'utf8');
          for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            let rec: Record<string, unknown>;
            try {
              rec = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue; // corrupt line — not a request
            }
            if (rec.eventType === 'archive-overflow') continue;
            if (rec.eventType !== 'http-exchange') continue;
            const ev = CaptureRecorder.parseArchivedEvent(rec);
            if (ev) streamEvents.push(ev);
            if (rec.apiKey && (rec.apiKey as CaptureKeyIdentity).id && !seenKeys.has(String((rec.apiKey as CaptureKeyIdentity).id))) {
              const k = rec.apiKey as CaptureKeyIdentity;
              seenKeys.set(String(k.id), { id: String(k.id), name: String(k.name ?? '') });
            }
            if (conversationKey === undefined && typeof rec.conversationKey === 'string' && rec.conversationKey) {
              conversationKey = rec.conversationKey;
            }
            // First client request body = the session's opening prompt.
            if (
              preview === undefined &&
              rec.direction === 'client' &&
              rec.phase === 'request' &&
              (rec.wire as RawWireCapture | undefined)?.requestBody !== undefined
            ) {
              preview = CaptureRecorder.extractSessionPreview((rec.wire as RawWireCapture).requestBody);
            }
            // Inbound-protocol badge: the FIRST client request line wins.
            if (protocol === undefined && rec.direction === 'client' && rec.phase === 'request') {
              protocol = CaptureRecorder.protocolFromRequestLine((rec.wire as RawWireCapture | undefined)?.requestLine);
            }
          }
          for (const r of CaptureRecorder.groupEventsIntoRequests(streamEvents)) {
            requests++;
            const clientResponse = exchangeEvent(r, 'client', 'response');
            const hasError =
              Boolean(r.error) ||
              r.exchanges.some(ex => ex.request?.status === 'error' || ex.response?.status === 'error');
            if (hasError) failed++;
            if (clientResponse) lastStatus = clientResponse.status === 'error' ? 'error' : 'ok';
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
          requests,
          failed,
          lastStatus,
          preview,
          ...(keyList.length ? { apiKeys: keyList } : {}),
          ...(conversationKey ? { conversationKey } : {}),
          ...(protocol ? { protocol } : {}),
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
   * Read the raw JSONL objects from the tail of one archive, newest `limit`
   * lines in file order. No schema interpretation: archive-overflow seal
   * markers are metadata and are filtered out, everything else is returned
   * verbatim. Used by the generic console record view and the raw exporter.
   */
  public readRecords(
    date: string,
    file: string,
    limit = 200
  ): { records: Record<string, unknown>[]; totalLines: number; fileTruncated: boolean } {
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

      const records: Record<string, unknown>[] = [];
      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const rec = JSON.parse(raw);
          // The terminal seal marker is metadata, never a captured event.
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
   * Read the last `bytes` of one archive and parse its http-exchange events.
   * Async and yield-paced: the window can be tens of MB and per-line
   * JSON.parse is CPU-bound — parsing in batches with event-loop yields keeps
   * the gateway responsive while an archive read is in flight. Never fails:
   * corrupt lines are skipped.
   *
   * `minBytes` lets a caller ask for a window LARGER than the default one —
   * the console's backward pager grows the window until the page it wants is
   * covered (see readEvents), so a session whose bodies blow past the default
   * window is still fully browsable instead of silently ending at its tail.
   */
  private async readWindowEvents(
    date: string,
    file: string,
    minBytes = 0
  ): Promise<{ events: CaptureEvent[]; fileTruncated: boolean; fileBytes: number; windowBytes: number }> {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return { events: [], fileTruncated: false, fileBytes: 0, windowBytes: 0 };

    let text: string;
    let fileTruncated = false;
    let fileBytes = 0;
    let windowBytes = 0;
    try {
      const st = await fs.promises.stat(filePath);
      fileBytes = st.size;
      const readSize = Math.min(st.size, Math.max(this.readWindowBytes(), minBytes));
      windowBytes = readSize;
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
      return { events: [], fileTruncated: false, fileBytes: 0, windowBytes: 0 };
    }

    const lines = text.split(/\r?\n/);
    if (fileTruncated && lines.length > 0) lines.shift();

    const events: CaptureEvent[] = [];
    const yieldLoop = () => new Promise<void>(r => setImmediate(r));
    const BATCH = 128; // lines per event-loop slice
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj.eventType === 'http-exchange') {
          const ev = CaptureRecorder.parseArchivedEvent(obj);
          if (!ev) continue;
          deriveCompletionTokens(ev);
          events.push(ev);
        }
      } catch {
        // Corrupt/partial line — skip, never fail the whole read.
      }
      if ((i + 1) % BATCH === 0) await yieldLoop();
    }
    return { events, fileTruncated, fileBytes, windowBytes };
  }
  /**
   * Archive-line boundary validation — schema-2 only. A line is accepted
   * only when it is a COMPLETE schema-2 http-exchange event: every scope
   * field written by the admission gate must be present, including the
   * first-class `turnIndex: null` for prompt-less requests. There is no
   * legacy vocabulary, no field mapping and no derived fallback: a line is
   * read in the shape the writer produced or not at all. A schema-1 archive
   * is never read here — the migrator chain (`capture/migrate/`) rewrites it
   * in place at boot, and it does so for EVERY line it can parse.
   */
  private static parseArchivedEvent(obj: Record<string, unknown>): CaptureEvent | null {
    if (
      obj.schema !== CAPTURE_SCHEMA ||
      obj.eventType !== 'http-exchange' ||
      typeof obj.id !== 'string' || !obj.id ||
      typeof obj.ts !== 'number' ||
      typeof obj.requestId !== 'string' || !obj.requestId ||
      typeof obj.exchangeId !== 'string' || !obj.exchangeId ||
      typeof obj.sessionId !== 'string' ||
      (obj.turnIndex !== null && typeof obj.turnIndex !== 'number') ||
      typeof obj.isPromptStart !== 'boolean' ||
      typeof obj.turnDecision !== 'string' ||
      typeof obj.attempt !== 'number' ||
      (obj.direction !== 'client' && obj.direction !== 'upstream') ||
      (obj.phase !== 'request' && obj.phase !== 'response')
    ) return null;
    return obj as unknown as CaptureEvent;
  }


  /**
   * Read the schema-2 events in one archive's tail window and project them
   * into REQUESTS. Paging is in requests (the pager's unit): page 1 is the
   * newest `limit` requests, and every exchange of a request always travels
   * with it. `bodies='none'` strips wire bodies for metadata-first reads;
   * `bodies='chat'` keeps only a prompt-start request's body plus responses.
   *
   * The read window GROWS to cover the requested page: a large body per
   * request means a few requests can fill the default window. Growth doubles
   * until the page fits, the whole file is read, or the growth ceiling is
   * reached — past that the response clamps `page`/`totalPages`.
   *
   * `totalTurns` counts DISTINCT write-time `turnIndex` values in the window;
   * it is not an ordinal and not a request count. Nothing here derives a turn
   * boundary: the archive already carries `turnIndex`/`isPromptStart`.
   */
  public async readEvents(
    date: string,
    file: string,
    limit = 50,
    bodies: 'full' | 'none' | 'chat' = 'full',
    page = 1
  ): Promise<{
    events: CaptureEvent[];
    requests: CaptureRequestSummary[];
    totalLines: number;
    /** Requests in the read window (the pager's exact denominator). */
    totalRequests: number;
    /** Distinct write-time turn ordinals in the read window. */
    totalTurns: number;
    /** The window is the WHOLE file (false = only its tail was read). */
    windowComplete: boolean;
    fileTruncated: boolean;
    /** The page actually served (clamped into [1, totalPages]). */
    page: number;
    /** Pages available in the read window (request pages). */
    totalPages: number;
    hasOlder: boolean;
    hasNewer: boolean;
  }> {
    const size = Math.max(1, limit);
    const needed = page * size + 1;
    let minBytes = 0;
    let read = await this.readWindowEvents(date, file, minBytes);
    for (;;) {
      const groups = CaptureRecorder.groupEventsIntoRequests(read.events);
      if (groups.length >= needed || !read.fileTruncated) break;
      const next = Math.min(
        Math.max(read.windowBytes * 2, this.readWindowBytes()),
        READ_WINDOW_GROWTH_CEIL_BYTES
      );
      if (next <= read.windowBytes) break;
      minBytes = next;
      read = await this.readWindowEvents(date, file, minBytes);
    }
    const { events, fileTruncated } = read;

    const allRequests = CaptureRecorder.groupEventsIntoRequests(events);
    const totals = CaptureRecorder.numberRequests(allRequests);
    const totalPages = Math.max(1, Math.ceil(allRequests.length / size));
    const pageNo = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
    const end = allRequests.length - (pageNo - 1) * size;
    const sliceStart = Math.max(0, end - size);
    const pageRequests = allRequests.slice(sliceStart, Math.max(sliceStart, end));

    // Exactly the events of this page's requests, in wire order.
    const visible = new Set<CaptureEvent>();
    for (const r of pageRequests) for (const ev of CaptureRecorder.requestEvents(r)) visible.add(ev);
    const newest = events.filter(ev => visible.has(ev));

    if (bodies === 'none') stripBodies(events);
    else if (bodies === 'chat') {
      const keepRequests = new Set<CaptureEvent>();
      for (const r of allRequests) {
        const cr = exchangeEvent(r, 'client', 'request');
        // Only the request that OPENED a turn carries a new prompt's history.
        if (cr && r.isPromptStart) keepRequests.add(cr);
      }
      stripBodiesForChat(events, keepRequests);
    }
    return {
      events: newest,
      requests: pageRequests,
      totalLines: events.length,
      totalRequests: totals.requests,
      totalTurns: totals.turns,
      windowComplete: !fileTruncated,
      fileTruncated,
      page: pageNo,
      totalPages,
      hasOlder: sliceStart > 0,
      hasNewer: pageNo > 1,
    };
  }

  /**
   * Read one REQUEST's full wire bodies. The key is its `requestId` (what the
   * console row and every React key carries); any of its event ids is accepted
   * too for deep links. Returns null when the key is unknown or fell outside
   * the read window. No re-derivation: the returned summary is the archive's
   * own write-time identity over its `exchanges[]`.
   */
  public async readRequest(
    date: string,
    file: string,
    requestOrEventId: string
  ): Promise<{ request: CaptureRequestSummary } | null> {
    const { events } = await this.readWindowEvents(date, file);
    const anchor =
      events.find(e => e.id === requestOrEventId) ??
      events.find(e => e.requestId === requestOrEventId);
    if (!anchor) return null;
    const requests = CaptureRecorder.groupEventsIntoRequests(events);
    CaptureRecorder.numberRequests(requests);
    const request = requests.find(r => r.requestId === anchor.requestId);
    return request ? { request } : null;
  }

  /* --------------------------------------------------- cross-date stitching */

  // conversationKey per archive path (first 64 KB head read). null = read
  // done, none found. Bounded: one entry per archive file ever stitched.
  private convKeyCache = new Map<string, string | null>();
  private static CONVKEY_HEAD_BYTES = 64 * 1024;

  /** All date dirs whose directory listing contains exactly this file name. */
  private findDatesForFile(file: string): string[] {
    if (!file || !file.endsWith(JSONL_SUFFIX) || file.includes('/') || file.includes('\\') || file.includes('..')) {
      return [];
    }
    const dates: string[] = [];
    for (const d of this.listDates()) {
      try {
        if (fs.readdirSync(path.join(this.rootDir, d.date), { withFileTypes: true }).some(e => e.isFile() && e.name === file)) {
          dates.push(d.date);
        }
      } catch {
        continue; // Date dir vanished mid-scan — fail open.
      }
    }
    return dates;
  }

  /** First conversationKey in an archive's head window (conversationKey is
   * stamped on EVERY event, so the first lines carry it). Cached per path. */
  private readConversationKey(date: string, file: string): string | null {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return null;
    const cached = this.convKeyCache.get(filePath);
    if (cached !== undefined) return cached;
    let key: string | null = null;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(CaptureRecorder.CONVKEY_HEAD_BYTES, fs.fstatSync(fd).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        for (const line of buf.toString('utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const k = (JSON.parse(line) as Record<string, unknown>).conversationKey;
            if (typeof k === 'string' && k) {
              key = k;
              break;
            }
          } catch {
            /* partial first line — skip */
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      key = null;
    }
    // Cap the cache: admin consoles browse finite archives, but a config-root
    // change or long uptime must not grow it without bound.
    if (this.convKeyCache.size > 4096) this.convKeyCache.clear();
    this.convKeyCache.set(filePath, key);
    return key;
  }

  /**
   * All fragments of the conversation this archive belongs to, across ALL
   * date dirs. Primary join: exact file name (a session that crossed
   * midnight keeps its sanitized name — readdir-only, free). Fallback join:
   * the anchor's `conversationKey` matches sibling archives whose session id
   * churned mid-conversation (head-window reads, cached). Newest first.
   */
  private conversationFragments(date: string, file: string): { date: string; file: string }[] {
    const seen = new Set<string>();
    const fragments: { date: string; file: string }[] = [];
    const push = (d: string, f: string) => {
      const k = `${d}/${f}`;
      if (seen.has(k)) return;
      seen.add(k);
      fragments.push({ date: d, file: f });
    };
    // 1. Name join across every date dir.
    for (const d of this.findDatesForFile(file)) push(d, file);
    // 2. conversationKey join: only files NOT already matched — those need a
    //    head read each (cached). Bounded by retention (dates × files).
    const convKey = this.readConversationKey(date, file);
    if (convKey) {
      for (const d of this.listDates()) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(path.join(this.rootDir, d.date), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith(JSONL_SUFFIX)) continue;
          if (seen.has(`${d.date}/${e.name}`)) continue;
          if (this.readConversationKey(d.date, e.name) === convKey) push(d.date, e.name);
        }
      }
    }
    return fragments;
  }

  /**
   * Stitched read: merge the session's fragments from every date dir into
   * ONE chronological event stream, then group exactly like readEvents.
   * Reads happen per fragment (each bounded by readWindowBytes), the merge
   * dedupes by event id (defensive — appends are disjoint by construction)
   * and sorts by ts, so a turn that straddles midnight reassembles even when
   * its request and response events landed in different date files.
   * Fragment turn counts are per-file (the archive's physical layout), while
   * `turns`/`totalTurns` cover the WHOLE conversation.
   *
   * `page` pages backwards exactly like the non-stitched read, over the
   * MERGED conversation timeline (a page can therefore mix shards). Paging
   * stays window-bounded: each fragment is read through its own tail window,
   * so history older than every window is export-only.
   */
  public async readEventsStitched(
    date: string,
    file: string,
    limit = 50,
    bodies: 'full' | 'none' | 'chat' = 'full',
    page = 1
  ): Promise<{
    events: CaptureEvent[];
    requests: CaptureRequestSummary[];
    totalLines: number;
    totalRequests: number;
    totalTurns: number;
    windowComplete: boolean;
    fileTruncated: boolean;
    fragments: { date: string; file: string; requests: number }[];
    page: number;
    totalPages: number;
    hasOlder: boolean;
    hasNewer: boolean;
  }> {
    const fragments = this.conversationFragments(date, file);
    const size = Math.max(1, limit);
    const needed = page * size + 1;
    let minBytes = 0;
    let merged = new Map<string, CaptureEvent>();
    let fileTruncated = false;
    let fragmentRows: { date: string; file: string; requests: number }[] = [];
    for (;;) {
      merged = new Map<string, CaptureEvent>();
      fragmentRows = [];
      fileTruncated = false;
      let grew = false;
      let maxWindow = 0;
      for (const f of fragments) {
        const result = await this.readWindowEvents(f.date, f.file, minBytes);
        if (result.fileTruncated) fileTruncated = true;
        if (result.windowBytes > maxWindow) maxWindow = result.windowBytes;
        if (result.fileBytes > result.windowBytes) grew = true;
        for (const ev of result.events) if (!merged.has(ev.id)) merged.set(ev.id, ev);
        fragmentRows.push({
          date: f.date,
          file: f.file,
          requests: CaptureRecorder.groupEventsIntoRequests(result.events).length,
        });
      }
      const all = [...merged.values()].sort((a, b) => a.ts - b.ts);
      if (CaptureRecorder.groupEventsIntoRequests(all).length >= needed || !grew) break;
      const next = Math.min(Math.max(maxWindow * 2, this.readWindowBytes()), READ_WINDOW_GROWTH_CEIL_BYTES);
      if (next <= maxWindow) break;
      minBytes = next;
    }
    const all = [...merged.values()].sort((a, b) => a.ts - b.ts);

    const allRequests = CaptureRecorder.groupEventsIntoRequests(all);
    const totals = CaptureRecorder.numberRequests(allRequests);
    const totalPages = Math.max(1, Math.ceil(allRequests.length / size));
    const pageNo = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
    const end = allRequests.length - (pageNo - 1) * size;
    const sliceStart = Math.max(0, end - size);
    const pageRequests = allRequests.slice(sliceStart, Math.max(sliceStart, end));
    const visible = new Set<CaptureEvent>();
    for (const r of pageRequests) for (const ev of CaptureRecorder.requestEvents(r)) visible.add(ev);
    const newest = all.filter(ev => visible.has(ev));

    if (bodies === 'none') stripBodies(all);
    else if (bodies === 'chat') {
      const keepRequests = new Set<CaptureEvent>();
      for (const r of allRequests) {
        const cr = exchangeEvent(r, 'client', 'request');
        if (cr && r.isPromptStart) keepRequests.add(cr);
      }
      stripBodiesForChat(all, keepRequests);
    }
    return {
      events: newest,
      requests: pageRequests,
      totalLines: all.length,
      totalRequests: totals.requests,
      totalTurns: totals.turns,
      windowComplete: !fileTruncated,
      fileTruncated,
      fragments: fragmentRows,
      page: pageNo,
      totalPages,
      hasOlder: sliceStart > 0,
      hasNewer: pageNo > 1,
    };
  }

  /**
   * Resolve one request's full wire bodies across ALL fragments of the
   * session: a request archived in a previous day's shard must still open.
   */
  public async readRequestStitched(
    date: string,
    file: string,
    requestOrEventId: string
  ): Promise<{ request: CaptureRequestSummary } | null> {
    for (const f of this.conversationFragments(date, file)) {
      const result = await this.readRequest(f.date, f.file, requestOrEventId);
      if (result) return result;
    }
    return null;
  }

  /* -------------------------------------------------- exact archive summary */

  /**
   * EXACT whole-archive summary, not the read window: the request count and
   * the WRITE-TIME TURN INDEX (turnIndex + contiguous request range).
   *
   * Every request starts with exactly one client-request event, so counting
   * those lines counts requests without grouping. A client request carrying
   * `turnIndex: null` belongs to no turn and is counted as a request only.
   * The terminal `archive-overflow` seal line is metadata and is skipped.
   *
   * Streamed in chunks so a seal-maximum session (512 MB) never becomes one
   * string on the heap. Targeted regexes pull only the metadata — never
   * JSON.parse on the whole line, whose request body can be many MB. Turn
   * membership is read from the archive, never inferred from prompts,
   * message counts or resend heuristics.
   *
   * The result is DISPLAY ONLY: pagination still reads a bounded window.
   */
  public async captureSummary(date: string, file: string): Promise<CaptureArchiveSummary> {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return { requests: 0, fragments: 1, turns: [] };
    const sig = this.archiveSignature([filePath]);
    const cached = sig ? this.summaryCache.get(sig) : undefined;
    if (cached) return cached;
    const state = newRequestIndexState();
    await this.scanRequestIndex(filePath, state);
    const summary = { requests: state.requests, fragments: 1, turns: state.turns };
    if (sig) this.rememberSummary(sig, summary);
    return summary;
  }

  /**
   * Whole STITCHED conversation: fragments in chronological order. One
   * client-request line lives in exactly one shard, so a request is counted
   * once; `byKey` carries the same (sessionId, turnIndex) across shards.
   */
  public async captureSummaryStitched(date: string, file: string): Promise<CaptureArchiveSummary> {
    const fragments = this.conversationFragments(date, file)
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
    const paths = fragments
      .map(f => this.resolveArchiveFile(f.date, f.file))
      .filter((p): p is string => Boolean(p));
    const sig = this.archiveSignature(paths);
    const cached = sig ? this.summaryCache.get(sig) : undefined;
    if (cached) return cached;
    const state = newRequestIndexState();
    for (const p of paths) await this.scanRequestIndex(p, state);
    const summary = { requests: state.requests, fragments: paths.length, turns: state.turns };
    if (sig) this.rememberSummary(sig, summary);
    return summary;
  }

  /** mtime+size signature — any append invalidates; a read-only archive hits. */
  private archiveSignature(paths: string[]): string | null {
    const parts: string[] = [];
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        parts.push(`${p}:${st.size}:${st.mtimeMs}`);
      } catch {
        return null;
      }
    }
    return parts.join('|');
  }

  /** Bounded LRU-ish cache: drop the oldest entry past 8 summaries. */
  private rememberSummary(sig: string, summary: CaptureArchiveSummary): void {
    this.summaryCache.delete(sig);
    this.summaryCache.set(sig, summary);
    while (this.summaryCache.size > 8) {
      const oldest = this.summaryCache.keys().next().value;
      if (oldest === undefined) break;
      this.summaryCache.delete(oldest);
    }
  }

  /**
   * One streamed metadata pass; appends to `state` so shards chain.
   * Byte-level: several event lines can share a multi-MB request body, so
   * the stream stays a Buffer and only a matching client-request line is
   * decoded. Only schema-2 lines are considered.
   */
  private async scanRequestIndex(filePath: string, state: RequestIndexState): Promise<void> {
    const take = (line: Buffer): void => {
      if (line.length === 0) return;
      if (
        line.indexOf('"schema":2') < 0 ||
        line.indexOf('"eventType":"http-exchange"') < 0 ||
        line.indexOf('"direction":"client"') < 0 ||
        line.indexOf('"phase":"request"') < 0
      ) return;
      const text = line.toString('utf8');
      state.requests++;
      const n = state.requests;
      const turnMatch = RE_CAPTURE_TURN_INDEX.exec(text);
      // `turnIndex: null` (prompt-less request) belongs to no turn.
      if (!turnMatch) return;
      const turnIndex = Number(turnMatch[1]);
      const sessionId = RE_CAPTURE_SESSION_ID.exec(text)?.[1] ?? '';
      const tsMatch = RE_CAPTURE_TS.exec(text);
      const ts = tsMatch ? Number(tsMatch[1]) : undefined;
      const isPromptStart = RE_CAPTURE_IS_PROMPT_START.test(text);
      const rawPrompt = RE_CAPTURE_PROMPT_SUMMARY.exec(text)?.[1];
      let prompt: string | undefined;
      if (isPromptStart && rawPrompt !== undefined) {
        try {
          prompt = JSON.parse(rawPrompt);
        } catch {
          prompt = undefined; // truncated/sealed line — display-only field
        }
      }
      const key = `${sessionId}|${turnIndex}`;
      let entry = state.byKey.get(key);
      if (!entry) {
        entry = {
          turnIndex,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(isPromptStart && ts !== undefined && Number.isFinite(ts) ? { startTs: ts } : {}),
          requests: 0,
          firstRequest: n,
          lastRequest: n,
        };
        state.byKey.set(key, entry);
        state.turns.push(entry);
      } else if (isPromptStart) {
        if (entry.prompt === undefined && prompt !== undefined) entry.prompt = prompt;
        if (entry.startTs === undefined && ts !== undefined && Number.isFinite(ts)) entry.startTs = ts;
        entry.firstRequest = Math.min(entry.firstRequest, n);
      }
      entry.requests++;
      entry.lastRequest = n;
    };
    try {
      const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
      let rest = Buffer.alloc(0);
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        rest = rest.length > 0 ? Buffer.concat([rest, buf]) : buf;
        let start = 0;
        for (;;) {
          const nl = rest.indexOf(0x0a, start);
          if (nl < 0) break;
          take(rest.subarray(start, nl));
          start = nl + 1;
        }
        if (start > 0) rest = rest.subarray(start);
      }
      if (rest.length > 0) take(rest);
    } catch {
      // Unreadable tail — answer what was counted.
    }
  }

  /**
   * Group a flat list of capture events into REQUESTS by the gateway-owned
   * `requestId`. Each request owns an `exchanges[]` list bucketed by
   * `(leg, attempt)`, so EVERY failover hop and the Layer-2 decision pair
   * survive — nothing is last-write-wins.
   *
   * No turn boundary, prompt, message count or ordinal is derived here:
   * `turnIndex` / `isPromptStart` / `turnDecision` are copied from the
   * write-time fields on the events, and `attempt` was stamped at emit time.
   * Pure function — exported for unit tests.
   */
  public static groupEventsIntoRequests(events: CaptureEvent[]): CaptureRequestSummary[] {
    const byRequest = new Map<string, CaptureRequestSummary>();
    const exchangeByKey = new Map<string, CaptureExchange>();

    const legOf = (ev: CaptureEvent): CaptureExchangeLeg =>
      ev.purpose === 'l2-decision' ? 'decision' : ev.direction === 'client' ? 'client' : 'upstream';

    for (const ev of events) {
      let summary = byRequest.get(ev.requestId);
      if (!summary) {
        summary = {
          requestId: ev.requestId,
          ...(ev.clientRequestId ? { clientRequestId: ev.clientRequestId } : {}),
          sessionId: ev.sessionId,
          model: ev.model,
          turnIndex: ev.turnIndex ?? null,
          isPromptStart: ev.isPromptStart ?? false,
          turnDecision: ev.turnDecision ?? 'no_prompt',
          exchanges: [],
        };
        byRequest.set(ev.requestId, summary);
      }
      // The client-request event is authoritative for identity when present.
      if (ev.direction === 'client' && ev.phase === 'request') {
        summary.sessionId = ev.sessionId;
        summary.model = ev.model;
        summary.turnIndex = ev.turnIndex ?? null;
        summary.isPromptStart = ev.isPromptStart ?? false;
        summary.turnDecision = ev.turnDecision ?? 'no_prompt';
        if (ev.promptSummary !== undefined) summary.promptSummary = ev.promptSummary;
      }
      if (ev.error && !summary.error) summary.error = ev.error;

      const leg = legOf(ev);
      const key = `${ev.requestId}|${ev.exchangeId}`;
      let exchange = exchangeByKey.get(key);
      if (!exchange) {
        exchange = {
          leg,
          attempt: ev.attempt ?? 1,
          exchangeId: ev.exchangeId,
          ...(ev.purpose ? { purpose: ev.purpose } : {}),
        };
        exchangeByKey.set(key, exchange);
        summary.exchanges.push(exchange);
      }
      if (ev.phase === 'request') exchange.request = ev;
      else exchange.response = ev;
    }

    const all = [...byRequest.values()];
    for (const summary of all) {
      summary.exchanges.sort((a, b) =>
        (a.request?.ts ?? a.response?.ts ?? 0) - (b.request?.ts ?? b.response?.ts ?? 0) ||
        a.attempt - b.attempt
      );
      for (const ex of summary.exchanges) {
        if (!ex.request || !ex.response) continue;
        ex.latencyMs = Math.max(0, ex.response.ts - ex.request.ts);
        if (ex.response.firstByteTs !== undefined) {
          ex.ttftMs = Math.max(0, ex.response.firstByteTs - ex.request.ts);
          ex.genMs = Math.max(0, ex.response.ts - ex.response.firstByteTs);
        }
      }
    }
    return all.sort((a, b) => {
      const ts = (t: CaptureRequestSummary): number =>
        t.exchanges[0]?.request?.ts ?? t.exchanges[0]?.response?.ts ?? 0;
      return ts(a) - ts(b);
    });
  }

  /** Number requests 1..N inside the read window (the pager's unit). */
  private static numberRequests(requests: CaptureRequestSummary[]): { requests: number; turns: number } {
    requests.forEach((r, i) => { r.requestNumber = i + 1; });
    const seen = new Set<number>();
    for (const r of requests) if (r.turnIndex !== null) seen.add(r.turnIndex);
    return { requests: requests.length, turns: seen.size };
  }

  /** Events belonging to a request (used for body stripping + page slicing). */
  private static requestEvents(request: CaptureRequestSummary): CaptureEvent[] {
    const out: CaptureEvent[] = [];
    for (const ex of request.exchanges) {
      if (ex.request) out.push(ex.request);
      if (ex.response) out.push(ex.response);
    }
    return out;
  }

  /**
   * Requests whose events survived a tail slice. A request created from a
   * stray trailing response (its client request fell outside the window) has
   * no event in the slice and drops out.
   */
  private static requestsInWindow(
    all: CaptureRequestSummary[],
    window: CaptureEvent[]
  ): CaptureRequestSummary[] {
    const visible = new Set(window);
    return all.filter(r => CaptureRecorder.requestEvents(r).some(e => visible.has(e)));
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
   * When `exclude` is non-empty, the matching wire-side bodies of a schema-2
   * http-exchange event are blanked and the rest of the line is re-serialized;
   * metadata (ids / ts / status / model / routing / turn identity) always
   * survives. Seal markers and unparseable lines pass through verbatim.
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
            // Seal marker / unparseable-as-event line: keep it exactly as written.
            out.push(line);
            continue;
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

  /* ------------------------------------------------------ schema migration */

  /**
   * Archive schema-transition pass (ADR-0008 section 5).
   *
   * COLD files are walked hop by hop through the steps registered in
   * `migrate/registry.ts`, resolved by `(from, to)`. That is how an upgrading
   * installation keeps its history: schema-1 lines become schema-2 lines IN
   * PLACE, and every line the pass can read comes out readable — a legacy
   * span sequence that does not close cleanly is repaired into the nearest
   * truth-bearing shape by the step itself, never set aside.
   *
   * Whole-file discipline: a file is rewritten atomically or left exactly as
   * it was. A line that is not parseable JSON is carried over byte-for-byte
   * (and counted in `unreadable`) instead of costing the file its other
   * thousand good rows.
   *
   * Runs at boot, on hot-apply enable and on the hourly sweep; fail-open per
   * file. Rewritten files invalidate the size/seal/summary caches.
   *
   * `hotMs` is the quiet window a file must sit in before it is touched.
   * Boot and hot-enable pass 0 (`BOOT_MIGRATION_HOT_MS`) so an upgraded
   * installation shows its history at once — safety there comes from the
   * re-check before each swap, not from waiting. The hourly sweep passes
   * `undefined` and keeps the default window, because by then this process is
   * appending and a shard written minutes ago is simply retried next hour.
   */
  public async migrateArchives(hotMs?: number): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await migrateArchiveRoot(this.rootDir, CAPTURE_SCHEMA, { hotMs });
      if (res.files > 0) {
        this.fileBytesCache.clear();
        this.sealedFiles.clear();
        this.summaryCache.clear();
      }
      // Reported, never silent: an upgrade that could not bring some data
      // forward must say so once per pass instead of leaving the operator to
      // wonder why a session looks short.
      if (res.unreadable > 0) {
        console.warn(
          `[Capture] ${res.unreadable} archive line(s) are not parseable JSON — carried over verbatim, unreadable by any reader`,
        );
      }
      if (res.rejected > 0) {
        console.warn(
          `[Capture] ${res.rejected} archive file(s) could not be migrated and were left untouched for the next pass`,
        );
      }
    } catch {
      // Fail-open: a capture problem must never break the inference hot path.
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
        renameWithRetry(tmp, fp);
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
    // First HUMAN text, not the first user-role message: Cursor opens with a
    // `<user_info>`/`<rules>` bundle and the prompt rides the NEXT message.
    // Same strict-then-permissive rule as the console session title.
    const text = CaptureRecorder.firstHumanUserText(request);
    if (!text) return undefined;
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return undefined;
    return flat.length <= cap ? flat : flat.slice(0, cap - 1) + '…';
  }

  /**
   * The LAST user message of a request body, flattened and capped. Same
   * disclosure class as the session preview. Undefined when the body carries
   * no user text.
   *
   * NOT stamped verbatim: a body's last user message is only THIS turn's
   * question when the client appended it — agent loops resend the whole
   * history, so a tool-result continuation still ends its user list with the
   * previous turn's prompt. `turnPromptStamp` adds the positions the read
   * plane needs to tell those apart.
   */
  public static extractTurnPrompt(request: unknown, cap = 120): string | undefined {
    return CaptureRecorder.summarizePromptText(CaptureRecorder.lastUserSlot(request)?.text, cap);
  }

  /**
   * Display-only last user message of a client-request body. Written ONLY on
   * the request that opened the turn (`isPromptStart`); the turn boundary is
   * decided structurally at the admission gate, never from this text.
   */
  public static turnPromptStamp(request: unknown, cap = 120): string | undefined {
    const slot = CaptureRecorder.lastUserSlot(request);
    return CaptureRecorder.summarizePromptText(slot?.text, cap);
  }

  /** Display form of a prompt: newlines flattened, empty bundle text dropped
   *  (a metadata-only turn keeps NO prompt — the timeline renders the
   *  empty-prompt glyph instead of quoting the client's context bundle as
   *  this turn's question), capped with an ellipsis. */
  private static summarizePromptText(text: string | undefined, cap: number): string | undefined {
    if (!text) return undefined;
    const flat = displayPromptText(text);
    if (!flat) return undefined;
    return flat.length <= cap ? flat : flat.slice(0, cap - 1) + '…';
  }

  /**
   * System One decision requests evaluate `state` — plain text or a
   * structured object/array (no `messages`/`input`, which is why the chat
   * extractors miss them and decision sessions rendered untitled). Strings
   * pass trimmed; structured state flattens to its JSON form (capped) so
   * the session list / turn prompt shows evaluated content instead of the
   * raw session id. Undefined for absent / empty / non-text scalar state.
   */
  private static stateText(state: unknown, cap = 300): string | undefined {
    if (state === null || state === undefined) return undefined;
    if (typeof state === 'string') return state.trim() || undefined;
    if (typeof state !== 'object') return undefined; // numeric/boolean scalar — no title
    try {
      const flat = JSON.stringify(state);
      return flat ? flat.slice(0, cap) : undefined;
    } catch {
      return undefined; // circular / unserializable state — fail open
    }
  }

  /**
   * Inbound protocol for the session-list badge, from the client request
   * line's path (`POST /v1/systemone HTTP/1.1` → 'systemone'). Every
   * recognized inference surface returns an explicit label — chat included,
   * rendered by the console as the quiet neutral default. Unrecognized /
   * req-less lines (empty requestLine) return undefined.
   */
  public static protocolFromRequestLine(requestLine: unknown): CaptureSessionProtocol | undefined {
    if (typeof requestLine !== 'string') return undefined;
    // The path segment; tolerates ABSOLUTE-FORM lines (`POST https://host/p?q`
    // — the MITM client leg) by skipping an optional scheme+authority prefix.
    const m = /^\w+ (?:[a-z][a-z0-9+.-]*:\/\/[^/?\s]+)?([^?\s]+)(?:\?\S*)? HTTP\//.exec(requestLine);
    if (!m) return undefined;
    switch (m[1]) {
      case '/v1/chat/completions':
        return 'chat';
      case '/v1/messages':
        return 'anthropic';
      case '/v1/responses':
        return 'responses';
      case '/v1/systemone':
        return 'systemone';
      default:
        return undefined; // anything unrecognized
    }
  }

  /**
   * The flattened text of a request body's LAST user slot. Display only:
   * `promptSummary` never decides a turn boundary. Bodies that are not a
   * message array still answers text where a surface has an obvious text
   * channel (plain-string `input`, System One `state`); unparseable bodies
   * answer none and render the empty-prompt glyph.
   */
  private static lastUserSlot(
    request: unknown,
    depth = 0
  ): { text?: string } | undefined {
    if (request === null || request === undefined || depth > 2) return undefined;
    if (typeof request === 'string') {
      // Same truncation-repair contract as firstHumanUserText.
      const trimmed = request.endsWith(TRUNCATION_SUFFIX)
        ? request.slice(0, -TRUNCATION_SUFFIX.length)
        : request;
      try {
        return CaptureRecorder.lastUserSlot(JSON.parse(trimmed), depth + 1);
      } catch {
        const repaired = CaptureRecorder.repairTruncatedJson(trimmed);
        if (repaired !== null) return CaptureRecorder.lastUserSlot(repaired, depth + 1);
        return { text: trimmed.slice(0, 300) };
      }
    }
    if (typeof request !== 'object') return undefined;
    const body = request as Record<string, unknown>;
    if (Array.isArray(body.messages)) return CaptureRecorder.lastUserSlotInMessages(body.messages);
    if (Array.isArray(body.input)) return CaptureRecorder.lastUserSlotInMessages(body.input);
    if (typeof body.input === 'string') return { text: body.input };
    // System One decision surface — evaluated content lives in `state`.
    return { text: CaptureRecorder.stateText(body.state) };
  }

  /**
   * The FIRST user message that carries HUMAN text — the client-envelope
   * normalizer's rules, not the first user-role message. Cursor's agent opens
   * with a standalone `<user_info>`/`<rules>`/`<mcp_server_catalog>` bundle and
   * puts the real prompt in the NEXT `<user_query>` message, so taking the
   * first user role verbatim titled capture sessions with an OS banner. Same
   * strict-then-permissive rule as the console session title
   * (`firstDisplayText`), so every surface names a conversation identically.
   */
  private static firstHumanUserText(request: unknown, depth = 0): string | undefined {
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
        return CaptureRecorder.firstHumanUserText(JSON.parse(trimmed), depth + 1);
      } catch {
        const repaired = CaptureRecorder.repairTruncatedJson(trimmed);
        if (repaired !== null) return CaptureRecorder.firstHumanUserText(repaired, depth + 1);
        return trimmed.slice(0, 300);
      }
    }
    if (typeof request !== 'object') return undefined;
    const body = request as Record<string, unknown>;
    if (Array.isArray(body.messages)) {
      return CaptureRecorder.firstHumanText(body.messages) ?? CaptureRecorder.stateText(body.state);
    }
    if (Array.isArray(body.input)) {
      return CaptureRecorder.firstHumanText(body.input) ?? CaptureRecorder.stateText(body.state);
    }
    if (typeof body.input === 'string') return body.input;
    // System One decision surface — evaluated content lives in `state`.
    return CaptureRecorder.stateText(body.state);
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

  /**
   * Text of one message's content (string, or joined text parts). Undefined
   * for non-text content — the callers treat that differently on purpose.
   */
  private static messageText(m: unknown): string | undefined {
    if (!m || typeof m !== 'object' || !('content' in m)) return undefined;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return undefined;
    const parts = content
      .map(p => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  /**
   * The last user message of a message array, flattened to display text.
   * Pure presentation: turn boundaries are decided structurally by
   * `classifyTurnBoundary`, never by this text or its position.
   */
  private static lastUserSlotInMessages(messages: unknown[]): { text?: string } {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object' || !('role' in msg) || msg.role !== 'user') continue;
      return { text: CaptureRecorder.messageText(msg) };
    }
    return {};
  }

  /**
   * The FIRST user message that carries HUMAN text (client envelopes stripped)
   * — the capture session preview's opening prompt. Walks forward and skips
   * metadata-only / image-only messages, exactly like the console title.
   */
  private static firstHumanText(messages: unknown[]): string | undefined {
    const texts: string[] = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object' || !('role' in msg) || msg.role !== 'user') continue;
      const text = CaptureRecorder.messageText(msg);
      if (text) texts.push(text);
    }
    return firstDisplayText(texts, 300);
  }

  /** Local-timezone YYYY-MM-DD — retention is by calendar day as users see it. */
  public static localDateDir(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
