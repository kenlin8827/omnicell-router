import type { LLMProvider, UpstreamEventContext, CallCredential } from '../base.js';
import type { ModelRegistration, ProviderConfig } from '../../config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../ir/types.js';
import { canonicalToResponsesPayload, responsesResponseToIR } from '../../ir/adapters/openai-responses.js';
import { OpenAIResponsesStreamDecoder } from '../../ir/adapters/openai-responses-stream.js';
import { UpstreamError } from '../../resilience/error-classifier.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_TIMEOUT_MS,
} from '../../config/defaults.js';
import { postProviderJson, setDefaultHeaderCaseInsensitive, setHeaderCaseInsensitive } from './http-json.js';
import { postProviderStream } from './http-stream.js';
import { redactUpstreamBody } from '../../observability/upstream-body-redaction.js';

function parseCompletion(
  data: { status?: string; error?: { message?: string } },
  provider: string,
  modelId: string,
  headers: Record<string, string>,
): CanonicalResponse {
  if (data.status === 'failed') {
    const safeMessage = redactUpstreamBody(
      data.error?.message || 'Upstream Responses turn failed.',
      headers,
    );
    const safeBody = redactUpstreamBody(JSON.stringify(data.error ?? {}), headers);
    throw new UpstreamError({
      message: safeMessage,
      status: 502,
      errorBody: safeBody,
      provider,
      modelId,
    });
  }
  return responsesResponseToIR(data);
}

/** OpenAI Responses upstream. The provider speaks Canonical IR only. */
export class OpenAIResponsesProvider implements LLMProvider {
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
    return headers;
  }

  public async createCompletion(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<CanonicalResponse> {
    const headers = this.headers(credential);
    const data = await postProviderJson({
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/responses`,
      headers,
      payload: canonicalToResponsesPayload(request, model),
      model,
      provider: this.name,
      label: 'responses',
      timeoutMs: this.config.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS,
      upstreamEventContext,
    }) as { status?: string; error?: { message?: string } };
    return parseCompletion(data, this.name, model.id, headers);
  }

  public async createStream(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<AsyncIterable<StreamEvent>> {
    const headers = this.headers(credential);
    return postProviderStream({
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/responses`,
      headers,
      payload: canonicalToResponsesPayload(request, model, true),
      model,
      provider: this.name,
      label: 'responses',
      timeoutMs: this.config.streamTimeoutMs || DEFAULT_STREAM_TIMEOUT_MS,
      idleTimeoutMs: this.config.streamIdleTimeoutMs || DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      upstreamEventContext,
      createDecoder: () => new OpenAIResponsesStreamDecoder(),
      parseBuffered: (body) =>
        parseCompletion(body as { status?: string; error?: { message?: string } }, this.name, model.id, headers),
    });
  }
}
