import { LLMProvider, type UpstreamEventContext, type CallCredential } from './base.js';
import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { WireKind } from './wire.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { getModelServicePlugin } from '../plugins/host.js';
import { ResponsesProvider } from './responses.js';
import { AnthropicProvider } from './anthropic.js';
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
      if (w === 'unroutable' || w === 'systemone') continue;
      // 'systemone' is intentionally NOT a chat executor (ADR-0008 §7): the
      // decision protocol is served natively by protocols/systemone/native.ts,
      // and decision-wire models never enter a chat pool (registry
      // tierPoolEntries filter), so exec() below never reaches a chat call —
      // its throw is the honest leftover for any direct misuse.
      const wireCfg: ProviderConfig = { ...config, type: w as ProviderConfig['type'], baseUrl: base };
      if (w === 'anthropic') this.execs.set(w, new AnthropicProvider(wireCfg));
      else if (w === 'google') this.execs.set(w, new GoogleProvider(wireCfg));
      else if (w === 'responses') this.execs.set(w, new ResponsesProvider(wireCfg));
      else if (w === 'qoder') {
        // Plugin-provided executor: absent plugin = no executor, and
        // exec() reports the honest "wire not registered" error per model.
        const plugin = getModelServicePlugin(w);
        if (plugin) this.execs.set(w, plugin.createProvider(wireCfg));
      }
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

  /**
   * Streaming capability: only executors with a native streaming reader are
   * admitted to the streamed relay path — the OpenAI `chat/completions` SSE
   * reader and the Qoder gRPC server-streaming bridge. Anthropic /
   * Google / Responses executors still return a buffered JSON document, so
   * their models keep the buffered path and the fake-stream re-chunker.
   */
  public supportsStreaming(model: ModelRegistration): boolean {
    const w = model.wire ?? 'openai';
    if (w !== 'openai' && w !== 'qoder') return false;
    try {
      return !!this.exec(model).createStream;
    } catch {
      // Unroutable wire (exec throws): report "cannot stream" and let the pool
      // surface the real routing error — a capability probe must not mask it.
      return false;
    }
  }

  public async createStream(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const exec = this.exec(model);
    if (!exec.createStream) {
      throw new Error(`Wire '${model.wire ?? 'openai'}' has no native streaming executor`);
    }
    return exec.createStream(request, model, upstreamEventContext, credential);
  }
}