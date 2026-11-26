import type { ChatCompletionRequest } from '../types/openai.js';
import type { ExecutionResult } from '../types/router.js';
import { normalizeLegacyChatRequest } from '../protocols/chat-compat.js';
import { chatRequestToIR, irToChatResponse } from '../ir/adapters/openai-chat.js';
import { canonicalResponseToEvents } from '../ir/stream.js';
import { ChatEventEncoder } from '../ir/adapters/openai-chat-stream.js';
import { IrUnsupportedError } from '../ir/errors.js';
import { buildChatOcrSummaryFrame } from './ocr-headers.js';
import type { ChatSurface, SurfaceParseResult } from './types.js';

interface ChatSurfaceState {
  encoder: ChatEventEncoder;
}

/** OpenAI Chat Completions is a protocol boundary, never the execution IR. */
export const chatSurface: ChatSurface = {
  wire: 'openai-chat',
  exec: 'chat-pipeline',
  capture: true,
  routePath: '/v1/chat/completions',
  detectSuffix: '/v1/chat/completions',

  parse(body: unknown): SurfaceParseResult {
    const messages = (body as { messages?: unknown } | null | undefined)?.messages;
    if (!body || !Array.isArray(messages)) {
      return { error: 'Invalid request: "messages" array is required.' };
    }
    try {
      const wire = normalizeLegacyChatRequest(body as ChatCompletionRequest);
      return { request: chatRequestToIR(wire), state: { encoder: new ChatEventEncoder({ deferUsage: true }) } };
    } catch (err) {
      return {
        error: (err as Error | undefined)?.message || 'Invalid request.',
        ...(err instanceof IrUnsupportedError ? { errorCode: 'unsupported_parameter' } : {}),
      };
    }
  },

  encodeJson(result: ExecutionResult): unknown {
    const response = result.response!;
    return irToChatResponse(response, response.id ?? `chatcmpl-${Date.now()}`, result.modelUsed);
  },

  encodeStream(result: ExecutionResult): string[] {
    const state: ChatSurfaceState = { encoder: new ChatEventEncoder({ deferUsage: true }) };
    const frames: string[] = [];
    for (const event of canonicalResponseToEvents(result.response!)) {
      const frame = chatSurface.encodeChunk!(event, {
        model: result.modelUsed,
        includeUsage: true,
        state,
      });
      if (frame !== null) frames.push(frame);
    }
    frames.push(...chatSurface.streamEnd!(result, state, {
      model: result.modelUsed, includeUsage: true, state,
    }));
    return frames;
  },

  streamEnd(result: ExecutionResult, state: unknown): string[] {
    const encoder = (state as ChatSurfaceState).encoder;
    return [
      ...encoder.finish(result.response!, result.modelUsed).map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
      buildChatOcrSummaryFrame(result),
      'data: [DONE]\n\n',
    ];
  },

  encodeChunk(event, ctx) {
    if (event.type === 'response.usage' && !ctx.includeUsage) return null;
    const state = ctx.state as ChatSurfaceState | undefined;
    const encoder = state?.encoder ?? new ChatEventEncoder();
    const chunk = encoder.encode(event, ctx.model);
    return chunk ? `data: ${JSON.stringify(chunk)}\n\n` : null;
  },

  /**
   * The chat encoder validates every canonical stream event up front
   * (`assertCanonicalStreamEventSupported`) and throws `IrUnsupportedError`
   * mid-turn for anything chat cannot represent — signed/encrypted reasoning
   * (`reasoning_signature`), structured reasoning summaries
   * (`reasoning_summary`), extra candidates, extension items, signed tool
   * calls. That is NOT one code: gating on `reasoning_signature` alone leaves
   * the same silent close (no `[DONE]`, no reason) for its siblings. Answer
   * in-band for every chat-side rejection; anything else keeps the bare close.
   */
  streamError(err): string | null {
    if (!(err instanceof IrUnsupportedError) || err.protocol !== 'openai-chat') return null;
    return `data: ${JSON.stringify(chatErrorBody(err.statusCode, err.message, 'unsupported_parameter'))}\n\n`;
  },

  errorBody(status: number, message: string, code?: string): unknown {
    return chatErrorBody(status, message, code);
  },

  executionError(err: unknown): { status: number; body: unknown } {
    const e = err as { statusCode?: unknown; message?: string; code?: string; name?: string } | null | undefined;
    const statusCode = e?.statusCode;
    const status =
      typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
        ? statusCode
        : 500;
    const code = e?.name === 'IrUnsupportedError' ? 'unsupported_parameter' : e?.code;
    return { status, body: chatErrorBody(status, e?.message || 'Internal Router Error', code) };
  },
};

function chatErrorBody(status: number, message: string, code?: string): unknown {
  const error: Record<string, string> = {
    message,
    type: status >= 500 ? 'api_error' : 'invalid_request_error',
  };
  if (code !== undefined) error.code = code;
  return { error };
}
