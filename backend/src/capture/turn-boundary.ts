import type { InputItem } from '../ir/types.js';

export type TurnDecision = 'new_prompt' | 'continuation' | 'ambiguous_compaction' | 'no_prompt';

export interface TurnIdentity {
  turnIndex: number | null;
  isPromptStart: boolean;
  turnDecision: TurnDecision;
}

export const NO_TURN: TurnIdentity = {
  turnIndex: null, isPromptStart: false, turnDecision: 'no_prompt',
};

export interface TurnAssignment extends TurnIdentity {
  messageCount: number;
}

/** Structural write-time boundary over canonical items, never prompt text. */
export function classifyTurnBoundary(
  input: readonly InputItem[] | undefined,
  prevMessageCount: number | undefined,
): { isPromptStart: boolean; turnDecision: TurnDecision; messageCount: number } {
  const list = Array.isArray(input) ? input : [];
  const messageCount = list.length;
  let lastUserIndex = -1;
  for (let index = messageCount - 1; index >= 0; index--) {
    if (list[index]?.type === 'message' && list[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return { isPromptStart: false, turnDecision: 'no_prompt', messageCount };
  for (let index = messageCount - 1; index > lastUserIndex; index--) {
    if (list[index]?.type === 'tool_result') {
      return { isPromptStart: false, turnDecision: 'continuation', messageCount };
    }
  }
  if (prevMessageCount !== undefined) {
    if (messageCount < prevMessageCount) {
      return { isPromptStart: true, turnDecision: 'ambiguous_compaction', messageCount };
    }
    if (lastUserIndex < prevMessageCount) {
      return { isPromptStart: false, turnDecision: 'continuation', messageCount };
    }
  }
  return { isPromptStart: true, turnDecision: 'new_prompt', messageCount };
}
