import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterConfig } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { getRuntimeConfigRef, loadConfig, registerRuntimeConfigRef, saveConfig } from '../src/config/index.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import type { ForwardProxyConfig } from '../src/config/types.js';
import {
  normalizeUnresolvedModelConfig,
  resolveUnresolvedModelAction,
} from '../src/pipeline/unresolved-model.js';

/**
 * forwardProxy.unresolvedModel (ADR-0003 §7a): when the client's `model`
 * name survives the full resolution ladder (exact id → variant → host-pinned
 * bare upstream name → combo), the MITM forward-proxy leg applies the
 * operator's onMiss policy. The native /v1 leg NEVER consults it.
 *
 * MITM-leg context shape: `clientRequest` present, `fastifyRequest` absent —
 * the leg discriminator processInternal uses.
 */
const mitmContext = {
  clientRequest: { url: '/v1/chat/completions', headers: { host: 'opencode.ai' } },
} as any;

const nativeContext = {
  fastifyRequest: { headers: { host: '127.0.0.1:3000' } },
} as any;

function makeConfig(forwardProxy?: RouterConfig['forwardProxy']): RouterConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    baselineModel: 'plus-1',
    fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
    circuitBreaker: { enabled: true, failureThreshold: 3 },
    retry: {
      enabled: true,
      inplace: { enabled: true, maxAttempts: 1, backoffMs: 10, jitterMs: 5 },
      failover: { enabled: true, maxAttempts: 3, tierCrossPolicy: 'allow_escalate' },
    },
    models: [
      {
        id: 'lite-1', provider: 'mock', upstreamModel: 'lite-1', tier: 'lite',
        priority: 1, isDefaultInTier: true, pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
      },
      {
        id: 'lite-2', provider: 'mock', upstreamModel: 'lite-2', tier: 'lite',
        priority: 2, pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
      },
      {
        id: 'plus-1', provider: 'mock', upstreamModel: 'plus-1', tier: 'plus',
        priority: 1, isDefaultInTier: true, pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
      },
    ],
    combos: [{ id: 'combo-lite', selection: 'priority', models: ['lite-1', 'lite-2'] }],
    forwardProxy,
  } as RouterConfig;
}

function makeOrchestrator(config: RouterConfig) {
  const registry = new ProviderRegistry(config, true);
  return { registry, orchestrator: new PipelineOrchestrator(config, registry, new FinOpsTracker()) };
}

describe('unresolved-model policy: normalization', () => {
  it('trims values, lowercases host keys, drops empties', () => {
    const cfg = normalizeUnresolvedModelConfig({
      onMiss: ' fail ',
      hosts: { ' OpenCode.AI ': 'auto', '': 'x', dead: '  ' },
    });
    assert.deepEqual(cfg, { onMiss: 'fail', hosts: { 'opencode.ai': 'auto' } });
  });

  it('returns undefined for an absent section', () => {
    assert.equal(normalizeUnresolvedModelConfig(undefined), undefined);
  });
});

describe('unresolved-model policy: action resolution', () => {
  it('defaults to auto', () => {
    assert.equal(resolveUnresolvedModelAction(undefined, 'opencode.ai'), 'auto');
    assert.equal(resolveUnresolvedModelAction({ unresolvedModel: {} } as any, 'opencode.ai'), 'auto');
  });

  it('host override wins over the global onMiss', () => {
    const fp = { unresolvedModel: { onMiss: 'fail', hosts: { 'opencode.ai': 'lite-1' } } } as any;
    assert.deepEqual(resolveUnresolvedModelAction(fp, 'OPENCODE.ai'), { ref: 'lite-1' });
    assert.equal(resolveUnresolvedModelAction(fp, 'other.host'), 'fail');
  });

  it('strips a port suffix from the Host header before the hosts lookup', () => {
    const fp = { unresolvedModel: { onMiss: 'fail', hosts: { 'opencode.ai': 'lite-1' } } } as ForwardProxyConfig;
    assert.deepEqual(resolveUnresolvedModelAction(fp, 'opencode.ai:8443'), { ref: 'lite-1' });
  });

  it('maps the two verbs, keeps auto as the default action, and leaves other values as modelRefs', () => {
    const fp = { unresolvedModel: { onMiss: 'direct' } } as any;
    assert.equal(resolveUnresolvedModelAction(fp, undefined), 'direct');
    assert.equal(resolveUnresolvedModelAction({ unresolvedModel: { onMiss: 'auto' } } as any, undefined), 'auto');
    assert.deepEqual(resolveUnresolvedModelAction({ unresolvedModel: { onMiss: 'combo-lite' } } as any, undefined), {
      ref: 'combo-lite',
    });
  });
});

describe('unresolved-model policy: pipeline behavior', () => {
  it('defaults to the classifier on both legs (historical behavior)', async () => {
    const { orchestrator } = makeOrchestrator(makeConfig());
    for (const ctx of [undefined, mitmContext]) {
      const result = await orchestrator.process({
        model: 'big-pickle',
        messages: [{ role: 'user', content: 'hi' }],
      } as any, ctx);
      assert.equal(result.modelUsed, 'plus-1'); // baseline fallback of the cascade
    }
  });

  it('onMiss=fail throws loud 404 on the MITM leg only', async () => {
    const { orchestrator } = makeOrchestrator(
      makeConfig({ unresolvedModel: { onMiss: 'fail' } })
    );
    await assert.rejects(
      async () =>
        orchestrator.process({
          model: 'big-pickle',
          messages: [{ role: 'user', content: 'hi' }],
        } as any, mitmContext),
      (err: any) => err.statusCode === 404 && /onMiss=fail/.test(err.message)
    );
    // Native leg: same name still classifier-routes.
    const result = await orchestrator.process({
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
    } as any, nativeContext);
    assert.equal(result.modelUsed, 'plus-1');
  });

  it('onMiss modelRef resolves as an explicit client choice (MITM leg)', async () => {
    const { orchestrator } = makeOrchestrator(
      makeConfig({ unresolvedModel: { onMiss: 'combo-lite' } })
    );
    const result = await orchestrator.process({
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
    } as any, mitmContext);
    assert.equal(result.modelUsed, 'lite-1'); // combo leader under priority
  });

  it('a host override maps only that host', async () => {
    const { orchestrator } = makeOrchestrator(
      makeConfig({ unresolvedModel: { onMiss: 'fail', hosts: { 'opencode.ai': 'lite-2' } } })
    );
    const mapped = await orchestrator.process({
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
    } as any, mitmContext);
    assert.equal(mapped.modelUsed, 'lite-2');

    const otherCtx = { clientRequest: { headers: { host: 'api.other.dev' } } } as any;
    await assert.rejects(
      async () =>
        orchestrator.process({
          model: 'big-pickle',
          messages: [{ role: 'user', content: 'hi' }],
        } as any, otherCtx),
      (err: any) => err.statusCode === 404
    );
  });

  it('a stale onMiss modelRef degrades to the classifier with a warning', async () => {
    const { orchestrator } = makeOrchestrator(
      makeConfig({ unresolvedModel: { onMiss: 'ghost-model' } })
    );
    const result = await orchestrator.process({
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
    } as any, mitmContext);
    assert.equal(result.modelUsed, 'plus-1');
  });

  it('onMiss=direct runs THROUGH the pipeline and ends as a DirectForwardPlan (model-bound stages skipped)', async () => {
    const { orchestrator } = makeOrchestrator(
      makeConfig({ unresolvedModel: { onMiss: 'direct' } })
    );
    const result = await orchestrator.process({
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
    } as any, mitmContext);
    // The plan is the terminal outcome: no model routed, no OCR inference —
    // the transport relays the ORIGINAL destination verbatim.
    assert.ok(result.directForward, 'a direct plan is returned');
    assert.equal(result.directForward!.url, 'https://opencode.ai/v1/chat/completions');
    assert.ok(result.directForward!.requestBody.includes('"big-pickle"'), 'original model id rides the origin body');
    assert.ok(!result.response, 'no model response exists for a direct turn');
  });

  it('onMiss=direct degrades to the classifier for a loopback ORIGINAL destination (recursion guard)', async () => {
    const { orchestrator } = makeOrchestrator(
      makeConfig({ unresolvedModel: { onMiss: 'direct' } })
    );
    const loopbackCtx = { clientRequest: { headers: { host: '127.0.0.1:4555' } } } as any;
    const result = await orchestrator.process({
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
    } as any, loopbackCtx);
    assert.ok(!result.directForward, 'loopback targets are never direct-forwarded');
    assert.equal(result.modelUsed, 'plus-1', 'degrades to the default classifier');
  });
});

describe('unresolved-model policy: config-save hot-apply', () => {
  it('saveConfig lands forwardProxy.unresolvedModel in the live runtime ref (no restart)', () => {
    // Boot snapshot = the object the MITM interceptor and the orchestrator
    // read per request (server.ts:243-246 — same ref, same object).
    registerRuntimeConfigRef(loadConfig());
    saveConfig({ forwardProxy: { unresolvedModel: { onMiss: 'fail' } } });
    saveConfig({ forwardProxy: { unresolvedModel: { onMiss: 'direct' } } });
    const ref = getRuntimeConfigRef();
    assert.equal(ref?.forwardProxy?.unresolvedModel?.onMiss, 'direct');
  });
});
