import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContentPart,
} from '../types/openai.js';
import { EFFORT_LADDER, type ReasoningEffort } from '../types/router.js';

/**
 * Anthropic Messages API compatibility — wire protocol converters.
 *
 * Route registration lives in surfaces/anthropic.ts (refactor step 3a);
 * this module is the shared converter library: the Fastify surface and the
 * MITM forward-proxy interceptor both encode through it, and the wire tests
 * import these functions from this path.
 *
 * Lets Anthropic-protocol clients (Claude Code, Anthropic SDKs, any
 * ANTHROPIC_BASE_URL-aware tool) hit the same routing pipeline as
 * OpenAI-protocol clients. Auth is enforced by the shared preHandler
 * hook in server.ts, which already accepts `x-api-key` in addition to
 * `Authorization: Bearer`.
 *
 * Wire types (subset consumed by the gateway):
 */

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, any>;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicTextBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicToolDef[];
  metadata?: { user_id?: string };
  // Extended thinking — Anthropic-native shape. The provider-build layer maps
  //   enabled   → reasoning.max_thinking_tokens (Anthropic thinking block)
  //   adaptive  → no router-side override; upstream picks the model default
  //   disabled  → reasoning.effort='none' (no thinking block constructed)
  // Opus 5.5+ reject `disabled` with 400; the gateway doesn't second-guess
  // the client — it forwards faithfully and lets the upstream answer.
  thinking?: { type?: 'enabled' | 'adaptive' | 'disabled'; budget_tokens?: number };
  // output_config.effort — Anthropic's newer high-level effort knob
  // (Opus 5.5 / Sonnet 5.5+). Vocabulary: `low` / `medium` / `high` / `max`.
  // When present alongside `thinking`, output_config.effort takes precedence.
  // Typed loosely so an upstream vocabulary change doesn't need a code
  // change here; an unknown value simply doesn't match anything in the
  // internal effort ladder and is treated as "no preference" (equivalent
  // to the field being omitted).
  output_config?: { effort?: string };
}

/** Anthropic requires max_tokens; mirror the SDK default when omitted. */
const DEFAULT_MAX_TOKENS = 4096;

export function anthropicToOpenAI(body: AnthropicMessagesRequest): {
  request?: ChatCompletionRequest;
  error?: string;
} {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: 'Invalid request: "messages" array is required.' };
  }

  const messages: ChatMessage[] = [];

  // Top-level system prompt (string or text blocks) -> leading system message
  if (body.system !== undefined && body.system !== null) {
    const systemText =
      typeof body.system === 'string'
        ? body.system
        : body.system
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  const convertBlocks = (blocks: AnthropicContentBlock[]): ChatMessageContentPart[] =>
    blocks.flatMap((block): ChatMessageContentPart[] => {
      if (block.type === 'text') {
        return [{ type: 'text', text: block.text }];
      }
      if (block.type === 'image' && block.source?.type === 'base64') {
        return [
          {
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          },
        ];
      }
      return [];
    });

  const textOfResult = (content: AnthropicToolResultBlock['content']): string => {
    if (typeof content === 'string') return content;
    return (content || []).map((b) => b.text).join('\n');
  };

  for (const msg of body.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      // Assistant turns may mix text and tool_use blocks (parallel calls too).
      const text = msg.content
        .filter((b): b is AnthropicTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = msg.content
        .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      messages.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // User turns may mix tool_result blocks with plain text/images.
    let pending: ChatMessageContentPart[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        if (pending.length) {
          messages.push({ role: 'user', content: pending });
          pending = [];
        }
        messages.push({ role: 'tool', content: textOfResult(block.content), tool_call_id: block.tool_use_id });
        continue;
      }
      pending.push(...convertBlocks([block]));
    }
    if (pending.length) messages.push({ role: 'user', content: pending });
  }

  return {
    request: {
      model: body.model?.trim() || 'auto',
      messages,
      max_tokens: body.max_tokens ?? DEFAULT_MAX_TOKENS,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: body.stream,
      stop: body.stop_sequences,
      user: body.metadata?.user_id,
      // Anthropic-native thinking → gateway's reasoning fields. The provider
      // payload builders turn `max_thinking_tokens` into the upstream-native
      // shape (Anthropic thinking block, Responses reasoning.max_tokens,
      // Gemini thinkingConfig.thinkingBudget). `type:'adaptive'` lets the
      // upstream pick the model default (Anthropic Opus 5.5+); we just
      // skip the type marker. `type:'disabled'` maps to `reasoning_effort=
      // 'none'` (the lowest tier — explicit "no thinking"). output_config
      // .effort (Anthropic's high-level knob, Opus 5.5+) takes precedence
      // when both are present — it is the more explicit signal. A value
      // outside the 6-level vocabulary (e.g. a future Anthropic tier) is
      // dropped to "no preference" so the gateway keeps working through
      // upstream vocabulary changes.
      max_thinking_tokens: body.thinking?.type === 'enabled' ? body.thinking?.budget_tokens : undefined,
      reasoning_effort: (() => {
        const oc = body.output_config?.effort;
        if (oc && (EFFORT_LADDER as readonly string[]).includes(oc)) return oc as ReasoningEffort;
        if (body.thinking?.type === 'disabled') return 'none';
        return undefined;
      })(),
      ...(body.tools?.length
        ? {
            tools: body.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.input_schema },
            })),
          }
        : {}),
    },
  };
}

/** finish_reason -> Anthropic stop_reason */
function toStopReason(finish: string | null | undefined): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

export function openAIToAnthropic(
  response: ChatCompletionResponse,
  model: string
): Record<string, unknown> {
  const choice = response.choices?.[0];
  const usage = response.usage;
  const message = choice?.message;

  const content: Record<string, unknown>[] = [];
  const text = typeof message?.content === 'string' ? message.content : '';
  if (text) content.push({ type: 'text', text });
  for (const tc of message?.tool_calls || []) {
    let input: Record<string, any> = {};
    try {
      input = JSON.parse(tc.function.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id: response.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model || response.model,
    content,
    stop_reason: toStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens
        ? { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens }
        : {}),
    },
  };
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Synthesize the Anthropic SSE event sequence for one buffered completion.
 * Emits per-content-block start/delta/stop (text_delta and input_json_delta),
 * so tool-calling clients on the streaming path receive proper tool_use
 * blocks — Claude Code always streams, this path is its primary lifeline.
 */
export function chatToAnthropicStreamEvents(
  response: ChatCompletionResponse,
  model: string
): string[] {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const id = response.id || `msg_${Date.now()}`;
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: string };
  const blocks: Block[] = [];
  const text = typeof message?.content === 'string' ? message.content : '';
  if (text) blocks.push({ type: 'text', text });
  for (const tc of message?.tool_calls || []) {
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: tc.function.arguments || '{}' });
  }

  const events: string[] = [];
  events.push(
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })
  );

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(sseEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
      const chunkSize = 4;
      for (let i = 0; i < block.text.length; i += chunkSize) {
        events.push(sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text.slice(i, i + chunkSize) } }));
      }
      events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    } else {
      events.push(sseEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }));
      const chunkSize = 32;
      for (let i = 0; i < block.input.length; i += chunkSize) {
        events.push(sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.input.slice(i, i + chunkSize) } }));
      }
      events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    }
  });

  events.push(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: toStopReason(choice?.finish_reason), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
  );
  events.push(sseEvent('message_stop', { type: 'message_stop' }));
  return events;
}
