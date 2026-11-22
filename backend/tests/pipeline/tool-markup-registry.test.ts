import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '../../src/providers/registry';
import { ChatStreamDecoder } from '../../src/ir/adapters/openai-chat-stream.js';
import type { LLMProvider } from '../../src/providers/base';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../src/ir/types';
import type { ModelRegistration, ProviderConfig, RouterConfig } from '../../src/config/types';
import type { StreamRelay } from '../../src/utils/stream-relay';

const LEAK =
  '<|DSML|tool_calls><|DSML|invoke name="read">' +
  '<|DSML|parameter name="path" string="true">a.ts</|DSML|parameter>' +
  '</|DSML|invoke></|DSML|tool_calls>';

function request(withTools = true): CanonicalRequest {
  return {
    model: 'p/deepseek-v4-flash',
    stream: true,
    input: [],
    ...(withTools ? {
      tools: [{
        type: 'function',
        function: {
          name: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      }],
    } : {}),
  };
}

function model(): ModelRegistration {
  return {
    id: 'p/deepseek-v4-flash',
    provider: 'p',
    upstreamModel: 'deepseek-v4-flash',
    tier: 'plus',
    pricing: { input: 0, output: 0, cacheRead: 0 },
  };
}

function providerConfig(baseUrl: string): ProviderConfig {
  return { name: 'p', type: 'openai-chat', baseUrl, apiKey: 'test' };
}

function responseWith(text: string): CanonicalResponse {
  return {
    id: 'resp_registry',
    status: 'completed',
    reason: 'stop',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text }] }],
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function registryWith(baseUrl: string, provider: LLMProvider): ProviderRegistry {
  const registry = new ProviderRegistry({
    port: 3000,
    host: '127.0.0.1',
    models: [],
    tiers: {},
    circuitBreaker: { enabled: false },
  } as RouterConfig, false);
  registry.setAutoRefreshTierMatch(false);
  registry.registerProvider('p', provider, undefined, providerConfig(baseUrl));
  return registry;
}

function relaySink(): { relay: StreamRelay; frames: StreamEvent[]; transports: string[] } {
  const frames: StreamEvent[] = [];
  const transports: string[] = [];
  return {
    frames,
    transports,
    relay: {
      stageRouting: () => {},
      onChunk: (event) => { frames.push(event); },
      onTransport: (kind) => { transports.push(kind); },
      get committed() { return frames.length > 0; },
    },
  };
}

async function* decodedStream(text: string): AsyncIterable<StreamEvent> {
  const decoder = new ChatStreamDecoder();
  const chunk = (content: string, finishReason: string | null = null) => ({
    id: 'resp_registry', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  });
  for (const event of decoder.push(chunk(text) as any)) yield event;
  for (const event of decoder.push(chunk('', 'stop') as any)) yield event;
  for (const event of decoder.finish()) yield event;
}

function streamingProvider(text: string, calls: { buffered: number; streamed: number }): LLMProvider {
  return {
    name: 'p',
    supportsStreaming: () => true,
    createCompletion: async () => {
      calls.buffered += 1;
      throw new Error('the native stream path must be used');
    },
    createStream: async () => {
      calls.streamed += 1;
      return decodedStream(text);
    },
  };
}

function textOf(response: CanonicalResponse): string {
  const message = response.output.find((item) => item.type === 'message');
  return message?.type === 'message'
    ? message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
    : '';
}

function streamedText(frames: StreamEvent[]): string {
  return frames.flatMap((event) => event.type === 'response.output_text.delta' ? [event.text] : []).join('');
}

describe('tool markup recovery — ProviderRegistry execution chain', () => {
  test('recovers a scoped buffered response and exposes the recovery count', async () => {
    const provider: LLMProvider = { name: 'p', createCompletion: async () => responseWith(LEAK) };
    const registry = registryWith('https://opencode.ai/zen/v1', provider);
    const response = await registry.execute(request(), model());
    expect(response.toolTextRecovery).toEqual({ kind: 'dsml', calls: 1 });
    expect(response.output.filter((item) => item.type === 'tool_call')).toHaveLength(1);
    expect(textOf(response)).toBe('');
  });

  test('recovers a scoped native SSE stream without converting it to buffered execution', async () => {
    const calls = { buffered: 0, streamed: 0 };
    const registry = registryWith('https://opencode.ai/zen/v1', streamingProvider(LEAK, calls));
    const { relay, frames, transports } = relaySink();
    const response = await registry.execute(request(), model(), undefined, undefined, relay);
    expect(calls).toEqual({ buffered: 0, streamed: 1 });
    expect(transports).toEqual(['sse']);
    expect(response.toolTextRecovery).toEqual({ kind: 'dsml', calls: 1 });
    expect(response.output.filter((item) => item.type === 'tool_call')).toHaveLength(1);
    expect(streamedText(frames)).not.toContain('invoke');
  });

  for (const baseUrl of ['https://api.deepseek.com/v1', 'https://opencode.ai/other/v1']) {
    test(`keeps an unscoped native stream unchanged: ${baseUrl}`, async () => {
      const calls = { buffered: 0, streamed: 0 };
      const registry = registryWith(baseUrl, streamingProvider(LEAK, calls));
      const { relay, frames, transports } = relaySink();
      const response = await registry.execute(request(), model(), undefined, undefined, relay);
      expect(calls).toEqual({ buffered: 0, streamed: 1 });
      expect(transports).toEqual(['sse']);
      expect(response.toolTextRecovery).toBeUndefined();
      expect(response.output.some((item) => item.type === 'tool_call')).toBe(false);
      expect(textOf(response)).toBe(LEAK);
      expect(streamedText(frames)).toBe(LEAK);
    });
  }

  test('does not enter recovery for a request without callable tools', async () => {
    const calls = { buffered: 0, streamed: 0 };
    const registry = registryWith('https://opencode.ai/zen/v1', streamingProvider(LEAK, calls));
    const { relay, frames } = relaySink();
    const response = await registry.execute(request(false), model(), undefined, undefined, relay);
    expect(calls).toEqual({ buffered: 0, streamed: 1 });
    expect(response.toolTextRecovery).toBeUndefined();
    expect(response.output.some((item) => item.type === 'tool_call')).toBe(false);
    expect(textOf(response)).toBe(LEAK);
    expect(streamedText(frames)).toBe(LEAK);
  });
});
