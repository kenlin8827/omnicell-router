import { describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import { chatSurface } from '../src/surfaces/chat.js';
import { runChatSurface } from '../src/surfaces/chat-pipeline.js';
import { responsesSurface } from '../src/surfaces/responses.js';
import { buildChatOcrCompletionFacts, buildChatOcrRoutingHeaders } from '../src/surfaces/ocr-headers.js';
import type { TransportContext } from '../src/surfaces/types.js';
import type { ChatCompletionRequest } from '../src/types/openai.js';
import type { ExecutionResult } from '../src/types/router.js';
import { createChunkAccumulator } from '../src/utils/chat-stream.js';
import { buildChatStreamChunks } from '../src/utils/chat-sse.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { UpstreamError } from '../src/resilience/error-classifier.js';
import type { ModelRegistration, ProviderConfig } from '../src/config/types.js';

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

const bufferedResult = (over: Partial<ExecutionResult> = {}): ExecutionResult =>
  ({
    response: {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'p/m',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    },
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
    traceId: 'trace-1',
    actualEffort: 'low',
    requestedEffort: 'low',
    ...over,
  }) as ExecutionResult;

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
  ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'upstream-model-id',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }) as any;

describe('chunk accumulator (what accounting reads)', () => {
  it('rebuilds content, finish_reason and usage from frames', () => {
    const acc = createChunkAccumulator();
    acc.push(chunk({ role: 'assistant', content: '' }));
    acc.push(chunk({ content: 'he' }));
    acc.push(chunk({ content: 'llo' }));
    acc.push(chunk({}, 'stop'));
    acc.push({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } as any);
    const res = acc.finish();
    expect(res.choices[0].message.content).toBe('hello');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage?.total_tokens).toBe(5);
    expect(res.id).toBe('chatcmpl-1');
  });

  it('merges tool_call fragments by index and keeps content null', () => {
    const acc = createChunkAccumulator();
    acc.push(chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'write' } }] }));
    acc.push(chunk({}, 'tool_calls'));
    const res = acc.finish();
    expect(res.choices[0].message.content).toBeNull();
    expect(res.choices[0].finish_reason).toBe('tool_calls');
    expect(res.choices[0].message.tool_calls?.map((tc) => tc.id)).toEqual(['call_a', 'call_b']);
    expect(res.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"path":"a"}');
  });

  it('orders tool calls by index even when fragments arrive shuffled', () => {
    const acc = createChunkAccumulator();
    acc.push(chunk({ tool_calls: [{ index: 1, id: 'second', function: { name: 'b', arguments: '' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 0, id: 'first', function: { name: 'a', arguments: '' } }] }));
    expect(acc.finish().choices[0].message.tool_calls?.map((tc) => tc.id)).toEqual(['first', 'second']);
  });
});

describe('client-side chunk forwarding', () => {
  it('rewrites model to the served id and passes reasoning_content through', () => {
    const frame = chatSurface.encodeChunk!(chunk({ reasoning_content: 'think', content: 'hi' }), {
      model: 'p/m',
      includeUsage: false,
    });
    const parsed = JSON.parse(frame!.replace('data: ', '').trim());
    expect(parsed.model).toBe('p/m');
    expect(parsed.choices[0].delta.reasoning_content).toBe('think');
  });

  it('drops the usage frame unless the client asked for it', () => {
    const usageOnly = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'u', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as any;
    expect(chatSurface.encodeChunk!(usageOnly, { model: 'p/m', includeUsage: false })).toBeNull();
    expect(chatSurface.encodeChunk!(usageOnly, { model: 'p/m', includeUsage: true })).toContain('"usage"');
  });

  it('the buffered re-chunker emits reasoning deltas too (no leg deletes thinking)', () => {
    const frames = buildChatStreamChunks(
      {
        id: 'chatcmpl-r',
        object: 'chat.completion',
        created: 1,
        model: 'p/m',
        choices: [
          {
            index: 0,
            // Not in the typed shape, but exactly what an interleaved-thinking
            // upstream puts on the wire (catalog `interleaved.field`).
            message: { role: 'assistant', content: 'answer', reasoning_content: 'think' } as any,
            finish_reason: 'stop',
          },
        ],
      } as any,
      'p/m'
    );
    const deltas = frames.map((f) => JSON.parse(f.replace('data: ', '').trim()).choices[0].delta);
    const reasoningText = deltas
      .filter((d: any) => typeof d.reasoning_content === 'string')
      .map((d: any) => d.reasoning_content)
      .join('');
    expect(reasoningText).toBe('think');
    // Thinking is replayed BEFORE the answer it produced.
    const firstReasoning = frames.findIndex((f) => f.includes('reasoning_content'));
    const firstAnswer = frames.findIndex((f, i) => i > 0 && f.includes('"content":"answ"'));
    expect(firstReasoning >= 0 && firstReasoning < firstAnswer).toBe(true);
  });
});

describe('X-OCR header split', () => {
  it('routing block carries no completion-time lies', () => {
    const h = buildChatOcrRoutingHeaders({ modelUsed: 'p/m', tierUsed: 'lite', traceId: 't' }, 'gate');
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
      process: async (req: ChatCompletionRequest, ctx: Record<string, unknown>, relay?: any) => {
        seen.hasRelay = relay !== undefined;
        if (!relay) return bufferedResult();
        relay.stageRouting({ modelUsed: 'p/m', tierUsed: 'lite', layerUsed: 'layer0', traceId: 't', sessionId: 's' });
        relay.onChunk(chunk({ role: 'assistant', content: 'a' }));
        markWritten();
        await written; // proves the byte went out before the call resolved
        relay.onChunk(chunk({ content: 'b' }));
        if (behavior.extraChunks) for (let i = 0; i < behavior.extraChunks; i++) relay.onChunk(chunk({ content: 'x' }));
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

  it('the responses surface has no chunk encoder (buffered by construction)', () => {
    expect(responsesSurface.encodeChunk).toBeUndefined();
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
      wire: 'openai',
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
      const provider = new OpenAICompatibleProvider({
        name: 'test-provider',
        type: 'openai',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      } as ProviderConfig);
      const stream = await provider.createStream(
        { model: 'x', messages: [] } as ChatCompletionRequest,
        modelReg(),
        { recorder: fakeRecorder(events), sessionId: 's', traceId: 't', model: 'x' } as any
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
    expect(events.map((e) => e.spanId)[0]).toBe(events[1].spanId);
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
      const provider = new OpenAICompatibleProvider({
        name: 'test-provider',
        type: 'openai',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      } as ProviderConfig);
      await provider.createStream(
        { model: 'x', messages: [] } as ChatCompletionRequest,
        modelReg(),
        { recorder: fakeRecorder(events), sessionId: 's', traceId: 't', model: 'x' } as any
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
});
