import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterConfig } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { getRouteEntryStore, promptHashOf } from '../src/router/route-entries.js';
import { createServer } from '../src/server.js';
import { ErrorClassifier, UpstreamError } from '../src/resilience/index.js';
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

describe('Resilience: Cost-Aware In-Place Retry & KV Cache Preservation ', () => {
  const baseConfig: RouterConfig = {
    port: 3000,
    host: '127.0.0.1',
    baselineModel: 'primary-plus',
    fallback: {
      enabled: false,
      maxRetries: 1,
      escalateTier: 'plus',
      injectErrorContext: true,
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 2,
    },
    retry: {
      enabled: true,
      inplace: {
        enabled: true,
        maxAttempts: 1,
        backoffMs: 10,
        jitterMs: 5,
      },
      failover: {
        enabled: true,
        maxAttempts: 2,
        tierCrossPolicy: 'allow_escalate',
      },
    },
    models: [
      {
        id: 'primary-plus',
        provider: 'mock',
        upstreamModel: 'primary-plus',
        tier: 'plus',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
      },
      {
        id: 'secondary-plus',
        provider: 'mock',
        upstreamModel: 'secondary-plus',
        tier: 'plus',
        priority: 2,
        pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
      },
      {
        id: 'mock-lite-1',
        provider: 'mock',
        upstreamModel: 'mock-lite-1',
        tier: 'lite',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
      },
      {
        id: 'mock-lite-2',
        provider: 'mock',
        upstreamModel: 'mock-lite-2',
        tier: 'lite',
        priority: 2,
        pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
      },
    ],
  };

  it('should succeed via In-Place Retry on transient 503, preserving same model and 100% KV cache', async () => {
    const registry = new ProviderRegistry(baseConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(baseConfig, registry, tracker);

    // Primary plus fails once with 503, then succeeds on in-place retry
    const req: any = {
      model: 'plus',
      messages: [{ role: 'user', content: 'Explain distributed consensus algorithms' }],
      __simulate_error_model__: 'primary-plus',
      __simulate_status__: 503,
      __simulate_message__: 'Temporary upstream 503 gateway blip',
      __simulate_fail_times__: 1,
    };

    const result = await orchestrator.process(req);

    // Verified: Request succeeded on primary-plus!
    assert.ok(result.response);
    assert.equal(result.modelUsed, 'primary-plus');
    assert.equal(result.failoverOccurred, false);
    assert.equal(result.failoverAttempts, 1);
    assert.equal(result.inplaceRetries, 1);

    // Circuit breaker must still be CLOSED because the in-place retry recovered
    const breaker = registry.getCircuitBreakerManager().getBreaker('primary-plus');
    assert.equal(breaker?.getState(), 'CLOSED');
  });

  it('should skip in-place retry and immediately failover to backup model when inplace.enabled is false', async () => {
    const noInplaceConfig: RouterConfig = {
      ...baseConfig,
      retry: {
        ...baseConfig.retry,
        inplace: {
          enabled: false,
          maxAttempts: 0,
        },
      },
    };

    const registry = new ProviderRegistry(noInplaceConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(noInplaceConfig, registry, tracker);

    const req: any = {
      model: 'plus',
      messages: [{ role: 'user', content: 'Explain Paxos' }],
      __simulate_error_model__: 'primary-plus',
      __simulate_status__: 503,
      __simulate_fail_times__: 1,
    };

    const result = await orchestrator.process(req);

    // Because inplace is disabled, it immediately fails over to secondary-plus
    assert.equal(result.modelUsed, 'secondary-plus');
    assert.equal(result.failoverOccurred, true);
    assert.equal(result.failoverAttempts, 2);
    assert.equal(result.inplaceRetries, 0);
  });

  it('should immediately bypass in-place retry on 402 Quota Exhausted and failover with 0 wasted retries', async () => {
    const registry = new ProviderRegistry(baseConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(baseConfig, registry, tracker);

    const req: any = {
      model: 'plus',
      messages: [{ role: 'user', content: 'Explain Raft' }],
      __simulate_error_model__: 'primary-plus',
      __simulate_status__: 402,
      __simulate_message__: 'insufficient_quota: credential balance is 0',
    };

    const result = await orchestrator.process(req);

    // Verified: Bypassed in-place retry, switched immediately to backup
    assert.equal(result.modelUsed, 'secondary-plus');
    assert.equal(result.failoverOccurred, true);
    assert.equal(result.failoverAttempts, 2);
    assert.equal(result.inplaceRetries, 0);

    // Primary breaker must be hard-tripped into OPEN
    const breaker = registry.getCircuitBreakerManager().getBreaker('primary-plus');
    assert.equal(breaker?.getState(), 'OPEN');
    assert.equal(breaker?.getSnapshot().category, 'QUOTA_EXHAUSTED');
  });

  it('should abort immediately on non-retriable 400 client error without retries or failover', async () => {
    const registry = new ProviderRegistry(baseConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(baseConfig, registry, tracker);

    const req: any = {
      model: 'plus',
      messages: [{ role: 'user', content: 'Super massive prompt' }],
      __simulate_error_model__: 'primary-plus',
      __simulate_status__: 400,
      __simulate_message__: 'context_length_exceeded: prompt exceeds max 128k',
    };

    await assert.rejects(async () => {
      await orchestrator.process(req);
    }, (err: any) => {
      assert.ok(err.message.includes('context_length_exceeded') || err.message.includes('400'));
      return true;
    });

    // Primary breaker must NOT be tripped on client input error
    const breaker = registry.getCircuitBreakerManager().getBreaker('primary-plus');
    assert.equal(breaker?.getState(), 'CLOSED');
  });

  describe('Explicit-model failover contract (ADR-0014 amendment)', () => {
    const failReq = (model: string, extra: Record<string, unknown> = {}) => ({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      __simulate_error_model__: 'mock-lite-1',
      __simulate_status__: 503,
      __simulate_message__: 'upstream 503',
      __simulate_fail_times__: 99,
      ...extra,
    });

    it('a named model is NEVER substituted: exhaustion fails loud naming the model', async () => {
      const registry = new ProviderRegistry(baseConfig, true);
      const orchestrator = new PipelineOrchestrator(baseConfig, registry, new FinOpsTracker());
      await assert.rejects(
        () => orchestrator.process(failReq('mock-lite-1') as any),
        /Explicit model 'mock-lite-1' did not serve the request/
      );
    });

    it('router_options.failover: true restores tier-pool substitution for that request only', async () => {
      const registry = new ProviderRegistry(baseConfig, true);
      const orchestrator = new PipelineOrchestrator(baseConfig, registry, new FinOpsTracker());
      const result = await orchestrator.process(failReq('mock-lite-1', {
        router_options: { failover: true },
      }) as any);
      assert.equal(result.modelUsed, 'mock-lite-2');
      assert.equal(result.failoverOccurred, true);
    });

    it('forced tier keeps its in-tier failover without any opt-in', async () => {
      const registry = new ProviderRegistry(baseConfig, true);
      const orchestrator = new PipelineOrchestrator(baseConfig, registry, new FinOpsTracker());
      const result = await orchestrator.process(failReq('lite') as any);
      assert.equal(result.modelUsed, 'mock-lite-2');
      assert.equal(result.failoverOccurred, true);
    });
  });
});

describe('Resilience: Hierarchical Failover & Tier Crossing Policies ', () => {
  const crossTierConfig: RouterConfig = {
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
      failureThreshold: 1,
    },
    retry: {
      enabled: true,
      inplace: {
        enabled: true,
        maxAttempts: 1,
        backoffMs: 10,
        jitterMs: 5,
      },
      failover: {
        enabled: true,
        maxAttempts: 3,
        tierCrossPolicy: 'allow_escalate',
      },
    },
    models: [
      {
        id: 'lite-1',
        provider: 'mock',
        upstreamModel: 'lite-1',
        tier: 'lite',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
      },
      {
        id: 'lite-2',
        provider: 'mock',
        upstreamModel: 'lite-2',
        tier: 'lite',
        priority: 2,
        pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
      },
      {
        id: 'plus-1',
        provider: 'mock',
        upstreamModel: 'plus-1',
        tier: 'plus',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
      },
    ],
  };

  it('auto (entry-hit lite) escalates to plus via the allow_escalate pool tail when every lite attempt fails', async () => {
    const registry = new ProviderRegistry(crossTierConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(crossTierConfig, registry, tracker);

    // Genuine-AUTO lite decision: seed the experience table so the entry
    // layer (auto-only) places the prompt at lite — the only way an auto
    // request lands at lite without a decision model. The cross-tier escalation tail
    // is an AUTO-routing policy (ADR-0014); this is the path that may cross.
    getRouteEntryStore().upsert({
      promptHash: promptHashOf('Tail escalation greeting'),
      tier: 'lite',
      source: 'human',
      confidence: 1.0,
    });

    // Wire failure on lite-1 (execution-level) plus a trip on lite-2 (skip).
    // The session pin (lite-1, born healthy) is followed and stays healthy —
    // the pin-eviction repair path CANNOT be what serves plus: with both
    // lite attempts gone, the allow_escalate tail is the only route to plus-1.
    registry.getCircuitBreakerManager().getBreaker('lite-2')?.trip('503 outage', 'SERVICE_UNAVAILABLE', 3600000);

    const req: any = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Tail escalation greeting' }],
      __simulate_error_model__: 'lite-1',
      __simulate_status__: 503,
    };

    const result = await orchestrator.process(req);

    // Under allow_escalate, should escalate up to plus-1 to preserve user uptime!
    assert.equal(result.tierUsed, 'plus');
    assert.equal(result.modelUsed, 'plus-1');
  });

  it('lite (forced tier) must NEVER cross tiers — all-lite outage fails cleanly', async () => {
    const registry = new ProviderRegistry(crossTierConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(crossTierConfig, registry, tracker);

    // Trip both lite-1 and lite-2 to simulate total outage in Lite Tier
    registry.getCircuitBreakerManager().getBreaker('lite-1')?.trip('503 outage', 'SERVICE_UNAVAILABLE', 3600000);
    registry.getCircuitBreakerManager().getBreaker('lite-2')?.trip('503 outage', 'SERVICE_UNAVAILABLE', 3600000);

    const req: any = {
      model: 'lite',
      messages: [{ role: 'user', content: 'Quick greeting' }],
      // Breaker OPEN alone only skips candidates (the last one is force-tried
      // and the mock serves it) — simulate real wire failures so the chain
      // genuinely exhausts with no plus tail to fall into.
      __simulate_error_all__: true,
      __simulate_status__: 503,
    };

    // A forced tier is a contract (ADR-0014): no plus tail, fail loud.
    await assert.rejects(async () => {
      await orchestrator.process(req);
    }, (err: any) => {
      assert.ok(err.message.includes('503'));
      return true;
    });
  });

  it('should refuse to cross tiers and fail cleanly when tierCrossPolicy is same_tier_only', async () => {
    const strictConfig: RouterConfig = {
      ...crossTierConfig,
      retry: {
        ...crossTierConfig.retry,
        failover: {
          enabled: true,
          maxAttempts: 3,
          tierCrossPolicy: 'same_tier_only',
        },
      },
    };

    const registry = new ProviderRegistry(strictConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(strictConfig, registry, tracker);

    // Both lite models fail
    const req: any = {
      model: 'lite',
      messages: [{ role: 'user', content: 'Batch task' }],
      __simulate_error_all__: true,
      __simulate_status__: 503,
    };

    await assert.rejects(async () => {
      await orchestrator.process(req);
    }, (err: any) => {
      assert.ok(err.message.includes('503'));
      return true;
    });
  });

  it('should enforce Strict Anti-Downgrade: Plus requests must NEVER downgrade to lite tier', async () => {
    const registry = new ProviderRegistry(crossTierConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(crossTierConfig, registry, tracker);

    // Trip plus-1
    registry.getCircuitBreakerManager().getBreaker('plus-1')?.trip('Plus down', 'SERVICE_UNAVAILABLE', 3600000);

    const req: any = {
      model: 'plus',
      messages: [{ role: 'user', content: 'Critical architecture design' }],
      __simulate_error_model__: 'plus-1',
      __simulate_status__: 503,
    };

    // Must NOT downgrade to lite-1; should fail instead of degrading code intelligence
    await assert.rejects(async () => {
      await orchestrator.process(req);
    });
  });
});

describe('Resilience: End-to-End HTTP Headers & Observability', () => {
  const e2eConfig: RouterConfig = {
    port: 3000,
    host: '127.0.0.1',
    baselineModel: 'primary-model',
    fallback: {
      enabled: false,
      maxRetries: 1,
      escalateTier: 'plus',
      injectErrorContext: false,
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 2,
    },
    retry: {
      enabled: true,
      inplace: {
        enabled: true,
        maxAttempts: 1,
        backoffMs: 10,
        jitterMs: 5,
      },
      failover: {
        enabled: true,
        maxAttempts: 2,
        tierCrossPolicy: 'allow_escalate',
      },
    },
    models: [
      {
        id: 'primary-model',
        provider: 'mock',
        upstreamModel: 'primary-model',
        tier: 'plus',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
      },
    ],
  };

  it('POST /v1/chat/completions should attach X-OCR-InPlace-Retries and X-OCR-Failover headers', async () => {
    const { app } = createServer(e2eConfig, true);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'What is 42?' }],
        __simulate_error_model__: 'primary-model',
        __simulate_status__: 503,
        __simulate_fail_times__: 1,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-ocr-model'], 'primary-model');
    assert.equal(res.headers['x-ocr-inplace-retries'], '1');
    assert.equal(res.headers['x-ocr-failover'], 'false');
    assert.equal(res.headers['x-ocr-failover-attempts'], '1');
    assert.equal(res.headers['x-ocr-breaker-state'], 'CLOSED');
  });
});

describe('Resilience: Fine-Grained Network Jitter Taxonomy & Cause Filtering ', () => {
  it('should accurately diagnose specific network jitter causes and in-place retriability', () => {
    // 1. Connection reset
    const errReset = new Error('read ECONNRESET: socket hang up');
    const diagReset = ErrorClassifier.classify(errReset, 'gpt-4o', 'openai');
    assert.equal(diagReset.networkCause, 'CONNECTION_RESET');
    assert.equal(diagReset.isInPlaceRetriable, true);

    // 2. Network Timeout
    const errTimeout = new Error('fetch failed: ETIMEDOUT connection timeout');
    const diagTimeout = ErrorClassifier.classify(errTimeout, 'claude-3-5-sonnet', 'anthropic');
    assert.equal(diagTimeout.networkCause, 'NETWORK_TIMEOUT');
    assert.equal(diagTimeout.isInPlaceRetriable, true);

    // 3. Gateway 502 / 503
    const err502 = new UpstreamError({ message: 'Bad Gateway', status: 502, modelId: 'gpt-4o' });
    const diag502 = ErrorClassifier.classify(err502, 'gpt-4o', 'openai');
    assert.equal(diag502.networkCause, 'GATEWAY_ERROR');
    assert.equal(diag502.isInPlaceRetriable, true);

    // 4. Rate limit short burst (<= 2s) -> In-place retriable!
    const err429Short = new UpstreamError({
      message: 'Rate limit exceeded',
      status: 429,
      retryAfterSeconds: 1,
      modelId: 'gpt-4o-mini',
    });
    const diag429Short = ErrorClassifier.classify(err429Short, 'gpt-4o-mini', 'openai');
    assert.equal(diag429Short.networkCause, 'RATE_LIMIT_BURST');
    assert.equal(diag429Short.isInPlaceRetriable, true);

    // 5. Rate limit long burst (> 2s) -> NOT in-place retriable (failover immediately)
    const err429Long = new UpstreamError({
      message: 'Rate limit exceeded',
      status: 429,
      retryAfterSeconds: 30,
      modelId: 'gpt-4o-mini',
    });
    const diag429Long = ErrorClassifier.classify(err429Long, 'gpt-4o-mini', 'openai');
    assert.equal(diag429Long.isInPlaceRetriable, false);

    // 6. Hard failure (402, 401, 400) -> NEVER in-place retriable
    const err402 = new UpstreamError({ message: 'insufficient_quota', status: 402, modelId: 'gpt-4o' });
    const diag402 = ErrorClassifier.classify(err402, 'gpt-4o', 'openai');
    assert.equal(diag402.networkCause, 'HARD_FAILURE');
    assert.equal(diag402.isInPlaceRetriable, false);

    // 7. Server internal error (500) -> NOT in-place retriable by default
    const err500 = new UpstreamError({ message: 'Internal Server Error', status: 500, modelId: 'gpt-4o' });
    const diag500 = ErrorClassifier.classify(err500, 'gpt-4o', 'openai');
    assert.equal(diag500.networkCause, 'SERVER_INTERNAL_ERROR');
    assert.equal(diag500.isInPlaceRetriable, false);
  });

  it('should respect custom retryOnCauses filter in configuration', async () => {
    // Only allow 'network_timeout', disallow 'gateway_error'
    const customConfig: RouterConfig = {
      port: 3000,
      host: '127.0.0.1',
      baselineModel: 'model-a',
      fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
      circuitBreaker: { enabled: true, failureThreshold: 2 },
      retry: {
        enabled: true,
        inplace: {
          enabled: true,
          maxAttempts: 1,
          backoffMs: 10,
          jitterMs: 5,
          retryOnCauses: ['network_timeout'], // Only in-place retry on timeouts!
        },
        failover: {
          enabled: true,
          maxAttempts: 2,
          tierCrossPolicy: 'same_tier_only',
        },
      },
      models: [
        {
          id: 'model-a',
          provider: 'mock',
          upstreamModel: 'model-a',
          tier: 'plus',
          priority: 1,
          isDefaultInTier: true,
          pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
        },
        {
          id: 'model-b',
          provider: 'mock',
          upstreamModel: 'model-b',
          tier: 'plus',
          priority: 2,
          pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
        },
      ],
    };

    const registry = new ProviderRegistry(customConfig, true);
    const tracker = new FinOpsTracker();
    const orchestrator = new PipelineOrchestrator(customConfig, registry, tracker);

    // 503 is GATEWAY_ERROR. Since retryOnCauses only contains 'network_timeout',
    // it must NOT in-place retry on model-a and should immediately failover to model-b!
    const req: any = {
      model: 'plus',
      messages: [{ role: 'user', content: 'Test custom cause filtering' }],
      __simulate_error_model__: 'model-a',
      __simulate_status__: 503,
      __simulate_fail_times__: 1,
    };

    const result = await orchestrator.process(req);
    assert.equal(result.modelUsed, 'model-b');
    assert.equal(result.failoverOccurred, true);
    assert.equal(result.inplaceRetries, 0); // 0 in-place retries because 503 wasn't in retryOnCauses!
  });

  it('should automatically provide DEFAULT_RETRIABLE_CAUSES when retryOnCauses is omitted', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const { DEFAULT_RETRIABLE_CAUSES } = await import('../src/resilience/types.js');

    // Default configuration must have all default retriable causes populated
    const cfg = loadConfig();
    assert.ok(cfg.retry?.inplace?.retryOnCauses);
    assert.deepEqual(cfg.retry?.inplace?.retryOnCauses, DEFAULT_RETRIABLE_CAUSES);

    // ErrorClassifier without explicit retryOnCauses must default to DEFAULT_RETRIABLE_CAUSES
    const errReset = new Error('ECONNRESET');
    const diag = ErrorClassifier.classify(errReset, 'model-1', 'provider-1', undefined, {
      enabled: true,
      inplace: { enabled: true }, // retryOnCauses omitted!
    });
    assert.equal(diag.isInPlaceRetriable, true);
    assert.equal(diag.networkCause, 'CONNECTION_RESET');
  });
});


