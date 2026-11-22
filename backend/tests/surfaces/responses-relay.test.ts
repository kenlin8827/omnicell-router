import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { runChatSurface } from '../../src/surfaces/chat-pipeline.js';
import { responsesSurface, __resetResponsesSurfaceForTests } from '../../src/surfaces/responses.js';
import { applyStreamingPosture, streamingPosture } from '../../src/pipeline/streaming-posture.js';
import type { TransportContext } from '../../src/surfaces/types.js';
import type { StreamEvent } from '../../src/ir/types.js';
import type { ExecutionResult } from '../../src/types/router.js';
import { responseIR } from '../helpers/ir.js';

/**
 * Client-side Responses streaming: upstream canonical events are encoded as they
 * arrive, while the completed IR remains available for persistence and usage.
 */

function makeTransport() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const t: TransportContext = {
    method: 'POST',
    url: '/v1/responses',
    headers: { 'user-agent': 'responses-relay-test' },
    clientIp: '127.0.0.1',
    access: { kind: 'key', keyName: 'relay-key', policy: undefined, enforce: () => true },
    captureProcessContext: () => ({ fastifyRequest: { __fake: true } as unknown as FastifyRequest }),
    relayUpstream: (up) => record('relayUpstream', up),
    sendJson: (status, payload, headers) => record('sendJson', status, payload, headers),
    beginSse: (headers) => record('beginSse', headers),
    writeSseChunk: (chunk) => record('writeSseChunk', chunk),
    endSse: () => record('endSse'),
    isClientGone: () => false,
    logError: (err, message) => record('logError', err, message),
  };
  return { t, calls, ops: () => calls.map((c) => c.op) };
}

type StubToolCall = { id: string; name: string; arguments: string };
type StubDelta = { content: string | null; reasoning?: string; role?: string };

function stubResult(text: string, toolCalls?: StubToolCall[]): ExecutionResult {
  const response = responseIR(text, {
    id: 'resp_upstream',
    model: 'upstream-deployment-name',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
      ...(toolCalls ?? []).map((call) => ({
        type: 'tool_call' as const, id: call.id, callId: call.id, name: call.name, arguments: call.arguments,
      })),
    ],
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  });
  return {
    response,
    tierUsed: 'lite',
    modelUsed: 'served-model',
    fallbackOccurred: false,
    latencyMs: 1,
    ttftMs: 12,
    genMs: 40,
    sessionId: 'sess-relay',
    requestId: 'trace-relay',
  };
}

function stubOrchestrator(deltas: StubDelta[], text: string, toolCalls?: StubToolCall[]) {
  let relaySeen = false;
  const orchestrator = {
    process: async (_request: unknown, _ctx: unknown, relay?: { onChunk(event: StreamEvent): void }) => {
      relaySeen = !!relay;
      const emit = (event: StreamEvent) => relay?.onChunk(event);
      emit({ type: 'response.created', id: 'resp_upstream', model: 'upstream-deployment-name', createdAt: 1 });
      let nextIndex = 0;
      let messageIndex: number | undefined;
      let reasoningIndex: number | undefined;
      let fullText = '';
      for (const delta of deltas) {
        if (delta.reasoning !== undefined) {
          if (reasoningIndex === undefined) {
            reasoningIndex = nextIndex++;
            emit({ type: 'response.output_item.added', index: reasoningIndex, item: { type: 'reasoning', text: '' } });
          }
          if (delta.reasoning) emit({ type: 'response.reasoning.delta', index: reasoningIndex, text: delta.reasoning });
        }
        if (delta.role === 'assistant' || typeof delta.content === 'string') {
          if (messageIndex === undefined) {
            messageIndex = nextIndex++;
            emit({ type: 'response.output_item.added', index: messageIndex, item: { type: 'message', role: 'assistant', content: [] } });
            emit({ type: 'response.content_part.added', index: messageIndex, partIndex: 0, part: { type: 'text', text: '' } });
          }
          if (delta.content) {
            fullText += delta.content;
            emit({ type: 'response.output_text.delta', index: messageIndex, partIndex: 0, text: delta.content });
          }
        }
      }
      if (messageIndex !== undefined) {
        emit({ type: 'response.output_text.done', index: messageIndex, partIndex: 0, text: fullText });
        emit({ type: 'response.output_item.done', index: messageIndex, item: { type: 'message', role: 'assistant', content: [{ type: 'text', text: fullText }] } });
      }
      if (reasoningIndex !== undefined) {
        emit({ type: 'response.output_item.done', index: reasoningIndex, item: { type: 'reasoning', text: deltas.map((d) => d.reasoning ?? '').join('') } });
      }
      for (const call of toolCalls ?? []) {
        const index = nextIndex++;
        const item = { type: 'tool_call' as const, id: call.id, callId: call.id, name: call.name, arguments: call.arguments };
        emit({ type: 'response.output_item.added', index, item });
        emit({ type: 'response.function_call.arguments.delta', index, argumentsDelta: call.arguments });
        emit({ type: 'response.function_call.arguments.done', index, arguments: call.arguments });
        emit({ type: 'response.output_item.done', index, item });
      }
      emit({ type: 'response.usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
      return stubResult(text, toolCalls);
    },
  } as unknown as Parameters<typeof runChatSurface>[2];
  return { orchestrator, sawRelay: () => relaySeen };
}

function chunk(content: string | null, extra: { reasoning_content?: string; role?: string } = {}): StubDelta {
  return { content, reasoning: extra.reasoning_content, role: extra.role };
}

/** Every SSE frame on this wire is `event: <type>\ndata: <json>\n\n`. */
function eventsOf(frames: string[]): Array<Record<string, any>> {
  return frames.map((frame) => {
    assert.ok(frame.startsWith('event: ') && frame.endsWith('\n\n'), `malformed frame: ${JSON.stringify(frame.slice(0, 80))}`);
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    assert.ok(line, 'every relayed frame carries a data line');
    const payload = JSON.parse(line!.slice('data: '.length)) as Record<string, any>;
    assert.equal(payload.type, frame.slice('event: '.length, frame.indexOf('\n')), 'event line and payload.type agree');
    return payload;
  });
}

function framesOf(calls: Array<{ op: string; args: unknown[] }>): string[] {
  return calls
    .filter((c) => c.op === 'writeSseChunk')
    .flatMap((c) => (c.args[0] as string).match(/event: [\s\S]*?\n\n/g) ?? []);
}

describe('responses wire — relayed (per-chunk) SSE', () => {
  // The posture is a process-global live snapshot. Other suites (notably
  // streaming-hot-apply) mutate it, so pin it for THIS file and restore the
  // exact prior value afterwards instead of leaking into neighbours.
  let saved: ReturnType<typeof streamingPosture>;
  beforeEach(() => {
    saved = { ...streamingPosture() };
    applyStreamingPosture({ client: { mode: 'allow' }, upstream: { mode: 'follow' } });
    __resetResponsesSurfaceForTests();
  });
  afterEach(() => {
    applyStreamingPosture({ client: { mode: saved.client }, upstream: { mode: saved.upstream } });
  });

  it('flushes a full lifecycle: prefix, one delta per upstream chunk, closing half, no [DONE]', async () => {
    const { t, calls, ops } = makeTransport();
    const { orchestrator, sawRelay } = stubOrchestrator(
      [
        chunk('Hel'),
        chunk(null, { reasoning_content: 'thinking' }), // no prose -> dropped
        chunk('lo'),
        chunk('', { role: 'assistant' }), // empty prose -> dropped
      ],
      'Hello',
    );
    await runChatSurface(t, responsesSurface, orchestrator, {
      model: 'auto',
      input: 'hi',
      stream: true,
    });

    assert.ok(sawRelay(), 'the responses wire must be offered the relay on a streamed turn');
    assert.equal(ops().filter((op) => op === 'beginSse').length, 1, 'one SSE terminal send');
    assert.equal(ops().filter((op) => op === 'endSse').length, 1, 'one SSE close');
    assert.ok(!ops().includes('sendJson'), 'a relayed turn never also sends JSON');

    const frames = framesOf(calls);
    assert.ok(!frames.some((f) => f.includes('[DONE]')), 'Responses SSE has no [DONE] sentinel');
    const summaryChunks = calls
      .filter((c) => c.op === 'writeSseChunk')
      .map((c) => c.args[0] as string)
      .filter((chunk) => chunk.startsWith(': ocr-summary '));
    assert.equal(summaryChunks.length, 1, 'completion facts follow the protocol terminal event');
    const summary = JSON.parse(summaryChunks[0]!.slice(': ocr-summary '.length).trim()) as Record<string, string>;
    assert.equal(summary['X-OCR-Gen-MS'], '40', 'the tok/s denominator rides the comment, not a protocol field');
    assert.equal(summary['X-OCR-TTFT-MS'], '12');

    const events = eventsOf(frames);
    const types = events.map((e) => e.type);
    assert.deepEqual(types.slice(0, 4), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
    ], 'the opening frames precede EVERY delta so the client knows item_id');
    assert.equal(types[types.length - 1], 'response.completed', 'the turn closes on response.completed');

    const deltas = events.filter((e) => e.type === 'response.output_text.delta');
    assert.equal(deltas.length, 2, 'exactly one delta per chunk carrying prose; empty chunks emit no text delta');
    assert.equal(deltas.map((d) => d.delta).join(''), 'Hello', 'relayed text is not re-sliced or duplicated');

    const respIds = new Set(events.filter((e) => e.response?.id).map((e) => e.response.id as string));
    assert.equal(respIds.size, 1, 'created / in_progress / completed share ONE response id');
    const itemIds = new Set([
      ...events.filter((e) => e.item?.type === 'message').map((e) => e.item.id as string),
      ...deltas.map((d) => d.item_id as string),
    ]);
    assert.equal(itemIds.size, 1, 'output_item.added and every delta share ONE item id');
  });

  it('afterResult still persists the chain after the relayed turn closes', async () => {
    const first = makeTransport();
    await runChatSurface(
      first.t,
      responsesSurface,
      stubOrchestrator([chunk('OK')], 'OK').orchestrator,
      { model: 'auto', input: 'remember BETA17', stream: true },
    );
    const firstEvents = eventsOf(framesOf(first.calls));
    const respId = firstEvents[0]!.response.id as string;
    assert.ok(respId.length > 8, 'a usable response id was minted');

    // Continuation: client sends ONLY the delta. A missing RespStore node would
    // produce the loud previous_not_found 400 instead of a JSON answer.
    const second = makeTransport();
    await runChatSurface(
      second.t,
      responsesSurface,
      stubOrchestrator([], 'pong').orchestrator,
      { model: 'auto', input: 'what was the code?', previous_response_id: respId },
    );
    assert.ok(second.ops().includes('sendJson'), 'continuation answers in JSON on a non-streamed turn');
    const sent = second.calls.find((c) => c.op === 'sendJson')!;
    assert.equal(sent.args[0], 200, 'the relayed turn registered its response id in the store');
    // The envelope ALWAYS carries `error` (null on success, per the Response
    // schema) — only an error object means the chain id failed to resolve.
    assert.equal((sent.args[1] as { error?: unknown }).error, null, 'no previous_not_found error');
  });

  it('a non-streamed turn keeps the original buffered/JSON shapes', async () => {
    const { t, calls, ops } = makeTransport();
    await runChatSurface(
      t,
      responsesSurface,
      stubOrchestrator([], 'Hello').orchestrator,
      { model: 'auto', input: 'hi' },
    );
    assert.ok(ops().includes('sendJson'), 'stream:false stays a single JSON terminal send');
    assert.ok(!ops().includes('beginSse'), 'no SSE headers on a JSON turn');
    const body = calls.find((c) => c.op === 'sendJson')!.args[1] as { id?: string; status?: string };
    assert.equal(body.status, 'completed');
    assert.ok(body.id, 'the JSON body carries the parse-minted id');
  });

  // -------------------------------------------------------------------------
  // Junie 4020.10 strict-schema contract. Verified by javap on
  // OpenAIResponsesStreamingEvent$* and schema.Response:
  //  - every streaming event (including the Unknown fallback) requires
  //    `sequence_number`; without it Junie DROPS the event, so a dropped
  //    response.completed becomes LlmStreamTruncatedException -> the user sees
  //    "A network error interrupted the request to the model provider".
  //  - schema.Response has no default for id/status/model/output/tools;
  //    OpenAIResponseUsage requires input_tokens/output_tokens/total_tokens.
  //  - tool calls are rebuilt from OutputItemAdded + FunctionCallArgumentsDelta,
  //    NOT from the terminal response object alone.
  // -------------------------------------------------------------------------

  it('every event carries a strictly increasing sequence_number and a parseable Response', async () => {
    const { t, calls } = makeTransport();
    await runChatSurface(
      t,
      responsesSurface,
      stubOrchestrator([chunk('Hel'), chunk('lo')], 'Hello').orchestrator,
      { model: 'auto', input: 'hi', stream: true },
    );
    const events = eventsOf(framesOf(calls));

    events.forEach((e, i) => {
      assert.equal(e.sequence_number, i, `event ${i} (${e.type}) must carry sequence_number === ${i}`);
    });

    const withResponse = events.filter((e) => e.response);
    assert.ok(withResponse.length >= 3, 'created / in_progress / completed all carry a response');
    for (const e of withResponse) {
      const r = e.response;
      for (const field of ['id', 'object', 'status', 'model', 'output']) {
        assert.ok(r[field] !== undefined, `${e.type}.response.${field} is required by Junie`);
      }
      assert.ok(Array.isArray(r.tools), `${e.type}.response.tools is required by Junie`);
      for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
        assert.equal(typeof r.usage?.[field], 'number', `${e.type}.response.usage.${field} is required`);
      }
    }
    const terminal = events[events.length - 1];
    assert.equal(terminal.type, 'response.completed', 'a terminal event survives strict parsing');
    assert.equal(terminal.response.status, 'completed');
  });

  it('relayed tool calls keep output_item.added + function_call_arguments.delta in the closing half', async () => {
    const args = JSON.stringify({ full_answer: 'Hello from a tool call' });
    const { t, calls } = makeTransport();
    await runChatSurface(
      t,
      responsesSurface,
      stubOrchestrator([chunk('thinking')], 'thinking', [
        { id: 'call_1', name: 'answer', arguments: args },
      ]).orchestrator,
      { model: 'auto', input: 'hi', stream: true },
    );
    const events = eventsOf(framesOf(calls));

    const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
    assert.equal(textDeltas.map((d) => d.delta).join(''), 'thinking', 'live text is NOT replayed in the suffix');

    const fcAdded = events.filter((e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
    assert.equal(fcAdded.length, 1, 'the function_call item is announced');
    const argDeltas = events.filter((e) => e.type === 'response.function_call_arguments.delta');
    assert.ok(argDeltas.length > 0, 'Junie rebuilds tool calls from these deltas');
    assert.equal(argDeltas.map((d) => d.delta).join(''), args);
    assert.equal(argDeltas[0].item_id, fcAdded[0].item.id, 'added and deltas share the item id');
    assert.equal(events[events.length - 1].type, 'response.completed');
    events.forEach((e, i) => assert.equal(e.sequence_number, i));
  });

  it('a tool-call-only answer keeps output indexes aligned with the prefix', async () => {
    const { t, calls } = makeTransport();
    await runChatSurface(
      t,
      responsesSurface,
      stubOrchestrator([chunk('', { role: 'assistant' })], '', [
        { id: 'call_2', name: 'answer', arguments: '{"full_answer":"ok"}' },
      ]).orchestrator,
      { model: 'auto', input: 'hi', stream: true },
    );
    const events = eventsOf(framesOf(calls));

    const added = events.filter((e) => e.type === 'response.output_item.added');
    const done = events.filter((e) => e.type === 'response.output_item.done');
    assert.equal(added.length, done.length, 'every announced item is closed');
    assert.equal(added[0].output_index, 0, 'the prefix owns index 0');
    assert.equal(added[1].item.type, 'function_call');
    assert.equal(added[1].output_index, 1, 'the tool call does not collide with the prefix item');
    assert.equal(events[events.length - 1].type, 'response.completed');
    events.forEach((e, i) => assert.equal(e.sequence_number, i));
  });
});
