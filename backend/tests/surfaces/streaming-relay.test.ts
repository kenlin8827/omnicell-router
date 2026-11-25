import { describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import { chatSurface } from '../../src/surfaces/chat.js';
import { runChatSurface } from '../../src/surfaces/chat-pipeline.js';
import { responsesSurface } from '../../src/surfaces/responses.js';
import { buildChatOcrCompletionFacts, buildChatOcrRoutingHeaders } from '../../src/surfaces/ocr-headers.js';
import type { TransportContext } from '../../src/surfaces/types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../../src/types/openai.js';
import type { CanonicalRequest, StreamEvent } from '../../src/ir/types.js';
import type { ExecutionResult } from '../../src/types/router.js';
import { createEventAccumulator } from '../../src/ir/stream.js';
import { ChatStreamDecoder } from '../../src/ir/adapters/openai-chat-stream.js';
import { OpenAIChatProvider } from '../../src/providers/executors/openai-chat.js';
import { UpstreamEventContext } from '../../src/observability/upstream-events.js';
import { UpstreamError } from '../../src/resilience/error-classifier.js';
import type { ModelRegistration, ProviderConfig } from '../../src/config/types.js';
import { responseIR, toIR } from '../helpers/ir.js';

/**
 * True upstream streaming (the end of "fake streaming"). Four contracts are
 * pinned here, in order of what would hurt if it regressed:
 *  1. bytes reach the transport WHILE the execution call is still pending;
 *  2. a turn that already committed bytes is never retried/failed over and never
 *     gets a JSON error body;
 *  3. the buffered response rebuilt from chunks is what accounting reads;
 *  4. headers flush with routing facts only — completion facts ride the summary.
 */

const fakeReq = { __fakeFastifyRequest: true } as unknown as import('fastify').FastifyRequest;

function makeTransport() {
  const ops: Array<{ op: string; arg?: unknown }> = [];
  const t: TransportContext = {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'user-agent': 'streaming-test' },
    clientIp: '127.0.0.1',
    access: { kind: 'key', keyName: 'k', policy: undefined, enforce: () => true },
    captureProcessContext: () => ({ fastifyRequest: fakeReq }),
    sendJson: (status, payload) => ops.push({ op: 'sendJson', arg: status }),
    beginSse: (headers) => ops.push({ op: 'beginSse', arg: headers }),
    writeSseChunk: (chunk) => ops.push({ op: 'write', arg: chunk }),
    endSse: () => ops.push({ op: 'end' }),
    isClientGone: () => false,
    logError: () => ops.push({ op: 'logError' }),
  };
  return { t, ops };
}

const streamRequest = (extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest =>
  ({
    model: 'qwen-3.8-flash',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    ...extra,
  }) as ChatCompletionRequest;

const bufferedResult = (over: Partial<ExecutionResult> = {}): ExecutionResult => ({
  response: responseIR('hello', {
    id: 'resp-1', createdAt: 1, model: 'p/m',
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
  }),
  tierUsed: 'lite',
  modelUsed: 'p/m',
  layerUsed: 'layer0',
  fallbackOccurred: false,
  failoverOccurred: false,
  failoverAttempts: 1,
  failoverPath: ['p/m'],
  inplaceRetries: 0,
  latencyMs: 1200,
  sessionId: 'sess-1',
  requestId: 'trace-1',
  actualEffort: 'low',
  requestedEffort: 'low',
  ...over,
});

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown): ChatCompletionChunk =>
  ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'upstream-model-id',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }) as ChatCompletionChunk;

/** Explicit Chat-wire fixture decoder feeding the canonical event accumulator. */
function chatAccumulator(options: { maxChars?: number } = {}) {
  const decoder = new ChatStreamDecoder();
  const accumulator = createEventAccumulator(options);
  return {
    push(frame: ChatCompletionChunk) {
      for (const event of decoder.push(frame)) accumulator.push(event);
    },
    finish() {
      for (const event of decoder.finish()) accumulator.push(event);
      return accumulator.finish();
    },
  };
}

describe('canonical event accumulator (what accounting reads)', () => {
  it('rebuilds content, status and usage from Chat-wire fixture frames', () => {
    const acc = chatAccumulator();
    acc.push(chunk({ role: 'assistant', content: '' }));
    acc.push(chunk({ content: 'he' }));
    acc.push(chunk({ content: 'llo' }));
    acc.push(chunk({}, 'stop'));
    acc.push({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } as ChatCompletionChunk);
    const res = acc.finish();
    expect(res.output[0]).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'hello' }] });
    expect(res.status).toBe('completed');
    expect(res.usage.totalTokens).toBe(5);
    expect(res.id).toBe('chatcmpl-1');
  });

  it('merges tool_call fragments by index without inventing a message', () => {
    const acc = chatAccumulator();
    acc.push(chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'write' } }] }));
    acc.push(chunk({}, 'tool_calls'));
    const res = acc.finish();
    expect(res.output.map((item) => item.type)).toEqual(['tool_call', 'tool_call']);
    expect(res.output.map((item) => item.type === 'tool_call' ? item.id : '')).toEqual(['call_a', 'call_b']);
    expect(res.output[0]).toMatchObject({ arguments: '{"path":"a"}' });
  });

  it('assigns immutable canonical item ids in arrival order when wire indexes arrive shuffled', () => {
    // Chat tool_calls.index correlates fragments; it is not a retroactive output
    // ordering key. Renumbering after item.added would break downstream streams.
    const acc = chatAccumulator();
    acc.push(chunk({ tool_calls: [{ index: 1, id: 'second', function: { name: 'b', arguments: '' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 0, id: 'first', function: { name: 'a', arguments: '' } }] }));
    expect(acc.finish().output.map((item) => item.type === 'tool_call' ? item.id : '')).toEqual(['second', 'first']);
  });

  it('folds reasoning fragments into a separate item before the answer', () => {
    const acc = chatAccumulator();
    acc.push(chunk({ role: 'assistant', reasoning_content: 'thin' }));
    acc.push(chunk({ reasoning_content: 'king', content: '' }));
    acc.push(chunk({ content: 'answer' }));
    acc.push(chunk({}, 'stop'));
    const res = acc.finish();
    expect(res.output[0]).toMatchObject({ type: 'reasoning', text: 'thinking' });
    expect(res.output[1]).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'answer' }] });
  });
});

describe('client-side chunk forwarding', () => {
  it('rewrites model to the served id and passes reasoning_content through', () => {
    const event: StreamEvent = { type: 'response.reasoning.delta', index: 0, text: 'think' };
    const frame = chatSurface.encodeChunk!(event, { model: 'p/m', includeUsage: false });
    const parsed = JSON.parse(frame!.replace('data: ', '').trim());
    expect(parsed.model).toBe('p/m');
    expect(parsed.choices[0].delta.reasoning_content).toBe('think');
  });

  it('drops the usage frame unless the client asked for it', () => {
    const event: StreamEvent = {
      type: 'response.usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    expect(chatSurface.encodeChunk!(event, { model: 'p/m', includeUsage: false })).toBeNull();
    expect(chatSurface.encodeChunk!(event, { model: 'p/m', includeUsage: true })).toContain('"usage"');
  });

  it('the buffered canonical re-chunker emits reasoning deltas before the answer', () => {
    const result = bufferedResult({
      response: responseIR('answer', {
        id: 'resp-r', createdAt: 1, model: 'p/m',
        output: [
          { type: 'reasoning', text: 'think' },
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        ],
      }),
    });
    const frames = chatSurface.encodeStream!(result, undefined);
    const deltas = frames
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame) => JSON.parse(frame.replace('data: ', '').trim()).choices?.[0]?.delta)
      .filter(Boolean);
    const reasoningText = deltas
      .filter((delta: any) => typeof delta.reasoning_content === 'string')
      .map((delta: any) => delta.reasoning_content)
      .join('');
    expect(reasoningText).toBe('think');
    const firstReasoning = frames.findIndex((frame) => frame.includes('reasoning_content'));
    const firstAnswer = frames.findIndex((frame) => frame.includes('"content":"answer"'));
    expect(firstReasoning >= 0 && firstReasoning < firstAnswer).toBe(true);
  });
});

describe('X-OCR header split', () => {
  it('routing block carries no completion-time lies', () => {
    const h = buildChatOcrRoutingHeaders({ modelUsed: 'p/m', tierUsed: 'lite', requestId: 't' }, 'gate');
    expect(h['X-OCR-Model']).toBe('p/m');
    expect(h['X-OCR-Latency-MS']).toBeUndefined();
    expect(h['X-OCR-Failover']).toBeUndefined();
    expect(h['X-OCR-Breaker-State']).toBeUndefined();
    expect(h['X-OCR-Thinking-Actual']).toBeUndefined();
  });

  it('completion facts are exactly the keys the routing block omits', () => {
    const routing = Object.keys(buildChatOcrRoutingHeaders({ modelUsed: 'p/m' }, 'gate'));
    const completion = Object.keys(buildChatOcrCompletionFacts(bufferedResult()));
    for (const k of completion) expect(routing).not.toContain(k);
    expect(completion).toContain('X-OCR-Latency-MS');
    expect(completion).toContain('X-OCR-Thinking-Actual');
  });
});

describe('chat pipeline relay ordering', () => {
  /** Stub orchestrator that streams frames while its own call is still pending. */
  function streamingStub(behavior: { failAfterFirstChunk?: boolean; extraChunks?: number } = {}) {
    const seen: { hasRelay: boolean } = { hasRelay: false };
    let markWritten: () => void = () => {};
    const written = new Promise<void>((resolve) => {
      markWritten = resolve;
    });
    const orchestrator = {
      process: async (req: CanonicalRequest, ctx: Record<string, unknown>, relay?: any) => {
        seen.hasRelay = relay !== undefined;
        if (!relay) return bufferedResult();
        relay.stageRouting({ modelUsed: 'p/m', tierUsed: 'lite', layerUsed: 'layer0', requestId: 't', sessionId: 's' });
        relay.onChunk({ type: 'response.created', id: 'resp-1', model: 'p/m', createdAt: 1 });
        relay.onChunk({ type: 'response.output_item.added', index: 0, item: { type: 'message', role: 'assistant', content: [] } });
        relay.onChunk({ type: 'response.content_part.added', index: 0, partIndex: 0, part: { type: 'text', text: '' } });
        relay.onChunk({ type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'a' });
        markWritten();
        await written; // proves the byte went out before the call resolved
        relay.onChunk({ type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'b' });
        if (behavior.extraChunks) {
          for (let i = 0; i < behavior.extraChunks; i++) {
            relay.onChunk({ type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'x' });
          }
        }
        if (behavior.failAfterFirstChunk) throw new Error('upstream died mid-stream');
        return bufferedResult();
      },
    } as unknown as Parameters<typeof runChatSurface>[2];
    return { orchestrator, seen };
  }

  it('flushes headers and the first frame BEFORE execution completes', async () => {
    const { t, ops } = makeTransport();
    const { orchestrator, seen } = streamingStub();
    await runChatSurface(t, chatSurface, orchestrator, streamRequest());
    expect(seen.hasRelay).toBe(true);
    const sequence = ops.map((o) => o.op);
    expect(sequence.slice(0, 3)).toEqual(['beginSse', 'write', 'write']);
    expect(sequence[sequence.length - 2]).toBe('write'); // [DONE]
    expect(sequence[sequence.length - 1]).toBe('end');
    const summary = ops.filter((o) => o.op === 'write').map((o) => String(o.arg));
    expect(summary.some((s) => s.startsWith(': ocr-summary '))).toBe(true);
    expect(summary[summary.length - 1]).toBe('data: [DONE]\n\n');
    // headers were the routing subset only
    const headers = ops.find((o) => o.op === 'beginSse')?.arg as Record<string, string>;
    expect(headers['X-OCR-Model']).toBe('p/m');
    expect(headers['X-OCR-Request-ID']).toBe('t');
    expect(headers['X-OCR-Latency-MS']).toBeUndefined();
  });

  it('never sends a JSON error and never sends [DONE] after a committed failure', async () => {
    const { t, ops } = makeTransport();
    const { orchestrator } = streamingStub({ failAfterFirstChunk: true });
    await runChatSurface(t, chatSurface, orchestrator, streamRequest());
    const frames = ops.filter((o) => o.op === 'write').map((o) => String(o.arg));
    expect(ops.some((o) => o.op === 'sendJson')).toBe(false);
    expect(frames).not.toContain('data: [DONE]\n\n');
    expect(ops[ops.length - 1].op).toBe('end');
    expect(ops.some((o) => o.op === 'logError')).toBe(true);
  });

  it('keeps the clean JSON error path when nothing was committed', async () => {
    const { t, ops } = makeTransport();
    const orchestrator = {
      process: async () => {
        throw new Error('no pool');
      },
    } as unknown as Parameters<typeof runChatSurface>[2];
    await runChatSurface(t, chatSurface, orchestrator, streamRequest());
    expect(ops.map((o) => o.op)).toEqual(['logError', 'sendJson']);
  });

  it('offers no relay to a surface that hooks afterResult', async () => {
    const { t } = makeTransport();
    let sawRelay = true;
    const hooked = { ...chatSurface, afterResult: () => {} };
    const orchestrator = {
      process: async (_r: ChatCompletionRequest, _c: unknown, relay?: unknown) => {
        sawRelay = relay !== undefined;
        return bufferedResult();
      },
    } as unknown as Parameters<typeof runChatSurface>[2];
    await runChatSurface(t, hooked as any, orchestrator, streamRequest());
    expect(sawRelay).toBe(false);
  });

  it('offers no relay on the non-streaming leg (C-3 normalization included)', async () => {
    for (const body of [streamRequest({ stream: false }), streamRequest({ stream: 'true' as any })]) {
      const { t } = makeTransport();
      let sawRelay = true;
      const orchestrator = {
        process: async (_r: ChatCompletionRequest, _c: unknown, relay?: unknown) => {
          sawRelay = relay !== undefined;
          return bufferedResult();
        },
      } as unknown as Parameters<typeof runChatSurface>[2];
      await runChatSurface(t, chatSurface, orchestrator, body);
      expect(sawRelay).toBe(false);
    }
  });

  it('the responses surface relays chunks with a full lifecycle (anthropic stays buffered)', () => {
    expect(typeof responsesSurface.encodeChunk).toBe('function');
    expect(typeof responsesSurface.streamStart).toBe('function');
    expect(typeof responsesSurface.streamEnd).toBe('function');
    expect(responsesSurface.afterResult).toBeDefined();
  });
});

describe('provider streaming leg (capture + error class)', () => {
  const modelReg = (): ModelRegistration =>
    ({
      id: 'test-provider/test-model',
      provider: 'test-provider',
      upstreamModel: 'upstream-model-id',
      tier: 'lite',
      isDefaultInTier: false,
      wire: 'openai-chat',
      pricing: { input: 1, output: 2, cacheRead: 0.25 },
    }) as ModelRegistration;

  const fakeRecorder = (sink: any[]) => ({ isEnabled: () => true, recordEvent: async (e: any) => sink.push(e) } as any);

  it('emits a paired request/response exchange event for the SSE body', async () => {
    const events: any[] = [];
    const server = serve({
      port: 0,
      async fetch() {
        return new Response(
          `data: ${JSON.stringify(chunk({ content: 'hi' }))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      },
    });
    try {
      const provider = new OpenAIChatProvider({
        name: 'test-provider',
        type: 'openai-chat',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      } as ProviderConfig);
      const stream = await provider.createStream(
        toIR({ model: 'x', messages: [] }),
        modelReg(),
        new UpstreamEventContext({ recorder: fakeRecorder(events), sessionId: 's', requestId: 't', model: 'x' })
      );
      for await (const _c of stream) void _c;
    } finally {
      server.stop(true);
    }
    const phases = events.map((e) => `${e.direction}/${e.phase}`);
    expect(phases).toEqual(['upstream/request', 'upstream/response']);
    expect(events[0].wire.requestBody).toContain('"stream":true');
    expect(events[0].wire.requestBody).toContain('include_usage');
    expect(events[1].wire.responseBody).toContain('data: [DONE]');
    // Streaming responses carry the first-chunk stamp: TTFT/decode split for
    // the capture plane derives from the SAME event (see CaptureRequestSummary).
    // (Range vs request-ts is pinned in capture.test.ts — the raw event here
    // carries no ts; the real recorder assigns it at persist time.)
    expect(typeof events[1].firstByteTs).toBe('number');
    expect(events.map((e) => e.exchangeId)[0]).toBe(events[1].exchangeId);
  });

  it('raises UpstreamError (not a bare Error) on a non-2xx head, and pairs the event', async () => {
    const events: any[] = [];
    const server = serve({
      port: 0,
      async fetch() {
        return new Response('upstream busy', { status: 429, headers: { 'retry-after': '7' } });
      },
    });
    let caught: unknown;
    try {
      const provider = new OpenAIChatProvider({
        name: 'test-provider',
        type: 'openai-chat',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      } as ProviderConfig);
      await provider.createStream(
        toIR({ model: 'x', messages: [] }),
        modelReg(),
        new UpstreamEventContext({ recorder: fakeRecorder(events), sessionId: 's', requestId: 't', model: 'x' })
      );
    } catch (err) {
      caught = err;
    } finally {
      server.stop(true);
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as InstanceType<typeof UpstreamError>).status).toBe(429);
    expect((caught as any).retryAfterSeconds).toBe(7);
    expect(events.map((e) => `${e.direction}/${e.phase}`)).toEqual(['upstream/request', 'upstream/response']);
    expect(events[1].error).toContain('Upstream 429');
  });

  // The idle deadline bounds EVERY wait on the provider leg, not just the body
  // reads. A head that never arrives had no deadline at all before this (only
  // the 60-minute total timeout), which is exactly the shape of a request that
  // hangs until the gateway is restarted.
  it('fails a head that never arrives at the idle deadline', async () => {
    const events: any[] = [];
    const server = serve({
      port: 0,
      // Never answers: the client must give up on its own budget.
      async fetch() {
        return new Promise<Response>(() => {});
      },
    });
    let caught: unknown;
    try {
      const provider = new OpenAIChatProvider({
        name: 'test-provider',
        type: 'openai-chat',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
        streamIdleTimeoutMs: 120,
      } as ProviderConfig);
      await provider.createStream(
        toIR({ model: 'x', messages: [] }),
        modelReg(),
        new UpstreamEventContext({ recorder: fakeRecorder(events), sessionId: 's', requestId: 't', model: 'x' })
      );
    } catch (err) {
      caught = err;
    } finally {
      server.stop(true);
    }
    expect((caught as Error).message).toContain('stream idle for 120ms');
  });

  it('fails a body that stalls after the first frame at the idle deadline, and pairs the event', async () => {
    const events: any[] = [];
    const server = serve({
      port: 0,
      async fetch() {
        const encoder = new TextEncoder();
        // One frame, then silence: the reader's next read never settles.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: 'hi' }))}\n\n`));
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    let caught: unknown;
    const seen: string[] = [];
    try {
      const provider = new OpenAIChatProvider({
        name: 'test-provider',
        type: 'openai-chat',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
        streamIdleTimeoutMs: 120,
      } as ProviderConfig);
      const stream = await provider.createStream(
        toIR({ model: 'x', messages: [] }),
        modelReg(),
        new UpstreamEventContext({ recorder: fakeRecorder(events), sessionId: 's', requestId: 't', model: 'x' })
      );
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') seen.push(event.text);
      }
    } catch (err) {
      caught = err;
    } finally {
      server.stop(true);
    }
    expect(seen).toEqual(['hi']);
    expect((caught as Error).message).toContain('stream idle for 120ms');
    // The stalled exchange must still close in the archive: an unanswered
    // upstream leg is what leaves the console showing a turn pending forever.
    expect(events.map((e) => `${e.direction}/${e.phase}`)).toEqual(['upstream/request', 'upstream/response']);
    expect(events[1].error).toContain('stream idle for 120ms');
    expect(events[1].wire.responseBody).toContain('hi');
  });
});

describe('canonical accumulator memory bound', () => {
  const frame = (delta: Record<string, unknown>): ChatCompletionChunk =>
    ({
      id: 'chatcmpl-cap',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'up-1',
      choices: [{ index: 0, delta, finish_reason: null }],
    }) as ChatCompletionChunk;

  it('fails the turn instead of growing without bound when the payload exceeds the cap', () => {
    const acc = chatAccumulator({ maxChars: 8 });
    acc.push(frame({ role: 'assistant', content: '1234' }));
    expect(() => acc.push(frame({ content: '56789' }))).toThrow(/accumulation cap/);
  });

  it('charges tool-call arguments too, not just content', () => {
    const acc = chatAccumulator({ maxChars: 8 });
    acc.push(frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '12345' } }] }));
    expect(() =>
      acc.push(frame({ tool_calls: [{ index: 0, function: { arguments: '67890' } }] }))
    ).toThrow(/accumulation cap/);
  });

  it('a normal answer stays inside the default cap', () => {
    const acc = chatAccumulator();
    acc.push(frame({ role: 'assistant', content: 'hello ' }));
    acc.push(frame({ content: 'world' }));
    expect(acc.finish().output[0]).toMatchObject({ content: [{ type: 'text', text: 'hello world' }] });
  });
});
