import type { ChatCompletionChunk, ChatCompletionResponse, ToolCall } from '../types/openai.js';
import type { ReasoningEffort } from '../types/router.js';

/**
 * Routing facts the execution layer hands the relay before the first chunk of
 * the attempt that proceeds. Field names mirror `ExecutionResult` so the
 * header builder consumes both shapes interchangeably; every one of them is
 * decidable BEFORE the upstream call (candidate, tier, layer, session, trace,
 * the client's thinking ask, the resolved variant).
 */
export interface StreamRoutingFacts {
  modelUsed?: string;
  tierUsed?: string;
  layerUsed?: 'layer0' | 'layer2';
  sessionId?: string;
  sessionRatchetApplied?: boolean;
  sessionLookupType?: string;
  traceId?: string;
  requestedEffort?: ReasoningEffort;
  variantUsed?: string;
}

/**
 * Client-facing relay for ONE upstream completion stream.
 *
 * Why this exists: the gateway used to execute every upstream call with
 * `stream:false`, buffer the whole JSON, then re-chunk it as SSE ("fake
 * streaming"). That made the client's time-to-first-byte equal to the FULL
 * generation time (measured 30-108 s on agent traffic), so a slow turn was
 * indistinguishable from a hung gateway. With a relay the upstream SSE body is
 * forwarded to the client as it arrives, while the same chunks are accumulated
 * into the buffered `ChatCompletionResponse` the post-turn accounting expects
 * (FinOps / rate-limit ledger / trace / session registration all keep reading a
 * complete response object — they are NOT streaming-aware).
 *
 * COMMIT POINT: `committed` flips to true the moment bytes reach the client.
 * Before it, a failure is an ordinary failover/retry candidate error (zero
 * bytes out, a clean JSON error is still possible). After it, the turn is
 * physically un-failover-able — re-issuing upstream would duplicate output the
 * client already consumed — so the candidate pool stops, and the pipeline closes
 * the SSE stream WITHOUT `[DONE]` (the standard "stream ended unexpectedly"
 * signal, no invented frame).
 *
 * Headers: the X-OCR block is normally written at `beginSse`, but the
 * completion-time facts (failover counts, latency, thinking-actual, breaker) do
 * not exist yet when the first byte must go out. So the execution layer stages
 * the routing facts (`stageRouting`) and the transport flushes only the
 * routing-derived headers with the first forwarded chunk; the completion facts
 * travel in a trailing SSE comment frame instead (see `buildOcrSummaryFrame`).
 */
export interface StreamRelay {
  /**
   * Called for the candidate attempt that is about to emit its first chunk.
   * Idempotent per attempt: a later candidate attempt (only reachable while
   * nothing is committed) overwrites the staged set.
   */
  stageRouting(facts: StreamRoutingFacts): void;
  /** One upstream chunk, in arrival order. Flushes headers on the first call. */
  onChunk(chunk: ChatCompletionChunk): void;
  /** True once any byte has reached the client — the no-failover boundary. */
  readonly committed: boolean;
}

/** Delta `tool_calls` fragment shape as it arrives on the wire (index-keyed). */
type ToolCallFragment = {
  index?: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
};

type MutableToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

/**
 * Accumulate an OpenAI `chat.completion.chunk` stream back into the buffered
 * `chat.completion` response shape — the object every post-turn consumer and the
 * non-streaming wire already depend on.
 *
 * The typed `delta` carries only role/content/tool_calls; upstreams (Qwen,
 * DeepSeek-R1, ...) additionally send `reasoning_content`. That field is NOT
 * folded into the assembled response: session fingerprinting, schema assertion
 * and FinOps never read it, and the gateway should not claim knowledge of
 * thinking text it did not verify end-to-end. The relay forwards those chunks
 * VERBATIM, so thinking still streams to the client — only the internal
 * accounting view stays content/tool-calls only.
 */
export function createChunkAccumulator(): {
  push: (chunk: ChatCompletionChunk) => void;
  finish: () => ChatCompletionResponse;
} {
  let id = '';
  let created = 0;
  let model = '';
  let systemFingerprint: string | undefined;
  let content = '';
  let contentSeen = false;
  let finishReason: ChatCompletionResponse['choices'][number]['finish_reason'] = null;
  let usage: ChatCompletionResponse['usage'];
  /** index -> accumulated call; the output array is ordered by that index. */
  const toolCalls = new Map<number, MutableToolCall>();

  return {
    push(chunk: ChatCompletionChunk): void {
      if (!id && chunk.id) id = chunk.id;
      if (!created && chunk.created) created = chunk.created;
      if (chunk.model) model = chunk.model;
      if (chunk.system_fingerprint) systemFingerprint = chunk.system_fingerprint;
      // The usage frame (stream_options.include_usage) carries no choices at all.
      if (chunk.usage) usage = chunk.usage;

      for (const choice of chunk.choices ?? []) {
        if (typeof choice.delta?.content === 'string') {
          contentSeen = true;
          content += choice.delta.content;
        }
        const fragments = choice.delta?.tool_calls as ToolCallFragment[] | undefined;
        if (Array.isArray(fragments)) {
          fragments.forEach((frag, pos) => {
            // OpenAI spec: fragments are keyed by `index`; some upstreams omit it
            // on the first fragment of a single call. Falling back to the array
            // position keeps a malformed-but-common stream usable instead of
            // merging every call into slot 0.
            const key = typeof frag.index === 'number' ? frag.index : pos;
            let acc = toolCalls.get(key);
            if (!acc) {
              acc = { id: '', type: 'function', function: { name: '', arguments: '' } };
              toolCalls.set(key, acc);
            }
            if (frag.id) acc.id = frag.id;
            if (frag.type) acc.type = frag.type;
            if (frag.function?.name) acc.function.name += frag.function.name;
            if (frag.function?.arguments) acc.function.arguments += frag.function.arguments;
          });
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    },

    finish(): ChatCompletionResponse {
      const calls: ToolCall[] = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v as ToolCall);
      const response: ChatCompletionResponse = {
        id: id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: created || Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              // A turn that produced only tool calls has `content: null` in the
              // buffered shape (what a non-streaming upstream returns), and both
              // session fingerprinting and schema assertion read exactly this
              // field — never substitute '' for an absent content.
              content: contentSeen ? content : null,
              ...(calls.length ? { tool_calls: calls } : {}),
            },
            finish_reason: calls.length ? 'tool_calls' : finishReason ?? 'stop',
          },
        ],
      };
      if (usage) response.usage = usage;
      if (systemFingerprint) response.system_fingerprint = systemFingerprint;
      return response;
    },
  };
}
