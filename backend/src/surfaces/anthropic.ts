import type { ExecutionResult } from '../types/router.js';
import {
  AnthropicMessagesEventEncoder,
  anthropicRequestToIR,
  canonicalToAnthropicResponse,
} from '../ir/adapters/anthropic-messages.js';
import { canonicalResponseToEvents } from '../ir/stream.js';
import { IrUnsupportedError } from '../ir/errors.js';
import type { StreamEvent } from '../ir/types.js';
import { buildChatOcrSummaryFrame } from './ocr-headers.js';
import type { ChatSurface, ChatChunkContext, SurfaceParseResult } from './types.js';

interface AnthropicSurfaceState {
  encoder: AnthropicMessagesEventEncoder;
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Anthropic Messages surface with direct IR JSON and event lifecycle codecs. */
export const anthropicSurface: ChatSurface = {
  wire: 'anthropic-messages',
  exec: 'chat-pipeline',
  capture: true,
  routePath: '/v1/messages',
  detectSuffix: '/v1/messages',

  parse(body: unknown): SurfaceParseResult {
    try {
      return { request: anthropicRequestToIR(body ?? {}), state: { encoder: new AnthropicMessagesEventEncoder() } };
    } catch (err) {
      return {
        error: (err as Error | undefined)?.message || 'Invalid request.',
        ...(err instanceof IrUnsupportedError ? { errorCode: 'unsupported_parameter' } : {}),
      };
    }
  },

  encodeJson(result: ExecutionResult): unknown {
    return canonicalToAnthropicResponse(result.response!, result.modelUsed);
  },

  encodeStream(result: ExecutionResult): string[] {
    const encoder = new AnthropicMessagesEventEncoder();
    const frames: string[] = [];
    for (const event of canonicalResponseToEvents(result.response!)) {
      for (const payload of encoder.encode(event, result.modelUsed, result.response)) frames.push(sse(payload));
    }
    // Mirror chat: buffered SSE (no relay) never calls streamEnd, so the
    // trailing observation comment has to ride encodeStream itself.
    frames.push(buildChatOcrSummaryFrame(result));
    return frames;
  },

  encodeChunk(event: StreamEvent, ctx: ChatChunkContext): string | null {
    const state = ctx.state as AnthropicSurfaceState | undefined;
    if (!state) return null;
    const payloads = state.encoder.encode(event, ctx.model);
    return payloads.length ? payloads.map(sse).join('') : null;
  },

  streamEnd(result: ExecutionResult, state: unknown): string[] {
    // Mirror Responses: if the live relay never saw a terminal IR event
    // (decoder/finish gap), synthesize completed/failed/incomplete so the
    // client still gets message_stop. A turn that already closed returns [].
    const frames: string[] = [];
    const encoder = (state as AnthropicSurfaceState | undefined)?.encoder;
    const response = result.response;
    if (encoder && response) {
      const event: StreamEvent = response.status === 'failed'
        ? { type: 'response.failed', reason: response.reason }
        : response.status === 'incomplete'
          ? { type: 'response.incomplete', reason: response.reason }
          : { type: 'response.completed' };
      for (const payload of encoder.encode(event, result.modelUsed, response)) frames.push(sse(payload));
    }
    // The comment follows the protocol terminator (message_stop or error).
    frames.push(buildChatOcrSummaryFrame(result));
    return frames;
  },

  errorBody(status: number, message: string, code?: string): unknown {
    return anthropicErrorBody(status, message, code);
  },

  executionError(err: unknown): { status: number; body: unknown } {
    const e = err as { statusCode?: unknown; message?: string; name?: string; code?: string } | null | undefined;
    const statusCode = e?.statusCode;
    const status =
      typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
        ? statusCode
        : 500;
    const code = e?.name === 'IrUnsupportedError' || e?.code === 'unsupported_parameter'
      ? 'unsupported_parameter'
      : undefined;
    return { status, body: anthropicErrorBody(status, e?.message || 'Internal Router Error', code) };
  },
};

function anthropicErrorBody(status: number, message: string, code?: string): unknown {
  return {
    type: 'error',
    error: {
      // Anthropic's own error-type table gives 413 a dedicated type
      // (`request_too_large`); folding it into `invalid_request_error` would
      // tell a Claude Code client to fix its request shape rather than its size.
      type: status >= 500 ? 'api_error' : status === 413 ? 'request_too_large' : 'invalid_request_error',
      message,
      ...(code ? { code } : {}),
    },
  };
}
