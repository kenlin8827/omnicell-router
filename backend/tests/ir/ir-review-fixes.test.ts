import { describe, expect, test } from 'bun:test';
import type { ModelRegistration } from '../../src/config/types.js';
import {
  AnthropicMessagesEventEncoder,
  anthropicRequestToIR,
  canonicalToAnthropicPayload,
} from '../../src/ir/adapters/anthropic-messages.js';
import {
  chatContentFromParts,
  chatRequestToIR,
  irToChatRequest,
} from '../../src/ir/adapters/openai-chat.js';
import { ChatStreamDecoder } from '../../src/ir/adapters/openai-chat-stream.js';
import { AnthropicMessagesStreamDecoder } from '../../src/ir/adapters/anthropic-messages-stream.js';
import { GoogleGeminiStreamDecoder } from '../../src/ir/adapters/google-gemini-stream.js';
import { canonicalToGooglePayload } from '../../src/ir/adapters/google-gemini.js';
import {
  OpenAIResponsesEventEncoder,
  defaultResponsesEcho,
  newResponseStreamSequence,
} from '../../src/ir/adapters/openai-responses-output.js';
import { OpenAIResponsesStreamDecoder } from '../../src/ir/adapters/openai-responses-stream.js';
import {
  canonicalToResponsesPayload,
  responsesRequestToIR,
} from '../../src/ir/adapters/openai-responses.js';
import { IrUnsupportedError, IrUpstreamError } from '../../src/ir/errors.js';
import {
  canonicalResponseToEvents,
  createEventAccumulator,
} from '../../src/ir/stream.js';
import type { CanonicalRequest, CanonicalResponse } from '../../src/ir/types.js';
import { runSystemoneDecision } from '../../src/protocols/systemone/decide.js';
import { UpstreamError } from '../../src/resilience/error-classifier.js';
import { EFFORT_LADDER, effortFromThinkingBudget } from '../../src/types/router.js';

const model = { id: 'p/m', provider: 'p', upstreamModel: 'upstream-model' } as ModelRegistration;

describe('IR review fixes: confirmed real bugs', () => {
  test('#2 ChatStreamDecoder.finish() closes refusal parts and parts at index > 0', () => {
    const decoder = new ChatStreamDecoder();
    decoder.push({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant', refusal: 'Cannot comply.' } as any, finish_reason: null }],
    });
    decoder.push({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: 'Extra note.' }, finish_reason: 'stop' }],
    });
    const terminal = decoder.finish();
    const refusalDone = terminal.find((e) => e.type === 'response.refusal.done');
    const textDone = terminal.find((e) => e.type === 'response.output_text.done');
    const partDones = terminal.filter((e) => e.type === 'response.content_part.done');
    expect(refusalDone).toMatchObject({ type: 'response.refusal.done', partIndex: 0, text: 'Cannot comply.' });
    expect(textDone).toMatchObject({ type: 'response.output_text.done', partIndex: 1, text: 'Extra note.' });
    expect(partDones).toHaveLength(2);
  });

  test('#3 anthropicRequestToIR() maps output_config.format to ir.text.format for cross-protocol routing', () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const ir = anthropicRequestToIR({
      model: 'claude-sonnet-4-5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    expect(ir.text?.format).toMatchObject({ type: 'json_schema', schema });
    const chat = irToChatRequest(ir, 'gpt-4o');
    expect(chat.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema } });
    const responses = canonicalToResponsesPayload(ir, model);
    expect(responses.text?.format).toMatchObject({ type: 'json_schema', schema });
    const google = canonicalToGooglePayload(ir, model);
    expect(google.generationConfig?.responseMimeType).toBe('application/json');
    expect(google.generationConfig?.responseSchema).toEqual(schema);
    const anthropic = canonicalToAnthropicPayload(ir, model);
    expect(anthropic.output_config?.format).toEqual({ type: 'json_schema', schema });
  });

  test('#4 irToChatRequest preserves Anthropic systemCache when carrierExtensions is true', () => {
    const ir = anthropicRequestToIR({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      system: [{ type: 'text', text: 'System prompt', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const chat = irToChatRequest(ir, 'gpt-4o');
    expect(chat.messages[0]).toMatchObject({
      role: 'system',
      content: 'System prompt',
      cache_control: { type: 'ephemeral' },
    });
    // Non-chat/non-Anthropic targets without item_breakpoint must still reject it.
    expect(() => canonicalToGooglePayload(ir, model)).toThrow(/system cache/);
    expect(() => canonicalToResponsesPayload(ir, model)).toThrow(/system cache/);
  });

  test('#5 canonicalResponseToEvents emits empty *.added shells and accumulator does not double-charge', () => {
    const resp: CanonicalResponse = {
      id: 'resp_1',
      model: 'm',
      status: 'completed',
      output: [
        { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { type: 'tool_call', id: 'fc_1', callId: 'call_1', name: 'read', arguments: '{"a":1}' },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const events = canonicalResponseToEvents(resp);
    const partAdded = events.find((e) => e.type === 'response.content_part.added');
    expect(partAdded?.type === 'response.content_part.added' && partAdded.part.type === 'text' ? partAdded.part.text : null).toBe('');
    const toolAdded = events.find((e) => e.type === 'response.output_item.added' && e.item.type === 'tool_call');
    expect(toolAdded?.type === 'response.output_item.added' && toolAdded.item.type === 'tool_call' ? toolAdded.item.arguments : null).toBe('');

    // OpenAIResponsesEventEncoder must emit empty text on content_part.added so text is not duplicated with delta.
    const encoder = new OpenAIResponsesEventEncoder('resp_1', 'msg_1', newResponseStreamSequence(), true, defaultResponsesEcho());
    const wire = events.flatMap((ev) => encoder.encode(ev, 'm', resp));
    const wirePartAdded = wire.find((f) => f.type === 'response.content_part.added') as any;
    expect(wirePartAdded.part.text).toBe('');

    // Accumulator must not double-charge deltas + output_item.done (5 chars for 'hello' + 7 chars for '{"a":1}' = 12).
    const acc = createEventAccumulator({ maxChars: 12 });
    for (const ev of events) acc.push(ev);
    const assembled = acc.finish();
    expect(assembled.output).toEqual(resp.output);
  });

  test('#6 ChatStreamDecoder emits immutable snapshots and handles chunked tool_call id/name', () => {
    const decoder = new ChatStreamDecoder();
    const first = decoder.push({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }],
    });
    const msgAdded = first.find((e) => e.type === 'response.output_item.added');
    decoder.push({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
    });
    // Snapshot emitted on output_item.added must not have been mutated by subsequent deltas.
    expect(msgAdded?.type === 'response.output_item.added' && msgAdded.item.type === 'message' ? msgAdded.item.content : null).toEqual([]);

    // Chunked tool_call: id arrives first, name arrives split across chunks, then arguments.
    const tcDecoder = new ChatStreamDecoder();
    const e1 = tcDecoder.push({
      id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_42', type: 'function', function: {} }] } as any, finish_reason: null }],
    });
    const e2 = tcDecoder.push({
      id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'get_' } }] } as any, finish_reason: null }],
    });
    const e3 = tcDecoder.push({
      id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'weather' } }] } as any, finish_reason: null }],
    });
    const e4 = tcDecoder.push({
      id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"NYC"}' } }] } as any, finish_reason: 'tool_calls' }],
    });
    const all = [...e1, ...e2, ...e3, ...e4, ...tcDecoder.finish()];
    const added = all.find((e) => e.type === 'response.output_item.added' && e.item.type === 'tool_call');
    expect(added?.type === 'response.output_item.added' && added.item.type === 'tool_call' ? added.item : null).toMatchObject({
      id: 'call_42',
      callId: 'call_42',
      name: 'get_weather',
      arguments: '',
    });
  });

  test('#7 AnthropicMessagesEventEncoder sets model when usage precedes created and marks error terminal', () => {
    const enc1 = new AnthropicMessagesEventEncoder();
    const frames1 = enc1.encode(
      { type: 'response.usage', usage: { inputTokens: 10, outputTokens: 0 } },
      'claude-sonnet-4-5',
    );
    const start = frames1.find((f) => f.type === 'message_start');
    expect(start?.message?.model).toBe('claude-sonnet-4-5');

    const enc2 = new AnthropicMessagesEventEncoder();
    enc2.encode({ type: 'response.created', id: 'msg_1', model: 'claude-sonnet-4-5' }, 'claude-sonnet-4-5');
    const errFrames = enc2.encode({ type: 'error', message: 'boom' }, 'claude-sonnet-4-5');
    expect(errFrames).toHaveLength(1);
    expect(errFrames[0].type).toBe('error');
    const afterErr = enc2.encode({ type: 'response.completed' }, 'claude-sonnet-4-5');
    expect(afterErr).toEqual([]);
  });

  test('#9 OpenAIResponsesStreamDecoder rejects malformed .delta and does not zero usage on failed', () => {
    const dec = new OpenAIResponsesStreamDecoder();
    expect(() => dec.push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, text: 'wrong-field' }))
      .toThrow(IrUpstreamError);

    const dec2 = new OpenAIResponsesStreamDecoder();
    const events = [
      ...dec2.push({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5', created_at: 1 } }),
      ...dec2.push({ type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'oops' } } }),
    ];
    expect(events.some((e) => e.type === 'response.usage')).toBe(false);
  });

  test('#10 chatContentFromParts does not leak cache.raw into cache_control on image parts', () => {
    const parts = chatContentFromParts([
      {
        type: 'image',
        source: { kind: 'url', url: 'https://example.test/a.png' },
        cache: { raw: { mode: 'explicit' } },
      },
    ]) as any[];
    expect(parts[0].cache_control).toBeUndefined();
    expect(parts[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
  });

  test('#11 irToChatRequest accepts reasoning.effort minimal and effortFromThinkingBudget covers full ladder', () => {
    const ir: CanonicalRequest = {
      model: 'gpt-5',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoning: { effort: 'minimal' },
    };
    const chat = irToChatRequest(ir, 'gpt-5');
    expect(chat.reasoning_effort).toBe('minimal');

    expect(effortFromThinkingBudget(0)).toBe('none');
    expect(effortFromThinkingBudget(512)).toBe('minimal');
    expect(effortFromThinkingBudget(1024)).toBe('low');
    expect(effortFromThinkingBudget(4096)).toBe('medium');
    expect(effortFromThinkingBudget(16384)).toBe('high');
    expect(effortFromThinkingBudget(32768)).toBe('xhigh');
    expect(effortFromThinkingBudget(65536)).toBe('max');
    // Every effort in EFFORT_LADDER is reachable.
    const reached = new Set([0, 512, 1024, 4096, 16384, 32768, 65536].map(effortFromThinkingBudget));
    expect([...reached]).toEqual([...EFFORT_LADDER]);
  });

  test('#12 canonicalToGooglePayload sets includeThoughts: false when budgetTokens is 0', () => {
    const ir: CanonicalRequest = {
      model: 'gemini-2.5-pro',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoning: { budgetTokens: 0 },
    };
    const payload = canonicalToGooglePayload(ir, model);
    expect(payload.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    });
  });

  test('#13b createEventAccumulator fails visibly on deltas before output_item.added', () => {
    const acc = createEventAccumulator();
    expect(() => acc.push({
      type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'orphan',
    })).toThrow(/before response\.output_item\.added/);
  });

  test('#13 canonicalResponseToEvents preserves response.error on failed responses', () => {
    const failed: CanonicalResponse = {
      id: 'resp_err',
      model: 'm',
      status: 'failed',
      reason: 'error',
      error: { code: 'rate_limit', message: 'Quota exceeded' },
      output: [],
      usage: { inputTokens: 1, outputTokens: 0 },
    };
    const events = canonicalResponseToEvents(failed);
    const acc = createEventAccumulator();
    for (const ev of events) acc.push(ev);
    const assembled = acc.finish();
    expect(assembled.status).toBe('failed');
    expect(assembled.error).toEqual({ code: 'rate_limit', message: 'Quota exceeded' });
  });

  test('#14 responsesRequestToIR parses base64 data URLs with media parameters via shared DATA_URL_RE', () => {
    const ir = responsesRequestToIR({
      model: 'gpt-5',
      input: [{
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_file',
          filename: 'note.txt',
          file_data: 'data:text/plain;charset=utf-8;base64,aGk=',
        }],
      }],
    });
    const msg = ir.input[0];
    expect(msg?.type === 'message' ? msg.content[0] : null).toMatchObject({
      type: 'file',
      filename: 'note.txt',
      source: { kind: 'base64', mediaType: 'text/plain;charset=utf-8', data: 'aGk=' },
    });
  });

  test('Pass-2 #1 canonicalToAnthropicPayload clamps minimal effort budget to Anthropic minimum 1024', () => {
    const ir: CanonicalRequest = {
      model: 'claude-sonnet-4-5',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoning: { effort: 'minimal' },
    };
    const payload = canonicalToAnthropicPayload(ir, model);
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(payload.max_tokens).toBeGreaterThanOrEqual(2048);
  });

  test('Pass-2 #2 Gemini and Anthropic stream decoders emit empty cloned *.added shells without mutating emitted snapshots', () => {
    // Gemini text + reasoning + tool_call
    const gemini = new GoogleGeminiStreamDecoder();
    const g1 = gemini.push({
      candidates: [{ index: 0, content: { parts: [{ thought: true, text: 'think1' }] } }],
    });
    const gReasoningAdded = g1.find((e) => e.type === 'response.output_item.added');
    expect(gReasoningAdded?.type === 'response.output_item.added' && gReasoningAdded.item.type === 'reasoning' ? gReasoningAdded.item.text : null).toBe('');

    const g2 = gemini.push({
      candidates: [{ index: 0, content: { parts: [{ text: 'hello' }] } }],
    });
    const gMsgAdded = g2.find((e) => e.type === 'response.output_item.added');
    const gPartAdded = g2.find((e) => e.type === 'response.content_part.added');
    expect(gMsgAdded?.type === 'response.output_item.added' && gMsgAdded.item.type === 'message' ? gMsgAdded.item.content : null).toEqual([]);
    expect(gPartAdded?.type === 'response.content_part.added' && gPartAdded.part.type === 'text' ? gPartAdded.part.text : null).toBe('');

    const g3 = gemini.push({
      candidates: [{ index: 0, content: { parts: [{ functionCall: { id: 'c1', name: 'fn', args: { k: 1 } } }] } }],
    });
    const gToolAdded = g3.find((e) => e.type === 'response.output_item.added');
    expect(gToolAdded?.type === 'response.output_item.added' && gToolAdded.item.type === 'tool_call' ? gToolAdded.item.arguments : null).toBe('');

    // Verify accumulator does not double first-chunk text before done
    const gAcc = createEventAccumulator();
    for (const ev of [...g1, ...g2]) gAcc.push(ev);
    const gMid = gAcc.finish();
    expect(gMid.output[1]?.type === 'message' && gMid.output[1].content[0]?.type === 'text' ? gMid.output[1].content[0].text : null).toBe('hello');

    // Anthropic text + tool_use + thinking with initial payload & deltas
    const anth = new AnthropicMessagesStreamDecoder();
    anth.push({ type: 'message_start', message: { id: 'm1', model: 'claude', usage: { input_tokens: 1, output_tokens: 0 } } });
    const aTextStart = anth.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'first' } });
    const aTextDelta = anth.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' second' } });
    const aMsgAdded = aTextStart.find((e) => e.type === 'response.output_item.added');
    const aPartAdded = aTextStart.find((e) => e.type === 'response.content_part.added');
    expect(aMsgAdded?.type === 'response.output_item.added' && aMsgAdded.item.type === 'message' ? aMsgAdded.item.content : null).toEqual([]);
    expect(aPartAdded?.type === 'response.content_part.added' && aPartAdded.part.type === 'text' ? aPartAdded.part.text : null).toBe('');

    const aToolStart = anth.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } } });
    const aToolAdded = aToolStart.find((e) => e.type === 'response.output_item.added');
    expect(aToolAdded?.type === 'response.output_item.added' && aToolAdded.item.type === 'tool_call' ? aToolAdded.item.arguments : null).toBe('');

    const aThinkStart = anth.push({ type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: 'hmm' } });
    anth.push({ type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: '...' } });
    const aThinkAdded = aThinkStart.find((e) => e.type === 'response.output_item.added');
    expect(aThinkAdded?.type === 'response.output_item.added' && aThinkAdded.item.type === 'reasoning' ? aThinkAdded.item.text : null).toBe('');

    const aAcc = createEventAccumulator();
    for (const ev of [...aTextStart, ...aTextDelta]) aAcc.push(ev);
    const aMid = aAcc.finish();
    expect(aMid.output[0]?.type === 'message' && aMid.output[0].content[0]?.type === 'text' ? aMid.output[0].content[0].text : null).toBe('first second');
  });

  test('Pass-2 #3 anthropicRequestToIR rejects unsupported or non-object output_config.format', () => {
    expect(() => anthropicRequestToIR({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { format: { type: 'xml' } },
    })).toThrow(IrUnsupportedError);

    expect(() => anthropicRequestToIR({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { format: 'json_object' },
    })).toThrow(IrUnsupportedError);
  });

  test('Pass-2 #4 AnthropicMessagesEventEncoder allows same-protocol extension output items', () => {
    const encoder = new AnthropicMessagesEventEncoder();
    const extBlock = { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'ocr' } };
    const frames = [
      ...encoder.encode({ type: 'response.created', id: 'msg_1', model: 'claude-sonnet-4-5' }, 'claude-sonnet-4-5'),
      ...encoder.encode({ type: 'response.usage', usage: { inputTokens: 5, outputTokens: 2 } }, 'claude-sonnet-4-5'),
      ...encoder.encode({
        type: 'response.output_item.added',
        index: 0,
        item: { type: 'extension', protocol: 'anthropic-messages', payload: extBlock },
      }, 'claude-sonnet-4-5'),
      ...encoder.encode({
        type: 'response.output_item.done',
        index: 0,
        item: { type: 'extension', protocol: 'anthropic-messages', payload: extBlock },
      }, 'claude-sonnet-4-5'),
      ...encoder.encode({ type: 'response.completed' }, 'claude-sonnet-4-5'),
    ];
    const start = frames.find((f) => f.type === 'content_block_start');
    const stop = frames.find((f) => f.type === 'content_block_stop');
    expect(start?.content_block).toEqual(extBlock);
    expect(stop?.index).toBe(start?.index);

    // Foreign-protocol extension must still throw.
    const foreignEnc = new AnthropicMessagesEventEncoder();
    foreignEnc.encode({ type: 'response.usage', usage: { inputTokens: 1, outputTokens: 0 } }, 'claude-sonnet-4-5');
    expect(() => foreignEnc.encode({
      type: 'response.output_item.added',
      index: 0,
      item: { type: 'extension', protocol: 'google-gemini', payload: { x: 1 } },
    }, 'claude-sonnet-4-5')).toThrow(IrUnsupportedError);
  });

  test('Pass-2 #5 ChatStreamDecoder preserves parallel tool_call order when earlier call has empty arguments', () => {
    const decoder = new ChatStreamDecoder();
    const events = [
      ...decoder.push({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_0', type: 'function', function: { name: 'no_args_tool', arguments: '' } },
              { index: 1, id: 'call_1', type: 'function', function: { name: 'with_args_tool', arguments: '{"a":1}' } },
            ],
          } as any,
          finish_reason: 'tool_calls',
        }],
      }),
      ...decoder.finish(),
    ];
    const addedTools = events
      .filter((e): e is Extract<typeof e, { type: 'response.output_item.added' }> =>
        e.type === 'response.output_item.added' && e.item.type === 'tool_call')
      .map((e) => ({ index: e.index, id: e.item.type === 'tool_call' ? e.item.id : '' }));
    expect(addedTools).toEqual([
      { index: 0, id: 'call_0' },
      { index: 1, id: 'call_1' },
    ]);
  });

  test('Pass-2 #6 systemone parseMentionedEfforts recognizes minimal from vendor error messages', async () => {
    const attemptedEfforts: (string | undefined)[] = [];
    const mockRegistry = {
      execute: async (req: CanonicalRequest): Promise<CanonicalResponse> => {
        attemptedEfforts.push(req.reasoning?.effort);
        if (attemptedEfforts.length === 1) {
          throw new UpstreamError({
            provider: 'test',
            message: 'Bad Request',
            status: 400,
            errorBody: "Invalid 'reasoning_effort': must be one of 'minimal', 'low', 'medium'",
          });
        }
        return {
          id: 'resp_1',
          model: 'u',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: '{"answers":{"ok":{"noul":0.9}}}' }] }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as any;
    const testModel = {
      id: 'test/pass2-minimal-effort',
      provider: 'test',
      upstreamModel: 'u',
      wire: 'openai-chat',
      supportedReasoningEfforts: ['none', 'low'],
    } as ModelRegistration;
    await runSystemoneDecision(mockRegistry, {
      state: { x: 1 },
      questions: { ok: { type: 'noul', instructions: 'Is it ok?' } },
    }, testModel);
    expect(attemptedEfforts).toEqual(['none', 'minimal']);
  });

  test('OpenAIResponsesStreamDecoder ignores builtin tool progress events without throwing', () => {
    const decoder = new OpenAIResponsesStreamDecoder();
    expect(decoder.push({ type: 'response.created', response: { id: 'r1', model: 'gpt-5', created_at: 1 } })).toHaveLength(1);
    expect(decoder.push({ type: 'response.web_search_call.in_progress', output_index: 0, item_id: 'ws_1' })).toEqual([]);
    expect(decoder.push({ type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws_1' })).toEqual([]);
    expect(decoder.push({ type: 'response.web_search_call.completed', output_index: 0, item_id: 'ws_1' })).toEqual([]);
    expect(decoder.push({ type: 'response.file_search_call.in_progress', output_index: 1, item_id: 'fs_1' })).toEqual([]);
    expect(decoder.push({ type: 'response.mcp_call.in_progress', output_index: 2, item_id: 'mcp_1' })).toEqual([]);
    expect(decoder.push({ type: 'response.code_interpreter_call_code.delta', output_index: 3, delta: 'x=1' })).toEqual([]);
    expect(decoder.push({ type: 'response.image_generation_call.generating', output_index: 4 })).toEqual([]);
    const done = decoder.push({
      type: 'response.completed',
      response: { id: 'r1', model: 'gpt-5', status: 'completed', output: [] },
    });
    expect(done.some((e) => e.type === 'response.completed')).toBe(true);
  });

  test('canonicalToGooglePayload sanitizes MCP/OpenAI JSON schemas ($defs/$ref, nullable unions, const, additionalProperties)', () => {
    const googleModel: ModelRegistration = {
      id: 'g/gemini-2.5-flash',
      provider: 'g',
      upstreamModel: 'gemini-2.5-flash',
      wire: 'google-gemini',
    };
    const payload = canonicalToGooglePayload({
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'run' }] }],
      text: {
        format: {
          type: 'json_schema',
          name: 'out',
          schema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { const: 'ok' },
              note: { anyOf: [{ type: 'string' }, { type: 'null' }], default: '' },
            },
            required: ['status', 'missing_field'],
          },
        },
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'edit_node',
            parameters: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              $defs: {
                Node: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: ['string', 'null'], title: 'Name' },
                    child: { $ref: '#/$defs/Node' },
                  },
                  required: ['name'],
                },
              },
              type: 'object',
              additionalProperties: false,
              properties: {
                root: { $ref: '#/$defs/Node' },
              },
              required: ['root'],
            },
          },
        },
      ],
    }, googleModel) as any;

    const schema = payload.generationConfig.responseSchema;
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.properties.status).toEqual({ enum: ['ok'] });
    expect(schema.properties.note).toEqual({ type: 'string', nullable: true });
    expect(schema.required).toEqual(['status']);

    const toolParams = payload.tools[0].functionDeclarations[0].parameters;
    expect(toolParams.$defs).toBeUndefined();
    expect(toolParams.additionalProperties).toBeUndefined();
    expect(toolParams.properties.root.properties.name).toEqual({ type: 'string', nullable: true });
    expect(toolParams.properties.root.properties.child).toBeDefined();
  });

  test('chatRequestToIR and ChatStreamDecoder accept reasoning and reasoning_details dialects', () => {
    const ir = chatRequestToIR({
      model: 'deepseek-r1',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'answer',
          reasoning_details: [
            { type: 'reasoning.text', text: 'step 1; ' },
            { type: 'reasoning.summary', summary: 'step 2' },
          ],
        } as any,
      ],
    });
    expect(ir.input[1]).toEqual({ type: 'reasoning', text: 'step 1; step 2' });

    const decoder = new ChatStreamDecoder();
    const events = decoder.push({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'or',
      choices: [{
        index: 0,
        delta: {
          reasoning_details: [{ type: 'reasoning.text', text: 'streamed thought' }],
        } as any,
        finish_reason: null,
      }],
    });
    expect(events.some((e) => e.type === 'response.reasoning.delta' && e.text === 'streamed thought')).toBe(true);
  });
});

