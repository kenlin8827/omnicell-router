import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLegacyChatRequest } from '../src/protocols/chat-compat.js';
import type { ChatCompletionRequest } from '../src/types/openai.js';

describe('chat wire version tolerance: legacy functions → current tools', () => {
  it('leaves a current-shape request untouched (same object, no copy)', () => {
    const req = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    } as unknown as ChatCompletionRequest;
    assert.strictEqual(normalizeLegacyChatRequest(req), req);
  });

  it('maps functions → tools, function_call → tool_choice, and drops the legacy keys', () => {
    const raw = {
      model: 'auto',
      messages: [{ role: 'user', content: 'go' }],
      functions: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      function_call: { name: 'read' },
    };
    const next = normalizeLegacyChatRequest(raw as unknown as ChatCompletionRequest) as ChatCompletionRequest & {
      functions?: unknown;
      function_call?: unknown;
    };
    assert.deepStrictEqual(next.tools, [
      {
        type: 'function',
        function: { name: 'read', description: 'read a file', parameters: { type: 'object' } },
      },
    ]);
    assert.deepStrictEqual(next.tool_choice, { type: 'function', function: { name: 'read' } });
    assert.equal(next.functions, undefined);
    assert.equal(next.function_call, undefined);
    // Input object is not mutated: capture/indexing still sees client bytes.
    assert.ok(Array.isArray(raw.functions));
  });

  it('maps scalar function_call values', () => {
    const auto = normalizeLegacyChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'go' }],
      function_call: 'auto',
    } as unknown as ChatCompletionRequest);
    assert.equal(auto.tool_choice, 'auto');
    const none = normalizeLegacyChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'go' }],
      function_call: 'none',
    } as unknown as ChatCompletionRequest);
    assert.equal(none.tool_choice, 'none');
  });

  it('rewrites assistant function_call + role:function history into a paired tool chain', () => {
    const next = normalizeLegacyChatRequest({
      model: 'auto',
      messages: [
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: null, function_call: { name: 'list_files', arguments: '{"path":"."}' } },
        { role: 'function', name: 'list_files', content: 'a.ts,b.ts' },
      ],
    } as unknown as ChatCompletionRequest);

    const [user, assistant, tool] = next.messages;
    assert.equal(user!.role, 'user');
    assert.equal(assistant!.role, 'assistant');
    assert.equal(assistant!.content, '');
    assert.equal(assistant!.tool_calls?.length, 1);
    assert.equal(assistant!.tool_calls![0]!.function.name, 'list_files');
    assert.equal(assistant!.tool_calls![0]!.function.arguments, '{"path":"."}');
    assert.equal(tool!.role, 'tool');
    assert.equal((tool as { tool_call_id?: string }).tool_call_id, assistant!.tool_calls![0]!.id);
    assert.equal(tool!.content, 'a.ts,b.ts');
    assert.ok(!('function_call' in assistant!), 'legacy key must not reach the upstream');
  });

  it('matches an unnamed role:function result to the most recent unanswered call', () => {
    const next = normalizeLegacyChatRequest({
      model: 'auto',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', function_call: { name: 'a', arguments: '{}' } },
        { role: 'function', content: 'A' },
        { role: 'assistant', content: '', function_call: { name: 'b', arguments: '{}' } },
        { role: 'function', content: 'B' },
      ],
    } as unknown as ChatCompletionRequest);
    const tools = next.messages.filter((m) => m.role === 'tool') as Array<{ tool_call_id: string; content: string }>;
    const calls = next.messages.flatMap((m) => m.tool_calls ?? []);
    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.tool_call_id, calls[0]!.id);
    assert.equal(tools[1]!.tool_call_id, calls[1]!.id);
    assert.deepEqual(
      tools.map((t) => t.content),
      ['A', 'B']
    );
  });

  it('preserves an orphan legacy result as a user turn instead of dropping it', () => {
    const next = normalizeLegacyChatRequest({
      model: 'auto',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'function', name: 'ghost', content: 'lost?' },
      ],
    } as unknown as ChatCompletionRequest);
    assert.equal(next.messages[1]!.role, 'user');
    assert.match(String(next.messages[1]!.content), /\[function ghost\]\nlost\?/);
  });

  // Regression: the fail-visible legacy conversion must not turn the common
  // `null` "feature not used" sentinel into a 400 unsupported_parameter.
  it('treats legacy null sentinels as absent and strips them from the wire', () => {
    const base = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };
    const cases = [
      { ...base, functions: null },
      { ...base, function_call: null },
      { ...base, functions: null, function_call: null },
    ];
    for (const raw of cases) {
      const next = normalizeLegacyChatRequest(raw as unknown as ChatCompletionRequest) as ChatCompletionRequest & {
        functions?: unknown;
        function_call?: unknown;
      };
      assert.equal(next.tools, undefined);
      assert.equal(next.tool_choice, undefined);
      assert.equal(next.functions, undefined, 'null key must not reach the upstream');
      assert.equal(next.function_call, undefined, 'null key must not reach the upstream');
      assert.deepEqual(next.messages, base.messages);
    }
  });

  it('joins multiple text parts of a legacy function result without gluing them', () => {
    const next = normalizeLegacyChatRequest({
      model: 'auto',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', function_call: { name: 'f', arguments: '{}' } },
        { role: 'function', name: 'f', content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ] },
      ],
    } as unknown as ChatCompletionRequest);
    assert.equal(next.messages[2]!.role, 'tool');
    assert.equal(next.messages[2]!.content, 'first\n\nsecond');
  });

  it('fails visible instead of silently dropping image parts from a legacy function result', () => {
    assert.throws(
      () => normalizeLegacyChatRequest({
        model: 'auto',
        messages: [
          { role: 'assistant', content: '', function_call: { name: 'f', arguments: '{}' } },
          { role: 'function', name: 'f', content: [
            { type: 'text', text: 'first' },
            { type: 'image_url', image_url: { url: 'https://x/a.png' } },
          ] },
        ],
      } as unknown as ChatCompletionRequest),
      (err: unknown) => err instanceof Error && err.name === 'IrUnsupportedError',
    );
  });

  it('still rejects genuinely malformed legacy values', () => {
    const base = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };
    const cases = [
      { ...base, functions: 'nope' },
      { ...base, function_call: 42 },
      { ...base, function_call: { name: '' } },
      { ...base, functions: [null] },
    ];
    for (const raw of cases) {
      assert.throws(
        () => normalizeLegacyChatRequest(raw as unknown as ChatCompletionRequest),
        (err: unknown) => err instanceof Error && err.name === 'IrUnsupportedError',
      );
    }
  });
});
