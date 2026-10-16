/**
 * Session transcript reconstruction for the capture archive.
 *
 * Every captured turn stores the FULL pre-compression request snapshot
 * (`clientRequest.wire.requestBody`, accumulated messages) plus the response
 * wire (JSON or SSE stream). Walking turns oldest-first, the conversation is
 * rebuilt as: [messages new since the previous snapshot] + [this turn's
 * parsed assistant output]. No backend projection needed.
 *
 * Degraded cases handled here:
 *  - request bodies cut by `maxBodyBytes` (`...[TRUNCATED]`) — a bracket-repair
 *    pass salvages the largest parseable prefix (mirrors backend
 *    CaptureRecorder.repairTruncatedJson);
 *  - snapshot history rewrites (client-side compaction) — replay resumes from
 *    the divergence point, flagged per turn;
 *  - both OpenAI chat-completions and Anthropic messages dialects, streaming
 *    and non-streaming.
 */
import type { CaptureTurn, HttpExchangeEvent, WireBody } from './api';

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

export interface TurnOutput {
  text: string;
  reasoning: string;
  toolCalls: TranscriptToolCall[];
}

export interface TranscriptTurn {
  /** Index into the page's newest-first `turns` array (drawer contract). */
  idx: number;
  turn: CaptureTurn;
  ts?: number;
  /** Messages that entered the conversation with this turn. */
  input: TranscriptMessage[];
  /** Assistant output produced by this turn (parsed from the response wire). */
  output: TurnOutput | null;
  hasResponseBody: boolean;
  /** Request body carried the truncation marker (newest tail may be lost). */
  reqTruncated: boolean;
  /** Request body exists but yielded no parseable message array. */
  reqUnparsed: boolean;
  /** Snapshot prefix changed — history was rewritten mid-loop (compaction). */
  diverged: boolean;
}

// ---------------------------------------------------------------- primitives

const bodyToString = (body: string | WireBody | undefined): string | null =>
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

function parseJsonResponse(obj: unknown): TurnOutput | null {
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

function parseSseResponse(s: string): TurnOutput | null {
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
export function parseAssistantResponse(raw: string): TurnOutput | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    const obj = parseJsonLoose(s);
    return obj ? parseJsonResponse(obj) : null;
  }
  if (/\bdata:/.test(s) || /\bevent:/.test(s)) return parseSseResponse(s);
  return null;
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

/** Collapse tokens to a short chip label for list heads (round excerpt). */
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
 *      `{"message_id":…,"agent":"coder"}\n继续处理中…`).
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

// ------------------------------------------------------------- reconstruction

/**
 * Rebuild the conversation from the page's newest-first `turns`. Result is
 * chronological (oldest first), one entry per turn.
 */
export function buildTranscript(turns: CaptureTurn[]): TranscriptTurn[] {
  const result: TranscriptTurn[] = [];
  const seen = new Set<string>();
  const toolNames = new Map<string, string>();
  let prevKeys: string[] = [];
  let prevOutputRendered = false;

  const chrono = turns.map((t, i) => ({ t, i })).reverse();
  for (const { t: turn, i: idx } of chrono) {
    const ts =
      turn.clientRequest?.ts ?? turn.upstreamRequest?.ts ?? turn.gatewayResponse?.ts ?? turn.upstreamResponse?.ts;
    let input: TranscriptMessage[] = [];
    let reqTruncated = false;
    let reqUnparsed = false;
    let diverged = false;

    const rawReq = bodyToString(turn.clientRequest?.wire.requestBody);
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
          if (msg.role === 'assistant' && prevOutputRendered) continue; // already shown from its own turn
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

    // Prefer the gateway leg (what the client actually saw); fall back to the
    // raw upstream body when the gateway response fell outside the read window.
    const respEvent: HttpExchangeEvent | undefined = turn.gatewayResponse ?? turn.upstreamResponse;
    const rawResp = bodyToString(respEvent?.wire.responseBody);
    const output = rawResp ? parseAssistantResponse(rawResp) : null;
    if (output) for (const c of output.toolCalls) if (c.id && c.name) toolNames.set(c.id, c.name);
    prevOutputRendered = !!output;

    result.push({
      idx,
      turn,
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

// ---------------------------------------------------------------- by-prompt rounds

/**
 * One user prompt and everything it drove: a round opens with a `user` message
 * in a turn's input delta and covers the consecutive tool-call hops until the
 * answer converges (or the next prompt interrupts / the archive window ends).
 * This is the harness-style grouping: header = prompt, tail = final answer,
 * middle = the HTTP turns (each still linked to its raw wire).
 */
export interface TranscriptRound {
  /** User message that opened this round; null when the window starts mid-round. */
  prompt: TranscriptMessage | null;
  steps: TranscriptTurn[];
  /** Tail answer: text of the last parsed output. */
  finalText: string;
  /** Last non-empty reasoning stream — fallback tail when the answer came as thinking only. */
  finalReasoning: string;
  /** tool_calls issued by this round's outputs (hop count, for result-loss hints). */
  toolCallsIssued: number;
  /** tool results actually observed in later turns' inputs. */
  toolResultsSeen: number;
  finalToolCalls: TranscriptToolCall[];
  /** Round ended with a text answer and no pending tool calls. */
  converged: boolean;
  startTs?: number;
  endTs?: number;
  totalLatencyMs: number;
  hasError: boolean;
}

export function groupIntoRounds(items: TranscriptTurn[]): TranscriptRound[] {
  const rounds: TranscriptRound[] = [];
  let cur: TranscriptRound | null = null;
  const countResults = (msgs: TranscriptMessage[]) =>
    msgs.reduce(
      (n, m) => n + (m.role === 'tool' ? 1 : m.blocks.filter(b => b.kind === 'tool_result').length),
      0
    );
  for (const st of items) {
    const pi = st.input.findIndex(m => m.role === 'user');
    const promptMsg = pi >= 0 ? st.input[pi] : null;
    // A round opens on a visible user prompt. Bonus signal: once a step's
    // output CONVERGED (pure-text answer), the next client request can only
    // be a fresh prompt — this survives request bodies whose tail (where new
    // user messages live) was cut by maxBodyBytes truncation.
    if (!cur || promptMsg || cur.converged) {
      // Tool results that arrived BEFORE this prompt answer the PREVIOUS
      // round's tool calls — credit them there, or the loss-hint misfires.
      if (cur && pi > 0) cur.toolResultsSeen += countResults(st.input.slice(0, pi));
      cur = {
        prompt: promptMsg,
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
      rounds.push(cur);
    }
    cur.steps.push(st);
    cur.toolCallsIssued += st.output?.toolCalls.length ?? 0;
    cur.toolResultsSeen += countResults(st.input.slice(Math.max(pi, 0)));
    if (st.ts !== undefined) {
      if (cur.startTs === undefined) cur.startTs = st.ts;
      cur.endTs = st.ts;
    }
    cur.totalLatencyMs += st.turn.gatewayLatencyMs ?? st.turn.upstreamLatencyMs ?? 0;
    if (
      st.turn.error ||
      st.turn.gatewayResponse?.status === 'error' ||
      st.turn.upstreamResponse?.status === 'error'
    )
      cur.hasError = true;
    if (st.output && (st.output.text || st.output.reasoning || st.output.toolCalls.length)) {
      // Keep the LAST non-empty text as the tail answer; `converged` marks
      // whether the final hop itself closed with text (no pending tool call).
      if (st.output.text) cur.finalText = st.output.text;
      if (st.output.reasoning) cur.finalReasoning = st.output.reasoning;
      cur.finalToolCalls = st.output.toolCalls;
      cur.converged = st.output.toolCalls.length === 0 && st.output.text.length > 0;
    }
  }
  return rounds;
}
