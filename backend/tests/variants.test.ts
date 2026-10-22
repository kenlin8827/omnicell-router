import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterConfig } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import { routableVariants } from '../src/providers/boot-direct.js';

/**
 * Auth mirror of server.ts preHandler key resolution (same helper shape as
 * combo.test.ts): when the local config.yaml defines apiKeys, inference
 * endpoints require a valid key even though the test config passes none
 * (disk keys win by design). Reuse the first enabled disk key so the e2e
 * cases run both on machines with a populated config.yaml and in clean CI.
 */
function authHeaders(): Record<string, string> {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
}

const baseConfig: RouterConfig = {
  port: 3000,
  host: '127.0.0.1',
  baselineModel: 'vis-1',
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
      id: 'vis-1',
      provider: 'mock',
      upstreamModel: 'vis-1',
      tier: 'plus',
      isDefaultInTier: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
      variants: [
        { id: 'strong', reasoningEffort: 'high' },
        { id: 'quick', reasoningEffort: 'low' },
      ],
    },
    {
      id: 'lite-1',
      provider: 'mock',
      upstreamModel: 'lite-1',
      tier: 'lite',
      isDefaultInTier: true,
      pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
    },
  ],
};

function makeOrchestrator(config: RouterConfig) {
  const registry = new ProviderRegistry(config, true);
  const tracker = new FinOpsTracker();
  const orchestrator = new PipelineOrchestrator(config, registry, tracker);
  return { registry, orchestrator };
}

describe('Model variants: def normalization (boot-direct ingestion)', () => {
  it('keeps effort-bearing variants and maps settings.effort as a fallback', () => {
    assert.deepEqual(
      routableVariants([
        { id: 'aaaa', settings: { reasoningEffort: 'medium' } },
        { id: 'hot', settings: { effort: 'high' } },
      ]),
      [
        { id: 'aaaa', reasoningEffort: 'medium' },
        { id: 'hot', reasoningEffort: 'high' },
      ]
    );
  });

  it('drops non-effort variants, unknown efforts, duplicates and garbage', () => {
    assert.equal(
      routableVariants([
        { id: 'think-on', settings: { thinking: { type: 'enabled' } } },
        { id: 'weird', settings: { reasoningEffort: 'ultra-max' } },
        null,
        { settings: { reasoningEffort: 'low' } },
      ]),
      undefined
    );
    assert.deepEqual(routableVariants([{ id: 'dup', settings: { reasoningEffort: 'low' } }, { id: 'dup', settings: { reasoningEffort: 'high' } }]), [
      { id: 'dup', reasoningEffort: 'low' },
    ]);
  });

  it('returns undefined for non-arrays and empty arrays', () => {
    assert.equal(routableVariants(undefined), undefined);
    assert.equal(routableVariants([]), undefined);
    assert.equal(routableVariants({ id: 'x' }), undefined);
  });
});

describe('Model variants: registry resolution', () => {
  it('resolves sibling ids and #syntax to base + variant', () => {
    const { registry } = makeOrchestrator(baseConfig);

    const sibling = registry.resolveVariantRef('vis-1-strong');
    assert.equal(sibling?.base.id, 'vis-1');
    assert.equal(sibling?.variant.id, 'strong');
    assert.equal(sibling?.variant.reasoningEffort, 'high');

    const hash = registry.resolveVariantRef('vis-1#quick');
    assert.equal(hash?.base.id, 'vis-1');
    assert.equal(hash?.variant.reasoningEffort, 'low');
  });

  it('returns null for unknown variants, unknown bases and plain unknown ids', () => {
    const { registry } = makeOrchestrator(baseConfig);
    assert.equal(registry.resolveVariantRef('vis-1-nope'), null);
    assert.equal(registry.resolveVariantRef('vis-1#nope'), null);
    assert.equal(registry.resolveVariantRef('ghost#strong'), null);
    assert.equal(registry.resolveVariantRef('gpt-3.5-turbo'), null);
  });

  it('a real model id always beats a sibling id it would shadow', () => {
    const { registry } = makeOrchestrator(baseConfig);
    assert.equal(registry.resolveVariantRef('vis-1-strong')?.variant.id, 'strong');

    registry.registerModel({
      id: 'vis-1-strong',
      provider: 'mock',
      upstreamModel: 'vis-1-strong',
      tier: 'lite',
      pricing: { input: 0.1, cacheRead: 0.01, output: 0.4 },
    });

    assert.equal(registry.getModel('vis-1-strong')?.id, 'vis-1-strong');
    assert.equal(registry.resolveVariantRef('vis-1-strong'), null);
    assert.ok(!registry.getVariantExposures().some((e) => e.id === 'vis-1-strong'));
    // the shadowing must not affect the base's other variants
    assert.equal(registry.resolveVariantRef('vis-1-quick')?.variant.id, 'quick');
  });

  it('exposes variant siblings for /v1/models', () => {
    const { registry } = makeOrchestrator(baseConfig);
    const ids = registry.getVariantExposures().map((e) => e.id);
    assert.deepEqual(ids.sort(), ['vis-1-quick', 'vis-1-strong']);
  });
});

describe('Model variants: routing & effort injection', () => {
  it('routes #variant to the base model with the variant effort pinned', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'vis-1#strong',
      messages: [{ role: 'user', content: 'Hello variant' }],
    } as any);

    assert.equal(result.modelUsed, 'vis-1');
    assert.equal(result.variantUsed, 'strong');
    assert.equal(result.requestedEffort, 'high');
    assert.equal(result.actualEffort, 'high');
    assert.equal(result.reasoningDegraded, false);
  });

  it('routes sibling ids identically', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'vis-1-quick',
      messages: [{ role: 'user', content: 'Hello sibling' }],
    } as any);

    assert.equal(result.modelUsed, 'vis-1');
    assert.equal(result.variantUsed, 'quick');
    assert.equal(result.actualEffort, 'low');
  });

  it('the variant choice wins over a client-sent reasoning_effort', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'vis-1#strong',
      messages: [{ role: 'user', content: 'Conflict case' }],
      reasoning_effort: 'low',
    } as any);

    assert.equal(result.variantUsed, 'strong');
    assert.equal(result.requestedEffort, 'high');
    assert.equal(result.actualEffort, 'high');
  });

  it('an unknown #variant fails loud (404) instead of silently classifier-routing', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    await assert.rejects(
      async () =>
        orchestrator.process({
          model: 'vis-1#nope',
          messages: [{ role: 'user', content: 'typo' }],
        } as any),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        assert.ok(String(err.message).includes("Variant 'nope' not found for model 'vis-1'"));
        return true;
      }
    );
  });
});

describe('Model variants: HTTP surface', () => {
  it('lists variant siblings and resolves them in /v1/models/:id', async () => {
    const { app } = createServer(baseConfig, true);

    const list = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(list.statusCode, 200);
    // OpenAI envelope rows carry the models.dev block under `metadata`; row
    // ids are the gateway-visible ids. Provider-grouped capability data lives
    // on /v1/catalog.json.
    const ids: string[] = list.json().data.map((m: any) => m.id);
    assert.ok(ids.includes('vis-1-strong'));
    assert.ok(ids.includes('vis-1-quick'));
    // base model listed before its siblings
    assert.ok(ids.indexOf('vis-1') < ids.indexOf('vis-1-strong'));

    const single = await app.inject({
      method: 'GET',
      url: '/v1/models/vis-1-strong',
      headers: authHeaders(),
    });
    assert.equal(single.statusCode, 200);
    assert.equal(single.json().metadata.parent, 'vis-1');
    assert.equal(single.json().metadata.variant.reasoningEffort, 'high');
    assert.equal(single.json().owned_by, 'mock');
  });

  it('executes variant requests end-to-end with X-OCR-Variant / effort headers', async () => {
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: 'vis-1#strong',
        messages: [{ role: 'user', content: 'What is 42?' }],
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-ocr-model'], 'vis-1');
    assert.equal(res.headers['x-ocr-variant'], 'strong');
    assert.equal(res.headers['x-ocr-thinking-actual'], 'high');

    const sibling = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: 'vis-1-quick',
        messages: [{ role: 'user', content: 'Sibling form' }],
      },
    });
    assert.equal(sibling.statusCode, 200);
    assert.equal(sibling.headers['x-ocr-variant'], 'quick');
    assert.equal(sibling.headers['x-ocr-model'], 'vis-1');
  });

  it('rejects a typo #variant with 404 over HTTP', async () => {
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: 'vis-1#nope',
        messages: [{ role: 'user', content: 'typo' }],
      },
    });

    assert.equal(res.statusCode, 404);
    assert.ok(String(res.json().error?.message || '').includes("Variant 'nope' not found"));
  });

  it('honors variants on the /v1/responses wire (200 + 404 contract)', async () => {
    const { app } = createServer(baseConfig, true);

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: authHeaders(),
      payload: { model: 'vis-1#strong', input: 'Hello responses wire' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['x-ocr-variant'], 'strong');
    assert.equal(ok.headers['x-ocr-model'], 'vis-1');

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: authHeaders(),
      payload: { model: 'vis-1#nope', input: 'typo' },
    });
    assert.equal(bad.statusCode, 404);
    assert.ok(String(bad.json().error?.message || '').includes("Variant 'nope' not found"));
  });
});