import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from 'bun';
import { RouterConfig } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import type { ChatCompletionChunk } from '../src/types/openai.js';
import type { StreamRelay } from '../src/utils/chat-stream.js';

/**
 * End-to-end streaming through the REAL execution chain: candidate pool →
 * registry.execute → provider SSE reader → relay → accumulated buffered response
 * → post-turn accounting. The unit-level relay tests live in
 * streaming-relay.test.ts; this file pins the two things only the pool can
 * break: a client that receives bytes before the turn completes, and a
 * half-streamed turn that must NEVER be re-issued on another candidate.
 */

function makeRelaySink() {
  const frames: ChatCompletionChunk[] = [];
  const relay: StreamRelay = {
    stageRouting: () => {},
    onChunk: (chunk) => frames.push(chunk),
    get committed() {
      return frames.length > 0;
    },
  };
  return { relay, frames };
}

const chunkLine = (delta: Record<string, unknown>, finish: string | null = null, model = 'up-1') =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

function sseBody(...frames: string[]): string {
  return frames.join('') + 'data: [DONE]\n\n';
}

function makeConfig(baseUrl: string, extra: Partial<RouterConfig> = {}): RouterConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    baselineModel: 'stub/one',
    fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
    circuitBreaker: { enabled: true, failureThreshold: 5 },
    retry: {
      enabled: true,
      inplace: { enabled: false, maxAttempts: 0, backoffMs: 1, jitterMs: 1 },
      failover: { enabled: true, maxAttempts: 3, tierCrossPolicy: 'deny' },
    },
    providers: [{ name: 'stub', type: 'openai', baseUrl, apiKey: 'sk-stub' }],
    models: [
      { id: 'stub/one', provider: 'stub', upstreamModel: 'up-1', tier: 'lite', priority: 1, isDefaultInTier: true, pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 } },
      { id: 'stub/two', provider: 'stub', upstreamModel: 'up-2', tier: 'lite', priority: 2, pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 } },
    ],
    ...extra,
  } as RouterConfig;
}

function boot(config: RouterConfig) {
  const registry = new ProviderRegistry(config, false);
  const tracker = new FinOpsTracker();
  return { registry, tracker, orchestrator: new PipelineOrchestrator(config, registry, tracker) };
}

const request = (model: string, stream = true) =>
  ({ model, messages: [{ role: 'user', content: 'hi' }], stream }) as any;

describe('true streaming through the candidate pool', () => {
  it('forwards frames while the turn is still executing, then credentials normally', async () => {
    let hits = 0;
    let pulled = 0;
    const server = serve({
      port: 0,
      async fetch() {
        hits++;
        const stream = new ReadableStream({
          async pull(c) {
            if (pulled++ === 0) {
              // First frame goes out immediately; the rest arrives 60 ms later.
              // If the gateway buffered, the relay would see nothing at t≈20 ms.
              c.enqueue(chunkLine({ role: 'assistant', content: 'part-' }));
              return;
            }
            await new Promise((r) => setTimeout(r, 60));
            c.enqueue(chunkLine({ content: 'one' }));
            c.enqueue(chunkLine({}, 'stop'));
            c.enqueue(
              `data: ${JSON.stringify({
                id: 'chatcmpl-e2e',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'up-1',
                choices: [],
                usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
              })}\n\n`
            );
            c.enqueue('data: [DONE]\n\n');
            c.close();
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(makeConfig(base));
    const { relay, frames } = makeRelaySink();

    try {
      const pending = orchestrator.process(request('stub/one'), {}, relay);
      await new Promise((r) => setTimeout(r, 20));
      // THE point of the whole change: a byte reached the client while the turn
      // was still running. A buffered gateway would have nothing here.
      assert.ok(frames.length >= 1, `expected progressive delivery, got ${frames.length} frames at t=20ms`);
      const result = await pending;
      assert.equal(frames.length >= 3, true);
      // The buffered object every consumer reads was rebuilt from those frames.
      assert.equal(result.response.choices[0].message.content, 'part-one');
      assert.equal(result.response.usage?.completion_tokens, 3);
      assert.equal(result.modelUsed, 'stub/one');
      assert.equal(hits, 1);
      // Credentialing saw usage, so the turn is billed exactly like a buffered one.
      assert.equal(relay.committed, true);
    } finally {
      server.stop(true);
    }
  });

  it('a mid-stream break after committed bytes is NOT failed over or retried', async () => {
    const seenPaths: string[] = [];
    const server = serve({
      port: 0,
      async fetch(req) {
        seenPaths.push(new URL(req.url).pathname + (await req.text()));
        // One frame delivered and CONSUMED, then the connection dies mid-body:
        // the client has already been handed that frame, so re-asking is
        // forbidden. `pull` makes the sequencing deterministic — the reader takes
        // exactly one frame before it hits the error.
        let pulled = 0;
        const stream = new ReadableStream({
          async pull(c) {
            if (pulled++ === 0) {
              c.enqueue(chunkLine({ content: 'halfway' }));
              return;
            }
            // Let the socket actually flush frame 1 before killing the body —
            // otherwise the client never sees it and this test would be proving
            // the pre-commit case instead of the committed one.
            await new Promise((r) => setTimeout(r, 60));
            c.error(new Error('upstream reset'));
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    const base = `http://localhost:${server.port}/v1`;
    const config = makeConfig(base, {
      combos: [{ id: 'pair', selection: 'priority', models: ['stub/one', 'stub/two'] }],
    } as Partial<RouterConfig>);
    const { orchestrator } = boot(config);
    const { relay, frames } = makeRelaySink();

    try {
      let rejected = false;
      await orchestrator.process(request('pair'), {}, relay).catch(() => {
        rejected = true;
      });
      assert.ok(rejected, 'a broken stream must surface as a failed turn');
      assert.ok(frames.length >= 1, 'the first frame must have been relayed before the break');
      assert.equal(frames.length, 1, 'only the committed frame may have been relayed');
      assert.equal(seenPaths.length, 1, `mid-stream failure must not re-issue upstream, saw ${seenPaths.length} calls`);
    } finally {
      server.stop(true);
    }
  });

  it('a failure BEFORE the first frame still fails over to the next candidate', async () => {
    let hits = 0;
    const server = serve({
      port: 0,
      async fetch() {
        hits++;
        if (hits === 1) return new Response('boom', { status: 503 });
        return new Response(sseBody(chunkLine({ content: 'second wins' }, 'stop')), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    });
    const base = `http://localhost:${server.port}/v1`;
    const config = makeConfig(base, {
      combos: [{ id: 'pair', selection: 'priority', models: ['stub/one', 'stub/two'] }],
    } as Partial<RouterConfig>);
    const { orchestrator } = boot(config);
    const { relay, frames } = makeRelaySink();
    try {
      const result = await orchestrator.process(request('pair'), {}, relay);
      assert.equal(hits, 2, 'the head-level 5xx must fail over to the next candidate');
      assert.equal(result.response.choices[0].message.content, 'second wins');
      assert.equal(result.failoverOccurred, true);
      assert.ok(frames.length >= 1);
    } finally {
      server.stop(true);
    }
  });

  it('a wire without a streaming executor keeps the buffered call', async () => {
    let body = '';
    const server = serve({
      port: 0,
      async fetch() {
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'up-1',
            content: [{ type: 'text', text: 'buffered' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    });
    const base = `http://localhost:${server.port}/v1`;
    const config = makeConfig(base);
    // Second provider on the Anthropic wire: no createStream anywhere on it.
    (config.providers as any[]).push({ name: 'stub-a', type: 'anthropic', baseUrl: base, apiKey: 'sk' });
    (config.models as any[]).push({
      id: 'stub-a/one',
      provider: 'stub-a',
      upstreamModel: 'up-1',
      tier: 'lite',
      priority: 3,
      wire: 'anthropic',
      pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 },
    });
    const { orchestrator } = boot(config as RouterConfig);
    const { relay, frames } = makeRelaySink();
    try {
      const result = await orchestrator.process(request('stub-a/one'), {}, relay);
      body = JSON.stringify(result.response.choices[0].message.content);
      assert.equal(body, JSON.stringify('buffered'));
      assert.equal(frames.length, 0, 'an unstreamable wire must never feed the relay');
      assert.equal(relay.committed, false);
    } finally {
      server.stop(true);
    }
  });

  it('mock mode ignores the relay (test base stays buffered)', async () => {
    const config = makeConfig('http://localhost:1/v1');
    const registry = new ProviderRegistry(config, true);
    const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
    const { relay, frames } = makeRelaySink();
    const result = await orchestrator.process(request('stub/one'), {}, relay);
    assert.ok(result.response.choices.length >= 1);
    assert.equal(frames.length, 0);
  });
});
