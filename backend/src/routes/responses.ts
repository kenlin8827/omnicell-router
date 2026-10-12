import crypto from 'node:crypto';
import {
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
 * `reasoning` input items are intentionally skipped: chat-completions
 * upstreams cannot consume them (note: `reasoning` is the OpenAI Responses API
 * item type name, kept verbatim — not the internal tier name). Unknown item
 * types fail with 400 rather
 * than being silently dropped (fail-visible over silent data loss).
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
  /** Accepted for compatibility; the gateway always keeps state (local, bounded). */
  store?: boolean;
  user?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: Tool[];
  // 5-level effort vocabulary (the OpenAI Responses wire mirrors the
  // OpenAI Chat Completions ladder — `max` is Anthropic-only and never
  // crosses this wire). OpenAI Responses rejects unsupported values
  // per-model (e.g. a never-thinking model rejects `none` with 400).
// OpenAI Responses wire: 5 levels (no `max` — that's Anthropic-only).
// The internal ReasoningEffort type also includes `max` so the orchestrator
// can carry it through the downgrade pipeline; the openai-compatible
// provider builder collapses it before this wire is touched.
reasoning?: { effort?: Exclude<ReasoningEffort, 'max'>; max_tokens?: number };
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

export function inputItemsToMessages(input: string | ResponsesInputItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const items: ResponsesInputItem[] =
    typeof input === 'string' ? [{ role: 'user', content: input }] : input || [];

  for (const item of items) {
    const t = (item as { type?: string })?.type as string | undefined;
    if (t === undefined || t === 'message') {
      const m = item as ResponsesMessageItem;
      messages.push({
        role: (m.role || 'user') as ChatMessage['role'],
        content: contentToChatContent(m.content),
      });
    } else if (t === 'function_call') {
      const fc = item as ResponsesFunctionCallItem;
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: fc.call_id, type: 'function', function: { name: fc.name, arguments: fc.arguments } }],
      });
    } else if (t === 'function_call_output') {
      const fo = item as ResponsesFunctionCallOutputItem;
      messages.push({ role: 'tool', content: String(fo.output ?? ''), tool_call_id: fo.call_id });
    } else if (t === 'reasoning') {
      // Known-ignored: chat-completions upstreams cannot consume reasoning items.
      continue;
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
  model: string
): Record<string, unknown> {
  const msg = chatResp.choices[0]?.message;
  const output: Record<string, unknown>[] = [];

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
  } else {
    const text = typeof msg?.content === 'string' ? msg.content : '';
    output.push({
      type: 'message',
      id: shortId('msg_'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
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
    usage: {
      input_tokens: u?.prompt_tokens || 0,
      output_tokens: u?.completion_tokens || 0,
      total_tokens: u?.total_tokens || (u ? u.prompt_tokens + u.completion_tokens : 0),
    },
  };
}

/** Synthesized Responses SSE event sequence for one buffered completion. */
export function chatToStreamEvents(
  chatResp: ChatCompletionResponse,
  respId: string,
  model: string
): string[] {
  const response = chatToResponseObject(chatResp, respId, model) as Record<string, any>;
  const events: string[] = [];
  const emit = (payload: Record<string, unknown>) =>
    events.push(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);

  emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
  emit({ type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] } });

  const output = response.output as Record<string, any>[];
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    emit({ type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress' } });
    if (item.type === 'message') {
      const fullText: string = item.content?.[0]?.text || '';
      emit({
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: i,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
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

