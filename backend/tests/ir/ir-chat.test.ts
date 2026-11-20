import { describe, expect, test } from 'bun:test';
import { chatRequestToIR, chatResponseToIR, irToChatRequest, irToChatResponse } from '../../src/ir/adapters/openai-chat.js';
import { IrUnsupportedError } from '../../src/ir/errors.js';
import type { ChatCompletionRequest } from '../../src/types/openai.js';

const request: ChatCompletionRequest = {
  model: 'auto',
  stream: true,
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png', detail: 'low' } }] },
    { role: 'assistant', content: null, reasoning_content: 'think', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
    { role: 'tool', content: [{ type: 'text', text: 'ok' }] as any, tool_call_id: 'c1' },
  ],
  tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' }, strict: true, cache_control: { type: 'ephemeral' } } }],
  tool_choice: { type: 'function', function: { name: 'f' } },
  parallel_tool_calls: false,
  temperature: 0.2,
  max_completion_tokens: 512,
  response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } },
  reasoning_effort: 'medium',
  prompt_cache_key: 'k',
  metadata: { tenant: 't' },
};

describe('IR: chat adapter', () => {
  test('request maps every chat feature to typed IR', () => {
    const ir = chatRequestToIR(request);
    expect(ir.input.map((i) => i.type)).toEqual(['message', 'message', 'reasoning', 'tool_call', 'tool_result']);
    expect(ir.tools?.[0].function.strict).toBe(true);
    expect(ir.tools?.[0].function.cache).toEqual({ type: 'ephemeral' });
    expect(ir.toolChoice).toEqual({ type: 'function', name: 'f' });
    expect(ir.generation?.maxOutputTokens).toBe(512);
    expect(ir.text?.format?.type).toBe('json_schema');
    expect(ir.reasoning?.effort).toBe('medium');
    expect(ir.cache?.key).toBe('k');
  });

  test('IR → chat round-trips the supported chat feature set', () => {
    const ir = chatRequestToIR(request);
    const back = irToChatRequest(ir, 'up-model');
    expect(back.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    // Folded system text keeps the part-level cache as a message-level marker.
    expect(back.messages[0].content).toBe('sys');
    expect(back.messages[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((back.messages[1].content as any)[0].image_url).toEqual({ url: 'https://x.test/a.png', detail: 'low' });
    expect(back.messages[2].reasoning_content).toBe('think');
    expect(back.messages[2].tool_calls?.[0].id).toBe('c1');
    expect(back.tools?.[0].function.strict).toBe(true);
    expect(back.max_tokens).toBe(512);
    expect(back.parallel_tool_calls).toBe(false);
    expect(back.prompt_cache_key).toBe('k');
    expect(ir.text?.format?.type).toBe('json_schema');
  });

  test('folds instructions + system input into one system message', () => {
    const back = irToChatRequest({
      model: 'auto',
      instructions: 'INSTR',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'SYS' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }, 'm');
    expect(back.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'system', content: 'INSTR\n\nSYS' },
      { role: 'user', content: 'hi' },
    ]);
  });

  test('joins adjacent text parts with a stable separator', () => {
    const ir = chatRequestToIR({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }],
    });
    const back = irToChatRequest(ir, 'm');
    expect(back.messages[0].content).toBe('first\n\nsecond');
  });

  test('IR → chat refuses a part chat cannot carry', () => {
    const ir = chatRequestToIR(request);
    ir.input[1] = { type: 'message', role: 'user', content: [{ type: 'file', source: { kind: 'file', fileId: 'file_1' } }] };
    expect(() => irToChatRequest(ir, 'm')).toThrow(IrUnsupportedError);
  });

  test('response maps tool calls, reasoning, refusal and cache usage', () => {
    const ir = chatResponseToIR({
      id: 'r1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 1 } },
    });
    expect(ir.status).toBe('completed');
    expect(ir.output.map((i) => i.type)).toEqual(['reasoning', 'tool_call']);
    expect(ir.usage.cachedInputTokens).toBe(8);
    expect(ir.usage.reasoningTokens).toBe(1);

    const back = irToChatResponse(ir, 'r1', 'm');
    expect(back.choices[0].finish_reason).toBe('tool_calls');
    expect(back.usage?.prompt_tokens_details?.cached_tokens).toBe(8);
  });
});
