import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterConfig } from '../src/config/types.js';
import { createServer } from '../src/server.js';

/**
 * Locks for POST /api/admin/tiers/:tier/test — the Rules-page per-tier test
 * button. The route must exercise the SAME resolution a client request takes:
 * the `auto-<tier>` virtual entry pins the tier through router_options
 * force_tier (a BARE tier name is not addressable on the chat wire — it would
 * classifier-route), so a plus-tier test serves the plus pool even though the
 * tiny probe text would classify as lite. An EMPTY tier degrades inside
 * getModelForTier (session-pin birth representative) — the landing model
 * shows up in modelUsed, so the drift stays visible.
 */
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
};

describe('Tier console end-to-end test route', () => {
  // The admin surface gate is the webAuth session check; the test configs
  // carry no webAuth, so /api/admin/* is reachable via inject exactly like
  // the console UI sees it after login.

  it('should run one real completion pinned to the tier pool and echo the serving member', async () => {
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({ method: 'POST', url: '/api/admin/tiers/lite/test' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true, `test failed: ${body.error}`);
    assert.equal(body.tier, 'lite');
    assert.equal(body.modelUsed, 'lite-1');
    assert.equal(typeof body.latencyMs, 'number');
    assert.equal(body.failoverOccurred, false);
    // failoverPath records the TRIED order (the lone leader on a green run),
    // not only an actual failover — the honest chain shape either way.
    assert.deepEqual(body.failoverPath, ['lite-1']);
  });

  it('should serve the FORCED tier, not the classifier pick (plus probe would classify as lite)', async () => {
    // The discriminating pin check: a 'ping' body classifies into the lite
    // tier, so a route that sent a bare tier name (or ignored force_tier)
    // would answer with lite-1 here. The virtual-entry pin must land plus-1.
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({ method: 'POST', url: '/api/admin/tiers/plus/test' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true, `test failed: ${body.error}`);
    assert.equal(body.tier, 'plus');
    assert.equal(body.modelUsed, 'plus-1');
  });

  it('should refuse an unknown tier name BEFORE spending an upstream call', async () => {
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({ method: 'POST', url: '/api/admin/tiers/bogus/test' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().reasonCode, 'unknown_tier');
  });

  it('should surface an EMPTY tier via the degraded landing model in modelUsed (never silent)', async () => {
    // No ultra model is registered. The tier representative for session pin
    // birth degrades inside getModelForTier (escalate→plus→lite chain, server
    // warn reason=empty-pool) and the degraded model becomes the chain head —
    // exactly what a real client `ultra` request gets served. The result
    // must pass that truth through: ok, but modelUsed names the NON-ultra
    // landing model (plus-1, the escalateTier), so the drift is visible.
    const { app } = createServer(baseConfig, true);

    const res = await app.inject({ method: 'POST', url: '/api/admin/tiers/ultra/test' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true, `test failed: ${body.error}`);
    assert.equal(body.tier, 'ultra');
    assert.equal(body.modelUsed, 'plus-1');
    assert.deepEqual(body.failoverPath, ['plus-1']);
  });
});
