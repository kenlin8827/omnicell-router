import type { ChatCompletionRequest } from '../types/openai.js';
import type { ExecutionResult } from '../types/router.js';
import { buildChatStreamChunks } from '../utils/chat-sse.js';
import type { ChatSurface, SurfaceParseResult } from './types.js';

/**
 * The OpenAI chat-completions surface (/v1/chat/completions).
 *
 * Every member below is the verbatim extraction of the old inline server.ts
 * handler — same message strings, same JSON key insertion order (wire bytes
 * depend on object literal order), same status→type mapping. Byte-identity
 * is the step-2 acceptance bar; the SSE generator itself is untouched per
 * contract §4 (generators stay as-is with their own DONE/frame sequence).
 */
export const chatSurface: ChatSurface = {
  wire: 'chat',
  exec: 'chat-pipeline',
  capture: true,
  routePath: '/v1/chat/completions',
  detectSuffix: '/v1/chat/completions',

  parse(body: unknown): SurfaceParseResult {
    const messages = (body as { messages?: unknown } | null | undefined)?.messages;
    if (!body || !Array.isArray(messages)) {
      return { error: 'Invalid request: "messages" array is required.' };
    }
    // `model` stays client-sent verbatim — the orchestrator's fork
    // (auto / auto-<tier> / concrete ids / variants / combos) owns resolution.
    return { request: body as ChatCompletionRequest };
  },

  encodeJson(result: ExecutionResult): unknown {
    return result.response;
  },

  encodeStream(result: ExecutionResult): string[] {
    // Plain `result.modelUsed` — today's handler passed exactly this to the
    // generator; the `modelUsed || gate || 'auto'` fallback is only for the
    // X-OCR-Model HEADER (ocr-headers.ts), never for chunk bodies.
    return [...buildChatStreamChunks(result.response, result.modelUsed), 'data: [DONE]\n\n'];
  },

  errorBody(status: number, message: string, code?: string): unknown {
    return chatErrorBody(status, message, code);
  },

  executionError(err: unknown): { status: number; body: unknown } {
    const e = err as { statusCode?: unknown; message?: string } | null | undefined;
    const statusCode = e?.statusCode;
    // Explicit 4xx/5xx from the orchestrator pass through; anything else (or
    // a non-integer / out-of-range statusCode) collapses to 500 — today's
    // mapping, restated with typeof because Number.isInteger is not a TS
    // type predicate (semantics unchanged: isInteger implies typeof number).
    const status =
      typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
        ? statusCode
        : 500;
    return { status, body: chatErrorBody(status, e?.message || 'Internal Router Error') };
  },
};

// One envelope for both error paths (parse-400 and execution catch) so they
// can never drift. `code` rides last, only when a caller provides it — the
// chat wire has never sent a code on these two shapes.
function chatErrorBody(status: number, message: string, code?: string): unknown {
  const error: Record<string, string> = {
    message,
    type: status >= 500 ? 'api_error' : 'invalid_request_error',
  };
  if (code !== undefined) error.code = code;
  return { error };
}
