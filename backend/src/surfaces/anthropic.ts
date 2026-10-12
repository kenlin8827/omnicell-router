import { anthropicToOpenAI, chatToAnthropicStreamEvents, openAIToAnthropic } from '../routes/anthropic.js';
import type { ExecutionResult } from '../types/router.js';
import type { ChatSurface, SurfaceParseResult } from './types.js';

/**
 * The Anthropic Messages surface (/v1/messages), wire 'anthropic'.
 *
 * Verbatim extraction of the old inline /v1/messages route handler: same 400
 * message texts, same {type:'error', error:{type, message}} envelope with its
 * key insertion order (wire bytes depend on object literal order), same
 * [400,600)→pass-through status mapping. The wire converters stay in
 * routes/anthropic.ts — the MITM interceptor and the wire tests import them
 * from there (contract step 3a).
 *
 * Stream-branch note: the old handler branched on `request.stream` TRUTHINESS;
 * the shared pipeline gates on `=== true` (approved C-3 convergence, same as
 * the chat leg in step 2). Anthropic clients send boolean `stream: true`, so
 * only a non-boolean truthy value changes path — it now takes the JSON leg.
 */
export const anthropicSurface: ChatSurface = {
  wire: 'anthropic',
  exec: 'chat-pipeline',
  capture: true,
  routePath: '/v1/messages',
  detectSuffix: '/v1/messages',

  parse(body: unknown): SurfaceParseResult {
    // Today's handler entry: `body || {}` fed to the converter, same fallback
    // text on the (unreachable-in-practice) error-less rejection. The
    // converter normalizes model to trim()||'auto' — gateModel in the
    // pipeline re-trims, which is idempotent, so the 403 gate sees exactly
    // today's value.
    const { request, error } = anthropicToOpenAI((body || {}) as Parameters<typeof anthropicToOpenAI>[0]);
    if (!request || error) {
      return { error: error || 'Invalid request.' };
    }
    // No per-request state: today's SSE/JSON encoding used result.modelUsed
    // only (the dead `const id` local is dropped per R-7).
    return { request };
  },

  encodeJson(result: ExecutionResult): unknown {
    return openAIToAnthropic(result.response, result.modelUsed);
  },

  encodeStream(result: ExecutionResult): string[] {
    // The generator ends the sequence with message_stop — the Anthropic wire
    // has no [DONE] sentinel and today's stream block wrote none (contract §4:
    // generators stay as-is with their own DONE/frame sequence).
    return chatToAnthropicStreamEvents(result.response, result.modelUsed);
  },

  errorBody(status: number, message: string): unknown {
    return anthropicErrorBody(status, message);
  },

  executionError(err: unknown): { status: number; body: unknown } {
    const e = err as { statusCode?: unknown; message?: string } | null | undefined;
    const statusCode = e?.statusCode;
    // Today's catch: explicit integer 4xx/5xx pass through, anything else
    // (including out-of-range) collapses to 500.
    const status =
      typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
        ? statusCode
        : 500;
    return { status, body: anthropicErrorBody(status, e?.message || 'Internal Router Error') };
  },
};

// One envelope for both error paths so they can never drift. The interface's
// `code` slot is deliberately absent: Anthropic's error object is
// {type, message}, and today's handler sent no code on either path (the 403
// gate keeps its OpenAI-shaped envelope because the SHARED guard writes it —
// preserved, not "fixed", per contract §4).
function anthropicErrorBody(status: number, message: string): unknown {
  return {
    type: 'error',
    error: {
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
      message,
    },
  };
}
