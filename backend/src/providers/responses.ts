import crypto from 'node:crypto';
import { LLMProvider, type UpstreamEventContext, type CallCredential } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
} from '../observability/upstream-events.js';
import { ChatCompletionRequest, ChatCompletionResponse, ChatMessageContentPart, ToolCall } from '../types/openai.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch, resolveProxyUrl } from '../utils/proxy.js';

/**
 * OpenAI Responses API wire (`@ai-sdk/openai`) — POST {base}/responses.
 * Serves providers (or single models, via model-level npm override) that reject
 * chat/completions with `ModelProtocolUnsupported` — e.g. Zen's gpt-6-luna.
 *
 * Tools are fully mapped both directions (2026-10): request.tools → payload
 * tools (identical flat function shape), assistant tool_calls in history →
 * function_call items, tool role messages → function_call_output items, and
 * upstream function_call output items → chat tool_calls. Without this, a
 * /v1/responses tool-loop client routed here would silently lose tool calling.
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

/**
 * OpenAI Responses wire shares the same response-header semantics as the
 * chat-completions wire (x-ratelimit-*, retry-after, x-request-id) — the
 * upstream is the same family. Headers are now sanitized uniformly via
 * `sanitizeHeadersForCapture` (full names + credential redaction) so the
 * wire-specific extractor is no longer needed.
 */

/** Pure payload builder: chat-completions request → OpenAI Responses payload. */
export function buildResponsesPayload(request: ChatCompletionRequest, model: ModelRegistration): Record<string, any> {
  const instructions: string[] = [];
  const input: any[] = [];
  for (const msg of request.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      instructions.push(typeof msg.content === 'string' ? msg.content : textOf(msg.content));
      continue;
    }
    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const text = typeof msg.content === 'string' ? msg.content : textOf(msg.content);
      if (text) input.push({ role, content: text });
      for (const tc of msg.tool_calls) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
      continue;
    }
    if (typeof msg.content === 'string') {
      input.push({ role, content: msg.content });
    } else {
      input.push({
        role,
        content: msg.content.map((p) =>
          p.type === 'text'
            ? { type: 'input_text', text: p.text || '' }
            : { type: 'input_image', image_url: (p as any).image_url?.url }
        ),
      });
    }
  }
  const payload: Record<string, any> = {
    model: model.upstreamModel,
    input,
    stream: false,
  };
  const joined = instructions.filter(Boolean).join('\n\n');
  if (joined) payload.instructions = joined;
  if (request.max_tokens != null) payload.max_output_tokens = request.max_tokens;
  else if (request.max_completion_tokens != null) payload.max_output_tokens = request.max_completion_tokens;
  if (request.temperature != null && model.temperature !== false) payload.temperature = request.temperature;
  if (request.top_p != null) payload.top_p = request.top_p;
  if (request.tools?.length) payload.tools = request.tools;
  if (request.reasoning_effort || request.max_thinking_tokens != null) {
    const reasoning: Record<string, any> = {};
    // OpenAI Responses accepts the full 5-level vocabulary (none/low/medium/
    // high/xhigh). Pass through verbatim — upstream rejects unsupported values
    // with a clear 400. Explicit max_thinking_tokens wins over the ladder.
    if (request.reasoning_effort) reasoning.effort = request.reasoning_effort;
    if (request.max_thinking_tokens != null) reasoning.max_tokens = request.max_thinking_tokens;
    payload.reasoning = reasoning;
  }
  return payload;
}

/** Pure response mapper: OpenAI Responses payload → chat-completions response. */
export function responsesToChatCompletion(data: any, model: ModelRegistration): ChatCompletionResponse {
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const o of data.output || []) {
    if (o.type === 'message') {
      text += (o.content || [])
        .filter((c: any) => c.type === 'output_text')
        .map((c: any) => c.text)
        .join('');
    } else if (o.type === 'function_call') {
      toolCalls.push({
        id: o.call_id || o.id || `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: {
          name: o.name,
          arguments: typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments ?? {}),
        },
      });
    }
  }
  const cached = data.usage?.input_tokens_details?.cached_tokens || 0;
  // OpenAI Responses surfaces thinking tokens as `usage.output_tokens_details.reasoning_tokens`;
  // mirror them into the chat-completions shape so downstream cost math + clients see them.
  const reasoningTokens = data.usage?.output_tokens_details?.reasoning_tokens || 0;

  return {
    id: data.id || `resp-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : data.status === 'incomplete' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      prompt_tokens_details: { cached_tokens: cached },
      ...(reasoningTokens > 0
        ? {
            completion_tokens_details: {
              reasoning_tokens: reasoningTokens,
            },
          }
        : {}),
    },
  };
}

export class ResponsesProvider implements LLMProvider {
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
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/responses`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Per-call credential outranks the boot-baked key.
      Authorization: `Bearer ${credential?.key ?? this.config.apiKey}`,
      ...this.config.headers,
    };

    const payload = buildResponsesPayload(request, model);

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
    // Wall-clock cap on the non-streaming upstream execution — see the
    // openai-compatible provider: agent coding traffic legitimately runs past
    // a minute, so the default is 300 s.
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 300000);

    try {
      const res = await withUpstreamFailureGuard(
        upstreamEventContext,
        spanId,
        url,
        'POST',
        () => proxiedFetch(
          url,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          },
          { provider: this.config.name, model: model.id }
        ),
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
          error: `Responses error [${res.status}]`,
        });
        throw new UpstreamError({
          message: `Upstream ${this.name} [responses] returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
          retryAfterSeconds: isNaN(retryAfterSeconds as number) ? undefined : retryAfterSeconds,
        });
      }

      // Emit the response event the moment the body BYTES arrive — before
      // JSON.parse (see anthropic.ts for the rationale).
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
      return responsesToChatCompletion(data, model);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function textOf(parts: ChatMessageContentPart[]): string {
  return parts.map((p) => p.text || '').join(' ');
}
