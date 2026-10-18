import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitBreaker,
  CircuitBreakerManager,
  ErrorClassifier,
  UpstreamError,
} from '../src/resilience/index.js';
import { ModelRegistration, RouterConfig } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { createServer } from '../src/server.js';
import { ChatCompletionRequest } from '../src/types/openai.js';
import { loadConfig } from '../src/config/index.js';

/**
 * Auth mirror of server.ts preHandler key resolution: when the local
 * config.yaml defines apiKeys, inference endpoints require a valid key even
 * though the test config passes none (disk keys win over the test config by
 * design). Reuse the first enabled disk key so the e2e cases run both on
 * machines with a populated config.yaml and in clean CI checkouts.
 */
const authHeaders = (): Record<string, string> => {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
};

describe('Resilience: Error Taxonomy & Diagnostic Classification', () => {
  it('should classify HTTP 402 and quota exhaustion as hard-tripping QUOTA_EXHAUSTED', () => {
    const err402 = new UpstreamError({
      message: 'Upstream returned status 402: {"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}',
      status: 402,
      errorBody: 'insufficient_quota',
      provider: 'openai',
      modelId: 'gpt-4o',
    });

    const diagnosis = ErrorClassifier.classify(err402, 'gpt-4o', 'openai');
    assert.equal(diagnosis.category, 'QUOTA_EXHAUSTED');
    assert.equal(diagnosis.hardTrip, true);
    assert.equal(diagnosis.shouldTripBreaker, true);
    assert.equal(diagnosis.isRetriable, true);
    assert.equal(diagnosis.minCooldownMs, 12 * 3600 * 1000); // 12 hours
  });

  it('should detect Chinese or natural language balance exhaustion phrases', () => {
    const err = new Error('Upstream deepseek returned status 402: 账户余额不足，请充值后重试 (insufficient balance)');
    const diagnosis = ErrorClassifier.classify(err, 'deepseek-chat', 'deepseek');
    assert.equal(diagnosis.category, 'QUOTA_EXHAUSTED');
    assert.equal(diagnosis.hardTrip, true);
  });

  it('should classify HTTP 401 as AUTHENTICATION_ERROR and hard-trip breaker', () => {
    const err401 = new Error('Anthropic error [401]: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    const diagnosis = ErrorClassifier.classify(err401, 'claude-3-5-sonnet', 'anthropic');
    assert.equal(diagnosis.category, 'AUTHENTICATION_ERROR');
    assert.equal(diagnosis.hardTrip, true);
    assert.equal(diagnosis.isRetriable, true);
  });

  it('should classify HTTP 429 as RATE_LIMITED and respect retry-after header', () => {
    const err429 = new UpstreamError({
      message: 'Rate limit reached for requests per minute',
      status: 429,
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      retryAfterSeconds: 45,
    });

    const diagnosis = ErrorClassifier.classify(err429, 'gpt-4o-mini', 'openai');
    assert.equal(diagnosis.category, 'RATE_LIMITED');
    // Explicit Retry-After longer than the in-place wait budget: trust the
    // upstream and hard-trip for exactly that duration.
    assert.equal(diagnosis.hardTrip, true);
    assert.equal(diagnosis.minCooldownMs, 45000);
    assert.equal(diagnosis.retryAfterSeconds, 45);
  });

  it('should keep short-burst 429 soft (in-place retry, no hard trip)', () => {
    const err429short = new UpstreamError({
      message: 'Rate limit reached for requests per minute',
      status: 429,
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      retryAfterSeconds: 1,
    });

    const diagnosis = ErrorClassifier.classify(err429short, 'gpt-4o-mini', 'openai');
    assert.equal(diagnosis.category, 'RATE_LIMITED');
    assert.equal(diagnosis.hardTrip, false);
    assert.equal(diagnosis.isInPlaceRetriable, true);

    // 429 WITHOUT Retry-After: statistical path, no hard trip either
    const err429blind = new UpstreamError({
      message: 'Too many requests',
      status: 429,
      provider: 'openai',
      modelId: 'gpt-4o-mini',
    });
    const diagBlind = ErrorClassifier.classify(err429blind, 'gpt-4o-mini', 'openai');
    assert.equal(diagBlind.hardTrip, false);
  });

  it('should classify 5xx, network timeouts and connection drops as SERVICE_UNAVAILABLE', () => {
    const err503 = new Error('Upstream openrouter returned status 503: Service Unavailable / Cloudflare Bad Gateway');
    const diag503 = ErrorClassifier.classify(err503, 'meta-llama/llama-3.3-70b', 'openrouter');
    assert.equal(diag503.category, 'SERVICE_UNAVAILABLE');
    assert.equal(diag503.hardTrip, false);
    assert.equal(diag503.isRetriable, true);

    const errTimeout = new Error('TypeError: fetch failed (ETIMEDOUT)');
    const diagTimeout = ErrorClassifier.classify(errTimeout, 'claude-3-5-sonnet', 'anthropic');
    assert.equal(diagTimeout.category, 'SERVICE_UNAVAILABLE');
    assert.equal(diagTimeout.isRetriable, true);

    // Bun surfaces a fetch deadline as a TimeoutError whose message carries no
    // "timeout" substring — must still land in SERVICE_UNAVAILABLE / NETWORK_TIMEOUT,
    // not the UNKNOWN bucket ("未知上游错误").
    const errBunTimeout = new Error('The operation timed out.');
    const diagBunTimeout = ErrorClassifier.classify(errBunTimeout, 'glm-5.3-flash', 'zhipu');
    assert.equal(diagBunTimeout.category, 'SERVICE_UNAVAILABLE');
    assert.equal(diagBunTimeout.networkCause, 'NETWORK_TIMEOUT');
    assert.equal(diagBunTimeout.isRetriable, true);
  });

  it('should classify HTTP 400 client payload errors as CLIENT_ERROR and NEVER trip circuit breaker', () => {
    const err400 = new Error('Upstream openai returned status 400: context_length_exceeded: maximum context length is 128000 tokens');
    const diagnosis = ErrorClassifier.classify(err400, 'gpt-4o', 'openai');
    assert.equal(diagnosis.category, 'CLIENT_ERROR');
    assert.equal(diagnosis.shouldTripBreaker, false);
    assert.equal(diagnosis.hardTrip, false);
    assert.equal(diagnosis.isRetriable, false);
  });
});

describe('Resilience: Circuit Breaker State Machine & Cooldown Transitions', () => {
  it('should immediately trip into OPEN on 402 Quota Exhausted with 12h cooldown, and recover via canary', () => {
    let mockTime = 10000000;
    const breaker = new CircuitBreaker('claude-3-5-sonnet', 'anthropic', 'plus', undefined, () => mockTime);

    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(breaker.canExecute().allowed, true);

    // Record 402 failure
    breaker.recordFailure({
      category: 'QUOTA_EXHAUSTED',
      statusCode: 402,
      hardTrip: true,
      shouldTripBreaker: true,
      isRetriable: true,
      // Echo of the global knob — the hard-trip length is resolved from
      // trip.quota.cooldownMs (default quotaCooldownMs = 12h), not from this.
      minCooldownMs: 12 * 3600 * 1000,
      reason: 'Balance exhausted on Anthropic account',
      reasonCode: 'breaker.quota',
      reasonParams: { model: 'claude-3-5-sonnet', provider: 'anthropic' },
    });

    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.canExecute().allowed, false);
    assert.match(breaker.canExecute().reason || '', /Balance exhausted/);
    // Hard trip passes the cause code/params straight through to the snapshot.
    assert.equal(breaker.getSnapshot().reasonCode, 'breaker.quota');
    assert.equal(breaker.getSnapshot().reasonParams?.model, 'claude-3-5-sonnet');

    // Fast-forward 6 hours: still in cooldown
    mockTime += 6 * 3600 * 1000;
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.canExecute().allowed, false);

    // Fast-forward another 6 hours + 1s: enters HALF_OPEN
    mockTime += 6 * 3600 * 1000 + 1000;
    assert.equal(breaker.getState(), 'HALF_OPEN');

    // First canary trial probe allowed
    const probe1 = breaker.canExecute();
    assert.equal(probe1.allowed, true);

    // Second probe rejected while in HALF_OPEN (probe limit 1)
    const probe2 = breaker.canExecute();
    assert.equal(probe2.allowed, false);

    // Canary probe succeeds -> Transitions back to CLOSED!
    breaker.recordSuccess();
    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(breaker.canExecute().allowed, true);
  });

  it('should trip after consecutive 503 failures and escalate backoff up to 5 hours max', () => {
    let mockTime = 10000000;
    const breaker = new CircuitBreaker(
      'deepseek-chat',
      'deepseek',
      'plus',
      {
        failureThreshold: 3,
        initialCooldownMs: 30000,
        cooldownMultiplier: 2,
        maxCooldownMs: 5 * 3600 * 1000, // 5 hours cap
      },
      () => mockTime
    );

    // 1st failure: remains CLOSED
    breaker.recordFailure({
      category: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      hardTrip: false,
      shouldTripBreaker: true,
      isRetriable: true,
      reason: 'Gateway 503',
    });
    assert.equal(breaker.getState(), 'CLOSED');

    // 2nd failure: remains CLOSED
    breaker.recordFailure({
      category: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      hardTrip: false,
      shouldTripBreaker: true,
      isRetriable: true,
      reason: 'Gateway 503',
    });
    assert.equal(breaker.getState(), 'CLOSED');

    // 3rd failure: threshold reached -> trips into OPEN!
    breaker.recordFailure({
      category: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      hardTrip: false,
      shouldTripBreaker: true,
      isRetriable: true,
      reason: 'Gateway 503',
    });
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.getSnapshot().currentCooldownMs, 30000);

    // Cooldown expires -> HALF_OPEN
    mockTime += 30001;
    assert.equal(breaker.getState(), 'HALF_OPEN');

    // Canary trial fails -> immediately escalates cooldown (30s * 2 = 60s)
    breaker.recordFailure({
      category: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      hardTrip: false,
      shouldTripBreaker: true,
      isRetriable: true,
      reason: 'Gateway 503 still failing',
    });
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.getSnapshot().currentCooldownMs, 60000);
  });

  it('rate-window trip, then canary recovery clears the stale window so one blip cannot re-trip', () => {
    let mockTime = 1_000_000;
    // failureThreshold 5 > slidingWindowSize 4: the 4th failure fills the window
    // at 100% rate and trips via the rate path BEFORE the consecutive path can.
    const breaker = new CircuitBreaker('win-model', 'openai', 'plus', {
      failureThreshold: 5, slidingWindowSize: 4, failureRateThreshold: 0.5,
      initialCooldownMs: 30000, maxCooldownMs: 3_600_000, cooldownMultiplier: 2,
    }, () => mockTime);

    const net = {
      category: 'SERVICE_UNAVAILABLE' as const,
      statusCode: 503,
      hardTrip: false,
      shouldTripBreaker: true,
      isRetriable: true,
      isInPlaceRetriable: false,
      reason: 'Upstream network jitter [GATEWAY_ERROR, status 503]: bad gateway',
      reasonCode: 'breaker.network' as const,
      reasonParams: { cause: 'GATEWAY_ERROR', status: 503, message: 'bad gateway' },
    };

    // 3 failures: window not yet full, no trip
    breaker.recordFailure(net);
    breaker.recordFailure(net);
    breaker.recordFailure(net);
    assert.equal(breaker.getState(), 'CLOSED');

    // 4th fills the window at 100% >= 50% -> rate_window trip wrapping the cause
    breaker.recordFailure(net);
    assert.equal(breaker.getState(), 'OPEN');
    const trip = breaker.getSnapshot();
    assert.equal(trip.reasonCode, 'breaker.rate_window');
    assert.equal(trip.reasonParams?.rate, 100);
    assert.equal(trip.reasonParams?.threshold, 50);
    assert.equal(trip.reasonParams?.cause_code, 'breaker.network');

    // Recover via canary: one ms short of the boundary still OPEN, exact
    // cooldownUntil (>=) flips to HALF_OPEN.
    mockTime += 29999;
    assert.equal(breaker.getState(), 'OPEN');
    mockTime += 1;
    assert.equal(breaker.getState(), 'HALF_OPEN');
    breaker.recordSuccess();
    assert.equal(breaker.getState(), 'CLOSED');

    // Regression: a single blip right after recovery must NOT re-trip. Without
    // clearing the window, the 3 surviving stale failures + 1 fresh = 100% again.
    breaker.recordFailure(net);
    assert.equal(breaker.getState(), 'CLOSED');

    // Re-arming holds: it takes a FULL fresh window to trip again.
    breaker.recordFailure(net);
    breaker.recordFailure(net);
    assert.equal(breaker.getState(), 'CLOSED');
    breaker.recordFailure(net);
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.getSnapshot().reasonCode, 'breaker.rate_window');
  });

  it('canary failure escalates the cooldown by the multiplier, caps at max, and wraps cause_code', () => {
    let mockTime = 0;
    const breaker = new CircuitBreaker('ladder-model', 'openai', 'plus', {
      failureThreshold: 3, initialCooldownMs: 30000, maxCooldownMs: 80000, cooldownMultiplier: 2,
    }, () => mockTime);

    const jitter = {
      category: 'SERVICE_UNAVAILABLE' as const,
      statusCode: 504,
      hardTrip: false,
      shouldTripBreaker: true,
      isRetriable: true,
      isInPlaceRetriable: false,
      reason: 'Upstream network jitter [NETWORK_TIMEOUT, status 504]: etimedout',
      reasonCode: 'breaker.network' as const,
      reasonParams: { cause: 'NETWORK_TIMEOUT', status: 504, message: 'etimedout' },
    };

    // Trip on the consecutive threshold.
    breaker.recordFailure(jitter);
    breaker.recordFailure(jitter);
    breaker.recordFailure(jitter);
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.getSnapshot().currentCooldownMs, 30000);

    // Canary #1 fails -> 30s * 2 = 60s, wrapped as breaker.canary over the cause.
    // getState() drives the cooldown-expiry transition (OPEN -> HALF_OPEN) —
    // recordFailure alone does not poll the clock.
    mockTime += 30001;
    assert.equal(breaker.getState(), 'HALF_OPEN');
    breaker.recordFailure(jitter);
    assert.equal(breaker.getState(), 'OPEN');
    const c1 = breaker.getSnapshot();
    assert.equal(c1.currentCooldownMs, 60000);
    assert.equal(c1.reasonCode, 'breaker.canary');
    assert.equal(c1.reasonParams?.cause_code, 'breaker.network');
    assert.equal(c1.reasonParams?.message, 'etimedout');

    // Canary #2 fails -> 60s * 2 = 120s clamped to max 80s (cap actually bites).
    mockTime += 60001;
    assert.equal(breaker.getState(), 'HALF_OPEN');
    breaker.recordFailure(jitter);
    assert.equal(breaker.getSnapshot().currentCooldownMs, 80000);
  });

  it('should support manual administrative reset for instant recovery', () => {
    const breaker = new CircuitBreaker('gpt-4o', 'openai', 'plus');
    breaker.trip('Admin simulated trip', 'QUOTA_EXHAUSTED', 12 * 3600 * 1000);
    assert.equal(breaker.getState(), 'OPEN');

    // Admin recharged account and calls reset
    breaker.reset();
    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(breaker.canExecute().allowed, true);
  });
});

describe('Resilience: Transparent Multi-Model Failover & Session Self-Healing', () => {
  const baseConfig: RouterConfig = {
    port: 3000,
    host: '127.0.0.1',
    baselineModel: 'primary-plus',
    fallback: {
      enabled: true,
      maxRetries: 2,
      escalateTier: 'plus',
      injectErrorContext: true,
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 2,
      quotaCooldownMs: 12 * 3600 * 1000,
    },
    models: [
      {
        id: 'primary-plus',
        provider: 'mock',
        upstreamModel: 'primary-plus',
        tier: 'plus',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 3.0, cacheRead: 0.75, output: 12.0 },
      },
      {
        id: 'secondary-plus',
        provider: 'mock',
        upstreamModel: 'secondary-plus',
        tier: 'plus',
        priority: 2,
        pricing: { input: 3.0, cacheRead: 0.75, output: 12.0 },
      },
      {
        id: 'mock-lite',
        provider: 'mock',
        upstreamModel: 'mock-lite',
        tier: 'lite',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 0.2, cacheRead: 0.05, output: 0.8 },
      },
    ],
  };

  it('should seamlessly failover from primary to backup model when primary fails with 402/503', async () => {
    const registry = new ProviderRegistry(baseConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(baseConfig, registry, tracker);

    // Simulate primary-plus failing with 402 Quota Exhausted
    const request: any = {
      model: 'auto-plus',
      messages: [{ role: 'user', content: 'Explain quantum entanglement' }],
      __simulate_error_model__: 'primary-plus',
      __simulate_status__: 402,
      __simulate_message__: 'insufficient_quota on primary-plus',
    };

    const result = await orchestrator.process(request);

    // Request should succeed without error!
    assert.ok(result.response);
    // Should have used secondary-plus
    assert.equal(result.modelUsed, 'secondary-plus');
    assert.equal(result.tierUsed, 'plus');
    assert.equal(result.failoverOccurred, true);
    assert.equal(result.failoverAttempts, 2);
    assert.deepEqual(result.failoverPath, ['primary-plus', 'secondary-plus']);

    // Check circuit breaker status: primary-plus must now be in OPEN state!
    const cbManager = registry.getCircuitBreakerManager();
    const primaryBreaker = cbManager.getBreaker('primary-plus');
    assert.equal(primaryBreaker?.getState(), 'OPEN');
    assert.equal(primaryBreaker?.getSnapshot().category, 'QUOTA_EXHAUSTED');

    // Next request to auto-plus should immediately route to secondary-plus without touching primary!
    const req2: any = {
      model: 'auto-plus',
      messages: [{ role: 'user', content: 'Follow up question' }],
    };
    const result2 = await orchestrator.process(req2);
    assert.equal(result2.modelUsed, 'secondary-plus');
    assert.equal(result2.failoverOccurred, false); // No failover needed, secondary was picked first!
  });

  it('should auto-heal pinned conversation sessions when pinned model is tripped into OPEN', async () => {
    const registry = new ProviderRegistry(baseConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(baseConfig, registry, tracker);
    const sessionId = 'test-session-resilience-heal';

    // Turn 1: Normal turn, session pins to primary-plus
    const req1: any = {
      model: 'auto-plus',
      messages: [{ role: 'user', content: 'Hello assistant' }],
      router_options: { session_id: sessionId },
    };
    const res1 = await orchestrator.process(req1);
    assert.equal(res1.modelUsed, 'primary-plus');

    const sessionBefore = orchestrator.getSessionManager().getSession(sessionId);
    assert.equal(sessionBefore?.pinnedModel, 'primary-plus');

    // Now primary-plus suffers an outage / 402
    registry.getCircuitBreakerManager().getBreaker('primary-plus')?.trip('5-hour outage', 'SERVICE_UNAVAILABLE', 5 * 3600 * 1000);

    // Turn 2: Follow-up in same session
    const req2: any = {
      model: 'auto-plus',
      messages: [
        { role: 'user', content: 'Hello assistant' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'Can you help me write code?' },
      ],
      router_options: { session_id: sessionId },
    };

    const res2 = await orchestrator.process(req2);

    // Session must NOT crash; it should auto-heal to secondary-plus!
    assert.equal(res2.modelUsed, 'secondary-plus');
    const sessionAfter = orchestrator.getSessionManager().getSession(sessionId);
    assert.equal(sessionAfter?.pinnedModel, 'secondary-plus');
  });
});

describe('Resilience: REST Observability & Administrative API Endpoints', () => {
  const testConfig: RouterConfig = {
    port: 3000,
    host: '127.0.0.1',
    baselineModel: 'plus-1',
    fallback: {
      enabled: true,
      maxRetries: 1,
      escalateTier: 'plus',
      injectErrorContext: true,
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 2,
    },
    models: [
      {
        id: 'plus-1',
        provider: 'mock',
        upstreamModel: 'plus-1',
        tier: 'plus',
        isDefaultInTier: true,
        pricing: { input: 3.0, cacheRead: 0.75, output: 12.0 },
      },
    ],
  };

  it('GET /health should reflect degraded/outage status when breakers trip', async () => {
    const { app, registry } = createServer(testConfig, true);

    // Initially healthy
    const resHealthy = await app.inject({ method: 'GET', url: '/health' });
    const jsonHealthy = resHealthy.json();
    assert.equal(jsonHealthy.status, 'ok');
    assert.equal(jsonHealthy.circuitBreakers.healthy, 1);
    assert.equal(jsonHealthy.circuitBreakers.tripped, 0);

    // Trip the model
    registry.getCircuitBreakerManager().getBreaker('plus-1')?.trip('Test 402', 'QUOTA_EXHAUSTED', 3600000);

    // Should now report degraded/outage
    const resTripped = await app.inject({ method: 'GET', url: '/health' });
    const jsonTripped = resTripped.json();
    assert.equal(jsonTripped.status, 'outage');
    assert.equal(jsonTripped.circuitBreakers.tripped, 1);
  });

  it('manual trip exposes breaker.manual with the operator detail (or empty for console default)', () => {
    const { registry } = createServer(testConfig, true);
    const mgr = registry.getCircuitBreakerManager();

    mgr.trip('plus-1', { reason: 'provider billing issue' });
    const noted = mgr.getBreaker('plus-1')?.getSnapshot();
    assert.equal(noted?.reasonCode, 'breaker.manual');
    assert.equal(noted?.reasonParams?.detail, 'provider billing issue');

    // No note -> empty detail so the console renders its "via console" label.
    mgr.reset('plus-1');
    mgr.trip('plus-1', {});
    const bare = mgr.getBreaker('plus-1')?.getSnapshot();
    assert.equal(bare?.reasonCode, 'breaker.manual');
    assert.equal(bare?.reasonParams?.detail, '');
  });

  it('consecutive-failure trip wraps the cause code into reasonParams', () => {
    const breaker = new CircuitBreaker('wrapped-model', 'anthropic', 'plus');
    const jitter = {
      category: 'SERVICE_UNAVAILABLE' as const,
      statusCode: 503,
      hardTrip: false,
      shouldTripBreaker: true,
      isRetriable: true,
      isInPlaceRetriable: true,
      reason: 'Upstream network jitter [GATEWAY_ERROR, status 503]: bad gateway',
      reasonCode: 'breaker.network' as const,
      reasonParams: { cause: 'GATEWAY_ERROR', status: 503, message: 'bad gateway' },
    };
    breaker.recordFailure(jitter);
    breaker.recordFailure(jitter);
    breaker.recordFailure(jitter);

    const snap = breaker.getSnapshot();
    assert.equal(snap.state, 'OPEN');
    assert.equal(snap.reasonCode, 'breaker.consecutive');
    assert.equal(snap.reasonParams?.count, 3);
    assert.equal(snap.reasonParams?.cause_code, 'breaker.network');
    assert.equal(snap.reasonParams?.message, 'bad gateway');
  });

  it('GET /api/admin/health/circuit-breakers should expose detailed snapshot metrics', async () => {
    const { app, registry } = createServer(testConfig, true);
    registry.getCircuitBreakerManager().getBreaker('plus-1')?.trip('Quota exhausted 402', 'QUOTA_EXHAUSTED', 12 * 3600 * 1000);

    const res = await app.inject({ method: 'GET', url: '/api/admin/health/circuit-breakers' });
    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.object, 'circuit_breaker_summary');
    assert.equal(data.tripped, 1);
    assert.equal(data.breakers[0].modelId, 'plus-1');
    assert.equal(data.breakers[0].category, 'QUOTA_EXHAUSTED');
    assert.ok(data.breakers[0].remainingCooldownMs > 0);
  });

  it('POST /api/admin/health/circuit-breakers/reset should reset tripped breakers to CLOSED', async () => {
    const { app, registry } = createServer(testConfig, true);
    registry.getCircuitBreakerManager().getBreaker('plus-1')?.trip('Test trip', 'SERVICE_UNAVAILABLE', 3600000);

    // Call reset endpoint
    const resReset = await app.inject({
      method: 'POST',
      url: '/api/admin/health/circuit-breakers/reset?model=plus-1',
    });
    assert.equal(resReset.statusCode, 200);
    const resetJson = resReset.json();
    assert.equal(resetJson.status, 'ok');
    assert.equal(resetJson.resetCount, 1);

    // Verify model is back to CLOSED
    assert.equal(registry.getCircuitBreakerManager().getBreaker('plus-1')?.getState(), 'CLOSED');
  });

  it('POST /v1/chat/completions should attach failover and circuit breaker response headers', async () => {
    const { app } = createServer(testConfig, true);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'What is the speed of light?' }],
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-ocr-failover'], 'false');
    assert.equal(res.headers['x-ocr-failover-attempts'], '1');
    assert.equal(res.headers['x-ocr-breaker-state'], 'CLOSED');
  });
});
