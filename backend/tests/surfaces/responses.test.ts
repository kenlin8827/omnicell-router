import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRegistration } from '../../src/config/types.js';
import {
  canonicalToResponsesPayload,
  responsesInputToIR,
  responsesRequestToIR,
} from '../../src/ir/adapters/openai-responses.js';
import {
  OpenAIResponsesEventEncoder,
  canonicalToResponsesObject,
  defaultResponsesEcho,
  newResponseStreamSequence,
  responsesEventFrame,
  type ResponsesEcho,
} from '../../src/ir/adapters/openai-responses-output.js';
import { irToChatRequest } from '../../src/ir/adapters/openai-chat.js';
import { canonicalResponseToEvents } from '../../src/ir/stream.js';
import type { CanonicalResponse, OutputItem } from '../../src/ir/types.js';
import { RespStore, newResponseId, type RespNode } from '../../src/session/resp-store.js';

const model = { id: 'mock-model', upstreamModel: 'upstream-model' } as ModelRegistration;

function response(text: string, overrides: Partial<CanonicalResponse> = {}): CanonicalResponse {
  return {
    id: 'resp_source', createdAt: 1700000000, model: 'upstream-model', status: 'completed', reason: 'stop',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text }] }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...overrides,
  };
}

function stream(value: CanonicalResponse, echo: ResponsesEcho = defaultResponsesEcho()) {
  const encoder = new OpenAIResponsesEventEncoder('resp_stream', 'msg_stream', newResponseStreamSequence(), true, echo);
  return canonicalResponseToEvents(value).flatMap((event) => encoder.encode(event, 'mock-model', value));
}

describe('Responses request tools → IR', () => {
  it('preserves function tool fields and emits the flat Responses shape', () => {
    const ir = responsesRequestToIR({
      input: 'read', tools: [{
        type: 'function', name: 'read', description: 'Read a file', strict: true,
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    });
    assert.deepStrictEqual(ir.tools, [{
      type: 'function', function: {
        name: 'read', description: 'Read a file', strict: true,
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }]);
    const wire = canonicalToResponsesPayload(ir, model);
    assert.deepStrictEqual(wire.tools, [{
      type: 'function', name: 'read', description: 'Read a file', strict: true,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }]);
    assert.ok(!('function' in wire.tools[0]));
  });

  it('keeps custom and built-in tools instead of rejecting legal Responses tools', () => {
    const ir = responsesRequestToIR({
      input: 'go', tools: [
        { type: 'custom', name: 'code', format: { type: 'text' } },
        { type: 'web_search_preview', search_context_size: 'medium' },
      ],
    });
    assert.deepStrictEqual(ir.tools?.map((tool) => tool.type), ['custom', 'builtin']);
    assert.deepStrictEqual(canonicalToResponsesPayload(ir, model).tools, [
      { type: 'custom', name: 'code', format: { type: 'text' } },
      { type: 'web_search_preview', search_context_size: 'medium' },
    ]);
  });

  it('maps function, scalar and allowed_tools tool_choice values', () => {
    assert.deepStrictEqual(responsesRequestToIR({ input: 'x', tool_choice: { type: 'function', name: 'read' } }).toolChoice,
      { type: 'function', name: 'read' });
    for (const type of ['auto', 'none', 'required'] as const) {
      assert.deepStrictEqual(responsesRequestToIR({ input: 'x', tool_choice: type }).toolChoice, { type });
    }
    const allowed = { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read' }] };
    const ir = responsesRequestToIR({ input: 'x', tool_choice: allowed });
    assert.deepStrictEqual(canonicalToResponsesPayload(ir, model).tool_choice, allowed);
    assert.throws(() => responsesRequestToIR({ input: 'x', tool_choice: { type: 'mcp', server_label: 'x' } }), /tool_choice/);
  });
});

describe('Responses input → IR', () => {
  it('converts plain string input into one user message', () => {
    assert.deepStrictEqual(responsesInputToIR('hello there'), [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello there' }] },
    ]);
  });

  it('preserves message roles and text parts', () => {
    const input = responsesInputToIR([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { role: 'user', content: 'and now?' },
    ]);
    assert.deepStrictEqual(input.map((item) => item.type === 'message' ? item.role : item.type), ['user', 'assistant', 'user']);
    assert.deepStrictEqual(input[0], { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] });
  });

  it('keeps function calls and outputs as separate ordered items', () => {
    const input = responsesInputToIR([
      { role: 'user', content: 'list files' },
      { type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.ts,b.ts' },
    ]);
    assert.deepStrictEqual(input.map((item) => item.type), ['message', 'tool_call', 'tool_result']);
    const call = input[1]!;
    assert.ok(call.type === 'tool_call');
    assert.strictEqual(call.callId, 'call_1');
    const result = input[2]!;
    assert.ok(result.type === 'tool_result');
    assert.deepStrictEqual(result.content, [{ type: 'text', text: 'a.ts,b.ts' }]);
  });

  it('preserves parallel calls and their results without Chat-style folding', () => {
    const input = responsesInputToIR([
      { role: 'user', content: 'read both files' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading both.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"p":"a"}' },
      { type: 'function_call', call_id: 'call_2', name: 'read', arguments: '{"p":"b"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'A' },
      { type: 'function_call_output', call_id: 'call_2', output: 'B' },
    ]);
    assert.deepStrictEqual(input.map((item) => item.type), ['message', 'message', 'tool_call', 'tool_call', 'tool_result', 'tool_result']);
    assert.deepStrictEqual(input.slice(2, 4).map((item) => item.type === 'tool_call' ? item.callId : ''), ['call_1', 'call_2']);
  });

  it('preserves reasoning text, summaries, empty items and ordering', () => {
    const input = responsesInputToIR([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'after' }] },
      { type: 'reasoning', summary: [] },
    ]);
    assert.deepStrictEqual(input.map((item) => item.type), ['reasoning', 'tool_call', 'reasoning', 'reasoning']);
    assert.deepStrictEqual(input[0], { type: 'reasoning', summary: ['thought'] });
    assert.deepStrictEqual(input[2], { type: 'reasoning', text: 'after' });
    assert.deepStrictEqual(input[3], { type: 'reasoning', summary: [] });
  });

  it('preserves multimodal tool output parts', () => {
    const input = responsesInputToIR([{
      type: 'function_call_output', call_id: 'call_1',
      output: [{ type: 'input_text', text: 'line one' }, { type: 'input_text', text: 'line two' }],
    }]);
    assert.deepStrictEqual(input[0], {
      type: 'tool_result', callId: 'call_1',
      content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
    });
  });

  it('keeps refusal, image URL, file and file_id image inputs losslessly', () => {
    const input = responsesInputToIR([
      { role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] },
      { role: 'user', content: [
        { type: 'input_image', image_url: 'https://x/y.png', detail: 'high' },
        { type: 'input_image', file_id: 'img_1' },
        { type: 'input_file', file_id: 'file_1', filename: 'notes.pdf' },
      ] },
    ]);
    const assistant = input[0]!;
    assert.ok(assistant.type === 'message');
    assert.deepStrictEqual(assistant.content, [{ type: 'refusal', text: 'I cannot help with that.' }]);
    const user = input[1]!;
    assert.ok(user.type === 'message');
    assert.deepStrictEqual(user.content.map((part) => part.type), ['image', 'image', 'file']);
    assert.deepStrictEqual(canonicalToResponsesPayload({ model: 'auto', input }, model).input[1].content, [
      { type: 'input_image', image_url: 'https://x/y.png', detail: 'high' },
      { type: 'input_image', file_id: 'img_1' },
      { type: 'input_file', file_id: 'file_1', filename: 'notes.pdf' },
    ]);
  });

  it('keeps unknown items opaque and rejects them at a lossy Chat boundary', () => {
    const input = responsesInputToIR([{ type: 'mystery_item', value: 1 }]);
    assert.deepStrictEqual(input, [{ type: 'extension', protocol: 'openai-responses', payload: { type: 'mystery_item', value: 1 } }]);
    assert.throws(() => irToChatRequest({ model: 'auto', input }, 'upstream'), /extension item/);
  });

  it('rejects malformed media parts instead of degrading them to empty text', () => {
    assert.throws(() => responsesInputToIR([{ role: 'user', content: [{ type: 'input_file' }] }]), /input_file/);
    assert.throws(() => responsesInputToIR([{ role: 'user', content: [{ type: 'input_image' }] }]), /input_image/);
  });
});

describe('IR → Responses object and stream', () => {
  it('maps output text, required tools and usage', () => {
    const obj = canonicalToResponsesObject(response('the answer'), { respId: 'resp_x' }, 'mock-model') as any;
    assert.strictEqual(obj.id, 'resp_x');
    assert.strictEqual(obj.object, 'response');
    assert.strictEqual(obj.status, 'completed');
    assert.strictEqual(obj.output[0].content[0].text, 'the answer');
    assert.deepStrictEqual(obj.tools, []);
    assert.deepStrictEqual(obj.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('reports truncated and filtered turns as incomplete', () => {
    const truncated = canonicalToResponsesObject(response('partial', { status: 'incomplete', reason: 'length' }), { respId: 'resp_t' }, 'mock-model') as any;
    assert.strictEqual(truncated.status, 'incomplete');
    assert.deepStrictEqual(truncated.incomplete_details, { reason: 'max_output_tokens' });
    assert.strictEqual(truncated.error, null);
    const filtered = canonicalToResponsesObject(response('blocked', { status: 'incomplete', reason: 'content_filter' }), { respId: 'resp_f' }, 'mock-model') as any;
    assert.deepStrictEqual(filtered.incomplete_details, { reason: 'content_filter' });
  });

  it('echoes request parameters required by strict Response decoders', () => {
    const echo: ResponsesEcho = {
      ...defaultResponsesEcho(), instructions: 'be terse', metadata: { tenant: 'a' }, temperature: 0.2,
      top_p: null, max_output_tokens: 128, tool_choice: { type: 'function', name: 'read' },
      parallel_tool_calls: false, previous_response_id: 'resp_prev', service_tier: 'flex',
    };
    const obj = canonicalToResponsesObject(response('ok'), { respId: 'resp_e', messageId: 'msg_e' }, 'mock-model', true, echo) as any;
    assert.strictEqual(obj.instructions, 'be terse');
    assert.strictEqual(obj.temperature, 0.2);
    assert.strictEqual(obj.top_p, null);
    assert.strictEqual(obj.max_output_tokens, 128);
    assert.deepStrictEqual(obj.tool_choice, { type: 'function', name: 'read' });
    assert.strictEqual(obj.parallel_tool_calls, false);
    assert.strictEqual(obj.previous_response_id, 'resp_prev');
    assert.deepStrictEqual(obj.metadata, { tenant: 'a' });
    assert.strictEqual(obj.service_tier, 'flex');
    assert.strictEqual(obj.error, null);
    assert.strictEqual(obj.incomplete_details, null);
  });

  it('maps text.format and rejects malformed or unknown formats', () => {
    assert.deepStrictEqual(responsesRequestToIR({ input: 'x', text: { format: { type: 'json_object' } } }).text,
      { format: { type: 'json_object' } });
    assert.deepStrictEqual(responsesRequestToIR({
      input: 'x', text: { format: { type: 'json_schema', name: 'x', schema: { type: 'object' }, strict: true } },
    }).text, { format: { type: 'json_schema', name: 'x', schema: { type: 'object' }, strict: true } });
    assert.deepStrictEqual(responsesRequestToIR({ input: 'x', text: { format: { type: 'text' } } }).text, { format: { type: 'text' } });
    assert.throws(() => responsesRequestToIR({ input: 'x', text: { format: { type: 'json_schema' } } }), /name and schema/);
    assert.throws(() => responsesRequestToIR({ input: 'x', text: { format: { type: 'xml' } } }), /text\.format/);
  });

  it('ends truncated streams with response.incomplete', () => {
    const events = stream(response('partial', { status: 'incomplete', reason: 'length' }));
    const terminal = events.at(-1)!;
    assert.strictEqual(terminal.type, 'response.incomplete');
    assert.strictEqual((terminal.response as any).status, 'incomplete');
    assert.deepStrictEqual((terminal.response as any).incomplete_details, { reason: 'max_output_tokens' });
  });

  it('emits tool calls, prose and reasoning in canonical order', () => {
    const output: OutputItem[] = [
      { type: 'reasoning', id: 'rs_1', summary: ['thought'] },
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'let me check that file' }] },
      { type: 'tool_call', id: 'fc_1', callId: 'call_1', name: 'read', arguments: '{}' },
    ];
    const obj = canonicalToResponsesObject(response('', { output, reason: 'tool_calls' }), { respId: 'resp_y' }, 'mock-model') as any;
    assert.deepStrictEqual(obj.output.map((item: any) => item.type), ['reasoning', 'message', 'function_call']);
    assert.strictEqual(obj.output[0].summary[0].text, 'thought');
    assert.strictEqual(obj.output[1].content[0].text, 'let me check that file');
    assert.strictEqual(obj.output[2].call_id, 'call_1');
  });

  it('keeps a relayed message id stable when a later reasoning item arrives', () => {
    const final = response('answer', { output: [
      { type: 'message', id: 'msg_pinned', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { type: 'reasoning', id: 'rs_pinned', summary: ['thought'] },
    ] });
    const encoder = new OpenAIResponsesEventEncoder('resp_q', 'msg_pinned', newResponseStreamSequence(), true, defaultResponsesEcho());
    const payloads = [
      ...encoder.encode({ type: 'response.created', id: 'resp_q', model: 'mock-model' }, 'mock-model'),
      ...encoder.encode({ type: 'response.output_item.added', index: 0, item: final.output[0]! }, 'mock-model'),
      ...encoder.encode({ type: 'response.output_item.added', index: 1, item: final.output[1]! }, 'mock-model'),
      ...encoder.encode({ type: 'response.completed' }, 'mock-model', final),
    ];
    const added = payloads.filter((payload) => payload.type === 'response.output_item.added');
    assert.strictEqual(added.length, 2);
    assert.strictEqual(added[1]!.output_index, 1);
    const completed = payloads.find((payload) => payload.type === 'response.completed')!.response as any;
    assert.strictEqual(completed.output[0].id, 'msg_pinned');
    assert.strictEqual(completed.output[1].id, 'rs_pinned');
  });

  it('emits a complete lifecycle with monotonic sequence numbers and intact text', () => {
    const longText = 'abcdefghij'.repeat(4);
    const events = stream(response(longText));
    assert.deepStrictEqual(events.map((event) => event.type), [
      'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.completed',
    ]);
    const completed = events.at(-1)!.response as any;
    assert.strictEqual(completed.id, 'resp_stream');
    assert.strictEqual(completed.status, 'completed');
    assert.ok(Array.isArray(completed.tools));
    events.forEach((event, index) => assert.strictEqual(event.sequence_number, index));
    assert.strictEqual(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''), longText);
    assert.ok(events.every((event) => responsesEventFrame(event).endsWith('\n\n')));
  });
});

describe('Responses response tree store', () => {
  let store: RespStore;

  beforeEach(() => { store = new RespStore(); });

  const node = (id: string, parent: string | null, sessionId: string, userText: string, assistantText: string): RespNode => ({
    v: 2, id, parent, sessionId, model: 'mock-model',
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: userText }] }],
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: assistantText }] }],
    createdAt: Date.now(),
  });
  const texts = (items: RespNode['input']) => items.map((item) => item.type === 'message'
    ? item.content.map((part) => part.type === 'text' ? part.text : '').join('') : '');

  it('rebuilds canonical input root-to-leaf with exact session binding', () => {
    const r1 = newResponseId();
    const r2 = newResponseId();
    store.append(node(r1, null, 'sess_A', 'q1', 'a1'));
    store.append(node(r2, r1, 'sess_A', 'q2', 'a2'));
    const built = store.buildInput(r2)!;
    assert.strictEqual(built.sessionId, 'sess_A');
    assert.deepStrictEqual(texts(built.input), ['q1', 'a1', 'q2', 'a2']);
  });

  it('supports branches with independent histories', () => {
    const r1 = newResponseId();
    const branchA = newResponseId();
    const branchB = newResponseId();
    store.append(node(r1, null, 'sess_A', 'q1', 'a1'));
    store.append(node(branchA, r1, 'sess_A', 'go left', 'left'));
    store.append(node(branchB, r1, 'sess_A', 'go right', 'right'));
    assert.deepStrictEqual(texts(store.buildInput(branchA)!.input), ['q1', 'a1', 'go left', 'left']);
    assert.deepStrictEqual(texts(store.buildInput(branchB)!.input), ['q1', 'a1', 'go right', 'right']);
  });

  it('returns null for an unknown previous_response_id', () => {
    assert.strictEqual(store.buildInput('resp_never_existed'), null);
  });

  it('keeps the newest live chain resolvable under eviction', () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = newResponseId();
      ids.push(id);
      store.append(node(id, i === 0 ? null : ids[i - 1]!, 'sess_B', `q${i}`, `a${i}`));
    }
    assert.ok(store.size <= 50);
    const newest = store.buildInput(ids.at(-1)!)!;
    assert.ok(newest.input.length > 0);
    assert.strictEqual(newest.sessionId, 'sess_B');
  });

  it('generates unique prefixed response ids', () => {
    const a = newResponseId();
    const b = newResponseId();
    assert.notStrictEqual(a, b);
    assert.ok(a.startsWith('resp_') && b.startsWith('resp_'));
  });
});

describe('Responses stateful request assembly', () => {
  it('places rebuilt history before the delta and keeps instructions request-scoped', () => {
    const store = new RespStore();
    const r1 = newResponseId();
    store.append({
      v: 2, id: r1, parent: null, sessionId: 'sess_A', model: 'mock-model', createdAt: Date.now(),
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'q1' }] }],
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'a1' }] }],
    });
    const built = store.buildInput(r1)!;
    const parsed = responsesRequestToIR({ instructions: 'You are a coder.', previous_response_id: r1, input: 'q2' });
    const input = [...built.input, ...parsed.input];
    assert.strictEqual(parsed.instructions, 'You are a coder.');
    assert.deepStrictEqual(input.map((item) => item.type === 'message'
      ? item.content.map((part) => part.type === 'text' ? part.text : '').join('') : ''), ['q1', 'a1', 'q2']);
  });
});

describe('Responses usage breakdowns', () => {
  it('maps cached, reasoning and audio tokens without inventing zero details', () => {
    const detailed = canonicalToResponsesObject(response('answer', { usage: {
      inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 8, reasoningTokens: 3, audioOutputTokens: 2,
    } }), { respId: 'resp_u' }, 'mock-model') as any;
    assert.deepStrictEqual(detailed.usage, {
      input_tokens: 10, input_tokens_details: { cached_tokens: 8 }, output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 3, audio_tokens: 2 }, total_tokens: 15,
    });
    const plain = canonicalToResponsesObject(response('answer'), { respId: 'resp_p' }, 'mock-model') as any;
    assert.equal('input_tokens_details' in plain.usage, false);
    assert.equal('output_tokens_details' in plain.usage, false);
  });
});
