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
  responsesRequestToIR,
  responsesResponseToIR,
  responsesToolItemId,
} from '../../src/ir/adapters/openai-responses.js';
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
    assert.throws(() => canonicalToGooglePayload({ model: 'auto', stream: false, input: cachedInput }, model), /item-level cache breakpoint/);
    assert.throws(() => canonicalToResponsesPayload({ model: 'auto', stream: false, input: cachedInput }, model), /item-level cache breakpoint/);
    assert.throws(() => canonicalToAnthropicPayload({
      model: 'auto', stream: false, input: [userText('x')], cache: { key: 'shared' },
    }, model), /cache\.key/);
    assert.throws(() => canonicalToResponsesPayload({
      model: 'auto', stream: false, input: [userText('x')],
      tools: [{ type: 'function', function: { name: 'f', parameters: {}, cache: { type: 'ephemeral' } } }],
    }, model), /tool cache breakpoint/);
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
