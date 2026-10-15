import { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import { ModelRegistration } from '../config/types.js';
import type { UpstreamEventContext } from '../observability/upstream-events.js';
import type { CallCredential } from '../opencode/credentials/types.js';

export type { CallCredential };

/**
 * Single source of truth lives in observability/upstream-events.ts — the
 * orchestrator fills the context once per inference turn and the adapter
 * uses it to emit the two UPSTREAM events (request before fetch, response
 * after `await res.text()`). The two CLIENT events are the orchestrator /
 * Fastify hook's responsibility, not the provider's.
 */
export type { UpstreamEventContext };

export interface LLMProvider {
  name: string;
  createCompletion(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    /**
     * Event-stream upstream context: provider emits a req event right
     * before fetch and a resp event right after `await res.text()` — each is
     * a separate JSONL line, independent of the inference result. Optional
     * so providers remain usable without a capture pipeline (mock mode,
     * unit tests).
     */
    upstreamEventContext?: UpstreamEventContext,
    /**
     * Per-call credential. When present the executor
     * authenticates with `credential.key` INSTEAD of the boot-baked
     * `config.apiKey`; when absent the baked key is used (100% backward
     * compatible — the registry only passes this for explicitly selected
     * accounts, and the no-selector default stays `undefined`).
     */
    credential?: CallCredential
  ): Promise<ChatCompletionResponse>;

  createStream?(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    credential?: CallCredential
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
}