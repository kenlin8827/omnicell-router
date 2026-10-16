import { ChatCompletionChunk, ChatCompletionResponse } from '../types/openai.js';

/**
 * OpenAI `chat.completion.chunk` helpers for the client-facing SSE wire.
 *
 * Two shapes of streaming coexist by design:
 *  - buffered re-chunking (`buildChatStreamChunks`) — used when the upstream leg
 *    was executed non-streaming: a wire with no streaming executor
 *    (anthropic/google/responses), the schema-assertion cascade (whose verdict
 *    needs the full content before any byte may go out), and mock mode.
 *  - pass-through forwarding (`formatChatChunkForClient`) — the upstream SSE
 *    body relayed frame by frame as it arrives, so the client's
 *    time-to-first-byte is the upstream's, not the whole generation's.
 */
/**
 * Forward one upstream chunk on the client wire, or drop it.
 *
 * The gateway is a transparent proxy on the streaming leg: every field the
 * upstream put in the frame rides through untouched — including
 * `reasoning_content`, which the buffered re-chunker now emits the same way.
 * `model` is the one rewrite: the upstream names its own deployment, the client
 * must keep seeing the gateway's served id, exactly as the buffered path labels
 * every chunk.
 *
 * `usage` frames are dropped unless the client asked for them via
 * `stream_options.include_usage`. The gateway always requests usage upstream
 * (FinOps needs it), so forwarding unconditionally would hand strict clients a
 * frame shape they did not ask for.
 */
export function formatChatChunkForClient(
  chunk: ChatCompletionChunk,
  servedModel: string,
  includeUsageRequested: boolean
): string | null {
  if (chunk.usage && (!chunk.choices || chunk.choices.length === 0) && !includeUsageRequested) return null;
  return `data: ${JSON.stringify({ ...chunk, model: servedModel })}\n\n`;
}

/**
 * Trailing SSE comment frame carrying the completion-time X-OCR facts of a
 * streamed turn (failover counts, retries, breaker, latency, thinking actual).
 * Comment lines are ignored by conformant SSE parsers, so strict clients see the
 * ordinary frame sequence while tooling can still read the summary. Emitted
 * BEFORE `data: [DONE]` — most parsers stop reading at `[DONE]`.
 */
export function buildOcrSummaryFrame(facts: Record<string, string>): string {
  return `: ocr-summary ${JSON.stringify(facts)}\n\n`;
}

/**
 * Synthesize the frame sequence for ONE buffered completion. Emits: role chunk →
 * content deltas → tool_call fragments → final chunk with the REAL
 * finish_reason (+ usage). Tool fragments follow the OpenAI streaming spec
 * (first fragment carries index/id/type/name, then argument chunks). A
 * hardcoded finish_reason 'stop' would silently break streaming tool-loop
 * clients — the real reason must ride the final chunk.
 */
export function buildChatStreamChunks(response: ChatCompletionResponse, model: string): string[] {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const id = response.id || `chatcmpl-${Date.now()}`;
  const created = response.created || Math.floor(Date.now() / 1000);
  const chunks: string[] = [];
  const push = (delta: Record<string, any>, finishReason: string | null, withUsage = false) => {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (withUsage) chunk.usage = response.usage;
    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  push({ role: 'assistant', content: '' }, null);

  const chunkSize = 4;
  // Thinking text rides the wire when the upstream produced it. The streamed leg
  // forwards it frame by frame; dropping it HERE would make the same model
  // answer differently depending on which leg carried it — the client would pay
  // for reasoning it never saw. Field name follows the OpenAI-compatible
  // interleaved convention the catalog declares (`interleaved.field`).
  const reasoning = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
  if (typeof reasoning === 'string') {
    for (let i = 0; i < reasoning.length; i += chunkSize) {
      push({ reasoning_content: reasoning.slice(i, i + chunkSize) }, null);
    }
  }

  const text = typeof message?.content === 'string' ? message.content : '';
  for (let i = 0; i < text.length; i += chunkSize) {
    push({ content: text.slice(i, i + chunkSize) }, null);
  }

  const toolCalls = message?.tool_calls || [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    push(
      { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] },
      null
    );
    const args = tc.function.arguments || '';
    const argChunk = 32;
    for (let j = 0; j < args.length; j += argChunk) {
      push({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + argChunk) } }] }, null);
    }
  }

  const finishReason = toolCalls.length ? 'tool_calls' : (choice?.finish_reason as string) || 'stop';
  push({}, finishReason, true);
  return chunks;
}
