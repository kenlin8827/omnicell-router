import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from 'bun';
import { ProviderConfig, RouterConfig } from '../src/config/types.js';
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

function stubProvider(baseUrl: string): ProviderConfig {
  return { name: 'stub', type: 'openai-compatible', baseUrl, apiKey: 'sk-stub' };
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
    models: [
      { id: 'stub/one', provider: 'stub', upstreamModel: 'up-1', tier: 'lite', priority: 1, isDefaultInTier: true, pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 } },
      { id: 'stub/two', provider: 'stub', upstreamModel: 'up-2', tier: 'lite', priority: 2, pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 } },
    ],
    ...extra,
  } as RouterConfig;
}

function boot(config: RouterConfig, providers: ProviderConfig[] = [stubProvider('http://localhost:9/v1')]) {
  const registry = new ProviderRegistry(config, false, providers);
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
    const { orchestrator } = boot(makeConfig(base), [stubProvider(base)]);
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
      // Industry TTFT/TPS split on the trace row: ttftMs = process start →
      // first forwarded chunk (user-perceived), genMs = first chunk → drained
      // stream — here the upstream's 60 ms stall must appear in the decode
      // window, NOT in the effective-rate sense. Both are bounded by latencyMs.
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      assert.equal(trace.execution.modelUsed, 'stub/one');
      assert.ok(typeof trace.execution.ttftMs === 'number' && trace.execution.ttftMs >= 0);
      assert.ok(trace.execution.genMs! >= 55, `decode window should cover the 60ms stall, got ${trace.execution.genMs}`);
      assert.ok(trace.execution.ttftMs! <= trace.execution.latencyMs);
      assert.ok(trace.execution.genMs! <= trace.execution.latencyMs);
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
    const { orchestrator } = boot(config, [stubProvider(base)]);
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
    const { orchestrator } = boot(config, [stubProvider(base)]);
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
    const providers: ProviderConfig[] = [stubProvider(base), { name: 'stub-a', type: 'anthropic', baseUrl: base, apiKey: 'sk' }];
    (config.models as any[]).push({
      id: 'stub-a/one',
      provider: 'stub-a',
      upstreamModel: 'up-1',
      tier: 'lite',
      priority: 3,
      wire: 'anthropic',
      pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 },
    });
    const { orchestrator } = boot(config, providers);
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

  it('a buffered (stream:false) turn records no ttftMs/genMs — no synthesized decode rate', async () => {
    const server = serve({
      port: 0,
      async fetch() {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-buf',
            object: 'chat.completion',
            created: 1,
            model: 'up-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'buffered' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    });
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(makeConfig(base), [stubProvider(base)]);
    try {
      const result = await orchestrator.process(request('stub/one', false), {}, undefined);
      assert.equal(result.response.choices[0].message.content, 'buffered');
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      assert.equal(trace.execution.ttftMs, undefined);
      assert.equal(trace.execution.genMs, undefined);
    } finally {
      server.stop(true);
    }
  });
});

/**
 * Schema-assertion cascade × streaming. The lite lead must stay buffered (its
 * output can be discarded wholesale on assertion failure — no byte may commit),
 * but the escalation leg's response IS the final answer (no re-assertion), so
 * it streams under the direct path's commit-point contract and stamps
 * ttftMs/genMs. Before the escalation leg carried the relay, these turns left
 * the client in silence for the whole generation and showed '—' in the console.
 */
describe('schema-assertion cascade streaming', () => {
  /** JSON body → routing: lite attempt answers non-JSON prose, plus streams. */
  function cascadeServer() {
    const plusHits: string[] = [];
    let liteHits = 0;
    const server = serve({
      port: 0,
      async fetch(req) {
        const body = JSON.parse(await req.text());
        if (body.model === 'up-lite') {
          liteHits++;
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-lite',
              object: 'chat.completion',
              created: 1700000000,
              model: 'up-lite',
              choices: [{ index: 0, message: { role: 'assistant', content: '我是散文，不是 JSON' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        // Escalation leg: SSE only when the upstream was ASKED to stream —
        // with streaming.enabled=false the rollback path calls createCompletion
        // (stream stripped), so the fake must answer a buffered JSON body.
        plusHits.push(body.model);
        if ((body.stream ?? false) !== true) {
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-plus',
              object: 'chat.completion',
              created: 1700000000,
              model: 'up-plus',
              choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":"yes"}' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        let pulled = 0;
        const stream = new ReadableStream({
          async pull(c) {
            if (pulled++ === 0) {
              c.enqueue(chunkLine({ role: 'assistant', content: '{"ok":' }, null, 'up-plus'));
              return;
            }
            await new Promise((r) => setTimeout(r, 60));
            c.enqueue(chunkLine({ content: '"yes"}' }, 'stop', 'up-plus'));
            c.enqueue(
              `data: ${JSON.stringify({
                id: 'chatcmpl-plus',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'up-plus',
                choices: [],
                usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
              })}\n\n`
            );
            c.enqueue('data: [DONE]\n\n');
            c.close();
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    return { server, plusHits, liteHits: () => liteHits };
  }

  const schemaRequest = () =>
    ({
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'extract' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'Strict',
          schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'string' } } },
        },
      },
    }) as any;

  /** Lite + plus registry: the cascade gate needs fallback.enabled=true. */
  function cascadeConfig(baseUrl: string, extra: Partial<RouterConfig> = {}): RouterConfig {
    return makeConfig(
      baseUrl,
      {
        fallback: { enabled: true, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
        models: [
          { id: 'stub/one', provider: 'stub', upstreamModel: 'up-lite', tier: 'lite', priority: 1, isDefaultInTier: true, pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 } },
          { id: 'stub/plus', provider: 'stub', upstreamModel: 'up-plus', tier: 'plus', priority: 1, isDefaultInTier: true, pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 } },
        ],
        ...extra,
      } as Partial<RouterConfig>
    );
  }

  function makeFactsSink() {
    const sink = makeRelaySink();
    const staged: any[] = [];
    const relay: StreamRelay = {
      stageRouting: (facts) => staged.push({ ...facts }),
      onChunk: sink.relay.onChunk,
      get committed() {
        return sink.relay.committed;
      },
    };
    return { relay, frames: sink.frames, staged };
  }

  it('escalation leg streams the final answer and stamps ttftMs/genMs', async () => {
    const { server, plusHits, liteHits } = cascadeServer();
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(cascadeConfig(base), [stubProvider(base)]);
    const { relay, frames, staged } = makeFactsSink();
    try {
      const result = await orchestrator.process(schemaRequest(), {}, relay);
      // The lite attempt ran and failed the assertion; the escalation served.
      assert.equal(liteHits(), 1);
      assert.equal(result.fallbackOccurred, true);
      assert.ok(result.fallbackReason?.includes('not valid JSON'));
      assert.equal(result.tierUsed, 'plus');
      assert.equal(result.response.choices[0].message.content, '{"ok":"yes"}');
      // THE fix: the escalation output reached the relay progressively.
      assert.ok(frames.length >= 2, `expected relayed frames, got ${frames.length}`);
      assert.equal(relay.committed, true);
      assert.equal(plusHits.length, 1, 'post-commit failure would re-issue; a clean stream hits once');
      // Trace: the industry TTFT/TPS split must now exist for cascade turns.
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      assert.equal(trace.execution.modelUsed, 'stub/plus');
      assert.ok(typeof trace.execution.ttftMs === 'number' && trace.execution.ttftMs >= 0);
      assert.ok(trace.execution.genMs! >= 55, `decode window should cover the 60ms stall, got ${trace.execution.genMs}`);
      assert.ok(trace.execution.ttftMs! <= trace.execution.latencyMs);
      // Routing facts staged on the first forwarded chunk name the ESCALATED
      // model/tier (the pool's per-attempt stageRouting overwrites), and the
      // decision layer stays the original router's.
      const last = staged[staged.length - 1];
      assert.equal(last.modelUsed, 'stub/plus');
      assert.equal(last.tierUsed, 'plus');
      assert.equal(last.layerUsed, 'layer0');
    } finally {
      server.stop(true);
    }
  });

  it('lite-success cascade turns stay buffered — no frames, timing undefined', async () => {
    const server = serve({
      port: 0,
      async fetch(req) {
        const body = JSON.parse(await req.text());
        if (body.model === 'up-lite') {
          // Buffered JSON body: the lite lead executes WITHOUT the relay, so
          // registry falls to createCompletion which strips `stream` — the
          // upstream never even sees a streaming ask. Buffering here is the
          // gateway's assertion discipline, not the wire's.
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-lite',
              object: 'chat.completion',
              created: 1700000000,
              model: 'up-lite',
              choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":"valid"}' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error('escalation must not run when the lite assertion passes');
      },
    });
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(cascadeConfig(base), [stubProvider(base)]);
    const { relay, frames } = makeFactsSink();
    try {
      const result = await orchestrator.process(schemaRequest(), {}, relay);
      assert.equal(result.fallbackOccurred, false);
      assert.equal(result.tierUsed, 'lite');
      assert.equal(result.response.choices[0].message.content, '{"ok":"valid"}');
      assert.equal(frames.length, 0, 'a discardable lite attempt must never commit relay bytes');
      assert.equal(relay.committed, false);
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      assert.equal(trace.execution.ttftMs, undefined);
      assert.equal(trace.execution.genMs, undefined);
    } finally {
      server.stop(true);
    }
  });

  it('streaming.enabled=false rolls the escalation leg back to buffered', async () => {
    const { server, plusHits } = cascadeServer();
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(cascadeConfig(base, { streaming: { enabled: false } }), [stubProvider(base)]);
    const { relay, frames } = makeFactsSink();
    try {
      const result = await orchestrator.process(schemaRequest(), {}, relay);
      assert.equal(result.fallbackOccurred, true);
      assert.equal(result.tierUsed, 'plus');
      assert.equal(result.response.choices[0].message.content, '{"ok":"yes"}');
      assert.equal(frames.length, 0, 'the rollback switch must keep the escalation leg buffered too');
      assert.equal(plusHits.length, 1);
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.equal(trace?.execution.ttftMs, undefined);
      assert.equal(trace?.execution.genMs, undefined);
    } finally {
      server.stop(true);
    }
  });

  it('escalation leg that breaks after committed bytes is not re-issued', async () => {
    const plusHits: string[] = [];
    let liteHits = 0;
    const server = serve({
      port: 0,
      async fetch(req) {
        const body = JSON.parse(await req.text());
        if (body.model === 'up-lite') {
          liteHits++;
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-lite',
              object: 'chat.completion',
              created: 1700000000,
              model: 'up-lite',
              choices: [{ index: 0, message: { role: 'assistant', content: 'not json' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        // Escalation leg: one committed frame, then the body dies.
        plusHits.push(body.model);
        let pulled = 0;
        const stream = new ReadableStream({
          async pull(c) {
            if (pulled++ === 0) {
              c.enqueue(chunkLine({ content: 'halfway' }, null, 'up-plus'));
              return;
            }
            await new Promise((r) => setTimeout(r, 60));
            c.error(new Error('upstream reset'));
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(cascadeConfig(base), [stubProvider(base)]);
    const { relay, frames } = makeFactsSink();
    try {
      let rejected = false;
      await orchestrator.process(schemaRequest(), {}, relay).catch(() => {
        rejected = true;
      });
      assert.ok(rejected, 'a broken escalation stream must surface as a failed turn');
      assert.ok(liteHits >= 1, 'the lite lead must have run and failed the assertion');
      assert.ok(frames.length >= 1, 'the first escalation frame must have been relayed before the break');
      assert.equal(plusHits.length, 1, 'post-commit: no second candidate, no re-issue');
    } finally {
      server.stop(true);
    }
  });
});
