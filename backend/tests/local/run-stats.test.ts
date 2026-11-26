/**
 * Per-run request accounting (ADR-0040 §2–3).
 *
 * The seam is the `local` provider decorator: it is the one place that knows
 * WHICH run answers and what the request cost. These tests drive the decorator
 * itself — not the stats module in isolation — because the contract that
 * matters is "a request through the gateway lands as exactly one counted
 * request on the right run, on BOTH the buffered and the streamed leg".
 */
import '../helpers/sandbox-home.js';
import { describe, expect, test, beforeEach } from 'bun:test';
import type { ModelRegistration } from '../../src/config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../../src/ir/types.js';
import { LocalDialProvider } from '../../src/local/local-provider.js';
import {
  allStats,
  beginRequest,
  completeRequest,
  failRequest,
  resetStatsForTests,
  statsFor,
} from '../../src/local/run-stats.js';

const RUN_ID = 'run-test-1';

/** A model registration shaped the way the local pool builds it. */
const MODEL: ModelRegistration = {
  id: `local/${RUN_ID}`,
  provider: 'local',
  upstreamModel: RUN_ID,
  pricing: { input: 0, output: 0, cacheRead: 0 },
  wire: 'openai-chat',
};

function responseWith(usage: Partial<CanonicalResponse['usage']>): CanonicalResponse {
  return {
    status: 'completed',
    output: [],
    usage: { inputTokens: 0, outputTokens: 0, ...usage },
  };
}

describe('run-stats counters', () => {
  beforeEach(() => resetStatsForTests());

  test('a fresh run reports a blank row rather than throwing', () => {
    const row = statsFor('never-served');
    expect(row.requests).toBe(0);
    expect(row.inFlight).toBe(0);
    expect(row.ttftMs).toBeNull();
    expect(row.decodeTps).toBeNull();
  });

  test('in-flight rises on entry and falls on completion', () => {
    const mark = beginRequest(RUN_ID);
    expect(statsFor(RUN_ID).inFlight).toBe(1);
    completeRequest(RUN_ID, mark, { inputTokens: 10, outputTokens: 20 }, { streamed: true });
    expect(statsFor(RUN_ID).inFlight).toBe(0);
    expect(statsFor(RUN_ID).requests).toBe(1);
  });

  test('a failed request releases its slot — a leaked gauge would climb forever', () => {
    const mark = beginRequest(RUN_ID);
    failRequest(RUN_ID, mark, new Error('upstream died'));
    const row = statsFor(RUN_ID);
    expect(row.inFlight).toBe(0);
    expect(row.errors).toBe(1);
    expect(row.requests).toBe(0);
  });

  test('token totals accumulate across requests', () => {
    completeRequest(RUN_ID, beginRequest(RUN_ID), { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 }, { streamed: true });
    completeRequest(RUN_ID, beginRequest(RUN_ID), { inputTokens: 200, outputTokens: 70, cachedInputTokens: 0 }, { streamed: true });
    const row = statsFor(RUN_ID);
    expect(row.inputTokens).toBe(300);
    expect(row.outputTokens).toBe(120);
    expect(row.cachedInputTokens).toBe(20);
    expect(row.requests).toBe(2);
  });

  test('a buffered leg flags itself instead of passing its TTFT off as a first-token wait', () => {
    completeRequest(RUN_ID, beginRequest(RUN_ID), { outputTokens: 5 }, { streamed: false });
    const row = statsFor(RUN_ID);
    expect(row.bufferedOnly).toBe(true);
    expect(row.ttftMs?.samples).toBe(1);
    // No decode window without a first delta — no fabricated rate.
    expect(row.decodeTps).toBeNull();
  });

  test('concurrent requests on one run settle to zero, never negative', () => {
    const a = beginRequest(RUN_ID);
    const b = beginRequest(RUN_ID);
    expect(statsFor(RUN_ID).inFlight).toBe(2);
    completeRequest(RUN_ID, a, { outputTokens: 1 }, { streamed: true });
    // Settling the same mark twice must not double-decrement.
    completeRequest(RUN_ID, a, { outputTokens: 1 }, { streamed: true });
    expect(statsFor(RUN_ID).inFlight).toBe(1);
    failRequest(RUN_ID, b);
    expect(statsFor(RUN_ID).inFlight).toBe(0);
  });
});

describe('the decorator is the accounting seam', () => {
  beforeEach(() => resetStatsForTests());

  test('both legs report to the same counters (one accounting plane)', async () => {
    const provider = new LocalDialProvider();
    const inner = {
      createCompletion: async (): Promise<CanonicalResponse> =>
        responseWith({ inputTokens: 7, outputTokens: 11 }),
      createStream: async (): Promise<AsyncIterable<StreamEvent>> =>
        (async function* () {
          yield { type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'hi' } as StreamEvent;
          yield { type: 'response.usage', usage: { inputTokens: 3, outputTokens: 4 } } as StreamEvent;
        })(),
    };
    // The decorator resolves its inner executor from the run's base; stub it so
    // this test exercises accounting, not dialing.
    (provider as unknown as { innerAt: () => typeof inner }).innerAt = () => inner;
    (provider as unknown as { baseline: () => string }).baseline = () => 'http://127.0.0.1:1/v1';

    const request = { messages: [] } as unknown as CanonicalRequest;

    const buffered = await provider.createCompletion(request, MODEL);
    expect(buffered.usage.outputTokens).toBe(11);

    const stream = await provider.createStream(request, MODEL);
    for await (const _event of stream) {
      // drain
    }

    // Both legs landed on the SAME run id's counters.
    const rows = [...allStats().values()];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.requests).toBe(2);
    expect(row.outputTokens).toBe(15);
    expect(row.inFlight).toBe(0);
  });

  test('an aborted stream still settles its gauge', async () => {
    const provider = new LocalDialProvider();
    const inner = {
      createStream: async (): Promise<AsyncIterable<StreamEvent>> =>
        (async function* () {
          yield { type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'a' } as StreamEvent;
          yield { type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'b' } as StreamEvent;
        })(),
    };
    (provider as unknown as { innerAt: () => typeof inner }).innerAt = () => inner;
    (provider as unknown as { baseline: () => string }).baseline = () => 'http://127.0.0.1:1/v1';

    const stream = await provider.createStream({ messages: [] } as unknown as CanonicalRequest, MODEL);
    // Break out early — the consumer went away mid-stream.
    for await (const _event of stream) break;

    const row = [...allStats().values()][0]!;
    expect(row.inFlight).toBe(0);
    expect(row.requests).toBe(1);
  });

  test('a failing request counts as an error, not as traffic', async () => {
    const provider = new LocalDialProvider();
    const inner = {
      createCompletion: async (): Promise<CanonicalResponse> => {
        throw new Error('engine said no');
      },
    };
    (provider as unknown as { innerAt: () => typeof inner }).innerAt = () => inner;
    (provider as unknown as { baseline: () => string }).baseline = () => 'http://127.0.0.1:1/v1';

    await expect(provider.createCompletion({ messages: [] } as unknown as CanonicalRequest, MODEL)).rejects.toThrow(
      'engine said no'
    );
    const row = [...allStats().values()][0]!;
    expect(row.errors).toBe(1);
    expect(row.requests).toBe(0);
    expect(row.inFlight).toBe(0);
  });
});