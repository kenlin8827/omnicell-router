import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import type http from 'node:http';
import { createClientLegWatchdog, writeWithBackpressure } from '../src/surfaces/transport-backpressure.js';
import { runChatSurface } from '../src/surfaces/chat-pipeline.js';
import { chatSurface } from '../src/surfaces/chat.js';
import type { TransportContext } from '../src/surfaces/types.js';
import type { CanonicalRequest, StreamEvent } from '../src/ir/types.js';
import type { ModelRegistration } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { LLMProvider } from '../src/providers/base.js';
import type { StreamRelay } from '../src/utils/stream-relay.js';
import { OpenAIResponsesProvider } from '../src/providers/executors/openai-responses.js';
import { responseIR, toIR } from './helpers/ir.js';

function bufferedResult() {
  return {
    response: responseIR('hello'),
    tierUsed: 'plus', modelUsed: 'p/m', layerUsed: 'layer0',
    fallbackOccurred: false, failoverOccurred: false, failoverAttempts: 1,
    failoverPath: ['p/m'], inplaceRetries: 0, latencyMs: 1,
    sessionId: 's', requestId: 'r', actualEffort: 'low', requestedEffort: 'low',
  } as const;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('stream backpressure and resource release', () => {
  it('waits for drain and resolves rather than hanging on close', async () => {
    const response = new EventEmitter() as http.ServerResponse;
    let writes = 0;
    response.write = (() => { writes++; return false; }) as any;
    const first = writeWithBackpressure(response, 'first', () => {});
    const second = writeWithBackpressure(response, 'second', () => {});
    expect(writes).toBe(2);
    response.emit('drain');
    await first;
    response.emit('close');
    await second;
  });

  // The client leg has its own deadline: a peer that neither drains nor closes
  // (Bun keeps a dead socket writable and silent) used to park the relay — and
  // with it the terminal capture event — forever.
  it('abandons and destroys a write the peer never drains', async () => {
    const response = new EventEmitter() as http.ServerResponse;
    const errors: unknown[] = [];
    let destroyed = 0;
    response.write = (() => false) as any;
    (response as any).destroy = () => { destroyed++; };
    await writeWithBackpressure(response, 'stuck', (err) => errors.push(err), 20);
    expect(destroyed).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('did not drain within 20ms');
  });

  it('does not touch a write the peer drains inside the deadline', async () => {
    const response = new EventEmitter() as http.ServerResponse;
    const errors: unknown[] = [];
    let destroyed = 0;
    response.write = (() => false) as any;
    (response as any).destroy = () => { destroyed++; };
    const pending = writeWithBackpressure(response, 'slow-but-alive', (err) => errors.push(err), 60);
    setTimeout(() => response.emit('drain'), 10);
    await pending;
    await new Promise((r) => setTimeout(r, 80));
    expect(destroyed).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it('watchdog fires once on a silent leg, waits for nothing else', async () => {
    const stalls: number[] = [];
    createClientLegWatchdog({ idleTimeoutMs: 20, onStall: (ms) => stalls.push(ms) });
    await new Promise((r) => setTimeout(r, 70));
    expect(stalls).toEqual([20]);
  });

  it('watchdog stays quiet while frames move and disarms on stop', async () => {
    const stalls: number[] = [];
    const watchdog = createClientLegWatchdog({ idleTimeoutMs: 20, onStall: () => stalls.push(1) });
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 10));
      watchdog.progress();
    }
    expect(stalls).toHaveLength(0);
    watchdog.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(stalls).toHaveLength(0);
  });

  it('serializes surface frames and execution behind a slow client write', async () => {
    const gate = deferred();
    const sequence: string[] = [];
    let writes = 0;
    const transport: TransportContext = {
      method: 'POST', url: '/v1/chat/completions', headers: {}, clientIp: undefined,
      access: { kind: 'key', keyName: '', policy: undefined, enforce: () => true },
      captureProcessContext: () => ({}),
      sendJson: () => { sequence.push('json'); },
      beginSse: () => { sequence.push('begin'); },
      writeSseChunk: () => {
        writes++;
        sequence.push(`write:${writes}`);
        return writes === 1 ? gate.promise : undefined;
      },
      endSse: () => { sequence.push('end'); },
      isClientGone: () => false,
      logError: () => {},
    };
    const orchestrator = {
      process: async (_request: CanonicalRequest, _context: unknown, relay: StreamRelay) => {
        relay.stageRouting({ modelUsed: 'p/m' });
        await relay.onChunk({ type: 'response.created', id: 'r', model: 'p/m' });
        await relay.onChunk({ type: 'response.output_item.added', index: 0, item: { type: 'message', role: 'assistant', content: [] } });
        await relay.onChunk({ type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'a' });
        sequence.push('first-accepted');
        await relay.onChunk({ type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'b' });
        sequence.push('second-accepted');
        return {
          ...bufferedResult(),
          response: responseIR('ab'),
        };
      },
    } as any;
    const running = runChatSurface(transport, chatSurface, orchestrator, {
      model: 'p/m', stream: true, messages: [{ role: 'user', content: 'hi' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sequence).not.toContain('first-accepted');
    expect(writes).toBe(1);
    gate.resolve();
    await running;
    expect(sequence.indexOf('write:2')).toBeLessThan(sequence.indexOf('first-accepted'));
    expect(sequence.indexOf('first-accepted')).toBeLessThan(sequence.indexOf('write:3'));
    expect(sequence.indexOf('second-accepted')).toBeLessThan(sequence.indexOf('end'));
  });

  it('awaits client backpressure in the provider registry drain', async () => {
    const gate = deferred();
    const seen: string[] = [];
    const events: StreamEvent[] = [
      { type: 'response.created', id: 'r' },
      { type: 'response.output_item.added', index: 0, item: { type: 'message', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', index: 0, partIndex: 0, part: { type: 'text', text: '' } },
      { type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'ok' },
      { type: 'response.output_text.done', index: 0, partIndex: 0, text: 'ok' },
      { type: 'response.output_item.done', index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      { type: 'response.usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'response.completed' },
    ];
    const provider: LLMProvider = {
      name: 'p',
      createCompletion: async () => responseIR('unused'),
      createStream: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            seen.push(`upstream:${event.type}`);
            yield event;
          }
        },
      }),
    };
    const registry = new ProviderRegistry({ models: [] } as any);
    registry.registerProvider('p', provider);
    const model: ModelRegistration = {
      id: 'p/m', provider: 'p', upstreamModel: 'm', tier: 'plus', wire: 'openai-chat',
      pricing: { input: 1, output: 1, cacheRead: 0.1 },
    };
    registry.registerModel(model);
    let delayed = true;
    const relay: StreamRelay = {
      stageRouting: () => {},
      get committed() { return false; },
      onChunk: (event) => {
        seen.push(`client:${event.type}`);
        if (delayed) {
          delayed = false;
          return gate.promise;
        }
      },
    };
    const running = registry.execute(toIR({ model: 'p/m', stream: true, messages: [] }), model, undefined, undefined, relay);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.filter((entry) => entry.startsWith('upstream:'))).toEqual(['upstream:response.created']);
    gate.resolve();
    const response = await running;
    expect(response.output[0]).toMatchObject({ content: [{ text: 'ok' }] });
    expect(seen.filter((entry) => entry.startsWith('upstream:'))).toHaveLength(events.length);
  });

  it('cancels the upstream body when the consumer exits the iterator early', async () => {
    let cancelled = false;
    const server = serve({
      port: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"r"}}\n\n'));
        },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    });
    try {
      const provider = new OpenAIResponsesProvider({
        name: 'p', type: 'openai-responses', baseUrl: `http://localhost:${server.port}/v1`, apiKey: 'sk',
      });
      const model: ModelRegistration = {
        id: 'p/m', provider: 'p', upstreamModel: 'm', tier: 'plus', wire: 'openai-responses',
        pricing: { input: 1, output: 1, cacheRead: 0.1 },
      };
      const stream = await provider.createStream(toIR({ model: 'p/m', stream: true, messages: [] }), model);
      for await (const event of stream) {
        expect(event.type).toBe('response.created');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cancelled).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
