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

  /**
   * Streaming capability probe for the relay path — answered BEFORE any fetch,
   * so a wire that cannot stream simply never enters the streaming branch
   * instead of surfacing a "not supported" error mid-request. Optional: an
   * executor without it is probed by whether `createStream` exists.
   */
  supportsStreaming?(model: ModelRegistration): boolean;

  /**
   * Native streaming execution: yields `chat.completion.chunk` frames as the
   * upstream SSE body arrives. Optional — a wire whose upstream has no
   * streaming support simply does not implement it, and the caller falls back
   * to `createCompletion` (that fallback is only legal while NOTHING has been
   * written to the client, which the StreamRelay's commit point guarantees).
   *
   * Same event/capture discipline as `createCompletion`: request event before
   * the fetch, a response (or failure) event carrying the raw SSE body once the
   * stream is consumed, and an `UpstreamError` on a non-2xx head so the
   * classifier keeps its status / retry-after / credential attribution.
   */
  createStream?(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
}