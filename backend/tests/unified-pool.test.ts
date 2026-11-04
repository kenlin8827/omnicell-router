import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterConfig } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { SessionManager } from '../src/session/session-manager.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import { ErrorClassifier, UpstreamError } from '../src/resilience/index.js';

// ─── Shared fixtures ────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<RouterConfig>): RouterConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    baselineModel: 'plus-1',
    fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
    circuitBreaker: { enabled: true, failureThreshold: 3 },
    retry: {
      enabled: true,
      inplace: { enabled: true, maxAttempts: 1, backoffMs: 10, jitterMs: 5 },
      failover: { enabled: true, maxAttempts: 2, tierCrossPolicy: 'allow_escalate' },
    },
    models: [
      { id: 'lite-1', provider: 'mock', upstreamModel: 'lite-1', tier: 'lite', priority: 1, isDefaultInTier: true, pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 } },
      { id: 'lite-2', provider: 'mock', upstreamModel: 'lite-2', tier: 'lite', priority: 2, pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 } },
      { id: 'lite-3', provider: 'mock', upstreamModel: 'lite-3', tier: 'lite', priority: 3, pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 } },
      { id: 'plus-1', provider: 'mock', upstreamModel: 'plus-1', tier: 'plus', priority: 1, isDefaultInTier: true, pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 } },
      { id: 'pro-1', provider: 'mock', upstreamModel: 'pro-1', tier: 'pro', priority: 1, isDefaultInTier: true, pricing: { input: 15.0, cacheRead: 3.75, output: 60.0 } },
    ],
    ...overrides,
  };
}

function makeOrchestrator(config: RouterConfig) {
  const registry = new ProviderRegistry(config, true);
  const tracker = new FinOpsTracker();
  const orchestrator = new PipelineOrchestrator(config, registry, tracker);
  return { registry, orchestrator };
}

// ─── P1① All-OPEN pool: last candidate force-tried, pool never zero-try ────

describe('Unified pool: last-candidate force-try', () => {
  it('should force-try the last combo member even when every member is pre-tripped', async () => {
    const config = makeConfig({
      combos: [{ id: 'combo-all-down', selection: 'priority', models: ['lite-1', 'lite-2'] }],
    });
    const { registry, orchestrator } = makeOrchestrator(config);
    const cb = registry.getCircuitBreakerManager();
    cb.trip('lite-1', { reason: 'pre-tripped', cooldownMs: 3600000 });
    cb.trip('lite-2', { reason: 'pre-tripped', cooldownMs: 3600000 });

    // Mock upstream is actually healthy — force-trying the last candidate
    // must succeed instead of failing with zero attempts.
    const result = await orchestrator.process({
      model: 'combo-all-down',
      messages: [{ role: 'user', content: 'Force try' }],
    } as any);

    assert.equal(result.modelUsed, 'lite-2');
    assert.equal(result.failoverAttempts, 1);
    assert.deepEqual(result.failoverPath, ['lite-2']);
  });

  it('should force-try the last tier candidate under same_tier_only when the tier is fully down', async () => {
    const config = makeConfig({
      retry: {
        enabled: true,
        inplace: { enabled: true, maxAttempts: 1, backoffMs: 10, jitterMs: 5 },
        failover: { enabled: true, maxAttempts: 3, tierCrossPolicy: 'same_tier_only' },
      },
    });
    const { registry, orchestrator } = makeOrchestrator(config);
    const cb = registry.getCircuitBreakerManager();
    for (const id of ['lite-1', 'lite-2', 'lite-3']) {
      cb.trip(id, { reason: 'pre-tripped', cooldownMs: 3600000 });
    }

    const result = await orchestrator.process({
      model: 'lite',
      messages: [{ role: 'user', content: 'Force try tier' }],
    } as any);

    // lite-1/lite-2 skipped (untried candidates remain), lite-3 force-tried as last
    assert.equal(result.modelUsed, 'lite-3');
    assert.deepEqual(result.failoverPath, ['lite-3']);
  });
});

// ─── P1② peek/consume split: HALF_OPEN never starved by dry checks ─────────

describe('Unified breaker gate: peek vs consume', () => {
  it('isAvailable (peek) must NOT consume HALF_OPEN probe quota', async () => {
    const registry = new ProviderRegistry(makeConfig(), true);
    const cb = registry.getCircuitBreakerManager();
    cb.recordSuccessScoped('lite-1'); // materialize the sentinel tuple (a manual manager trip clamps to 1000ms)
    const breaker = cb.getPairBreaker('lite-1', '')!;
    breaker.trip('simulated outage', 'SERVICE_UNAVAILABLE', 60); // 60ms cooldown
    await new Promise(r => setTimeout(r, 90)); // cooldown expires → next check flips HALF_OPEN

    // First check transitions OPEN → HALF_OPEN (no slot consumed by peek)
    assert.equal(cb.isAvailable('lite-1'), true);
    assert.equal(breaker.getState(), 'HALF_OPEN');

    // Hammer the peek path (pool filters, self-healing, leader picks…) —
    // quota must remain intact for the single execution gate.
    for (let i = 0; i < 20; i++) {
      assert.equal(cb.isAvailable('lite-1'), true);
      registry.getCandidateModelsForTier('lite', true);
    }
    assert.equal(breaker.getSnapshot().state, 'HALF_OPEN');
    assert.equal(breaker.canExecute().allowed, true); // the gate consumes here
    assert.equal(breaker.canExecute().allowed, false); // quota exhausted for concurrent request
  });

  it('should recover a HALF_OPEN model end-to-end: dry checks + canary success close the circuit', async () => {
    const config = makeConfig({
      combos: [{ id: 'combo-recover', selection: 'priority', models: ['lite-1', 'lite-2'] }],
    });
    const { registry, orchestrator } = makeOrchestrator(config);
    const cb = registry.getCircuitBreakerManager();
    cb.recordSuccessScoped('lite-1'); // materialize the sentinel tuple (manual-trip clamp bypassed below)
    cb.getPairBreaker('lite-1', '')!.trip('simulated outage', 'SERVICE_UNAVAILABLE', 60);
    await new Promise(r => setTimeout(r, 90));

    // Request 1: canary via combo leader position — dry checks must not have
    // eaten the probe; canary succeeds → CLOSED.
    const r1 = await orchestrator.process({
      model: 'combo-recover',
      messages: [{ role: 'user', content: 'Recovery probe' }],
    } as any);
    assert.equal(r1.modelUsed, 'lite-1');
    assert.equal(cb.getPairBreaker('lite-1', '')?.getState(), 'CLOSED');

    // Request 2: fully healthy again — normal serving.
    const r2 = await orchestrator.process({
      model: 'combo-recover',
      messages: [{ role: 'user', content: 'After recovery' }],
    } as any);
    assert.equal(r2.modelUsed, 'lite-1');
  });

  it('should release the canary slot when the probe fails with a non-penalty error (400)', () => {
    const cb = new CircuitBreakerManager({ enabled: true, failureThreshold: 3, initialCooldownMs: 30 });
    cb.registerModel({ id: 'm1', provider: 'mock', upstreamModel: 'm1', tier: 'lite', pricing: { input: 1, output: 1, cacheRead: 0 } });
    cb.recordSuccessScoped('m1'); // materialize the sentinel tuple (a manual manager trip clamps to 1000ms)
    const breaker = cb.getPairBreaker('m1', '')!;
    breaker.trip('simulated outage', 'SERVICE_UNAVAILABLE', 30);

    // Transition to HALF_OPEN (cooldown 30ms → wait)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(breaker.canExecute().allowed, true); // gate consumed the slot
        const diagnosis = ErrorClassifier.classify(
          new UpstreamError({ message: 'context_length_exceeded', status: 400, modelId: 'm1' }),
          'm1', 'mock'
        );
        assert.equal(diagnosis.shouldTripBreaker, false);
        cb.recordFailure('m1', diagnosis, 'mock');
        // Slot released — the breaker can accept another canary instead of sticking.
        assert.equal(breaker.getState(), 'HALF_OPEN');
        assert.equal(breaker.canExecute().allowed, true);
        resolve();
      }, 60);
    });
  });
});

// ─── P2③ explicit requests: never rewritten by the session ratchet ─────────

describe('Unified session modes: explicit wins', () => {
  it('applyRatchet(allowIntercept=false) must NOT rewrite a lower proposed tier but must still escalate a higher one', () => {
    const sm = new SessionManager({ enabled: true, strategy: 'monotonic' });
    const resolve = (tier: string) => ({ id: `${tier}-model`, provider: 'mock', tier, pricing: { input: 1, output: 1 } } as any);

    const mkDecision = (tier: any): any => ({
      targetTier: tier, confidence: 1, reason: 'test',
      needsSchemaValidation: false,
      features: { tokenCountEstimate: 0, hasCode: false, hasMathOrProof: false, hasMultiTurn: false, hasToolsOrSchema: false, complexityScore: 0 },
    });

    sm.applyRatchet('s1', mkDecision('pro'), resolve); // ceiling = pro
    const explicitFast = sm.applyRatchet('s1', mkDecision('lite'), resolve, { allowIntercept: false });
    assert.equal(explicitFast.finalDecision.targetTier, 'lite'); // NOT rewritten
    assert.equal(explicitFast.session.maxTier, 'pro'); // ceiling preserved

    const autoFast = sm.applyRatchet('s1', mkDecision('lite'), resolve); // default: intercepted
    assert.equal(autoFast.finalDecision.targetTier, 'pro'); // downgrade intercepted as before
  });

  it('explicit-model requests should run the named model inside a high-ceiling session (no silent override)', async () => {
    const config = makeConfig();
    const { orchestrator } = makeOrchestrator(config);

    // Turn 1: auto request into the highest tier — session ceiling = pro.
    // Turn 2 extends the REAL chain (captured assistant content) so zero-header
    // resolution maps both turns to the same session.
    const baseMessages = [{ role: 'user', content: 'Raise the ceiling' }];
    const r1 = await orchestrator.process({ model: 'pro', messages: baseMessages } as any);
    const messages = [
      ...baseMessages,
      { role: 'assistant', content: r1.response!.choices[0]!.message!.content },
      { role: 'user', content: 'now explicit lite' },
    ];

    const result = await orchestrator.process({ model: 'lite-1', messages } as any);

    assert.equal(result.sessionId, r1.sessionId); // same session, high ceiling
    assert.equal(result.modelUsed, 'lite-1'); // exactly this model — no ratchet override
    assert.equal(result.tierUsed, 'lite');
  });

  it('explicit-model success should write the pin back within the ceiling tier', async () => {
    const config = makeConfig();
    const { orchestrator } = makeOrchestrator(config);

    // Turn 1 pins the tier default (lite-1); turn 2 explicitly names the
    // SECONDARY lite model on the SAME session (real chain plugin).
    const baseMessages = [{ role: 'user', content: 'Session start' }];
    const r1 = await orchestrator.process({ model: 'lite', messages: baseMessages } as any);
    const before = (orchestrator.getSessionManager() as any).sessions.get(r1.sessionId);
    assert.equal(before.maxTier, 'lite');
    assert.equal(before.pinnedModel, 'lite-1');

    const messages = [
      ...baseMessages,
      { role: 'assistant', content: r1.response!.choices[0]!.message!.content },
      { role: 'user', content: 'switch to lite-2' },
    ];
    const result = await orchestrator.process({ model: 'lite-2', messages } as any);
    assert.equal(result.sessionId, r1.sessionId);
    assert.equal(result.modelUsed, 'lite-2');

    const after = (orchestrator.getSessionManager() as any).sessions.get(r1.sessionId);
    assert.equal(after.pinnedModel, 'lite-2'); // pin migrated to the explicit choice
    assert.equal(after.maxTier, 'lite');
  });
});

// ─── 429 hard-trip: explicit Retry-After trusted, recovery at expiry ────────

describe('429 hard-trip with explicit Retry-After', () => {
  it('should hard-trip immediately for Retry-After 45s and recover via canary after expiry', async () => {
    const config = makeConfig();
    const { registry, orchestrator } = makeOrchestrator(config);

    const result = await orchestrator.process({
      model: 'lite',
      messages: [{ role: 'user', content: 'Hit the limit' }],
      __simulate_error_model__: 'lite-1',
      __simulate_status__: 429,
      __simulate_retry_after__: 45,
      __simulate_message__: 'Rate limit reached',
    } as any);

    // First 429 → immediate hard trip (no 3-strike accumulation) + failover
    assert.equal(result.modelUsed, 'lite-2');
    const breaker = registry.getCircuitBreakerManager().getPairBreaker('lite-1', '')!;
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.getSnapshot().category, 'RATE_LIMITED');

    // Cooldown = Retry-After (45s) — simulate expiry via a short manual trip cycle:
    // reset then re-trip briefly to prove the canary path closes it.
    breaker.reset();
    breaker.trip('simulated rate limit', 'RATE_LIMITED', 60);
    await new Promise(r => setTimeout(r, 90));

    const r2 = await orchestrator.process({
      model: 'lite',
      messages: [{ role: 'user', content: 'After cooldown' }],
    } as any);
    assert.equal(r2.modelUsed, 'lite-1'); // canary succeeded → recovered
    assert.equal(breaker.getState(), 'CLOSED');
  });
});

// ─── P2④ combo chains are never truncated by failover.maxAttempts ──────────

describe('Unified attempt cap: explicit/combo use chain length', () => {
  it('should walk a 3-member combo chain past the configured failover cap of 2', async () => {
    const config = makeConfig({
      combos: [{ id: 'combo-long', selection: 'priority', models: ['lite-1', 'lite-2', 'lite-3'] }],
    });
    const { orchestrator } = makeOrchestrator(config);

    const result = await orchestrator.process({
      model: 'combo-long',
      messages: [{ role: 'user', content: 'Deep failover' }],
      __simulate_error_model__: 'lite-1',
      __simulate_status__: 402,
      __simulate_message__: 'insufficient_quota',
    } as any);
    assert.equal(result.modelUsed, 'lite-2');
    assert.deepEqual(result.failoverPath, ['lite-1', 'lite-2']);

    // Both first members hard-down (402 trips them) → third must still serve
    const result2 = await orchestrator.process({
      model: 'combo-long',
      messages: [{ role: 'user', content: 'Deeper failover' }],
      __simulate_error_model__: 'lite-2',
      __simulate_status__: 402,
      __simulate_message__: 'insufficient_quota',
    } as any);
    assert.equal(result2.modelUsed, 'lite-3');
    assert.equal(result2.failoverAttempts, 2);
  });
});

describe('P1 hardening: dead combos fail fast, reserved ids never route', () => {
  it('should FAIL FAST when a named combo has zero registered members (no silent auto fallback)', async () => {
    const config = makeConfig({
      combos: [{ id: 'combo-dead', selection: 'priority', models: ['ghost-a', 'ghost-b'] }],
    });
    const { registry, orchestrator } = makeOrchestrator(config);
    assert.equal(registry.isCombo('combo-dead'), true); // still configured & advertised

    await assert.rejects(
      async () =>
        orchestrator.process({
          model: 'combo-dead',
          messages: [{ role: 'user', content: 'Dead combo' }],
        } as any),
      (err: any) => {
        assert.ok(err.message.includes('combo-dead'));
        assert.ok(err.message.includes('no registered member models'));
        return true;
      }
    );
  });

  it('should ignore combos with reserved virtual ids (they cannot shadow routing)', () => {
    const config = makeConfig({
      combos: [
        { id: 'lite', selection: 'priority', models: ['lite-1'] },
        { id: 'combo-ok', selection: 'priority', models: ['lite-1', 'lite-2'] },
      ],
    });
    const registry = new ProviderRegistry(config, true);
    assert.equal(registry.isCombo('lite'), false);
    assert.equal(registry.isCombo('combo-ok'), true);
  });

  it('should hide model-shadowed combos from /v1/models exposure', () => {
    const config = makeConfig();
    const registry = new ProviderRegistry(config, true);
    registry.applyCombos([{ id: 'combo-x', selection: 'priority', models: ['lite-1'] }]);
    assert.equal(registry.isCombo('combo-x'), true);
    assert.ok(registry.getCombos().some(c => c.id === 'combo-x'));

    // A late-registered model with the same id shadows the combo
    registry.registerModel({ id: 'combo-x', provider: 'mock', upstreamModel: 'combo-x', tier: 'lite', pricing: { input: 1, output: 1 } });
    assert.ok(!registry.getCombos().some(c => c.id === 'combo-x'));
  });
});
