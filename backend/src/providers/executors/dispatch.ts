import { LLMProvider, type UpstreamEventContext, type CallCredential } from '../base.js';
import type { ModelRegistration, ProviderConfig } from '../../config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../ir/types.js';
import { WireKind } from '../wire.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { getModelServicePlugin } from '../../plugins/host.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { AnthropicMessagesProvider } from './anthropic-messages.js';
import { GoogleGeminiProvider } from './google-gemini.js';
import { createPluginProvider } from './plugin-adapter.js';
import { isPluginWire } from '../plugin-wires.js';

/** Resolve each model's physical wire to one canonical executor. */
export class DispatchingProvider implements LLMProvider {
  public name: string;
  private execs = new Map<WireKind, LLMProvider>();

  constructor(config: ProviderConfig, wireBases: Partial<Record<WireKind, string>>) {
    this.name = config.name;
    for (const [wire, baseUrl] of Object.entries(wireBases) as [WireKind, string][]) {
      if (wire === 'unroutable' || wire === 'systemone') continue;
      const wireConfig: ProviderConfig = {
        ...config,
        type: wire,
        baseUrl,
      };
      if (wire === 'anthropic-messages') this.execs.set(wire, new AnthropicMessagesProvider(wireConfig));
      else if (wire === 'google-gemini') this.execs.set(wire, new GoogleGeminiProvider(wireConfig));
      else if (wire === 'openai-responses') this.execs.set(wire, new OpenAIResponsesProvider(wireConfig));
      else if (wire === 'openai-chat') this.execs.set(wire, new OpenAIChatProvider(wireConfig));
      else {
        // Plugin-owned wires are resolved through the host registry, never
        // through a name list here (a new plugin protocol needs no core edit).
        const plugin = getModelServicePlugin(wire);
        if (plugin) this.execs.set(wire, createPluginProvider(plugin, wireConfig));
        else if (!isPluginWire(wire)) this.execs.set(wire, new OpenAIChatProvider(wireConfig));
        // A plugin wire with no installed executor stays UNSET on purpose:
        // exec() then fails by wire id instead of routing the request to a
        // chat executor that would only produce an upstream 400.
      }
    }
  }

  private exec(model: ModelRegistration): LLMProvider {
    const wire = model.wire ?? 'openai-chat';
    const executor = this.execs.get(wire);
    if (!executor) throw new Error(`Model '${model.id}' wire '${wire}' is not registered in the direct pool`);
    return executor;
  }

  public createCompletion(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<CanonicalResponse> {
    return this.exec(model).createCompletion(request, model, upstreamEventContext, credential);
  }

  public supportsStreaming(model: ModelRegistration): boolean {
    try {
      const executor = this.exec(model);
      return executor.supportsStreaming
        ? executor.supportsStreaming(model)
        : typeof executor.createStream === 'function';
    } catch {
      return false;
    }
  }

  public async createStream(
    request: CanonicalRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<AsyncIterable<StreamEvent>> {
    const executor = this.exec(model);
    if (!executor.createStream) throw new Error(`Wire '${model.wire ?? 'openai-chat'}' has no native streaming executor`);
    return executor.createStream(request, model, upstreamEventContext, credential);
  }
}
