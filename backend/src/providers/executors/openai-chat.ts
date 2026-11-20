import { LLMProvider, type UpstreamEventContext, type CallCredential } from '../base.js';
import type { ModelRegistration, ProviderConfig } from '../../config/types.js';
import type { ChatCompletionChunk, ChatCompletionResponse } from '../../types/openai.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../ir/types.js';
import { chatResponseToIR, irToChatRequest } from '../../ir/adapters/openai-chat.js';
import { ChatStreamDecoder } from '../../ir/adapters/openai-chat-stream.js';
import { postProviderJson, setDefaultHeaderCaseInsensitive, setHeaderCaseInsensitive } from './http-json.js';
import { postProviderStream } from './http-stream.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_TIMEOUT_MS,
} from '../../config/defaults.js';

export class OpenAIChatProvider implements LLMProvider {
  public name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  private headers(credential?: CallCredential): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.config.headers,
    };
    setDefaultHeaderCaseInsensitive(headers, 'Content-Type', 'application/json');
    const apiKey = credential?.key ?? this.config.apiKey;
    if (apiKey) setHeaderCaseInsensitive(headers, 'Authorization', `Bearer ${apiKey}`);
    if (this.config.organization) setHeaderCaseInsensitive(headers, 'OpenAI-Organization', this.config.organization);
    return headers;
  }

  /** One explicit, adapter-owned whitelist feeds both buffered and streaming calls. */
  private payload(request: CanonicalRequest, model: ModelRegistration, stream: boolean): Record<string, unknown> {
    const chat = irToChatRequest(request, model.upstreamModel, { carrierExtensions: false });
    if (model.temperature === false) delete chat.temperature;
    if (!stream) delete chat.stream_options;
    const useMaxCompletionTokens =
      model.usesMaxCompletionTokens ??
      /(?:^|\/)(?:o1|o3|o4|gpt-5)(?:$|[-_.:])/i.test(model.upstreamModel);
    const out: Record<string, unknown> = {
      ...chat,
      model: model.upstreamModel,
      stream,
      ...(stream && model.supportsStreamOptions !== false ? { stream_options: { include_usage: true } } : {}),
    };
    if (useMaxCompletionTokens && out.max_tokens !== undefined) {
      out.max_completion_tokens = out.max_tokens;
      delete out.max_tokens;
    }
    return out;
  }

  public async createCompletion(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<CanonicalResponse> {
    const payload = this.payload(request, model, false);
    const data = await postProviderJson({
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      headers: this.headers(credential),
      payload,
      model,
      provider: this.name,
      label: 'chat',
      timeoutMs: this.config.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS,
      upstreamEventContext,
    });
    return chatResponseToIR(data as ChatCompletionResponse);
  }

  public async createStream(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<AsyncIterable<StreamEvent>> {
    return postProviderStream({
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      headers: this.headers(credential),
      payload: this.payload(request, model, true),
      model,
      provider: this.name,
      label: 'chat',
      timeoutMs: this.config.streamTimeoutMs || DEFAULT_STREAM_TIMEOUT_MS,
      idleTimeoutMs: this.config.streamIdleTimeoutMs || DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      upstreamEventContext,
      createDecoder: () => {
        const decoder = new ChatStreamDecoder();
        let terminated = false;
        return {
          get terminated() { return terminated; },
          push(payload) {
            const chunk = payload as ChatCompletionChunk;
            if (chunk.choices?.some((choice) => choice.finish_reason)) terminated = true;
            return decoder.push(chunk);
          },
          finish: () => decoder.finish(),
        };
      },
      parseBuffered: (body) => chatResponseToIR(body as ChatCompletionResponse),
    });
  }
}
