import { describe, expect, test } from 'bun:test';
import {
  createToolMarkupStreamRecovery,
  recoverToolMarkupInResponse,
  recoverToolMarkupText,
  toolMarkupRecoveryFor,
} from '../../src/providers/compat/tool-markup-recovery.js';
import { createEventAccumulator } from '../../src/ir/stream.js';
import { ChatStreamDecoder } from '../../src/ir/adapters/openai-chat-stream.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../src/ir/types';
import type { ModelRegistration, ProviderConfig } from '../../src/config/types';

const REAL_LEAK =
  '<｜tool_calls｜><｜invoke name="read"><｜parameter name="path">a.ts</｜parameter></｜invoke>' +
  '<｜invoke name="read"><｜parameter name="path">b.ts</｜parameter></｜invoke></｜tool_calls｜>';
const DSML_LEAK =
  '<|DSML|tool_calls><|DSML|invoke name="read">' +
  '<|DSML|parameter name="path" string="true">a.ts</|DSML|parameter>' +
  '</|DSML|invoke></|DSML|tool_calls>';
const ZERO_ARG = '<｜tool_calls｜><｜invoke name="refresh"></｜invoke></｜tool_calls｜>';

function request(tools: { name: string; parameters?: Record<string, unknown> }[] = [
  { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'refresh', parameters: { type: 'object', properties: {} } },
]): CanonicalRequest {
  return {
    model: 'deepseek-v4-flash',
    stream: false,
    input: [],
    tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, parameters: tool.parameters } })),
  };
}

function responseWith(text: string, id = 'resp_1'): CanonicalResponse {
  return {
    id,
    status: 'completed',
    reason: 'stop',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'text', text }] }],
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function model(upstreamModel = 'deepseek-v4-flash'): ModelRegistration {
  return { id: upstreamModel, provider: 'renamed-provider', upstreamModel } as ModelRegistration;
}

function config(baseUrl = 'https://opencode.ai/zen/v1'): ProviderConfig {
  return { name: 'renamed-provider', type: 'openai-chat', baseUrl, apiKey: 'test' };
}

describe('tool markup recovery — scope and buffered conversion', () => {
  test('scopes recovery to the declared endpoint, model family and callable request', () => {
    expect(toolMarkupRecoveryFor(request(), model(), config())).toBe('dsml');
    expect(toolMarkupRecoveryFor(request(), model('deepseek-v4'), config())).toBe('dsml');
    expect(toolMarkupRecoveryFor(request(), model('DeepSeek-V4-Pro'), config())).toBe('dsml');
    expect(toolMarkupRecoveryFor(request(), model('deepseek-v40'), config())).toBeNull();
    expect(toolMarkupRecoveryFor(request(), model('mydeepseek-v4'), config())).toBeNull();
    expect(toolMarkupRecoveryFor(request(), model('deepseek-chat'), config())).toBeNull();
    expect(toolMarkupRecoveryFor(request(), model(), config('https://api.deepseek.com/v1'))).toBeNull();
    expect(toolMarkupRecoveryFor({ ...request(), tools: [] }, model(), config())).toBeNull();
    expect(toolMarkupRecoveryFor({ ...request(), toolChoice: { type: 'none' } }, model(), config())).toBeNull();
  });

  test('recovers the real spelling without a DSML sentinel and preserves surrounding prose', () => {
    const result = recoverToolMarkupText(`Before\n${REAL_LEAK}\nAfter`, request());
    expect(result.calls).toEqual([
      { name: 'read', arguments: '{"path":"a.ts"}' },
      { name: 'read', arguments: '{"path":"b.ts"}' },
    ]);
    expect(result.text).toBe('Before\n\nAfter');
  });

  test('recovers a zero-argument call as an empty object', () => {
    const result = recoverToolMarkupText(ZERO_ARG, request());
    expect(result.calls).toEqual([{ name: 'refresh', arguments: '{}' }]);
    expect(result.text).toBe('');
  });

  test('uses the declared schema for an untyped string parameter', () => {
    expect(recoverToolMarkupText(REAL_LEAK, request()).calls[0]?.arguments).toBe('{"path":"a.ts"}');
  });

  test('leaves a request without tools byte-identical', () => {
    const req = { ...request(), tools: undefined };
    expect(recoverToolMarkupText(REAL_LEAK, req)).toEqual({ text: REAL_LEAK, calls: [] });
  });

  test('refuses an invoke that was not declared by the request', () => {
    const text = '<｜invoke name="delete_everything"><｜parameter name="path">/</｜parameter></｜invoke>';
    expect(recoverToolMarkupText(text, request())).toEqual({ text, calls: [] });
  });

  test('never recovers an example inside a fenced code block', () => {
    const text = `Example:\n\`\`\`xml\n${DSML_LEAK}\n\`\`\``;
    expect(recoverToolMarkupText(text, request())).toEqual({ text, calls: [] });
  });

  test('leaves a truncated invocation untouched', () => {
    const text = '<｜tool_calls｜><｜invoke name="read"><｜parameter name="path">a.ts';
    expect(recoverToolMarkupText(text, request())).toEqual({ text, calls: [] });
  });

  test('rejects malformed non-string JSON instead of changing its type', () => {
    const text = '<｜invoke name="read"><｜parameter name="path">{not json</｜parameter></｜invoke>';
    const numeric = request([{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'number' } } } }]);
    expect(recoverToolMarkupText(text, numeric)).toEqual({ text, calls: [] });
  });

  test('replaces a native empty placeholder instead of duplicating the call', () => {
    const original = responseWith(DSML_LEAK);
    original.output.push({ type: 'tool_call', id: 'native_1', callId: 'native_1', name: 'read', arguments: '{}' });
    const patched = recoverToolMarkupInResponse(original, request());
    const calls = patched.output.filter((item) => item.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ callId: 'native_1', arguments: '{"path":"a.ts"}' });
    expect(patched.toolTextRecovery).toEqual({ kind: 'dsml', calls: 1 });
  });

  test('does not duplicate a same-name native call that already has real arguments', () => {
    const original = responseWith(DSML_LEAK);
    original.output.push({
      type: 'tool_call', id: 'native_filled', callId: 'native_filled', name: 'read', arguments: '{"path":"native.ts"}',
    });
    const patched = recoverToolMarkupInResponse(original, request());
    const calls = patched.output.filter((item) => item.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ callId: 'native_filled', arguments: '{"path":"native.ts"}' });
    expect(patched.toolTextRecovery).toBeUndefined();
  });

  test('skips nested markup inside an invalid bare invoke', () => {
    const nested = `<｜invoke name="unknown"><｜invoke name="read"><｜parameter name="path">a.ts</｜parameter></｜invoke></｜invoke>`;
    expect(recoverToolMarkupText(nested, request())).toEqual({ text: nested, calls: [] });
  });

  test('response-scopes synthetic call ids', () => {
    const first = recoverToolMarkupInResponse(responseWith(DSML_LEAK, 'resp_A'), request());
    const second = recoverToolMarkupInResponse(responseWith(DSML_LEAK, 'resp_B'), request());
    const idOf = (response: CanonicalResponse) => response.output.find((item) => item.type === 'tool_call')?.callId;
    expect(idOf(first)).toContain('resp_A');
    expect(idOf(second)).toContain('resp_B');
    expect(idOf(first)).not.toBe(idOf(second));
  });

  test('never recovers an inline-code example', () => {
    const text = `Use \`${DSML_LEAK}\` as the example.`;
    expect(recoverToolMarkupText(text, request())).toEqual({ text, calls: [] });
  });

  test('does not double-count a primary candidate mirrored in candidates', () => {
    const original = responseWith(DSML_LEAK);
    original.candidates = [{ index: 0, status: 'completed', output: original.output }];
    const patched = recoverToolMarkupInResponse(original, request());
    expect(patched.toolTextRecovery).toEqual({ kind: 'dsml', calls: 1 });
    expect(patched.candidates?.[0]?.output.filter((item) => item.type === 'tool_call')).toHaveLength(1);
  });

  test('does not manufacture calls on a failed response', () => {
    const original = { ...responseWith(DSML_LEAK), status: 'failed' as const, reason: 'error' };
    const patched = recoverToolMarkupInResponse(original, request());
    expect(patched.output.some((item) => item.type === 'tool_call')).toBe(false);
    expect(patched.toolTextRecovery).toBeUndefined();
  });

  test('preserves a non-length incomplete reason', () => {
    const original = { ...responseWith(DSML_LEAK), status: 'incomplete' as const, reason: 'content_filter' };
    const patched = recoverToolMarkupInResponse(original, request());
    expect(patched.reason).toBe('content_filter');
  });
});

function decodeText(text: string, placeholder = false): StreamEvent[] {
  const decoder = new ChatStreamDecoder();
  const events: StreamEvent[] = [];
  for (const textPart of text.split(/(?<=.)/s)) {
    if (!textPart) continue;
    events.push(...decoder.push({
      id: 'resp_stream', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: { content: textPart }, finish_reason: null }],
    } as any));
  }
  if (placeholder) {
    events.push(...decoder.push({
      id: 'resp_stream', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'native_stream', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: null }],
    } as any));
  }
  events.push(...decoder.push({
    id: 'resp_stream', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  } as any));
  events.push(...decoder.finish());
  return events;
}

function runStream(text: string, placeholder = false, failed = false) {
  const recovery = createToolMarkupStreamRecovery(request());
  const accumulate = createEventAccumulator();
  const relayed: StreamEvent[] = [];
  const decoded = decodeText(text, placeholder);
  if (failed) decoded[decoded.length - 1] = { type: 'response.failed', reason: 'error' };
  for (const event of decoded) {
    for (const transformed of recovery.push(event)) {
      accumulate.push(transformed);
      relayed.push(transformed);
    }
  }
  for (const transformed of recovery.finish()) {
    accumulate.push(transformed);
    relayed.push(transformed);
  }
  return { response: recovery.finishResponse(accumulate.finish()), relayed };
}

describe('tool markup recovery — incremental stream', () => {
  test('recovers a call split across single-character deltas while streaming prose', () => {
    const { response, relayed } = runStream(`Before\n${REAL_LEAK}\nAfter`);
    expect(response.output.filter((item) => item.type === 'tool_call')).toHaveLength(2);
    const message = response.output.find((item) => item.type === 'message');
    expect(message?.type === 'message' && message.content[0]?.type === 'text' ? message.content[0].text : null).toBe('Before\n\nAfter');
    const firstText = relayed.findIndex((event) => event.type === 'response.output_text.delta');
    const firstTool = relayed.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'tool_call');
    expect(firstText).toBeGreaterThanOrEqual(0);
    expect(firstTool).toBeGreaterThan(firstText);
    expect(relayed.some((event) => event.type === 'response.output_text.delta' && event.text.includes('invoke'))).toBe(false);
    expect(response.toolTextRecovery).toEqual({ kind: 'dsml', calls: 2 });
  });

  test('reconciles a streamed native placeholder without duplicate calls', () => {
    const { response } = runStream(DSML_LEAK, true);
    const calls = response.output.filter((item) => item.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ callId: 'native_stream', arguments: '{"path":"a.ts"}' });
  });

  test('flushes a truncated block as observed text without manufacturing a call', () => {
    const text = '<｜tool_calls｜><｜invoke name="read"><｜parameter name="path">a.ts';
    const { response, relayed } = runStream(text);
    expect(response.output.some((item) => item.type === 'tool_call')).toBe(false);
    expect(response.toolMarkupLeak).toEqual({ calls: 1 });
    const streamed = relayed.filter((event) => event.type === 'response.output_text.delta').map((event) => event.text).join('');
    expect(streamed).toBe(text);
  });

  test('passes fenced examples and ordinary less-than prose byte-identically', () => {
    const text = `2 < 3\n\`\`\`xml\n${DSML_LEAK}\n\`\`\``;
    const { response, relayed } = runStream(text);
    expect(response.output.some((item) => item.type === 'tool_call')).toBe(false);
    const streamed = relayed.filter((event) => event.type === 'response.output_text.delta').map((event) => event.text).join('');
    expect(streamed).toBe(text);
  });

  test('passes inline-code examples byte-identically', () => {
    const text = `Use \`${DSML_LEAK}\` as the example.`;
    const { response, relayed } = runStream(text);
    expect(response.output.some((item) => item.type === 'tool_call')).toBe(false);
    const streamed = relayed.filter((event) => event.type === 'response.output_text.delta').map((event) => event.text).join('');
    expect(streamed).toBe(text);
  });

  test('drops queued recovery on a failed stream and restores the suppressed source', () => {
    const { response, relayed } = runStream(DSML_LEAK, false, true);
    expect(response.output.some((item) => item.type === 'tool_call')).toBe(false);
    expect(response.toolTextRecovery).toBeUndefined();
    expect(response.toolMarkupLeak).toEqual({ calls: 1 });
    const message = response.output.find((item) => item.type === 'message');
    const text = message?.type === 'message' && message.content[0]?.type === 'text' ? message.content[0].text : '';
    expect(text).toContain(DSML_LEAK);
    const streamed = relayed.filter((event) => event.type === 'response.output_text.delta').map((event) => event.text).join('');
    expect(streamed).toContain(DSML_LEAK);
  });

  test('streams prose after an unclosed backtick without stalling and still ignores markup inside it', () => {
    const recovery = createToolMarkupStreamRecovery(request());
    const first = recovery.push({
      type: 'response.output_text.delta',
      candidateIndex: 0,
      index: 0,
      partIndex: 0,
      text: 'See `unclosed ',
    });
    const second = recovery.push({
      type: 'response.output_text.delta',
      candidateIndex: 0,
      index: 0,
      partIndex: 0,
      text: `and ${DSML_LEAK} trailing prose`,
    });
    const streamedBeforeEnd = [...first, ...second]
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.text)
      .join('');
    expect(streamedBeforeEnd).toBe(`See \`unclosed and ${DSML_LEAK} trailing prose`);
    const ended = recovery.finish({ type: 'response.completed', reason: 'stop' });
    expect(ended.some((event) => event.type === 'response.output_item.added' && event.item.type === 'tool_call')).toBe(false);
  });

  test('handles indented backtick fences split across chunks', () => {
    const recovery = createToolMarkupStreamRecovery(request());
    recovery.push({ type: 'response.output_text.delta', candidateIndex: 0, index: 0, partIndex: 0, text: '  ``' });
    recovery.push({ type: 'response.output_text.delta', candidateIndex: 0, index: 0, partIndex: 0, text: `\`xml\n${DSML_LEAK}\n  \`\`\`` });
    const ended = recovery.finish({ type: 'response.completed', reason: 'stop' });
    expect(ended.some((event) => event.type === 'response.output_item.added' && event.item.type === 'tool_call')).toBe(false);
  });

  test('does not stall streaming on unexpected opening tag inside <parameter>', () => {
    const recovery = createToolMarkupStreamRecovery(request());
    const out = recovery.push({
      type: 'response.output_text.delta',
      candidateIndex: 0,
      index: 0,
      partIndex: 0,
      text: '<invoke name="read"><parameter name="path">abc<parameter name="other">1</parameter></invoke> ok',
    });
    const streamed = out
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.text)
      .join('');
    expect(streamed).toContain('<invoke name="read">');
    expect(streamed).toContain(' ok');
  });
});
