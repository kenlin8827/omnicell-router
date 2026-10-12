import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { anthropicSurface } from '../src/surfaces/anthropic.js';
import { chatSurface } from '../src/surfaces/chat.js';
import { responsesSurface } from '../src/surfaces/responses.js';
import { systemoneSurface } from '../src/surfaces/systemone.js';
import { runChatSurface } from '../src/surfaces/chat-pipeline.js';
import { SURFACES, detectSurface } from '../src/surfaces/table.js';
import type { TransportContext } from '../src/surfaces/types.js';
import type { ModelAccessConfig } from '../src/config/types.js';
import type { ChatCompletionRequest } from '../src/types/openai.js';
import type { ExecutionResult } from '../src/types/router.js';

/**
 * Frozen-order unit tests for the chat surface pipeline (contract step 2):
 * the FAKE TransportContext records every call so we can assert the §1.3
 * sequence (parse-400 before gate, gate before process, exactly one terminal
 * send) without Fastify in the loop. Wire-level byte identity stays the
 * server.test.ts / capture suites' job.
 */

interface RecordedCall {
  op: string;
  args: unknown[];
}

const fakeReq = { __fakeFastifyRequest: true };

function makeFakeTransport(opts: {
  enforce?: (model: string) => boolean;
  policy?: ModelAccessConfig;
} = {}) {
  const calls: RecordedCall[] = [];
  const record = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const t: TransportContext = {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'user-agent': 'surface-chat-test' },
    clientIp: '127.0.0.1',
    access: {
      kind: 'key',
      keyName: 'fake-key',
      policy: opts.policy,
      enforce: (model) => {
        record('enforce', model);
        return opts.enforce ? opts.enforce(model) : true;
      },
    },
    captureProcessContext: () => {
      record('captureProcessContext');
      return { fastifyRequest: fakeReq as unknown as FastifyRequest };
    },
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
    costUsd: 0,
    baselineCostUsd: 0,
    savedCostUsd: 0,
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
  const processed: Array<{ request: ChatCompletionRequest; ctx: Record<string, unknown> }> = [];
  const orchestrator = {
    process: async (request: ChatCompletionRequest, ctx: Record<string, unknown>) => {
      processed.push({ request, ctx: ctx ?? {} });
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.result ?? stubResult('mock-1', okResponse);
    },
  } as unknown as Parameters<typeof runChatSurface>[2];
  return { orchestrator, processed };
}

const chatBody = (extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({
  model: 'auto',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

describe('chat surface — frozen §1.3 order', () => {
  it('parse failure sends 400 BEFORE the gate runs and never reaches process', async () => {
    const { t, calls, ops } = makeFakeTransport();
    const { orchestrator, processed } = makeStubOrchestrator();
    await runChatSurface(t, chatSurface, orchestrator, { model: 'auto', messages: 'not-an-array' });

    assert.deepEqual(ops(), ['sendJson']);
    const [status, body] = calls[0]!.args;
    assert.equal(status, 400);
    // EXACT today-handler text + OpenAI envelope (no code field).
    assert.deepEqual(body, {
      error: { message: 'Invalid request: "messages" array is required.', type: 'invalid_request_error' },
    });
    assert.equal(processed.length, 0, 'process must never run for a rejected parse');
  });

  it('gate denial returns immediately — 403 is the gate send, nothing after', async () => {
    const { t, ops } = makeFakeTransport({ enforce: () => false });
    const { orchestrator, processed } = makeStubOrchestrator();
    await runChatSurface(t, chatSurface, orchestrator, chatBody());

    assert.deepEqual(ops(), ['enforce'], 'no process / captureProcessContext / terminal send after denial');
    assert.equal(processed.length, 0);
  });

  it('gate model is trim() || auto; request.model stays verbatim into process', async () => {
    const { t, calls } = makeFakeTransport();
    const { orchestrator, processed } = makeStubOrchestrator();
    await runChatSurface(t, chatSurface, orchestrator, chatBody({ model: '  my-model  ' }));
    assert.equal(calls.find((c) => c.op === 'enforce')?.args[0], 'my-model');

    const { t: t2, calls: calls2 } = makeFakeTransport();
    const o2 = makeStubOrchestrator();
    await runChatSurface(t2, chatSurface, o2.orchestrator, chatBody({ model: undefined as unknown as string }));
    assert.equal(calls2.find((c) => c.op === 'enforce')?.args[0], 'auto');
    assert.equal(processed[0]!.request.model, '  my-model  ', 'client-sent name untouched');
  });

  it('process receives wire/chat + gate policy + captureProcessContext spread', async () => {
    const policy: ModelAccessConfig = { mode: 'allow', models: ['mock-1'] };
    const { t } = makeFakeTransport({ policy });
    const { orchestrator, processed } = makeStubOrchestrator();
    await runChatSurface(t, chatSurface, orchestrator, chatBody());

    const ctx = processed[0]!.ctx;
    assert.equal(ctx.wire, 'chat');
    assert.equal(ctx.modelAccess, policy, 'modelAccess comes from the gate, not a re-read');
    assert.equal(ctx.clientIp, '127.0.0.1');
    assert.deepEqual(ctx.headers, { 'user-agent': 'surface-chat-test' });
    assert.equal(ctx.fastifyRequest, fakeReq, 'capture fields arrive via captureProcessContext()');
  });

  it('stream=true sends beginSse → chunks → [DONE] last → endSse (no sendJson)', async () => {
    const { t, calls, ops } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, chatSurface, orchestrator, chatBody({ stream: true }));

    const sseOps = ops().filter((op) => op !== 'enforce' && op !== 'captureProcessContext');
    assert.equal(sseOps[0], 'beginSse');
    assert.equal(sseOps[sseOps.length - 1], 'endSse');
    const chunks = calls.filter((c) => c.op === 'writeSseChunk').map((c) => c.args[0] as string);
    assert.ok(chunks.length >= 2, 'role chunk + content + finish + DONE');
    assert.equal(chunks[chunks.length - 1], 'data: [DONE]\n\n');
    assert.ok(ops().includes('writeSseChunk'));
    assert.equal(ops().filter((o) => o === 'sendJson').length, 0, 'exactly one terminal discipline');
    // Chunk model field = result.modelUsed verbatim (today's handler), no header-style fallback.
    assert.equal(JSON.parse(chunks[0]!.replace('data: ', '').trim()).model, 'mock-1');
  });

  it('non-boolean truthy stream takes the JSON path (approved C-3 convergence)', async () => {
    const { t, ops } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, chatSurface, orchestrator, chatBody({ stream: 'true' as unknown as boolean }));
    assert.ok(ops().includes('sendJson'));
    assert.ok(!ops().includes('beginSse'));
  });

  it('non-stream sends sendJson(200, result.response, full X-OCR header set)', async () => {
    const { t, calls } = makeFakeTransport();
    const result = { ...stubResult('mock-1', okResponse), requestedEffort: 'high' as const };
    const { orchestrator } = makeStubOrchestrator({ result });
    await runChatSurface(t, chatSurface, orchestrator, chatBody({ model: 'auto' }));

    const send = calls.find((c) => c.op === 'sendJson')!;
    assert.equal(send.args[0], 200);
    assert.equal(send.args[1], okResponse, 'encodeJson passes result.response through as-is');
    const headers = send.args[2] as Record<string, string>;
    for (const key of [
      'X-OCR-Tier', 'X-OCR-Layer', 'X-OCR-Model', 'X-OCR-Failover', 'X-OCR-Failover-Attempts',
      'X-OCR-Failover-Path', 'X-OCR-InPlace-Retries', 'X-OCR-Breaker-State', 'X-OCR-Session-ID',
      'X-OCR-Session-Ratchet', 'X-OCR-Session-Lookup', 'X-OCR-Trace-ID', 'X-OCR-Cost-USD',
      'X-OCR-Saved-USD', 'X-OCR-Latency-MS',
    ]) {
      assert.ok(key in headers, `base header ${key} must be staged`);
    }
    assert.equal(headers['X-OCR-Model'], 'mock-1');
    assert.equal(headers['X-OCR-Thinking-Requested'], 'high', 'conditionals ride the same set');
  });

  it('afterResult hook fires before the first terminal call', async () => {
    const { t, ops } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator();
    const orderAtHook: string[] = [];
    const surfaceWithHook = {
      ...chatSurface,
      afterResult: () => orderAtHook.push(...ops()),
    };
    await runChatSurface(t, surfaceWithHook, orchestrator, chatBody({ stream: true }));
    assert.ok(orderAtHook.includes('enforce'));
    assert.ok(!orderAtHook.includes('beginSse'), 'hook runs strictly before beginSse (pre-first-byte)');
  });

  it('execution errors map through executionError + logError + one sendJson', async () => {
    const cases: Array<[unknown, number, string, string]> = [
      [Object.assign(new Error('provider down'), { statusCode: 503 }), 503, 'provider down', 'api_error'],
      [Object.assign(new Error('not found'), { statusCode: 404 }), 404, 'not found', 'invalid_request_error'],
      [Object.assign(new Error('crazy'), { statusCode: 700 }), 500, 'crazy', 'api_error'],
      [new Error('plain'), 500, 'plain', 'api_error'],
    ];
    for (const [err, expectedStatus, expectedMessage, expectedType] of cases) {
      const { t, calls, ops } = makeFakeTransport();
      const { orchestrator } = makeStubOrchestrator({ throw: err });
      await runChatSurface(t, chatSurface, orchestrator, chatBody());

      const log = calls.find((c) => c.op === 'logError')!;
      assert.equal(log.args[1], 'Chat completion execution failed');
      const sends = calls.filter((c) => c.op === 'sendJson');
      assert.equal(sends.length, 1, 'exactly one terminal send on the error path');
      const [status, body] = sends[0]!.args;
      assert.equal(status, expectedStatus);
      assert.deepEqual(body, { error: { message: expectedMessage, type: expectedType } });
      assert.ok(!ops().includes('beginSse'));
    }
  });

  it('execution error with no message falls back to Internal Router Error', async () => {
    const { t, calls } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator({ throw: Object.assign(new Error(''), { statusCode: 500 }) });
    await runChatSurface(t, chatSurface, orchestrator, chatBody());
    const send = calls.filter((c) => c.op === 'sendJson')[0]!;
    assert.equal(send.args[0], 500);
    assert.deepEqual(send.args[1], { error: { message: 'Internal Router Error', type: 'api_error' } });
  });
});

describe('surface table (step 4 contents)', () => {
  it('SURFACES holds chat + anthropic + responses + systemone; detectSuffix routes all four', () => {
    assert.equal(SURFACES.length, 4);
    assert.equal(SURFACES[0], chatSurface);
    assert.equal(SURFACES[1], anthropicSurface);
    assert.equal(SURFACES[2], responsesSurface);
    assert.equal(SURFACES[3], systemoneSurface);
    assert.equal(detectSurface('/v1/chat/completions'), chatSurface);
    assert.equal(detectSurface('/v1/chat/completions?x=1'), chatSurface);
    assert.equal(detectSurface('/V1/Chat/Completions'), chatSurface);
    assert.equal(detectSurface('/v1/messages'), anthropicSurface, 'anthropic joined in step 3a');
    assert.equal(detectSurface('/v1/responses'), responsesSurface, 'responses joined in step 3b');
    assert.equal(detectSurface('/v1/systemone'), systemoneSurface, 'decision surface joined in step 4');
    assert.equal(detectSurface('/systemone'), systemoneSurface, 'ADR-0014 §2: the wide suffix claims native upstream paths');
  });

  it('chat surface metadata matches the contract', () => {
    assert.equal(chatSurface.wire, 'chat');
    assert.equal(chatSurface.exec, 'chat-pipeline');
    assert.equal(chatSurface.capture, true);
    assert.equal(chatSurface.routePath, '/v1/chat/completions');
    assert.equal(chatSurface.detectSuffix, '/v1/chat/completions');
  });
});
