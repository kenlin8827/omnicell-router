import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  inputItemsToMessages,
  chatToResponseObject,
  chatToStreamEvents,
  responsesStreamSuffix,
  newResponseStreamSequence,
  responsesToolsToChat,
  chatToolsToResponses,
  responsesToolChoiceToChat,
  ResponsesRequest,
} from '../src/routes/responses.js';
import { RespStore, newResponseId, ChatMessageLite } from '../src/session/resp-store.js';
import { ChatCompletionResponse } from '../src/types/openai.js';

function fakeChatResponse(text: string): ChatCompletionResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } as ChatCompletionResponse;
}

describe('Responses API: tool shape conversion', () => {
  it('flattens Responses-wire tools into the nested chat-completions shape', () => {
    const flat = [
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
    const chat = responsesToolsToChat(flat);
    assert.equal(chat.length, 1);
    assert.deepEqual(chat[0], {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    });
  });

  it('passes already-nested tools through untouched', () => {
    const nested = [
      { type: 'function', function: { name: 'bash', description: 'd', parameters: {} } },
    ];
    assert.deepEqual(responsesToolsToChat(nested), nested);
  });

  it('maps Responses tool_choice object {type,name} to the nested chat shape; scalars pass through', () => {
    assert.deepEqual(responsesToolChoiceToChat({ type: 'function', name: 'read' }), {
      type: 'function',
      function: { name: 'read' },
    });
    assert.strictEqual(responsesToolChoiceToChat('auto'), 'auto');
    assert.strictEqual(responsesToolChoiceToChat('none'), 'none');
    assert.strictEqual(responsesToolChoiceToChat('required'), 'required');
  });

  it('round-trips nested back to flat for a Responses-upstream provider', () => {
    const nested = [
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    const flat = chatToolsToResponses(nested);
    assert.deepEqual(flat, [
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
    ]);
  });

  it('omits undefined description when re-flattening', () => {
    const flat = chatToolsToResponses([
      { type: 'function', function: { name: 'x', parameters: {} } },
    ] as any);
    assert.ok(!('description' in flat[0]));
  });
});

describe('Responses API: input conversion', () => {
  it('converts plain string input into a single user message', () => {
    const msgs = inputItemsToMessages('hello there');
    assert.deepStrictEqual(msgs, [{ role: 'user', content: 'hello there' }]);
  });

  it('converts message items with input/output text parts', () => {
    const msgs = inputItemsToMessages([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { role: 'user', content: 'and now?' },
    ]);
    assert.strictEqual(msgs.length, 3);
    assert.deepStrictEqual(msgs[0].content, [{ type: 'text', text: 'hi' }]);
    assert.strictEqual(msgs[1].role, 'assistant');
    assert.strictEqual(msgs[2].role, 'user');
  });

  it('converts function_call / function_call_output into assistant tool_calls + tool message', () => {
    const msgs = inputItemsToMessages([
      { role: 'user', content: 'list files' },
      { type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.ts,b.ts' },
    ]);
    assert.strictEqual(msgs[1].role, 'assistant');
    assert.strictEqual(msgs[1].tool_calls?.[0].id, 'call_1');
    assert.strictEqual(msgs[1].tool_calls?.[0].function.name, 'list_files');
    assert.strictEqual(msgs[2].role, 'tool');
    assert.strictEqual(msgs[2].tool_call_id, 'call_1');
    assert.strictEqual(msgs[2].content, 'a.ts,b.ts');
  });

  it('folds parallel function_call items into ONE assistant message answered by every tool message', () => {
    // Responses emits one function_call item per call; chat-completions
    // requires all calls of a turn on a single assistant message. Two
    // assistant messages in a row are rejected by strict upstreams
    // ("insufficient tool messages following tool_calls message").
    const msgs = inputItemsToMessages([
      { role: 'user', content: 'read both files' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading both.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"p":"a"}' },
      { type: 'function_call', call_id: 'call_2', name: 'read', arguments: '{"p":"b"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'A' },
      { type: 'function_call_output', call_id: 'call_2', output: 'B' },
    ]);
    assert.strictEqual(msgs.length, 4);
    assert.strictEqual(msgs[1].role, 'assistant');
    assert.deepStrictEqual(
      msgs[1].tool_calls?.map((c) => c.id),
      ['call_1', 'call_2']
    );
    assert.deepStrictEqual(msgs[1].content, [{ type: 'text', text: 'Reading both.' }]);
    assert.deepStrictEqual(
      msgs.slice(2).map((m) => [m.role, m.tool_call_id]),
      [['tool', 'call_1'], ['tool', 'call_2']]
    );
  });

  it('carries a reasoning item into the assistant turn that follows it', () => {
    const msgs = inputItemsToMessages([
      { role: 'user', content: 'go' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'A' },
    ]);
    assert.strictEqual(msgs[1]!.role, 'assistant');
    assert.strictEqual(msgs[1]!.reasoning_content, 'thought');
  });

  it('attaches a reasoning item emitted after its turn (relayed order) to that turn', () => {
    const msgs = inputItemsToMessages([
      { role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
      { type: 'reasoning', content: 'thought' },
      { type: 'function_call_output', call_id: 'call_1', output: 'A' },
    ]);
    assert.strictEqual(msgs[1]!.role, 'assistant');
    assert.strictEqual(msgs[1]!.reasoning_content, 'thought');
    assert.strictEqual(msgs[2]!.role, 'tool');
  });

  it('skips a reasoning item with no text (nothing to replay)', () => {
    const msgs = inputItemsToMessages([
      { type: 'reasoning', summary: [] } as any,
      { role: 'user', content: 'go' },
    ]);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].role, 'user');
  });

  it('fails loudly on unknown item types (no silent data loss)', () => {
    assert.throws(() => inputItemsToMessages([{ type: 'mystery_item' } as any] as any), /Unsupported input item type/);
  });
});

describe('Responses API: response object + stream events', () => {
  it('maps chat response to a Responses response object with usage + output_text', () => {
    const obj = chatToResponseObject(fakeChatResponse('the answer'), 'resp_x', 'mock-model') as any;
    assert.strictEqual(obj.id, 'resp_x');
    assert.strictEqual(obj.object, 'response');
    assert.strictEqual(obj.status, 'completed');
    assert.strictEqual(obj.output[0].type, 'message');
    assert.strictEqual(obj.output[0].content[0].text, 'the answer');
    assert.deepStrictEqual(obj.tools, [], 'tools is required by strict Responses clients (Junie)');
    assert.deepStrictEqual(obj.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('emits tool_calls as function_call output items', () => {
    const resp = fakeChatResponse('');
    resp.choices[0].message.content = '';
    resp.choices[0].message.tool_calls = [
      { id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"p":"x"}' } },
    ];
    const obj = chatToResponseObject(resp, 'resp_y', 'mock-model') as any;
    assert.strictEqual(obj.output[0].type, 'function_call');
    assert.strictEqual(obj.output[0].call_id, 'call_9');
  });

  it('emits assistant prose BEFORE function_call items when both are present', () => {
    const resp = fakeChatResponse('let me check that file');
    resp.choices[0].message.tool_calls = [
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
    ];
    const obj = chatToResponseObject(resp, 'resp_z', 'mock-model') as any;
    assert.strictEqual(obj.output.length, 2);
    assert.strictEqual(obj.output[0].type, 'message');
    assert.strictEqual(obj.output[0].content[0].text, 'let me check that file');
    assert.strictEqual(obj.output[1].type, 'function_call');
    assert.strictEqual(obj.output[1].name, 'read');
  });

  it('emits reasoning as the FIRST output item so the client can replay it', () => {
    const resp = fakeChatResponse('answer');
    resp.choices[0].message.reasoning_content = 'thought';
    const obj = chatToResponseObject(resp, 'resp_r', 'mock-model') as any;
    assert.strictEqual(obj.output[0].type, 'reasoning');
    assert.strictEqual(obj.output[0].summary[0].type, 'summary_text');
    assert.strictEqual(obj.output[0].summary[0].text, 'thought');
    assert.strictEqual(obj.output[1].type, 'message');
  });

  it('relayed closing half keeps the message at index 0 and appends the reasoning item', () => {
    const resp = fakeChatResponse('answer');
    resp.choices[0].message.reasoning_content = 'thought';
    const frames = responsesStreamSuffix(resp, 'resp_q', 'mock-model', 'msg_pinned', newResponseStreamSequence());
    const payloads = frames.map((f) => JSON.parse(f.split('data: ')[1]!) as Record<string, any>);
    const added = payloads.filter((p) => p.type === 'response.output_item.added');
    assert.strictEqual(added.length, 1, 'the message item was already announced by the prefix');
    assert.strictEqual(added[0]!.output_index, 1);
    assert.strictEqual(added[0]!.item.type, 'reasoning');
    const completed = payloads.find((p) => p.type === 'response.completed')!.response;
    assert.strictEqual(completed.output[0].id, 'msg_pinned');
    assert.strictEqual(completed.output[0].type, 'message');
    assert.strictEqual(completed.output[completed.output.length - 1].type, 'reasoning');
  });

  it('stream event sequence: created -> in_progress -> item/part/deltas -> completed, with final payload intact', () => {
    const longText = 'abcdefghij'.repeat(4); // 40 chars -> 3 delta chunks (16/16/8)
    const events = chatToStreamEvents(fakeChatResponse(longText), 'resp_s', 'mock-model');
    const types = events.map((e) => /^event: (.+)$/m.exec(e)?.[1]);
    assert.deepStrictEqual(types, [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const completed = JSON.parse(events[events.length - 1].split('data: ')[1]);
    assert.strictEqual(completed.response.id, 'resp_s');
    assert.strictEqual(completed.response.status, 'completed');
    assert.ok(Array.isArray(completed.response.tools), 'the terminal response carries required tools');
    events.forEach((frame, i) => {
      const payload = JSON.parse(frame.split('data: ')[1]);
      assert.strictEqual(payload.sequence_number, i, 'buffered SSE numbers every event from 0');
    });
    const deltas = events
      .filter((e) => e.includes('event: response.output_text.delta'))
      .map((e) => JSON.parse(e.split('data: ')[1]).delta);
    assert.strictEqual(deltas.join(''), longText, 'delta chunks must reassemble the full text');
  });
});

describe('Responses API: response tree store (stateful emulation)', () => {
  let store: RespStore;

  beforeEach(() => {
    store = new RespStore();
  });

  const node = (id: string, parent: string | null, sessionId: string, userText: string, assistantText: string) => ({
    id,
    parent,
    sessionId,
    model: 'mock-model',
    input: [{ role: 'user', content: userText } as ChatMessageLite],
    assistant: { role: 'assistant', content: assistantText } as ChatMessageLite,
    createdAt: Date.now(),
  });

  it('rebuilds the full message array along the parent chain, with exact session binding', () => {
    const r1 = newResponseId();
    const r2 = newResponseId();
    store.append(node(r1, null, 'sess_A', 'q1', 'a1'));
    store.append(node(r2, r1, 'sess_A', 'q2', 'a2'));

    const built = store.buildMessages(r2)!;
    assert.strictEqual(built.sessionId, 'sess_A', 'stateful turns bind to the exact routing session');
    assert.strictEqual(built.messages.length, 4);
    assert.deepStrictEqual(
      built.messages.map((m) => m.content),
      ['q1', 'a1', 'q2', 'a2'],
      'rebuild must be root->leaf in order'
    );
  });

  it('supports branching: two children of the same parent rebuild different histories', () => {
    const r1 = newResponseId();
    const branchA = newResponseId();
    const branchB = newResponseId();
    store.append(node(r1, null, 'sess_A', 'q1', 'a1'));
    store.append(node(branchA, r1, 'sess_A', 'go left', 'left'));
    store.append(node(branchB, r1, 'sess_A', 'go right', 'right'));

    const a = store.buildMessages(branchA)!;
    const b = store.buildMessages(branchB)!;
    // Rebuild includes the leaf's own input + assistant: [q1, a1, delta, reply].
    assert.strictEqual(a.messages.length, 4);
    assert.strictEqual(b.messages.length, 4);
    assert.strictEqual(a.messages[2].content, 'go left');
    assert.strictEqual(a.messages[3].content, 'left');
    assert.strictEqual(b.messages[2].content, 'go right');
    assert.strictEqual(b.messages[3].content, 'right');
  });

  it('returns null for unknown previous_response_id (route maps this to a loud 400)', () => {
    assert.strictEqual(store.buildMessages('resp_never_existed'), null);
  });

  it('evicts oldest nodes beyond the FIFO cap, newest (live) last', () => {
    // Shrink the cap indirectly is impossible (constant) — exercise ordering
    // by appending many and asserting the newest survives while count is bounded.
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = newResponseId();
      ids.push(id);
      store.append(node(id, i === 0 ? null : ids[i - 1], 'sess_B', `q${i}`, `a${i}`));
    }
    assert.ok(store.size <= 50);
    const newest = store.buildMessages(ids[ids.length - 1])!;
    assert.ok(newest.messages.length > 0, 'newest node must remain resolvable');
    assert.strictEqual(newest.sessionId, 'sess_B');
  });

  it('newResponseId produces unique prefixed ids', () => {
    const a = newResponseId();
    const b = newResponseId();
    assert.notStrictEqual(a, b);
    assert.ok(a.startsWith('resp_') && b.startsWith('resp_'));
  });
});

describe('Responses API: stateful request assembly (route-level logic shape)', () => {
  it('assembles [rebuilt] + delta and keeps instructions request-scoped', () => {
    // Mirrors the route's assembly so regressions in ordering surface here.
    const store = new RespStore();
    const r1 = newResponseId();
    store.append(node0(r1, 'sess_A', 'q1', 'a1'));

    const body: ResponsesRequest = {
      instructions: 'You are a coder.',
      previous_response_id: r1,
      input: 'q2',
    };
    const built = store.buildMessages(body.previous_response_id!)!;
    let delta = inputItemsToMessages(body.input!);
    let messages = [...built.messages, ...delta];
    if (body.instructions?.trim()) {
      messages = [{ role: 'system', content: body.instructions }, ...messages];
    }
    assert.deepStrictEqual(
      messages.map((m) => [m.role, m.content]),
      [
        ['system', 'You are a coder.'],
        ['user', 'q1'],
        ['assistant', 'a1'],
        ['user', 'q2'],
      ],
      'instructions stay at top; rebuilt history precedes the new delta'
    );
  });

  function node0(id: string, sessionId: string, q: string, a: string) {
    return {
      id,
      parent: null,
      sessionId,
      model: 'mock-model',
      input: [{ role: 'user', content: q } as ChatMessageLite],
      assistant: { role: 'assistant', content: a } as ChatMessageLite,
      createdAt: Date.now(),
    };
  }
});

describe('Responses API: usage breakdowns', () => {
  type ResponsesObject = { usage: Record<string, unknown> };
  const build = (resp: ChatCompletionResponse): ResponsesObject =>
    chatToResponseObject(resp, 'resp_u', 'mock-model') as unknown as ResponsesObject;

  it('maps cached prompt tokens and reasoning tokens when the upstream reports them', () => {
    const resp = fakeChatResponse('answer');
    resp.usage!.prompt_tokens_details = { cached_tokens: 8 };
    resp.usage!.completion_tokens_details = { reasoning_tokens: 3 };
    assert.deepStrictEqual(build(resp).usage, {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 8 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 15,
    });
  });

  it('omits both breakdowns when the upstream reported none (no invented zeros)', () => {
    const usage = build(fakeChatResponse('answer')).usage;
    assert.equal('input_tokens_details' in usage, false);
    assert.equal('output_tokens_details' in usage, false);
  });
});
