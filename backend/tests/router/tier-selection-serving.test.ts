import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import type { RouterConfig } from '../../src/config/types.js';
import type { TierMemberRule } from '../../src/config/types.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import { processIR } from '../helpers/ir.js';
import type { ChatCompletionRequest } from '../../src/types/openai.js';

/**
 * End-to-end lock for TIER selection: the strategy pick must decide the model
 * the request path actually SERVES, not just a registry getter.
 *
 * The chain-head pick is exercised through a forced tier (`auto` +
 * router_options.force_tier) — the same serving path a stateless session
 * takes: no session pin is read, so every request draws exactly one pick from
 * the strategy cursor and the drawn model must lead the executed chain.
 *
 * Before this lock the auto chain was `[pool[0], ...]` whenever no pin was
 * present, so every non-priority strategy was inert here (weighted 3:1 served
 * the same head forever) even though `getModelForTier` rotated correctly.
 */

const makeConfig = (plusMembers: TierMemberRule[], selection?: RouterConfig['tiers']['plus']['selection']): RouterConfig => ({
  port: 3000,
  host: '127.0.0.1',
  baselineModel: 'plus-1',
  fallback: {
    enabled: false,
    maxRetries: 1,
    escalateTier: 'plus',
    injectErrorContext: false,
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
  },
  retry: {
    enabled: true,
    inplace: { enabled: true, maxAttempts: 1, backoffMs: 10, jitterMs: 5 },
    failover: { enabled: true, maxAttempts: 3, tierCrossPolicy: 'allow_escalate' },
  },
  models: [
    {
      id: 'plus-1',
      provider: 'mock',
      upstreamModel: 'plus-1',
      tier: 'plus',
      priority: 1,
      isDefaultInTier: true,
      pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
    },
    {
      id: 'plus-2',
      provider: 'mock',
      upstreamModel: 'plus-2',
      tier: 'plus',
      priority: 2,
      pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
    },
  ],
  tiers: {
    plus: { selection, members: plusMembers },
  },
});

async function serveWith(
  registry: ProviderRegistry,
  orchestrator: PipelineOrchestrator,
  turns: number
): Promise<string[]> {
  const served: string[] = [];
  for (let i = 0; i < turns; i++) {
    const request: ChatCompletionRequest & Record<string, unknown> = {
      model: 'auto',
      messages: [{ role: 'user', content: `turn ${i}` }],
      router_options: { force_tier: 'plus' },
    };
    const result = await processIR(orchestrator, request);
    assert.equal(result.failoverOccurred, false, `turn ${i} unexpectedly failed over`);
    assert.deepEqual(result.failoverPath, [result.modelUsed], `turn ${i} tried more than the leader`);
    served.push(result.modelUsed!);
  }
  return served;
}

async function servePlus(config: RouterConfig, turns: number): Promise<string[]> {
  const registry = new ProviderRegistry(config, true);
  // Hermetic: the lazy disk replay would replace `tierPolicies` with the
  // developer's config.yaml and drop the test's selection strategy.
  registry.setAutoRefreshMembers(false);
  return serveWith(registry, new PipelineOrchestrator(config, registry, new FinOpsTracker()), turns);
}

describe('tier selection decides the served model (end-to-end)', () => {
  it('weighted_round_robin rotates the executed chain 3:1', async () => {
    const served = await servePlus(
      makeConfig([{ pattern: 'plus-1', weight: 3 }, { pattern: 'plus-2' }], 'weighted_round_robin'),
      4,
    );
    assert.deepEqual(served, ['plus-1', 'plus-1', 'plus-2', 'plus-1']);
  });

  it('round_robin alternates the executed chain even with declared weights', async () => {
    const served = await servePlus(
      makeConfig([{ pattern: 'plus-1', weight: 3 }, { pattern: 'plus-2' }], 'round_robin'),
      4,
    );
    assert.deepEqual(served, ['plus-1', 'plus-2', 'plus-1', 'plus-2']);
  });

  it('priority serves the chain head, and weight orders that chain', async () => {
    const served = await servePlus(
      makeConfig([{ pattern: 'plus-2', weight: 5 }, { pattern: 'plus-1' }], 'priority'),
      3,
    );
    assert.deepEqual(served, ['plus-2', 'plus-2', 'plus-2']);
  });

  it('a one-member pool serves it on every turn (no rotation state needed)', async () => {
    const config = makeConfig([{ pattern: 'plus-1' }], 'weighted_round_robin');
    // Hand-configured models join their explicit tier even without a claim,
    // so drop plus-2 to make the pool truly single-member.
    config.models = config.models!.filter((m) => m.id !== 'plus-2');
    const served = await servePlus(config, 3);
    assert.deepEqual(served, ['plus-1', 'plus-1', 'plus-1']);
  });

  it('stateless sessions draw exactly once per request (no pin, no extra effort pick)', async () => {
    // No stored pin → the placeholder pick leads the chain. The no-effort
    // effort pass-through must not touch the cursor a second time; before
    // that fix the served sequence sampled every second draw and 3:1 looked
    // like 1:1.
    const config = makeConfig([{ pattern: 'plus-1', weight: 3 }, { pattern: 'plus-2' }], 'weighted_round_robin');
    config.session = { enabled: true, strategy: 'stateless' };
    const served = await servePlus(config, 4);
    assert.deepEqual(served, ['plus-1', 'plus-1', 'plus-2', 'plus-1']);
  });

  it('a fully-tripped tier does not consume an extra draw per request', async () => {
    // Stateless + every member circuit-tripped: the chain force-tries its LAST
    // candidate, but the discarded ratchet representative must NOT advance the
    // rotation cursor — that would burn two picks for one request and shift
    // every later draw once the tier recovers.
    const config = makeConfig([{ pattern: 'plus-1', weight: 3 }, { pattern: 'plus-2' }], 'weighted_round_robin');
    config.session = { enabled: true, strategy: 'stateless' };
    const registry = new ProviderRegistry(config, true);
    registry.setAutoRefreshMembers(false);
    const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
    const cb = registry.getCircuitBreakerManager();
    for (const id of ['plus-1', 'plus-2']) cb.trip(id, { reason: 'test outage', cooldownMs: 3_600_000 });
    const request: ChatCompletionRequest & Record<string, unknown> = {
      model: 'auto',
      messages: [{ role: 'user', content: 'tripped turn' }],
      router_options: { force_tier: 'plus' },
    };
    await processIR(orchestrator, request);
    for (const id of ['plus-1', 'plus-2']) cb.getPairBreaker(id, '')!.reset();
    // 3:1 SWRR is a,a,b,a — exactly ONE consumed pick makes the next three
    // a,b,a. A double advance during the tripped turn would serve b,a,a.
    const served = await serveWith(registry, orchestrator, 3);
    assert.deepEqual(served, ['plus-1', 'plus-2', 'plus-1']);
  });
});
