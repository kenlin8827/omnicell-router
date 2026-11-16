/**
 * Tool-call pairing normalization for the canonical chat-completions chain.
 *
 * Chat-completions — and every upstream that enforces the same rule (OpenAI,
 * DeepSeek, Anthropic's tool_use/tool_result pair) — requires every
 * `tool_calls` entry on an assistant message to be answered by exactly ONE
 * `tool` message carrying that `tool_call_id`, before any message of another
 * role appears, and forbids a `tool` message that answers no call. A client
 * can break any of those three clauses without meaning to: a cancelled or
 * aborted tool execution, a parallel call whose result was never recorded, a
 * client-side compaction that dropped old tool messages, an abandoned turn
 * continued with a plain user message, a retried result appended twice.
 * Forwarded verbatim, strict upstreams reject the WHOLE request:
 * "An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'. (insufficient tool messages following
 * tool_calls message)".
 *
 * Three repairs, all confined to the messages that violate the contract:
 *   - MISSING reply → a `tool` message is synthesized at the point the next
 *     message of another role appears (and at the end of the chain), so the
 *     model learns the call produced no result;
 *   - DUPLICATE reply (same id twice) → the later one is dropped;
 *   - ORPHAN reply (no preceding assistant message declared its id) → dropped:
 *     it can only be answered by history this list does not contain, and no
 *     strict upstream will accept it anyway.
 * A conforming conversation is returned untouched (same array instance), so a
 * clean chain never pays for the repair.
 *
 * Call sites (idempotent — a conforming chain is returned untouched): the
 * Responses surface repairs its own assembled chain so the request it hands
 * downstream is already valid, and the pipeline orchestrator runs it on the
 * canonical chain every inbound wire converges on (native chat-completions,
 * Responses, Anthropic) before compression and wire shaping.
 */
import { ChatMessage } from '../types/openai.js';

/** Content of the synthesized reply for a call the client never answered. */
export const UNANSWERED_TOOL_CONTENT = 'Tool call was cancelled before returning a result.';

export interface ToolPairingRepair {
  messages: ChatMessage[];
  /** Calls closed with a synthesized `tool` message. */
  synthesized: number;
  /** Second and later `tool` messages for an id already answered. */
  duplicates: number;
  /** `tool` messages whose id no assistant message in the chain declared. */
  orphans: number;
}

export function repairToolCallPairing(messages: ChatMessage[]): ToolPairingRepair {
  const out: ChatMessage[] = [];
  /** Call ids of the current assistant turn not yet answered. */
  let pending: string[] = [];
  /** Every call id any assistant message in this chain declared. */
  const declared = new Set<string>();
  let synthesized = 0;
  let duplicates = 0;
  let orphans = 0;

  const flush = (): void => {
    for (const id of pending) {
      out.push({ role: 'tool', content: UNANSWERED_TOOL_CONTENT, tool_call_id: id });
      synthesized += 1;
    }
    pending = [];
  };

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // No later message can answer the previous turn's calls.
      flush();
      out.push(msg);
      pending = [];
      for (const tc of msg.tool_calls ?? []) {
        const id = tc.id;
        // An id-less call cannot be answered by anything — including a
        // synthesized reply — so it is left for the upstream to judge.
        if (!id) continue;
        declared.add(id);
        pending.push(id);
      }
      continue;
    }
    if (msg.role === 'tool') {
      const idx = msg.tool_call_id ? pending.indexOf(msg.tool_call_id) : -1;
      if (idx >= 0) {
        pending.splice(idx, 1);
        out.push(msg);
      } else if (msg.tool_call_id && declared.has(msg.tool_call_id)) {
        // Answered twice for the same call: keep the first reply only.
        duplicates += 1;
      } else {
        // Never declared anywhere in this chain — unplaceable client data.
        orphans += 1;
      }
      continue;
    }
    // user / system / developer: no later message can answer these calls.
    flush();
    out.push(msg);
  }
  flush();

  const changed = synthesized > 0 || duplicates > 0 || orphans > 0;
  return { messages: changed ? out : messages, synthesized, duplicates, orphans };
}
