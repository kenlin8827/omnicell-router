import type { LLMProvider, UpstreamEventContext, CallCredential } from '../base.js';
import type { ModelRegistration, ProviderConfig } from '../../config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../ir/types.js';
import { anthropicResponseToIR, canonicalToAnthropicPayload } from '../../ir/adapters/anthropic-messages.js';
import { AnthropicMessagesStreamDecoder } from '../../ir/adapters/anthropic-messages-stream.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_TIMEOUT_MS,
} from '../../config/defaults.js';
import { anthropicMessagesUrl } from '../wire.js';
import { mergeCommaHeader, postProviderJson, setDefaultHeaderCaseInsensitive, setHeaderCaseInsensitive } from './http-json.js';
import { postProviderStream } from './http-stream.js';

/** Anthropic Messages upstream. The provider speaks Canonical IR only. */
export class AnthropicMessagesProvider implements LLMProvider {
  public name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  dialBaseFor(): string {
    return this.config.baseUrl;
  }

  private headers(credential?: CallCredential): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.config.headers,
    };
    setDefaultHeaderCaseInsensitive(headers, 'Content-Type', 'application/json');
    setDefaultHeaderCaseInsensitive(headers, 'anthropic-version', '2023-06-01');
    const apiKey = credential?.key ?? this.config.apiKey;
    if (apiKey) setHeaderCaseInsensitive(headers, 'x-api-key', apiKey);
    mergeCommaHeader(headers, 'anthropic-beta', 'prompt-caching-2024-07-31');
    return headers;
  }

  public async createCompletion(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<CanonicalResponse> {
    const data = await postProviderJson({
      url: anthropicMessagesUrl(this.config.baseUrl),
      headers: this.headers(credential),
      payload: canonicalToAnthropicPayload(request, model),
      model,
      provider: this.name,
      label: 'anthropic',
      timeoutMs: this.config.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS,
      upstreamEventContext,
    });
    return anthropicResponseToIR(data);
  }

  public async createStream(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<AsyncIterable<StreamEvent>> {
    return postProviderStream({
      url: anthropicMessagesUrl(this.config.baseUrl),
      headers: this.headers(credential),
      payload: { ...canonicalToAnthropicPayload(request, model), stream: true },
      model,
      provider: this.name,
      label: 'anthropic',
      timeoutMs: this.config.streamTimeoutMs || DEFAULT_STREAM_TIMEOUT_MS,
      idleTimeoutMs: this.config.streamIdleTimeoutMs || DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      ttftTimeoutMs: this.config.ttftTimeoutMs,
      upstreamEventContext,
      createDecoder: () => new AnthropicMessagesStreamDecoder(),
      parseBuffered: (body) => anthropicResponseToIR(body),
    });
  }
}
