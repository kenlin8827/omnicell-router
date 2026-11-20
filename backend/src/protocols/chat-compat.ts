import type { ChatMessage, ChatMessageContentPart, ChatCompletionRequest, Tool, ToolCall } from '../types/openai.js';
import { IrUnsupportedError } from '../ir/errors.js';

/**
 * Chat-completions wire version tolerance.
 *
 * The chat wire has TWO generations of the same feature:
 * - legacy (pre-2023-11): `functions` + `function_call`, assistant
 *   `message.function_call`, `role: "function"` results keyed by NAME;
 * - current: `tools` + `tool_choice`, assistant `message.tool_calls`,
 *   `role: "tool"` results keyed by `tool_call_id`.
 *
 * The canonical chain only speaks the current shape, so legacy requests are
 * normalized HERE, at the surface, before the canonical chain sees them:
 * upstream vendors and every other wire in the gateway implement `tools`/
 * `tool_calls` only, and forwarding `functions` would make a modern model 400.
 *
 * Outbound stays modern-only. A legacy client that sends `functions` still
 * receives `tool_calls`; the alternative is a per-request legacy response
 * encoder (non-streaming and streaming), which would fork the response shape
 * for a pre-2023 client generation that current SDKs no longer emit. That is
 * a deliberate boundary, not an accidental drop.
 *
 * Malformed legacy fields fail visible (`IrUnsupportedError` → 400
 * unsupported_parameter) instead of being silently skipped — a dropped tool
 * definition collapses agent loops the same way a dropped modern `tools`
 * entry would. A `null` legacy field is NOT malformed: it is the common
 * "feature not used" sentinel and is treated as absent.
 */

interface LegacyFunctionDefinition {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
}

interface LegacyFunctionCall {
  name?: unknown;
  arguments?: unknown;
}

type LegacyMessage = Omit<ChatMessage, 'role' | 'content'> & {
  role: ChatMessage['role'] | 'function';
  content?: string | ChatMessageContentPart[] | null;
  function_call?: LegacyFunctionCall | null;
};

type LegacyRequest = ChatCompletionRequest & {
  functions?: unknown;
  function_call?: unknown;
};

function failLegacy(code: string, message: string): never {
  throw new IrUnsupportedError(code, message, 'openai-chat');
}

export function normalizeLegacyChatRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const legacy = request as LegacyRequest;
  const legacyMessages = Array.isArray(request.messages)
    ? (request.messages as LegacyMessage[]).some(
        (m) => m?.role === 'function' || (m && typeof m.function_call === 'object' && m.function_call !== null),
      )
    : false;
  // `null` is a wire-level "not specified" sentinel (some SDKs / serializers
  // emit it instead of omitting the key). It is not a malformed value: the
  // type declaration above, the message-layer handling and HEAD's wire all
  // treat it as absent. Only truly absent keys take the fast path; null keys
  // still go through the copy below so they are stripped from the outbound wire.
  const hasFunctions = legacy.functions !== undefined && legacy.functions !== null;
  const hasFunctionCall = legacy.function_call !== undefined && legacy.function_call !== null;
  if (legacy.functions === undefined && legacy.function_call === undefined && !legacyMessages) {
    return request;
  }

  const next = { ...legacy } as LegacyRequest;
  // Modern fields win on conflict; the legacy key never reaches an upstream.
  if (hasFunctions && request.tools === undefined) {
    if (!Array.isArray(legacy.functions)) {
      failLegacy('functions', 'Legacy "functions" must be an array of function definitions.');
    }
    next.tools = legacy.functions.map((raw, index): Tool => {
      if (!raw || typeof raw !== 'object') {
        failLegacy('functions', `Legacy functions[${index}] must be an object with a string name.`);
      }
      const fn = raw as LegacyFunctionDefinition;
      if (typeof fn.name !== 'string' || !fn.name) {
        failLegacy('functions', `Legacy functions[${index}] requires a non-empty string name.`);
      }
      const parameters =
        fn.parameters !== null && typeof fn.parameters === 'object'
          ? (fn.parameters as Record<string, unknown>)
          : { type: 'object', properties: {} };
      return {
        type: 'function',
        function: {
          name: fn.name,
          ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
          parameters,
        },
      };
    });
  }
  if (hasFunctionCall && request.tool_choice === undefined) {
    const choice = legacy.function_call;
    if (choice === 'none' || choice === 'auto') {
      next.tool_choice = choice;
    } else if (choice && typeof choice === 'object' && 'name' in choice && typeof (choice as { name?: unknown }).name === 'string') {
      const name = (choice as { name: string }).name;
      if (!name) failLegacy('function_call', 'Legacy function_call.name must be a non-empty string.');
      next.tool_choice = { type: 'function', function: { name } };
    } else {
      failLegacy(
        'function_call',
        'Legacy function_call must be "none", "auto", or { name: string }.',
      );
    }
  }
  delete next.functions;
  delete next.function_call;

  if (legacyMessages) next.messages = normalizeLegacyMessages(request.messages as LegacyMessage[]);
  return next;
}

function normalizeLegacyMessages(messages: LegacyMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const legacyCalls: { id: string; name: string }[] = [];
  const answered = new Set<string>();
  let counter = 0;

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.function_call && typeof msg.function_call === 'object') {
      const call = msg.function_call;
      const name = typeof call.name === 'string' ? call.name : '';
      if (!name) {
        failLegacy('function_call', 'Assistant message.function_call requires a non-empty string name.');
      }
      const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
      const id = `call_legacy_${counter++}`;
      const { function_call: _legacyCall, ...rest } = msg;
      const legacyToolCall: ToolCall = { id, type: 'function', function: { name, arguments: args } };
      out.push({
        ...(rest as ChatMessage),
        content: msg.content ?? '',
        tool_calls: [...(msg.tool_calls ?? []), legacyToolCall],
      });
      legacyCalls.push({ id, name });
      continue;
    }

    if (msg.role === 'function') {
      const name = typeof msg.name === 'string' ? msg.name : undefined;
      // Legacy results are matched by NAME; take the most recent unanswered
      // call with that name, then fall back to any unanswered call (some
      // clients omit `name` on the result).
      const call =
        [...legacyCalls].reverse().find((c) => !answered.has(c.id) && (!name || c.name === name)) ??
        [...legacyCalls].reverse().find((c) => !answered.has(c.id));
      if (call) {
        answered.add(call.id);
        out.push({ role: 'tool', content: contentText(msg.content), tool_call_id: call.id });
      } else {
        // Orphan legacy result (no assistant call to answer): preserve its text
        // instead of dropping it — as a user turn, which the chat wire accepts.
        out.push({
          role: 'user',
          content: `[function ${name ?? 'output'}]\n${contentText(msg.content)}`,
        });
      }
      continue;
    }

    out.push({
      ...(msg as ChatMessage),
      ...(msg.content === null || msg.content === undefined ? { content: '' } : {}),
    });
  }
  return out;
}

/**
 * Legacy `role:'function'` results are rewritten to `role:'tool'`, whose Chat
 * content is a string. Non-text parts (images, ...) cannot be represented
 * there, so fail visible instead of silently dropping them; multiple text
 * parts are joined with the same `\n\n` separator the IR adapters use rather
 * than being glued into one word.
 */
function contentText(content: LegacyMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.some((part) => part.type !== 'text')) {
      failLegacy(
        'function_result_content',
        'Legacy function result content carries text parts only; non-text parts cannot be represented on the tool wire.',
      );
    }
    return content.map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('\n\n');
  }
  return '';
}
