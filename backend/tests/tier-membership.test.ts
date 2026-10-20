import { describe, it, expect } from 'bun:test';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { RouterConfig } from '../src/config/types.js';
import type { ModelRegistration, TierMemberRule } from '../src/config/types.js';
import type { TierLevel } from '../src/types/router.js';
import { COMBO_REF_PREFIX } from '../src/providers/member-match.js';

/**
 * registry-level membership: the explicit `members` lists are the
 * ONLY pool-membership source, projected PER TIER — each tier's list
 * independently claims what it matches, so a model (or combo) may join
 * several tiers at once; each pool's chain order / weight / effortMap come
 * from THAT tier's rules. `claimModel` still derives the home tier (first
 * claim in tier order lite→plus→pro→ultra) for single-tier consumers;
 * unclaimed models become 'unclassified' (no pool, still registered/directly
 * callable). NON-mock mode: reclassifyTiers() is a no-op under mockMode.
 */

const model = (id: string, tier: ModelRegistration['tier'], extra: Partial<ModelRegistration> = {}): ModelRegistration => ({
  id,
  provider: 'p',
  upstreamModel: id,
  tier,
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
  ...extra,
});

function makeRegistry(models: ModelRegistration[], tiers: RouterConfig['tiers'] = {}, combos: RouterConfig['combos'] = []): ProviderRegistry {
  const config = {
    port: 3000,
    host: '127.0.0.1',
    fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
    circuitBreaker: { enabled: false },
    models,
    tiers,
    combos,
  } as unknown as RouterConfig;
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshTierMatch(false); // no disk re-reads in tests
  return registry;
}

const members = (
  lite: TierMemberRule[] = [],
  plus: TierMemberRule[] = [],
  pro: TierMemberRule[] = [],
  ultra: TierMemberRule[] = []
): Record<TierLevel, TierMemberRule[]> => ({ lite, plus, pro, ultra });

const rule = (pattern: string, extra: Omit<TierMemberRule, 'pattern'> = {}): TierMemberRule => ({ pattern, ...extra });

const ref = (comboId: string): TierMemberRule => ({ pattern: `${COMBO_REF_PREFIX}${comboId}` });

describe('tier membership commit (member lists)', () => {
  it('claims by full id / substring; unclaimed models leave every pool but stay registered', () => {
    const registry = makeRegistry(
      [
        model('p/mid-priced', 'plus', { tierMatch: { reasoningFlag: false } }),
        model('p/no-condition', 'plus', { tierMatch: { reasoningFlag: false } }),
      ],
      { plus: { members: [rule('p/mid')] } },
    );
    registry.reclassifyTiers(members([], [rule('p/mid')], [], []));

    expect(registry.getCandidateModelsForTier('plus', false).map((m) => m.id)).toEqual(['p/mid-priced']);
    expect(registry.getCandidateModelsForTier('lite', false)).toHaveLength(0);
    expect(registry.getAllModels()).toHaveLength(2); // still registered → direct calls work

    // and it is projected into the diagnostic 'unclassified' pool
    const { pool } = registry.resolveTierPool('unclassified');
    expect(pool.map((p) => p.model.id)).toEqual(['p/no-condition']);
  });

  it('list order IS the chain order; the list leader is the representative', () => {
    const registry = makeRegistry([
      model('p/a', 'plus', { tierMatch: { reasoningFlag: false } }),
      model('p/b', 'plus', { tierMatch: { reasoningFlag: false } }),
    ]);
    registry.reclassifyTiers(members([], [rule('p/b'), rule('p/a')], [], []));
    expect(registry.getCandidateModelsForTier('plus', false).map((m) => m.id)).toEqual(['p/b', 'p/a']);
    expect(registry.getModelForTier('plus', false).id).toBe('p/b');
  });

  it('member weight orders the chain ahead of list order (dual-purpose weight)', () => {
    const cfg = members([], [rule('p/a'), rule('p/b', { weight: 5 })], [], []);
    const registry = makeRegistry(
      [
        model('p/a', 'plus', { tierMatch: { reasoningFlag: false } }),
        model('p/b', 'plus', { tierMatch: { reasoningFlag: false } }),
      ],
      { plus: { members: cfg.plus } },
    );
    registry.reclassifyTiers(cfg);
    // b carries weight 5 → it leads despite being listed second
    expect(registry.getCandidateModelsForTier('plus', false).map((m) => m.id)).toEqual(['p/b', 'p/a']);
  });

  it('a model may join several tiers at once (per-tier membership projection)', () => {
    const registry = makeRegistry([model('p/both', 'plus', { tierMatch: { reasoningFlag: false } })]);
    registry.reclassifyTiers(members([rule('p/both')], [rule('p/both')], [], []));
    expect(registry.getCandidateModelsForTier('lite', false).map((m) => m.id)).toEqual(['p/both']);
    expect(registry.getCandidateModelsForTier('plus', false).map((m) => m.id)).toEqual(['p/both']);
    // The stored tier stays the DERIVED home tier: first claim in tier order.
    expect(registry.getModel('p/both')!.tier).toBe('lite');
    // Removing one membership leaves the other pool untouched.
    registry.reclassifyTiers(members([], [rule('p/both')], [], []));
    expect(registry.getCandidateModelsForTier('lite', false)).toHaveLength(0);
    expect(registry.getCandidateModelsForTier('plus', false).map((m) => m.id)).toEqual(['p/both']);
  });

  it('each tier carries its own chain order, weight and effortMap for a shared member', () => {
    const registry = makeRegistry(
      [model('p/shared', 'plus', { tierMatch: { reasoningFlag: false } }), model('p/b', 'plus', { tierMatch: { reasoningFlag: false } })],
      {
        lite: { members: [rule('p/shared', { effortMap: { none: 'high' } })] },
        pro: { members: [rule('p/b'), rule('p/shared', { weight: 5 })] },
      },
    );
    registry.reclassifyTiers(
      members(
        [rule('p/shared', { effortMap: { none: 'high' } })],
        [],
        [rule('p/b'), rule('p/shared', { weight: 5 })],
        []
      )
    );
    // lite: the shared model is the sole member (chain head).
    expect(registry.getCandidateModelsForTier('lite', false).map((m) => m.id)).toEqual(['p/shared']);
    // pro: weight 5 lifts it over the earlier-listed b.
    expect(registry.getCandidateModelsForTier('pro', false).map((m) => m.id)).toEqual(['p/shared', 'p/b']);
    // effort translation follows the SERVING pool, not the home tier.
    expect(registry.effortMapFor(registry.getModel('p/shared')!, 'lite')).toEqual({ none: 'high' });
    expect(registry.effortMapFor(registry.getModel('p/shared')!, 'pro')).toBeUndefined();
  });

  it('a combo ref may be referenced by several tiers (each pool expands independently)', () => {
    const registry = makeRegistry(
      [
        model('p/a', 'plus', { tierMatch: { reasoningFlag: false } }),
        model('p/b', 'plus', { tierMatch: { reasoningFlag: false } }),
      ],
      { lite: { members: [ref('c1')] }, ultra: { members: [ref('c1')] } },
      [{ id: 'c1', models: ['p/a', 'p/b'] }],
    );
    const commit = () =>
      registry.reclassifyTiers(registry.expandedMemberRules({ lite: { members: [ref('c1')] }, ultra: { members: [ref('c1')] } } as any).tiers);
    commit();
    expect(registry.getCandidateModelsForTier('lite', false).map((m) => m.id)).toEqual(['p/a', 'p/b']);
    expect(registry.getCandidateModelsForTier('ultra', false).map((m) => m.id)).toEqual(['p/a', 'p/b']);
  });

  it('an unclassified model can never be a tier representative', () => {
    const registry = makeRegistry([
      // registered FIRST so it would naively become the plus representative
      model('p/no-condition', 'plus', { tierMatch: { reasoningFlag: false } }),
      model('p/mid-priced', 'plus', { tierMatch: { reasoningFlag: false } }),
    ]);
    registry.reclassifyTiers(members([], [rule('p/mid-priced')], [], []));
    expect(registry.getModelForTier('plus', false).id).toBe('p/mid-priced');
  });

  it('attaches the claiming rule effortMap and clears it when the rule is removed', () => {
    const registry = makeRegistry([model('p/gpt', 'plus', { tierMatch: { reasoningFlag: false } })]);
    registry.reclassifyTiers(members([], [rule('p/gpt', { effortMap: { none: 'high', low: 'high' } })], [], []));
    expect(registry.getModel('p/gpt')!.effortMap).toEqual({ none: 'high', low: 'high' });
    registry.reclassifyTiers(members([], [rule('p/gpt')], [], []));
    expect(registry.getModel('p/gpt')!.effortMap).toBeUndefined();
  });

  it('a tier emptied by its list degrades instead of hard-failing (same graceful-degradation contract)', () => {
    const registry = makeRegistry([
      model('p/lite-one', 'lite', { tierMatch: { reasoningFlag: false }, isDefaultInTier: true }),
      model('p/mid-one', 'plus', { tierMatch: { reasoningFlag: false } }),
    ]);
    // the plus list matches nothing → EMPTY pool
    registry.reclassifyTiers(members([rule('p/lite-one')], [rule('p/no-such-model')], [], []));
    expect(registry.getCandidateModelsForTier('plus', false)).toHaveLength(0);
    // degradation is allowed (logged) but never lands on an unclassified model
    const picked = registry.getModelForTier('plus', false);
    expect(['p/lite-one', 'p/mid-one']).toContain(picked.id);
    expect(picked.unclassified).not.toBe(true);
  });

  it('reclassify is idempotent: adding the model to the list restores membership', () => {
    const registry = makeRegistry([model('p/mid-one', 'plus', { tierMatch: { reasoningFlag: false } })]);
    registry.reclassifyTiers(members([], [], [], []));
    expect(registry.getCandidateModelsForTier('plus', false)).toHaveLength(0);
    registry.reclassifyTiers(members([], [rule('p/mid-one')], [], []));
    expect(registry.getCandidateModelsForTier('plus', false).map((m) => m.id)).toEqual(['p/mid-one']);
  });

  it('hand-configured models (no tierMatch) keep their explicit tier forever', () => {
    const registry = makeRegistry([model('p/hand', 'pro') /* no tierMatch */]);
    registry.reclassifyTiers(members([], [], [], []));
    expect(registry.getCandidateModelsForTier('pro', false).map((m) => m.id)).toEqual(['p/hand']);
  });

  it('the global denylist still outranks membership (projected as excluded)', () => {
    const registry = makeRegistry([model('p/banned', 'lite', { tierMatch: { reasoningFlag: false } })], {
      exclude: ['p/banned'],
      lite: { members: [rule('p/banned')] },
    });
    registry.reclassifyTiers(members([rule('p/banned')], [], [], []));
    expect(registry.getCandidateModelsForTier('lite', false)).toHaveLength(0); // hot path filters it
    const { pool, excluded } = registry.resolveTierPool('lite');
    expect(pool).toHaveLength(0);
    expect(excluded.map((e) => e.id)).toEqual(['p/banned']);
  });
});

describe('effortMap — selection side (pickModelForEffort / bestEffortMatch)', () => {
  const effortModel = (id: string, extra: Partial<ModelRegistration> = {}) =>
    model(id, 'plus', { tierMatch: { reasoningFlag: false }, supportedReasoningEfforts: ['none', 'medium', 'high'], ...extra });

  it('none→high wins a no-effort request (negative gap beats the unmapped sibling)', () => {
    const maps = [rule('p/native'), rule('p/mapped', { effortMap: { none: 'high' } })];
    const registry = makeRegistry([effortModel('p/native'), effortModel('p/mapped')], { plus: { members: maps } });
    registry.reclassifyTiers(members([], maps, [], []));
    const pick = registry.pickModelForEffort('plus', 'none');
    expect(pick?.model.id).toBe('p/mapped');
    expect(pick?.actualEffort).toBe('high');
    expect(pick?.degraded).toBe(false); // served ABOVE the ask — not a degradation
  });

  it('medium→low loses to a native medium server (min-gap first)', () => {
    const maps = [rule('p/native'), rule('p/mapped', { effortMap: { medium: 'low' } })];
    const registry = makeRegistry([effortModel('p/native'), effortModel('p/mapped')], { plus: { members: maps } });
    registry.reclassifyTiers(members([], maps, [], []));
    const pick = registry.pickModelForEffort('plus', 'medium');
    expect(pick?.model.id).toBe('p/native');
    expect(pick?.actualEffort).toBe('medium');
    expect(pick?.degraded).toBe(false);
  });

  it('map-to-none is an explicit operator choice: served without thinking, degraded vs the CLIENT ask', () => {
    const maps = [rule('p/solo', { effortMap: { medium: 'none' } })];
    const registry = makeRegistry([effortModel('p/solo')], { plus: { members: maps } });
    registry.reclassifyTiers(members([], maps, [], []));
    const pick = registry.pickModelForEffort('plus', 'medium');
    expect(pick?.model.id).toBe('p/solo'); // NOT skipped — mapping TO none is deliberate
    expect(pick?.actualEffort).toBe('none');
    expect(pick?.degraded).toBe(true); // vs requested=medium, not vs the map target
  });

  it('capability cannot reach the mapped level → candidate skipped, never a silent none', () => {
    const maps = [rule('p/solo', { effortMap: { medium: 'high' } })];
    const registry = makeRegistry(
      [effortModel('p/solo', { supportedReasoningEfforts: ['max'] })], // cannot serve anything ≤ high... except none
      { plus: { members: maps } },
    );
    registry.reclassifyTiers(members([], maps, [], []));
    expect(registry.pickModelForEffort('plus', 'medium')).toBeNull();
  });
});