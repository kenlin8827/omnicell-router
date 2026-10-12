import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { responsesSurface } from '../src/surfaces/responses.js';
import { runChatSurface } from '../src/surfaces/chat-pipeline.js';
import { SURFACES } from '../src/surfaces/table.js';
import type { TransportContext } from '../src/surfaces/types.js';
import type { ChatCompletionRequest } from '../src/types/openai.js';
import type { ExecutionResult } from '../src/types/router.js';

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

function stubResult(modelUsed: string, response: unknown, sessionId = 'sess-1'): ExecutionResult {
  return {
    response: response as never,
    tierUsed: 'lite',
    modelUsed,
    fallbackOccurred: false,
    costUsd: 0,
    baselineCostUsd: 0,
    savedCostUsd: 0,
    latencyMs: 1,
    sessionId,
    traceId: 'trace-1',
  };
}

const okResponse = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'mock-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function makeStubOrchestrator(behavior: { result?: ExecutionResult; throw?: unknown } = {}) {
  const processed: Array<{ request: ChatCompletionRequest }> = [];
  const orchestrator = {
    process: async (request: ChatCompletionRequest) => {
      processed.push({ request });
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.result ?? stubResult('mock-1', okResponse);
    },
  } as unknown as Parameters<typeof runChatSurface>[2];
  return { orchestrator, processed };
}

const sseData = (chunk: string): Record<string, unknown> =>
  JSON.parse(chunk.split('\n')[1]!.replace('data: ', ''));

describe('responses surface — metadata', () => {
  it('matches the contract §1 entry', () => {
    assert.equal(responsesSurface.wire, 'responses');
    assert.equal(responsesSurface.exec, 'chat-pipeline');
    assert.equal(responsesSurface.capture, true);
    assert.equal(responsesSurface.routePath, '/v1/responses');
    assert.equal(responsesSurface.detectSuffix, '/v1/responses');
    assert.ok(SURFACES.includes(responsesSurface));
  });
});

describe('responses surface — parse 400 texts', () => {
  it('missing input → exact text through the wire envelope (no code)', async () => {
    const { t, sent, ops } = makeFakeTransport();
    const { orchestrator, processed } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto' });

    assert.deepEqual(ops(), ['sendJson'], '400 precedes the gate');
    const send = sent()[0]!;
    assert.equal(send.status, 400);
    assert.equal(
      JSON.stringify(send.payload),
      '{"error":{"message":"Invalid request: \\"input\\" is required.","type":"invalid_request_error"}}'
    );
    assert.equal(processed.length, 0);
  });

  it('unknown item type throws through with its own message; empty resolution pinned', () => {
    assert.equal(responsesSurface.parse({ model: 'auto', input: [{ type: 'bogus' }] }).error, 'Unsupported input item type: "bogus"');
    assert.equal(responsesSurface.parse({ model: 'auto', input: [] }).error, 'Invalid request: "input" resolved to an empty message list.');
    assert.equal(responsesSurface.parse(null).error, 'Invalid request: "input" is required.');
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
    assert.equal(req.router_options?.session_id, 'sess-abc', 'parent node session replayed via router_options');
    // messages = [instructions] + rebuilt chain (user+assistant) + this delta
    assert.equal(req.messages.length, 4);
    assert.deepEqual(req.messages[0], { role: 'system', content: 'be terse' });
    assert.equal(req.messages[1]!.role, 'user');
    assert.equal(req.messages[1]!.content, 'parent turn');
    assert.equal(req.messages[2]!.role, 'assistant');
    assert.equal(req.messages[2]!.content, 'ok');
    assert.equal(req.messages[3]!.content, 'child turn');
  });

  it('stream=true: response.created…completed carry the SAME minted id; no [DONE]', async () => {
    const { t, calls } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, responsesSurface, orchestrator, { model: 'auto', stream: true, input: 'sse turn' });

    const chunks = calls.filter((c) => c.op === 'writeSseChunk').map((c) => c.args[0] as string);
    assert.ok(chunks.length >= 4, 'created/in_progress + item + deltas + completed');
    const createdId = (sseData(chunks[0]!).response as { id: string }).id;
    const completed = sseData(chunks[chunks.length - 1]!).response as { id: string; status: string };
    assert.match(createdId, /^resp_[0-9a-f]{24}$/);
    assert.equal(completed.id, createdId, 'one minted respId flows through every event (state coupling)');
    assert.equal(completed.status, 'completed');
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
