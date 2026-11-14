/**
 * Merge-view regression tests for the openai-chat dialect in transcript.ts.
 * The driver ingests EVERY later data: frame once a dialect is selected, so
 * the adapter must ignore foreign shapes (mid-stream error events,
 * choices-less usage frames) instead of throwing on them.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureRequestView } from './api';
import { groupIntoTurns, messageText, mergeSseToNonStream } from './transcript';
import type { TranscriptMessage, TranscriptStep } from './transcript';

const frame = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;

const deltaFrame = (content: string, finish: string | null = null): string =>
  frame({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });

describe('mergeSseToNonStream — openai-chat dialect', () => {
  it('merges a delta stream into the equivalent non-stream completion body', () => {
    const raw = deltaFrame('Hel') + deltaFrame('lo', 'stop') + 'data: [DONE]\n\n';
    const merged = mergeSseToNonStream(raw) as Record<string, any>;
    expect(merged.object).toBe('chat.completion');
    expect(merged.choices[0].message.content).toBe('Hello');
    expect(merged.choices[0].finish_reason).toBe('stop');
  });

  it('ignores choices-less error frames that share the data channel mid-stream', () => {
    const raw =
      deltaFrame('ok') + frame({ error: { message: 'overloaded', code: 503 } }) + deltaFrame('!', 'stop');
    const merged = mergeSseToNonStream(raw) as Record<string, any>;
    expect(merged).not.toBeNull();
    expect(merged.choices[0].message.content).toBe('ok!');
  });

  it('still folds usage from a choices-less usage frame', () => {
    const raw =
      deltaFrame('hi', 'stop') +
      frame({ id: 'chatcmpl-1', usage: { prompt_tokens: 3, completion_tokens: 1 } });
    const merged = mergeSseToNonStream(raw) as Record<string, any>;
    expect(merged.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1 });
  });
});

const msg = (text: string, role: 'user' | 'assistant' | 'tool' = 'user'): TranscriptMessage => ({
  role,
  blocks: [{ kind: 'text', text }],
  toolCalls: [],
});

/** A schema-2 request view with its WRITE-TIME turn identity. */
const request = (turnIndex: number | null, promptSummary?: string): CaptureRequestView => ({
  requestId: `req_${turnIndex ?? 'none'}_${promptSummary ?? ''}`,
  sessionId: 'sess_1',
  model: 'test-model',
  turnIndex,
  isPromptStart: promptSummary !== undefined,
  turnDecision: turnIndex === null ? 'no_prompt' : promptSummary !== undefined ? 'new_prompt' : 'continuation',
  ...(promptSummary !== undefined ? { promptSummary } : {}),
  exchanges: [],
});

const step = (over: Partial<TranscriptStep>): TranscriptStep => ({
  idx: 0,
  request: request(1),
  input: [],
  output: null,
  hasResponseBody: false,
  reqTruncated: false,
  reqUnparsed: false,
  diverged: false,
  ...over,
});

describe('groupIntoTurns — write-time turnIndex', () => {
  it('groups a prompt-start request and its tool-result continuation into ONE turn', () => {
    const turns = groupIntoTurns([
      step({ request: request(7, 'Q7'), input: [msg('Q7')] }),
      step({ request: request(7), input: [msg('tool result', 'tool')] }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].turnIndex).toBe(7);
    expect(turns[0].steps).toHaveLength(2);
    expect(turns[0].prompt && messageText(turns[0].prompt)).toBe('Q7');
  });

  it('does not split a turn when an intermediate answer converges', () => {
    const turns = groupIntoTurns([
      step({ request: request(1, 'Q1'), output: { text: 'intermediate', reasoning: '', toolCalls: [] } }),
      step({ request: request(1), input: [msg('tool result', 'tool')] }),
      step({ request: request(2, 'Q2') }),
    ]);
    expect(turns.map(t => t.turnIndex)).toEqual([1, 2]);
    expect(turns[0].steps).toHaveLength(2);
    expect(turns[0].converged).toBe(false); // last hop carried no text answer
  });

  it('skips prompt-less requests (turnIndex: null) entirely', () => {
    const turns = groupIntoTurns([
      step({ request: request(null) }),
      step({ request: request(1, 'Q1') }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].steps).toHaveLength(1);
  });

  it('falls back to the newest prompt in the input delta when no stamp exists', () => {
    const turns = groupIntoTurns([
      step({ request: request(3), input: [msg('old'), msg('<user_info> harness'), msg('new prompt')] }),
    ]);
    expect(turns[0].prompt && messageText(turns[0].prompt)).toBe('new prompt');
  });
});
