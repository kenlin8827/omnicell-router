import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterConfig } from '../src/config/types.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';

/**
 * Auth mirror of server.ts preHandler key resolution: when the local
 * config.yaml defines apiKeys, inference endpoints require a valid key even
 * though the test config passes none (disk keys win over the test config by
 * design). Reuse the first enabled disk key so the e2e cases run both on
 * machines with a populated config.yaml and in clean CI checkouts.
 */
function authHeaders(): Record<string, string> {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
}

/** Flatten the /v1/models body (OpenAI envelope) into model ids. */
const listIds = (body: any): string[] => body?.data.map((m: any) => m.id);

const baseConfig: RouterConfig = {
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
  combos: [
    { id: 'combo-priority', selection: 'priority', models: ['lite-1', 'lite-2'] },
    { id: 'combo-single', selection: 'priority', models: ['lite-1'] },
    { id: 'combo-cross', selection: 'priority', models: ['lite-1', 'plus-1'] },
    { id: 'combo-rr', selection: 'round_robin', models: ['lite-1', 'lite-2'] },
    { id: 'combo-weighted', selection: 'weighted', models: [{ id: 'lite-1', weight: 1000000 }, { id: 'lite-2', weight: 1 }] },
    { id: 'combo-unknown-member', selection: 'priority', models: ['ghost-model', 'lite-2'] },
    { id: 'combo-disabled', selection: 'priority', models: ['lite-1'], disabled: true },
  ],
};

function makeOrchestrator(config: RouterConfig) {
  const registry = new ProviderRegistry(config, true);
  const tracker = new FinOpsTracker();
  const orchestrator = new PipelineOrchestrator(config, registry, tracker);
  return { registry, orchestrator };
}

describe('Custom Model Combos: routing & execution', () => {
  it('should route a combo-named request to the first member under priority selection', async () => {
    const { registry, orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'combo-priority',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'lite-1');
    assert.equal(result.tierUsed, 'lite');
    assert.equal(result.failoverOccurred, false);
    assert.equal(registry.isCombo('combo-priority'), true);
  });

  it('should fail over in combo config order when the leader hits a hard 402', async () => {
    const { registry, orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'combo-priority',
      messages: [{ role: 'user', content: 'Hello combo' }],
      __simulate_error_model__: 'lite-1',
      __simulate_status__: 402,
      __simulate_message__: 'insufficient_quota',
    } as any);

    assert.equal(result.modelUsed, 'lite-2');
    assert.equal(result.failoverOccurred, true);
    assert.deepEqual(result.failoverPath, ['lite-1', 'lite-2']);

    // Leader breaker hard-tripped by the 402
    assert.equal(registry.getCircuitBreakerManager().getPairBreaker('lite-1', '')?.getState(), 'OPEN');
  });

  it('must NOT escalate outside the combo when all members fail (composition is authoritative)', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    // combo-single has exactly one member (lite-1); plus-1 is healthy but
    // NOT in the combo — the request must fail instead of silently escalating.
    await assert.rejects(
      async () =>
        orchestrator.process({
          model: 'combo-single',
          messages: [{ role: 'user', content: 'Hello combo' }],
          __simulate_error_model__: 'lite-1',
          __simulate_status__: 503,
          __simulate_message__: 'down hard',
        } as any),
      (err: any) => {
        assert.ok(err.message.includes('503') || err.message.includes('down hard'));
        return true;
      }
    );
  });

  it('should skip a tripped member and lead with the first healthy one (no failover counted)', async () => {
    const { registry, orchestrator } = makeOrchestrator(baseConfig);
    registry.getCircuitBreakerManager().trip('lite-1', { reason: 'pre-tripped', cooldownMs: 3600000 });

    const result = await orchestrator.process({
      model: 'combo-priority',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'lite-2');
    assert.equal(result.failoverAttempts, 1);
  });

  it('should support cross-tier combos and report the executed member tier', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    const result = await orchestrator.process({
      model: 'combo-cross',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'lite-1');
    assert.equal(result.tierUsed, 'lite');
  });

  it('round_robin selection should rotate the leader across members', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    const r1 = await orchestrator.process({
      model: 'combo-rr',
      messages: [{ role: 'user', content: 'Turn 1' }],
    } as any);
    const r2 = await orchestrator.process({
      model: 'combo-rr',
      messages: [{ role: 'user', content: 'Turn 2' }],
    } as any);

    assert.deepEqual([r1.modelUsed, r2.modelUsed], ['lite-1', 'lite-2']);
  });

  it('weighted selection should draw the leader by member weight', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    // weight 1,000,000 : 1 — probability of the minority draw is ~1e-6
    const result = await orchestrator.process({
      model: 'combo-weighted',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'lite-1');
  });

  it('should drop unregistered member ids and execute the remaining ones', async () => {
    const { registry, orchestrator } = makeOrchestrator(baseConfig);

    const members = registry.resolveCombo('combo-unknown-member');
    assert.deepEqual(members.map(m => m.id), ['lite-2']);

    const result = await orchestrator.process({
      model: 'combo-unknown-member',
      messages: [{ role: 'user', content: 'Hello combo' }],
    } as any);

    assert.equal(result.modelUsed, 'lite-2');
  });

  it('combo execution must not consult the tier pool when every model is unclassified', async () => {
    // Combos exist to address pool-less models — the pre-execution tier
    // placeholder must not hard-fail them (regression pin).
    // The registry stores config model objects BY REFERENCE — clone them per
    // fixture or the unclassified mutation below leaks into every later test
    // in this file (module-level baseConfig is shared).
    const cfg: RouterConfig = { ...baseConfig, models: baseConfig.models.map(m => ({ ...m })) };
    const { registry, orchestrator } = makeOrchestrator(cfg);
    for (const m of registry.getAllModels()) m.unclassified = true;

    const result = await orchestrator.process({
      model: 'combo-priority',
      messages: [{ role: 'user', content: 'Hello pool-less combo' }],
    } as any);

    assert.equal(result.modelUsed, 'lite-1');
  });

  it('naming an unclassified model directly must execute it, not hard-fail on the empty tier pool', async () => {
    // Boot contract: every model remains directly callable by full id even
    // when no tier rule claims anything (the pool-less operator setup).
    // Cloned fixtures — see the note in the combo test above.
    const cfg: RouterConfig = { ...baseConfig, models: baseConfig.models.map(m => ({ ...m })) };
    const { registry, orchestrator } = makeOrchestrator(cfg);
    for (const m of registry.getAllModels()) m.unclassified = true;

    const result = await orchestrator.process({
      model: 'lite-2',
      messages: [{ role: 'user', content: 'Hello pool-less explicit model' }],
    } as any);

    assert.equal(result.modelUsed, 'lite-2');
  });

  it('a bare upstream-name hit must NOT shadow a combo claiming the same name', async () => {
    // /v1/models advertises the combo id as a virtual model; resolving that
    // name to a single same-upstream-name physical model would be the
    // invisible billing/model drift the combo fail-fast contract forbids.
    const cfg: RouterConfig = {
      ...baseConfig,
      models: [
        ...baseConfig.models,
        {
          id: 'mock/glm-shadow',
          provider: 'mock',
          upstreamModel: 'combo-shadow',
          tier: 'lite',
          priority: 9,
          pricing: { input: 0.1, cacheRead: 0.01, output: 0.4 },
        },
      ],
      combos: [...baseConfig.combos, { id: 'combo-shadow', selection: 'priority', models: ['plus-1'] }],
    };
    const { orchestrator } = makeOrchestrator(cfg);

    const result = await orchestrator.process({
      model: 'combo-shadow',
      messages: [{ role: 'user', content: 'Combo or shadowed physical model?' }],
    } as any);

    assert.equal(result.modelUsed, 'plus-1');
  });
});

describe('Custom Model Combos: exposure & config plumbing', () => {
  it('should list combos in /v1/models and resolve them in /v1/models/:id', async () => {
    const { app } = createServer(baseConfig, true);
    const list = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(list.statusCode, 200);
    const ids = listIds(list.json());
    assert.ok(ids.includes('combo-priority'));

    const single = await app.inject({
      method: 'GET',
      url: '/v1/models/combo-priority',
      headers: authHeaders(),
    });
    assert.equal(single.statusCode, 200);

    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/models/no-such-combo',
      headers: authHeaders(),
    });
    assert.equal(unknown.statusCode, 404);
  });

  it('should execute a combo end-to-end through POST /v1/chat/completions', async () => {
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: 'combo-priority',
        messages: [{ role: 'user', content: 'What is 42?' }],
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-ocr-model'], 'lite-1');
  });

  it('applyCombos should hot-swap the combo registry snapshot', () => {
    const { registry } = makeOrchestrator(baseConfig);
    assert.equal(registry.isCombo('combo-priority'), true);
    assert.equal(registry.isCombo('combo-new'), false);

    registry.applyCombos([{ id: 'combo-new', selection: 'priority', models: ['lite-1'] }]);
    assert.equal(registry.isCombo('combo-priority'), false);
    assert.equal(registry.isCombo('combo-new'), true);
    assert.equal(registry.resolveCombo('combo-new').length, 1);
  });
});

describe('Custom Model Combos: operator disable', () => {
  it('disabled combo stays registered but is hidden from getCombos exposure', () => {
    const { registry } = makeOrchestrator(baseConfig);

    assert.equal(registry.isCombo('combo-disabled'), true);
    assert.equal(registry.isComboDisabled('combo-disabled'), true);
    assert.equal(registry.isComboDisabled('combo-priority'), false);
    assert.ok(!registry.getCombos().some(c => c.id === 'combo-disabled'));
    assert.ok(registry.getCombos().some(c => c.id === 'combo-priority'));
    // Members still resolve — the console page renders disabled combos too.
    assert.deepEqual(registry.resolveCombo('combo-disabled').map(m => m.id), ['lite-1']);
  });

  it('routing a disabled combo fails loud with 404 (never classifier-routed)', async () => {
    const { orchestrator } = makeOrchestrator(baseConfig);

    await assert.rejects(
      async () =>
        orchestrator.process({
          model: 'combo-disabled',
          messages: [{ role: 'user', content: 'Hello disabled combo' }],
        } as any),
      (err: any) => {
        assert.match(err.message, /combo-disabled.*is disabled/);
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it('disabled combo is absent from /v1/models and 404s on /v1/models/:id', async () => {
    const { app } = createServer(baseConfig, true);

    const list = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(list.statusCode, 200);
    const ids = listIds(list.json());
    assert.ok(!ids.includes('combo-disabled'));

    const single = await app.inject({
      method: 'GET',
      url: '/v1/models/combo-disabled',
      headers: authHeaders(),
    });
    assert.equal(single.statusCode, 404);
  });

  it('hot-apply re-enables a combo (disabled flag removed ⇒ selectable again)', () => {
    const { registry } = makeOrchestrator(baseConfig);
    assert.ok(!registry.getCombos().some(c => c.id === 'combo-disabled'));

    registry.applyCombos(
      baseConfig.combos!.map(c => (c.id === 'combo-disabled' ? { ...c, disabled: false } : c))
    );
    assert.equal(registry.isComboDisabled('combo-disabled'), false);
    assert.ok(registry.getCombos().some(c => c.id === 'combo-disabled'));
  });
});

describe('Custom Model Combos: console end-to-end test route', () => {
  // The admin surface gate is the webAuth session check; the test configs
  // carry no webAuth, so /api/admin/* is reachable via inject exactly like
  // the console UI sees it after login.
  it('should run one real completion for an active combo and echo the serving member', async () => {
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({ method: 'POST', url: '/api/admin/combos/combo-priority/test' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.combo, 'combo-priority');
    assert.equal(body.modelUsed, 'lite-1');
    assert.equal(typeof body.latencyMs, 'number');
    assert.equal(body.failoverOccurred, false);
    // failoverPath records the TRIED order (the lone leader on a green run),
    // not only an actual failover — the honest chain shape either way.
    assert.deepEqual(body.failoverPath, ['lite-1']);
  });

  it('should refuse an id that is not a live combo BEFORE spending an upstream call', async () => {
    const { app } = createServer(baseConfig, true);

    const unknown = await app.inject({ method: 'POST', url: '/api/admin/combos/no-such-combo/test' });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().reasonCode, 'combo_inactive');

    // Reserved virtual ids are not combos either — an auto-routed name must
    // never masquerade as a combo test result.
    const reserved = await app.inject({ method: 'POST', url: '/api/admin/combos/auto/test' });
    assert.equal(reserved.statusCode, 400);
    assert.equal(reserved.json().reasonCode, 'combo_inactive');
  });

  it('should refuse a LATE-SHADOWED combo id (physical model registered over it) as inactive', async () => {
    // registerModel keeps isCombo true but hides the id from catalogs — the
    // full-id lookup would silently serve the physical model under the
    // combo's name. The precondition must match the exposure rule exactly
    // (isCombo && !getModel).
    const { app, registry } = createServer(baseConfig, true);
    registry.registerModel({
      id: 'combo-priority',
      provider: 'mock',
      upstreamModel: 'combo-priority',
      tier: 'lite',
      priority: 1,
      pricing: { input: 0.1, cacheRead: 0.01, output: 0.4 },
    } as any);
    assert.equal(registry.isCombo('combo-priority'), true); // shadowed but still in the map

    const res = await app.inject({ method: 'POST', url: '/api/admin/combos/combo-priority/test' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().reasonCode, 'combo_inactive');
  });

  it('should report a disabled combo as a FAILED TEST (200 + ok:false), not a precondition error', async () => {
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({ method: 'POST', url: '/api/admin/combos/combo-disabled/test' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.httpStatus, 404);
    assert.match(body.error, /combo-disabled.*is disabled/);
  });

  it('should test a combo green even when EVERY registered model is unclassified', async () => {
    // The pool-less-operator shape: tiers rules match nothing (live default
    // envs), combos are the only sanctioned address path. Before the fix the
    // pre-execution tier placeholder hard-threw here and killed the combo.
    // Cloned model fixtures — the mutation must not leak to later tests.
    const cfg: RouterConfig = { ...baseConfig, models: baseConfig.models.map(m => ({ ...m })) };
    const { app, registry } = createServer(cfg, true);
    for (const m of registry.getAllModels()) m.unclassified = true;
    assert.throws(() => registry.getModelForTier('plus', true), /No routable models registered/);

    const res = await app.inject({ method: 'POST', url: '/api/admin/combos/combo-priority/test' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true, `test failed: ${body.error}`);
    assert.equal(body.modelUsed, 'lite-1');
  });
});
