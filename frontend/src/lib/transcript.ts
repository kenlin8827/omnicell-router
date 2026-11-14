/**
 * Session transcript reconstruction for the capture archive.
 *
 * The archive's WRITE-TIME identity decides the structure (ADR-0024):
 * `requestId` groups the HTTP exchanges of one request, `turnIndex` groups
 * the requests of one user-prompt turn. Nothing here infers a boundary from
 * prompt text, message counts, history divergence or resend heuristics —
 * those fields are read, never re-derived.
 *
 * Each request carries the FULL pre-compression request snapshot
 * (`clientRequest.wire.requestBody`, accumulated messages) plus the response
 * wire (JSON or SSE stream). Walking requests oldest-first, the conversation
 * is rebuilt as: [messages new since the previous snapshot] + [this
 * request's parsed assistant output]. No backend projection needed.
 *
 * Degraded cases handled here:
 *  - request bodies cut by `maxBodyBytes` (`...[TRUNCATED]`) — a bracket-repair
 *    pass salvages the largest parseable prefix (mirrors backend
 *    CaptureRecorder.repairTruncatedJson);
 *  - snapshot history rewrites (client-side compaction) — replay resumes from
 *    the divergence point, flagged per request;
 *  - both OpenAI chat-completions and Anthropic messages dialects, streaming
 *    and non-streaming.
 */
import type { CaptureRequestView, CaptureEvent, WireBody } from './api';

const TRUNCATION_SUFFIX = '...[TRUNCATED]';

export interface TranscriptToolCall {
  id: string;
  name: string;
  /** Raw `arguments` string (or JSON of a structured input). */
  args: string;
}

export interface TranscriptBlock {
  /** 'text' prose, or a tool_result part embedded in a content array. */
  kind: 'text' | 'tool_result';
  text: string;
  /** tool_result parts (Anthropic dialect): the call this answers. */
  toolCallId?: string;
}

export interface TranscriptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'unknown';
  blocks: TranscriptBlock[];
  toolCalls: TranscriptToolCall[];
  /** OpenAI role=tool: the call id this message answers. */
  toolCallId?: string;
  /** Resolved via the tool-call registry while walking snapshots. */
  toolName?: string;
}

export interface RequestOutput {
  text: string;
  reasoning: string;
  toolCalls: TranscriptToolCall[];
}

/** One REQUEST's parsed replay — a single step inside a user-prompt turn. */
export interface TranscriptStep {
  /** Index into the page's newest-first `requests` array (drawer contract). */
  idx: number;
  /** The canonical request + its serving-leg view slots. */
  request: CaptureRequestView;
  ts?: number;
  /** Messages that entered the conversation with this request. */
  input: TranscriptMessage[];
  /** Assistant output produced by this request (parsed from the response wire). */
  output: RequestOutput | null;
  hasResponseBody: boolean;
  /** Request body carried the truncation marker (newest tail may be lost). */
  reqTruncated: boolean;
  /** Request body exists but yielded no parseable message array. */
  reqUnparsed: boolean;
  /** Snapshot prefix changed — history was rewritten mid-loop (compaction). */
  diverged: boolean;
}

// ---------------------------------------------------------------- primitives

const bodyToString = (body: WireBody | undefined): string | null =>
  typeof body === 'string' ? body : null;

const safeStringify = (v: unknown): string => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '';
  } catch {
    return '';
  }
};

/**
 * Best-effort recovery of the largest well-formed prefix of a truncated JSON
 * document: one pass tracking string state and the container stack, recording
 * every balanced position; candidates tried newest-first (the newest balanced
 * prefix may end on a value-less key while an older one closes cleanly).
 * Ported from backend CaptureRecorder.repairTruncatedJson.
 */
function repairTruncatedJson(s: string): unknown | null {
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
      return JSON.parse(repaired);
    } catch {
      // Try the next-older balanced prefix.
    }
  }
  return null;
}

function parseJsonLoose(raw: string): unknown | null {
  const s = raw.endsWith(TRUNCATION_SUFFIX) ? raw.slice(0, -TRUNCATION_SUFFIX.length) : raw;
  try {
    return JSON.parse(s);
  } catch {
    return repairTruncatedJson(s);
  }
}

// ------------------------------------------------------- message normalization

function normalizeToolCalls(raw: unknown): TranscriptToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptToolCall[] = [];
  for (const tc of raw) {
    if (!tc || typeof tc !== 'object') continue;
    const t = tc as Record<string, any>;
    const fn = t.function;
    out.push({
      id: typeof t.id === 'string' ? t.id : '',
      name: typeof fn?.name === 'string' ? fn.name : typeof t.name === 'string' ? t.name : '',
      args:
        typeof fn?.arguments === 'string'
          ? fn.arguments
          : safeStringify(t.input ?? ''),
    });
  }
  return out;
}

const stringifyPartContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p =>
        p && typeof p === 'object' && typeof (p as any).text === 'string'
          ? (p as any).text
          : safeStringify(p)
      )
      .join('\n');
  }
  return safeStringify(content);
};

function normalizeMessage(raw: unknown): TranscriptMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, any>;
  const roleRaw = typeof m.role === 'string' ? m.role.toLowerCase() : 'unknown';
  const role = (['system', 'user', 'assistant', 'tool'].includes(roleRaw)
    ? roleRaw
    : 'unknown') as TranscriptMessage['role'];
  const blocks: TranscriptBlock[] = [];
  const content = m.content;
  if (typeof content === 'string') {
    if (content) blocks.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (!p || typeof p !== 'object') {
        if (typeof p === 'string' && p) blocks.push({ kind: 'text', text: p });
        continue;
      }
      const part = p as Record<string, any>;
      if ((part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
        if (part.text) blocks.push({ kind: 'text', text: part.text });
      } else if (part.type === 'tool_result') {
        blocks.push({
          kind: 'tool_result',
          toolCallId: String(part.tool_use_id ?? part.tool_call_id ?? ''),
          text: stringifyPartContent(part.content),
        });
      } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
        // Anthropic history carries thinking blocks inline — surface as prose.
        if (part.thinking) blocks.push({ kind: 'text', text: part.thinking });
      } else {
        // Scrubbed media parts survive as their [MEDIA …] placeholder string —
        // surface it as a text block; the renderer turns it into a chip/img.
        const tok = partMediaToken(part);
        if (tok) blocks.push({ kind: 'text', text: tok });
      }
    }
  }
  const toolCalls = normalizeToolCalls(m.tool_calls);
  const msg: TranscriptMessage = { role, blocks, toolCalls };
  if (typeof m.tool_call_id === 'string' && m.tool_call_id) msg.toolCallId = m.tool_call_id;
  if (!blocks.length && !toolCalls.length && !msg.toolCallId) return null;
  return msg;
}

function normalizeMessages(obj: unknown): TranscriptMessage[] | null {
  if (!obj || typeof obj !== 'object') return null;
  const arr = (obj as Record<string, any>).messages;
  if (!Array.isArray(arr)) return null;
  const out: TranscriptMessage[] = [];
  for (const m of arr) {
    const t = normalizeMessage(m);
    if (t) out.push(t);
  }
  return out;
}

/** Stable identity for cross-snapshot diff/dedup — structural equality. */
const messageKey = (m: TranscriptMessage): string =>
  JSON.stringify([m.role, m.blocks, m.toolCalls.map(c => [c.id, c.name, c.args]), m.toolCallId ?? '']);

// --------------------------------------------------------- response parsing

function parseJsonResponse(obj: unknown): RequestOutput | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, any>;
  // OpenAI chat-completion body
  const choice = Array.isArray(o.choices) ? o.choices[0] : undefined;
  const message = choice?.message;
  if (message && typeof message === 'object') {
    const text =
      typeof message.content === 'string' ? message.content : stringifyPartContent(message.content);
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    const toolCalls = normalizeToolCalls(message.tool_calls);
    if (text || reasoning || toolCalls.length) return { text, reasoning, toolCalls };
    return null;
  }
  // Anthropic non-streaming body: top-level content blocks
  if (Array.isArray(o.content)) {
    let text = '';
    let reasoning = '';
    const toolCalls: TranscriptToolCall[] = [];
    for (const b of o.content) {
      if (!b || typeof b !== 'object') continue;
      const blk = b as Record<string, any>;
      if (blk.type === 'text' && typeof blk.text === 'string') text += blk.text;
      else if (blk.type === 'thinking' && typeof blk.thinking === 'string') reasoning += blk.thinking;
      else if (blk.type === 'tool_use')
        toolCalls.push({ id: String(blk.id ?? ''), name: String(blk.name ?? ''), args: safeStringify(blk.input ?? '') });
    }
    if (text || reasoning || toolCalls.length) return { text, reasoning, toolCalls };
  }
  return null;
}

function parseSseResponse(s: string): RequestOutput | null {
  let text = '';
  let reasoning = '';
  const calls: TranscriptToolCall[] = [];
  for (const line of s.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(payload);
    } catch {
      // A truncated capture cuts the stream tail — keep what accumulated.
      break;
    }
    const choice = Array.isArray(d.choices) ? d.choices[0] : undefined;
    const delta = choice?.delta;
    if (delta && typeof delta === 'object') {
      // OpenAI chat-completion chunk
      if (typeof delta.content === 'string') text += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const i = typeof tc.index === 'number' ? tc.index : calls.length;
          while (calls.length <= i) calls.push({ id: '', name: '', args: '' });
          const slot = calls[i];
          if (typeof tc.id === 'string' && tc.id) slot.id = tc.id;
          if (typeof tc.function?.name === 'string') slot.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
        }
      }
      continue;
    }
    // Anthropic streaming events
    if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') {
      calls.push({ id: String(d.content_block.id ?? ''), name: String(d.content_block.name ?? ''), args: '' });
    } else if (d.type === 'content_block_delta') {
      const dl = d.delta;
      if (dl?.type === 'text_delta' && typeof dl.text === 'string') text += dl.text;
      else if (dl?.type === 'thinking_delta' && typeof dl.thinking === 'string') reasoning += dl.thinking;
      else if (dl?.type === 'input_json_delta' && typeof dl.partial_json === 'string' && calls.length)
        calls[calls.length - 1].args += dl.partial_json;
    }
  }
  const toolCalls = calls.filter(c => c.id || c.name || c.args);
  if (!text && !reasoning && !toolCalls.length) return null;
  return { text, reasoning, toolCalls };
}

/** Parse a captured response wire body into the assistant turn output. */
export function parseAssistantResponse(raw: string): RequestOutput | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    const obj = parseJsonLoose(s);
    return obj ? parseJsonResponse(obj) : null;
  }
  if (/\bdata:/.test(s) || /\bevent:/.test(s)) return parseSseResponse(s);
  return null;
}

/**
 * One wire dialect of streamed completions, as a merge-view adapter:
 * recognize its payloads, accumulate per-stream state, and emit the
 * equivalent NON-STREAM response body. The dialect determines both the
 * chunk shape on the wire and the target shape of the merged body.
 * Adding a dialect (e.g. OpenAI Responses events) means adding one entry
 * to MERGE_ADAPTERS — the driver in mergeSseToNonStream stays
 * dialect-agnostic (same registry idiom as the backend's quota/harness
 * adapters).
 */
interface StreamMergeAdapter<A> {
  /** Dialect id — labels tests and comments; never rendered. */
  readonly id: string;
  /** Does one parsed SSE payload belong to this dialect? */
  recognizes: (chunk: Record<string, any>) => boolean;
  /** Fresh per-stream accumulator. */
  create: () => A;
  /** Ingest one parsed payload; must ignore shapes it does not own. */
  ingest: (acc: A, chunk: Record<string, any>) => void;
  /** Emit the canonical non-stream body; null when nothing merged. */
  finish: (acc: A) => Record<string, unknown> | null;
}

/**
 * OpenAI chat-completions dialect: `chat.completion.chunk` stream →
 * `chat.completion` body. Field set mirrors the backend's
 * ChatCompletionResponse (types/openai.ts): the first chunk donates the
 * envelope (id / created / model / service_tier / system_fingerprint),
 * deltas fold per choice index into message.content / reasoning_content /
 * refusal / annotations / tool_calls / legacy function_call, the last
 * non-null finish_reason and the last usage frame win. Choice-level
 * logprobs are never reconstructed (per-token logprob arrays are not
 * mergeable); usage is omitted when the stream carried no frame.
 */
const openaiChatMerge: StreamMergeAdapter<{
  head: Record<string, any> | null;
  usage: unknown;
  slots: Map<
    number,
    {
      content: string;
      reasoning: string;
      refusal: string;
      annotations: unknown[];
      calls: Map<number, { id: string; name: string; args: string }>;
      fnCall: { name: string; args: string } | null;
      finish: unknown;
    }
  >;
}> = {
  id: 'openai-chat',
  recognizes: chunk => Array.isArray(chunk.choices),
  create: () => ({ head: null, usage: null, slots: new Map() }),
  ingest: (acc, d) => {
    if (!acc.head) acc.head = d;
    // Usage rides terminal frames; some upstreams send it without a choices
    // array, so fold it before the shape guard below (last cumulative wins).
    if (d.usage && typeof d.usage === 'object') acc.usage = d.usage;
    // Mid-stream foreign frames (error events, usage-only payloads) share the
    // data: channel once the dialect is selected — ignore shapes we do not own
    // instead of throwing on them (the driver ingests every later frame).
    if (!Array.isArray(d.choices)) return;
    for (const ch of d.choices) {
      if (!ch || typeof ch !== 'object') continue;
      const i = typeof ch.index === 'number' ? ch.index : 0;
      let slot = acc.slots.get(i);
      if (!slot)
        acc.slots.set(
          i,
          (slot = { content: '', reasoning: '', refusal: '', annotations: [], calls: new Map(), fnCall: null, finish: null })
        );
      const delta = ch.delta;
      if (delta && typeof delta === 'object') {
        if (typeof delta.content === 'string') slot.content += delta.content;
        if (typeof delta.reasoning_content === 'string') slot.reasoning += delta.reasoning_content;
        if (typeof delta.refusal === 'string') slot.refusal += delta.refusal;
        if (Array.isArray(delta.annotations)) slot.annotations.push(...delta.annotations);
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== 'object') continue;
            const ci = typeof tc.index === 'number' ? tc.index : slot.calls.size;
            let call = slot.calls.get(ci);
            if (!call) slot.calls.set(ci, (call = { id: '', name: '', args: '' }));
            if (typeof tc.id === 'string' && tc.id) call.id = tc.id;
            if (typeof tc.function?.name === 'string') call.name += tc.function.name;
            if (typeof tc.function?.arguments === 'string') call.args += tc.function.arguments;
          }
        }
        // Legacy function_call delta (deprecated dialect, still seen).
        if (delta.function_call && typeof delta.function_call === 'object') {
          if (!slot.fnCall) slot.fnCall = { name: '', args: '' };
          if (typeof delta.function_call.name === 'string') slot.fnCall.name += delta.function_call.name;
          if (typeof delta.function_call.arguments === 'string') slot.fnCall.args += delta.function_call.arguments;
        }
      }
      if (ch.finish_reason) slot.finish = ch.finish_reason;
    }
  },
  finish: acc => {
    const choices = [...acc.slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, s]) => {
        const message: Record<string, unknown> = { role: 'assistant' };
        message.content = s.content ? s.content : null;
        if (s.reasoning) message.reasoning_content = s.reasoning;
        if (s.refusal) message.refusal = s.refusal;
        if (s.annotations.length) message.annotations = s.annotations;
        if (s.calls.size) {
          message.tool_calls = [...s.calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, c]) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
        }
        if (s.fnCall) message.function_call = { name: s.fnCall.name, arguments: s.fnCall.args };
        return { index, message, finish_reason: s.finish ?? null };
      });
    const out: Record<string, unknown> = {
      id: acc.head?.id,
      object: 'chat.completion',
      created: acc.head?.created,
      model: acc.head?.model,
      choices,
    };
    if (acc.head && typeof acc.head.service_tier === 'string') out.service_tier = acc.head.service_tier;
    if (acc.head && acc.head.system_fingerprint !== undefined) out.system_fingerprint = acc.head.system_fingerprint;
    if (acc.usage) out.usage = acc.usage;
    return out;
  },
};

/**
 * Anthropic messages dialect: message_start / content_block_start /
 * content_block_delta / message_delta / message_stop events → `message`
 * body. Field set mirrors the message shape the backend synthesizes for
 * Anthropic clients (routes/anthropic.ts toAnthropicMessage): content
 * blocks in index order (text with citations, thinking with signature,
 * tool_use with parsed input), stop_reason / stop_sequence from
 * message_delta, usage = message_start.usage + the last output_tokens.
 */
const anthropicMessagesMerge: StreamMergeAdapter<{
  head: Record<string, any> | null;
  stopReason: unknown;
  stopSeq: unknown;
  outTokens: unknown;
  blocks: Map<
    number,
    { type: string; text: string; thinking: string; signature: string; citations: unknown[]; id: string; name: string; input: string }
  >;
}> = {
  id: 'anthropic-messages',
  recognizes: chunk => {
    const t = typeof chunk.type === 'string' ? chunk.type : '';
    return (
      t === 'message_start' ||
      t === 'content_block_start' ||
      t === 'content_block_delta' ||
      t === 'message_delta' ||
      t === 'message_stop'
    );
  },
  create: () => ({ head: null, stopReason: undefined, stopSeq: undefined, outTokens: undefined, blocks: new Map() }),
  ingest: (acc, d) => {
    const t = d.type as string;
    if (t === 'message_start' && !acc.head) acc.head = d.message ?? d;
    else if (t === 'content_block_start') {
      const i = typeof d.index === 'number' ? d.index : acc.blocks.size;
      const cb = d.content_block ?? {};
      acc.blocks.set(i, {
        type: typeof cb.type === 'string' ? cb.type : 'text',
        text: '',
        thinking: '',
        signature: '',
        citations: [],
        id: typeof cb.id === 'string' ? cb.id : '',
        name: typeof cb.name === 'string' ? cb.name : '',
        input: '',
      });
    } else if (t === 'content_block_delta') {
      const i = typeof d.index === 'number' ? d.index : Math.max(0, acc.blocks.size - 1);
      const blk = acc.blocks.get(i);
      const dl = d.delta ?? {};
      if (blk) {
        if (dl.type === 'text_delta' && typeof dl.text === 'string') blk.text += dl.text;
        else if (dl.type === 'thinking_delta' && typeof dl.thinking === 'string') blk.thinking += dl.thinking;
        else if (dl.type === 'signature_delta' && typeof dl.signature === 'string') blk.signature += dl.signature;
        else if (dl.type === 'citations_delta' && dl.citation && typeof dl.citation === 'object') blk.citations.push(dl.citation);
        else if (dl.type === 'input_json_delta' && typeof dl.partial_json === 'string') blk.input += dl.partial_json;
      }
    } else if (t === 'message_delta') {
      const dl = d.delta ?? {};
      if (dl.stop_reason !== undefined) acc.stopReason = dl.stop_reason;
      if (dl.stop_sequence !== undefined) acc.stopSeq = dl.stop_sequence;
      if (d.usage && typeof d.usage === 'object' && d.usage.output_tokens !== undefined)
        acc.outTokens = d.usage.output_tokens;
    }
  },
  finish: acc => {
    const content = [...acc.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => {
        if (b.type === 'tool_use') {
          let input: unknown = {};
          try {
            input = b.input ? JSON.parse(b.input) : {};
          } catch {
            input = {}; // truncated argument stream — non-stream shape wants an object
          }
          return { type: 'tool_use', id: b.id, name: b.name, input };
        }
        if (b.type === 'thinking')
          return { type: 'thinking', thinking: b.thinking, ...(b.signature ? { signature: b.signature } : {}) };
        return { type: 'text', text: b.text, ...(b.citations.length ? { citations: b.citations } : {}) };
      });
    return {
      id: acc.head?.id,
      type: 'message',
      role: 'assistant',
      model: acc.head?.model,
      content,
      stop_reason: acc.stopReason ?? null,
      stop_sequence: acc.stopSeq ?? null,
      usage: {
        ...(acc.head && typeof acc.head.usage === 'object' ? (acc.head.usage as object) : {}),
        ...(acc.outTokens !== undefined ? { output_tokens: acc.outTokens } : {}),
      },
    };
  },
};

/** Merge-view registry, in preference order (first recognized payload wins). */
const MERGE_ADAPTERS: StreamMergeAdapter<any>[] = [openaiChatMerge, anthropicMessagesMerge];

/**
 * Merge a streamed SSE completion into the equivalent NON-STREAM response
 * body — the shape the API would have returned for a non-streaming call.
 * Dialect detection and accumulation live in MERGE_ADAPTERS (one adapter
 * per wire protocol): the first recognized payload selects the dialect,
 * later payloads of other dialects are ignored. Truncated tail payloads
 * are skipped, never parsed. Returns null when no adapter recognizes the
 * stream (e.g. Responses-API events) or the body is not SSE at all — the
 * toggle caller uses that to hide the merge view.
 */
export function mergeSseToNonStream(raw: string): Record<string, unknown> | null {
  let adapter: StreamMergeAdapter<any> | null = null;
  let acc: any = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const p = t.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    let chunk: Record<string, any>;
    try {
      chunk = JSON.parse(p);
    } catch {
      continue; // truncated tail payload — nothing to merge from it
    }
    if (!chunk || typeof chunk !== 'object') continue;
    if (!adapter) {
      const hit = MERGE_ADAPTERS.find(a => a.recognizes(chunk));
      if (!hit) continue;
      adapter = hit;
      acc = hit.create();
    }
    adapter.ingest(acc, chunk);
  }
  return adapter ? adapter.finish(acc) : null;
}

// ------------------------------------------------------------- media tokens

/**
 * Recorder scrub token: `[MEDIA <mime> <human size> sha256=<16hex>[ file=<rel path>]]`
 * — written when a base64 media payload was replaced in a captured request
 * body. The `file=` segment exists only when the bytes were actually offloaded
 * to disk (storeMedia on + write ok); without it the replay renders an
 * omitted-badge instead of an image.
 */
export interface TranscriptMedia {
  /** Label before the hash, e.g. "image/png 1.2 MB" (rendered verbatim). */
  info: string;
  /** First 16 hex chars of the payload's sha256 — also the read-URL key. */
  sha256: string;
  /** Archive-relative stored path ("media/<sha>.<ext>"); null when omitted. */
  file: string | null;
}

const MEDIA_TOKEN_STRICT = /^\[MEDIA (.+?) sha256=([0-9a-f]{16})(?: file=([^\]]+))?\]$/;
const MEDIA_TOKEN_GLOBAL = /\[MEDIA (.+?) sha256=([0-9a-f]{16})(?: file=([^\]]+))?\]/g;

export function parseMediaToken(text: string): TranscriptMedia | null {
  const m = MEDIA_TOKEN_STRICT.exec(text.trim());
  if (!m) return null;
  return { info: m[1], sha256: m[2], file: m[3] ?? null };
}

/** All tokens embedded in a string (export scanning uses this on raw JSONL). */
export function findMediaTokens(text: string): TranscriptMedia[] {
  const out: TranscriptMedia[] = [];
  MEDIA_TOKEN_GLOBAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_TOKEN_GLOBAL.exec(text))) out.push({ info: m[1], sha256: m[2], file: m[3] ?? null });
  return out;
}

/** Split prose into plain runs and inline media tokens (stringified tool
 *  results carry tokens inside otherwise-normal text). */
export function splitMediaTokens(
  text: string
): Array<{ kind: 'text'; text: string } | { kind: 'media'; media: TranscriptMedia }> {
  const out: Array<{ kind: 'text'; text: string } | { kind: 'media'; media: TranscriptMedia }> = [];
  MEDIA_TOKEN_GLOBAL.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_TOKEN_GLOBAL.exec(text))) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'media', media: { info: m[1], sha256: m[2], file: m[3] ?? null } });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Collapse tokens to a short chip label for list heads (turn excerpt). */
export function collapseMediaTokens(text: string, chip: string): string {
  MEDIA_TOKEN_GLOBAL.lastIndex = 0;
  return text.replace(MEDIA_TOKEN_GLOBAL, chip).replace(/[ \t]{2,}/g, ' ').trim();
}

/** Placeholder carried by an already-scrubbed content part (either dialect). */
const partMediaToken = (part: Record<string, any>): string | null => {
  const cand =
    typeof part.image_url === 'string'
      ? part.image_url
      : typeof part.image_url?.url === 'string'
        ? part.image_url.url
        : typeof part.source?.data === 'string'
          ? part.source.data
          : null;
  return cand && MEDIA_TOKEN_STRICT.test(cand.trim()) ? cand : null;
};

// ---------------------------------------------------------------- display aid

/** Index of the `}` closing the first balanced JSON object in `s` (-1 if none). */
function leadingJsonObjectEnd(s: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Harness clients (opencode et al.) wrap the human prompt in transport
 * metadata. Two observed shapes, both handled:
 *   A) the whole content IS a JSON envelope → use its content/text/prompt field;
 *   B) a leading JSON metadata object, then a newline, then the real text →
 *      drop the envelope, keep the human tail (the screenshot case:
 *      `{"message_id":…,"agent":"coder"}\nProcessing continues...`).
 * Anything else stays verbatim (never swallow unknown content).
 */
export function unwrapHarnessText(text: string): string {
  const s = text.trimStart();
  if (!s.startsWith('{')) return text;
  const end = leadingJsonObjectEnd(s);
  if (end < 0) return text;
  const rest = s.slice(end + 1).trim();
  if (rest) return rest; // shape B — envelope meta + human tail
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (o && typeof o === 'object') {
      for (const k of ['content', 'text', 'prompt', 'message'] as const) {
        if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string;
      }
    }
  } catch {
    // malformed envelope — show the original text verbatim
  }
  return text; // pure metadata blob, no human part to extract
}

/**
 * Harness-injected context riding inside user-role messages: system reminders,
 * project instruction files, runtime-context snapshots. The client concatenates
 * these into the prompt channel — no human typed them, so replay folds them
 * into a collapsed chip instead of a full "user" message. Prefixes are the
 * observed harness shapes; anything unknown stays verbatim (never swallow a
 * real prompt on a guess).
 */
const INJECTION_PREFIXES = [
  '<system-reminder>',
  '<system_reminder>',
  '<user_instructions>',
  '<environment_context>',
  'Instructions from:',
  'Current runtime context',
];

/** Joined, envelope-unwrapped text of a message's text blocks ('' if none). */
export function messageText(m: TranscriptMessage): string {
  return m.blocks
    .filter(b => b.kind === 'text')
    .map(b => unwrapHarnessText(b.text))
    .join('\n\n')
    .trim();
}

/** A pure injection message: user-role, text-only, opening on a known harness marker. */
export function isInjectionMessage(m: TranscriptMessage): boolean {
  if (m.role !== 'user') return false;
  if (m.toolCalls.length > 0) return false;
  if (m.blocks.some(b => b.kind !== 'text')) return false;
  const text = messageText(m);
  return INJECTION_PREFIXES.some(p => text.startsWith(p));
}

// ------------------------------------------------------------- reconstruction

// ------------------------------------------------------------- reconstruction

/**
 * Rebuild the conversation from the page's newest-first `requests` array.
 * Result is chronological (oldest first), one entry per REQUEST. The only
 * grouping key here is `requestId`; turn membership is an attribute read
 * from `turnIndex`, not something this pass computes.
 */
export function buildTranscript(requests: CaptureRequestView[]): TranscriptStep[] {
  const result: TranscriptStep[] = [];
  const seen = new Set<string>();
  const toolNames = new Map<string, string>();
  let prevKeys: string[] = [];
  let prevOutputRendered = false;

  const chrono = requests.map((r, i) => ({ r, i })).reverse();
  for (const { r: request, i: idx } of chrono) {
    const ts =
      request.clientRequest?.ts ?? request.upstreamRequest?.ts ?? request.clientResponse?.ts ?? request.upstreamResponse?.ts;
    let input: TranscriptMessage[] = [];
    let reqTruncated = false;
    let reqUnparsed = false;
    let diverged = false;

    const rawReq = bodyToString(request.clientRequest?.wire.requestBody);
    if (rawReq) {
      reqTruncated = rawReq.endsWith(TRUNCATION_SUFFIX);
      const msgs = normalizeMessages(parseJsonLoose(rawReq));
      if (msgs) {
        const keys = msgs.map(messageKey);
        let k = 0;
        while (k < prevKeys.length && k < keys.length && prevKeys[k] === keys[k]) k++;
        if (k < prevKeys.length) diverged = true; // history rewritten after k
        for (let j = k; j < msgs.length; j++) {
          const msg = msgs[j];
          const key = keys[j];
          if (seen.has(key)) continue;
          seen.add(key);
          if (msg.role === 'assistant' && prevOutputRendered) continue; // shown by its own request
          for (const c of msg.toolCalls) if (c.id && c.name) toolNames.set(c.id, c.name);
          if (msg.toolCallId) msg.toolName = toolNames.get(msg.toolCallId);
          for (const b of msg.blocks) {
            if (b.kind === 'tool_result' && b.toolCallId && !msg.toolName)
              msg.toolName = toolNames.get(b.toolCallId);
          }
          input.push(msg);
        }
        prevKeys = keys;
      } else {
        reqUnparsed = true;
      }
    }

    // Prefer the client leg (what the client actually saw); fall back to the
    // raw upstream body when the client response fell outside the read window.
    const respEvent: CaptureEvent | undefined = request.clientResponse ?? request.upstreamResponse;
    const rawResp = bodyToString(respEvent?.wire.responseBody);
    const output = rawResp ? parseAssistantResponse(rawResp) : null;
    if (output) for (const c of output.toolCalls) if (c.id && c.name) toolNames.set(c.id, c.name);
    prevOutputRendered = !!output;

    result.push({
      idx,
      request,
      ts,
      input,
      output,
      hasResponseBody: !!rawResp,
      reqTruncated,
      reqUnparsed,
      diverged,
    });
  }
  return result;
}

// ----------------------------------------------------------- write-time turns

/**
 * One USER-PROMPT TURN: every request sharing one write-time `turnIndex`.
 * The admission gate already decided this boundary (ADR-0024); this pass
 * only groups by it. Requests with `turnIndex: null` carry no user prompt
 * and belong to no turn, so the conversation lens skips them — their wire
 * is still reachable from the timeline.
 */
export interface TranscriptTurn {
  /** Immutable, session-scoped write-time turn ordinal. */
  turnIndex: number;
  /** User message that opened the turn; null when the window starts mid-turn. */
  prompt: TranscriptMessage | null;
  /** One REQUEST per step, chronological. */
  steps: TranscriptStep[];
  /** Tail answer: text of the last parsed output. */
  finalText: string;
  /** Last non-empty reasoning stream — fallback tail for thinking-only answers. */
  finalReasoning: string;
  /** tool_calls issued by this turn's outputs (hop count, for loss hints). */
  toolCallsIssued: number;
  /** Tool results observed in later steps' inputs. */
  toolResultsSeen: number;
  finalToolCalls: TranscriptToolCall[];
  /** Turn ended with a text answer and no pending tool calls. */
  converged: boolean;
  startTs?: number;
  endTs?: number;
  totalLatencyMs: number;
  hasError: boolean;
}

/**
 * Group replay steps by the archive's WRITE-TIME `turnIndex`. No prompt
 * parsing decides a split: `isPromptStart` names the opener, and the
 * display-only `promptSummary` on that opener labels the header.
 */
export function groupIntoTurns(items: TranscriptStep[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const byIndex = new Map<number, TranscriptTurn>();
  const isPrompt = (m: TranscriptMessage) =>
    m.role === 'user' && m.blocks.some(b => b.kind === 'text' && b.text.trim().length > 0);
  const countResults = (msgs: TranscriptMessage[]) =>
    msgs.reduce(
      (n, m) => n + (m.role === 'tool' ? 1 : m.blocks.filter(b => b.kind === 'tool_result').length),
      0
    );

  for (const st of items) {
    const turnIndex = st.request.turnIndex;
    if (turnIndex === null) continue;
    let turn = byIndex.get(turnIndex);
    if (!turn) {
      // Prefer the write-time display stamp; fall back to the newest prompt
      // in the parsed input delta of this first visible step.
      let prompt: TranscriptMessage | null = null;
      if (st.request.promptSummary) {
        prompt = {
          role: 'user',
          blocks: [{ kind: 'text', text: st.request.promptSummary }],
          toolCalls: [],
        };
      } else {
        for (let i = st.input.length - 1; i >= 0; i--) {
          if (isPrompt(st.input[i])) {
            prompt = st.input[i];
            break;
          }
        }
      }
      turn = {
        turnIndex,
        prompt,
        steps: [],
        finalText: '',
        finalReasoning: '',
        toolCallsIssued: 0,
        toolResultsSeen: 0,
        finalToolCalls: [],
        converged: false,
        totalLatencyMs: 0,
        hasError: false,
      };
      byIndex.set(turnIndex, turn);
      turns.push(turn);
    }
    const skipPrompt = turn.prompt;
    turn.steps.push(st);
    turn.toolCallsIssued += st.output?.toolCalls.length ?? 0;
    // The header prompt is already counted on its own step; tool results
    // arriving in later steps answer this turn's tool calls.
    turn.toolResultsSeen += countResults(st.input.filter(m => m !== skipPrompt));
    if (st.ts !== undefined) {
      if (turn.startTs === undefined) turn.startTs = st.ts;
      turn.endTs = st.ts;
    }
    turn.totalLatencyMs += st.request.gatewayLatencyMs ?? st.request.upstreamLatencyMs ?? 0;
    if (
      st.request.error ||
      st.request.clientResponse?.status === 'error' ||
      st.request.upstreamResponse?.status === 'error'
    )
      turn.hasError = true;
    if (st.output && (st.output.text || st.output.reasoning || st.output.toolCalls.length)) {
      if (st.output.text) turn.finalText = st.output.text;
      if (st.output.reasoning) turn.finalReasoning = st.output.reasoning;
      turn.finalToolCalls = st.output.toolCalls;
      turn.converged = st.output.toolCalls.length === 0 && st.output.text.length > 0;
    }
  }
  return turns;
}
