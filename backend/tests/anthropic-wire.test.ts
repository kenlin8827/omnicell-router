import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnthropicMessagesEventEncoder,
  anthropicRequestToIR,
  canonicalToAnthropicResponse,
} from '../src/ir/adapters/anthropic-messages.js';
import { canonicalResponseToEvents } from '../src/ir/stream.js';
import type { CanonicalResponse, OutputItem } from '../src/ir/types.js';

function response(output: OutputItem[], reason = 'stop'): CanonicalResponse {
  return {
    id: 'msg_test', createdAt: 1700000000, model: 'upstream-model', status: 'completed', reason,
    output, usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
  };
}

function stream(responseValue: CanonicalResponse) {
  const encoder = new AnthropicMessagesEventEncoder();
  return canonicalResponseToEvents(responseValue).flatMap((event) => encoder.encode(event, 'claude-x', responseValue));
}

describe('Anthropic request → IR', () => {
  it('maps function tools and input_schema without a Chat intermediate', () => {
    const request = anthropicRequestToIR({
      model: 'claude-x', max_tokens: 100,
      tools: [{ name: 'list_files', description: 'List files in a directory', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [{ role: 'user', content: 'list the files' }],
    });
    assert.deepStrictEqual(request.tools, [{
      type: 'function',
      function: {
        name: 'list_files', description: 'List files in a directory',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }]);
  });

  it('keeps assistant text, tool_use and tool_result as ordered IR items', () => {
    const request = anthropicRequestToIR({
      model: 'claude-x', max_tokens: 100,
      messages: [
        { role: 'user', content: 'list the files' },
        { role: 'assistant', content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call_1', name: 'list_files', input: { path: '.' } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.ts,b.ts' }] },
      ],
    });
    assert.deepStrictEqual(request.input.map((item) => item.type), ['message', 'message', 'tool_call', 'tool_result']);
    const call = request.input[2]!;
    assert.ok(call.type === 'tool_call');
    assert.strictEqual(call.callId, 'call_1');
    assert.deepStrictEqual(JSON.parse(call.arguments), { path: '.' });
    const result = request.input[3]!;
    assert.ok(result.type === 'tool_result');
    assert.deepStrictEqual(result.content, [{ type: 'text', text: 'a.ts,b.ts' }]);
  });

  it('maps tool_choice and disable_parallel_tool_use', () => {
    const request = anthropicRequestToIR({
      model: 'claude-x', max_tokens: 100, tools: [{ name: 'read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'read', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.deepStrictEqual(request.toolChoice, { type: 'function', name: 'read' });
    assert.strictEqual(request.parallelToolCalls, false);

    const auto = anthropicRequestToIR({
      model: 'claude-x', max_tokens: 10, tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: 'hi' }],
    });
    assert.deepStrictEqual(auto.toolChoice, { type: 'auto' });
    assert.strictEqual(auto.parallelToolCalls, undefined);
  });

  it('preserves metadata.user_id as the canonical user', () => {
    const user = 'user_abc_account_xyz_session_6f978fa1-8a13-4a42-9f77-65bef0e6802f';
    const request = anthropicRequestToIR({
      model: 'claude-x', max_tokens: 10, metadata: { user_id: user }, messages: [{ role: 'user', content: 'hi' }],
    });
    assert.strictEqual(request.user, user);
  });

  it('maps enabled, disabled and adaptive thinking distinctly', () => {
    const base = { model: 'claude-x', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
    assert.strictEqual(anthropicRequestToIR({ ...base, thinking: { type: 'enabled', budget_tokens: 5000 } }).reasoning?.budgetTokens, 5000);
    assert.strictEqual(anthropicRequestToIR({ ...base, thinking: { type: 'disabled' } }).reasoning?.effort, 'none');
    assert.strictEqual(anthropicRequestToIR({ ...base, thinking: { type: 'adaptive' } }).reasoning, undefined);
    assert.strictEqual(anthropicRequestToIR(base).reasoning, undefined);
  });

  it('maps supported output_config.effort values and rejects unknown values', () => {
    const base = { model: 'claude-x', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      assert.strictEqual(anthropicRequestToIR({ ...base, output_config: { effort } }).reasoning?.effort, effort);
    }
    assert.throws(() => anthropicRequestToIR({ ...base, output_config: { effort: 'ultra' } }), /output_config\.effort/);
  });

  it('preserves URL and base64 image sources', () => {
    const request = anthropicRequestToIR({
      model: 'claude-x', max_tokens: 100,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] }],
    });
    const message = request.input[0]!;
    assert.ok(message.type === 'message');
    assert.deepStrictEqual(message.content.map((part) => part.type === 'image' ? part.source : null), [
      { kind: 'url', url: 'https://example.test/a.png' },
      { kind: 'base64', mediaType: 'image/png', data: 'AAAA' },
    ]);
  });
});

describe('IR → Anthropic response and events', () => {
  it('maps text and tool calls to tool_use blocks with stop_reason tool_use', () => {
    const out = canonicalToAnthropicResponse(response([
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'checking' }] },
      { type: 'tool_call', id: 'call_1', callId: 'call_1', name: 'list_files', arguments: '{"path":"."}' },
    ], 'tool_calls'), 'claude-x');
    assert.strictEqual(out.stop_reason, 'tool_use');
    assert.strictEqual(out.content[0].text, 'checking');
    assert.deepStrictEqual(out.content[1], { type: 'tool_use', id: 'call_1', name: 'list_files', input: { path: '.' } });
  });

  it('keeps text-only responses on the classic single text block', () => {
    const out = canonicalToAnthropicResponse(response([
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'plain' }] },
    ]), 'claude-x');
    assert.deepStrictEqual(out.content, [{ type: 'text', text: 'plain' }]);
    assert.strictEqual(out.stop_reason, 'end_turn');
  });

  it('emits tool_use blocks with input_json_delta events', () => {
    const events = stream(response([
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'checking' }] },
      { type: 'tool_call', id: 'call_7', callId: 'call_7', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ], 'tool_calls'));
    assert.deepStrictEqual(events.map((event) => event.type), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.deepStrictEqual(events[4]!.content_block, { type: 'tool_use', id: 'call_7', name: 'read_file', input: {} });
    assert.strictEqual(events[5]!.delta.partial_json, '{"path":"a.ts"}');
    assert.strictEqual(events[7]!.delta.stop_reason, 'tool_use');
  });

  it('keeps pure-text streams on one content block', () => {
    const events = stream(response([{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]));
    assert.strictEqual(events.filter((event) => event.type === 'content_block_start').length, 1);
    assert.strictEqual(events.at(-1)!.type, 'message_stop');
  });
});
