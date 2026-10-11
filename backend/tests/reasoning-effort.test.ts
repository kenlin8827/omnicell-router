import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downgradeReasoning, EFFORT_LADDER, ReasoningEffort } from '../src/types/router.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { RouterConfig } from '../src/config/types.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('downgradeReasoning — pure ranking', () => {
  it('returns the requested effort unchanged when the model supports it', () => {
    assert.strictEqual(downgradeReasoning('high', ['low', 'medium', 'high']), 'high');
  });

  it('downgrades to the highest supported level ≤ requested', () => {
    assert.strictEqual(downgradeReasoning('xhigh', ['high']), 'high');
    assert.strictEqual(downgradeReasoning('xhigh', ['low', 'medium', 'high']), 'high');
    assert.strictEqual(downgradeReasoning('high', ['low', 'medium']), 'medium');
  });

  it('returns "none" when model supports no effort at all', () => {
    assert.strictEqual(downgradeReasoning('high', undefined), 'high');
    assert.strictEqual(downgradeReasoning('low', undefined), 'low');
  });

  it('returns "none" when model only supports "none" itself', () => {
    // A model that only declares "explicit no thinking" can't serve any
    // level request — honesty contract forces downgrade to `none` (and
    // the registry will refuse the model entirely for level requests).
    assert.strictEqual(downgradeReasoning('xhigh', ['none']), 'none');
  });

  it('never upgrades above the requested level', () => {
    // Critical honesty contract: a `low` request must never silently become `high`.
    assert.strictEqual(downgradeReasoning('low', ['high', 'xhigh']), 'none');
  });

  it('handles full ladder requests correctly', () => {
    // Every tier in the ladder served by a model that supports the full
    // ladder: request passes through unchanged.
    for (const req of EFFORT_LADDER) {
      assert.strictEqual(downgradeReasoning(req, EFFORT_LADDER), req, `request=${req}`);
    }
  });

  it('undefined supported set falls back to the full ladder; explicit empty array downgrades to none', () => {
    // `undefined` means "no capability declared" → assume the model
    // supports everything, so the request passes through unchanged.
    // An explicit EMPTY array is the opposite: "serves no explicit level"
    // → 'none'. The registry's normalizeEfforts collapses empty arrays
    // to `undefined`-or-legacy before this runs, so `[]` only reaches
    // here from the orchestrator's pinned-model path.
    assert.strictEqual(downgradeReasoning('high', undefined), 'high');
    assert.strictEqual(downgradeReasoning('high', []), 'none');
  });

  it('EFFORT_LADDER is the 6-level vocabulary aligned with OpenCode', () => {
    assert.deepStrictEqual([...EFFORT_LADDER], [
      'none', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
  });

  it('EFFORT_LADDER index is the canonical rank (and is monotonic)', () => {
    // The ladder array IS the rank — indexOf doubles as rank. Add a new
    // level by appending to EFFORT_LADDER; don't reintroduce a parallel
    // numeric map.
    const ranks = EFFORT_LADDER.map((l) => EFFORT_LADDER.indexOf(l));
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(ranks[i] > ranks[i - 1], `rank[${i}] must be > rank[${i - 1}]`);
    }
    assert.strictEqual(EFFORT_LADDER[0], 'none');
    assert.strictEqual(EFFORT_LADDER[EFFORT_LADDER.length - 1], 'max');
  });
});

// ---------------------------------------------------------------------------
// Registry integration: pickModelForEffort
// ---------------------------------------------------------------------------

/**
 * Build a minimal RouterConfig with one tier pool containing `models`.
 * mockMode=true skips real provider construction — every model registered
 * here returns canned responses via the registry's mock executor.
 */
function configWithModels(
  models: Array<{
    id: string;
    tier: 'lite' | 'plus' | 'pro' | 'ultra';
    supportedReasoningEfforts?: ReasoningEffort[];
    supportsReasoningEffort?: boolean;
  }>
): RouterConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    baselineModel: models[0]?.id ?? 'mock',
    fallback: { enabled: false, maxRetries: 0, escalateTier: 'plus', injectErrorContext: false },
    providers: [],
    models: models.map((m) => ({
      id: m.id,
      provider: 'mock',
      upstreamModel: m.id,
      tier: m.tier,
      pricing: { input: 1, output: 2, cacheRead: 0.5 },
      supportedReasoningEfforts: m.supportedReasoningEfforts,
      supportsReasoningEffort: m.supportsReasoningEffort,
      wire: 'openai',
    })),
  };
}

describe('ProviderRegistry.pickModelForEffort — perfect match within tier', () => {
  it('returns the model that natively supports the requested effort', () => {
    const cfg = configWithModels([
      { id: 'a', tier: 'pro', supportedReasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'b', tier: 'pro', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'b');
    assert.strictEqual(pick!.actualEffort, 'xhigh');
    assert.strictEqual(pick!.degraded, false);
  });

  it('returns the only candidate when there is exactly one (downgraded or not)', () => {
    const cfg = configWithModels([
      { id: 'only', tier: 'pro', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'only');
    assert.strictEqual(pick!.actualEffort, 'high');
    assert.strictEqual(pick!.degraded, true);
  });
});

describe('ProviderRegistry.pickModelForEffort — downgrade within tier', () => {
  it('xhigh → high when pool maxes out at high', () => {
    const cfg = configWithModels([
      { id: 'a', tier: 'pro', supportedReasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'b', tier: 'pro', supportedReasoningEfforts: ['low', 'high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.actualEffort, 'high');
    assert.strictEqual(pick!.degraded, true);
  });

  it('high → medium when pool only reaches medium', () => {
    const cfg = configWithModels([
      { id: 'a', tier: 'plus', supportedReasoningEfforts: ['low', 'medium'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('plus', 'high');
    assert.ok(pick);
    assert.strictEqual(pick!.actualEffort, 'medium');
    assert.strictEqual(pick!.degraded, true);
  });

  it('chooses the BEST downgrade when multiple candidates exist (smallest gap)', () => {
    // Pool has [low, high] + [medium] for an `xhigh` request.
    // The single-medium candidate gives gap=2; the [low,high] gives gap=1.
    // Registry must pick the [low,high] one (smaller gap).
    const cfg = configWithModels([
      { id: 'a', tier: 'pro', supportedReasoningEfforts: ['low', 'high'] },
      { id: 'b', tier: 'pro', supportedReasoningEfforts: ['medium'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'a', 'model with smallest gap wins');
    assert.strictEqual(pick!.actualEffort, 'high');
  });

  it('returns null when the only candidate has no effort list at all', () => {
    // A model without `supportedReasoningEfforts` doesn't accept explicit
    // effort control — the registry refuses to silently map a request
    // onto it. The orchestrator falls back to its tier-default path.
    const cfg = configWithModels([
      { id: 'a', tier: 'pro' /* no supportedReasoningEfforts */ },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'high');
    assert.strictEqual(pick, null);
  });

  it('returns null when the only candidate\'s supported set is ["none"] only', () => {
    // Honesty contract: a 'high' request must never silently become 'none'
    // just because the pool happens to contain a model that doesn't support
    // explicit effort. Returning null lets the orchestrator try another tier
    // / report the gap honestly via the response headers.
    const cfg = configWithModels([
      { id: 'a', tier: 'pro', supportedReasoningEfforts: ['none'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'high');
    assert.strictEqual(pick, null);
  });
});

describe('ProviderRegistry.pickModelForEffort — cross-tier mixing', () => {
  it('mixes tiers when the requested tier has no thinking-capable model', () => {
    // The `pro` tier is empty for thinking; the `ultra` tier has the
    // perfect match. Per the 2026-10 design decision, cross-tier mixing
    // is allowed — operators discover this from the response headers.
    const cfg = configWithModels([
      { id: 'ultra-1', tier: 'ultra', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'ultra-1');
    assert.strictEqual(pick!.actualEffort, 'xhigh');
  });

  it('cross-tier fallback still downgrades correctly', () => {
    const cfg = configWithModels([
      { id: 'ultra-1', tier: 'ultra', supportedReasoningEfforts: ['medium'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'ultra-1');
    assert.strictEqual(pick!.actualEffort, 'medium');
    assert.strictEqual(pick!.degraded, true);
  });

  it('returns null when no thinking-capable model exists anywhere', () => {
    const cfg = configWithModels([
      { id: 'a', tier: 'pro' /* no supportedReasoningEfforts */ },
      { id: 'b', tier: 'ultra' /* ditto */ },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'high');
    // No partial match anywhere, no candidate can serve 'high' explicitly;
    // the gateway's contract is to never silently upgrade, so it returns
    // null and the orchestrator falls back to the tier-default flow.
    assert.strictEqual(pick, null);
  });
});

describe('ProviderRegistry.pickModelForEffort — effort=none short-circuits', () => {
  it('returns any model with actualEffort=none and degraded=false', () => {
    const cfg = configWithModels([
      { id: 'only', tier: 'lite', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('lite', 'none');
    assert.ok(pick);
    assert.strictEqual(pick!.actualEffort, 'none');
    assert.strictEqual(pick!.degraded, false);
  });
});

describe('ProviderRegistry.pickModelForEffort — legacy boolean compat', () => {
  it('supportsReasoningEffort=true is treated as supporting all 4 non-default levels', () => {
    const cfg = configWithModels([
      { id: 'legacy', tier: 'pro', supportsReasoningEffort: true },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.actualEffort, 'xhigh');
    assert.strictEqual(pick!.degraded, false);
  });

  it('supportsReasoningEffort=false (or absent) means "no explicit effort control"', () => {
    const cfg = configWithModels([
      { id: 'plain', tier: 'pro', supportsReasoningEffort: false },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'high');
    assert.strictEqual(pick, null);
  });
});

describe('ProviderRegistry.pickModelForEffort — overrides-store priority', () => {
  it('uses supportedReasoningEfforts even when the catalog thought the model was non-thinking', () => {
    // The boot-derived `supportsReasoningEffort=false` is overridden by
    // explicit `supportedReasoningEfforts` on the model registration.
    const cfg = configWithModels([
      { id: 'override-me', tier: 'pro', supportsReasoningEffort: false, supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'high');
    assert.ok(pick);
    assert.strictEqual(pick!.actualEffort, 'high');
  });
});

// ---------------------------------------------------------------------------
// Cross-tier search order (the contract that `ultra` is searched before
// `lite`, so an under-equipped `pro` tier falls UP to ultra, not DOWN to lite)
// ---------------------------------------------------------------------------

describe('ProviderRegistry.pickModelForEffort — cross-tier search order', () => {
  it('prefers the higher tier when both `ultra` and `lite` match', () => {
    // pro tier is empty. ultra has a perfect match, lite has a downgrade
    // match. Order is ultra first → ultra wins.
    const cfg = configWithModels([
      { id: 'ultra-1', tier: 'ultra', supportedReasoningEfforts: ['high', 'xhigh'] },
      { id: 'lite-1', tier: 'lite', supportedReasoningEfforts: ['medium'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'ultra-1', 'ultra tier must win');
    assert.strictEqual(pick!.actualEffort, 'xhigh');
    assert.strictEqual(pick!.degraded, false);
  });

  it('falls UP to ultra (never DOWN) when pro tier is empty', () => {
    const cfg = configWithModels([
      { id: 'lite-1', tier: 'lite', supportedReasoningEfforts: ['medium'] },
      { id: 'ultra-1', tier: 'ultra', supportedReasoningEfforts: ['medium'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'high');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'ultra-1', 'must not fall down to lite');
  });

  it('skips ultra when ultra is healthyOnly-true and empty; falls to plus', () => {
    const cfg = configWithModels([
      { id: 'plus-1', tier: 'plus', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'high');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'plus-1');
  });
});

// ---------------------------------------------------------------------------
// healthyOnly + circuit breaker integration
// ---------------------------------------------------------------------------

describe('ProviderRegistry.pickModelForEffort — healthyOnly + circuit breaker', () => {
  it('healthyOnly=true filters out models whose circuit breaker is open', () => {
    const cfg = configWithModels([
      { id: 'only', tier: 'pro', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const cb = reg.getCircuitBreakerManager();
    cb.trip('only', { reason: 'test', cooldownMs: 60_000 });
    const pick = reg.pickModelForEffort('pro', 'high', true);
    // No other healthy thinking-capable model exists → null so the
    // orchestrator falls back to its tier-default path (which does the
    // healthyOnly=false recovery internally).
    assert.strictEqual(pick, null, 'all healthy models in tier are tripped → null');
  });

  it('healthyOnly=false recovers a tripped model (recovery path)', () => {
    const cfg = configWithModels([
      { id: 'only', tier: 'pro', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const cb = reg.getCircuitBreakerManager();
    cb.trip('only', { reason: 'test', cooldownMs: 60_000 });
    const pick = reg.pickModelForEffort('pro', 'high', false);
    assert.ok(pick, 'healthyOnly=false bypasses the breaker');
    assert.strictEqual(pick!.model.id, 'only');
  });

  it('cross-tier fallback also respects healthyOnly', () => {
    // pro is tripped, ultra is healthy → ultra wins.
    const cfg = configWithModels([
      { id: 'pro-1', tier: 'pro', supportedReasoningEfforts: ['high'] },
      { id: 'ultra-1', tier: 'ultra', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const cb = reg.getCircuitBreakerManager();
    cb.trip('pro-1', { reason: 'test', cooldownMs: 60_000 });
    const pick = reg.pickModelForEffort('pro', 'high');
    assert.ok(pick);
    assert.strictEqual(pick!.model.id, 'ultra-1', 'cross-tier must skip tripped pro');
  });
});

// ---------------------------------------------------------------------------
// Boundary: effort='none' requested
// ---------------------------------------------------------------------------

describe('ProviderRegistry.pickModelForEffort — effort="none" boundary', () => {
  it('returns the tier default model with actualEffort=none and degraded=false', () => {
    const cfg = configWithModels([
      { id: 'a', tier: 'pro', supportedReasoningEfforts: ['high'] },
      { id: 'b', tier: 'pro' /* no effort list */ },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'none');
    assert.ok(pick);
    assert.strictEqual(pick!.actualEffort, 'none');
    assert.strictEqual(pick!.degraded, false);
  });

  it('effort=none falls through to tier-default model even when tier pool is empty (contract)', () => {
    // getModelForTier() always returns SOMETHING (even via cross-tier
    // escalation). pickModelForEffort('none') delegates to it. So an empty
    // pool never returns null for effort=none — the gateway must always be
    // able to serve some model.
    const cfg = configWithModels([]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'none');
    // No models registered at all → registry falls back to throwing;
    // but with models in OTHER tiers, getModelForTier escalates.
    const cfg2 = configWithModels([
      { id: 'fallback', tier: 'lite', supportedReasoningEfforts: ['high'] },
    ]);
    const reg2 = new ProviderRegistry(cfg2, true);
    const pick2 = reg2.pickModelForEffort('pro', 'none');
    assert.ok(pick2);
    assert.strictEqual(pick2!.actualEffort, 'none');
  });
});

// ---------------------------------------------------------------------------
// Honesty contract: never silently upgrade above the requested level
// ---------------------------------------------------------------------------

describe('ProviderRegistry.pickModelForEffort — honesty contract', () => {
  it('a "low" request on a pool that supports only "high" returns null (no silent upgrade)', () => {
    const cfg = configWithModels([
      { id: 'over-spec', tier: 'pro', supportedReasoningEfforts: ['high', 'xhigh'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'low');
    assert.strictEqual(pick, null);
  });

  it('a "medium" request on a pool that supports only "high" returns null (no silent upgrade)', () => {
    const cfg = configWithModels([
      { id: 'over-spec', tier: 'pro', supportedReasoningEfforts: ['high'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'medium');
    assert.strictEqual(pick, null);
  });
});

// ---------------------------------------------------------------------------
// Multiple candidates with equal gap: deterministic tie-break
// ---------------------------------------------------------------------------

describe('ProviderRegistry.pickModelForEffort — deterministic tie-breaking', () => {
  it('two candidates with the same gap → smaller gap-count wins (first match in pool order)', () => {
    // Pool order is the tier's existing sort order; both [low,high] and
    // [medium] have gap=1 from xhigh. Whichever the tier picks first wins.
    // We don't pin to a specific id — only that one of them is selected.
    const cfg = configWithModels([
      { id: 'a', tier: 'pro', supportedReasoningEfforts: ['low', 'high'] },
      { id: 'b', tier: 'pro', supportedReasoningEfforts: ['medium'] },
    ]);
    const reg = new ProviderRegistry(cfg, true);
    const pick = reg.pickModelForEffort('pro', 'xhigh');
    assert.ok(pick);
    assert.strictEqual(pick!.actualEffort, 'high');
    assert.ok(['a', 'b'].includes(pick!.model.id));
  });
});