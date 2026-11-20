import { describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import type { ModelRegistration, ProviderConfig } from '../src/config/types.js';
import type { StreamEvent } from '../src/ir/types.js';
import { AnthropicMessagesProvider } from '../src/providers/executors/anthropic-messages.js';
import { GoogleGeminiProvider } from '../src/providers/executors/google-gemini.js';
import { OpenAIResponsesProvider } from '../src/providers/executors/openai-responses.js';
import { STREAM_CAPTURE_CAP } from '../src/providers/executors/http-stream.js';
import { toIR } from './helpers/ir.js';

const request = toIR({ model: 'p/m1', stream: true, messages: [{ role: 'user', content: 'hi' }] });
const model = (wire: ModelRegistration['wire']): ModelRegistration => ({
  id: 'p/m1', provider: 'p', upstreamModel: 'm1', tier: 'plus', wire,
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
});
const config = (type: ProviderConfig['type'], port: number): ProviderConfig => ({
  name: 'p', type, baseUrl: `http://localhost:${port}/v1`, apiKey: 'sk-test',
});

function sse(payload: unknown, multiline = false): string {
  const json = JSON.stringify(payload, null, multiline ? 2 : 0);
  const data = multiline ? json.replaceAll('\n', '\r\ndata: ') : json;
  return `event: message\r\n: keep-alive\r\ndata: ${data}\r\n\r\n`;
}

function fragmented(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('native provider stream transports', () => {
  it('decodes fragmented multiline Responses SSE with annotations and usage', async () => {
    let received: any;
    const captured: any[] = [];
    const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] };
    const body = [
      sse({ type: 'response.created', response: { id: 'resp_1', model: 'm1', created_at: 10 } }, true),
      sse({ type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } }, true),
      sse({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
      sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' }),
      sse({ type: 'response.output_text.annotation.added', output_index: 0, content_index: 0, annotation_index: 0, annotation: { type: 'url_citation', url: 'https://example.com', title: 'Example' } }),
      sse({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' }),
      sse({ type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'hello', annotations: [{ type: 'url_citation', url: 'https://example.com' }] } }),
      sse({ type: 'response.output_item.done', output_index: 0, item: message }),
      sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [message], usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11, input_tokens_details: { cached_tokens: 5 } } } }),
    ].join('');
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return new Response(fragmented(body), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      },
    });
    try {
      const provider = new OpenAIResponsesProvider(config('responses', server.port));
      const events = await collect(await provider.createStream(request, model('responses'), {
        recorder: { isEnabled: () => true, recordEvent: async (event: any) => captured.push(event) },
      } as any));
      expect(received.stream).toBe(true);
      expect(events[0]).toMatchObject({ type: 'response.created', id: 'resp_1' });
      expect(events.some((event) => event.type === 'response.output_text.delta' && event.text === 'hello')).toBe(true);
      expect(events.some((event) => event.type === 'response.output_text.annotation.added')).toBe(true);
      expect(events.filter((event) => event.type === 'response.usage').at(-1)).toMatchObject({ usage: { cachedInputTokens: 5 } });
      expect(events.at(-1)?.type).toBe('response.completed');
      expect(captured.map((event) => `${event.direction}/${event.phase}`)).toEqual(['upstream/request', 'upstream/response']);
      expect(captured[1].wire.responseBody).toContain('response.completed');
    } finally {
      server.stop(true);
    }
  });

  it('decodes Anthropic thinking, signatures, citations, tools and terminal usage', async () => {
    let received: any;
    const body = [
      sse({ type: 'message_start', message: { id: 'msg_1', model: 'm1', usage: { input_tokens: 4, cache_read_input_tokens: 3, output_tokens: 0 } } }),
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '1' } }),
      sse({ type: 'content_block_stop', index: 0 }),
      sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }),
      sse({ type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.com' } } }),
      sse({ type: 'content_block_stop', index: 1 }),
      sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } }),
      sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":' } }),
      sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"x"}' } }),
      sse({ type: 'content_block_stop', index: 2 }),
      sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }),
      sse({ type: 'message_stop' }),
    ].join('');
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return new Response(fragmented(body), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      const provider = new AnthropicMessagesProvider(config('anthropic', server.port));
      const events = await collect(await provider.createStream(request, model('anthropic')));
      expect(received.stream).toBe(true);
      const reasoning = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
      expect(reasoning).toMatchObject({ item: { text: 'plan', signature: 'sig-1' } });
      expect(events.some((event) => event.type === 'response.output_text.annotation.added')).toBe(true);
      const tool = events.find((event) => event.type === 'response.function_call.arguments.done');
      expect(tool).toMatchObject({ arguments: '{"q":"x"}' });
      expect(events.filter((event) => event.type === 'response.usage').at(-1)).toMatchObject({ usage: { inputTokens: 7, cachedInputTokens: 3, outputTokens: 9 } });
      expect(events.at(-1)?.type).toBe('response.completed');
    } finally {
      server.stop(true);
    }
  });

  it('decodes Gemini deltas without duplicate items or terminal events', async () => {
    const body = [
      sse({ modelVersion: 'm1', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'plan', thought: true }] } }] }),
      sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer', thoughtSignature: 'thought-1' }] } }] }),
      sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: { q: 'x' } } }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['x'] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, totalTokenCount: 9, cachedContentTokenCount: 2, thoughtsTokenCount: 1 } }),
    ].join('');
    const server = serve({ port: 0, fetch: () => new Response(fragmented(body), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const provider = new GoogleGeminiProvider(config('google', server.port));
      const events = await collect(await provider.createStream(request, model('google')));
      expect(events.filter((event) => event.type === 'response.created')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'response.completed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'response.reasoning.delta')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'response.output_text.delta')).toHaveLength(1);
      expect(events.find((event) => event.type === 'response.function_call.arguments.done')).toMatchObject({ arguments: '{"q":"x"}' });
      expect(events.filter((event) => event.type === 'response.output_item.added' && event.item.type === 'extension')).toHaveLength(1);
      expect(events.find((event) => event.type === 'response.usage')).toMatchObject({ usage: { cachedInputTokens: 2, reasoningTokens: 1 } });
    } finally {
      server.stop(true);
    }
  });

  it('falls back from streaming to buffered JSON for all three protocols', async () => {
    const cases = [
      {
        type: 'openai-responses' as const, wire: 'openai-responses' as const,
        body: { id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'json openai-responses' }] }], usage: { input_tokens: 1, output_tokens: 1 } },
        make: (port: number) => new OpenAIResponsesProvider(config('responses', port)),
      },
      {
        type: 'anthropic-messages' as const, wire: 'anthropic-messages' as const,
        body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm1', content: [{ type: 'text', text: 'json anthropic-messages' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
        make: (port: number) => new AnthropicMessagesProvider(config('anthropic', port)),
      },
      {
        type: 'google-gemini' as const, wire: 'google-gemini' as const,
        body: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'json google-gemini' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
        make: (port: number) => new GoogleGeminiProvider(config('google', port)),
      },
    ];
    for (const test of cases) {
      const server = serve({ port: 0, fetch: () => Response.json(test.body) });
      try {
        const events = await collect(await test.make(server.port).createStream(request, model(test.wire)));
        expect(events.at(-1)?.type).toBe('response.completed');
        expect(events.some((event) => event.type === 'response.output_text.delta' && event.text === `json ${test.type}`)).toBe(true);
      } finally {
        server.stop(true);
      }
    }
  });

  it('rejects a native stream that ends before its terminal event', async () => {
    const server = serve({
      port: 0,
      fetch: () => new Response(sse({ type: 'response.created', response: { id: 'resp_1' } }), { headers: { 'content-type': 'text/event-stream' } }),
    });
    try {
      const provider = new OpenAIResponsesProvider(config('responses', server.port));
      const stream = await provider.createStream(request, model('responses'));
      await expect(collect(stream)).rejects.toThrow(/ended before completion/);
    } finally {
      server.stop(true);
    }
  });

  it('bounds raw capture without truncating semantic deltas', async () => {
    const text = 'x'.repeat(STREAM_CAPTURE_CAP + 4096);
    const captured: any[] = [];
    const body = [
      sse({ type: 'response.created', response: { id: 'resp_1' } }),
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }),
      sse({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }),
      sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }),
      sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }),
    ].join('');
    const server = serve({ port: 0, fetch: () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const provider = new OpenAIResponsesProvider(config('responses', server.port));
      const events = await collect(await provider.createStream(request, model('responses'), {
        recorder: { isEnabled: () => true, recordEvent: async (event: any) => captured.push(event) },
      } as any));
      expect(events.find((event) => event.type === 'response.output_text.delta')).toMatchObject({ text });
      expect(captured[1].wire.responseBody.endsWith('...[TRUNCATED]')).toBe(true);
      expect(Buffer.byteLength(captured[1].wire.responseBody)).toBeLessThan(STREAM_CAPTURE_CAP + 64);
    } finally {
      server.stop(true);
    }
  });
});
