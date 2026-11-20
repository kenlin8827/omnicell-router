import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { responsesSurface } from '../src/surfaces/responses.js';
import { runChatSurface } from '../src/surfaces/chat-pipeline.js';
import { SURFACES } from '../src/surfaces/table.js';
import type { TransportContext } from '../src/surfaces/types.js';
import type { CanonicalRequest } from '../src/ir/types.js';
import type { ExecutionResult } from '../src/types/router.js';
import { responseIR } from './helpers/ir.js';
import { IrUnsupportedError } from '../src/ir/errors.js';

/**
 * Surface-level unit tests for the responses wire (contract step 3b):
 * parse-400 texts pinned, the loud previous_response_not_found 400 (code
 * field included), state coupling (afterResult mints respId → encode paths +
 * shared-RespStore round-trip across two calls), C-3 stream normalization,
 * and both error envelopes.
 */

interface RecordedCall {
  op: string;
  args: unknown[];
}

function makeFakeTransport() {
  const calls: RecordedCall[] = [];
  const record = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const t: TransportContext = {
    method: 'POST',
    url: '/v1/responses',
    headers: { 'user-agent': 'surface-responses-test' },
    clientIp: '127.0.0.1',
    access: {
      kind: 'key',
      keyName: 'fake-key',
      policy: undefined,
      enforce: (model) => {
        record('enforce', model);
        return true;
      },
    },
    captureProcessContext: () => ({}),
    sendJson: (status, payload, headers) => record('sendJson', status, payload, headers),
    beginSse: (headers) => record('beginSse', headers),
    writeSseChunk: (chunk) => record('writeSseChunk', chunk),
    endSse: () => record('endSse'),
    isClientGone: () => false,
    logError: (err, message) => record('logError', err, message),
  };
  const sent = () =>
    calls
      .filter((c) => c.op === 'sendJson')
      .map((c) => ({ status: c.args[0] as number, payload: c.args[1] as Record<string, unknown> }));
  return { t, calls, ops: () => calls.map((c) => c.op), sent };
}

function stubResult(modelUsed: string, response: ExecutionResult['response'], sessionId = 'sess-1'): ExecutionResult {
  return {
    response,
    tierUsed: 'lite',
    modelUsed,
    fallbackOccurred: false,
    latencyMs: 1,
    sessionId,
    requestId: 'trace-1',
  };
}

const okResponse = responseIR('ok', { id: 'resp-1', createdAt: 1, model: 'mock-1' });

function makeStubOrchestrator(behavior: { result?: ExecutionResult; throw?: unknown } = {}) {
  const processed: Array<{ request: CanonicalRequest }> = [];
  const orchestrator = {
    process: async (request: CanonicalRequest) => {
      processed.push({ request });
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.result ?? stubResult('mock-1', okResponse);
    },
  } as unknown as Parameters<typeof runChatSurface>[2];
  return { orchestrator, processed };
}

const sseData = (chunk: string): Record<string, unknown> =>
  JSON.parse(chunk.split('\n')[1]!.replace('data: ', ''));

/** Protocol event frames only — buffered encodeStream trails an ocr-summary comment. */
const sseEventChunks = (chunks: string[]): string[] =>
  chunks.filter((chunk) => !chunk.startsWith(': ocr-summary'));

describe('responses surface — metadata', () => {
  it('matches the contract §1 entry', () => {
    assert.equal(responsesSurface.wire, 'openai-responses');
    assert.equal(responsesSurface.exec, 'chat-pipeline');
    assert.equal(responsesSurface.capture, true);
    assert.equal(responsesSurface.routePath, '/v1/responses');
    assert.equal(responsesSurface.detectSuffix, '/v1/responses');
    assert.ok(SURFACES.includes(responsesSurface));
  });
});

describe('responses surface — parse 400 texts', () => {
  it('missing input → exact text through the wire envelope', async () => {
    const { t, sent, ops } = makeFakeTransport();
    const { orchestrator, processed } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto' });

    assert.deepEqual(ops(), ['sendJson'], '400 precedes the gate');
    const send = sent()[0]!;
    assert.equal(send.status, 400);
    assert.equal(
      JSON.stringify(send.payload),
      '{"error":{"message":"Invalid request: \\"input\\" is required.","type":"invalid_request_error","code":"unsupported_parameter"}}'
    );
    assert.equal(processed.length, 0);
  });

  it('preserves unknown same-carrier items and pins empty resolution', () => {
    const parsed = responsesSurface.parse({ model: 'auto', input: [{ type: 'bogus', value: 1 }] });
    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.request?.input[0], { type: 'extension', protocol: 'openai-responses', payload: { type: 'bogus', value: 1 } });
    assert.equal(responsesSurface.parse({ model: 'auto', input: [] }).error, 'Invalid request: "input" resolved to an empty item list.');
    assert.equal(responsesSurface.parse(null).error, 'Invalid request: "input" is required.');
  });

  it('forwards tools/tool_choice/parallel_tool_calls in canonical IR', () => {
    const parsed = responsesSurface.parse({
      model: 'auto',
      input: 'go',
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object' }, strict: true }],
      tool_choice: { type: 'function', name: 'read' },
      parallel_tool_calls: false,
    });
    assert.equal(parsed.error, undefined);
    const request = parsed.request!;
    assert.deepEqual(request.tools?.[0], {
      type: 'function', function: { name: 'read', parameters: { type: 'object' }, strict: true },
    });
    assert.deepEqual(request.toolChoice, { type: 'function', name: 'read' });
    assert.equal(request.parallelToolCalls, false);
  });

  it('returns a parse error for a malformed file part instead of throwing', () => {
    const parsed = responsesSurface.parse({
      model: 'auto',
      input: [{ role: 'user', content: [{ type: 'input_file' }] }],
    });
    assert.match(parsed.error ?? '', /input_file/);
  });

  it('preserves a built-in tool for capability validation at the provider boundary', () => {
    const parsed = responsesSurface.parse({
      model: 'auto',
      input: 'go',
      tools: [{ type: 'web_search_preview' }],
    });
    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.request?.tools?.[0], { type: 'builtin', kind: 'web_search_preview', config: {} });
  });

  it('emits the request echo and truncation status through encodeJson', () => {
    const parsed = responsesSurface.parse({
      model: 'auto',
      input: 'go',
      instructions: 'be terse',
      temperature: 0.3,
      max_output_tokens: 64,
      tool_choice: 'required',
      parallel_tool_calls: false,
    });
    assert.equal(parsed.error, undefined);
    const response = responseIR('partial', {
      id: 'resp-up', createdAt: 1, model: 'up', status: 'incomplete', reason: 'length',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    const body = responsesSurface.encodeJson(stubResult('served', response), parsed.state) as Record<string, unknown>;
    assert.equal(body.instructions, 'be terse');
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_output_tokens, 64);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.status, 'incomplete');
    assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(body.error, null);
  });

  it('maps text.format, metadata and service_tier into the canonical request', () => {
    const parsed = responsesSurface.parse({
      model: 'auto',
      input: 'go',
      text: { format: { type: 'json_schema', name: 'x', schema: { type: 'object' }, strict: true } },
      metadata: { tenant: 'a' },
      service_tier: 'flex',
      prompt_cache_key: 'pk',
      safety_identifier: 'sid',
    });
    assert.equal(parsed.error, undefined);
    const request = parsed.request!;
    assert.deepEqual(request.text?.format, {
      type: 'json_schema', name: 'x', schema: { type: 'object' }, strict: true,
    });
    assert.deepEqual(request.metadata, { tenant: 'a' });
    assert.equal(request.serviceTier, 'flex');
    assert.equal(request.cache?.key, 'pk');
    assert.equal(request.safetyIdentifier, 'sid');
  });

  it('emits a refusal output part and echoes request metadata', () => {
    const parsed = responsesSurface.parse({ model: 'auto', input: 'go', metadata: { tenant: 'a' } });
    assert.equal(parsed.error, undefined);
    const response = responseIR('', {
      id: 'resp-refusal', createdAt: 1, model: 'up',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', text: 'no' }] }],
    });
    const body = responsesSurface.encodeJson(stubResult('served', response), parsed.state) as Record<string, any>;
    assert.deepEqual(body.output[0].content, [{ type: 'refusal', refusal: 'no' }]);
    assert.deepEqual(body.metadata, { tenant: 'a' });
  });

  it('unknown previous_response_id → loud 400 WITH code previous_response_not_found', async () => {
    const { t, sent } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, {
      model: 'auto',
      previous_response_id: 'resp_never_minted_000000',
      input: 'orphan turn',
    });
    const wire = JSON.stringify(sent()[0]!.payload);
    assert.ok(sent()[0]!.status === 400);
    assert.ok(wire.includes('"Unknown previous_response_id \\"resp_never_minted_000000\\" (expired, evicted, or from before a gateway restart). Resend the full conversation input."'), wire);
    assert.ok(wire.includes('"code":"previous_response_not_found"'), wire);
  });
});

describe('responses surface — state coupling (respId + shared store)', () => {
  it('afterResult mints respId before the first byte; encodeJson echoes it', async () => {
    const { t, ops } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    const orderAtHook: string[] = [];
    const observed = {
      ...responsesSurface,
      afterResult: (result: ExecutionResult, state: unknown) => {
        orderAtHook.push(...ops());
        responsesSurface.afterResult!(result, state);
      },
    };
    await runChatSurface(t, observed, orchestrator, { model: 'auto', stream: true, input: 'turn one' });

    assert.ok(orderAtHook.includes('enforce'));
    assert.ok(!orderAtHook.includes('beginSse'), 'hook runs strictly before beginSse (pre-first-byte)');
  });

  it('sendJson payload id === minted respId, model === result.modelUsed', async () => {
    const { t, sent } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator({ result: stubResult('mock-9', okResponse) });
    await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto', input: 'turn one' });
    const send = sent()[0]!;
    assert.equal(send.status, 200);
    assert.match(String(send.payload.id), /^resp_[0-9a-f]{24}$/, 'minted via newResponseId');
    assert.equal(send.payload.model, 'mock-9');
  });

  it('previous_response_id round-trip across two calls via the shared module store', async () => {
    const { t: t1, sent: sent1 } = makeFakeTransport();
    const o1 = makeStubOrchestrator({ result: stubResult('mock-1', okResponse, 'sess-abc') });
    await runChatSurface(t1, responsesSurface, o1.orchestrator, { model: 'auto', input: 'parent turn' });
    const parentTurnId = String(sent1()[0]!.payload.id);

    const { t: t2, sent: sent2 } = makeFakeTransport();
    const o2 = makeStubOrchestrator({ result: stubResult('mock-1', okResponse, 'sess-abc') });
    await runChatSurface(t2, responsesSurface, o2.orchestrator, {
      model: 'auto',
      previous_response_id: parentTurnId,
      instructions: 'be terse',
      input: 'child turn',
    });

    assert.equal(sent2()[0]!.status, 200, 'the appended node is resolvable: no 400');
    const req = o2.processed[0]!.request;
    assert.equal(req.routerOptions?.sessionId, 'sess-abc', 'parent node session replayed via router options');
    assert.equal(req.instructions, 'be terse');
    assert.equal(req.input.length, 3);
    assert.deepEqual(req.input.map((item) => item.type === 'message'
      ? [item.role, item.content.map((part) => part.type === 'text' ? part.text : '').join('')]
      : [item.type, '']), [
      ['user', 'parent turn'],
      ['assistant', 'ok'],
      ['user', 'child turn'],
    ]);
  });

  it('a chain whose assistant turn called tools preserves the call without inventing a result', async () => {
    const toolCallResponse = responseIR('', {
      ...okResponse,
      reason: 'tool_calls',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
        { type: 'tool_call', id: 'call_1', callId: 'call_1', name: 'read', arguments: '{}' },
      ],
    });
    const { t: t1, sent: sent1 } = makeFakeTransport();
    const o1 = makeStubOrchestrator({ result: stubResult('mock-1', toolCallResponse) });
    await runChatSurface(t1, responsesSurface, o1.orchestrator, { model: 'auto', input: 'read it' });
    const parentTurnId = String(sent1()[0]!.payload.id);

    const { t: t2 } = makeFakeTransport();
    const o2 = makeStubOrchestrator();
    await runChatSurface(t2, responsesSurface, o2.orchestrator, {
      model: 'auto',
      previous_response_id: parentTurnId,
      input: 'never mind',
    });

    const input = o2.processed[0]!.request.input;
    assert.deepStrictEqual(input.map((item) => item.type), ['message', 'message', 'tool_call', 'message']);
    assert.deepStrictEqual(input[2], { type: 'tool_call', id: 'call_1', callId: 'call_1', name: 'read', arguments: '{}' });
  });

  it('stream=true: response.created…completed carry the SAME minted id; no [DONE]', async () => {
    const { t, calls } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto', stream: true, input: 'sse turn' });

    const chunks = calls.filter((c) => c.op === 'writeSseChunk').map((c) => c.args[0] as string);
    const events = sseEventChunks(chunks);
    assert.ok(events.length >= 4, 'created/in_progress + item + deltas + completed');
    const createdId = (sseData(events[0]!).response as { id: string }).id;
    const completed = sseData(events[events.length - 1]!).response as { id: string; status: string };
    assert.match(createdId, /^resp_[0-9a-f]{24}$/);
    assert.equal(completed.id, createdId, 'one minted respId flows through every event (state coupling)');
    assert.equal(completed.status, 'completed');
    assert.ok(chunks.some((c) => c.startsWith(': ocr-summary ')), 'buffered path trails ocr-summary');
    assert.ok(!chunks.some((c) => c.includes('[DONE]')), 'responses wire ends on response.completed');

    // The streamed id is store-resolvable: afterResult appended BEFORE the
    // first byte, so a continuation turn parses clean instead of 400.
    const { t: t2, sent: sent2 } = makeFakeTransport();
    const o2 = makeStubOrchestrator();
    await runChatSurface(t2, responsesSurface, o2.orchestrator, {
      model: 'auto',
      previous_response_id: createdId,
      input: 'continuation',
    });
    assert.equal(sent2()[0]!.status, 200);
  });

  it('C-3: non-boolean truthy stream normalizes to the JSON path, true stays true', async () => {
    const { t, ops } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto', stream: 'yes', input: 'x' });
    assert.ok(ops().includes('sendJson'));
    assert.ok(!ops().includes('beginSse'));
  });
});

describe('responses surface — error envelopes', () => {
  it('executionError: 4xx keeps status + invalid_request_error code; else 502 upstream_error with fallback', async () => {
    const cases: Array<[unknown, number, string, string]> = [
      [new IrUnsupportedError('input_file', 'no file', 'openai-responses'), 400, 'no file', 'unsupported_parameter'],
      [Object.assign(new Error('Explicit model did not serve. Last error: no file'), {
        statusCode: 400, name: 'IrUnsupportedError', code: 'unsupported_parameter',
      }), 400, 'Explicit model did not serve. Last error: no file', 'unsupported_parameter'],
      [Object.assign(new Error('unknown variant'), { statusCode: 404 }), 404, 'unknown variant', 'invalid_request_error'],
      [Object.assign(new Error('provider 503'), { statusCode: 503 }), 502, 'provider 503', 'upstream_error'],
      [new Error('plain'), 502, 'plain', 'upstream_error'],
      [Object.assign(new Error(''), { statusCode: 700 }), 502, 'Upstream execution failed.', 'upstream_error'],
    ];
    for (const [err, expectedStatus, expectedMessage, expectedCode] of cases) {
      const { t, sent, ops } = makeFakeTransport();
      const { orchestrator } = makeStubOrchestrator({ throw: err });
      await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto', input: 'x' });

      const sends = sent();
      assert.equal(sends.length, 1);
      assert.equal(sends[0]!.status, expectedStatus);
      const wire = JSON.stringify(sends[0]!.payload);
      assert.ok(wire.includes(`"code":"${expectedCode}"`), wire);
      assert.ok(wire.includes(`"message":"${expectedMessage}"`), wire);
      assert.ok(wire.includes('"type":"invalid_request_error"'), wire);
      assert.ok(!ops().includes('beginSse'));
    }
  });
});

describe('responses surface — store flag (OpenAI parity)', () => {
  it('store defaults to true and is echoed on the response object', async () => {
    const { t, sent } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto', input: 'turn' });

    assert.equal(sent()[0]!.status, 200);
    assert.equal(sent()[0]!.payload.store, true, 'absent store means retained, OpenAI default');
  });

  it('store:false is honored — the response is never a chain parent', async () => {
    const { t: t1, sent: sent1 } = makeFakeTransport();
    const o1 = makeStubOrchestrator();
    await runChatSurface(t1, responsesSurface, o1.orchestrator, { model: 'auto', store: false, input: 'private turn' });
    const unretainedId = String(sent1()[0]!.payload.id);
    assert.equal(sent1()[0]!.payload.store, false, 'the effective flag is echoed, not silently kept true');

    const { t: t2, sent: sent2 } = makeFakeTransport();
    const o2 = makeStubOrchestrator();
    await runChatSurface(t2, responsesSurface, o2.orchestrator, {
      model: 'auto',
      previous_response_id: unretainedId,
      input: 'child turn',
    });

    assert.equal(sent2()[0]!.status, 400, 'an unretained response cannot be chained');
    const wire = JSON.stringify(sent2()[0]!.payload);
    assert.ok(wire.includes('"code":"previous_response_not_found"'), wire);
    assert.equal(o2.processed.length, 0, 'nothing reached the orchestrator');
  });

  it('the stream opening object echoes store:false too', async () => {
    const { t, calls } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto', stream: true, store: false, input: 'x' });

    const chunks = calls.filter((c) => c.op === 'writeSseChunk').map((c) => c.args[0] as string);
    const created = sseEventChunks(chunks).map(sseData).find((p) => p.type === 'response.created')!;
    assert.equal((created.response as { store?: boolean }).store, false);
  });
});

describe('responses surface — unimplemented parameters fail visible', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ conversation: 'conv_123' }, 'conversation'],
    [{ background: true }, 'background'],
    [{ truncation: 'auto' }, 'truncation'],
    [{ text: { format: { type: 'json_schema' } } }, 'text.format'],
  ];

  for (const [extra, named] of cases) {
    it(`rejects "${named}" with code unsupported_parameter`, async () => {
      const { t, sent } = makeFakeTransport();
      const { orchestrator, processed } = makeStubOrchestrator();
      await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto', input: 'x', ...extra });

      assert.equal(sent()[0]!.status, 400);
      const payload = sent()[0]!.payload as { error?: { message?: string; code?: string } };
      assert.equal(payload.error?.code, 'unsupported_parameter');
      assert.ok(payload.error?.message?.includes(named), String(payload.error?.message));
      assert.equal(processed.length, 0, 'rejected before the orchestrator');
    });
  }

  it('accepts the no-op standard values (truncation disabled, text.format text)', async () => {
    const { t, sent } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, {
      model: 'auto',
      input: 'x',
      truncation: 'disabled',
      text: { format: { type: 'text' } },
    });
    assert.equal(sent()[0]!.status, 200);
  });
});
