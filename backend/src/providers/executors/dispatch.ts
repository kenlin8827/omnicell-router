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
  /**
   * Wires whose executor is CORE (the four built-in transports + the
   * openai-chat fallback for unknown non-plugin types) and therefore honors
   * `config.proxy` through `proxiedFetch`. Plugin wires own their egress and
   * stay OUT of this set — `dialBaseFor` answers only for the core ones, so
   * the trace never claims an egress the plugin may not have taken.
   */
  private coreWires = new Set<WireKind>();
  private wireBases: Partial<Record<WireKind, string>>;

  constructor(config: ProviderConfig, wireBases: Partial<Record<WireKind, string>>) {
    this.name = config.name;
    this.wireBases = wireBases;
    for (const [wire, baseUrl] of Object.entries(wireBases) as [WireKind, string][]) {
      if (wire === 'unroutable' || wire === 'systemone') continue;
      const wireConfig: ProviderConfig = {
        ...config,
        type: wire,
        baseUrl,
      };
      if (wire === 'anthropic-messages') { this.execs.set(wire, new AnthropicMessagesProvider(wireConfig)); this.coreWires.add(wire); }
      else if (wire === 'google-gemini') { this.execs.set(wire, new GoogleGeminiProvider(wireConfig)); this.coreWires.add(wire); }
      else if (wire === 'openai-responses') { this.execs.set(wire, new OpenAIResponsesProvider(wireConfig)); this.coreWires.add(wire); }
      else if (wire === 'openai-chat') { this.execs.set(wire, new OpenAIChatProvider(wireConfig)); this.coreWires.add(wire); }
      else {
        // Plugin-owned wires are resolved through the host registry, never
        // through a name list here (a new plugin protocol needs no core edit).
        const plugin = getModelServicePlugin(wire);
        if (plugin) this.execs.set(wire, createPluginProvider(plugin, wireConfig));
        else if (!isPluginWire(wire)) {
          this.execs.set(wire, new OpenAIChatProvider(wireConfig));
          this.coreWires.add(wire);
        }
        // A plugin wire with no installed executor stays UNSET on purpose:
        // exec() then fails by wire id instead of routing the request to a
        // chat executor that would only produce an upstream 400.
      }
    }
  }

  /**
   * The per-wire base this dispatch dials for `model` — only for core wires.
   * `undefined` = plugin-owned (or unset) transport: egress unknown.
   */
  dialBaseFor(model: ModelRegistration): string | undefined {
    const wire = model.wire ?? 'openai-chat';
    if (!this.coreWires.has(wire)) return undefined;
    return this.wireBases[wire];
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
    sessionId?: string,
  ): Promise<CanonicalResponse> {
    return this.exec(model).createCompletion(request, model, upstreamEventContext, credential, sessionId);
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
    sessionId?: string,
  ): Promise<AsyncIterable<StreamEvent>> {
    const executor = this.exec(model);
    if (!executor.createStream) throw new Error(`Wire '${model.wire ?? 'openai-chat'}' has no native streaming executor`);
    return executor.createStream(request, model, upstreamEventContext, credential, sessionId);
  }
}
