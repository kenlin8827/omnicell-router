import type { LLMProvider, UpstreamEventContext, CallCredential } from '../base.js';
import type { ModelRegistration, ProviderConfig } from '../../config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../ir/types.js';
import { canonicalToGooglePayload, googleResponseToIR } from '../../ir/adapters/google-gemini.js';
import { GoogleGeminiStreamDecoder } from '../../ir/adapters/google-gemini-stream.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_TIMEOUT_MS,
} from '../../config/defaults.js';
import { postProviderJson, setDefaultHeaderCaseInsensitive, setHeaderCaseInsensitive } from './http-json.js';
import { postProviderStream } from './http-stream.js';

/** Google Generative Language upstream. The provider speaks Canonical IR only. */
export class GoogleGeminiProvider implements LLMProvider {
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
    if (apiKey) setHeaderCaseInsensitive(headers, 'x-goog-api-key', apiKey);
    return headers;
  }

  public async createCompletion(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<CanonicalResponse> {
    const data = await postProviderJson({
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model.upstreamModel)}:generateContent`,
      headers: this.headers(credential),
      payload: canonicalToGooglePayload(request, model),
      model,
      provider: this.name,
      label: 'google',
      timeoutMs: this.config.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS,
      upstreamEventContext,
    });
    return googleResponseToIR(data);
  }

  public async createStream(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<AsyncIterable<StreamEvent>> {
    return postProviderStream({
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model.upstreamModel)}:streamGenerateContent?alt=sse`,
      headers: this.headers(credential),
      payload: canonicalToGooglePayload(request, model),
      model,
      provider: this.name,
      label: 'google',
      timeoutMs: this.config.streamTimeoutMs || DEFAULT_STREAM_TIMEOUT_MS,
      idleTimeoutMs: this.config.streamIdleTimeoutMs || DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      upstreamEventContext,
      createDecoder: () => new GoogleGeminiStreamDecoder(),
      parseBuffered: (body) => googleResponseToIR(body),
    });
  }
}
