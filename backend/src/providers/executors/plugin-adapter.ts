import type { ModelServicePlugin } from '../../plugins/types.js';
import type { ProviderConfig } from '../../config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../ir/types.js';
import { chatResponseToIR, irToChatRequest } from '../../ir/adapters/openai-chat.js';
import { ChatStreamDecoder } from '../../ir/adapters/openai-chat-stream.js';
import type { LLMProvider, UpstreamEventContext, CallCredential } from '../base.js';
import type { ModelRegistration } from '../../config/types.js';

/**
 * Versioned model-service plugins expose Chat as their EXTERNAL contract.
 * This is the only core-owned Chat bridge on a non-Chat wire; orchestration and
 * every built-in provider remain canonical throughout.
 */
export function createPluginProvider(
  plugin: ModelServicePlugin,
  config: ProviderConfig,
): LLMProvider {
  const provider = plugin.createProvider(config);
  return {
    name: provider.name,
    supportsStreaming: () => typeof provider.createStream === 'function',
    async createCompletion(
      request: CanonicalRequest,
      model: ModelRegistration,
      upstreamEventContext?: UpstreamEventContext,
      credential?: CallCredential,
    ): Promise<CanonicalResponse> {
      const response = await provider.createCompletion(
        irToChatRequest(request, model.upstreamModel, { carrierExtensions: false }),
        model,
        upstreamEventContext,
        credential,
      );
      return chatResponseToIR(response);
    },
    async createStream(
      request: CanonicalRequest,
      model: ModelRegistration,
      upstreamEventContext?: UpstreamEventContext,
      credential?: CallCredential,
    ): Promise<AsyncIterable<StreamEvent>> {
      if (!provider.createStream) throw new Error(`Plugin provider '${provider.name}' has no stream executor`);
      const stream = await provider.createStream(
        irToChatRequest(request, model.upstreamModel, { carrierExtensions: false }),
        model,
        upstreamEventContext,
        credential,
      );
      return {
        async *[Symbol.asyncIterator]() {
          const decoder = new ChatStreamDecoder();
          for await (const chunk of stream) yield* decoder.push(chunk);
          yield* decoder.finish();
        },
      };
    },
  };
}
