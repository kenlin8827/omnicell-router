import crypto from 'node:crypto';
import { LLMProvider, type UpstreamEventContext, type CallCredential } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { ChatCompletionRequest, ChatCompletionResponse, ToolCall } from '../types/openai.js';
import type { ReasoningEffort } from '../types/router.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch, resolveProxyUrl } from '../utils/proxy.js';
import { anthropicMessagesUrl } from './wire.js';
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
} from '../observability/upstream-events.js';

/**
 * Anthropic Messages upstream wire. Tools are fully mapped both directions
 * (2026-10): request.tools → Anthropic tools (input_schema), assistant
 * tool_calls in history → tool_use blocks, tool role messages → tool_result
 * blocks, and upstream tool_use blocks → chat tool_calls. Without this,
 * tool-driving clients routed to Anthropic upstreams silently lose tools.
 */

/** Parse tool arguments into an object; never throws (tool loops must survive). */
function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : { result: v };
  } catch {
    return { result: raw };
  }
}

function contentToText(content: ChatCompletionRequest['messages'][number]['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

const DATA_URL_RE = /^data:(.+?);base64,(.*)$/;

/**
 * Chat content parts → Anthropic content blocks. Text passes through; images
 * map to source blocks (base64 data URLs → inline source, HTTP(S) URLs → url
 * source). Non-text non-image parts degrade to their JSON form rather than
 * vanishing (fail-visible in the payload).
 */
function toAnthropicBlocks(content: ChatCompletionRequest['messages'][number]['content']): any[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text || '' };
    const url = (p as any).image_url?.url || '';
    const m = DATA_URL_RE.exec(url);
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    if (url.startsWith('http')) return { type: 'image', source: { type: 'url', url } };
    return { type: 'text', text: `[unsupported part: ${p.type}]` };
  });
}

/** Pure payload builder: chat-completions request → Anthropic Messages payload. */
export function buildAnthropicPayload(request: ChatCompletionRequest, model: ModelRegistration): Record<string, any> {
  let systemPrompt: any = undefined;
  const anthropicMessages: any[] = [];

  for (const msg of request.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = contentToText(msg.content);
      // Prompt caching block for Anthropic
      systemPrompt = [
        {
          type: 'text',
          text,
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else if (msg.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || '',
            content: contentToText(msg.content),
          },
        ],
      });
    } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const blocks: any[] = [];
      const text = contentToText(msg.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of msg.tool_calls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      anthropicMessages.push({ role: 'assistant', content: blocks });
    } else {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      anthropicMessages.push({ role, content: toAnthropicBlocks(msg.content) });
    }
  }

  const payload: any = {
    model: model.upstreamModel,
    max_tokens: request.max_tokens || request.max_completion_tokens || 4096,
    messages: anthropicMessages,
    system: systemPrompt,
    // Models the catalog marks temperature:false (next-gen Claude etc.) have
    // deprecated sampling params — strip it to avoid the upstream 400
    // "`temperature` is deprecated for this model". undefined is dropped
    // automatically by JSON.stringify, i.e. the field is simply not sent.
    temperature: model.temperature === false ? undefined : request.temperature,
  };
  // Extended thinking: Anthropic requires `thinking.type=enabled` plus a positive
  // `budget_tokens`; budget is the upper bound on thinking tokens consumed
  // before the final answer (must be < max_tokens). Map the gateway's 5-level
  // effort level → token budget. The full 6-level table; `none` maps
  // to 0 as a defensive value even though the guard below skips the
  // thinking block for it. Numbers for the other 5 are engineering
  // estimates; operators with strict cost caps should pass an explicit
  // `max_thinking_tokens` instead.
  const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 1024,
    medium: 4096,
    high: 16384,
    xhigh: 32768,
    max: 65536,
  };
  const effort = request.reasoning_effort;
  const explicitBudget = request.max_thinking_tokens != null && request.max_thinking_tokens > 0
    ? request.max_thinking_tokens
    : undefined;
  // `effort === undefined` (client omitted) and `effort === 'none'`
  // (client explicitly asked for no thinking) both skip the thinking
  // block — the upstream picks its own default. Mirrors google.ts.
  if ((effort && effort !== 'none') || explicitBudget != null) {
    const budget = explicitBudget ?? EFFORT_TO_BUDGET[effort as Exclude<ReasoningEffort, 'none'>];
    // Anthropic requires budget_tokens < max_tokens; bump max_tokens to leave headroom.
    if (typeof budget === 'number' && budget > 0) {
      const headroom = Math.max(payload.max_tokens, budget + 1024);
      if (headroom > payload.max_tokens) payload.max_tokens = headroom;
      payload.thinking = { type: 'enabled', budget_tokens: budget };
    }
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  if (request.tool_choice) {
    if (request.tool_choice === 'auto') payload.tool_choice = { type: 'auto' };
    else if (request.tool_choice === 'none') payload.tool_choice = { type: 'none' };
    else if (request.tool_choice === 'required') payload.tool_choice = { type: 'any' };
    else if (typeof request.tool_choice === 'object') payload.tool_choice = { type: 'tool', name: request.tool_choice.function.name };
  }
  if (request.stop?.length) payload.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  return payload;
}

/** Pure response mapper: Anthropic Messages payload → chat-completions response. */
export function anthropicToChatCompletion(data: any, model: ModelRegistration): ChatCompletionResponse {
  let textContent = '';
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
  }

  const cachedTokens = data.usage?.cache_read_input_tokens || 0;
  const uncachedInput = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  // Anthropic extended-thinking tokens ride in `usage.output_tokens_details.thinking_tokens`
  // (Anthropic Messages API reference). Surface them as OpenAI's
  // `completion_tokens_details.reasoning_tokens` so downstream cost math + clients see them.
  const thinkingTokens = data.usage?.output_tokens_details?.thinking_tokens || 0;
  const finishReason =
    data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : 'stop';

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: uncachedInput + cachedTokens,
      completion_tokens: outputTokens,
      total_tokens: uncachedInput + cachedTokens + outputTokens,
      prompt_tokens_details: {
        cached_tokens: cachedTokens,
      },
      // Only attach the thinking breakdown when there are actual thinking
      // tokens — keeps the response shape tight for non-thinking calls.
      ...(thinkingTokens > 0
        ? {
            completion_tokens_details: {
              reasoning_tokens: thinkingTokens,
            },
          }
        : {}),
    },
  };
}

export class AnthropicProvider implements LLMProvider {
  public name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential
  ): Promise<ChatCompletionResponse> {
    const url = anthropicMessagesUrl(this.config.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Per-call credential (ADR-0019 P3 step 1) outranks the boot-baked key.
      'x-api-key': credential?.key ?? this.config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      ...this.config.headers,
    };

    const payload = buildAnthropicPayload(request, model);

    // Event-stream emit BEFORE the fetch fires. Independent of the response.
    const spanId = emitUpstreamRequestOnce(upstreamEventContext, {
      url,
      method: 'POST',
      requestHeaders: headers,
      requestBody: JSON.stringify(payload),
      model: model.upstreamModel,
      proxy: resolveProxyUrl(url, { provider: this.config.name, model: model.id }),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 60000);

    try {
      // The guard emits a paired failure response event on ANY thrown error
      // so console readers never see a dangling request event.
      const res = await withUpstreamFailureGuard(
        upstreamEventContext,
        spanId,
        url,
        'POST',
        () => proxiedFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        }, { provider: this.config.name, model: model.id }),
        model.upstreamModel
      );

      if (!res.ok) {
        // Body read can fail mid-stream (connection reset) — pair the request
        // event with a failure response before rethrowing.
        let errorText: string;
        try {
          errorText = await res.text();
        } catch (err: any) {
          emitUpstreamFailureOnce(upstreamEventContext, {
            model: model.upstreamModel,
            spanId,
            url,
            method: 'POST',
            status: res.status,
            statusText: res.statusText,
            error: `Response body read failed: ${err?.message ?? err}`,
          });
          throw err;
        }
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
        emitUpstreamFailureOnce(upstreamEventContext, {
          model: model.upstreamModel,
          spanId,
          url,
          method: 'POST',
          status: res.status,
          statusText: res.statusText,
          responseHeaders: res.headers,
          responseBody: errorText,
          error: `Anthropic error [${res.status}]`,
        });
        throw new UpstreamError({
          message: `Anthropic error [${res.status}]: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
          retryAfterSeconds: isNaN(retryAfterSeconds as number) ? undefined : retryAfterSeconds,
        });
      }

      // Emit the response event the moment the body BYTES arrive — before
      // JSON.parse. A 200-with-garbage body (e.g. misconfigured baseUrl
      // returning an HTML error page) must still leave the response event
      // on disk; likewise a mid-body connection reset gets a failure event.
      let rawBody: string;
      try {
        rawBody = await res.text();
      } catch (err: any) {
        emitUpstreamFailureOnce(upstreamEventContext, {
          model: model.upstreamModel,
          spanId,
          url,
          method: 'POST',
          status: res.status,
          statusText: res.statusText,
          error: `Response body read failed: ${err?.message ?? err}`,
        });
        throw err;
      }
      emitUpstreamResponseOnce(upstreamEventContext, {
        model: model.upstreamModel,
        spanId,
        url,
        method: 'POST',
        status: res.status,
        statusText: res.statusText,
        responseHeaders: res.headers,
        responseBody: rawBody,
      });
      const data = JSON.parse(rawBody) as any;
      return anthropicToChatCompletion(data, model);
    } finally {
      clearTimeout(timeout);
    }
  }
}
