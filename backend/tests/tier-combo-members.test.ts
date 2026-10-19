import { describe, it, expect } from 'bun:test';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { RouterConfig, ModelRegistration, TierMemberRule, ComboConfig } from '../src/config/types.js';
import type { TierLevel } from '../src/types/router.js';
import { expandComboRefs, claimModel, COMBO_REF_PREFIX } from '../src/providers/member-match.js';

/**
 * combo refs in tier member lists (`pattern: 'combo:<id>'`): a DECLARED
 * indirection expanded IN PLACE at every commit/read point — config order
 * preserved, per-member weight carried, ref effortMap block-wide, exact pins
 * (never substring-claiming longer sibling ids), dead refs reported. Pools
 * stay physical-model lists; later combo edits follow at the next commit.
 */

const model = (id: string, tier: ModelRegistration['tier'], extra: Partial<ModelRegistration> = {}): ModelRegistration => ({
  id,
  provider: 'p',
  upstreamModel: id,
  tier,
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
  ...extra,
});

function makeRegistry(models: ModelRegistration[], tiers: RouterConfig['tiers'] = {}, combos: ComboConfig[] = []): ProviderRegistry {
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

describe('expandComboRefs (pure expansion)', () => {
  it('expands in place: config order, weight carried, effortMap block-wide, dead refs reported', () => {
    const { tiers, dead } = expandComboRefs(
      members([rule('p/explicit'), ref('c1'), rule('p/tail')]),
      (id) => (id === 'c1' ? [{ id: 'p/v4', weight: 3 }, { id: 'p/v4-pro', weight: 1 }] : null),
    );
    expect(tiers.lite.map((r) => r.pattern)).toEqual(['p/explicit', 'p/v4', 'p/v4-pro', 'p/tail']);
    expect(tiers.lite[1].weight).toBe(3);
    expect(tiers.lite[1].exact).toBe(true);
    expect(dead).toHaveLength(0);
  });

  it('block-wide effortMap rides on every expanded member (independent copies)', () => {
    const map = { none: 'low', high: 'max' } as const;
    const { tiers } = expandComboRefs(
      members([{ ...ref('c1'), effortMap: { ...map } }]),
      () => [{ id: 'p/a', weight: 1 }, { id: 'p/b', weight: 1 }],
    );
    expect(tiers.lite[0].effortMap).toEqual(map);
    expect(tiers.lite[1].effortMap).toEqual(map);
    expect(tiers.lite[0].effortMap).not.toBe(tiers.lite[1].effortMap);
  });

  it('exact pin: an expanded member never substring-claims a longer sibling id', () => {
    const { tiers } = expandComboRefs(members([ref('c1')]), () => [{ id: 'p/v4', weight: 1 }]);
    expect(claimModel('p/v4', tiers).tier).toBe('lite');
    expect(claimModel('p/v4-pro', tiers)).toBe('unclassified');
  });

  it('dedupes within the expansion and against earlier exact claims; dead refs surface', () => {
    const { tiers, dead } = expandComboRefs(
      members([rule('p/v4'), ref('c1'), ref('gone')]),
      (id) => (id === 'c1' ? [{ id: 'p/v4', weight: 1 }, { id: 'p/v4-pro', weight: 1 }] : null),
    );
    expect(tiers.lite.map((r) => r.pattern)).toEqual(['p/v4', 'p/v4-pro']);
    expect(dead).toEqual([{ tier: 'lite', ref: 'combo:gone' }]);
  });
});

describe('registry commit with combo refs', () => {
  it('pools follow combo edits at the next commit (applyCombos → expand → reclassify)', () => {
    const registry = makeRegistry(
      [
        model('p/a', 'plus', { tierMatch: { reasoningFlag: false } }),
        model('p/b', 'plus', { tierMatch: { reasoningFlag: false } }),
        model('p/c', 'plus', { tierMatch: { reasoningFlag: false } }),
      ],
      { lite: { members: [ref('c1')] } },
      [{ id: 'c1', models: ['p/a', 'p/b'] }],
    );
    const commit = () => registry.reclassifyTiers(registry.expandedMemberRules({ lite: { members: [ref('c1')] } }).tiers);
    commit();

    expect(registry.getCandidateModelsForTier('lite', false).map((m) => m.id)).toEqual(['p/a', 'p/b']);

    // combo edit: the tier pool follows without touching tiers.lite.members
    registry.applyCombos([{ id: 'c1', models: ['p/b', 'p/c'] }]);
    commit();
    expect(registry.getCandidateModelsForTier('lite', false).map((m) => m.id)).toEqual(['p/b', 'p/c']);
  });

  it('resolveTierPool preview expands draft refs; weights carry; disabled combo empties the pool', () => {
    const registry = makeRegistry(
      [
        model('p/a', 'plus', { tierMatch: { reasoningFlag: false } }),
        model('p/b', 'plus', { tierMatch: { reasoningFlag: false } }),
      ],
      {},
      [{ id: 'c1', models: [{ id: 'p/a', weight: 4 }, 'p/b'] }],
    );
    const draft = { lite: { members: [ref('c1')] } };
    const { pool } = registry.resolveTierPool('lite', draft as any);
    expect(pool.map((x) => x.model.id)).toEqual(['p/a', 'p/b']);
    expect(pool[0].weight).toBe(4);

    registry.applyCombos([{ id: 'c1', disabled: true, models: ['p/a'] }]);
    const { pool: afterDisable } = registry.resolveTierPool('lite', draft as any);
    expect(afterDisable).toHaveLength(0);
  });
});
