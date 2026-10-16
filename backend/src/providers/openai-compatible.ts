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

/**
 * Upper bound on the raw SSE bytes kept in memory for one streamed exchange's
 * capture event. The recorder truncates every body at `maxBodyBytes` (256 KB by
 * default) when writing the JSONL line, so retaining more than a few multiples
 * of that budget buys the archive nothing — it is purely a memory guard for
 * long agent-loop streams.
 */
const STREAM_CAPTURE_CAP = 256 * 1024;

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
    // A streamed client on THIS wire is served by createStream (frames relayed
    // as they arrive). This method is the buffered leg: an inbound surface with
    // no chunk encoder, the schema-assertion cascade, mock mode, a client that
    // did not ask for a stream, or `streaming.enabled:false`. A client-sent
    // stream_options must never leak into this payload — strict upstreams (e.g.
    // Alibaba) reject stream_options without stream:true with a 400.
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
    // Wall-clock cap on the buffered upstream execution (the gateway awaits the
    // full response, then the surface encodes it). Agent coding traffic carries
    // large contexts and long generations, so a legitimate completion can easily
    // run past a minute — 60 s used to cut healthy streams mid-flight and pay for
    // them again on retry. The streamed leg applies the same cap across the whole
    // SSE body (see createStream).
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 300000);

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
    upstreamEventContext?: UpstreamEventContext,
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

    // Event-stream emit BEFORE the fetch fires — same discipline as
    // createCompletion above, so a streamed turn is captured as a full
    // request/response pair instead of a dangling request line.
    const spanId = emitUpstreamRequestOnce(upstreamEventContext, {
      url,
      method: 'POST',
      requestHeaders: headers,
      requestBody: JSON.stringify(payload),
      model: model.upstreamModel,
      proxy: resolveProxyUrl(url, { provider: this.config.name, model: model.id }),
    });

    const controller = new AbortController();
    // Wall-clock cap, identical in kind to the non-streaming path. It aborts
    // MID-STREAM when generation runs long: by then the relay has committed
    // bytes to the client, so the pipeline closes the SSE without `[DONE]`
    // rather than failing over (re-issuing upstream would duplicate output).
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 300000);

    let res: Response;
    try {
      res = await withUpstreamFailureGuard(
        upstreamEventContext,
        spanId,
        url,
        'POST',
        () =>
          proxiedFetch(
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

      if (!res.ok || !res.body) {
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
            error: `Streaming error body read failed: ${err?.message ?? err}`,
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
        // UpstreamError (not a bare Error) keeps the classifier's status /
        // retry-after / credential attribution working on the streaming leg too
        // — a 429 head must trip the same breaker path as on the buffered leg.
        throw new UpstreamError({
          message: `Upstream ${this.name} returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
          retryAfterSeconds: isNaN(retryAfterSeconds as number) ? undefined : retryAfterSeconds,
        });
      }
    } catch (err) {
      // No readable body ever materialized — release the timer, the generator
      // below is the only other owner of it.
      clearTimeout(timeout);
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    // Captured before the object literal below: inside `*[Symbol.asyncIterator]`
    // `this` is the iterable, not the provider.
    const providerName = this.name;

    return {
      async *[Symbol.asyncIterator]() {
        let buffer = '';
        // Raw wire bytes accumulated for the capture event only, capped — the
        // recorder truncates at maxBodyBytes anyway, so holding a multi-megabyte
        // stream in memory would be pure cost for zero extra evidence.
        let raw = '';
        let rawCapped = false;
        let captured = false;
        let sawDone = false;
        let sawFinishReason = false;
        const appendRaw = (piece: string): void => {
          if (rawCapped) return;
          raw += piece;
          if (raw.length > STREAM_CAPTURE_CAP) {
            raw = raw.slice(0, STREAM_CAPTURE_CAP) + '...[TRUNCATED]';
            rawCapped = true;
          }
        };
        /** Exactly one response event per streamed exchange (cp-failfast: paired, never dangling). */
        const capture = (error?: string): void => {
          if (captured || !spanId) return;
          captured = true;
          const base = {
            spanId,
            url,
            method: 'POST',
            status: res.status,
            statusText: res.statusText,
            responseHeaders: res.headers,
            responseBody: raw,
            model: model.upstreamModel,
          };
          if (error) emitUpstreamFailureOnce(upstreamEventContext, { ...base, error });
          else emitUpstreamResponseOnce(upstreamEventContext, base);
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const decoded = decoder.decode(value, { stream: true });
            appendRaw(decoded);
            buffer += decoded;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (trimmed === 'data: [DONE]') {
                sawDone = true;
                return;
              }
              if (trimmed.startsWith('data: ')) {
                try {
                  const chunk = JSON.parse(trimmed.slice(6)) as ChatCompletionChunk;
                  if (chunk.choices?.some((c) => c.finish_reason)) sawFinishReason = true;
                  yield chunk;
                } catch {
                  // Ignore parse errors on partial lines
                }
              }
            }
          }
          // TRUNCATION GUARD. A body that simply stops is indistinguishable
          // from a clean end at the reader level, and silently assembling it
          // into `{content: null, finish_reason: 'stop'}` would bill a garbage
          // turn as a success. A stream is complete only if it said so — via a
          // finish_reason frame or [DONE] (some compatible-mode upstreams close
          // right after finish_reason without ever sending [DONE]).
          if (!sawDone && !sawFinishReason) {
            throw new Error(`Upstream ${providerName} stream ended before completion`);
          }
        } catch (err: any) {
          capture(`Stream aborted: ${err?.message ?? err}`);
          throw err;
        } finally {
          // Whether the upstream ever sent `[DONE]` is visible in the captured
          // raw body itself — the exchange event stays a success event, because
          // a stream that ends after a finish_reason chunk is a complete answer
          // for some compatible-mode upstreams and a failed one must not be
          // mislabelled as such here.
          capture();
          clearTimeout(timeout);
        }
      },
    };
  }
}