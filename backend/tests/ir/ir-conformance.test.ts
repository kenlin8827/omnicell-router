import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { ModelRegistration } from '../../src/config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../src/ir/types.js';
import {
  chatRequestToIR,
  chatResponseToIR,
  irToChatRequest,
  irToChatResponse,
} from '../../src/ir/adapters/openai-chat.js';
import {
  canonicalToResponsesPayload,
  responsesCallId,
  responsesRequestToIR,
  responsesResponseToIR,
  responsesToolItemId,
} from '../../src/ir/adapters/openai-responses.js';
import { RESPONSES_CALL_ID_MAX_LEN, RESPONSES_TOOL_ITEM_ID_MAX_LEN } from '../../src/config/defaults.js';
import { CALL_ID_PREFIX } from '../../src/ir/tool-identity.js';
import { repairToolCallPairing } from '../../src/pipeline/tool-pairing.js';
import type { InputItem } from '../../src/ir/types.js';
import {
  OpenAIResponsesEventEncoder,
  canonicalToResponsesObject,
  defaultResponsesEcho,
  newResponseStreamSequence,
} from '../../src/ir/adapters/openai-responses-output.js';
import {
  anthropicRequestToIR,
  canonicalToAnthropicPayload,
  canonicalToAnthropicResponse,
} from '../../src/ir/adapters/anthropic-messages.js';
import { canonicalToGooglePayload, googleResponseToIR } from '../../src/ir/adapters/google-gemini.js';
import { IrUnsupportedError } from '../../src/ir/errors.js';
import {
  canonicalResponseToEvents,
  createEventAccumulator,
} from '../../src/ir/stream.js';
import { ChatEventEncoder, ChatStreamDecoder } from '../../src/ir/adapters/openai-chat-stream.js';

const model: ModelRegistration = {
  id: 'p/model', provider: 'p', upstreamModel: 'upstream-model', tier: 'plus',
  pricing: { input: 1, output: 1, cacheRead: 0.1 },
};

function response(output: CanonicalResponse['output'], usage: Partial<CanonicalResponse['usage']> = {}): CanonicalResponse {
  return {
    id: 'resp_1', model: 'upstream-model', createdAt: 1, status: 'completed', reason: 'stop', output,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, ...usage },
  };
}

function userText(text: string): CanonicalRequest['input'][number] {
  return { type: 'message', role: 'user', content: [{ type: 'text', text }] };
}

describe('canonical IR conformance', () => {
  it('preserves reasoning, text and tool order with distinct item and call ids', () => {
    const ir = responsesRequestToIR({
      model: 'auto',
      input: [
        { type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: 'think' }], encrypted_content: 'opaque' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    });
    assert.deepEqual(ir.input.map((item) => item.type), ['reasoning', 'message', 'tool_call', 'tool_result']);
    assert.deepEqual(ir.input[2], {
      type: 'tool_call', id: 'fc_1', callId: 'call_1', name: 'read', arguments: '{"path":"a.ts"}',
    });
    const payload = canonicalToResponsesPayload(ir, model);
    assert.equal(payload.input[0].encrypted_content, 'opaque');
    assert.equal(payload.input[2].id, 'fc_1');
    assert.equal(payload.input[2].call_id, 'call_1');
    assert.equal(payload.input[3].call_id, 'call_1');
  });

  it('derives prefixed Responses item ids for history from carriers that have none', () => {
    const ir = chatRequestToIR({
      model: 'auto',
      messages: [
        {
          role: 'assistant', content: '',
          tool_calls: [
            { id: 'call_0123456789abcdef', type: 'function', function: { name: 'read', arguments: '{}' } },
            { id: 'toolu_01ABC', type: 'function', function: { name: 'write', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0123456789abcdef', content: 'a' },
        { role: 'tool', tool_call_id: 'toolu_01ABC', content: 'b' },
      ],
    });
    const payload = canonicalToResponsesPayload(ir, model);
    const calls = (payload.input as { type: string; id?: string; call_id?: string }[])
      .filter((item) => item.type === 'function_call');
    const [first, second] = calls;
    assert.equal(first.id, 'fc_call_0123456789abcdef', 'chat call ids are not valid Responses item ids');
    assert.equal(first.call_id, 'call_0123456789abcdef');
    assert.equal(second.id, 'fc_toolu_01ABC');
    assert.equal(second.call_id, 'toolu_01ABC');
    assert.equal((payload.input as { call_id?: string }[])[2].call_id, 'call_0123456789abcdef');
    assert.equal(
      JSON.stringify(canonicalToResponsesPayload(ir, model).input), JSON.stringify(payload.input),
      'the derived id must be stable across turns or the replayed prefix busts the prompt cache',
    );

    // Injective even for hostile ids: the chat client owns these strings, and a
    // sanitize/truncate transform would silently merge two calls onto one id.
    assert.notEqual(responsesToolItemId('call_a.b', false), responsesToolItemId('call_a:b', false));
    const long = 'x'.repeat(49);
    assert.notEqual(responsesToolItemId(long, false), responsesToolItemId(long.slice(0, 48), false));
    assert.match(responsesToolItemId(long, false), /^fc_[0-9a-f]{48}$/);
    assert.equal(responsesToolItemId(long, false), responsesToolItemId(long, false));

    const custom: CanonicalRequest = {
      model: 'auto',
      stream: false,
      input: [{
        type: 'tool_call', id: 'call_custom', callId: 'call_custom', name: 'freeform', arguments: '{}',
        vendor: { 'openai-responses': { itemType: 'custom_tool_call' } },
      }],
    };
    const customPayload = canonicalToResponsesPayload(custom, model);
    assert.equal(customPayload.input[0].id, 'ctc_call_custom');
    assert.equal(customPayload.input[0].call_id, 'call_custom');

    const native = responsesRequestToIR({
      model: 'auto',
      input: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}' }],
    });
    assert.equal(canonicalToResponsesPayload(native, model).input[0].id, 'fc_1', 'an item id is replayed verbatim');
  });

  it('fits the outbound Responses call_id into the field budget and never touches a legal one', () => {
    // The correlation id is not ours: a chat client owns tool_calls[].id, and the
    // cursor-gateway plugin's agent loop re-injects the id a PREVIOUS upstream minted
    // (its `tc.id`). An over-long one
    // used to leave verbatim and a strict Responses upstream answers 400.
    const long = `call_${'a'.repeat(40)}_${'b'.repeat(39)}`;
    assert.equal(long.length, 85);
    // The boundary is INCLUSIVE: an id of exactly the budget is legal and must leave
    // byte-identical (a one-off `<=` versus `<` mistake would silently digest half of all
    // traffic and change the id namespace clients see).
    const exact = 'c'.repeat(RESPONSES_CALL_ID_MAX_LEN);
    assert.equal(responsesCallId(exact), exact, 'an exactly-in-budget id is not rewritten');

    const entries: CanonicalRequest[] = [
      chatRequestToIR({
        model: 'auto',
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant', content: null,
            tool_calls: [{ id: long, type: 'function', function: { name: 'read', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: long, content: 'ok' },
        ],
      }),
      anthropicRequestToIR({
        model: 'auto', max_tokens: 16,
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: long, name: 'read', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: long, content: 'ok' }] },
        ],
      }),
    ];

    for (const ir of entries) {
      const payload = canonicalToResponsesPayload(ir, model);
      const items = payload.input as { type: string; call_id?: string }[];
      const call = items.find((item) => item.type === 'function_call');
      const result = items.find((item) => item.type === 'function_call_output');
      assert.ok(call && result, 'both legs of the pair must be emitted');
      assert.ok((call.call_id as string).length <= RESPONSES_CALL_ID_MAX_LEN);
      assert.equal(call.call_id, result.call_id, 'a rewritten id must still pair the call with its result');
      assert.equal(
        JSON.stringify(canonicalToResponsesPayload(ir, model).input), JSON.stringify(payload.input),
        'the rewritten id must be stable across turns or the replayed prefix busts the prompt cache',
      );
    }

    // The outbound RESPONSE leg deliberately does not project `call_id`. The claim is
    // FIELD-scoped: the same leg bounds item ids through `responsesToolItemId`, so saying
    // it projects nothing would misdescribe the item id beside it. Canonical state
    // (`CanonicalResponse.output[].callId`) and the session store a `store: true`
    // chain replays keep the ORIGINAL id, because projecting there would break the
    // other carriers (Anthropic `tool_use.id` has its own length rule). A digest
    // handed to the client would therefore meet the original in the next turn's
    // history as an unpaired orphan, and `repairToolCallPairing` would overwrite the
    // client's real result with "Tool call was cancelled before returning a result."
    // — silent data loss, which is worse than the 400 this whole map exists to avoid.
    const object = canonicalToResponsesObject(
      response([{ type: 'tool_call', id: long, callId: long, name: 'read', arguments: '{}' }]),
      { respId: 'resp_1' }, 'served',
    );
    assert.equal(
      (object.output as { call_id?: string }[])[0].call_id, long,
      'the client keeps the id the upstream minted, or the replayed chain splits into two naming planes',
    );

    // The same claim from the pairing side: one plane pairs, a split plane does not.
    const call: InputItem = { type: 'tool_call', id: 'fc_1', callId: long, name: 'read', arguments: '{}' };
    const resultFor = (callId: string): InputItem =>
      ({ type: 'tool_result', callId, content: userText('REAL RESULT').content });
    assert.deepEqual(
      [repairToolCallPairing([call, resultFor(long)]).synthesized, repairToolCallPairing([call, resultFor(long)]).orphans],
      [0, 0], 'originals on both legs stay paired',
    );
    assert.equal(
      repairToolCallPairing([call, resultFor(responsesCallId(long))]).orphans, 1,
      'a split plane WOULD orphan the result — pinned so the response leg keeps the ORIGINAL `call_id`',
    );

    // A projection: a client replaying an id the gateway already rewrote must not
    // get a second, different name for the same call.
    assert.equal(responsesCallId(responsesCallId(long)), responsesCallId(long));
    // Not a truncation: ids sharing the whole budget prefix stay distinct, and the
    // hashed form keeps the shape consumers (and operator greps) key on.
    assert.notEqual(responsesCallId(long), responsesCallId(`${long.slice(0, RESPONSES_CALL_ID_MAX_LEN)}tail`));
    assert.equal(responsesCallId(long).length, RESPONSES_CALL_ID_MAX_LEN);
    assert.ok(responsesCallId(long).startsWith('call_'), 'a hashed id must not lose the shape consumers key on');
    // Whitespace is hashed, never trimmed: stripping would make `a b` and `ab` one
    // correlation id, and a merged id merges two tool results onto one call.
    assert.notEqual(responsesCallId('call_a b'), responsesCallId('call_ab'));
    assert.notEqual(responsesCallId('call_a b'), 'call_a b');
    // The budget and the charset are BOTH rules, and the boundary is inclusive.
    const edge = CALL_ID_PREFIX + 'z'.repeat(RESPONSES_CALL_ID_MAX_LEN - CALL_ID_PREFIX.length);
    assert.equal(edge.length, RESPONSES_CALL_ID_MAX_LEN);
    assert.equal(responsesCallId(edge), edge, 'an id exactly at the budget is legal and must not be renamed');
    assert.notEqual(responsesCallId(edge + 'z'), edge + 'z');
    assert.notEqual(responsesCallId('call.a:b'), responsesCallId('call.a$b'));
    assert.notEqual(responsesCallId('call.a:b'), 'call.a:b');
    // In-budget ids leave byte-identical, so the shape carriers key on survives.
    assert.equal(responsesCallId('call_0123456789abcdef'), 'call_0123456789abcdef');
    assert.equal(responsesCallId('toolu_01ABC'), 'toolu_01ABC');

    // A built-in extension item carries `call_id` too, and passthrough is not
    // exemption on the leg we control — but the caller's payload is COPIED, since
    // that same object is what capture and the session store read.
    const extPayload = { type: 'web_search_call', call_id: long, status: 'completed' };
    const ext = canonicalToResponsesPayload({
      model: 'auto', stream: false,
      input: [{ type: 'extension', protocol: 'openai-responses', payload: extPayload }],
    } as unknown as CanonicalRequest, model);
    assert.equal((ext.input as Record<string, unknown>[])[0].call_id, responsesCallId(long));
    assert.equal(extPayload.call_id, long, 'normalising in place would edit the recorded client prompt');

    // The item-id budget is a SEPARATE, narrower field rule (its id carries an
    // item-type prefix); both share one charset, and neither truncates the original.
    assert.ok(responsesToolItemId(long, false).length <= 'fc_'.length + RESPONSES_TOOL_ITEM_ID_MAX_LEN);
    assert.ok(responsesToolItemId(long, false).startsWith('fc_'));
    assert.notEqual(responsesToolItemId(long, false), responsesToolItemId(long, true));
    assert.equal(responsesToolItemId('call_0123456789abcdef', false), 'fc_call_0123456789abcdef');

    // An unlabelled tool item has no faithful Responses representation: refuse in
    // the plane's own envelope instead of minting a placeholder all such calls share.
    assert.throws(
      () => canonicalToResponsesPayload({
        model: 'auto', stream: false,
        input: [{ type: 'tool_result', callId: '', content: [userText('x').content[0]] }],
      } as CanonicalRequest, model),
      (error: unknown) => error instanceof IrUnsupportedError && error.code === 'tool_call_id',
    );
  });

  it('names an id-less tool call on every leg so the client can answer it', () => {
    // A lenient upstream returns `tool_calls[]` with no id (the chat adapter records `''`).
    // `responsesToolItemId('')` used to digest the EMPTY STRING, which is a constant: every
    // id-less call in one response collapsed onto one item id, and `call_id` went out empty
    // — a correlation id no reply can name, and one the outbound budget then refuses when
    // the client replays it. Both slots now share ONE minted anchor per call.
    const idless = response([
      { type: 'tool_call', id: '', callId: '', name: 'read', arguments: '{"path":"a"}' },
      { type: 'tool_call', id: '', callId: '', name: 'read', arguments: '{"path":"b"}' },
    ]);
    const items = (canonicalToResponsesObject(idless, { respId: 'resp_1' }, 'served')
      .output as { id: string; call_id: string }[]);
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.ok(item.id && item.call_id, 'both id slots must carry a name');
      assert.ok(item.id.length <= 'fc_'.length + RESPONSES_TOOL_ITEM_ID_MAX_LEN);
      assert.ok(item.call_id.length <= RESPONSES_CALL_ID_MAX_LEN, 'a minted id must satisfy our own gate');
      assert.equal(item.id, item.call_id, 'one anchor per call, on both slots');
    }
    assert.notEqual(items[0].id, items[1].id, 'id-less calls must not share one item id');

    // Same pair through the streaming encoder: the id a client first sees must be the id
    // the terminal response reports, or a client that keyed on it loses the item.
    const encoder = new OpenAIResponsesEventEncoder('resp_1', 'msg_1', newResponseStreamSequence(), true, defaultResponsesEcho());
    const wire = canonicalResponseToEvents(idless).flatMap((event) => encoder.encode(event, 'served', idless));
    const added = wire.filter((event) => event.type === 'response.output_item.added')
      .map((event) => event.item as { id: string; call_id: string });
    const final = (wire.at(-1)?.response as { output: { id: string; call_id: string }[] } | undefined)?.output ?? [];
    assert.deepEqual(added.map((item) => item.id), final.map((item) => item.id));
    assert.equal(new Set(added.map((item) => item.id)).size, 2);
    assert.ok(added.every((item) => item.call_id === item.id));

    // The shape that actually arrives from such an upstream, end to end.
    const fromUpstream = chatResponseToIR({
      id: 'cmpl_1', model: 'upstream-model', object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
        { index: 0, id: '', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
        { index: 1, type: 'function', function: { name: 'read', arguments: '{"p":"b"}' } },
      ] } }],
    } as never);
    const upstreamItems = (canonicalToResponsesObject(fromUpstream, { respId: 'resp_2' }, 'served')
      .output as { id: string; call_id: string }[]);
    assert.equal(new Set(upstreamItems.map((item) => item.id)).size, 2, 'a missing id is not one shared id');

    // A call that HAS a correlation id but no item id keeps that id untouched — the anchor
    // is a last resort, never a rewrite of a name the client already holds.
    const halfNamed = (canonicalToResponsesObject(response([
      { type: 'tool_call', id: '', callId: 'call_zz', name: 'read', arguments: '{}' },
    ]), { respId: 'resp_3' }, 'served').output as { id: string; call_id: string }[]);
    assert.equal(halfNamed[0].call_id, 'call_zz');
    assert.equal(halfNamed[0].id, 'fc_call_zz');

    // An EMPTY `call_id` beside a real item id is what a client replays for a turn stored
    // before the anchor existed: the item id rescues it instead of a 400 on our own history.
    const replay = canonicalToResponsesPayload({
      model: 'auto', stream: false,
      input: [{ type: 'tool_call', id: 'fc_anchor', callId: '', name: 'read', arguments: '{}' }],
    } as CanonicalRequest, model);
    assert.equal((replay.input as { call_id: string }[])[0].call_id, 'fc_anchor');
  });

  it('keeps a passthrough built-in item id on both legs without writing through the payload', () => {
    // A same-protocol built-in (`web_search_call`, `mcp_call`) carries its name INSIDE the
    // payload. The stream leg used to read only the wrapper, so it minted an `fc_` name, and
    // then ASSIGNED it onto the payload object: the buffered leg showed the vendor id, the
    // stream showed a mint, and the captured copy of the upstream response was edited in
    // place. One id on both legs, and the canonical object stays untouched.
    const payload = { type: 'web_search_call', id: 'ws_1', call_id: 'call_ws_1', status: 'completed' };
    const builtIn = response([{ type: 'extension', protocol: 'openai-responses', payload }]);
    const buffered = (canonicalToResponsesObject(builtIn, { respId: 'resp_1' }, 'served')
      .output as { id: string }[]);
    assert.equal(buffered[0].id, 'ws_1');

    const encoder = new OpenAIResponsesEventEncoder('resp_1', 'msg_1', newResponseStreamSequence(), true, defaultResponsesEcho());
    const wire = canonicalResponseToEvents(builtIn).flatMap((event) => encoder.encode(event, 'served', builtIn));
    const added = wire.filter((event) => event.type === 'response.output_item.added')
      .map((event) => event.item as { id: string });
    const final = (wire.at(-1)?.response as { output: { id: string }[] } | undefined)?.output ?? [];
    assert.equal(added[0].id, 'ws_1', 'the stream must not rename a vendor item');
    assert.deepEqual(final.map((item) => item.id), added.map((item) => item.id));
    assert.deepEqual(payload, { type: 'web_search_call', id: 'ws_1', call_id: 'call_ws_1', status: 'completed' },
      'the payload object the session store holds is never written through');

    // With nothing to name it by, the mint is an `item_` anchor (not `fc_`, which would claim
    // the item is a function call), and it is the same name on both legs.
    const nameless = response([{ type: 'extension', protocol: 'openai-responses', payload: { type: 'mystery_item' } }]);
    const namelessEncoder = new OpenAIResponsesEventEncoder('resp_2', 'msg_2', newResponseStreamSequence(), true, defaultResponsesEcho());
    const frames = canonicalResponseToEvents(nameless).flatMap((event) => namelessEncoder.encode(event, 'served', nameless));
    const minted = (frames.filter((event) => event.type === 'response.output_item.added')[0]?.item as { id: string }).id;
    assert.match(minted, /^item_[0-9a-f]{24}$/);
    assert.equal((frames.at(-1)?.response as { output: { id: string }[] }).output[0].id, minted);
  });

  it('renders a deep-frozen canonical response on both legs, so encoding never writes through', () => {
    // The capture archive, the session store and the IR the pipeline hands the next stage are
    // THE SAME objects. Rendering is therefore required to be pure: today the encoder stamps
    // `id` onto an item wire shape and normalizes a `call_id` inside a payload, and both
    // write into a COPY. Freezing the whole response turns any write-through into a throw,
    // on either leg, for both id levels and the shared sub-objects (part payloads, logprobs,
    // annotations) — so a future "just set one more field here" fails a test instead of
    // silently editing the operator's record of what the upstream actually sent.
    const deepFreeze = (value: unknown): unknown => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const frozen = deepFreeze(response([
      {
        type: 'message', id: '', role: 'assistant', content: [{
          type: 'text', text: 'hi',
          logprobs: [{ token: 'hi', logprob: -0.1, bytes: [104] }],
          annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'x', start_index: 0, end_index: 2 }],
        }, {
          type: 'extension', protocol: 'openai-responses', payload: { type: 'input_image', image_url: 'https://example.com/i.png' },
        }],
      },
      { type: 'reasoning', id: '', text: 'think', summary: ['s1'] },
      { type: 'tool_call', id: '', callId: '', name: 'read', arguments: '{}' },
      { type: 'extension', protocol: 'openai-responses', payload: { type: 'web_search_call', call_id: 'call_ws' } },
    ]) as unknown) as ReturnType<typeof response>;

    const buffered = canonicalToResponsesObject(frozen, { respId: 'resp_1' }, 'served');
    const encoder = new OpenAIResponsesEventEncoder('resp_1', 'msg_1', newResponseStreamSequence(), true, defaultResponsesEcho());
    const wire = canonicalResponseToEvents(frozen).flatMap((event) => encoder.encode(event, 'served', frozen));
    const added = wire.filter((event) => event.type === 'response.output_item.added')
      .map((event) => event.item as { id?: string; call_id?: string });
    const final = (wire.at(-1)?.response as { output: { id?: string; call_id?: string }[] } | undefined)?.output ?? [];
    const bufferedItems = (buffered.output as { id?: string; call_id?: string }[]);
    assert.equal(added.length, 4);
    assert.equal(bufferedItems.length, 4);
    assert.deepEqual(final.map((item) => item.id), added.map((item) => item.id), 'both stream frames name each item alike');
    // Cross-leg EQUALITY is not the claim here (an id-less item gets a fresh random anchor in
    // each rendering, which is what the dedicated anchor tests pin). What must hold is that
    // neither leg THREW while rendering a frozen response, and that both produced a complete,
    // legal name for every item and every correlation id.
    const callIdShape = new RegExp(`^[A-Za-z0-9_-]{1,${RESPONSES_CALL_ID_MAX_LEN}}$`);
    // The REQUEST leg renders the same part shapes (the extension part copy lives in
    // `responsesPartToWire`), so it gets the same purity requirement.
    canonicalToResponsesPayload(deepFreeze({
      model: 'auto', stream: false,
      input: [{
        type: 'message', role: 'user', content: [{
          type: 'text', text: 'q', logprobs: [{ token: 'q', logprob: -0.2, bytes: [113] }],
        }, { type: 'extension', protocol: 'openai-responses', payload: { type: 'input_file', file_id: 'f1' } }],
      }, {
        type: 'tool_result', callId: 'call_x', content: [{ type: 'text', text: 'ok' }],
      }],
    } as unknown) as never, model);
    for (const item of [...bufferedItems, ...final, ...added]) {
      assert.ok(typeof item.id === 'string' && item.id.length > 0, 'every item is named');
      if (item.call_id !== undefined) assert.match(item.call_id, callIdShape, 'a rendered correlation id stays inside the field');
    }
  });

  it('emits prefixed item ids to Responses clients while keeping the call id correlation', () => {
    const original = response([
      { type: 'tool_call', id: 'call_1', callId: 'call_1', name: 'read', arguments: '{}' },
    ]);
    const object = canonicalToResponsesObject(original, { respId: 'resp_1' }, 'served');
    const buffered = (object.output as { id?: string; call_id?: string }[])[0];
    assert.equal(buffered.id, 'fc_call_1');
    assert.equal(buffered.call_id, 'call_1');

    const encoder = new OpenAIResponsesEventEncoder('resp_1', 'msg_1', newResponseStreamSequence(), true, defaultResponsesEcho());
    const wire = canonicalResponseToEvents(original).flatMap((event) => encoder.encode(event, 'served', original));
    const opened = wire.find((event) => event.type === 'response.output_item.added');
    const final = (wire.at(-1)?.response as { output: { id?: string }[] } | undefined)?.output[0];
    assert.equal((opened?.item as { id?: string } | undefined)?.id, 'fc_call_1');
    assert.equal(final?.id, 'fc_call_1', 'streamed and terminal item ids must agree');
  });

  it('round-trips Responses item references, custom tools, verbosity and schema descriptions', () => {
    const ir = responsesRequestToIR({
      model: 'auto',
      input: [{ type: 'item_reference', id: 'msg_stored' }, { type: 'message', role: 'user', content: 'continue' }],
      tools: [
        { type: 'custom', name: 'freeform', description: 'custom', format: { type: 'text' } },
        { type: 'web_search', search_context_size: 'high' },
      ],
      tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'freeform' }] },
      text: {
        verbosity: 'high',
        format: { type: 'json_schema', name: 'answer', description: 'Answer envelope', schema: { type: 'object' }, strict: true },
      },
      prompt_cache_key: 'cache-key', prompt_cache_retention: '24h', prompt_cache_options: { mode: 'explicit' },
    });
    const payload = canonicalToResponsesPayload(ir, model);
    assert.deepEqual(payload.input[0], { type: 'item_reference', id: 'msg_stored' });
    assert.equal(payload.text.verbosity, 'high');
    assert.equal(payload.text.format.description, 'Answer envelope');
    assert.equal(payload.tools[0].type, 'custom');
    assert.equal(payload.tools[1].type, 'web_search');
    assert.equal(payload.tool_choice.type, 'allowed_tools');
    assert.equal(payload.prompt_cache_retention, '24h');
    assert.deepEqual(payload.prompt_cache_options, { mode: 'explicit' });
  });

  it('preserves Responses annotations and signed or encrypted reasoning', () => {
    const ir = responsesResponseToIR({
      id: 'resp_wire', status: 'completed', output: [
        {
          type: 'message', id: 'msg_1', role: 'assistant', content: [{
            type: 'output_text', text: 'source',
            annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'Example', start_index: 0, end_index: 6 }],
          }],
        },
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'summary' }], encrypted_content: 'encrypted' },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    const message = ir.output[0];
    assert.equal(message?.type, 'message');
    if (message?.type !== 'message') return;
    assert.deepEqual(message.content[0]?.annotations?.[0], {
      type: 'url_citation', url: 'https://example.test', title: 'Example', startIndex: 0, endIndex: 6,
    });
    assert.deepEqual(ir.output[1], {
      type: 'reasoning', id: 'rs_1', summary: ['summary'], encrypted: 'encrypted',
    });
  });

  it('round-trips Anthropic documents, citations, redacted thinking and multimodal tool output', () => {
    const ir = anthropicRequestToIR({
      model: 'claude', max_tokens: 100,
      system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user', content: [
            { type: 'document', title: 'report', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } },
            { type: 'text', text: 'cite', citations: [{ type: 'char_location', document_index: 0, start_char_index: 0, end_char_index: 4 }] },
          ],
        },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'view', input: { page: 1 } }] },
        {
          role: 'user', content: [{
            type: 'tool_result', tool_use_id: 'toolu_1', content: [
              { type: 'text', text: 'image follows' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BB==' } },
            ],
          }],
        },
      ],
    });
    const payload = canonicalToAnthropicPayload(ir, model);
    assert.equal(payload.system[0].cache_control.type, 'ephemeral');
    assert.equal(payload.messages[0].content[0].type, 'document');
    assert.equal(payload.messages[0].content[1].citations[0].type, 'char_location');
    assert.deepEqual(payload.messages[1].content[0], { type: 'redacted_thinking', data: 'opaque' });
    assert.equal(payload.messages[2].content[0].content[1].type, 'image');
  });

  it('maps every implemented Google source kind and modality-aware usage', () => {
    const request: CanonicalRequest = {
      model: 'auto', stream: false,
      input: [{
        type: 'message', role: 'user', content: [
          { type: 'image', source: { kind: 'url', url: 'https://example.test/a.png' } },
          { type: 'file', source: { kind: 'file', fileId: 'files/1' } },
          { type: 'audio', source: { kind: 'base64', mediaType: 'audio/mp3', data: 'AA==' } },
        ],
      }],
    };
    // Build the request directly; Chat is deliberately not an intermediary.
    const payload = canonicalToGooglePayload(request, model);
    assert.equal(payload.contents[0].parts[0].fileData.fileUri, 'https://example.test/a.png');
    assert.equal(payload.contents[0].parts[1].fileData.fileUri, 'files/1');
    assert.equal(payload.contents[0].parts[2].inlineData.mimeType, 'audio/mp3');
    const result = googleResponseToIR({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 14,
        cachedContentTokenCount: 2, thoughtsTokenCount: 1,
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 4 }],
        candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 2 }],
      },
    });
    assert.equal(result.usage.cachedInputTokens, 2);
    assert.equal(result.usage.reasoningTokens, 1);
    assert.equal(result.usage.audioInputTokens, 4);
    assert.equal(result.usage.audioOutputTokens, 2);
  });

  it('rejects malformed tool arguments instead of changing them into a result object', () => {
    const input: CanonicalRequest['input'] = [{
      type: 'tool_call', id: 'call_1', callId: 'call_1', name: 'read', arguments: '{broken',
    }];
    assert.throws(() => canonicalToAnthropicPayload({ model: 'auto', stream: false, input }, model), IrUnsupportedError);
    assert.throws(() => canonicalToGooglePayload({ model: 'auto', stream: false, input }, model), IrUnsupportedError);
  });

  it('fails cross-carrier opaque items instead of silently dropping them', () => {
    const request: CanonicalRequest = {
      model: 'auto', stream: false,
      input: [{ type: 'extension', protocol: 'openai-responses', payload: { type: 'computer_call' } }],
    };
    assert.throws(() => canonicalToAnthropicPayload(request, model), IrUnsupportedError);
    assert.throws(() => canonicalToGooglePayload(request, model), IrUnsupportedError);
  });

  it('strips carrier-only fields and router controls from generic OpenAI Chat', () => {
    const request: CanonicalRequest = {
      model: 'auto', stream: false, input: [{
        type: 'message', role: 'user', cache: { type: 'ephemeral' },
        content: [{ type: 'text', text: 'hello', cache: { type: 'ephemeral' } }],
      }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {}, cache: { type: 'ephemeral' } } }],
      routerOptions: { forceTier: 'pro', disableFallback: true },
      cache: { key: 'key', retention: '24h', options: { mode: 'explicit' } },
    };
    const chat = irToChatRequest(request, 'upstream', { carrierExtensions: false });
    assert.equal(chat.prompt_cache_key, 'key');
    assert.equal('prompt_cache_retention' in chat, false);
    assert.equal('prompt_cache_options' in chat, false);
    assert.equal('router_options' in chat, false);
    assert.equal(JSON.stringify(chat).includes('cache_control'), false);
  });

  it('maps cached, reasoning and audio usage in both directions on Chat and Responses', () => {
    const chat = chatResponseToIR({
      id: 'c', object: 'chat.completion', created: 1, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 6, audio_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1, audio_tokens: 3 },
      },
    });
    assert.equal(chat.usage.cachedInputTokens, 6);
    assert.equal(chat.usage.audioInputTokens, 2);
    assert.equal(chat.usage.audioOutputTokens, 3);
    const encoded = irToChatResponse(chat, 'c', 'm');
    assert.equal(encoded.usage?.prompt_tokens_details?.cached_tokens, 6);
    assert.equal(encoded.usage?.completion_tokens_details?.audio_tokens, 3);

    const responses = responsesResponseToIR({
      status: 'completed', output: [],
      usage: {
        input_tokens: 10, output_tokens: 5, total_tokens: 15,
        input_tokens_details: { cached_tokens: 6, audio_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1, audio_tokens: 3 },
      },
    });
    assert.equal(responses.usage.cachedInputTokens, 6);
    assert.equal(responses.usage.audioInputTokens, 2);
    assert.equal(responses.usage.audioOutputTokens, 3);
  });

  it('keeps buffered and event-accumulated responses equivalent', () => {
    const original = response([
      { type: 'reasoning', id: 'rs_1', text: 'private', summary: ['short', 'detailed'], encrypted: 'opaque' },
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { type: 'tool_call', id: 'fc_1', callId: 'call_1', name: 'read', arguments: '{"path":"a"}' },
    ], { cachedInputTokens: 5, reasoningTokens: 2 });
    const events = canonicalResponseToEvents(original);
    const accumulator = createEventAccumulator();
    for (const event of events) accumulator.push(event);
    const assembled = accumulator.finish();
    assert.deepEqual(assembled.output, original.output);
    assert.deepEqual(assembled.usage, original.usage);
    assert.equal(assembled.status, original.status);
    assert.equal(events.filter((event) => event.type === 'response.reasoning_summary_part.added').length, 2);
    assert.equal(events.filter((event) => event.type === 'response.reasoning_summary.delta').length, 2);
  });

  it('emits Responses reasoning summary added before each delta and closes with final usage', () => {
    const original = response([{ type: 'reasoning', id: 'rs_1', summary: ['one', 'two'] }], { cachedInputTokens: 4 });
    const encoder = new OpenAIResponsesEventEncoder('resp_1', 'msg_1', newResponseStreamSequence(), true, defaultResponsesEcho());
    const wire = canonicalResponseToEvents(original).flatMap((event) => encoder.encode(event, 'served', original));
    const summaryAdded = wire.findIndex((event) => event.type === 'response.reasoning_summary_part.added');
    const summaryDelta = wire.findIndex((event) => event.type === 'response.reasoning_summary_text.delta');
    assert.ok(summaryAdded >= 0 && summaryAdded < summaryDelta);
    const terminal = wire.at(-1);
    assert.equal(terminal?.type, 'response.completed');
    assert.equal((terminal?.response as any).usage.input_tokens_details.cached_tokens, 4);
  });

  it('emits one terminal Chat frame per candidate and infers tool_calls finish reason', () => {
    const original = response([], {});
    original.candidates = [
      { index: 0, status: 'completed', output: [] },
      { index: 1, status: 'completed', output: [{ type: 'tool_call', id: 'c1', name: 'f', arguments: '{}' }] },
    ];
    const terminal = new ChatEventEncoder().finish(original, 'served');
    assert.deepEqual(terminal.map((chunk) => chunk.choices[0]?.finish_reason), ['stop', 'tool_calls']);
  });

  it('maps Anthropic cached usage without double-counting cached or written input', () => {
    const wire = canonicalToAnthropicResponse(response([], {
      inputTokens: 20, cachedInputTokens: 5, cacheWriteTokens: 3,
      cacheWrite5mTokens: 2, cacheWrite1hTokens: 1,
    }), 'claude') as any;
    assert.equal(wire.usage.input_tokens, 12);
    assert.equal(wire.usage.cache_read_input_tokens, 5);
    assert.equal(wire.usage.cache_creation_input_tokens, 3);
    assert.deepEqual(wire.usage.cache_creation, { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 });
  });

  it('keeps Google grounding and logprobs opaque and fails lossy cross-carrier output', () => {
    const result = googleResponseToIR({
      candidates: [{
        index: 0, content: { role: 'model', parts: [{ text: 'grounded' }] }, finishReason: 'STOP',
        groundingMetadata: { webSearchQueries: ['query'] },
        logprobsResult: { chosenCandidates: [{ token: 'grounded', logProbability: -0.1 }] },
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
    const extension = result.output.at(-1);
    assert.equal(extension?.type, 'extension');
    if (extension?.type !== 'extension') return;
    assert.equal(extension.protocol, 'google-gemini');
    assert.deepEqual(Object.keys(extension.payload as object).sort(), ['groundingMetadata', 'logprobsResult', 'type']);
    assert.throws(() => irToChatResponse(result, 'chat', 'served'), IrUnsupportedError);
    const encoder = new ChatEventEncoder();
    assert.throws(() => {
      for (const event of canonicalResponseToEvents(result)) encoder.encode(event, 'served');
    }, IrUnsupportedError);
  });

  it('keeps reasoning text distinct from summaries and closes both lifecycles', () => {
    const original = response([{ type: 'reasoning', id: 'rs_1', text: 'private', summary: ['public'] }]);
    const encoder = new OpenAIResponsesEventEncoder('resp_1', 'msg_1', newResponseStreamSequence(), true, defaultResponsesEcho());
    const wire = canonicalResponseToEvents(original).flatMap((event) => encoder.encode(event, 'served', original));
    const final = wire.at(-1)?.response as any;
    assert.deepEqual(final.output[0].summary, [{ type: 'summary_text', text: 'public' }]);
    assert.deepEqual(final.output[0].content, [{ type: 'reasoning_text', text: 'private' }]);
    assert.equal(wire.filter((event) => event.type === 'response.reasoning_text.done').length, 1);
    assert.equal(wire.filter((event) => event.type === 'response.reasoning_summary_text.done').length, 1);
    assert.equal(wire.filter((event) => event.type === 'response.reasoning_summary_part.done').length, 1);
  });

  it('reuses streamed Responses item ids in item.done and the terminal response', () => {
    const original = response([
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { type: 'reasoning', text: 'thought' },
    ]);
    const encoder = new OpenAIResponsesEventEncoder('resp_1', 'msg_1', newResponseStreamSequence(), true, defaultResponsesEcho());
    const wire = canonicalResponseToEvents(original).flatMap((event) => encoder.encode(event, 'served', original));
    const opened = wire.filter((event) => event.type === 'response.output_item.added');
    const closed = wire.filter((event) => event.type === 'response.output_item.done');
    const final = (wire.at(-1)?.response as any).output;
    for (let index = 0; index < opened.length; index++) {
      assert.equal((closed[index]?.item as any).id, (opened[index]?.item as any).id);
      assert.equal(final[index].id, (opened[index]?.item as any).id);
    }
  });

  it('enforces cache capabilities and maps Anthropic item breakpoints explicitly', () => {
    const cachedInput: CanonicalRequest['input'] = [{
      type: 'message', role: 'user', cache: { type: 'ephemeral' }, content: [{ type: 'text', text: 'hello' }],
    }];
    const anthropic = canonicalToAnthropicPayload({ model: 'auto', stream: false, input: cachedInput }, model);
    assert.deepEqual(anthropic.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.throws(() => canonicalToGooglePayload({ model: 'auto', stream: false, input: cachedInput }, model), /Item-level cache breakpoints/);
    assert.throws(() => canonicalToResponsesPayload({ model: 'auto', stream: false, input: cachedInput }, model), /Item-level cache breakpoints/);
    assert.throws(() => canonicalToAnthropicPayload({
      model: 'auto', stream: false, input: [userText('x')], cache: { key: 'shared' },
    }, model), /cache\.key/);
    assert.throws(() => canonicalToResponsesPayload({
      model: 'auto', stream: false, input: [userText('x')],
      tools: [{ type: 'function', function: { name: 'f', parameters: {}, cache: { type: 'ephemeral' } } }],
    }, model), /Tool cache breakpoints/);
  });

  it('keeps Chat stream_options at the northbound boundary on a Responses upstream', () => {
    const payload = canonicalToResponsesPayload({
      model: 'auto', stream: true, input: [userText('x')], streamOptions: { includeUsage: true },
    }, model, true);
    assert.equal(payload.stream, true);
    assert.equal('stream_options' in payload, false);
  });

  it('bounds conversion work for long contexts and high-frequency deltas', () => {
    const input = Array.from({ length: 4000 }, (_, index) => userText(`message-${index}-${'x'.repeat(64)}`));
    const request: CanonicalRequest = { model: 'auto', stream: true, input };
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const chat = irToChatRequest(request, 'upstream');
    const decoder = new ChatStreamDecoder();
    for (let index = 0; index < 10000; index++) {
      decoder.push({
        id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content: 'x' } : { content: 'x' }, finish_reason: null }],
      });
    }
    const terminal = decoder.finish();
    const elapsed = performance.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    assert.equal(chat.messages.length, input.length);
    assert.ok(terminal.some((event) => event.type === 'response.completed'));
    assert.ok(elapsed < 5000, `conversion took ${elapsed.toFixed(1)}ms`);
    assert.ok(heapDelta < 256 * 1024 * 1024, `heap grew by ${(heapDelta / 1024 / 1024).toFixed(1)}MiB`);
  });
});
