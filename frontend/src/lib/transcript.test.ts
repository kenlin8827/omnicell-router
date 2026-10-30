/**
 * Merge-view regression tests for the openai-chat dialect in transcript.ts.
 * The driver ingests EVERY later data: frame once a dialect is selected, so
 * the adapter must ignore foreign shapes (mid-stream error events,
 * choices-less usage frames) instead of throwing on them.
 */
import { describe, expect, it } from 'vitest';
import { mergeSseToNonStream } from './transcript';

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
