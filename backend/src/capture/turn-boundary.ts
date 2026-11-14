import type { ChatMessage } from '../types/openai.js';

/**
 * Write-time turn boundary classification (ADR-0024).
 *
 * A `turn` is ONE user prompt plus every request it drove. The boundary is
 * decided here, at the inbound admission gate, from the STRUCTURE of the
 * message list — never from display text and never at read time. Text
 * presence is presentation only: an image- or attachment-only user prompt is
 * still a new turn.
 *
 * The read plane never re-derives this. Every capture event and every
 * execution trace carries the resulting `turnIndex`, so a console window,
 * an archive slice or a session merge all see the same immutable number.
 */
export type TurnDecision =
  /** A new user message starts a new turn. */
  | 'new_prompt'
  /** Tool-result continuation (or resent history): stays in the current turn. */
  | 'continuation'
  /** Client compacted/shrank its history: allocate anyway, flag the doubt. */
  | 'ambiguous_compaction'
  /** No user message at all (standalone decision surface, probe, replay). */
  | 'no_prompt';

/**
 * The three turn fields copied onto EVERY capture event and every execution
 * trace of a request. `NO_TURN` is the first-class "no prompt" value, not a
 * missing field: standalone decision surfaces, probes and replays use it.
 */
export interface TurnIdentity {
  turnIndex: number | null;
  isPromptStart: boolean;
  turnDecision: TurnDecision;
}

export const NO_TURN: TurnIdentity = {
  turnIndex: null,
  isPromptStart: false,
  turnDecision: 'no_prompt',
};

export interface TurnAssignment extends TurnIdentity {
  /** Message-array length of this request — the next comparison floor. */
  messageCount: number;
}

/** Anthropic puts tool results inside a `user` message as `tool_result` parts. */
function isToolResultOnlyUserMessage(message: ChatMessage): boolean {
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(part => {
    if (typeof part !== 'object' || part === null) return false;
    const type = (part as { type?: unknown }).type;
    return type === 'tool_result' || type === 'tool_use';
  });
}

/**
 * Structural boundary rule.
 *
 * `prevMessageCount` is the message-array length of the session's PREVIOUS
 * request, held in the write-time counter state. A genuinely new user message
 * always lands at or past that floor because clients append. An older index
 * means the client resent history (a tool loop), not a new question. A shrunk
 * array means the client compacted its own history: every index moved, so the
 * comparison proves nothing — allocate a new turn and label the doubt rather
 * than silently hiding a real prompt.
 */
export function classifyTurnBoundary(
  messages: readonly ChatMessage[] | undefined,
  prevMessageCount: number | undefined
): { isPromptStart: boolean; turnDecision: TurnDecision; messageCount: number } {
  const list = Array.isArray(messages) ? messages : [];
  const messageCount = list.length;

  // Last user-role message. OpenAI's `role: 'tool'` messages are not user
  // messages and never open a turn; Anthropic's tool results ride INSIDE a
  // user message and are detected by their content parts below.
  let lastUserIdx = -1;
  for (let i = messageCount - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) {
    return { isPromptStart: false, turnDecision: 'no_prompt', messageCount };
  }

  // A tool-result continuation carries no new human prompt.
  if (isToolResultOnlyUserMessage(list[lastUserIdx])) {
    return { isPromptStart: false, turnDecision: 'continuation', messageCount };
  }
  // OpenAI dialect: a trailing `role: 'tool'` message means the last user
  // message already belonged to the previous request's tool loop.
  let trailingTool = false;
  for (let i = messageCount - 1; i > lastUserIdx; i--) {
    if (list[i]?.role === 'tool') {
      trailingTool = true;
      break;
    }
  }
  if (trailingTool) {
    return { isPromptStart: false, turnDecision: 'continuation', messageCount };
  }

  if (prevMessageCount !== undefined) {
    if (messageCount < prevMessageCount) {
      // History shrank — the index comparison is meaningless. Allocating on
      // doubt keeps (sessionId, turnIndex) unique and monotonic.
      return { isPromptStart: true, turnDecision: 'ambiguous_compaction', messageCount };
    }
    if (lastUserIdx < prevMessageCount) {
      return { isPromptStart: false, turnDecision: 'continuation', messageCount };
    }
  }
  return { isPromptStart: true, turnDecision: 'new_prompt', messageCount };
}
