import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from 'bun';
import { ProviderConfig, RouterConfig } from '../../src/config/types.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import type { StreamEvent } from '../../src/ir/types.js';
import type { StreamRelay } from '../../src/utils/stream-relay.js';
import { applyStreamingPosture, resetStreamingPostureForTests } from '../../src/pipeline/streaming-posture.js';
import { chatOf, processIR } from '../helpers/ir.js';

/**
 * End-to-end streaming through the REAL execution chain: candidate pool →
 * registry.execute → provider SSE reader → relay → accumulated buffered response
 * → post-turn accounting. The unit-level relay tests live in
 * streaming-relay.test.ts; this file pins the two things only the pool can
 * break: a client that receives bytes before the turn completes, and a
 * half-streamed turn that must NEVER be re-issued on another candidate.
 */

function makeRelaySink() {
  const frames: StreamEvent[] = [];
  const relay: StreamRelay = {
    stageRouting: () => {},
    onChunk: (chunk) => frames.push(chunk),
    get committed() {
      return frames.length > 0;
    },
  };
  return { relay, frames };
}

/**
 * `serve({port:0})` hands back a port, but under the full suite (126 files, many
 * processes binding ports at once) the first connect can still race the listen
 * and come back ECONNREFUSED — which surfaced as two flaky failures that never
 * reproduce when this file runs alone. Wait for the socket, with a clear error
 * if it genuinely never opens (that would be a bind failure, not timing).
 */
async function waitListening(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const socket = await Bun.connect({ hostname: 'localhost', port, socket: { data() {} } });
      socket.end();
      return;
    } catch (e) {
      if (Date.now() >= deadline) {
        throw new Error(`server on port ${port} never accepted a connection: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
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
  return { name: 'stub', type: 'openai-chat', baseUrl, apiKey: 'sk-stub' };
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
              // First frame goes out immediately; the rest arrives 400 ms
              // later. If the gateway buffered, the relay would see nothing at
              // t≈20 ms. 400 ms, not a minimal stall: under the 8-worker suite
              // the forwarding path can be delayed past the sleep's fire time,
              // so the measured decode window (genMs) loses the skew between
              // firstChunkAt and the timer — observed ~90 ms. 400 ms keeps the
              // assertion floor below comfortable.
              c.enqueue(chunkLine({ role: 'assistant', content: 'part-' }));
              return;
            }
            await new Promise((r) => setTimeout(r, 400));
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
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(makeConfig(base), [stubProvider(base)]);
    const { relay, frames } = makeRelaySink();

    try {
      let settled = false;
      const pending = processIR(orchestrator, request('stub/one'), {}, relay).finally(() => {
        settled = true;
      });
      // THE point of the whole change: a byte reaches the client while the turn
      // is still running. Poll instead of sleeping a fixed 20 ms; under the full
      // suite the event loop is busy enough that 20 ms is a coin flip.
      const deadline = Date.now() + 5_000;
      while (frames.length === 0 && !settled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(frames.length >= 1, `expected progressive delivery, got ${frames.length} frames`);
      assert.equal(settled, false, 'the first frame must arrive while the turn is still executing');
      const result = await pending;
      assert.equal(frames.length >= 3, true);
      // The buffered object every consumer reads was rebuilt from those frames.
      assert.equal(chatOf(result.response).choices[0].message.content, 'part-one');
      assert.equal(chatOf(result.response).usage?.completion_tokens, 3);
      assert.equal(result.modelUsed, 'stub/one');
      assert.equal(hits, 1);
      assert.equal(relay.committed, true);
      // The same TTFT/TPS split rides ExecutionResult (→ X-OCR-TTFT-MS /
      // X-OCR-Gen-MS) so a client can derive decode-TPS without reading the
      // trace store.
      assert.ok(typeof result.ttftMs === 'number' && result.ttftMs >= 0);
      assert.ok(result.genMs! >= 100, `result.genMs should cover the 400ms stall, got ${result.genMs}`);
      // Industry TTFT/TPS split on the trace row: ttftMs = process start →
      // first forwarded chunk (user-perceived), genMs = first chunk → drained
      // stream — here the upstream's 60 ms stall must appear in the decode
      // window, NOT in the effective-rate sense. Both are bounded by latencyMs.
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      assert.equal(trace.execution.modelUsed, 'stub/one');
      assert.ok(typeof trace.execution.ttftMs === 'number' && trace.execution.ttftMs >= 0);
      assert.ok(trace.execution.genMs! >= 100, `decode window should cover the 400ms stall, got ${trace.execution.genMs}`);
      assert.ok(trace.execution.ttftMs! <= trace.execution.latencyMs);
      assert.ok(trace.execution.genMs! <= trace.execution.latencyMs);
      // Perceived stall ratio: the two visible chunks ('part-' then 'one')
      // are ~60 ms apart — below the 1 s felt-pause threshold — so a measured
      // turn reports 0 (smooth), never a fabricated pause. The role-only
      // opener and the usage frame neither create nor erase a gap.
      assert.equal(trace.execution.stalledMs, 0, `sub-second gaps are not stalls, got ${trace.execution.stalledMs}`);
    } finally {
      server.stop(true);
    }
  });

  it('reasoning deltas are stream progress — a thinking phase is never one long stall', async () => {
    let pulled = 0;
    const server = serve({
      port: 0,
      async fetch() {
        const stream = new ReadableStream({
          async pull(c) {
            const step = pulled++;
            // Four visible deltas, 400 ms apart: content → reasoning →
            // reasoning → content, then the terminator. A REAL delay is the
            // point: stalled time is measured from Date.now() across a real
            // socket, and fake timers can drive neither Bun's HTTP server nor
            // the gateway's clock (sanctioned integration-test exception).
            // Each hop stays under the 1 s threshold; only IGNORING the
            // reasoning hops would merge them into one ≥1 s pause (1.2 s).
            if (step > 0 && step < 4) {
              const { promise, resolve } = Promise.withResolvers<void>();
              setTimeout(resolve, 400);
              await promise;
            }
            if (step === 0) return c.enqueue(chunkLine({ role: 'assistant', content: 'a' }));
            if (step === 1) return c.enqueue(chunkLine({ reasoning_content: 'think-1' }));
            if (step === 2) return c.enqueue(chunkLine({ reasoning_content: 'think-2' }));
            if (step === 3) return c.enqueue(chunkLine({ content: 'b' }));
            c.enqueue(chunkLine({}, 'stop'));
            c.enqueue('data: [DONE]\n\n');
            c.close();
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(makeConfig(base), [stubProvider(base)]);
    const { relay } = makeRelaySink();

    try {
      await processIR(orchestrator, request('stub/one'), {}, relay);
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      // The relay forwards reasoning verbatim (stream-relay.ts), so the client
      // receives progress during thinking. Counting only content/tool_calls
      // would leave a single 1.2 s gap and count it as stalled time; with
      // reasoning counted, every hop is 400 ms and the turn is smooth.
      assert.equal(
        trace.execution.stalledMs,
        0,
        `reasoning deltas are progress, not a stall; got ${trace.execution.stalledMs}`
      );
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
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const config = makeConfig(base, {
      combos: [{ id: 'pair', selection: 'priority', models: ['stub/one', 'stub/two'] }],
    } as Partial<RouterConfig>);
    const { orchestrator } = boot(config, [stubProvider(base)]);
    const { relay, frames } = makeRelaySink();

    try {
      let rejected = false;
      await processIR(orchestrator, request('pair'), {}, relay).catch(() => {
        rejected = true;
      });
      assert.ok(rejected, 'a broken stream must surface as a failed turn');
      assert.ok(frames.length >= 1, 'the first frame must have been relayed before the break');
      const text = frames.filter((event) => event.type === 'response.output_text.delta');
      assert.equal(text.length, 1, 'only the committed text may have been relayed');
      assert.equal(text[0]?.type === 'response.output_text.delta' ? text[0].text : '', 'halfway');
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
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const config = makeConfig(base, {
      combos: [{ id: 'pair', selection: 'priority', models: ['stub/one', 'stub/two'] }],
    } as Partial<RouterConfig>);
    const { orchestrator } = boot(config, [stubProvider(base)]);
    const { relay, frames } = makeRelaySink();
    try {
      const result = await processIR(orchestrator, request('pair'), {}, relay);
      assert.equal(hits, 2, 'the head-level 5xx must fail over to the next candidate');
      assert.equal(chatOf(result.response).choices[0].message.content, 'second wins');
      assert.equal(result.failoverOccurred, true);
      assert.ok(frames.length >= 1);
    } finally {
      server.stop(true);
    }
  });

  it('a native stream with a JSON fallback still feeds the relay', async () => {
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
            content: [{ type: 'text', text: 'buffered fallback' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    });
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const config = makeConfig(base);
    const providers: ProviderConfig[] = [stubProvider(base), { name: 'stub-a', type: 'anthropic-messages', baseUrl: base, apiKey: 'sk' }];
    (config.models as any[]).push({
      id: 'stub-a/one',
      provider: 'stub-a',
      upstreamModel: 'up-1',
      tier: 'lite',
      priority: 3,
      wire: 'anthropic-messages',
      pricing: { input: 0.1, cacheRead: 0.01, output: 0.2 },
    });
    const { orchestrator } = boot(config, providers);
    const { relay, frames } = makeRelaySink();
    try {
      const result = await processIR(orchestrator, request('stub-a/one'), {}, relay);
      body = JSON.stringify(chatOf(result.response).choices[0].message.content);
      assert.equal(body, JSON.stringify('buffered fallback'));
      assert.ok(frames.some((event) => event.type === 'response.output_text.delta'));
      assert.equal(frames.at(-1)?.type, 'response.completed');
      assert.equal(relay.committed, true);
    } finally {
      server.stop(true);
    }
  });

  it('mock mode ignores the relay (test base stays buffered)', async () => {
    const config = makeConfig('http://localhost:1/v1');
    const registry = new ProviderRegistry(config, true);
    const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
    const { relay, frames } = makeRelaySink();
    const result = await processIR(orchestrator, request('stub/one'), {}, relay);
    assert.ok(chatOf(result.response).choices.length >= 1);
    assert.equal(frames.length, 0);
  });

  it('a buffered-posture (streaming.upstream.mode: buffered) turn records no ttftMs/genMs — no synthesized decode rate', async () => {
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
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    applyStreamingPosture({ upstream: { mode: 'buffered' } });
    const { orchestrator } = boot(makeConfig(base), [stubProvider(base)]);
    try {
      const result = await processIR(orchestrator, request('stub/one', false), {}, undefined);
      assert.equal(chatOf(result.response).choices[0].message.content, 'buffered');
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      assert.equal(trace.execution.ttftMs, undefined);
      assert.equal(trace.execution.genMs, undefined);
    } finally {
      server.stop(true);
    }
  });

  it('under the stream default, a JSON-client turn against a JSON-answer upstream still streams (synthetic single chunk)', async () => {
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
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    applyStreamingPosture({ upstream: { mode: 'stream' } });
    const { orchestrator } = boot(makeConfig(base), [stubProvider(base)]);
    try {
      const result = await processIR(orchestrator, request('stub/one', false), {}, undefined);
      assert.equal(chatOf(result.response).choices[0].message.content, 'buffered');
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      // The upstream leg ran through the relay (one synthetic chunk), so the
      // TTFT pair IS stamped — the upstreamStream tag records it.
      assert.equal(trace.execution.upstreamStream, 'sse');
      assert.equal(typeof trace.execution.ttftMs, 'number');
      // No proxy is initialized in this process: the served dial went direct.
      assert.equal(trace.execution.egress, 'direct');
      assert.equal(trace.execution.egressProxy, undefined);
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
            // A ReadableStream pulls EAGERLY: this sleep can start before the
            // consumer has forwarded the first chunk, so genMs (first forwarded
            // chunk → stream drained) may be shorter than the sleep itself.
            await new Promise((r) => setTimeout(r, 150));
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
    return { server, plusHits, liteHits: () => liteHits, ready: waitListening(server.port) };
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
    const { server, plusHits, liteHits, ready } = cascadeServer();
    await ready;
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(cascadeConfig(base), [stubProvider(base)]);
    const { relay, frames, staged } = makeFactsSink();
    try {
      const result = await processIR(orchestrator, schemaRequest(), {}, relay);
      // The lite attempt ran and failed the assertion; the escalation served.
      assert.equal(liteHits(), 1);
      assert.equal(result.fallbackOccurred, true);
      assert.ok(result.fallbackReason?.includes('not valid JSON'));
      assert.equal(result.tierUsed, 'plus');
      assert.equal(chatOf(result.response).choices[0].message.content, '{"ok":"yes"}');
      // THE fix: the escalation output reached the relay progressively.
      assert.ok(frames.length >= 2, `expected relayed frames, got ${frames.length}`);
      assert.equal(relay.committed, true);
      assert.equal(plusHits.length, 1, 'post-commit failure would re-issue; a clean stream hits once');
      // Trace: the industry TTFT/TPS split must now exist for cascade turns.
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.ok(trace, 'the turn must be traced');
      assert.equal(trace.execution.modelUsed, 'stub/plus');
      assert.ok(typeof trace.execution.ttftMs === 'number' && trace.execution.ttftMs >= 0);
      assert.ok(trace.execution.genMs! >= 100, `decode window should cover the 150ms stall, got ${trace.execution.genMs}`);
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
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(cascadeConfig(base), [stubProvider(base)]);
    const { relay, frames } = makeFactsSink();
    try {
      const result = await processIR(orchestrator, schemaRequest(), {}, relay);
      assert.equal(result.fallbackOccurred, false);
      assert.equal(result.tierUsed, 'lite');
      assert.equal(chatOf(result.response).choices[0].message.content, '{"ok":"valid"}');
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

  it('upstream.mode: buffered rolls the escalation leg back to a buffered call', async () => {
    const { server, plusHits, ready } = cascadeServer();
    await ready;
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(cascadeConfig(base), [stubProvider(base)]);
    const { relay, frames } = makeFactsSink();
    applyStreamingPosture({ upstream: { mode: 'buffered' } });
    try {
      const result = await processIR(orchestrator, schemaRequest(), {}, relay);
      assert.equal(result.fallbackOccurred, true);
      assert.equal(result.tierUsed, 'plus');
      assert.equal(chatOf(result.response).choices[0].message.content, '{"ok":"yes"}');
      assert.equal(frames.length, 0, 'the rollback switch must keep the escalation leg buffered too');
      assert.equal(plusHits.length, 1);
      assert.equal(result.upstreamStream, 'buffered');
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
      assert.equal(trace?.execution.ttftMs, undefined);
      assert.equal(trace?.execution.genMs, undefined);
      assert.equal(trace?.execution.upstreamStream, 'buffered');
    } finally {
      resetStreamingPostureForTests();
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
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(cascadeConfig(base), [stubProvider(base)]);
    const { relay, frames } = makeFactsSink();
    try {
      let rejected = false;
      await processIR(orchestrator, schemaRequest(), {}, relay).catch(() => {
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

describe('upstream transport axis (streaming.upstream.mode — ADR-0008 §1)', () => {
  const askRequest = (model: string, stream: boolean) =>
    ({ model, messages: [{ role: 'user', content: 'hi' }], stream }) as any;

  /** Fake provider that records the `stream` flag it was asked for. */
  function sseServer(sent: boolean[]) {
    return serve({
      port: 0,
      async fetch(req) {
        const body = JSON.parse(await req.text()) as { stream?: unknown };
        sent.push(body.stream === true);
        if (body.stream !== true) {
          // A buffered caller gets a buffered answer: an SSE body would be a
          // protocol lie and the adapter would (correctly) fail to parse it.
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-acc',
              object: 'chat.completion',
              created: 1,
              model: 'up-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'buf-answer' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(chunkLine({ role: 'assistant', content: 'acc-' }));
            c.enqueue(chunkLine({ content: 'answer' }));
            c.enqueue(chunkLine({}, 'stop'));
            c.enqueue(
              `data: ${JSON.stringify({
                id: 'chatcmpl-acc',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'up-1',
                choices: [],
                usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
              })}\n\n`
            );
            c.enqueue('data: [DONE]\n\n');
            c.close();
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
  }

  it('stream: a JSON client is served the upstream SSE reader, accumulated, and tagged on both legs', async () => {
    const sent: boolean[] = [];
    const server = sseServer(sent);
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(makeConfig(base), [stubProvider(base)]);
    applyStreamingPosture({ upstream: { mode: 'stream' } });
    try {
      // No relay: this is the shape a stream:false client turns into.
      const result = await processIR(orchestrator, askRequest('stub/one', false), {});

      assert.deepEqual(sent, [true], 'the provider leg must be asked for SSE');
      assert.equal(chatOf(result.response).choices[0]!.message.content, 'acc-answer', 'chunks accumulated into one response');
      assert.equal(chatOf(result.response).usage?.completion_tokens, 2, 'the usage frame survives accumulation');
      assert.equal(result.clientStream, false, 'inbound tag: the client got JSON');
      assert.equal(result.upstreamStream, 'sse', 'outbound tag: the provider leg streamed');
      assert.ok(typeof result.ttftMs === 'number', 'ttft is measured in accumulate mode');
      const trace = orchestrator.getTraceTracker().getRecentTraces().data[0]!;
      assert.equal(trace.execution.upstreamStream, 'sse');
      assert.equal(trace.request.clientStream, false);
    } finally {
      resetStreamingPostureForTests();
      server.stop(true);
    }
  });

  it('follow: a JSON client stays on the buffered provider call (historical behavior)', async () => {
    const sent: boolean[] = [];
    const server = sseServer(sent);
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(makeConfig(base), [stubProvider(base)]);
    applyStreamingPosture({ upstream: { mode: 'follow' } });
    try {
      const result = await processIR(orchestrator, askRequest('stub/one', false), {});
      assert.deepEqual(sent, [false], 'no relay on a JSON client → a non-streaming provider call');
      assert.equal(result.upstreamStream, 'buffered');
      assert.equal(result.ttftMs, undefined, 'buffered legs keep no TTFT split');
    } finally {
      resetStreamingPostureForTests();
      server.stop(true);
    }
  });
});

describe('SSE idle watchdog (DEFAULT_STREAM_IDLE_TIMEOUT_MS)', () => {
  it('aborts a stream that goes completely silent, and says why', async () => {
    // One frame, then silence forever. Without the watchdog this turn would
    // sit until the two-hour wall clock; with it, the idle bound decides.
    const server = serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          async start(c) {
            c.enqueue(chunkLine({ role: 'assistant', content: 'thinking' }));
            await new Promise(() => {}); // never resolves, never closes
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(makeConfig(base), [{ ...stubProvider(base), streamIdleTimeoutMs: 120 }]);
    const { relay } = makeRelaySink();
    try {
      const started = Date.now();
      const error = await processIR(orchestrator, request('stub/one', true), {}, relay).then(
        () => null,
        (err: Error) => err
      );
      assert.ok(error, 'a silent stream must not resolve successfully');
      assert.match(error.message, /idle for 120ms/i, `expected the idle message, got: ${error.message}`);
      assert.ok(Date.now() - started < 10_000, 'the idle bound, not the wall clock, must fire');
    } finally {
      server.stop(true);
    }
  });
});

describe('streamed wall-clock cap (DEFAULT_STREAM_TIMEOUT_MS)', () => {
  it('aborts a stream that keeps trickling bytes past its cap', async () => {
    // Progress every 40 ms → the idle watchdog can never fire; only the
    // streamed wall clock can end this turn. A runaway loop looks exactly like
    // this, which is what the cap exists for.
    const server = serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          async start(c) {
            // Real platform timers on purpose: this is the fake PROVIDER's own
            // wire behavior (bytes arriving over a socket), so fake timers
            // cannot drive it — the watchers live in the client under test.
            for (;;) {
              c.enqueue(chunkLine({ content: '.' }));
              await Bun.sleep(40);
            }
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    await waitListening(server.port);
    const base = `http://localhost:${server.port}/v1`;
    const { orchestrator } = boot(makeConfig(base), [{ ...stubProvider(base), streamTimeoutMs: 150 }]);
    const { relay } = makeRelaySink();
    try {
      const started = Date.now();
      const error = await processIR(orchestrator, request('stub/one', true), {}, relay).then(
        () => null,
        (err: Error) => err
      );
      assert.ok(error, 'a runaway stream must not resolve successfully');
      assert.ok(Date.now() - started < 3_000, 'the cap, not the idle watchdog, must fire');
    } finally {
      server.stop(true);
    }
  });
});
