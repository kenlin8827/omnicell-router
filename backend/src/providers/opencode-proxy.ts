import { LLMProvider, type UpstreamEventContext } from './base.js';
import { ModelRegistration } from '../config/types.js';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { OpenCodeServiceConfig } from '../opencode/connector.js';
import { proxiedFetch, resolveProxyUrl } from '../utils/proxy.js';
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
} from '../observability/upstream-events.js';

export class OpenCodeProxyProvider implements LLMProvider {
  public name = 'opencode-proxy';
  private config: OpenCodeServiceConfig;

  constructor(config: OpenCodeServiceConfig) {
    this.config = config;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext
  ): Promise<ChatCompletionResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/api/experimental/generate`;

    // Flatten messages into conversational prompt
    let prompt = '';
    for (const msg of request.messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(p => p.text || '').join(' ')
          : '';
      prompt += `${msg.role.toUpperCase()}: ${content}\n\n`;
    }
    prompt += 'ASSISTANT:';

    const payload = {
      prompt: prompt.trim(),
      model: {
        providerID: model.provider,
        id: model.upstreamModel,
      },
    };

    const outboundHeaders: Record<string, string> = {
      Authorization: this.config.authHeader,
      'Content-Type': 'application/json',
    };

    // Event-stream emit BEFORE the fetch fires. Independent of the response.
    const spanId = emitUpstreamRequestOnce(upstreamEventContext, {
      url,
      method: 'POST',
      requestHeaders: outboundHeaders,
      requestBody: JSON.stringify(payload),
      model: model.upstreamModel,
      proxy: resolveProxyUrl(url, { provider: this.name, model: model.id }),
    });

    // The guard emits a paired failure response event on ANY thrown error so
    // console readers never see a dangling request event.
    const res = await withUpstreamFailureGuard(
      upstreamEventContext,
      spanId,
      url,
      'POST',
      // Loopback URLs skip the proxy (see isLoopbackUrl in proxy.ts), so this
      // also keeps local daemon calls from being routed via the gateway.
      () => proxiedFetch(
        url,
        {
          method: 'POST',
          headers: outboundHeaders,
          body: JSON.stringify(payload),
        },
        { provider: this.name, model: model.id }
      ),
      model.upstreamModel
    );

    if (!res.ok) {
      // Body read can fail mid-stream (connection reset) — pair the request
      // event with a failure response before rethrowing.
      let errText: string;
      try {
        errText = await res.text();
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
        responseBody: errText,
        error: `OpenCode Proxy error [${res.status}]`,
      });
      throw new Error(`OpenCode Proxy failed [${res.status}]: ${errText}`);
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
    // The shape is `{ data: { text: string } }` (private HTTP API; not
    // OpenAI-compatible).
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
    const text = data.data?.text || '';

    // Estimate tokens
    const promptTokens = Math.ceil(prompt.length / 3);
    const completionTokens = Math.ceil(text.length / 3);

    return {
      id: `opencode-cmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }
}