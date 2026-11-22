import { describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import type { ModelRegistration, ProviderConfig } from '../../src/config/types.js';
import { SseParser, STREAM_SSE_FRAME_MAX_CHARS } from '../../src/providers/executors/http-stream.js';
import { OpenAIResponsesProvider } from '../../src/providers/executors/openai-responses.js';
import { toIR } from '../helpers/ir.js';

const request = toIR({ model: 'p/m1', stream: true, messages: [{ role: 'user', content: 'hi' }] });
const model: ModelRegistration = {
  id: 'p/m1', provider: 'p', upstreamModel: 'm1', tier: 'plus', wire: 'openai-responses',
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
};

describe('stream resource boundaries', () => {
  it('accepts a large network chunk made of complete small SSE frames', () => {
    const parser = new SseParser();
    const comments = ': keep-alive\n'.repeat(Math.ceil((STREAM_SSE_FRAME_MAX_CHARS + 1) / ': keep-alive\n'.length));
    const frames = parser.push(`${comments}data: {"ok":true}\n\n`);
    expect(comments.length).toBeGreaterThan(STREAM_SSE_FRAME_MAX_CHARS);
    expect(frames).toEqual([{ data: '{"ok":true}' }]);
  });

  it('rejects one unterminated line or data frame above the cap', () => {
    const parser = new SseParser();
    expect(() => parser.push('x'.repeat(STREAM_SSE_FRAME_MAX_CHARS + 1))).toThrow(/SSE frame exceeded/);
    const data = new SseParser();
    expect(() => data.push(`data: ${'x'.repeat(STREAM_SSE_FRAME_MAX_CHARS + 1)}\n\n`)).toThrow(/SSE frame exceeded/);
  });

  it('rejects a non-SSE JSON body above the shared frame cap', async () => {
    const huge = `{"id":"resp_huge","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"${'x'.repeat(STREAM_SSE_FRAME_MAX_CHARS + 1)}"}]}]}`;
    const server = serve({
      port: 0,
      fetch: () => new Response(huge, { headers: { 'content-type': 'application/json' } }),
    });
    try {
      const config: ProviderConfig = {
        name: 'p', type: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'sk-test',
      };
      const provider = new OpenAIResponsesProvider(config);
      const stream = await provider.createStream(request, model);
      await expect((async () => { for await (const _ of stream) void _; })()).rejects.toThrow(/non-SSE body exceeded/);
    } finally {
      server.stop(true);
    }
  });

  it('Responses JSON fallback and buffered calls share failed-turn semantics', async () => {
    const server = serve({
      port: 0,
      fetch: () => Response.json({ id: 'resp_failed', status: 'failed', output: [], error: { message: 'model failed' } }),
    });
    try {
      const config: ProviderConfig = {
        name: 'p', type: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'sk-test',
      };
      const provider = new OpenAIResponsesProvider(config);
      await expect(provider.createCompletion(request, model)).rejects.toThrow('model failed');
      const stream = await provider.createStream(request, model);
      await expect((async () => { for await (const _ of stream) void _; })()).rejects.toThrow('model failed');
    } finally {
      server.stop(true);
    }
  });
});
