import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicSurface } from '../src/surfaces/anthropic.js';
import { runChatSurface } from '../src/surfaces/chat-pipeline.js';
import { SURFACES } from '../src/surfaces/table.js';
import type { TransportContext } from '../src/surfaces/types.js';
import type { ChatCompletionRequest } from '../src/types/openai.js';
import type { ExecutionResult } from '../src/types/router.js';

/**
 * Surface-level unit tests for the anthropic wire (contract step 3a):
 * parse-400 message texts pinned, SSE framing (message_start…message_stop,
 * NO [DONE]), modelUsed encoding, and the Anthropic error envelope on both
 * error paths. HTTP byte identity vs the old handler stays server.test.ts +
 * the scratch capture diff's job; this file pins the protocol surface itself.
 */

interface RecordedCall {
  op: string;
  args: unknown[];
}

function makeFakeTransport(opts: { enforce?: (model: string) => boolean } = {}) {
  const calls: RecordedCall[] = [];
  const record = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const t: TransportContext = {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'user-agent': 'surface-anthropic-test' },
    clientIp: '127.0.0.1',
    access: {
      kind: 'key',
      keyName: 'fake-key',
      policy: undefined,
      enforce: (model) => {
        record('enforce', model);
        return opts.enforce ? opts.enforce(model) : true;
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
  return { t, calls, ops: () => calls.map((c) => c.op) };
}

function stubResult(modelUsed: string, response: unknown): ExecutionResult {
  return {
    response: response as never,
    tierUsed: 'lite',
    modelUsed,
    fallbackOccurred: false,
    latencyMs: 1,
    sessionId: 'sess-1',
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

const anthropicBody = (extra: Record<string, unknown> = {}) => ({
  model: 'auto',
  max_tokens: 64,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  ...extra,
});

describe('anthropic surface — metadata', () => {
  it('matches the contract §1 entry', () => {
    assert.equal(anthropicSurface.wire, 'anthropic');
    assert.equal(anthropicSurface.exec, 'chat-pipeline');
    assert.equal(anthropicSurface.capture, true);
    assert.equal(anthropicSurface.routePath, '/v1/messages');
    assert.equal(anthropicSurface.detectSuffix, '/v1/messages');
    assert.ok(SURFACES.includes(anthropicSurface));
  });
});

describe('anthropic surface — parse + 400 envelope', () => {
  it('missing messages → converter text in the Anthropic envelope, gate never runs', async () => {
    const { t, calls, ops } = makeFakeTransport();
    const { orchestrator, processed } = makeStubOrchestrator();
    await runChatSurface(t, anthropicSurface, orchestrator, { model: 'auto', max_tokens: 64 });

    assert.deepEqual(ops(), ['sendJson']);
    const [status, body] = calls[0]!.args;
    assert.equal(status, 400);
    assert.deepEqual(body, {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid request: "messages" array is required.' },
    });
    assert.equal(processed.length, 0);
  });

  it('null body keeps the same text; the "Invalid request." fallback is unreachable via the converter', () => {
    assert.equal(anthropicSurface.parse(null).error, 'Invalid request: "messages" array is required.');
    assert.equal(anthropicSurface.parse({ messages: [] }).error, 'Invalid request: "messages" array is required.');
  });

  it('system + model normalization ride the converter verbatim (trim||auto, max_tokens default)', async () => {
    const { t, calls } = makeFakeTransport();
    const { orchestrator, processed } = makeStubOrchestrator();
    await runChatSurface(
      t,
      anthropicSurface,
      orchestrator,
      anthropicBody({ model: '  mock-lite  ', system: 'be nice', max_tokens: undefined })
    );
    assert.equal(calls.find((c) => c.op === 'enforce')?.args[0], 'mock-lite');
    const req = processed[0]!.request;
    assert.equal(req.model, 'mock-lite');
    assert.equal(req.max_tokens, 4096);
    assert.deepEqual(req.messages![0], { role: 'system', content: 'be nice' });
  });
});

describe('anthropic surface — SSE framing', () => {
  it('stream=true: beginSse → message_start…message_stop → endSse, no [DONE], no sendJson', async () => {
    const { t, calls, ops } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, anthropicSurface, orchestrator, anthropicBody({ stream: true }));

    const sseOps = ops().filter((op) => op !== 'enforce');
    assert.equal(sseOps[0], 'beginSse', 'exactly one terminal discipline, SSE-first');
    assert.equal(sseOps[sseOps.length - 1], 'endSse');
    assert.equal(ops().filter((o) => o === 'sendJson').length, 0);

    const chunks = calls.filter((c) => c.op === 'writeSseChunk').map((c) => c.args[0] as string);
    assert.ok(chunks.length >= 4, 'start + delta(s) + stop + message framing events');
    assert.ok(chunks[0]!.startsWith('event: message_start\n'), 'sequence opens with message_start');
    assert.ok(chunks[chunks.length - 1]!.startsWith('event: message_stop\n'), 'sequence ends with message_stop');
    assert.ok(!chunks.some((c) => c.includes('[DONE]')), 'anthropic wire has no [DONE] sentinel');
    assert.ok(chunks.some((c) => c.startsWith('event: content_block_delta\n') && c.includes('"text_delta"')));
    assert.ok(chunks.some((c) => c.startsWith('event: message_delta\n')));
  });

  it('non-boolean truthy stream takes the JSON path (approved C-3 convergence)', async () => {
    const { t, ops } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, anthropicSurface, orchestrator, anthropicBody({ stream: 'true' }));
    assert.ok(ops().includes('sendJson'));
    assert.ok(!ops().includes('beginSse'));
  });

  it('encoders label the payload with result.modelUsed (today handler)', async () => {
    const result = stubResult('mock-7', { ...okResponse, model: 'ignored-by-converter' });
    const { t, calls } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator({ result });
    await runChatSurface(t, anthropicSurface, orchestrator, anthropicBody());
    const send = calls.find((c) => c.op === 'sendJson')!;
    assert.equal((send.args[1] as { model: string }).model, 'mock-7');

    const { t: t2, calls: calls2 } = makeFakeTransport();
    const o2 = makeStubOrchestrator({ result });
    await runChatSurface(t2, anthropicSurface, o2.orchestrator, anthropicBody({ stream: true }));
    const startChunk = calls2.find((c) => c.op === 'writeSseChunk')!.args[0] as string;
    const start = JSON.parse(startChunk.split('\n')[1]!.replace('data: ', ''));
    assert.equal(start.message.model, 'mock-7');
  });
});

describe('anthropic surface — execution errors', () => {
  it('statusCode mapping + Anthropic envelope, exactly one send', async () => {
    const cases: Array<[unknown, number, string, string]> = [
      [Object.assign(new Error('provider down'), { statusCode: 503 }), 503, 'provider down', 'api_error'],
      [Object.assign(new Error('not found'), { statusCode: 404 }), 404, 'not found', 'invalid_request_error'],
      [Object.assign(new Error('crazy'), { statusCode: 700 }), 500, 'crazy', 'api_error'],
      [new Error('plain'), 500, 'plain', 'api_error'],
      [Object.assign(new Error(''), { statusCode: 500 }), 500, 'Internal Router Error', 'api_error'],
    ];
    for (const [err, expectedStatus, expectedMessage, expectedType] of cases) {
      const { t, calls, ops } = makeFakeTransport();
      const { orchestrator } = makeStubOrchestrator({ throw: err });
      await runChatSurface(t, anthropicSurface, orchestrator, anthropicBody());

      const sends = calls.filter((c) => c.op === 'sendJson');
      assert.equal(sends.length, 1);
      const [status, body] = sends[0]!.args;
      assert.equal(status, expectedStatus);
      assert.deepEqual(body, { type: 'error', error: { type: expectedType, message: expectedMessage } });
      assert.ok(!ops().includes('beginSse'));
    }
  });
});
