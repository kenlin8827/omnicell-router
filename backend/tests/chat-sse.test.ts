import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalResponseToEvents } from '../src/ir/stream.js';
import { ChatEventEncoder } from '../src/ir/adapters/openai-chat-stream.js';
import type { ChatCompletionResponse } from '../src/types/openai.js';
import { responseToIR } from './helpers/ir.js';

function resp(overrides: Partial<ChatCompletionResponse['choices'][0]['message']> & { content?: string }): ChatCompletionResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'up-model',
    choices: [
      { index: 0, message: { role: 'assistant', ...overrides } as any, finish_reason: overrides.tool_calls ? 'tool_calls' : 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  } as ChatCompletionResponse;
}

function encode(response: ChatCompletionResponse) {
  const ir = responseToIR(response);
  const encoder = new ChatEventEncoder();
  const events = canonicalResponseToEvents(ir);
  const chunks = events.flatMap((event) => {
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') return [];
    const chunk = encoder.encode(event, 'served-model');
    return chunk ? [chunk] : [];
  });
  chunks.push(...encoder.finish(ir, 'served-model'));
  return chunks;
}

describe('Chat IR event encoder', () => {
  it('emits role, text, usage and the real finish reason', () => {
    const chunks = encode(resp({ content: 'abcdefghij' }));
    assert.strictEqual(chunks[0]!.choices[0]!.delta.role, 'assistant');
    assert.strictEqual(chunks.map((chunk) => chunk.choices[0]?.delta.content || '').join(''), 'abcdefghij');
    const usage = chunks.find((chunk) => chunk.usage);
    assert.strictEqual(usage?.usage?.total_tokens, 8);
    assert.strictEqual(chunks.at(-1)!.choices[0]!.finish_reason, 'stop');
  });

  it('emits complete tool calls and finish_reason tool_calls', () => {
    const chunks = encode(resp({
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    }));
    const fragments = chunks.map((chunk) => chunk.choices[0]?.delta.tool_calls).filter(Boolean).flat();
    assert.strictEqual(fragments[0]!.id, 'call_1');
    assert.strictEqual(fragments[0]!.function.name, 'read_file');
    assert.strictEqual(fragments.slice(1).map((fragment) => fragment.function.arguments).join(''), '{"path":"a.ts"}');
    assert.strictEqual(chunks.at(-1)!.choices[0]!.finish_reason, 'tool_calls');
  });

  it('uses the served model id on every chunk', () => {
    assert.ok(encode(resp({ content: 'x' })).every((chunk) => chunk.model === 'served-model'));
  });
});
