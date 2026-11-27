import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicRequestToIR, anthropicResponseToIR } from '../../src/ir/adapters/anthropic-messages.js';
import { AnthropicMessagesStreamDecoder } from '../../src/ir/adapters/anthropic-messages-stream.js';
import { chatRequestToIR, chatResponseToIR } from '../../src/ir/adapters/openai-chat.js';
import { ChatStreamDecoder } from '../../src/ir/adapters/openai-chat-stream.js';
import { GoogleGeminiStreamDecoder } from '../../src/ir/adapters/google-gemini-stream.js';
import { canonicalToResponsesPayload, responsesInputToIR, responsesResponseToIR } from '../../src/ir/adapters/openai-responses.js';
import { OpenAIResponsesStreamDecoder } from '../../src/ir/adapters/openai-responses-stream.js';
import { mintToolCallId } from '../../src/ir/tool-identity.js';
import { RESPONSES_CALL_ID_MAX_LEN } from '../../src/config/defaults.js';
import { RespStore } from '../../src/session/resp-store.js';
import { repairToolCallPairing } from '../../src/pipeline/tool-pairing.js';
import type { ModelRegistration } from '../../src/config/types.js';
import type { CanonicalResponse, InputItem, OutputItem, StreamEvent } from '../../src/ir/types.js';

const model = { id: 'p/m', provider: 'p', upstreamModel: 'm' } as ModelRegistration;

type ToolCall = Extract<OutputItem, { type: 'tool_call' }>;
const toolCalls = (output: OutputItem[]): ToolCall[] => output.filter((item) => item.type === 'tool_call') as ToolCall[];

/**
 * A tool call that arrives with NO correlation id is named at the moment the upstream
 * response is READ, in canonical state — not at wire-render time. Canonical state is what
 * capture archives, what the `store: true` conversation tree replays, and what every
 * outbound carrier renders from, so one mint gives the client, the operator's record and
 * the next turn ONE name for one call.
 *
 * The failure this pins was silent in one direction and loud in the other: a lenient
 * OpenAI-compatible server that omits `tool_calls[].id` produced canonical items with an
 * empty id; the wire leg minted a random anchor the client then echoed back; and the stored
 * turn kept `callId: ''`. On the NEXT turn of a `previous_response_id` chain the gateway
 * rendered its own history and answered `400 tool_call_id` — a request the client did
 * nothing wrong with, failing on state the gateway wrote. A positional fallback mint
 * (`call_<candidate>_<index>`, the previous chat-stream spelling) is the other half of the
 * bug: it repeats the same id for the same position of every response, so two turns of one
 * session carry two calls under one correlation id and the upstream merges their results.
 */
describe('an unnamed upstream tool call is minted once, in canonical state', () => {
  // The gateway namespace, not the entropy width: widening the mint must not force every test
  // that names a minted id to change with it.
  const shape = /^call_[0-9a-f]{16,}$/;
  const lenientChat = (id: string) => ({
    id, object: 'chat.completion', created: 1, model: 'm',
    choices: [{
      index: 0, finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { index: 0, type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
          { index: 1, type: 'function', function: { name: 'read', arguments: '{"p":"b"}' } },
        ],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  } as never);

  it('mints on every reader, in one namespace, and never reuses a position', () => {
    const readers: [string, OutputItem[]][] = [
      ['openai-chat buffered', toolCalls(chatResponseToIR(lenientChat('cmpl_1')).output)],
      ['openai-chat stream', toolCalls(toolCallsFromStream())],
      ['openai-responses buffered', toolCalls(responsesResponseToIR({
        id: 'resp_u', model: 'm', status: 'completed',
        output: [
          { type: 'function_call', name: 'read', arguments: '{"p":"a"}' },
          { type: 'function_call', call_id: '', name: 'read', arguments: '{"p":"b"}' },
        ],
      } as never).output)],
      ['anthropic-messages buffered', toolCalls(anthropicResponseToIR({
        id: 'msg_u', role: 'assistant', model: 'm', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'read', input: {} }],
      } as never).output)],
      ['anthropic-messages inbound history', toolCalls(anthropicRequestToIR({
        model: 'auto', max_tokens: 16,
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'read', input: {} }] }],
      } as never).input as unknown as OutputItem[])],
    ];

    for (const [name, calls] of readers) {
      assert.ok(calls.length >= 1, `${name}: the reader must see the call`);
      for (const call of calls) {
        assert.ok(call.id && call.callId, `${name}: both id slots must be named`);
        assert.equal(call.id, call.callId, `${name}: the two slots are ONE anchor`);
        assert.match(call.id ?? '', shape, `${name}: minted in the gateway namespace`);
        assert.ok((call.id ?? '').length <= RESPONSES_CALL_ID_MAX_LEN, `${name}: inside the field budget`);
        assert.match(call.id ?? '', new RegExp(`^[A-Za-z0-9_-]{1,${RESPONSES_CALL_ID_MAX_LEN}}$`), `${name}: inside the shared charset`);
      }
      if (calls.length > 1) {
        assert.notEqual(calls[0]?.id, calls[1]?.id, `${name}: two calls of one response never share a name`);
      }
    }

    // Position-free: the same shape on a later response is a different name, so a replayed
    // history never holds two calls under one correlation id.
    const again = toolCalls(chatResponseToIR(lenientChat('cmpl_2')).output);
    assert.notEqual(again[0]?.id, toolCalls(chatResponseToIR(lenientChat('cmpl_1')).output)[0]?.id);
  });

  it('replays a stored turn of an id-less upstream without refusing its own history', () => {
    const response: CanonicalResponse = chatResponseToIR(lenientChat('cmpl_1'));
    const store = new RespStore();
    store.append({
      v: 2, id: 'resp_1', parent: null, sessionId: 's1', model: 'p/m',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'go' }] }],
      output: response.output, createdAt: Date.now(),
    });

    // What the client was handed on the wire, and what it answers with.
    const built = store.buildInput('resp_1');
    assert.ok(built);
    const wireCalls = toolCalls(response.output);
    const results: InputItem[] = wireCalls.map((call, index) => ({
      type: 'tool_result', callId: call.callId ?? '', content: [{ type: 'text', text: `RESULT ${index}` }],
    }));
    const history = [...(built?.input ?? []), ...results];

    const repair = repairToolCallPairing(history);
    assert.equal(repair.orphans, 0, 'the stored call and the client result carry ONE name');
    assert.equal(repair.synthesized, 0, 'no real result may be replaced by a cancelled placeholder');

    const payload = canonicalToResponsesPayload({ model: 'auto', stream: false, input: repair.input } as never, model);
    const rendered = (payload.input as { type: string; call_id?: string }[])
      .filter((item) => item.type === 'function_call' || item.type === 'function_call_output');
    assert.equal(rendered.length, 4);
    assert.deepEqual(rendered.slice(0, 2).map((item) => item.call_id), rendered.slice(2).map((item) => item.call_id),
      'a call and its result leave the gateway with the same correlation id');
  });

  it('mints are unique and inside the shape on their own', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintToolCallId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, shape);
  });
});

/**
 * One item is often READ more than once — a Responses stream sends `output_item.added` and
 * `output_item.done`, and the accumulator lets the later frame REPLACE the earlier one
 * (`ir/stream.ts`). A mint that happens per read therefore gives one call two canonical names,
 * and the name a client was handed mid-stream is not the name its tool result pairs against.
 * The stream legs must name an unnamed call ONCE per output index.
 */
describe('a minted name survives every re-read of one item', () => {
  it('names a Responses stream tool call once across added, done and both slots', () => {
    const decoder = new OpenAIResponsesStreamDecoder();
    const frame = (type: string) => ({
      type,
      output_index: 0,
      item: { type: 'function_call', name: 'read', arguments: '{"p":"a"}' },
    });
    const events = [...decoder.push(frame('response.output_item.added')), ...decoder.push(frame('response.output_item.done'))];
    const items = events
      .filter((event) => event.type.startsWith('response.output_item'))
      .map((event) => event.item) as ToolCall[];
    assert.equal(items.length, 2);
    const [added, done] = items;
    assert.ok(added?.id && added.id === done?.id, 'one item, one name on both frames');
    assert.equal(added?.callId, added?.id);
    assert.equal(done?.callId, done?.id);

    // A second unnamed item is a different call, so it never inherits the first name.
    const other = new OpenAIResponsesStreamDecoder();
    const second = other.push({
      type: 'response.output_item.added', output_index: 1,
      item: { type: 'function_call', name: 'read', arguments: '{"p":"b"}' },
    })[0];
    assert.ok(second.type === 'response.output_item.added' && second.item.type === 'tool_call');
    assert.notEqual(second.item.id, added?.id);

    // An id the upstream DID send is never rewritten, even when another item in the same
    // response needed a mint.
    const kept = decoder.push({
      type: 'response.output_item.added', output_index: 2,
      item: { type: 'function_call', call_id: 'call_upstream_1', name: 'read', arguments: '{}' },
    })[0];
    assert.ok(kept.type === 'response.output_item.added' && kept.item.type === 'tool_call');
    assert.equal(kept.item.callId, 'call_upstream_1');
  });

  it('names an Anthropic stream tool_use the way the buffered leg names it', () => {
    const decoder = new AnthropicMessagesStreamDecoder();
    const events = [
      ...decoder.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'read' } }),
      ...decoder.push({ type: 'content_block_stop', index: 0 }),
    ];
    const items = events
      .filter((event) => event.type.startsWith('response.output_item'))
      .map((event) => event.item) as ToolCall[];
    assert.ok(items.length >= 2, 'the stream leg emits both lifecycle frames');
    for (const item of items) {
      assert.match(item.id ?? '', /^call_[0-9a-f]{16,}$/, 'the stream leg is not the one leg that leaves a call unnamed');
      assert.equal(item.callId, item.id);
    }
    assert.equal(items[0]?.id, items[items.length - 1]?.id, 'one item, one name');
  });

  it('keeps a Gemini mint inside the charset both Responses id fields share', () => {
    const decoder = new GoogleGeminiStreamDecoder();
    const events = decoder.push({
      candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { p: 'a' } } }] } }],
    });
    const item = events.find((event) => event.type === 'response.output_item.added')?.item;
    assert.ok(item && item.type === 'tool_call');
    assert.match(item.id ?? '', /^[A-Za-z0-9_-]+$/, 'no separator a downstream carrier would have to digest away');
  });
});

/**
 * The request plane is the ONE place a mint must NOT appear. A harness resends the whole
 * history on every turn, so a name invented while READING a client body differs per resend and
 * the outbound prefix changes bytes each turn — a cold cache the client cannot see or fix
 * (AGENTS.md: prefix stability is part of the cache gate). An empty `call_id` therefore stays
 * empty here, and the outbound gate refuses the body instead of renaming it.
 */
describe('the request plane renames nothing', () => {
  const unnamed = [
    { type: 'message', role: 'user', content: 'HI' },
    { type: 'function_call', name: 'read', arguments: '{"p":"a"}' },
    { type: 'function_call_output', call_id: '', output: 'R1' },
  ];
  const named = [
    { type: 'message', role: 'user', content: 'HI' },
    { type: 'function_call', id: 'call_upstream_9', name: 'read', arguments: '{"p":"a"}' },
    { type: 'function_call_output', call_id: 'call_upstream_9', output: 'R1' },
  ];

  it('is byte-stable across identical resends', () => {
    const canonical = (input: unknown[]) => JSON.stringify(responsesInputToIR(input));
    const render = (input: unknown[]) => JSON.stringify(
      canonicalToResponsesPayload({ model: 'auto', input: responsesInputToIR(input) } as never, model).input,
    );
    assert.equal(canonical(unnamed), canonical(unnamed), 'even a malformed body must not change canonical bytes per resend');
    assert.equal(render(named), render(named), 'a body the client named renders identically every resend');
  });

  it('keeps an empty call_id empty in canonical state, and refuses it outbound', () => {
    const items = responsesInputToIR(unnamed);
    const call = toolCalls(items as unknown as OutputItem[])[0];
    assert.equal(call?.id, '', 'the gateway invents nothing on the request plane');
    assert.equal(call?.callId, '');
    assert.throws(
      () => canonicalToResponsesPayload({ model: 'auto', input: items } as never, model),
      (error: unknown) => (error as { code?: string }).code === 'tool_call_id',
      'a nameless correlation is refused with a field-named error, not forwarded as an empty string',
    );
  });

  it('lets an item id name a call whose call_id is empty, deterministically', () => {
    const call = toolCalls(responsesInputToIR([
      { type: 'function_call', id: 'fc_alias', call_id: '', name: 'read', arguments: '{}' },
    ]) as unknown as OutputItem[])[0];
    assert.equal(call?.callId, 'fc_alias');
    assert.equal(call?.id, 'fc_alias');
  });
});

/** Drive the chat stream decoder to completion and return the assembled tool calls. */
function toolCallsFromStream(): OutputItem[] {
  const decoder = new ChatStreamDecoder();
  const events: StreamEvent[] = [];
  events.push(...decoder.push({
    id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
    choices: [{
      index: 0, finish_reason: null,
      delta: { role: 'assistant', tool_calls: [
        { index: 0, type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
        { index: 1, type: 'function', function: { name: 'read', arguments: '{"p":"b"}' } },
      ] } as never,
    }],
  } as never));
  events.push(...decoder.push({
    id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
    choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }],
  } as never));
  events.push(...decoder.finish());
  const items: OutputItem[] = [];
  for (const event of [...events, ...decoder.finish()]) {
    if (event.type === 'response.output_item.added' && event.item.type === 'tool_call') items.push(event.item);
  }
  return items;
}
