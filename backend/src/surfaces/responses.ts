import path from 'node:path';
import {
  chatToResponseObject,
  chatToStreamEvents,
  inputItemsToMessages,
  responsesDeltaFrame,
  responsesStreamPrefix,
  responsesStreamSuffix,
  responsesToolsToChat,
  responsesToolChoiceToChat,
  newResponseMessageId,
  newResponseStreamSequence,
  type ResponsesRequest,
  type ResponsesStreamSequence,
  unsupportedResponsesParameter,
} from '../routes/responses.js';
import { repairToolCallPairing } from '../pipeline/tool-pairing.js';
import type { ChatCompletionChunk, ChatCompletionRequest, ChatMessage } from '../types/openai.js';
import type { ExecutionResult } from '../types/router.js';
import { loadConfig } from '../config/index.js';
import { getEnvPaths } from '../config/env.js';
import { ChatMessageLite, RespNode, RespStore, newResponseId } from '../session/resp-store.js';
import { WarnThrottle } from '../observability/warn-throttle.js';
import type { ChatSurface, SurfaceParseResult } from './types.js';

/**
 * The OpenAI Responses surface (/v1/responses), wire 'responses'.
 *
 * Verbatim extraction of the old inline /v1/responses route handler (frozen
 * contract step 3b): same validation texts and same envelope key insertion
 * order (wire bytes depend on object literal order). Retention follows the
 * client's `store` flag — the state block below owns that rule. The
 * converters stay in routes/responses.ts — the MITM interceptor and the
 * wire tests import them from there.
 *
 * Stateful mode (previous_response_id) uses ONE module-level RespStore: the
 * old handler owned a per-registration instance; the shared singleton is the
 * frozen step-3b decision (R-6 — the bounded FIFO/age sweep inside RespStore
 * is unchanged, and cross-leg Fastify↔MITM visibility is intended stateful
 * behavior — both legs now route the responses wire through this surface).
 *
 * Persistence: the singleton optionally mirrors to an
 * on-disk recovery log (`responses.persist`, default OFF → byte-identical
 * in-memory posture). Configuration is read lazily on the first parse of the
 * process (env switch = restart, so boot-time freshness is guaranteed); when
 * a client starts relying on the chain while persistence is off, one warn
 * per process points at the switch.
 */

// Single store for every consumer in-process: parse reads it (buildMessages),
// afterResult writes it (append). Tests construct their own RespStore
// instances directly (session/resp-store.js), so nothing imports this one.
const respStore = new RespStore();

let storeConfigured = false;
let persistActive = false;
let surfaceWarns = new WarnThrottle();

/**
 * One-shot lazy wiring: read `responses.persist`, and when on, replay the
 * recovery log BEFORE any parse can resolve a previous_response_id.
 * Everything off the happy path degrades to memory-only with a loud warn —
 * the log is a restart-survival optimization, never a request dependency.
 */
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

/** Test seam (precedent: env.__resetEnvResolutionForTests): redo lazy wiring + warn dedup. */
export function __resetResponsesSurfaceForTests(): void {
  storeConfigured = false;
  persistActive = false;
  surfaceWarns = new WarnThrottle();
  respStore.clear();
}

/**
 * Per-request state, opaque through SurfaceParseResult.state. Beyond the
 * contract-named trio {delta, sessionIdBind, respId} it carries `parent` (the
 * RespNode written in afterResult must record previous_response_id) and
 * `messageId`.
 *
 * Both ids are minted AT PARSE TIME, not in afterResult: on a relayed stream
 * the `response.created` / `output_item.added` frames flush with the first
 * upstream chunk, long before the turn produces a result. `afterResult` only
 * persists the node, so the chain resolves once the turn closes.
 *
 * `seq` is the SSE `sequence_number` counter shared by the prefix, every live
 * delta and the closing frames — strict clients require it on EVERY event.
 *
 * `store` is the client's EFFECTIVE retention flag (default true, OpenAI
 * parity): `afterResult` appends the node only when it is set, so a
 * `store:false` response is never a chain parent — exactly the upstream rule
 * that makes `previous_response_id` unusable without server-side state.
 */
interface ResponsesState {
  delta: ChatMessage[];
  sessionIdBind: string | undefined;
  parent: string | null;
  respId: string;
  messageId: string;
  seq: ResponsesStreamSequence;
  store: boolean;
}

// The wire's only code-bearing parse-400 — single emitter for the text and
// for the prefix errorBody() matches on (see errorBody for why matching is
// needed at all).
const PREVIOUS_NOT_FOUND_PREFIX = 'Unknown previous_response_id "';

function previousNotFoundMessage(id: string): string {
  return `${PREVIOUS_NOT_FOUND_PREFIX}${id}" (expired, evicted, or from before a gateway restart). Resend the full conversation input.`;
}

export const responsesSurface: ChatSurface = {
  wire: 'responses',
  exec: 'chat-pipeline',
  capture: true,
  routePath: '/v1/responses',
  detectSuffix: '/v1/responses',

  parse(body: unknown): SurfaceParseResult {
    ensureStoreConfigured();
    const req = body as ResponsesRequest | undefined | null;

    if (!req || req.input === undefined || req.input === null) {
      return { error: 'Invalid request: "input" is required.' };
    }

    // Unsupported-but-load-bearing parameters fail here, before any state is
    // touched: a standard client cannot detect a silently ignored parameter,
    // and `conversation` in particular would make it believe a session
    // continued while every turn starts blank.
    const unsupported = unsupportedResponsesParameter(req);
    if (unsupported) {
      return { error: unsupported, errorCode: 'unsupported_parameter' };
    }

    // This turn's NEW messages only (never includes rebuilt history — the
    // parent chain in the store already holds it).
    let delta: ChatMessage[];
    try {
      delta = inputItemsToMessages(req.input);
    } catch (e) {
      return { error: (e as Error | undefined)?.message || 'Invalid input items.' };
    }
    if (delta.length === 0) {
      return { error: 'Invalid request: "input" resolved to an empty message list.' };
    }

    // Full request messages = [instructions?] + [rebuilt history?] + delta.
    // `instructions` is request-scoped (like a system prompt for THIS turn),
    // so it is prepended at send time and never baked into stored deltas.
    let messages: ChatMessage[];
    let sessionIdBind: string | undefined;
    if (req.previous_response_id) {
      // Live client proven to rely on gateway-held state while persist=off:
      // one warn per process pointing at the exact switch (warn-once = the
      // dedup-by-key semantics of WarnThrottle over a constant key).
      if (!persistActive) {
        surfaceWarns.warn('resp-chain-not-persisted',
          '[responses] previous_response_id in use but responses.persist=false — the conversation chain ' +
            'is memory-only and a gateway restart will break continuation (clients then must resend the ' +
            'full input). Set responses.persist: true in config.yaml to survive restarts.');
      }
      const built = respStore.buildMessages(req.previous_response_id);
      if (!built) {
        // Fail-visible: never silently open a new session.
        return { error: previousNotFoundMessage(req.previous_response_id) };
      }
      messages = [...built.messages, ...delta];
      if (req.instructions?.trim()) {
        messages = [{ role: 'system', content: req.instructions }, ...messages];
      }
      sessionIdBind = built.sessionId;
    } else {
      messages = [...delta];
      if (req.instructions?.trim()) {
        messages = [{ role: 'system', content: req.instructions }, ...messages];
      }
    }
    // A cancelled/abandoned call can leave an assistant turn whose calls the
    // next wire item never answers (a plain user message is legal on the
    // Responses wire, not on chat-completions). Close them here, after the
    // rebuilt chain and this turn's delta are one list — the surface's own
    // contract is that the request it hands downstream is a valid chat chain.
    // The orchestrator normalizes again as the final gate for every wire
    // (same idempotent function; a repaired chain costs one pass).
    messages = repairToolCallPairing(messages).messages;

    const request: ChatCompletionRequest = {
      model: req.model?.trim() || 'auto',
      messages,
    };
    if (req.temperature !== undefined) request.temperature = req.temperature;
    if (req.top_p !== undefined) request.top_p = req.top_p;
    if (req.max_output_tokens !== undefined) request.max_tokens = req.max_output_tokens;
    if (req.tools !== undefined && !Array.isArray(req.tools)) {
      return { error: 'Invalid request: "tools" must be an array.' };
    }
    if (req.tools?.length) request.tools = responsesToolsToChat(req.tools as unknown[]);
    if (req.tool_choice !== undefined && req.tool_choice !== null) {
      request.tool_choice = responsesToolChoiceToChat(req.tool_choice);
    }
    if (req.reasoning?.effort) request.reasoning_effort = req.reasoning.effort;
    // Responses-native reasoning.max_tokens maps to router's max_thinking_tokens,
    // which provider payload builders translate per-upstream (see anthropic.ts,
    // google.ts, responses.ts buildResponsesPayload).
    if (req.reasoning?.max_tokens != null) request.max_thinking_tokens = req.reasoning.max_tokens;
    if (req.user) request.user = req.user;
    // Exact session binding for stateful turns: the parent node remembers the
    // routing session; router_options.session_id resolves via the explicit
    // layer — zero ambiguity, no content heuristics involved.
    if (sessionIdBind) request.router_options = { ...request.router_options, session_id: sessionIdBind };
    // Frozen C-3 normalization, done inside parse: typed boolean only. The old
    // handler branched on `body.stream` truthiness and never set the field;
    // provider builders force upstream stream:false regardless, so this only
    // selects this surface's own terminal-send branch (pipeline `=== true`).
    request.stream = req.stream === true;

    return {
      request,
      state: {
        delta,
        sessionIdBind,
        parent: req.previous_response_id || null,
        respId: newResponseId(),
        messageId: newResponseMessageId(),
        seq: newResponseStreamSequence(),
        // OpenAI parity: `store` defaults to true when the client omits it.
        store: req.store !== false,
      },
    };
  },

  afterResult(result: ExecutionResult, state: unknown): void {
    const s = state as ResponsesState;
    // `s.respId` was minted by parse so the opening frames of a relayed turn
    // could carry it. Persist the node before the terminal send on the
    // buffered leg, or before the closing frames on the relayed leg.
    //
    // `store:false` = "do not retain this response" (OpenAI parity): no node,
    // so a later `previous_response_id` naming it resolves to nothing and the
    // client gets the documented resend-full-input 400. Capture is a
    // DIFFERENT, operator-controlled plane — it is not the protocol store.
    const assistant = result.response?.choices[0]?.message;
    const node: RespNode = {
      id: s.respId,
      parent: s.parent,
      sessionId: result.sessionId || s.sessionIdBind || '',
      model: result.modelUsed,
      input: s.delta as ChatMessageLite[],
      assistant: {
        role: 'assistant',
        content: typeof assistant?.content === 'string' ? assistant.content : '',
        tool_calls: assistant?.tool_calls,
        reasoning_content: assistant?.reasoning_content,
      },
      createdAt: Date.now(),
    };
    if (s.store) respStore.append(node);
  },

  encodeJson(result: ExecutionResult, state: unknown): unknown {
    const s = state as ResponsesState;
    return chatToResponseObject(result.response!, s.respId, result.modelUsed, s.messageId, s.store);
  },

  encodeStream(result: ExecutionResult, state: unknown): string[] {
    const s = state as ResponsesState;
    // Buffered leg: the full synthesized sequence, carrying the same ids the
    // relayed leg used in its prefix.
    return chatToStreamEvents(result.response!, s.respId, result.modelUsed, s.messageId, s.seq, s.store);
  },

  // ---- Relayed leg: one upstream chunk -> one `response.output_text.delta`.
  // Without these three hooks the responses wire is buffered SSE: all events
  // arrive AFTER generation, so the client never sees token-by-token output.

  streamStart(state: unknown, ctx: { model: string }): string[] {
    const s = state as ResponsesState;
    return responsesStreamPrefix(s.respId, ctx.model, s.messageId, s.seq, s.store);
  },

  encodeChunk(chunk: ChatCompletionChunk, ctx: { state?: unknown }): string | null {
    const s = ctx.state as ResponsesState | undefined;
    const text = chunk.choices?.[0]?.delta?.content;
    if (!s || typeof text !== 'string' || text.length === 0) return null;
    return responsesDeltaFrame(s.messageId, text, s.seq);
  },

  streamEnd(result: ExecutionResult, state: unknown): string[] {
    const s = state as ResponsesState;
    return responsesStreamSuffix(result.response!, s.respId, result.modelUsed, s.messageId, s.seq, s.store);
  },

  // `_status` is kept for signature parity with the other wire surfaces; this
  // wire's quirk is that `type` is pinned regardless of status.
  errorBody(_status: number, message: string, code?: string): unknown {
    // Today's errorReply(): keys in order message/type/code, type pinned to
    // invalid_request_error at every status (this wire's quirk — preserved,
    // not "fixed"). `code` reaches this method from two callers: the parse-400
    // channel (SurfaceParseResult.errorCode — `unsupported_parameter`) and the
    // transports' pre-dispatch errors. A parse-400 without an explicit code
    // falls back to message identity: previousNotFoundMessage() above is the
    // only producer of `previous_response_not_found`.
    const resolved = code ?? (message.startsWith(PREVIOUS_NOT_FOUND_PREFIX) ? 'previous_response_not_found' : undefined);
    return {
      error: {
        message,
        type: 'invalid_request_error',
        code: resolved,
      },
    };
  },

  executionError(err: unknown): { status: number; body: unknown } {
    const e = err as { statusCode?: unknown; message?: string } | null | undefined;
    const statusCode = e?.statusCode;
    // Today's catch: explicitly tagged 4xx (e.g. variant resolution) keep
    // their status with code invalid_request_error (type and code are
    // literally identical there — preserved); everything else collapses to a
    // 502 upstream_error with the fallback message.
    if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
      return {
        status: statusCode,
        body: { error: { message: e?.message, type: 'invalid_request_error', code: 'invalid_request_error' } },
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
