import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RequestCaptureConfig } from '../config/types.js';
import { getEnvPaths } from '../config/env.js';
import { renameWithRetry } from '../utils/atomic-write.js';
import { DEFAULT_MAX_BODY_BYTES } from '../config/defaults.js';
import { setCaptureSecretRedaction } from '../observability/http-exchange.js';
import { displayPromptText, firstDisplayText } from '../utils/client-envelope.js';

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
 *     with the same `exchangeId` describe one exchange; their `ts`
 *     delta IS the request→response latency, computed at read time.
 *   - **Symmetry across client and upstream legs**: each direction emits
 *     its own request + response event, all four sharing one `requestId`
 *     (the gateway turn id) so the full picture joins back together.
 *
 * A single inference turn produces 2-4 events sharing the same `requestId`:
 * client-request, gateway-response, upstream-request, upstream-response.
 * File layout keeps the per-turn grouping (same `sessionId`) so the
 * session browser keeps working while the events stay individually
 * retrievable.
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
   * Gateway-owned id of the INFERENCE TURN these events belong to (ADR-0021)
   * — the turn-join key. Every event of one client request carries it;
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
   * Flattened LAST user message of the request, capped — stamped on
   * client-request events at write time so metadata-only reads
   * (`bodies=none`) can still render the turn prompt in the console
   * timeline. Absent on other phases/directions and for bodies without user
   * text. Note this is the *last user message of the body*, which for a
   * tool-result continuation is the PREVIOUS turn's prompt (clients resend
   * the whole history) — the read plane drops it in that case, see
   * `promptLastUserIdx`.
   */
  promptSummary?: string;
  /**
   * Length of the client-request body's message array (post-parse, raw as
   * received) — the floor the NEXT turn's `promptLastUserIdx` is compared
   * against: clients append, so a genuinely new user message always lands at
   * or past this index. Stamped with `promptSummary`; absent when the body
   * carries no message array (plain-string `input`, System One `state`, a
   * non-JSON / unrepairable body).
   */
  promptMessageCount?: number;
  /**
   * Index of the last user-role message inside `promptMessageCount`; absent
   * when that array has no user message. An index BELOW the previous turn's
   * `promptMessageCount` — with this turn's array no shorter than that
   * previous one — means the message already existed at the previous turn:
   * resent history, not this turn's question, so `groupEventsIntoTurns`
   * drops `promptSummary` and the timeline renders the no-prompt glyph. A
   * shrunk array (client-side compaction) disables the test: every index
   * moved, and the last user message is normally the new prompt. Same rule
   * the session plane applies to `userPromptSummary` (see the orchestrator's
   * trace record).
   */
  promptLastUserIdx?: number;
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
 * `requestId` (see `groupEventsIntoTurns`).
 */
export interface CaptureTurnSummary {
  /** Gateway turn id (ADR-0021) — the join key. */
  requestId: string;
  /** Caller correlation value, carried over from the client-request event. */
  clientRequestId?: string;
  sessionId: string;
  model: string;
  /**
   * 1-based REQUEST sequence number — one per client request, the same unit
   * as the trace plane's `turnNumber` (backed by `ExecutionTrace.turnNumber`,
   * see `trace/tracker.ts`). Numbered inside the read
   * window; the read response carries `windowRequests` so the console can
   * offset it against the exact archive tally and show an absolute number.
   * Absent on turns whose client-request event fell outside the window (a
   * continuation leg, not a request).
   */
  requestNumber?: number;
  /**
   * 1-based PROMPT-ROUND number — one per user prompt plus the requests it
   * drove (tool-call hops). Continuation turns share their round's number.
   * Numbered inside the read window; a leading prompt-less block is the
   * visible tail of a round whose prompt sits outside the window and opens
   * round 1. This is the console's "轮次" — never the request count.
   */
  roundNumber?: number;
  /**
   * This turn's NEW user prompt — lifted from the client-request event, and
   * BLANKED when that request only resent the previous turn's user message
   * (see groupEventsIntoTurns). Absent = the turn carried no fresh user
   * message (tool-result continuation), rendered as the no-prompt glyph.
   */
  promptSummary?: string;
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

/**
 * One user-prompt round over the WHOLE archive (not a read window): the
 * prompt and the contiguous request range it drove. `firstRequest` /
 * `lastRequest` are 1-based chronological request numbers, so the console can
 * map a round onto any page without loading full bodies.
 */
export interface CaptureRoundIndexEntry {
  /** 1-based chronological round number over the whole conversation. */
  ordinal: number;
  /** New user message that opened the round; absent for a legacy archive. */
  prompt?: string;
  /** Request send time (epoch ms) of the round's first request. */
  startTs?: number;
  /** Client requests in this round (the prompt turn + tool-loop hops). */
  requests: number;
  firstRequest: number;
  lastRequest: number;
}

/** Exact whole-archive totals + the prompt-round index (metadata only). */
export interface CaptureArchiveSummary {
  requests: number;
  fragments: number;
  rounds: CaptureRoundIndexEntry[];
}

interface RequestIndexState {
  requests: number;
  rounds: CaptureRoundIndexEntry[];
  /** sessionId → previous request's prompt message count (continuation floor). */
  lastMessageCount: Map<string, number>;
}

const newRequestIndexState = (): RequestIndexState => ({
  requests: 0,
  rounds: [],
  lastMessageCount: new Map(),
});

/** Targeted line scans: the archive is compact JSON written by this recorder. */
const RE_CAPTURE_SESSION_ID = /"sessionId":"((?:[^"\\]|\\.)*)"/;
const RE_CAPTURE_TS = /"ts":(\d+)/;
const RE_CAPTURE_PROMPT_SUMMARY = /"promptSummary":("(?:[^"\\]|\\.)*")/;
const RE_CAPTURE_PROMPT_COUNT = /"promptMessageCount":(\d+)/;
const RE_CAPTURE_PROMPT_LAST_USER = /"promptLastUserIdx":(\d+)/;

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
 * `bodies='chat'` retention: the conversation replay needs each ROUND
 * OPENER's client-request body (it carries the full history up to that
 * prompt) plus every response body; the multi-MB continuation request bodies
 * repeat the same history and only bloat memory. Upstream request bodies are
 * byte-identical to their client counterpart, so they always go.
 */
const stripBodiesForChat = (events: HttpExchangeEvent[], keepRequests: Set<HttpExchangeEvent>): void => {
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
  // Per-session seal bookkeeping: cached byte size per archive path + which
  // archives already got their terminal `archive-overflow` line.
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
   * `exchangeId`. One inference turn typically produces 2-4 events
   * sharing the same `requestId`. Synchronous callers (handler scope,
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
      ...(event.direction === 'client' && event.phase === 'request'
        ? CaptureRecorder.turnPromptStamp(truncatedReq.value ?? '')
        : {}),
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
        let protocol: CaptureSessionProtocol | undefined;
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
                const ev = CaptureRecorder.normalizeArchivedEvent(rec as Record<string, unknown>);
                if (ev) streamEvents.push(ev);
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
                // Inbound-protocol badge: the FIRST client request's request
                // line wins; a req-less emission (empty line) keeps looking.
                if (protocol === undefined && rec.direction === 'client' && rec.phase === 'request') {
                  protocol = CaptureRecorder.protocolFromRequestLine(rec.wire?.requestLine);
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
  ): Promise<{ events: HttpExchangeEvent[]; fileTruncated: boolean; fileBytes: number; windowBytes: number }> {
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

    const events: HttpExchangeEvent[] = [];
    const yieldLoop = () => new Promise<void>(r => setImmediate(r));
    const BATCH = 128; // lines per event-loop slice
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj.eventType === 'http-exchange') {
          const ev = CaptureRecorder.normalizeArchivedEvent(obj);
          if (!ev) continue;
          deriveCompletionTokens(ev);
          events.push(ev);
        }
        // Legacy turn-snapshot lines (`cap_…`, written by the retired
        // record()) are skipped here: they are not HTTP-exchange events and
        // carry no request id, so they cannot join a turn. The raw export
        // endpoint still serves such archives verbatim.
      } catch {
        // Corrupt/partial line — skip, never fail the whole read.
      }
      if ((i + 1) % BATCH === 0) await yieldLoop();
    }
    return { events, fileTruncated, fileBytes, windowBytes };
  }
  /**
   * One boundary normalization for archive lines written before ADR-0021:
   * those files carry the wire vocabulary (`spanId` / `traceId`) and no
   * `requestId`. Mapping them here keeps the DOMAIN model single-vocabulary —
   * no reader downstream sees two spellings. A legacy file has no turn id, so
   * its caller correlation value becomes the join key: exactly the behaviour
   * (and the ambiguity) those archives had when they were written. Removable
   * once capture retention has passed the cutover date.
   *
   * A line carrying NEITHER a request id nor a caller value is corrupt (the
   * writer always stamped one of them): return `null` so the caller skips it —
   * keying every such line on `''` would merge unrelated turns.
   */
  private static normalizeArchivedEvent(obj: Record<string, unknown>): HttpExchangeEvent | null {
    if (typeof obj.requestId === 'string' && obj.requestId && typeof obj.exchangeId === 'string') {
      return obj as unknown as HttpExchangeEvent;
    }
    const clientRequestId = typeof obj.clientRequestId === 'string' && obj.clientRequestId
      ? obj.clientRequestId
      : typeof obj.traceId === 'string' && obj.traceId
        ? obj.traceId
        : undefined;
    const requestId = typeof obj.requestId === 'string' && obj.requestId
      ? obj.requestId
      : clientRequestId;
    if (!requestId) return null;
    const exchangeId = typeof obj.exchangeId === 'string'
      ? obj.exchangeId
      : typeof obj.spanId === 'string'
        ? obj.spanId
        : '';
    return {
      ...obj,
      exchangeId,
      requestId,
      ...(clientRequestId ? { clientRequestId } : {}),
      sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : '',
    } as unknown as HttpExchangeEvent;
  }


  /**
   * Read HTTP exchange events from one archive file, newest `limit` events
   * in chronological order. Returns events + a `turns` summary that
   * groups the events by `requestId` (exchangeId-aware) so the console can
   * render them as logical turns. The underlying file is also bounded at
   * readWindowBytes() (pathologically large archives are tailed; the tail is
   * what matters). `bodies='none'` strips wire bodies for metadata-first
   * console reads — the tok/s chips keep working via the derived
   * `completionTokens` field, and full bodies come back on demand
   * (readTurn / bodies='full').
   *
   * `page` (1-based, counted from the NEWEST end) pages backwards in REQUESTS:
   * page 1 is the newest `limit` logical turns, page 2 the block just older
   * than it, and so on. Paging in turns (not raw event lines) is what makes
   * the console's pager summary speak the same unit as its header, and a page
   * can never hold half a turn — the four events of a turn always travel
   * together.
   *
   * The read window GROWS to cover the requested page: a 13 MB body per
   * request means a few requests can fill the default window, and a console
   * that stopped there would look like it lost history the trace plane still
   * shows. Growth doubles the window until the page fits, the whole file is
   * read, or READ_WINDOW_GROWTH_CEIL_BYTES is reached — past the ceiling the
   * response clamps `page`/`totalPages` (the pager self-heals) and deeper
   * history stays export-only, so one pager click can never allocate a
   * seal-sized buffer.
   */
  public async readEvents(
    date: string,
    file: string,
    limit = 50,
    bodies: 'full' | 'none' | 'chat' = 'full',
    page = 1
  ): Promise<{
    events: HttpExchangeEvent[];
    turns: CaptureTurnSummary[];
    totalLines: number;
    /** Logical turn count over ALL events in the read window (totalLines is
     * raw event lines — 2-4 per turn — so it must never be shown as turns). */
    totalTurns: number;
    /** Requests (turns with a client-request event) in the read window —
     *  the offset the console applies to `requestNumber` for absolute #. */
    windowRequests: number;
    /** User-prompt rounds in the read window: one per turn carrying a NEW
     *  prompt, plus a leading partial block when the window starts mid-round. */
    totalRounds: number;
    /** The window is the WHOLE file (false = only its tail was read). */
    windowComplete: boolean;
    fileTruncated: boolean;
    /** The page actually served (clamped into [1, totalPages]). */
    page: number;
    /** Pages available in the read window (turn pages). */
    totalPages: number;
    /** Older turns remain in the read window (page < totalPages). */
    hasOlder: boolean;
    /** Newer turns exist (page > 1). */
    hasNewer: boolean;
  }> {
    const size = Math.max(1, limit);
    // One page plus one turn proves "older exists"; growing until then makes
    // hasOlder exact instead of window-relative.
    const needed = page * size + 1;
    let minBytes = 0;
    let read = await this.readWindowEvents(date, file, minBytes);
    for (;;) {
      const groups = CaptureRecorder.groupEventsIntoTurns(read.events);
      if (groups.length >= needed || !read.fileTruncated) break;
      const next = Math.min(
        Math.max(read.windowBytes * 2, this.readWindowBytes()),
        READ_WINDOW_GROWTH_CEIL_BYTES
      );
      if (next <= read.windowBytes) break; // ceiling reached (or no growth) — stay put
      minBytes = next;
      read = await this.readWindowEvents(date, file, minBytes);
    }
    const { events, fileTruncated, windowBytes } = read;
    void windowBytes;
    const windowComplete = !fileTruncated;

    // Turn boundaries are structural (direction/phase/requestId), so this first
    // pass only exists to locate the page; the stamps backfilled below do not
    // change it, which is why the indices stay valid for the second pass.
    const groups = CaptureRecorder.groupEventsIntoTurns(events);
    const totalPages = Math.max(1, Math.ceil(groups.length / size));
    const pageNo = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
    const end = groups.length - (pageNo - 1) * size;
    const sliceStart = Math.max(0, end - size);
    const pageTurns = groups.slice(sliceStart, Math.max(sliceStart, end));
    // The page's events — exactly the legs of its turns, in wire order.
    const visible = new Set<HttpExchangeEvent>();
    for (const t of pageTurns) {
      for (const ev of [t.clientRequest, t.gatewayResponse, t.upstreamRequest, t.upstreamResponse, t.decisionRequest, t.decisionResponse]) {
        if (ev) visible.add(ev);
      }
    }
    const newest = events.filter(ev => visible.has(ev));
    // Positions must be derived while the bodies are still attached.
    CaptureRecorder.backfillPromptPositions(events, newest);

    // Group over the WHOLE read window, then keep the turns on this page.
    // Grouping only the page would lose the previous client request a
    // prompt-staleness decision needs (see groupEventsIntoTurns), so the
    // oldest visible continuation would show the resent prompt again. One
    // grouping pass also owns `totalTurns` — the header's turn count must use
    // that, not totalLines (raw event lines, 2-4 per turn).
    const allTurns = CaptureRecorder.groupEventsIntoTurns(events);
    const totals = CaptureRecorder.numberTurns(allTurns);
    if (bodies === 'none') stripBodies(events);
    else if (bodies === 'chat') {
      const keepRequests = new Set<HttpExchangeEvent>();
      allTurns.forEach((t, i) => {
        if (t.clientRequest && (t.promptSummary || i === 0)) keepRequests.add(t.clientRequest);
      });
      stripBodiesForChat(events, keepRequests);
    }
    const turns = CaptureRecorder.turnsInWindow(allTurns, newest);
    const hasOlder = sliceStart > 0;
    return {
      events: newest,
      turns,
      totalLines: events.length,
      totalTurns: allTurns.length,
      windowRequests: totals.requests,
      totalRounds: totals.rounds,
      windowComplete,
      fileTruncated,
      page: pageNo,
      totalPages,
      hasOlder,
      hasNewer: pageNo > 1,
    };
  }

  /**
   * Number a window's turns in chronological order on TWO separate axes:
   *   - `requestNumber` — one per client request (the unit the trace plane
   *     calls `turnNumber` — `ExecutionTrace.turnNumber`, `trace/tracker.ts`),
   *     never per tool-result continuation.
   *     Turns whose client-request event fell outside the window keep no
   *     number: they are the tail of a request whose number lives on an
   *     older page.
   *   - `roundNumber` — one per USER PROMPT plus every request it drove; a
   *     continuation shares its round's number. A leading prompt-less block
   *     is the visible tail of a round that started outside the window and
   *     therefore opens round 1.
   * The returned totals are the read window's request and round counts.
   */
  private static numberTurns(turns: CaptureTurnSummary[]): { requests: number; rounds: number } {
    let requests = 0;
    let rounds = 0;
    for (const t of turns) {
      if (t.clientRequest) t.requestNumber = ++requests;
      else delete t.requestNumber;
      if (t.promptSummary || rounds === 0) rounds++;
      t.roundNumber = rounds;
    }
    return { requests, rounds };
  }

  /**
   * Read one turn's FULL wire bodies. The key is the turn id (`requestId`,
   * what the console row carries and every React key uses); an EVENT id
   * (`evt_…`) is accepted too for deep links, since a turn is a set of
   * events and either id names it unambiguously. Returns null when the key
   * is unknown or falls outside the read window.
   */
  public async readTurn(
    date: string,
    file: string,
    turnOrEventId: string
  ): Promise<{ turn: CaptureTurnSummary } | null> {
    const { events } = await this.readWindowEvents(date, file);
    // Event id first (exact, cheap); then the turn id, which selects the
    // request event so the prompt backfill below starts from the same floor.
    const anchor =
      events.find(e => e.id === turnOrEventId) ??
      events.find(e => e.requestId === turnOrEventId);
    if (!anchor) return null;
    // Group the WHOLE window, not just the anchor's turn: the prompt
    // staleness decision compares against the session's previous client
    // request, so a request-only subset would re-show the resent prompt in the
    // drawer. Grouping is metadata-only — the bodies ride on the same objects.
    // Legacy archives carry `promptSummary` without its staleness basis —
    // derive it from the still-attached bodies before grouping. The pass
    // starts at the request BEFORE the anchor (it sets the anchor's floor)
    // and runs to the end of the window; already-stamped events are skipped,
    // so it is a no-op for archives written by this build.
    CaptureRecorder.backfillPromptPositions(events, [anchor]);
    const allTurns = CaptureRecorder.groupEventsIntoTurns(events);
    CaptureRecorder.numberTurns(allTurns);
    const turn = allTurns.find(
      t =>
        t.requestId === anchor.requestId ||
        [t.clientRequest, t.gatewayResponse, t.upstreamRequest, t.upstreamResponse, t.decisionRequest, t.decisionResponse]
          .some(e => e?.id === anchor.id)
    );
    return turn ? { turn } : null;
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
    events: HttpExchangeEvent[];
    turns: CaptureTurnSummary[];
    totalLines: number;
    totalTurns: number;
    windowRequests: number;
    totalRounds: number;
    windowComplete: boolean;
    fileTruncated: boolean;
    fragments: { date: string; file: string; turns: number }[];
    page: number;
    totalPages: number;
    hasOlder: boolean;
    hasNewer: boolean;
  }> {
    const fragments = this.conversationFragments(date, file);
    const size = Math.max(1, limit);
    const needed = page * size + 1;
    // Same window growth as readEvents, applied per fragment: a shard whose
    // bodies blow past the default window is grown until the merged timeline
    // covers the requested page (or every shard is read whole).
    let minBytes = 0;
    let merged = new Map<string, HttpExchangeEvent>();
    let fileTruncated = false;
    let fragmentRows: { date: string; file: string; turns: number }[] = [];
    for (;;) {
      merged = new Map<string, HttpExchangeEvent>();
      fragmentRows = [];
      fileTruncated = false;
      let grew = false;
      let maxWindow = 0;
      for (const f of fragments) {
        const result = await this.readWindowEvents(f.date, f.file, minBytes);
        if (result.fileTruncated) fileTruncated = true;
        if (result.windowBytes > maxWindow) maxWindow = result.windowBytes;
        if (result.fileBytes > result.windowBytes) grew = true;
        for (const ev of result.events) {
          if (!merged.has(ev.id)) merged.set(ev.id, ev);
        }
        fragmentRows.push({
          date: f.date,
          file: f.file,
          turns: CaptureRecorder.groupEventsIntoTurns(result.events).length,
        });
      }
      const all = [...merged.values()].sort((a, b) => a.ts - b.ts);
      const groups = CaptureRecorder.groupEventsIntoTurns(all);
      if (groups.length >= needed || !grew) break;
      const next = Math.min(Math.max(maxWindow * 2, this.readWindowBytes()), READ_WINDOW_GROWTH_CEIL_BYTES);
      if (next <= maxWindow) break; // ceiling reached — stay put
      minBytes = next;
    }
    const all = [...merged.values()].sort((a, b) => a.ts - b.ts);

    // Same turn-page arithmetic as readEvents: locate the page on a first
    // structural grouping pass, then re-group for the prompt-staleness stamps
    // (they never move a turn boundary).
    const groups = CaptureRecorder.groupEventsIntoTurns(all);
    const totalPages = Math.max(1, Math.ceil(groups.length / size));
    const pageNo = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
    const end = groups.length - (pageNo - 1) * size;
    const sliceStart = Math.max(0, end - size);
    const pageTurns = groups.slice(sliceStart, Math.max(sliceStart, end));
    const visible = new Set<HttpExchangeEvent>();
    for (const t of pageTurns) {
      for (const ev of [t.clientRequest, t.gatewayResponse, t.upstreamRequest, t.upstreamResponse, t.decisionRequest, t.decisionResponse]) {
        if (ev) visible.add(ev);
      }
    }
    const newest = all.filter(ev => visible.has(ev));
    // Positions must be derived while the bodies are still attached.
    CaptureRecorder.backfillPromptPositions(all, newest);
    const allTurns = CaptureRecorder.groupEventsIntoTurns(all);
    const totals = CaptureRecorder.numberTurns(allTurns);
    if (bodies === 'none') stripBodies(all);
    else if (bodies === 'chat') {
      const keepRequests = new Set<HttpExchangeEvent>();
      allTurns.forEach((t, i) => {
        if (t.clientRequest && (t.promptSummary || i === 0)) keepRequests.add(t.clientRequest);
      });
      stripBodiesForChat(all, keepRequests);
    }
    const turns = CaptureRecorder.turnsInWindow(allTurns, newest);
    const hasOlder = sliceStart > 0;
    return {
      events: newest,
      turns,
      totalLines: all.length,
      totalTurns: allTurns.length,
      windowRequests: totals.requests,
      totalRounds: totals.rounds,
      windowComplete: !fileTruncated,
      fileTruncated,
      fragments: fragmentRows,
      page: pageNo,
      totalPages,
      hasOlder,
      hasNewer: pageNo > 1,
    };
  }

  /**
   * readTurn across ALL fragments of the session: the anchor fragment's
   * window is tried first, then every other fragment — a turn archived in a
   * previous day's shard must still open its full wire bodies.
   *
   * Known limit: the prompt-staleness basis lives in the same fragment's
   * window, so a turn that is the FIRST of a day shard may still show the
   * resent prompt in the drawer (its predecessor sits in the previous shard).
   * The stitched timeline is exact — it groups all fragments together.
   */
  public async readTurnStitched(date: string, file: string, turnOrEventId: string): Promise<{ turn: CaptureTurnSummary } | null> {
    for (const f of this.conversationFragments(date, file)) {
      const result = await this.readTurn(f.date, f.file, turnOrEventId);
      if (result) return result;
    }
    return null;
  }

  /* -------------------------------------------------- exact archive summary */

  /**
   * EXACT whole-archive summary, not the read window: the request count and
   * the USER-PROMPT ROUND INDEX (prompt + contiguous request range).
   *
   * Every request starts with one client-request event (see
   * groupEventsIntoTurns: a client request ALWAYS opens a turn), and that line
   * is written exactly once, so this scan counts requests without grouping.
   * Legacy `cap_` turn records (one line per turn, pre-events) count as one
   * each; the terminal `archive-overflow` seal line carries `eventType` and is
   * skipped.
   *
   * Streamed in chunks so a seal-maximum session (512 MB) never becomes one
   * string on the heap. Prompt metadata and positions are pulled with
   * targeted regexes — never JSON.parse on the whole line, whose request body
   * can be many MB. Rounds use the SAME continuation rule as
   * groupEventsIntoTurns (a resent previous user message does not open a new
   * round), so the dropdown and the timeline agree.
   *
   * The result is DISPLAY ONLY: pagination still reads a bounded window.
   */
  public async captureSummary(date: string, file: string): Promise<CaptureArchiveSummary> {
    const filePath = this.resolveArchiveFile(date, file);
    if (!filePath) return { requests: 0, fragments: 1, rounds: [] };
    const sig = this.archiveSignature([filePath]);
    const cached = sig ? this.summaryCache.get(sig) : undefined;
    if (cached) return cached;
    const state = newRequestIndexState();
    await this.scanRequestIndex(filePath, state);
    const summary = { requests: state.requests, fragments: 1, rounds: state.rounds };
    if (sig) this.rememberSummary(sig, summary);
    return summary;
  }

  /**
   * Whole STITCHED conversation: fragments in chronological order, with the
   * continuation state carried across the midnight boundary. A request's
   * client-request line lives in exactly one shard, so it is counted once.
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
    const summary = { requests: state.requests, fragments: paths.length, rounds: state.rounds };
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
   * Byte-level: 2-4 event lines share a multi-MB request body, so the stream
   * stays a Buffer and only a matching client-request line is decoded. This
   * keeps the whole-archive scan proportional to the metadata, not the wire
   * bodies.
   */
  private async scanRequestIndex(filePath: string, state: RequestIndexState): Promise<void> {
    const take = (line: Buffer): void => {
      if (line.length === 0) return;
      if (line.indexOf('"eventType"') >= 0) {
        if (
          line.indexOf('"eventType":"http-exchange"') < 0 ||
          line.indexOf('"direction":"client"') < 0 ||
          line.indexOf('"phase":"request"') < 0
        ) {
          return;
        }
        const text = line.toString('utf8');
        state.requests++;
        const n = state.requests;
        const sessionId = RE_CAPTURE_SESSION_ID.exec(text)?.[1] ?? '';
        const tsMatch = RE_CAPTURE_TS.exec(text);
        const ts = tsMatch ? Number(tsMatch[1]) : undefined;
        const rawPrompt = RE_CAPTURE_PROMPT_SUMMARY.exec(text)?.[1];
        let prompt: string | undefined;
        if (rawPrompt !== undefined) {
          try {
            prompt = JSON.parse(rawPrompt);
          } catch {
            prompt = undefined; // truncated/sealed line — treat as no prompt
          }
        }
        const countMatch = RE_CAPTURE_PROMPT_COUNT.exec(text);
        const count = countMatch ? Number(countMatch[1]) : undefined;
        const idxMatch = RE_CAPTURE_PROMPT_LAST_USER.exec(text);
        const idx = idxMatch ? Number(idxMatch[1]) : undefined;
        const prevCount = state.lastMessageCount.get(sessionId);
        const resent =
          prevCount !== undefined &&
          count !== undefined &&
          count >= prevCount &&
          idx !== undefined &&
          idx < prevCount;
        if (resent) prompt = undefined;
        if (prompt !== undefined || state.rounds.length === 0) {
          state.rounds.push({
            ordinal: state.rounds.length + 1,
            prompt,
            startTs: ts !== undefined && Number.isFinite(ts) ? ts : undefined,
            requests: 0,
            firstRequest: n,
            lastRequest: n,
          });
        }
        const round = state.rounds[state.rounds.length - 1];
        round.requests++;
        round.lastRequest = n;
        if (count !== undefined) state.lastMessageCount.set(sessionId, count);
        return;
      }
      // Legacy turn-shaped record (pre-events archive): one line per request.
      if (line.indexOf('"id":"cap_') >= 0) {
        state.requests++;
        state.rounds.push({
          ordinal: state.rounds.length + 1,
          requests: 1,
          firstRequest: state.requests,
          lastRequest: state.requests,
        });
      }
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
   * Group a flat list of HTTP exchange events into logical turns by the
   * gateway-owned `requestId` (ADR-0021) — the events of ONE client request.
   * Each turn joins its four events: client-direction events pair by
   * `exchangeId`, upstream events attach to the request's active turn
   * (last-write-wins across failover hops). Legacy archives are normalized to
   * this shape at the reader boundary, so there is exactly one key here.
   * Pure function — exported for unit tests.
   */
  public static groupEventsIntoTurns(events: HttpExchangeEvent[]): CaptureTurnSummary[] {
    const byTurn = new Map<string, CaptureTurnSummary[]>();
    /** requestId → the turn upstream events should attach to (the latest). */
    const activeByTurn = new Map<string, CaptureTurnSummary>();
    /** sessionId → message count of the session's previous client request; the
     *  floor a turn's `promptLastUserIdx` must reach to be a NEW user message. */
    const lastMessageCount = new Map<string, number>();

    const newTurn = (ev: HttpExchangeEvent): CaptureTurnSummary => {
      const t: CaptureTurnSummary = {
        requestId: ev.requestId,
        ...(ev.clientRequestId ? { clientRequestId: ev.clientRequestId } : {}),
        sessionId: ev.sessionId,
        model: ev.model,
      };
      let list = byTurn.get(ev.requestId);
      if (!list) {
        list = [];
        byTurn.set(ev.requestId, list);
      }
      list.push(t);
      return t;
    };

    for (const ev of events) {
      let t: CaptureTurnSummary | undefined;
      if (ev.direction === 'client' && ev.phase === 'request') {
        // A client request ALWAYS starts a new turn — the turn id is the
        // gateway's per-request id, so two requests that share a caller
        // trace id stay two turns; each gets its own row instead of one
        // giant merged turn with last-write-wins fields.
        t = newTurn(ev);
        t.clientRequest = ev;
        // The stamped prompt is the body's LAST user message — for a
        // tool-result continuation that is the PREVIOUS turn's prompt resent
        // inside the history, and quoting it again made every continuation
        // row in the timeline read as a duplicate. Clients append, so a
        // genuinely new user message always sits at or past the previous
        // request's message count; below it, drop the summary and let the
        // timeline render the no-prompt glyph. Same rule the session plane
        // applies to `userPromptSummary`; events archived before the stamp
        // existed carry no positions and keep their summary unchanged.
        // The index test assumes an APPENDED history: when the client shrank
        // its own array (compaction / truncation) every index moved down, so
        // an index below the previous count proves nothing and the last user
        // message is normally the new turn's prompt — show it.
        const prevCount = lastMessageCount.get(ev.sessionId);
        const resent = prevCount !== undefined
          && ev.promptMessageCount !== undefined
          && ev.promptMessageCount >= prevCount
          && ev.promptLastUserIdx !== undefined
          && ev.promptLastUserIdx < prevCount;
        t.promptSummary = resent ? undefined : ev.promptSummary;
        if (ev.promptMessageCount !== undefined) lastMessageCount.set(ev.sessionId, ev.promptMessageCount);
        activeByTurn.set(ev.requestId, t);
      } else if (ev.direction === 'client' && ev.phase === 'response') {
        // Pair by exchangeId with the matching client request (newest first —
        const list = byTurn.get(ev.requestId) ?? [];
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].clientRequest?.exchangeId === ev.exchangeId) {
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
        t = activeByTurn.get(ev.requestId);
        if (!t) {
          t = newTurn(ev);
          activeByTurn.set(ev.requestId, t);
        }
        if (ev.phase === 'request') t.decisionRequest = ev;
        else t.decisionResponse = ev;
      } else {
        // Upstream events attach to the trace's active turn. Failover hops
        // overwrite each other (last-write-wins) — the final attempt is
        // the one that produced the gateway response.
        t = activeByTurn.get(ev.requestId);
        if (!t) {
          t = newTurn(ev);
          activeByTurn.set(ev.requestId, t);
        }
        if (ev.phase === 'request') t.upstreamRequest = ev;
        else t.upstreamResponse = ev;
      }
      if (ev.error && !t.error) t.error = ev.error;
    }
    const all: CaptureTurnSummary[] = [];
    for (const list of byTurn.values()) all.push(...list);
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
   * The turns whose events survived a tail slice, in the slice's own object
   * identity terms: group over the FULL window (so cross-turn derivations
   * see their predecessor) and keep only turns still anchored in `window`.
   * A turn created from a stray trailing response (its client request fell
   * outside the read window) has no event in the slice and drops out, exactly
   * as the old slice-then-group order did.
   */
  private static turnsInWindow(all: CaptureTurnSummary[], window: HttpExchangeEvent[]): CaptureTurnSummary[] {
    const visible = new Set(window);
    return all.filter(t =>
      [t.clientRequest, t.gatewayResponse, t.upstreamRequest, t.upstreamResponse, t.decisionRequest, t.decisionResponse]
        .some(e => e !== undefined && visible.has(e))
    );
  }

  /**
   * Transitional: archives written before the prompt positions existed carry
   * `promptSummary` without the basis the staleness rule compares against.
   * Derive the positions from the still-attached request body for the client
   * requests the caller is about to render — the tail window plus the one
   * turn immediately before it (that turn sets the floor for the oldest
   * visible continuation) — so the dedupe also covers the retention window
   * written by earlier builds. Persisted lines are never rewritten, and the
   * pass is a no-op once every archive carries the stamps. Must run BEFORE
   * `stripBodies`.
   */
  private static backfillPromptPositions(window: HttpExchangeEvent[], visible: HttpExchangeEvent[]): void {
    const visibleSet = new Set(visible);
    const firstVisible = window.findIndex(ev => visibleSet.has(ev));
    let from = 0;
    if (firstVisible >= 0) {
      for (let i = firstVisible - 1; i >= 0; i--) {
        if (window[i].direction === 'client' && window[i].phase === 'request') {
          from = i;
          break;
        }
      }
    }
    for (let i = from; i < window.length; i++) {
      const ev = window[i];
      if (ev.direction !== 'client' || ev.phase !== 'request') continue;
      if (ev.promptSummary === undefined || ev.promptMessageCount !== undefined) continue;
      const stamp = CaptureRecorder.turnPromptStamp(ev.wire?.requestBody ?? '');
      if (stamp.promptMessageCount !== undefined) ev.promptMessageCount = stamp.promptMessageCount;
      if (stamp.promptLastUserIdx !== undefined) ev.promptLastUserIdx = stamp.promptLastUserIdx;
    }
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
   * The client-request prompt stamp: the display summary PLUS the message
   * positions that let the READ plane decide whether that summary belongs to
   * this turn (see HttpExchangeEvent.promptLastUserIdx). The decision cannot
   * be made here — it needs the previous client request of the same session,
   * which only the archived event stream has (the recorder keeps no
   * cross-turn state; capture stays fail-open and restart-transparent).
   */
  public static turnPromptStamp(request: unknown, cap = 120): {
    promptSummary?: string;
    promptLastUserIdx?: number;
    promptMessageCount?: number;
  } {
    const slot = CaptureRecorder.lastUserSlot(request);
    const summary = CaptureRecorder.summarizePromptText(slot?.text, cap);
    return {
      ...(summary ? { promptSummary: summary } : {}),
      ...(slot?.lastUserIdx !== undefined ? { promptLastUserIdx: slot.lastUserIdx } : {}),
      ...(slot?.messageCount !== undefined ? { promptMessageCount: slot.messageCount } : {}),
    };
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
   * The last user slot of a request body: its flattened text plus the array
   * positions the read plane needs to judge staleness (see
   * HttpExchangeEvent.promptLastUserIdx). `messageCount` is reported even when
   * the array carries no user message — it is the NEXT turn's comparison
   * floor. Both positions stay undefined for bodies whose shape is not a
   * message array (plain-string `input`, System One `state`, unparseable raw
   * bodies), which disables the staleness rule rather than guessing.
   */
  private static lastUserSlot(
    request: unknown,
    depth = 0
  ): { text?: string; lastUserIdx?: number; messageCount?: number } | undefined {
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
   * The last user slot of a message array, with its index. A text-less tail
   * (tool-result continuation) ENDS the walk: quoting an older user message
   * would mislabel the turn, so only the positions come back.
   */
  private static lastUserSlotInMessages(messages: unknown[]): {
    text?: string;
    lastUserIdx?: number;
    messageCount: number;
  } {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object' || !('role' in msg) || msg.role !== 'user') continue;
      return { text: CaptureRecorder.messageText(msg), lastUserIdx: i, messageCount: messages.length };
    }
    return { messageCount: messages.length };
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
