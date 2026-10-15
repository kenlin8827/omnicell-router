import { LLMProvider, type UpstreamEventContext, type CallCredential } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch, resolveProxyUrl } from '../utils/proxy.js';
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
} from '../observability/upstream-events.js';

export class OpenAICompatibleProvider implements LLMProvider {
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
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Per-call credential outranks the boot-baked key;
      // absent = baked key, byte-identical to every pre-P3 request.
      Authorization: `Bearer ${credential?.key ?? this.config.apiKey}`,
      ...this.config.headers,
    };

    if (this.config.organization) {
      headers['OpenAI-Organization'] = this.config.organization;
    }

    const payload: any = {
      ...request,
      model: model.upstreamModel,
      stream: false,
    };
    delete payload.router_options;
    // The gateway streams to clients by executing non-streaming upstream calls
    // and re-chunking the result — a client-sent stream_options must never leak
    // into a non-streaming payload (strict upstreams like Alibaba reject
    // stream_options without stream: true with a 400).
    delete payload.stream_options;
    // Models the catalog marks temperature:false (next-gen Claude etc.) reject
    // sampling params — strip them from the passthrough payload to avoid an
    // upstream 400 invalid_request_error.
    if (model.temperature === false) delete payload.temperature;
    // reasoning_effort is the OpenAI-standard field; forwarded verbatim.
    // `max` (Anthropic's top tier) is not a valid OpenAI value — the
    // orchestrator's downgrade step collapses it to `xhigh` (or lower)
    // before reaching here, so a stray `max` would only survive if the
    // operator explicitly declared `max` in the model's
    // supportedReasoningEfforts AND routed it to an OpenAI wire, which
    // is a config error and surfaces as a clear 400 from the upstream.

    // Event-stream emit BEFORE the fetch fires — independent of the response.
    // Pairs with the upstream-response event below via `spanId`.
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
      // (network / DNS / TLS / abort / UpstreamError) so console readers
      // never see a dangling request event without a matching response.
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
          error: `Upstream ${res.status}`,
        });
        throw new UpstreamError({
          message: `Upstream ${this.name} returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
          retryAfterSeconds: isNaN(retryAfterSeconds as number) ? undefined : retryAfterSeconds,
        });
      }

      // Emit the response event the moment the body BYTES arrive — before
      // JSON.parse (see anthropic.ts for the rationale). The raw text body
      // preserves any whitespace / numeric-precision quirks the upstream
      // added.
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
      const json = JSON.parse(rawBody) as ChatCompletionResponse;
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async createStream(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    credential?: CallCredential
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Same per-call credential rule as createCompletion above.
      Authorization: `Bearer ${credential?.key ?? this.config.apiKey}`,
      ...this.config.headers,
    };

    const payload: any = {
      ...request,
      model: model.upstreamModel,
      stream: true,
      stream_options: { include_usage: true },
    };
    delete payload.router_options;
    // Models the catalog marks temperature:false — strip the param (same as the non-streaming path).
    if (model.temperature === false) delete payload.temperature;
    // reasoning_effort is the OpenAI-standard field; forwarded verbatim.
    if (request.reasoning_effort) payload.reasoning_effort = request.reasoning_effort;

    const res = await proxiedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }, { provider: this.config.name, model: model.id });

    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(`Upstream streaming failed [${res.status}]: ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    return {
      async *[Symbol.asyncIterator]() {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed === 'data: [DONE]') return;
            if (trimmed.startsWith('data: ')) {
              try {
                const chunk = JSON.parse(trimmed.slice(6)) as ChatCompletionChunk;
                yield chunk;
              } catch {
                // Ignore parse errors on partial lines
              }
            }
          }
        }
      },
    };
  }
}