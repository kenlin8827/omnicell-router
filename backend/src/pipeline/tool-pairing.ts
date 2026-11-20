import type { InputItem } from '../ir/types.js';

export const UNANSWERED_TOOL_CONTENT = 'Tool call was cancelled before returning a result.';

export interface ToolPairingRepair {
  input: InputItem[];
  synthesized: number;
  duplicates: number;
  orphans: number;
}

/** Repair tool_call/tool_result correlation without projecting through Chat. */
export function repairToolCallPairing(input: InputItem[]): ToolPairingRepair {
  const out: InputItem[] = [];
  let pending: string[] = [];
  let seenToolResult = false;
  const declared = new Set<string>();
  let synthesized = 0;
  let duplicates = 0;
  let orphans = 0;
  const flush = (): void => {
    for (const callId of pending) {
      out.push({
        type: 'tool_result', callId,
        content: [{ type: 'text', text: UNANSWERED_TOOL_CONTENT }],
      });
      synthesized += 1;
    }
    pending = [];
    seenToolResult = false;
  };
  const hasPendingResultInTurn = (startIndex: number): boolean => {
    for (let j = startIndex; j < input.length; j += 1) {
      const next = input[j]!;
      if (next.type === 'tool_result') {
        if (next.callId && pending.includes(next.callId)) return true;
        continue;
      }
      if (next.type === 'reasoning' || next.type === 'tool_call') continue;
      if (next.type === 'message' && next.role === 'assistant') continue;
      break;
    }
    return false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i]!;
    if (item.type === 'tool_call') {
      // Once any tool_result has been observed for the previous turn, a new
      // tool_call starts a new assistant turn and must flush unanswered calls.
      if (seenToolResult && pending.length > 0) flush();
      const callId = item.callId ?? item.id;
      out.push(item);
      if (callId) {
        declared.add(callId);
        pending.push(callId);
      }
      continue;
    }
    if (item.type === 'tool_result') {
      const index = item.callId ? pending.indexOf(item.callId) : -1;
      if (index >= 0) {
        pending.splice(index, 1);
        out.push(item);
        // Reset once the current batch is fully answered; otherwise a later
        // turn's second parallel tool_call would see stale seenToolResult=true
        // and falsely split the turn with a synthesized tool_result.
        seenToolResult = pending.length > 0;
      } else if (item.callId && declared.has(item.callId)) duplicates += 1;
      else orphans += 1;
      continue;
    }
    if (item.type === 'message' && item.role === 'assistant') {
      if (seenToolResult && pending.length > 0) flush();
      out.push(item);
      continue;
    }
    if (item.type === 'reasoning') {
      // Flush unanswered calls from an abandoned turn before a new turn's
      // reasoning block, but preserve pending calls when interleaved thinking
      // within the same assistant turn still has its matching tool_result ahead.
      if (pending.length > 0 && (seenToolResult || !hasPendingResultInTurn(i + 1))) flush();
      out.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  const changed = synthesized > 0 || duplicates > 0 || orphans > 0;
  return { input: changed ? out : input, synthesized, duplicates, orphans };
}
