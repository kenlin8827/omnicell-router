/**
 * Playground wire adapters — the three chat-shaped protocol surfaces the
 * gateway serves, reduced to the two operations the playground needs: build a
 * request body from one conversation, and decode the answer from either the
 * JSON body or one SSE frame. The decision wire (`/v1/systemone`) is NOT here:
 * it is a single-shot question/answer shape with its own panel, not a
 * conversation, so it has nothing in common with this table.
 *
 * ONE table, TWO call sites (the send path and the copy-cURL preview): the
 * sample the operator copies must be the request that is actually sent, so the
 * body builders are never duplicated per caller.
 *
 * The observation plane is deliberately out of scope. Every chat-shaped surface
 * funnels through backend/src/surfaces/ocr-headers.ts, so the X-OCR headers and
 * the trailing `: ocr-summary` frame carry the SAME vocabulary on all three
 * wires; a protocol switch therefore never touches the fact chips. Only the
 * body and the frame vocabulary differ — which is exactly what lives here.
 *
 * Parameters: `temperature` and the token cap are re-spelled per wire
 * (`max_tokens` on chat/anthropic, `max_output_tokens` on responses) but always
 * carry the same meaning. Reasoning effort is the one that MOVES: chat takes
 * the flat `reasoning_effort`, anthropic nests it under `output_config.effort`,
 * responses under `reasoning.effort`. Every surface here has a faithful field,
 * so no wire silently drops it.
 *
 * Wire shapes are owned by backend/src/ir/adapters — this file mirrors the
 * client-facing half of them and must be re-read against
 * `ir/adapters/{anthropic,responses}.ts` when a converter changes.
 */

/** The canonical chat-shaped protocol ids (protocol id = wire id). */
export type ChatProtocolId = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** One image attached to a user turn. Two shapes, because the gateway's
 *  canonical IR has exactly two that a browser can produce: `base64` (bytes the
 *  operator picked/pasted, rendered as a `data:` URL) and `url` (a remote image
 *  the upstream fetches itself). `file` (provider-hosted file ids) is not
 *  reachable from a browser and is deliberately absent. */
export type WireImage =
  | { kind: 'base64'; mediaType: string; data: string; bytes?: number }
  | { kind: 'url'; url: string };

/** The URL form of an attachment — every wire takes a data URL for bytes and a
 *  plain URL for remote images (anthropic spells the remote case as a `url`
 *  source object, but the playground-side value is the same string). */
export const wireImageUrl = (img: WireImage): string =>
  img.kind === 'url' ? img.url : `data:${img.mediaType};base64,${img.data}`;

const DATA_IMAGE_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/i;

/**
 * Parse a pasted image URL field into the WireImage shape Anthropic (and the
 * gateway IR) actually accept. A `data:image/…;base64,…` value is INLINE BYTES
 * — storing it as `{ kind: 'url' }` makes the Anthropic builder emit
 * `source: { type: 'url', url: 'data:…' }`, which upstreams reject.
 */
export function parseWireImageInput(raw: string): WireImage | null {
  const trimmed = raw.trim();
  const data = DATA_IMAGE_RE.exec(trimmed);
  if (data) {
    const mediaType = data[1]!.toLowerCase();
    const payload = data[2]!;
    return {
      kind: 'base64',
      mediaType,
      data: payload,
      bytes: Math.floor((payload.length * 3) / 4),
    };
  }
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'url', url: trimmed };
  return null;
}

/** Decoded byte size of an attachment (0 for a remote URL, which carries none).
 *  Used by the size guard and by the "not saved" stub, never for billing. */
export const imageBytes = (img: WireImage): number =>
  img.kind === 'base64' ? (img.bytes ?? Math.floor((img.data.length * 3) / 4)) : 0;

/** One tool call the model asked for. `arguments` stays the RAW JSON STRING the
 *  wire carried: the three wires stream it as a string fragment sequence, and
 *  re-encoding it as an object here would hide exactly the corruption a
 *  protocol switch can cause (chat `function.arguments`, anthropic
 *  `input_json_delta.partial_json`, responses `function_call_arguments.delta`). */
export interface WireToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** One outcome handed back for a `WireToolCall`, keyed by the call's id. */
export interface WireToolResult {
  id: string;
  name: string;
  content: string;
}

/** A tool definition in canonically-shaped form; each wire re-spells it
 *  (chat `tools[].function.*`, anthropic `tools[].input_schema`, responses
 *  flat `tools[].{name,parameters}`). */
export interface WireToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** `required` is chat/responses `tool_choice: 'required'` and anthropic
 *  `{type: 'any'}`; `none` disables the tools on all three. */
export type WireToolChoice = 'auto' | 'required' | 'none';

/** Accumulates the streamed fragments of one or more tool calls. Stateful by
 *  necessity: no wire sends a tool call whole. */
export interface WireToolStream {
  push(payload: Record<string, unknown>): void;
  /** Calls seen so far, in arrival order, arguments possibly still partial. */
  calls(): WireToolCall[];
}

/** One completed exchange handed to a body builder. `system` is passed apart
 *  because anthropic and responses refuse a `system` message in the history. */
export interface WireMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Attachments on a user turn. A wire that carries them turns `content` into
   *  a part array; without them the string stays a string. */
  images?: WireImage[];
  /** Assistant turn: the calls this turn requested. */
  toolCalls?: WireToolCall[];
  /** User turn: outcomes for the PREVIOUS assistant turn's calls. A wire that
   *  has no dedicated tool role (anthropic, responses) spells these as its own
   *  part/item vocabulary instead of a message role. */
  toolResults?: WireToolResult[];
}

/** Transcript turn shape the history builder needs — a subset of the page's
 *  ChatTurn so the pure helper stays free of React state. */
export interface WireHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  error?: string;
  pending?: boolean;
  images?: WireImage[];
  toolCalls?: WireToolCall[];
  toolResults?: WireToolResult[];
}

/** True when the latest completed assistant turn asked for tools that never
 *  ran. Anthropic / Responses reject a follow-up user message after bare
 *  `tool_use` / `function_call` with no results. */
export function hasUnansweredToolCalls(turns: readonly WireHistoryTurn[]): boolean {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.error || turn.pending) continue;
    if (turn.role !== 'assistant') continue;
    return Boolean(turn.toolCalls?.length && !turn.toolResults?.length);
  }
  return false;
}

/**
 * Build the wire history for the next request. Completed turns only.
 * Unanswered tool calls are DROPPED from the assistant message (text kept):
 * emitting `tool_use` without a following `tool_result` is invalid on
 * Anthropic/Responses. Callers should also block send when
 * `hasUnansweredToolCalls` is true so the operator sees why.
 */
export function wireHistoryFromTurns(
  turns: readonly WireHistoryTurn[],
  extra?: WireMessage,
): WireMessage[] {
  const messages: WireMessage[] = [];
  for (const turn of turns) {
    if (turn.error || turn.pending) continue;
    if (turn.role === 'assistant') {
      const answered = Boolean(turn.toolResults?.length);
      const calls = answered ? turn.toolCalls : undefined;
      if (!turn.content && !calls?.length) continue;
      messages.push({
        role: 'assistant',
        content: turn.content,
        ...(calls?.length ? { toolCalls: calls } : {}),
      });
      if (turn.toolResults?.length) {
        messages.push({ role: 'user', content: '', toolResults: turn.toolResults });
      }
      continue;
    }
    if (!turn.content && !turn.images?.length) continue;
    const sendable = turn.images?.filter((img) => img.kind !== 'base64' || img.data);
    messages.push({
      role: 'user',
      content: turn.content,
      ...(sendable?.length ? { images: sendable } : {}),
    });
  }
  if (extra) messages.push(extra);
  return messages;
}

export interface WireParams {
  model: string;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  /** One of EFFORT_LADDER, or undefined when the operator asked for none. */
  effort?: string;
  /** Tools offered to the model. Empty/absent = no `tools` field at all. */
  tools?: WireToolDef[];
  toolChoice?: WireToolChoice;
  parallelTools?: boolean;
}

/** The three counters the transcript bubble renders, plus the cache carrier the
 *  cache-integrity gate cares about. Normalized across carriers so the page
 *  never branches on the protocol it is displaying. */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Cached prompt tokens: chat `prompt_tokens_details.cached_tokens`,
   *  anthropic `cache_read_input_tokens`, responses
   *  `input_tokens_details.cached_tokens`. */
  cached_tokens?: number;
}

/** What one SSE frame contributes. Fields are partial: a wire may split the
 *  answer across token frames and the usage across two lifecycle frames. */
export interface WireFrame {
  text?: string;
  reasoning?: string;
  usage?: WireUsage;
  /** A protocol-level failure frame (`type: 'error'` / `response.failed`). */
  error?: string;
}

/** The decoded non-streaming answer. */
export interface WireAnswer {
  content: string;
  reasoning?: string;
  usage?: WireUsage;
  toolCalls?: WireToolCall[];
}

export interface WireProtocol {
  readonly id: ChatProtocolId;
  readonly path: string;
  /** This wire's spelling of the output token cap — the param panel labels the
   *  field with it, so the operator reads the name they must send. */
  readonly tokenCapField: string;
  buildBody(messages: WireMessage[], system: string, params: WireParams): Record<string, unknown>;
  decodeJson(body: unknown): WireAnswer;
  /** `null` = this frame carries nothing the transcript renders. */
  decodeFrame(payload: Record<string, unknown>): WireFrame | null;
  /** A fresh tool-call accumulator for one streamed response. */
  createToolStream(): WireToolStream;
}

/** A tool call's arguments as an OBJECT, for the wires that refuse a string
 *  (anthropic `tool_use.input`, responses `function_call.arguments` is a string
 *  but its input items want one too). A malformed fragment becomes `{}` here
 *  rather than throwing mid-request: the model's mistake must be observable in
 *  the transcript, not fatal to the page. */
const argsObject = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A `data:` URL is a few hundred KB of base64 — unreadable in a JSON viewer and
 *  larger than the whole localStorage budget. Every surface that DISPLAYS or
 *  PERSISTS a body replaces it with a size stub instead; the live request keeps
 *  the real bytes, because elision is a presentation concern, never a wire one. */
const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/;

export function elideDataUrls(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = DATA_URL_RE.exec(value);
    if (!match) return value;
    const bytes = Math.floor((match[2]!.length * 3) / 4);
    return `data:${match[1]};base64,… (${formatBytes(bytes)})`;
  }
  if (Array.isArray(value)) return value.map(elideDataUrls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = elideDataUrls(v);
    return out;
  }
  return value;
}

/** Human size for a stub/chip (decimal units — what a file dialog shows). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Drop the bytes but keep the receipt: a stored conversation keeps the fact
 *  that an image was attached (and how large it was) without the payload, so a
 *  reload shows a placeholder instead of silently losing or re-sending it. */
export const elideImagePayloads = (images: WireImage[]): WireImage[] =>
  images.map(img =>
    img.kind === 'base64' ? { kind: 'base64', mediaType: img.mediaType, data: '', bytes: imageBytes(img) } : img
  );

/** Per-field merge: a wire that reports input on one frame and output on the
 *  next (anthropic: prompt on `message_start`, completion on `message_delta`)
 *  ends up with one complete record. `total_tokens` is therefore RECOMPUTED
 *  whenever both halves are known — an earlier frame's derived total (prompt +
 *  0) must not survive as a stale answer once the output arrives. */
export function mergeUsage(current: WireUsage | undefined, next: WireUsage | undefined): WireUsage | undefined {
  if (!next) return current;
  const merged: WireUsage = { ...current };
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens'] as const) {
    if (next[key] !== undefined) merged[key] = next[key];
  }
  if (merged.prompt_tokens !== undefined && merged.completion_tokens !== undefined) {
    merged.total_tokens = merged.prompt_tokens + merged.completion_tokens;
  }
  return merged;
}

// ── chat: POST /v1/chat/completions ─────────────────────────────────────────

/** Attachments turn a string `content` into a part array: chat names the image
 *  part `image_url`, anthropic `image` (with a typed `source`), responses
 *  `input_image`. The text part comes first and is omitted when the turn is
 *  image-only — an empty text part is legal but some upstreams reject it. */
function chatParts(m: WireMessage): Record<string, unknown> {
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ...(m.images ?? []).map(img => ({ type: 'image_url', image_url: { url: wireImageUrl(img) } })),
    ],
  };
}

const chatToolCalls = (calls?: WireToolCall[]): Record<string, unknown>[] =>
  (calls ?? []).map(c => ({
    id: c.id,
    type: 'function',
    function: { name: c.name, arguments: c.arguments || '{}' },
  }));

const chatProtocol: WireProtocol = {
  id: 'openai-chat',
  path: '/v1/chat/completions',
  tokenCapField: 'max_tokens',

  buildBody(messages, system, p) {
    // This is the only wire with a `system` ROLE and a `tool` ROLE, so its
    // history is expanded rather than mapped: an assistant turn becomes one
    // message carrying `tool_calls`, and a results turn becomes one
    // `role: 'tool'` message per call.
    const history: Record<string, unknown>[] = [];
    if (system) history.push({ role: 'system', content: system });
    for (const m of messages) {
      if (m.role === 'assistant') {
        const calls = chatToolCalls(m.toolCalls);
        if (!m.content && calls.length === 0) continue;
        history.push({
          role: 'assistant',
          // `null` beside `tool_calls` is what this wire expects; an empty
          // string is legal but reads as "said nothing", which muddies the
          // transcript when the model both spoke and called a tool.
          content: m.content || (calls.length > 0 ? null : ''),
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
        continue;
      }
      if (m.toolResults?.length) {
        for (const r of m.toolResults) {
          history.push({ role: 'tool', tool_call_id: r.id, content: r.content });
        }
        continue;
      }
      history.push(m.images?.length ? chatParts(m) : { role: 'user', content: m.content });
    }
    return {
      model: p.model,
      messages: history,
      ...(p.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(p.maxTokens !== undefined ? { max_tokens: p.maxTokens } : {}),
      ...(p.effort ? { reasoning_effort: p.effort } : {}),
      ...(p.tools?.length
        ? {
          tools: p.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: p.toolChoice ?? 'auto',
          parallel_tool_calls: p.parallelTools !== false,
        }
        : {}),
    };
  },

  decodeJson(body) {
    const json = rec(body);
    const message = rec(arr(json.choices)[0]).message;
    const msg = rec(message);
    const content = typeof msg.content === 'string' ? msg.content : msg.content ? JSON.stringify(msg.content) : '';
    const calls: WireToolCall[] = arr(msg.tool_calls).map(raw => {
      const call = rec(raw);
      const fn = rec(call.function);
      return {
        id: typeof call.id === 'string' ? call.id : '',
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      };
    });
    const usage = rec(json.usage);
    const parsedUsage: WireUsage = {
      prompt_tokens: num(usage.prompt_tokens),
      completion_tokens: num(usage.completion_tokens),
      total_tokens: num(usage.total_tokens),
      cached_tokens: num(rec(usage.prompt_tokens_details).cached_tokens),
    };
    const hasUsage = parsedUsage.prompt_tokens !== undefined
      || parsedUsage.completion_tokens !== undefined
      || parsedUsage.total_tokens !== undefined
      || parsedUsage.cached_tokens !== undefined;
    return {
      content,
      reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      ...(hasUsage ? { usage: parsedUsage } : {}),
    };
  },

  decodeFrame(payload) {
    if (payload.error) {
      const errObj = rec(payload.error);
      const msg = typeof errObj.message === 'string'
        ? errObj.message
        : typeof payload.error === 'string'
          ? payload.error
          : 'upstream error';
      return { error: msg };
    }
    const delta = rec(rec(arr(payload.choices)[0]).delta);
    const usage = rec(payload.usage);
    const frame: WireFrame = {};
    if (typeof delta.content === 'string' && delta.content) frame.text = delta.content;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      frame.reasoning = delta.reasoning_content;
    }
    if (Object.keys(usage).length > 0) {
      frame.usage = {
        prompt_tokens: num(usage.prompt_tokens),
        completion_tokens: num(usage.completion_tokens),
        total_tokens: num(usage.total_tokens),
        cached_tokens: num(rec(usage.prompt_tokens_details).cached_tokens),
      };
    }
    return frame.text || frame.reasoning || frame.usage ? frame : null;
  },

  createToolStream() {
    // Fragments arrive per `delta.tool_calls[i]`, and `i` is the position in the
    // message, not an id: the first fragment carries id+name, the rest only
    // arguments. Accumulation is therefore positional.
    const byIndex = new Map<number, WireToolCall>();
    return {
      push(payload) {
        for (const raw of arr(rec(rec(arr(payload.choices)[0]).delta).tool_calls)) {
          const delta = rec(raw);
          const index = typeof delta.index === 'number' ? delta.index : 0;
          const current = byIndex.get(index) ?? { id: '', name: '', arguments: '' };
          const fn = rec(delta.function);
          if (typeof delta.id === 'string' && delta.id) current.id = delta.id;
          if (typeof fn.name === 'string' && fn.name) current.name = fn.name;
          if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
          byIndex.set(index, current);
        }
      },
      calls() {
        return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      },
    };
  },
};

// ── anthropic: POST /v1/messages ────────────────────────────────────────────

/** `input_tokens` on the anthropic wire EXCLUDES the cached and cache-write
 *  portions (ir/adapters/anthropic-messages.ts usageToAnthropic subtracts them), so the
 *  prompt total is the sum of the three — otherwise a cached turn would report
 *  a prompt that shrinks as the cache warms. */
function anthropicUsage(raw: unknown): WireUsage | undefined {
  const usage = rec(raw);
  const cached = num(usage.cache_read_input_tokens);
  const written = num(usage.cache_creation_input_tokens);
  const input = num(usage.input_tokens);
  const prompt =
    input === undefined && cached === undefined && written === undefined
      ? undefined
      : (input ?? 0) + (cached ?? 0) + (written ?? 0);
  const output = num(usage.output_tokens);
  if (prompt === undefined && output === undefined && cached === undefined) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt !== undefined && output !== undefined ? prompt + output : undefined,
    cached_tokens: cached,
  };
}

function anthropicImageSource(img: WireImage): Record<string, unknown> {
  // Defense in depth: even if a caller stored a data: URL as kind:'url', emit
  // the base64 source Anthropic requires for inline bytes.
  const normalized = img.kind === 'url' ? (parseWireImageInput(img.url) ?? img) : img;
  if (normalized.kind === 'url') {
    return { type: 'image', source: { type: 'url', url: normalized.url } };
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: normalized.mediaType, data: normalized.data },
  };
}

function anthropicParts(m: WireMessage): Record<string, unknown> {
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      // Two source spellings: bytes the operator attached, or a URL the upstream
      // fetches itself. The gateway's IR mirrors these exactly (`base64`/`url`),
      // and each southbound protocol then declares which it can carry.
      ...(m.images ?? []).map(anthropicImageSource),
    ],
  };
}

const anthropicProtocol: WireProtocol = {
  id: 'anthropic-messages',
  path: '/v1/messages',
  tokenCapField: 'max_tokens',
  buildBody(messages, system, p) {
    const history = messages.map(m => {
      if (m.role === 'assistant') {
        const calls = m.toolCalls ?? [];
        if (!m.content && calls.length === 0) return null;
        // Tool calls are CONTENT BLOCKS on this wire, not a message field: no
        // `tool` role exists, and `input` must be an object (a JSON string is
        // rejected as `tool_arguments`).
        // A turn with no calls keeps the plain STRING form: this wire accepts
        // both, and switching every assistant turn to a block array would
        // rewrite history that the upstream already cached.
        if (calls.length === 0) return { role: 'assistant', content: m.content };
        return {
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: argsObject(c.arguments) })),
          ],
        };
      }
      if (m.toolResults?.length) {
        // Results ride in a USER turn as `tool_result` blocks, keyed by the
        // call's id — there is no separate result channel.
        return {
          role: 'user',
          content: m.toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
        };
      }
      return m.images?.length ? anthropicParts(m) : { role: 'user', content: m.content };
    }).filter(Boolean);

    const disableParallel = p.parallelTools === false;
    const choice =
      p.toolChoice === 'required'
        ? { type: 'any' }
        : p.toolChoice === 'none'
          ? { type: 'none' }
          : p.toolChoice === 'auto'
            ? { type: 'auto' }
            : undefined;
    const applyDisableParallel = disableParallel && choice?.type !== 'none';
    return {
      model: p.model,
      // A system block is a TOP-LEVEL field on this wire, never a message —
      // folding it into `messages` would be rejected as an invalid role.
      ...(system ? { system } : {}),
      messages: history,
      ...(p.stream ? { stream: true } : {}),
      ...(p.maxTokens !== undefined ? { max_tokens: p.maxTokens } : {}),
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(p.effort ? { output_config: { effort: p.effort } } : {}),
      ...(p.tools?.length
        ? {
          tools: p.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          // `disable_parallel_tool_use` lives INSIDE the choice object here,
          // and is meaningless without one (and illegal on `type: 'none'`).
          ...(choice || applyDisableParallel
            ? { tool_choice: { ...(choice ?? { type: 'auto' }), ...(applyDisableParallel ? { disable_parallel_tool_use: true } : {}) } }
            : {}),
        }
        : {}),
    };
  },

  decodeJson(body) {
    const json = rec(body);
    const texts: string[] = [];
    const thoughts: string[] = [];
    const calls: WireToolCall[] = [];
    for (const raw of arr(json.content)) {
      const block = rec(raw);
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      if (block.type === 'thinking' && typeof block.thinking === 'string') thoughts.push(block.thinking);
      if (block.type === 'tool_use') {
        calls.push({
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return {
      content: texts.join(''),
      reasoning: thoughts.length > 0 ? thoughts.join('') : undefined,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      usage: anthropicUsage(json.usage),
    };
  },

  decodeFrame(payload) {
    const type = payload.type;
    if (type === 'message_start') {
      return { usage: anthropicUsage(rec(payload.message).usage) };
    }
    if (type === 'content_block_delta') {
      const delta = rec(payload.delta);
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        return { text: delta.text };
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        return { reasoning: delta.thinking };
      }
      return null;
    }
    if (type === 'message_delta') {
      const usage = anthropicUsage(payload.usage);
      return usage && (usage.completion_tokens !== undefined || usage.prompt_tokens !== undefined) ? { usage } : null;
    }
    if (type === 'error') {
      const message = rec(payload.error).message;
      return { error: typeof message === 'string' ? message : 'upstream error' };
    }
    return null;
  },

  createToolStream() {
    // A tool call is a CONTENT BLOCK: `content_block_start` opens it with the
    // id+name, `input_json_delta` appends `partial_json` fragments, and the
    // block's POSITION (`index`) is the accumulation key.
    const byIndex = new Map<number, WireToolCall>();
    return {
      push(payload) {
        const index = typeof payload.index === 'number' ? payload.index : 0;
        if (payload.type === 'content_block_start') {
          const block = rec(payload.content_block);
          if (block.type === 'tool_use') {
            byIndex.set(index, {
              id: typeof block.id === 'string' ? block.id : '',
              name: typeof block.name === 'string' ? block.name : '',
              arguments: '',
            });
          }
          return;
        }
        if (payload.type === 'content_block_delta') {
          const delta = rec(payload.delta);
          const current = byIndex.get(index);
          if (current && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            current.arguments += delta.partial_json;
          }
        }
      },
      calls() {
        return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      },
    };
  },
};

// ── responses: POST /v1/responses ───────────────────────────────────────────
function responsesParts(m: WireMessage): Record<string, unknown> {
  return {
    type: 'message',
    role: m.role,
    // `input_text` / `input_image` — this wire's part vocabulary, NOT chat's
    // `text` / `image_url`: the same names on the wrong wire are rejected.
    content: [
      ...(m.content ? [{ type: 'input_text', text: m.content }] : []),
      ...(m.images ?? []).map(img => ({ type: 'input_image', image_url: wireImageUrl(img) })),
    ],
  };
}

function responsesUsage(raw: unknown): WireUsage | undefined {
  const usage = rec(raw);
  const prompt = num(usage.input_tokens);
  const completion = num(usage.output_tokens);
  const total = num(usage.total_tokens);
  const cached = num(rec(usage.input_tokens_details).cached_tokens);
  if (prompt === undefined && completion === undefined && total === undefined && cached === undefined) {
    return undefined;
  }
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached,
  };
}

const responsesProtocol: WireProtocol = {
  id: 'openai-responses',
  path: '/v1/responses',
  tokenCapField: 'max_output_tokens',

  buildBody(messages, system, p) {
    // This wire's history is a FLAT ITEM LIST: a tool call and its output are
    // their own items (`function_call` / `function_call_output`), not fields on
    // a message and not content blocks.
    const input: Record<string, unknown>[] = [];
    for (const m of messages) {
      if (m.role === 'assistant') {
        if (m.content) input.push({ type: 'message', role: 'assistant', content: m.content });
        for (const call of m.toolCalls ?? []) {
          input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments || '{}' });
        }
        continue;
      }
      if (m.toolResults?.length) {
        for (const r of m.toolResults) input.push({ type: 'function_call_output', call_id: r.id, output: r.content });
        continue;
      }
      input.push(m.images?.length ? responsesParts(m) : { type: 'message', role: 'user', content: m.content });
    }
    return {
      model: p.model,
      // `instructions` is this wire's system slot; the history carries turns only.
      ...(system ? { instructions: system } : {}),
      input,
      ...(p.stream ? { stream: true } : {}),
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(p.maxTokens !== undefined ? { max_output_tokens: p.maxTokens } : {}),
      ...(p.effort ? { reasoning: { effort: p.effort === 'max' ? 'xhigh' : p.effort } } : {}),
      ...(p.tools?.length
        ? {
          // Flat, not nested under `function`: that is this wire's spelling.
          tools: p.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
          tool_choice: p.toolChoice ?? 'auto',
          parallel_tool_calls: p.parallelTools !== false,
        }
        : {}),
    };
  },

  decodeJson(body) {
    const json = rec(body);
    const texts: string[] = [];
    const thoughts: string[] = [];
    const calls: WireToolCall[] = [];
    for (const raw of arr(json.output)) {
      const item = rec(raw);
      if (item.type === 'function_call') {
        calls.push({
          id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : '',
          name: typeof item.name === 'string' ? item.name : '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        });
      }
      if (item.type === 'message') {
        for (const part of arr(item.content)) {
          const p = rec(part);
          if ((p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') texts.push(p.text);
        }
      }
      if (item.type === 'reasoning') {
        for (const part of [...arr(item.summary), ...arr(item.content)]) {
          const p = rec(part);
          if (typeof p.text === 'string') thoughts.push(p.text);
        }
      }
    }
    return {
      content: texts.join(''),
      reasoning: thoughts.length > 0 ? thoughts.join('') : undefined,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      usage: responsesUsage(json.usage),
    };
  },

  decodeFrame(payload) {
    const type = payload.type;
    if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      return payload.delta ? { text: payload.delta } : null;
    }
    if (
      (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') &&
      typeof payload.delta === 'string'
    ) {
      return payload.delta ? { reasoning: payload.delta } : null;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      return { usage: responsesUsage(rec(payload.response).usage) };
    }
    if (type === 'response.failed') {
      const response = rec(payload.response);
      const message = rec(response.error).message;
      return { error: typeof message === 'string' ? message : (response.status as string) || 'upstream failure' };
    }
    if (type === 'error') {
      const message = rec(payload.error).message;
      return { error: typeof message === 'string' ? message : 'upstream error' };
    }
    return null;
  },

  createToolStream() {
    // The call is announced as an OUTPUT ITEM (`response.output_item.added`)
    // and only the arguments are streamed afterwards, keyed by `item_id`.
    // TWO ids, and they are not interchangeable: `item.id` (`fc_…`) names the
    // stream — every delta frame is keyed by it — while `item.call_id` (`call_…`)
    // is what a `function_call_output` must reference. Keying the map by the
    // call id silently accumulates nothing, because the deltas never mention it.
    const byItem = new Map<string, WireToolCall>();
    const order: string[] = [];
    return {
      push(payload) {
        if (payload.type === 'response.output_item.added') {
          const item = rec(payload.item);
          if (item.type !== 'function_call') return;
          const itemId = typeof item.id === 'string' ? item.id : '';
          if (!byItem.has(itemId)) order.push(itemId);
          byItem.set(itemId, {
            id: typeof item.call_id === 'string' ? item.call_id : itemId,
            name: typeof item.name === 'string' ? item.name : '',
            arguments: typeof item.arguments === 'string' ? item.arguments : '',
          });
          return;
        }
        if (payload.type === 'response.function_call_arguments.delta') {
          const key = typeof payload.item_id === 'string' ? payload.item_id : '';
          const current = byItem.get(key);
          if (current && typeof payload.delta === 'string') current.arguments += payload.delta;
          return;
        }
        if (payload.type === 'response.function_call_arguments.done') {
          const key = typeof payload.item_id === 'string' ? payload.item_id : '';
          const current = byItem.get(key);
          if (current && typeof payload.arguments === 'string' && (payload.arguments || !current.arguments)) {
            current.arguments = payload.arguments;
          }
        }
      },
      calls() {
        return order.map(key => byItem.get(key)!).filter(Boolean);
      },
    };
  },
};

/** The registry — one row per chat-shaped protocol. Order is the page's tab
 *  order (`openai-chat`, `openai-responses`, `anthropic-messages`). */

export const CHAT_PROTOCOLS: readonly WireProtocol[] = [chatProtocol, responsesProtocol, anthropicProtocol];

export const CHAT_PROTOCOL_BY_ID: Record<ChatProtocolId, WireProtocol> = {
  'openai-chat': chatProtocol,
  'openai-responses': responsesProtocol,
  'anthropic-messages': anthropicProtocol,
};

/** Narrow an untrusted value (localStorage from an older build) to a canonical protocol id. */
export function asChatProtocolId(v: unknown): ChatProtocolId {
  if (v === 'anthropic-messages' || v === 'anthropic') return 'anthropic-messages';
  if (v === 'openai-responses' || v === 'responses') return 'openai-responses';
  return 'openai-chat';
}
