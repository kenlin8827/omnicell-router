import path from 'node:path';
import type { ExecutionResult } from '../types/router.js';
import type { CanonicalRequest, InputItem, StreamEvent } from '../ir/types.js';
import { responsesRequestToIR, responsesToolToWire } from '../ir/adapters/openai-responses.js';
import {
  OpenAIResponsesEventEncoder,
  canonicalToResponsesObject,
  newResponseMessageId,
  newResponseStreamSequence,
  responsesEventFrame,
  type ResponsesEcho,
} from '../ir/adapters/openai-responses-output.js';
import { canonicalResponseToEvents } from '../ir/stream.js';
import { IrUnsupportedError } from '../ir/errors.js';
import { loadConfig } from '../config/index.js';
import { getEnvPaths } from '../config/env.js';
import { RespStore, newResponseId, type RespNode } from '../session/resp-store.js';
import { WarnThrottle } from '../observability/warn-throttle.js';
import { buildChatOcrSummaryFrame } from './ocr-headers.js';
import type { ChatSurface, ChatChunkContext, SurfaceParseResult } from './types.js';

const respStore = new RespStore();
let storeConfigured = false;
let persistActive = false;
let surfaceWarns = new WarnThrottle();

function ensureStoreConfigured(): void {
  if (storeConfigured) return;
  storeConfigured = true;
  let wantPersist = false;
  try {
    wantPersist = loadConfig().responses?.persist === true;
  } catch (err) {
    surfaceWarns.warn('resp-store-config-unreadable',
      `[responses] config unreadable (${(err as Error).message}) — responses chain defaults to memory-only.`);
  }
  if (!wantPersist) return;
  persistActive = true;
  try {
    const stats = respStore.enablePersistence({
      filePath: path.join(getEnvPaths().dataDir, 'responses-chain.jsonl'),
    });
    console.log(
      `[responses] recovery log active: replayed ${stats.loaded} nodes ` +
        `(${stats.expired} expired, ${stats.malformed} malformed skipped) from responses-chain.jsonl.`
    );
  } catch (err) {
    console.warn(
      `[responses] recovery log failed to initialize (${(err as Error).message}) — continuing memory-only.`
    );
  }
}

export function __resetResponsesSurfaceForTests(): void {
  storeConfigured = false;
  persistActive = false;
  surfaceWarns = new WarnThrottle();
  respStore.clear();
}

/**
 * Console session delete cascade: drop the session's `previous_response_id`
 * nodes (memory + recovery log). `ensureStoreConfigured` runs first so a
 * `responses.persist: true` deployment rewrites the JSONL instead of leaving
 * the purged turns on disk for the next boot to replay. Returns the number of
 * nodes removed; a live chain degrades fail-visible (400 full-resend), which
 * is the documented posture for a missing parent.
 */
export function purgeResponseChainForSession(sessionId: string): number {
  ensureStoreConfigured();
  return respStore.deleteBySession(sessionId);
}

interface ResponsesState {
  delta: InputItem[];
  sessionIdBind: string | undefined;
  parent: string | null;
  respId: string;
  messageId: string;
  store: boolean;
  echo: ResponsesEcho;
  encoder: OpenAIResponsesEventEncoder;
}

const PREVIOUS_NOT_FOUND_PREFIX = 'Unknown previous_response_id "';

function previousNotFoundMessage(id: string): string {
  return `${PREVIOUS_NOT_FOUND_PREFIX}${id}" (expired, evicted, or from before a gateway restart). Resend the full conversation input.`;
}

function gatewayUnsupported(body: Record<string, any>): string | null {
  if (body.conversation !== undefined && body.conversation !== null) {
    return 'Unsupported parameter: "conversation" — the Conversations API is not implemented by this gateway; send the full conversation "input" on every turn and omit "conversation".';
  }
  if (body.background === true) {
    return 'Unsupported parameter: "background" — this gateway has no asynchronous execution or polling endpoint; omit "background".';
  }
  if (body.truncation === 'auto') {
    return 'Unsupported parameter: "truncation" — automatic context trimming is not implemented; shorten the input or send "truncation": "disabled".';
  }
  return null;
}

function echoOf(request: CanonicalRequest, raw: Record<string, any>): ResponsesEcho {
  return {
    instructions: request.instructions ?? null,
    metadata: request.metadata ?? null,
    temperature: request.generation?.temperature ?? null,
    top_p: request.generation?.topP ?? null,
    max_output_tokens: request.generation?.maxOutputTokens ?? null,
    tool_choice: raw.tool_choice ?? 'auto',
    parallel_tool_calls: request.parallelToolCalls ?? true,
    previous_response_id: request.previousResponseId ?? null,
    service_tier: request.serviceTier ?? null,
    tools: request.tools?.map(responsesToolToWire) ?? [],
    text: raw.text ?? { format: { type: 'text' } },
    reasoning: raw.reasoning ?? null,
    truncation: raw.truncation ?? 'disabled',
    background: raw.background ?? false,
    include: request.include ?? [],
    prompt: raw.prompt ?? null,
    conversation: raw.conversation ?? null,
    safety_identifier: request.safetyIdentifier ?? null,
  };
}

export const responsesSurface: ChatSurface = {
  wire: 'openai-responses',
  exec: 'chat-pipeline',
  capture: true,
  routePath: '/v1/responses',
  detectSuffix: '/v1/responses',

  parse(body: unknown): SurfaceParseResult {
    ensureStoreConfigured();
    const raw = (body ?? {}) as Record<string, any>;
    const unsupported = gatewayUnsupported(raw);
    if (unsupported) return { error: unsupported, errorCode: 'unsupported_parameter' };
    let parsed: CanonicalRequest;
    try {
      parsed = responsesRequestToIR(raw);
    } catch (err) {
      return {
        error: (err as Error | undefined)?.message || 'Invalid input items.',
        ...(err instanceof IrUnsupportedError ? { errorCode: 'unsupported_parameter' } : {}),
      };
    }
    const delta = parsed.input;
    let input = delta;
    let sessionIdBind: string | undefined;
    if (parsed.previousResponseId) {
      if (!persistActive) {
        surfaceWarns.warn('resp-chain-not-persisted',
          '[responses] previous_response_id in use but responses.persist=false — the conversation chain ' +
            'is memory-only and a gateway restart will break continuation (clients then must resend the ' +
            'full input). Set responses.persist: true in config.yaml to survive restarts.');
      }
      const built = respStore.buildInput(parsed.previousResponseId);
      if (!built) return { error: previousNotFoundMessage(parsed.previousResponseId) };
      input = [...built.input, ...delta];
      sessionIdBind = built.sessionId;
    }
    const request: CanonicalRequest = { ...parsed, input };
    // These controls describe the gateway-owned emulation, not an upstream call.
    delete request.store;
    delete request.previousResponseId;
    delete request.background;
    delete request.truncation;
    if (sessionIdBind) request.routerOptions = { ...request.routerOptions, sessionId: sessionIdBind };

    const respId = newResponseId();
    const messageId = newResponseMessageId();
    const store = raw.store !== false;
    const echo = echoOf(parsed, raw);
    const seq = newResponseStreamSequence();
    return {
      request,
      state: {
        delta, sessionIdBind, parent: parsed.previousResponseId ?? null,
        respId, messageId, store, echo,
        encoder: new OpenAIResponsesEventEncoder(respId, messageId, seq, store, echo),
      } satisfies ResponsesState,
    };
  },

  afterResult(result: ExecutionResult, state: unknown): void {
    const s = state as ResponsesState;
    const node: RespNode = {
      v: 2,
      id: s.respId,
      parent: s.parent,
      sessionId: result.sessionId || s.sessionIdBind || '',
      model: result.modelUsed,
      input: s.delta,
      output: result.response?.output ?? [],
      createdAt: Date.now(),
    };
    if (s.store) respStore.append(node);
  },

  encodeJson(result: ExecutionResult, state: unknown): unknown {
    const s = state as ResponsesState;
    return canonicalToResponsesObject(result.response!, {
      respId: s.respId, messageId: s.messageId,
    }, result.modelUsed, s.store, s.echo);
  },

  encodeStream(result: ExecutionResult, state: unknown): string[] {
    const s = state as ResponsesState;
    const frames: string[] = [];
    for (const event of canonicalResponseToEvents(result.response!)) {
      for (const payload of s.encoder.encode(event, result.modelUsed, result.response)) {
        frames.push(responsesEventFrame(payload));
      }
    }
    // Mirror chat: buffered SSE (no relay) never calls streamEnd, so the
    // trailing observation comment has to ride encodeStream itself.
    frames.push(buildChatOcrSummaryFrame(result));
    return frames;
  },

  // Relay capability marker required by runChatSurface when afterResult is
  // defined; response.created / response.in_progress frames are emitted by
  // OpenAIResponsesEventEncoder upon receiving the initial IR event.
  streamStart(): string[] {
    return [];
  },

  encodeChunk(event: StreamEvent, ctx: ChatChunkContext): string | null {
    const s = ctx.state as ResponsesState | undefined;
    if (!s) return null;
    const payloads = s.encoder.encode(event, ctx.model);
    return payloads.length ? payloads.map(responsesEventFrame).join('') : null;
  },

  streamEnd(result: ExecutionResult, state: unknown): string[] {
    const s = state as ResponsesState;
    const response = result.response!;
    const event: StreamEvent = response.status === 'failed'
      ? { type: 'response.failed', reason: response.reason }
      : response.status === 'incomplete'
        ? { type: 'response.incomplete', reason: response.reason }
        : { type: 'response.completed' };
    return [
      ...s.encoder.encode(event, result.modelUsed, response).map(responsesEventFrame),
      buildChatOcrSummaryFrame(result),
    ];
  },

  errorBody(_status: number, message: string, code?: string): unknown {
    const resolved = code ?? (message.startsWith(PREVIOUS_NOT_FOUND_PREFIX) ? 'previous_response_not_found' : undefined);
    return { error: { message, type: 'invalid_request_error', code: resolved } };
  },

  executionError(err: unknown): { status: number; body: unknown } {
    const e = err as { statusCode?: unknown; message?: string; name?: string } | null | undefined;
    const statusCode = e?.statusCode;
    if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
      return {
        status: statusCode,
        body: {
          error: {
            message: e?.message || 'Bad request.',
            type: 'invalid_request_error',
            code: e?.name === 'IrUnsupportedError' ? 'unsupported_parameter' : 'invalid_request_error',
          },
        },
      };
    }
    return {
      status: 502,
      body: {
        error: {
          message: e?.message || 'Upstream execution failed.',
          type: 'invalid_request_error',
          code: 'upstream_error',
        },
      },
    };
  },
};
