import { ChatCompletionChunk } from '../types/openai.js';

/** OpenAI `chat.completion.chunk` helpers for the client-facing SSE wire. */
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
