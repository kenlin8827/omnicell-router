import { describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { ModelRegistration, ProviderConfig } from '../src/config/types.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

function makeModel(): ModelRegistration {
  return {
    id: 'test-provider/test-model',
    provider: 'test-provider',
    upstreamModel: 'upstream-model-id',
    tier: 'plus',
    isDefaultInTier: false,
    wire: 'openai',
    pricing: { input: 1, output: 2, cacheRead: 0.25 },
  };
}

/**
 * Regression: `createCompletion` is the BUFFERED leg (a wire with no streaming
 * executor, the schema-assertion cascade, mock mode, or a client that did not
 * ask for a stream), so a client-sent `stream_options` must be stripped — strict
 * upstreams (e.g. Alibaba) reject stream_options without stream:true with a 400.
 * A streamed client is served by `createStream` instead, which sets both.
 */
describe('OpenAICompatibleProvider payload shaping', () => {
  test('createCompletion strips stream_options from a non-streaming payload', async () => {
    let received: any = null;
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'upstream-model-id',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    try {
      const config: ProviderConfig = {
        name: 'test-provider',
        type: 'openai',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      };
      const provider = new OpenAICompatibleProvider(config);
      const request: ChatCompletionRequest = {
        model: 'test-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      } as ChatCompletionRequest;

      const res = await provider.createCompletion(request, makeModel());
      expect(res.object).toBe('chat.completion');
      expect(received).not.toBeNull();
      expect(received.stream).toBe(false);
      expect(received.stream_options).toBeUndefined();
      expect(received.router_options).toBeUndefined();
      expect(received.model).toBe('upstream-model-id');
    } finally {
      server.stop(true);
    }
  });

  test('createCompletion strips temperature when model.temperature === false (models.dev tri-state)', async () => {
    let received: any = null;
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'upstream-model-id',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    try {
      const config: ProviderConfig = {
        name: 'test-provider',
        type: 'openai',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      };
      const provider = new OpenAICompatibleProvider(config);
      const request: ChatCompletionRequest = {
        model: 'test-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 1,
        top_p: 0.9,
      } as ChatCompletionRequest;

      // false → strip temperature (top_p has no capability flag, so it still passes through)
      const stripped = { ...makeModel(), temperature: false as const };
      await provider.createCompletion(request, stripped);
      expect(received.temperature).toBeUndefined();
      expect(received.top_p).toBe(0.9);

      // true / undefined → passed through unchanged
      await provider.createCompletion(request, { ...makeModel(), temperature: true });
      expect(received.temperature).toBe(1);
      await provider.createCompletion(request, makeModel());
      expect(received.temperature).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test('createStream sets stream and stream_options together', async () => {
    let received: any = null;
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        const body = `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'upstream-model-id',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
        })}\n\ndata: [DONE]\n\n`;
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    });

    try {
      const config: ProviderConfig = {
        name: 'test-provider',
        type: 'openai',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      };
      const provider = new OpenAICompatibleProvider(config);
      const request: ChatCompletionRequest = {
        model: 'test-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
      };

      const stream = await provider.createStream(request, makeModel());
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks.length).toBe(1);
      expect(received.stream).toBe(true);
      expect(received.stream_options).toEqual({ include_usage: true });
    } finally {
      server.stop(true);
    }
  });

  test('createCompletion forwards reasoning_effort to upstream', async () => {
    let received: any = null;
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'upstream-model-id',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    try {
      const config: ProviderConfig = {
        name: 'test-provider',
        type: 'openai',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      };
      const provider = new OpenAICompatibleProvider(config);
      const request: ChatCompletionRequest = {
        model: 'test-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
      } as ChatCompletionRequest;

      await provider.createCompletion(request, makeModel());
      expect(received.reasoning_effort).toBe('high');
    } finally {
      server.stop(true);
    }
  });

  test('createStream forwards reasoning_effort to upstream', async () => {
    let received: any = null;
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return new Response(
          `data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\n` +
            `data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n` +
            `data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      },
    });

    try {
      const config: ProviderConfig = {
        name: 'test-provider',
        type: 'openai',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      };
      const provider = new OpenAICompatibleProvider(config);
      const request: ChatCompletionRequest = {
        model: 'test-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'medium',
      } as ChatCompletionRequest;

      const stream = await provider.createStream(request, makeModel());
      for await (const _ of stream) { /* drain */ }
      expect(received.reasoning_effort).toBe('medium');
    } finally {
      server.stop(true);
    }
  });

  // P1.3 regression removed: the openai-compatible provider used to
  // translate `max` → `xhigh` here, but the orchestrator's downgrade step
  // already collapses `max` to the model's highest supported tier before
  // reaching this provider. A `max` that survives is a config error and
  // should surface as an upstream 400, not be silently masked.
  test('createCompletion forwards reasoning_effort verbatim', async () => {
    let received: any = null;
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'upstream-model-id',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    try {
      const config: ProviderConfig = {
        name: 'test-provider',
        type: 'openai',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      };
      const provider = new OpenAICompatibleProvider(config);
      const request: ChatCompletionRequest = {
        model: 'test-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
      } as ChatCompletionRequest;

      await provider.createCompletion(request, makeModel());
      expect(received.reasoning_effort).toBe('high');
    } finally {
      server.stop(true);
    }
  });
});
