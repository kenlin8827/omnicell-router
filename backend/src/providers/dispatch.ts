import { LLMProvider, type UpstreamEventContext, type CallCredential } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { WireKind } from './wire.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { ResponsesProvider } from './responses.js';
import { GoogleProvider } from './google.js';

/**
 * one logical provider may host models on different wires
 * (e.g. Zen: chat/completions for most, Responses API for gpt-6-luna,
 * Anthropic Messages for claude-*) — and even different MOUNTS per wire
 * (Zen: /zen/v1 vs /inference/anthropic/v1). Dispatch is driven purely by
 * `ModelRegistration.wire`, resolved at boot through the shared wireFor()/
 * baseForWire() that the console probe also uses — test ≡ inference by structure.
 */
export class DispatchingProvider implements LLMProvider {
  public name: string;
  private execs = new Map<WireKind, LLMProvider>();

  constructor(config: ProviderConfig, wireBases: Partial<Record<WireKind, string>>) {
    this.name = config.name;
    for (const [w, base] of Object.entries(wireBases) as [WireKind, string][]) {
      if (w === 'unroutable') continue;
      const wireCfg: ProviderConfig = { ...config, type: w as ProviderConfig['type'], baseUrl: base };
      if (w === 'anthropic') this.execs.set(w, new AnthropicProvider(wireCfg));
      else if (w === 'responses') this.execs.set(w, new ResponsesProvider(wireCfg));
      else if (w === 'google') this.execs.set(w, new GoogleProvider(wireCfg));
      else this.execs.set(w, new OpenAICompatibleProvider(wireCfg));
    }
  }

  private exec(model: ModelRegistration): LLMProvider {
    const w: WireKind = model.wire ?? 'openai';
    const exec = this.execs.get(w);
    if (!exec) {
      throw new Error(`模型 '${model.id}' 线型 ${w} 未在直连池注册（显式不可路由，非上游问题）`);
    }
    return exec;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential
  ): Promise<ChatCompletionResponse> {
    return this.exec(model).createCompletion(request, model, upstreamEventContext, credential);
  }

  public async createStream(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    credential?: CallCredential
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const exec = this.exec(model);
    if (!exec.createStream) {
      throw new Error(`线型 ${model.wire ?? 'openai'} 暂不支持原生流式`);
    }
    return exec.createStream(request, model, credential);
  }
}