/**
 * Merge-view regression tests for the openai-chat dialect in transcript.ts.
 * The driver ingests EVERY later data: frame once a dialect is selected, so
 * the adapter must ignore foreign shapes (mid-stream error events,
 * choices-less usage frames) instead of throwing on them.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureTurn } from './api';
import { groupIntoRounds, messageText, mergeSseToNonStream } from './transcript';
import type { TranscriptMessage, TranscriptTurn } from './transcript';

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

const step = (over: Partial<TranscriptTurn>): TranscriptTurn => ({
  idx: 0,
  turn: {} as CaptureTurn,
  input: [],
  output: null,
  hasResponseBody: false,
  reqTruncated: false,
  reqUnparsed: false,
  diverged: false,
  ...over,
});

describe('groupIntoRounds — archive prompt metadata', () => {
  it('keeps a full-history opener as one round and shows its archived prompt', () => {
    const rounds = groupIntoRounds([
      step({
        // The body carries Q1, a harness bundle, then the actual new prompt.
        input: [msg('Q1'), msg('<user_info> harness'), msg('Q2')],
        turn: {
          promptSummary: 'Q2',
          clientRequest: { promptMessageCount: 3 },
        } as CaptureTurn,
      }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].prompt && messageText(rounds[0].prompt)).toBe('Q2');
  });

  it('does not split an indexed round when an intermediate answer converges', () => {
    const rounds = groupIntoRounds([
      step({
        input: [msg('Q1')],
        turn: {
          promptSummary: 'Q1',
          clientRequest: { promptMessageCount: 2 },
        } as CaptureTurn,
        output: { text: 'intermediate', reasoning: '', toolCalls: [] },
      }),
      step({
        input: [msg('tool result', 'tool')],
        turn: { clientRequest: { promptMessageCount: 3 } } as CaptureTurn,
      }),
      step({
        input: [msg('Q2')],
        turn: {
          promptSummary: 'Q2',
          clientRequest: { promptMessageCount: 2 },
        } as CaptureTurn,
      }),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].steps).toHaveLength(2);
  });
});
