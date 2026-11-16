import crypto from 'node:crypto';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  Tool,
} from '../types/openai.js';
import type { ReasoningEffort } from '../types/router.js';

/**
 * OpenAI Responses API compatibility — wire protocol converters.
 *
 * Route registration lives in surfaces/responses.ts (refactor step 3b); this
 * module is the shared converter library — the Fastify surface and the MITM
 * forward-proxy interceptor both encode through it, and the wire tests import
 * these functions from this path.
 *
 * Stateful mode (`previous_response_id`) is implemented as GATEWAY-OWNED
 * stateful emulation: the client sends only the delta, the RespStore rebuilds
 * the full message array, and routing runs through the SAME orchestrator as
 * every other wire. Consequences that matter:
 * - state survives model switches / failover / ratchet escalations (an
 *   upstream-owned store would pin the conversation to one provider);
 * - stateful turns bind to their routing session EXACTLY via
 *   router_options.session_id (client-supplied correlation, resolved by the
 *   explicit layer — zero ambiguity);
 * - a previous_response_id that is unknown/expired fails LOUDLY with 400
 *   (never silently opens a new session).
 *
 * `reasoning` items round-trip the assistant's thinking text. Chat upstreams
 * have no reasoning item, so the text rides `reasoning_content` (the
 * OpenAI-compatible `interleaved.field` convention); thinking-mode upstreams
 * (DeepSeek) reject a follow-up turn whose assistant tool calls do not carry
 * it. Outbound: a served assistant message with `reasoning_content` becomes a
 * `reasoning` item whose `summary` parts carry the text. Inbound: a
 * `reasoning` item's text is attached to the assistant message of its turn
 * (before it, the normal order, or the one it follows on the relayed leg).
 * Unknown item types fail with 400 rather than being silently dropped
 * (fail-visible over silent data loss).
 *
 * Streaming (`stream: true`) synthesizes the Responses SSE event sequence
 * from the fully-buffered gateway response — same architecture as the
 * chat-completions and Anthropic wires.
 */

// ---------------------------------------------------------------------------
// Wire types (subset consumed by the gateway)
// ---------------------------------------------------------------------------

interface ResponsesTextPart {
  type: 'input_text' | 'output_text' | 'summary_text' | 'refusal';
  text: string;
}

interface ResponsesImagePart {
  type: 'input_image';
  image_url: string;
  detail?: 'low' | 'high' | 'auto';
}

type ResponsesContentPart = ResponsesTextPart | ResponsesImagePart;

interface ResponsesMessageItem {
  type?: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesContentPart[];
}

interface ResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

interface ResponsesReasoningItem {
  type: 'reasoning';
  [k: string]: unknown;
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export interface ResponsesRequest {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  previous_response_id?: string;
  stream?: boolean;
  /**
   * OpenAI retention flag, HONORED (default true): `store:false` means this
   * response is not retained by the gateway's chain store, so a later
   * `previous_response_id` naming it resolves to nothing (the documented
   * resend-full-input 400) — the same rule that makes chaining impossible
   * without server-side state upstream. Request capture is a separate,
   * operator-controlled plane and is NOT affected by this flag.
   */
  store?: boolean;
  user?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: Tool[];
  /** Responses wire: 'auto'/'none'/'required' | {type:'function', name}; normalized to the chat shape in parse. */
  tool_choice?: unknown;
  // 5-level effort vocabulary (the OpenAI Responses wire mirrors the
  // OpenAI Chat Completions ladder — `max` is Anthropic-only and never
  // crosses this wire). OpenAI Responses rejects unsupported values
  // per-model (e.g. a never-thinking model rejects `none` with 400).
  // OpenAI Responses wire: 5 levels (no `max` — that's Anthropic-only).
  // The internal ReasoningEffort type also includes `max` so the orchestrator
  // can carry it through the downgrade pipeline; the openai-compatible
  // provider builder collapses it before this wire is touched.
  reasoning?: { effort?: Exclude<ReasoningEffort, 'max'>; max_tokens?: number };
  /**
   * Conversations API handle. NOT implemented: rejected fail-visible, because
   * silently ignoring it leaves a client convinced the session continued while
   * every turn starts from empty history.
   */
  conversation?: unknown;
  /** Async execution + polling endpoints. NOT implemented: `true` is rejected. */
  background?: boolean;
  /** `auto` (server-side context trimming). NOT implemented: `auto` is rejected. */
  truncation?: 'auto' | 'disabled';
  /** Structured outputs. `format.type !== 'text'` is rejected (no mapping on this gateway). */
  text?: { format?: { type?: string } };
}

/**
 * The wire parameters this gateway does NOT implement but which change what
 * the client believes it got. Ignoring them is the one behavior a standard
 * client cannot detect, so each is rejected with `unsupported_parameter`
 * instead (fail-visible over silent divergence).
 */
export function unsupportedResponsesParameter(req: ResponsesRequest): string | null {
  if (req.conversation !== undefined && req.conversation !== null) {
    return 'Unsupported parameter: "conversation" — the Conversations API is not implemented by this gateway; send the full conversation "input" on every turn and omit "conversation".';
  }
  if (req.background === true) {
    return 'Unsupported parameter: "background" — this gateway has no asynchronous execution or polling endpoint; omit "background".';
  }
  if (req.truncation === 'auto') {
    return 'Unsupported parameter: "truncation" — automatic context trimming is not implemented; shorten the input or send "truncation": "disabled".';
  }
  const format = req.text?.format;
  if (format && typeof format === 'object' && format.type !== undefined && format.type !== 'text') {
    return `Unsupported parameter: "text.format" (type "${String(format.type)}") — structured outputs are not implemented on this gateway.`;
  }
  return null;
}

/**
 * Responses-wire tools are FLAT (`{type:'function', name, description, parameters}`);
 * chat-completions tools are NESTED (`{type:'function', function:{...}}`). The
 * internal pipeline canonicalizes on the chat-completions (nested) shape, so
 * the Responses surface flattens incoming client tools here and the
 * Responses-upstream provider re-flattens on payload build.
 */
export function responsesToolsToChat(tools: unknown[]): Tool[] {
  return tools.map((raw) => {
    const t = raw as Record<string, any>;
    if (t && typeof t === 'object' && t.function?.name) return t as Tool; // already nested
    if (t && typeof t === 'object' && typeof t.name === 'string') {
      return {
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      };
    }
    return t as Tool; // unknown shape — pass through, fail at the upstream
  });
}

/** Chat-completions (nested) tools → Responses-wire (flat) tools. */
export function chatToolsToResponses(tools: Tool[]): Record<string, unknown>[] {
  return tools.map((t) =>
    t.function
      ? {
          type: 'function',
          name: t.function.name,
          ...(t.function.description !== undefined ? { description: t.function.description } : {}),
          parameters: t.function.parameters,
        }
      : (t as unknown as Record<string, unknown>),
  );
}

/**
 * Responses-wire tool_choice → chat-completions tool_choice. The scalar
 * ladder ('auto'/'none'/'required') is identical; the object form differs:
 * Responses uses `{type:'function', name}`, chat nests the name under
 * `function`. Anything else passes through and fails at the upstream.
 */
export function responsesToolChoiceToChat(raw: unknown): ChatCompletionRequest['tool_choice'] {
  if (typeof raw === 'string') return raw as ChatCompletionRequest['tool_choice'];
  if (raw && typeof raw === 'object' && typeof (raw as any).name === 'string') {
    return { type: 'function', function: { name: (raw as any).name } };
  }
  return raw as ChatCompletionRequest['tool_choice'];
}

// ---------------------------------------------------------------------------
// Converter: Responses input items -> chat messages (delta only, no system)
// ---------------------------------------------------------------------------

function contentToChatContent(content: string | ResponsesContentPart[]): ChatMessage['content'] {
  if (typeof content === 'string') return content;
  return content.map((p) => {
    if (p.type === 'input_image') {
      return { type: 'image_url' as const, image_url: { url: p.image_url, detail: p.detail } };
    }
    // input_text / output_text / summary_text / refusal all carry text.
    return { type: 'text' as const, text: (p as ResponsesTextPart).text };
  });
}

/** Thinking text carried by one Responses `reasoning` item (summary parts and/or content). */
function reasoningTextOf(item: ResponsesReasoningItem): string | undefined {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value) parts.push(value);
      return;
    }
    if (!Array.isArray(value)) return;
    for (const part of value) {
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' && part.text) {
        parts.push(part.text);
      }
    }
  };
  collect(item.summary);
  collect(item.content);
  return parts.length ? parts.join('\n') : undefined;
}

export function inputItemsToMessages(input: string | ResponsesInputItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const items: ResponsesInputItem[] =
    typeof input === 'string' ? [{ role: 'user', content: input }] : input || [];
  // Thinking text waiting for the assistant turn it belongs to. In the normal
  // Responses order a `reasoning` item precedes the message/function_call
  // items of its turn; on a relayed stream the closing half emits it AFTER
  // them, so a pending value is attached backward once a non-assistant item
  // proves no assistant turn follows.
  let pendingReasoning: string | undefined;

  const takeReasoning = (): string | undefined => {
    const text = pendingReasoning;
    pendingReasoning = undefined;
    return text;
  };
  const attachReasoning = (msg: ChatMessage): void => {
    const text = takeReasoning();
    if (text !== undefined && !msg.reasoning_content) msg.reasoning_content = text;
  };
  const attachReasoningBackward = (): void => {
    if (pendingReasoning === undefined) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i]!;
      if (candidate.role !== 'assistant') continue;
      if (!candidate.reasoning_content) candidate.reasoning_content = takeReasoning();
      pendingReasoning = undefined;
      return;
    }
    pendingReasoning = undefined;
  };

  for (const item of items) {
    const t = item.type;
    if (t === undefined || t === 'message') {
      const m = item;
      const message: ChatMessage = {
        role: (m.role || 'user') as ChatMessage['role'],
        content: contentToChatContent(m.content),
      };
      if (message.role === 'assistant') attachReasoning(message);
      else attachReasoningBackward();
      messages.push(message);
    } else if (t === 'function_call') {
      const fc = item;
      const call = {
        id: fc.call_id,
        type: 'function' as const,
        function: { name: fc.name, arguments: fc.arguments },
      };
      // A Responses turn emits ONE function_call item per call, while a
      // chat-completions assistant turn carries ALL of its calls on a single
      // message. Emitting one assistant message per call produces consecutive
      // assistant messages, which strict upstreams (DeepSeek, OpenAI) reject:
      // "An assistant message with 'tool_calls' must be followed by tool
      // messages responding to each 'tool_call_id'". Fold each call into the
      // directly preceding assistant message (the text item of the same turn
      // or the call emitted just before it).
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant') {
        (prev.tool_calls ??= []).push(call);
        attachReasoning(prev);
      } else {
        const message: ChatMessage = { role: 'assistant', content: '', tool_calls: [call] };
        attachReasoning(message);
        messages.push(message);
      }
    } else if (t === 'function_call_output') {
      attachReasoningBackward();
      messages.push({ role: 'tool', content: String(item.output ?? ''), tool_call_id: item.call_id });
    } else if (t === 'reasoning') {
      const text = reasoningTextOf(item);
      if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${text}` : text;
    } else {
      throw new Error(`Unsupported input item type: "${t}"`);
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Converter: chat response -> Responses response object
// ---------------------------------------------------------------------------

function shortId(prefix: string): string {
  return prefix + crypto.randomBytes(12).toString('hex');
}

export function chatToResponseObject(
  chatResp: ChatCompletionResponse,
  respId: string,
  model: string,
  /** Pre-minted on the relayed leg so `response.created` and `response.completed` share one item id. */
  messageId: string = shortId('msg_'),
  /**
   * The client's EFFECTIVE `store` flag (default true, OpenAI parity). The
   * gateway honors it: `store:false` means the response is not retained, so it
   * can never be a `previous_response_id` parent — and the response object
   * says so instead of pretending a chain exists.
   */
  store: boolean = true
): Record<string, unknown> {
  const msg = chatResp.choices[0]?.message;
  const output: Record<string, unknown>[] = [];

  // Thinking text is a FIRST-CLASS output item on this wire: the client stores
  // it and replays it as an input item on the next turn, which is the only way
  // a stateless Responses client can satisfy thinking-mode upstreams (DeepSeek
  // rejects a follow-up whose assistant turn lost its reasoning). The raw text
  // rides `summary` parts — the schema-stable carrier every Responses parser
  // keeps; `content` is accepted on the way back too (see reasoningTextOf).
  const reasoning = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '';
  if (reasoning) {
    output.push({
      type: 'reasoning',
      id: shortId('rs_'),
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }

  // Assistant prose and tool_calls coexist in Responses output (message item +
  // function_call items); dropping the text when the model also called tools
  // would silently lose its explanation/reasoning preamble.
  const text = typeof msg?.content === 'string' ? msg.content : '';
  if (text) {
    output.push({
      type: 'message',
      id: messageId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: shortId('fc_'),
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: 'completed',
      });
    }
  }
  if (output.length === 0) {
    output.push({
      type: 'message',
      id: messageId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  const u = chatResp.usage;
  return {
    id: respId,
    object: 'response',
    created_at: Math.floor(chatResp.created || Date.now() / 1000),
    status: 'completed',
    model,
    output,
    // REQUIRED by strict Responses clients. JetBrains Junie declares `tools`
    // with no default in its `Response` serializer, so an absent field aborts
    // parsing of `response.created`/`response.completed` entirely — the client
    // never sees a terminal event and reports a truncated stream. An empty
    // array is the correct "no tools echoed on this response" value.
    tools: [],
    store,
    usage: {
      input_tokens: u?.prompt_tokens || 0,
      // Standard breakdowns, emitted only when the upstream reported them:
      // cached prompt tokens (KV/prefix hits) and reasoning tokens. Clients
      // that meter cost read these; inventing zeros would be a lie, so an
      // unreported detail is simply absent.
      ...(typeof u?.prompt_tokens_details?.cached_tokens === 'number'
        ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } }
        : {}),
      output_tokens: u?.completion_tokens || 0,
      ...(typeof u?.completion_tokens_details?.reasoning_tokens === 'number'
        ? { output_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens } }
        : {}),
      total_tokens: u?.total_tokens || (u ? u.prompt_tokens + u.completion_tokens : 0),
    },
  };
}

/**
 * Per-response SSE sequence counter. OpenAI Responses streaming events carry a
 * monotonically increasing `sequence_number`. Strict consumers declare it
 * REQUIRED on EVERY event — including their catch-all `Unknown` variant.
 * JetBrains Junie (4020.10) drops unnumbered events silently, so a missing
 * number on `response.completed` makes it throw `LlmStreamTruncatedException`
 * ("streaming response ended before a terminal response.* event") and surface
 * "A network error interrupted the request to the model provider".
 *
 * One counter is shared by the relayed leg's opening prefix, every live
 * `response.output_text.delta`, and the closing half. The buffered leg owns a
 * fresh counter and numbers its synthesized sequence the same way.
 */
export interface ResponsesStreamSequence {
  value: number;
}

export function newResponseStreamSequence(): ResponsesStreamSequence {
  return { value: 0 };
}

function sequenced(
  seq: ResponsesStreamSequence,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { sequence_number: seq.value++, ...payload };
}

/** One `event:/data:` frame — the exact shape every Responses SSE consumer reads. */
export function responsesEventFrame(payload: Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Id for the assistant message item; minted at parse time on the relayed leg. */
export function newResponseMessageId(): string {
  return shortId('msg_');
}

/**
 * Frames emitted ONCE before the first upstream chunk of a relayed turn.
 * `output_item.added` / `content_part.added` pin the item_id that every later
 * `response.output_text.delta` must carry, so they cannot wait for the result.
 */
export function responsesStreamPrefix(
  respId: string,
  model: string,
  messageId: string,
  seq: ResponsesStreamSequence = newResponseStreamSequence(),
  store: boolean = true
): string[] {
  const response = {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model,
    output: [],
    // Same required field as the completed response — `response.created` is
    // parsed into the very same Response schema by strict clients.
    tools: [],
    // Echoed on the opening object exactly like the terminal one: a client
    // that asked for `store:false` must not be told a chain now exists.
    store,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  return [
    { type: 'response.created', response },
    { type: 'response.in_progress', response },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
  ].map((payload) => responsesEventFrame(sequenced(seq, payload)));
}

/** ONE upstream chat delta -> ONE Responses text delta frame. */
export function responsesDeltaFrame(
  messageId: string,
  delta: string,
  seq: ResponsesStreamSequence,
): string {
  return responsesEventFrame(sequenced(seq, {
    type: 'response.output_text.delta',
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    delta,
  }));
}

/**
 * Full event payload sequence for one completed response.
 *
 * `relayed` distinguishes the two terminal legs:
 * - buffered (`false`): synthesize the whole sequence from the final result
 *   after generation — created/in_progress, every added/delta/done pair.
 * - relayed (`true`): the opening `created`/`in_progress` pair, item-0's
 *   `output_item.added`/`content_part.added`, and all live text deltas were
 *   ALREADY written during generation. Emit only the closing half.
 *
 * Tool-call arguments are NEVER relayed live (chat-completions upstreams carry
 * tool_calls on the final result), so `output_item.added` +
 * `function_call_arguments.delta` MUST be emitted here on the relayed leg too:
 * strict clients reconstruct tool calls from exactly those two event types,
 * not from the terminal `response.completed` object alone.
 */
function responseEventPayloads(
  chatResp: ChatCompletionResponse,
  respId: string,
  model: string,
  messageId: string,
  relayed = false,
  store = true
): Record<string, unknown>[] {
  const response = chatToResponseObject(chatResp, respId, model, messageId, store) as Record<string, any>;
  const output = response.output as Record<string, any>[];

  // Reasoning items are placed at the END on the relayed leg: the prefix has
  // already announced the message item at output_index 0, so a reasoning item
  // cannot take that slot without desynchronizing every index the client has
  // seen. The buffered leg keeps the standard reasoning-first order.
  if (relayed) {
    const reasoningItems = output.filter((item) => item.type === 'reasoning');
    if (reasoningItems.length > 0) {
      const rest = output.filter((item) => item.type !== 'reasoning');
      output.length = 0;
      output.push(...rest);
      // The prefix unconditionally announced item 0 as the parse-minted
      // message item. A tool-call-only answer has no prose item in `output`,
      // so insert the (empty) message item at index 0 to keep every
      // output_index in the closing half aligned with what the client saw.
      if (output[0]?.id !== messageId) {
        output.unshift({
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: '', annotations: [] }],
        });
      }
      output.push(...reasoningItems);
    }
  }

  if (relayed && output[0]?.id !== messageId) {
    output.unshift({
      type: 'message',
      id: messageId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  const events: Record<string, unknown>[] = [];
  const emit = (payload: Record<string, unknown>) => { events.push(payload); };

  if (!relayed) {
    emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    emit({ type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] } });
  }

  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    const prefixAlreadySent = relayed && i === 0 && item.id === messageId;

    if (!prefixAlreadySent) {
      emit({
        type: 'response.output_item.added',
        output_index: i,
        item: item.type === 'function_call'
          ? { ...item, status: 'in_progress', arguments: '' }
          : { ...item, status: 'in_progress' },
      });
    }
    if (item.type === 'message') {
      const fullText: string = item.content?.[0]?.text || '';
      if (!prefixAlreadySent) {
        emit({
          type: 'response.content_part.added',
          item_id: item.id,
          output_index: i,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      // On the relayed leg the live upstream chunks already carried these
      // deltas; replaying them here would duplicate every token.
      if (!relayed) {
        const chunkSize = 16;
        for (let j = 0; j < fullText.length; j += chunkSize) {
          emit({
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: i,
            content_index: 0,
            delta: fullText.slice(j, j + chunkSize),
          });
        }
      }
      emit({ type: 'response.output_text.done', item_id: item.id, output_index: i, content_index: 0, text: fullText });
      emit({ type: 'response.content_part.done', item_id: item.id, output_index: i, content_index: 0, part: item.content[0] });
    } else if (item.type === 'function_call') {
      const args: string = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      const chunkSize = 32;
      for (let j = 0; j < args.length; j += chunkSize) {
        emit({
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: i,
          delta: args.slice(j, j + chunkSize),
        });
      }
      emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: i, arguments: args });
    }
    emit({ type: 'response.output_item.done', output_index: i, item });
  }

  emit({ type: 'response.completed', response });
  return events;
}

/** Synthesized Responses SSE event sequence for one buffered completion. */
export function chatToStreamEvents(
  chatResp: ChatCompletionResponse,
  respId: string,
  model: string,
  messageId: string = shortId('msg_'),
  seq: ResponsesStreamSequence = newResponseStreamSequence(),
  store = true
): string[] {
  return responseEventPayloads(chatResp, respId, model, messageId, false, store)
    .map((payload) => responsesEventFrame(sequenced(seq, payload)));
}

/**
 * Closing half of a relayed turn. Shares the SAME sequence counter as the
 * prefix and the live deltas so `sequence_number` stays strictly increasing
 * across the entire connection.
 */
export function responsesStreamSuffix(
  chatResp: ChatCompletionResponse,
  respId: string,
  model: string,
  messageId: string,
  seq: ResponsesStreamSequence,
  store = true
): string[] {
  return responseEventPayloads(chatResp, respId, model, messageId, true, store)
    .map((payload) => responsesEventFrame(sequenced(seq, payload)));
}

