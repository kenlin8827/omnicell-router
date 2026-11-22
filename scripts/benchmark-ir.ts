/**
 * Local, deterministic IR performance baseline. No network and no provider
 * credentials. Timings are measurements, not portable CI budgets.
 *
 *   bun run bench:ir
 *   OCR_BENCH_MESSAGES=4000 OCR_BENCH_DELTAS=10000 OCR_BENCH_CONCURRENCY=16 bun run bench:ir
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import type http from 'node:http';
import type { ModelRegistration } from '../backend/src/config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../backend/src/ir/types.js';
import type { ExecutionResult } from '../backend/src/types/router.js';
import type { ChatSurface } from '../backend/src/surfaces/types.js';
import { irToChatRequest } from '../backend/src/ir/adapters/openai-chat.js';
import { canonicalToResponsesPayload } from '../backend/src/ir/adapters/openai-responses.js';
import { canonicalToAnthropicPayload } from '../backend/src/ir/adapters/anthropic-messages.js';
import { canonicalToGooglePayload } from '../backend/src/ir/adapters/google-gemini.js';
import { OpenAIResponsesStreamDecoder } from '../backend/src/ir/adapters/openai-responses-stream.js';
import { AnthropicMessagesStreamDecoder } from '../backend/src/ir/adapters/anthropic-messages-stream.js';
import { GoogleGeminiStreamDecoder } from '../backend/src/ir/adapters/google-gemini-stream.js';
import { canonicalResponseToEvents, createEventAccumulator } from '../backend/src/ir/stream.js';
import { ChatStreamDecoder } from '../backend/src/ir/adapters/openai-chat-stream.js';
import { chatSurface } from '../backend/src/surfaces/chat.js';
import { responsesSurface } from '../backend/src/surfaces/responses.js';
import { anthropicSurface } from '../backend/src/surfaces/anthropic.js';
import { writeWithBackpressure } from '../backend/src/surfaces/transport-backpressure.js';

type Protocol = 'chat' | 'responses' | 'anthropic' | 'google';
type Northbound = 'chat' | 'responses' | 'anthropic';
type Decoder = { push(frame: any): StreamEvent[]; finish(): StreamEvent[] };

const messages = positiveInt('OCR_BENCH_MESSAGES', 4_000);
const deltas = positiveInt('OCR_BENCH_DELTAS', 10_000);
const concurrency = positiveInt('OCR_BENCH_CONCURRENCY', 16);
const model: ModelRegistration = {
  id: 'bench/model', provider: 'bench', upstreamModel: 'bench-upstream', tier: 'plus',
  pricing: { input: 1, output: 1, cacheRead: 0.1 },
};
const protocols: Protocol[] = ['chat', 'responses', 'anthropic', 'google'];
const surfaces: Record<Northbound, ChatSurface> = {
  chat: chatSurface, responses: responsesSurface, anthropic: anthropicSurface,
};

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Benchmark correctness check failed: ${message}`);
}

function memory(): { heapUsedMiB: number; rssMiB: number } {
  const usage = process.memoryUsage();
  return {
    heapUsedMiB: Number((usage.heapUsed / 1024 / 1024).toFixed(2)),
    rssMiB: Number((usage.rss / 1024 / 1024).toFixed(2)),
  };
}

function longRequest(): CanonicalRequest {
  return {
    model: 'bench/model', stream: false, instructions: 'Answer precisely.',
    input: Array.from({ length: messages }, (_, index) => ({
      type: 'message' as const, role: 'user' as const,
      content: [{ type: 'text' as const, text: `message-${index}:${'x'.repeat(56)}` }],
    })),
    tools: [{
      type: 'function',
      function: {
        name: 'read', description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }],
  };
}

function render(protocol: Protocol, request: CanonicalRequest): Record<string, unknown> {
  if (protocol === 'chat') return irToChatRequest(request, model.upstreamModel) as Record<string, unknown>;
  if (protocol === 'responses') return canonicalToResponsesPayload(request, model);
  if (protocol === 'anthropic') return canonicalToAnthropicPayload(request, model);
  return canonicalToGooglePayload(request, model);
}

function decoder(protocol: Protocol): Decoder {
  if (protocol === 'chat') return new ChatStreamDecoder() as Decoder;
  if (protocol === 'responses') return new OpenAIResponsesStreamDecoder();
  if (protocol === 'anthropic') return new AnthropicMessagesStreamDecoder();
  return new GoogleGeminiStreamDecoder();
}

function* frames(protocol: Protocol, count: number): Generator<unknown> {
  if (protocol === 'chat') {
    yield { id: 'chatcmpl-bench', object: 'chat.completion.chunk', created: 1, model: 'bench-upstream', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    for (let index = 0; index < count; index++) {
      yield { id: 'chatcmpl-bench', object: 'chat.completion.chunk', created: 1, model: 'bench-upstream', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] };
    }
    yield { id: 'chatcmpl-bench', object: 'chat.completion.chunk', created: 1, model: 'bench-upstream', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    yield { id: 'chatcmpl-bench', object: 'chat.completion.chunk', created: 1, model: 'bench-upstream', choices: [], usage: { prompt_tokens: 10, completion_tokens: count, total_tokens: count + 10, prompt_tokens_details: { cached_tokens: 4 } } };
    return;
  }
  if (protocol === 'responses') {
    yield { type: 'response.created', response: { id: 'resp-bench', model: 'bench-upstream', created_at: 1 } };
    yield { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-bench', role: 'assistant', status: 'in_progress', content: [] } };
    yield { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } };
    for (let index = 0; index < count; index++) yield { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'x' };
    yield { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'x'.repeat(count) };
    yield { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'x'.repeat(count), annotations: [] } };
    yield { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-bench', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'x'.repeat(count), annotations: [] }] } };
    yield { type: 'response.completed', response: { id: 'resp-bench', status: 'completed', usage: { input_tokens: 10, output_tokens: count, total_tokens: count + 10, input_tokens_details: { cached_tokens: 4 } } } };
    return;
  }
  if (protocol === 'anthropic') {
    yield { type: 'message_start', message: { id: 'msg-bench', model: 'bench-upstream', usage: { input_tokens: 6, output_tokens: 0, cache_read_input_tokens: 4 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    for (let index = 0; index < count; index++) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: count } };
    yield { type: 'message_stop' };
    return;
  }
  for (let index = 0; index < count; index++) {
    yield { responseId: 'google-bench', modelVersion: 'bench-upstream', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'x' }] } }] };
  }
  yield {
    responseId: 'google-bench', modelVersion: 'bench-upstream',
    candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: count, totalTokenCount: count + 10, cachedContentTokenCount: 4 },
  };
}

function decode(protocol: Protocol, count: number): { response: CanonicalResponse; eventCount: number } {
  const stream = decoder(protocol);
  const accumulator = createEventAccumulator();
  let eventCount = 0;
  const consume = (events: StreamEvent[]): void => {
    eventCount += events.length;
    for (const event of events) accumulator.push(event);
  };
  for (const frame of frames(protocol, count)) consume(stream.push(frame));
  consume(stream.finish());
  const response = accumulator.finish();
  const text = response.output.flatMap((item) => item.type === 'message'
    ? item.content.flatMap((part) => part.type === 'text' ? [part.text] : []) : []).join('');
  assert(text.length === count, `${protocol} lost or duplicated text deltas.`);
  assert(response.status === 'completed', `${protocol} terminal status.`);
  assert(response.usage.cachedInputTokens === 4, `${protocol} cached usage.`);
  return { response, eventCount };
}

async function decodeConcurrent(protocol: Protocol, count: number): Promise<number> {
  const stream = decoder(protocol);
  const accumulator = createEventAccumulator();
  let eventCount = 0;
  let index = 0;
  const consume = (events: StreamEvent[]): void => {
    eventCount += events.length;
    for (const event of events) accumulator.push(event);
  };
  for (const frame of frames(protocol, count)) {
    consume(stream.push(frame));
    if (++index % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  consume(stream.finish());
  const response = accumulator.finish();
  assert(response.status === 'completed', `${protocol} concurrent terminal status.`);
  return eventCount;
}

function baseResponse(): CanonicalResponse {
  return {
    id: 'bench-response', model: 'bench-upstream', createdAt: 1, status: 'completed', reason: 'stop',
    output: [{ type: 'message', id: 'bench-message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
    usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cachedInputTokens: 4 },
  };
}

function clientBody(protocol: Northbound, stream: boolean): unknown {
  if (protocol === 'chat') return { model: 'bench/model', stream, messages: [{ role: 'user', content: 'hello' }] };
  if (protocol === 'responses') return { model: 'bench/model', stream, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] };
  return { model: 'bench/model', stream, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] };
}

function benchmarkMatrix(): { combinations: number; encodedBytes: number; nativeEvents: number } {
  let combinations = 0;
  let encodedBytes = 0;
  let nativeEvents = 0;
  for (const upstream of protocols) {
    for (const upstreamShape of ['buffered', 'native'] as const) {
      const expectedText = upstreamShape === 'buffered' ? 'hello' : 'x';
      const events = upstreamShape === 'buffered' ? canonicalResponseToEvents(baseResponse()) : (() => {
        const nativeDecoder = decoder(upstream);
        const nativeEventsList: StreamEvent[] = [];
        for (const frame of frames(upstream, 1)) nativeEventsList.push(...nativeDecoder.push(frame));
        nativeEventsList.push(...nativeDecoder.finish());
        nativeEvents += nativeEventsList.length;
        return nativeEventsList;
      })();
      const accumulator = createEventAccumulator();
      for (const event of events) accumulator.push(event);
      const response = accumulator.finish();
      const result: ExecutionResult = { response, modelUsed: 'bench/model', latencyMs: 0, fallbackOccurred: false };
      for (const client of Object.keys(surfaces) as Northbound[]) {
        const surface = surfaces[client];
        for (const clientShape of ['json', 'sse'] as const) {
          const parsed = surface.parse(clientBody(client, clientShape === 'sse'));
          assert(parsed.request, `${client} request parse.`);
          let wire: string;
          if (clientShape === 'json') {
            wire = JSON.stringify(surface.encodeJson(result, parsed.state));
          } else {
            const frames = [...(surface.streamStart?.(parsed.state, { model: result.modelUsed, includeUsage: true, state: parsed.state }) ?? [])];
            for (const event of events) {
              const frame = surface.encodeChunk?.(event, { model: result.modelUsed, includeUsage: true, state: parsed.state });
              if (frame) frames.push(frame);
            }
            frames.push(...(surface.streamEnd?.(result, parsed.state, { model: result.modelUsed, includeUsage: true, state: parsed.state }) ?? []));
            wire = frames.join('');
          }
          assert(wire.includes(expectedText), `${client} ${clientShape} <- ${upstream} ${upstreamShape} text.`);
          encodedBytes += Buffer.byteLength(wire);
          combinations++;
        }
      }
    }
  }
  assert(combinations === 48, 'The complete 48-case streaming matrix ran.');
  return { combinations, encodedBytes, nativeEvents };
}

async function benchmarkBackpressure(): Promise<{ writes: number; elapsedMs: number }> {
  const response = new EventEmitter() as http.ServerResponse;
  let writes = 0;
  response.write = (() => {
    writes++;
    setImmediate(() => response.emit('drain'));
    return false;
  }) as http.ServerResponse['write'];
  const started = performance.now();
  for (let index = 0; index < 100; index++) {
    await writeWithBackpressure(response, `data: ${index}\n\n`, () => { });
  }
  assert(writes === 100, 'All backpressured writes completed.');
  return { writes, elapsedMs: Number((performance.now() - started).toFixed(3)) };
}

const report: Record<string, unknown> = {
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown' },
  workload: { messages, deltas, concurrency },
  note: 'Machine-dependent measurements; no universal latency threshold is asserted. Heap deltas include GC timing noise.',
  requestRendering: {} as Record<string, unknown>,
  streamDecoding: {} as Record<string, unknown>,
};

// Warm up JIT and adapter initialization before recording measurements.
for (const protocol of protocols) {
  render(protocol, longRequest());
  decode(protocol, 32);
}

for (const protocol of protocols) {
  const request = longRequest();
  const before = memory();
  const started = performance.now();
  const wire = render(protocol, request);
  const elapsedMs = performance.now() - started;
  const bytes = Buffer.byteLength(JSON.stringify(wire));
  (report.requestRendering as Record<string, unknown>)[protocol] = {
    messages, bytes, elapsedMs: Number(elapsedMs.toFixed(3)),
    messagesPerSecond: elapsedMs > 0 ? Number((messages / elapsedMs * 1000).toFixed(1)) : null, before, after: memory(),
  };
}

for (const protocol of protocols) {
  const before = memory();
  const started = performance.now();
  const result = decode(protocol, deltas);
  const elapsedMs = performance.now() - started;
  (report.streamDecoding as Record<string, unknown>)[protocol] = {
    deltas, events: result.eventCount, elapsedMs: Number(elapsedMs.toFixed(3)),
    deltasPerSecond: elapsedMs > 0 ? Number((deltas / elapsedMs * 1000).toFixed(1)) : null, before, after: memory(),
  };
}

{
  const before = memory();
  const started = performance.now();
  const matrix = benchmarkMatrix();
  report.streamingMatrix = { ...matrix, elapsedMs: Number((performance.now() - started).toFixed(3)), before, after: memory() };
}

{
  const perWorker = Math.max(128, Math.floor(deltas / concurrency));
  const before = memory();
  const started = performance.now();
  const counts = await Promise.all(Array.from({ length: concurrency }, (_, index) => decodeConcurrent(protocols[index % protocols.length]!, perWorker)));
  report.concurrentDecode = {
    workers: concurrency, deltasPerWorker: perWorker, totalEvents: counts.reduce((sum, value) => sum + value, 0),
    elapsedMs: Number((performance.now() - started).toFixed(3)), before, after: memory(),
  };
}

report.slowClientBackpressure = await benchmarkBackpressure();
console.log(JSON.stringify(report, null, 2));
