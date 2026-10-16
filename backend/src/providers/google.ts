import crypto from 'node:crypto';
import { LLMProvider, type UpstreamEventContext, type CallCredential } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { ChatCompletionRequest, ChatCompletionResponse, ToolCall } from '../types/openai.js';
import type { ReasoningEffort } from '../types/router.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch, resolveProxyUrl } from '../utils/proxy.js';
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
} from '../observability/upstream-events.js';

/**
 * Google Generative Language wire (`@ai-sdk/google`) —
 * POST {base}/models/{model}:generateContent with x-goog-api-key.
 *
 * Tools are fully mapped both directions (2026-10): request.tools →
 * functionDeclarations, assistant tool_calls in history → functionCall parts,
 * tool role messages → functionResponse parts (call_id resolved to function
 * name via a first-pass scan), and upstream functionCall parts → chat
 * tool_calls. Without this, tool-driving clients routed to Gemini upstreams
 * silently lose tools.
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

function wrapResponse(v: Record<string, any>): Record<string, any> {
  // Gemini functionResponse.response must be a structured object.
  return Object.keys(v).length ? v : { result: 'ok' };
}

const DATA_URL_RE = /^data:(.+?);base64,(.*)$/;

/** Pure payload builder: chat-completions request → Gemini generateContent payload. */
export function buildGooglePayload(request: ChatCompletionRequest, model: ModelRegistration): Record<string, any> {
  // Gemini's functionResponse parts require the FUNCTION NAME (not call_id);
  // resolve call ids by scanning assistant tool_calls first.
  const nameByCall = new Map<string, string>();
  for (const m of request.messages) {
    for (const tc of m.tool_calls || []) nameByCall.set(tc.id, tc.function.name);
  }

  const systemText = request.messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');

  const contents = request.messages
    .filter((m) => m.role !== 'system' && m.role !== 'developer')
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: nameByCall.get(m.tool_call_id || '') || 'unknown_function',
                response: wrapResponse(parseArgs(m.content as any)),
              },
            },
          ],
        };
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const parts: any[] = [];
        const text = typeof m.content === 'string' ? m.content : '';
        if (text) parts.push({ text });
        for (const tc of m.tool_calls) {
          parts.push({ functionCall: { name: tc.function.name, args: parseArgs(tc.function.arguments) } });
        }
        return { role: 'model', parts };
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          typeof m.content === 'string'
            ? [{ text: m.content }]
            : m.content
                .map((p) => {
                  if (p.type === 'text') return { text: p.text || '' };
                  // Gemini inlineData requires base64; parse the data-URL so the
                  // real MIME type rides along. HTTP(S) URLs would need a
                  // Files-API upload — documented known loss (rare path).
                  const m2 = DATA_URL_RE.exec(String((p as any).image_url?.url || ''));
                  if (m2) return { inlineData: { mimeType: m2[1], data: m2[2] } };
                  return { text: `[unsupported image reference]` };
                })
                .filter(Boolean),
      };
    });

  const generationConfig: Record<string, any> = {};
  if (request.max_tokens != null) generationConfig.maxOutputTokens = request.max_tokens;
  else if (request.max_completion_tokens != null) generationConfig.maxOutputTokens = request.max_completion_tokens;
  if (request.temperature != null && model.temperature !== false) generationConfig.temperature = request.temperature;
  if (request.top_p != null) generationConfig.topP = request.top_p;
  if (request.stop?.length) generationConfig.stopSequences = request.stop;
  // effort level → thinkingConfig.thinkingBudget. The full 6-level
  // table; `none` maps to 0 as a defensive value even though the guard
  // below skips the thinking block for it. Numbers for the other 5 are
  // engineering estimates; operators with strict cost caps should pass
  // an explicit `max_thinking_tokens` instead.
  const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 1024,
    medium: 4096,
    high: 16384,
    xhigh: 32768,
    max: 65536,
  };
  const effort = request.reasoning_effort;
  if (request.max_thinking_tokens != null && request.max_thinking_tokens >= 0) {
    generationConfig.thinkingConfig = {
      thinkingBudget: request.max_thinking_tokens,
      includeThoughts: true,
    };
  } else if (effort && effort !== 'none') {
    generationConfig.thinkingConfig = {
      thinkingBudget: EFFORT_TO_BUDGET[effort],
      includeThoughts: true,
    };
  }

  const payload: Record<string, any> = { contents, ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}) };
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;
  if (request.tools?.length) {
    payload.tools = [
      {
        functionDeclarations: request.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ];
  }
  if (request.tool_choice === 'none') {
    payload.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  } else if (request.tool_choice === 'required') {
    payload.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
  } else if (request.tool_choice === 'auto') {
    payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return payload;
}

/** Pure response mapper: Gemini generateContent payload → chat-completions response. */
export function googleToChatCompletion(data: any, model: ModelRegistration): ChatCompletionResponse {
  const parts = data.candidates?.[0]?.content?.parts || [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
      });
    }
  }
  const finishRaw = data.candidates?.[0]?.finishReason;

  return {
    id: `google-${Date.now()}`,
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
        finish_reason: toolCalls.length
          ? 'tool_calls'
          : finishRaw === 'MAX_TOKENS'
            ? 'length'
            : finishRaw === 'SAFETY'
              ? 'content_filter'
              : 'stop',
      },
    ],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
      // Gemini surfaces thinking tokens as `thoughtsTokenCount` (separate from
      // `candidatesTokenCount` which counts only the visible answer). Surface
      // them as OpenAI's `completion_tokens_details.reasoning_tokens`.
      ...(data.usageMetadata?.thoughtsTokenCount
        ? {
            completion_tokens_details: {
              reasoning_tokens: data.usageMetadata.thoughtsTokenCount,
            },
          }
        : {}),
    },
  };
}

export class GoogleProvider implements LLMProvider {
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
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model.upstreamModel)}:generateContent`;

    const payload = buildGooglePayload(request, model);

    const outboundHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      // Per-call credential outranks the boot-baked key.
      'x-goog-api-key': credential?.key ?? this.config.apiKey,
      ...this.config.headers,
    };

    // Event-stream emit BEFORE the fetch fires. Independent of the response.
    const spanId = emitUpstreamRequestOnce(upstreamEventContext, {
      url,
      method: 'POST',
      requestHeaders: outboundHeaders,
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
            headers: outboundHeaders,
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
        emitUpstreamFailureOnce(upstreamEventContext, {
          model: model.upstreamModel,
          spanId,
          url,
          method: 'POST',
          status: res.status,
          statusText: res.statusText,
          responseHeaders: res.headers,
          responseBody: errorText,
          error: `Google error [${res.status}]`,
        });
        throw new UpstreamError({
          message: `Upstream ${this.name} [google] returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.config.name,
          modelId: model.id,
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
      return googleToChatCompletion(data, model);
    } finally {
      clearTimeout(timeout);
    }
  }
}
