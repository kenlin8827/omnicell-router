import { describe, it, expect } from 'bun:test';
import { DEFAULT_TIER_MATCH, bandOrder, classifyTier, resolveTierMatch, type ResolvedTierMatch } from '../src/providers/tier-match.js';

const base = resolveTierMatch(undefined);

/**
 * symmetric tiers, no residual. classifyTier returns
 * PoolMembership: 'lite' | 'plus' | 'pro' | 'ultra' | 'unclassified'.
 *
 * Four-tier vocabulary with `ultra` at the top of the price band [8, +∞) for
 * frontier-tier cases (e.g. Claude Fable).
 */
describe('tier smart match (providers/tier-match)', () => {
  it('lite is PRICE-driven now: a bare name never classifies (no preset patterns)', () => {
    // a recognizable economy NAME + a low price lands in lite by its BAND…
    expect(classifyTier({ modelId: 'gemini-2.5-flash', inputPerM: 0.3, reasoningFlag: false }, base)).toBe('lite');
    expect(classifyTier({ modelId: 'deepseek-v4.1-flash', inputPerM: 0.3, reasoningFlag: false }, base)).toBe('lite');
    // …but a name with NO price matches nothing → unclassified ('flash'/'haiku' are not rules)
    expect(classifyTier({ modelId: 'gemini-2.5-flash', reasoningFlag: false }, base)).toBe('unclassified');
    expect(classifyTier({ modelId: 'claude-haiku-4-5', reasoningFlag: false }, base)).toBe('unclassified');
  });

  it('includes free/local models (input = 0) in the lite band', () => {
    expect(classifyTier({ modelId: 'qwen3-32b', inputPerM: 0, reasoningFlag: false }, base)).toBe('lite');
  });

  it('NO residual any more: a model nothing claims is unclassified', () => {
    // no pattern, no pricing (bands skip), no thinking-effort flag
    expect(classifyTier({ modelId: 'some-unknown-model', inputPerM: undefined, reasoningFlag: false }, base)).toBe('unclassified');
    // priced OUTSIDE every band is unclassified too (plus is a real band now)
    const custom = resolveTierMatch({ plus: { match: { minInputPerM: 20, maxInputPerM: 40 } } });
    expect(classifyTier({ modelId: 'plain-cheap', inputPerM: 1.5, reasoningFlag: false }, custom)).toBe('unclassified');
  });

  it('plus has a REAL price band (the dead-config field is gone)', () => {
    expect(classifyTier({ modelId: 'gpt-5.2', inputPerM: 2.5, reasoningFlag: false }, base)).toBe('plus');
    // a custom plus ceiling pushes the price up into pro's band
    const custom = resolveTierMatch({ plus: { match: { minInputPerM: 1, maxInputPerM: 2 } } });
    expect(classifyTier({ modelId: 'mid-priced', inputPerM: 3, reasoningFlag: false }, custom)).toBe('pro');
    expect(classifyTier({ modelId: 'mid-priced', inputPerM: 3, reasoningFlag: true }, custom)).toBe('pro');
  });

  it('price >= 8 is ultra; the flag is consulted AFTER bands (existing rule)', () => {
    expect(classifyTier({ modelId: 'claude-fable-5', inputPerM: 15, reasoningFlag: false }, base)).toBe('ultra');
    // behavior delta: a mid-priced flagged model is claimed by plus's
    // band first — 'bands outrank the thinking-effort flag' now applies to plus too.
    expect(classifyTier({ modelId: 'kimi-k2', inputPerM: 1, reasoningFlag: true }, base)).toBe('plus');
    // unpriced + flag still reaches pro (bands skip)
    expect(classifyTier({ modelId: 'local-qwq', reasoningFlag: true }, base)).toBe('pro');
  });

  it('user match overrides defaults per field', () => {
    const custom = resolveTierMatch({ lite: { match: { maxInputPerM: 1.2 } }, pro: { match: { patterns: ['*qwq*'] } } });
    expect(classifyTier({ modelId: 'glm-4-air', inputPerM: 1.0, reasoningFlag: false }, custom)).toBe('lite');
    expect(classifyTier({ modelId: 'qwq-32b', inputPerM: 0.5, reasoningFlag: false }, custom)).toBe('pro');
    // lite patterns default kept because only maxInputPerM was replaced
    expect(custom.lite.patterns).toEqual(DEFAULT_TIER_MATCH.lite.patterns);
  });

  it('every tier is merged symmetrically (plus band is no longer ignored)', () => {
    const custom = resolveTierMatch({ plus: { match: { patterns: ['*sonnet*'], minInputPerM: 0.5, maxInputPerM: 125 } } });
    expect(custom.plus.patterns).toEqual(['*sonnet*']);
    expect(custom.plus.minInputPerM).toBe(0.5);
    expect(custom.plus.maxInputPerM).toBe(125);
    // pattern claim is symmetric now: plus claims sonnet like any other tier
    expect(classifyTier({ modelId: 'claude-sonnet-5', inputPerM: 1.5, reasoningFlag: true }, custom)).toBe('plus');
  });

  it('bandOrder(): closed bands first by ascending floor, open-ended bands last', () => {
    // base: lite [0, 0.8], plus [0.8, 3], pro [3, 8], ultra [8, +∞)
    expect(bandOrder(base)).toEqual(['lite', 'plus', 'pro', 'ultra']);
    // Hand-built: the per-field merge in resolveTierMatch() cannot CLEAR the
    // baseline plus ceiling (blank = fall back to baseline), and an open-
    // ended plus floor is exactly the trap bandOrder() defends against.
    const openPlus: ResolvedTierMatch = {
      lite: { maxInputPerM: 0.8 },
      plus: { minInputPerM: 0.8 }, // no ceiling → weak, consulted last
      pro: { minInputPerM: 5 },
      ultra: { minInputPerM: 8 },
    };
    expect(bandOrder(openPlus)).toEqual(['lite', 'ultra', 'pro', 'plus']);
    // ...which is what keeps an open-ended plus floor from swallowing pro
    expect(classifyTier({ modelId: 'expensive', inputPerM: 15, reasoningFlag: false }, openPlus)).toBe('ultra');
    expect(classifyTier({ modelId: 'middle', inputPerM: 2.5, reasoningFlag: false }, openPlus)).toBe('plus');
  });

  it('overlapping bands resolve to the lower floor', () => {
    const custom = resolveTierMatch({
      lite: { match: { patterns: [], maxInputPerM: 10 } },
      pro: { match: { minInputPerM: 2, maxInputPerM: 8 }, patterns: [] },
      plus: { match: { minInputPerM: 5, maxInputPerM: 100 }, patterns: [] },
    });
    expect(classifyTier({ modelId: 'overlap-model', inputPerM: 6, reasoningFlag: false }, custom)).toBe('lite');
  });

  it('per-tier exclude vetoes the AUTO-claim; the model keeps going down the chain', () => {
    const custom = resolveTierMatch({ lite: { match: { exclude: ['*mini*'] } } });
    // 'mini-r1' @ $0.5: lite pattern AND lite band both vetoed → plus floor is 0.8 → unclaimed
    expect(classifyTier({ modelId: 'openai/mini-r1', inputPerM: 0.5, reasoningFlag: false }, custom)).toBe('unclassified');
    // a cheap NON-mini model is still lite
    expect(classifyTier({ modelId: 'openai/cheap-nano', inputPerM: 0.5, reasoningFlag: false }, custom)).toBe('lite');
  });

  it('excludeTiers anchor: this tier refuses models the other tier conditions claim', () => {
    // plus [1, 20] overlaps pro and would win by lower floor…
    // (override pro's ceiling too — the per-field merge keeps baseline max otherwise)
    const overlap = resolveTierMatch({
      plus: { match: { minInputPerM: 1, maxInputPerM: 20 } },
      pro: { match: { minInputPerM: 5, maxInputPerM: 100 } },
    });
    expect(classifyTier({ modelId: 'expensive-plain', inputPerM: 10, reasoningFlag: false }, overlap)).toBe('plus');
    // …unless plus anchor-excludes pro: the band claim is filtered out
    const anchored = resolveTierMatch({
      plus: { match: { minInputPerM: 1, maxInputPerM: 20, excludeTiers: ['pro'] } },
      pro: { match: { minInputPerM: 5, maxInputPerM: 100 } },
    });
    expect(classifyTier({ modelId: 'expensive-plain', inputPerM: 10, reasoningFlag: false }, anchored)).toBe('pro');
    // below pro's floor the anchor does not bite → plus keeps it
    expect(classifyTier({ modelId: 'mid-plain', inputPerM: 3, reasoningFlag: false }, anchored)).toBe('plus');
    // a flagged model matches pro's CONDITION even without pricing → excluded too
    expect(classifyTier({ modelId: 'other-mid', inputPerM: 3, reasoningFlag: true }, anchored)).toBe('pro');
    // self-reference is ignored
    const self = resolveTierMatch({ plus: { match: { excludeTiers: ['plus'] } } });
    expect(classifyTier({ modelId: 'gpt-5.2', inputPerM: 2.5, reasoningFlag: false }, self)).toBe('plus');
  });

  it('an anchor-vetoed model can be rescued by another tier, not hidden', () => {
    const custom = resolveTierMatch({
      lite: { match: { excludeTiers: ['pro'] } },
      pro: { match: { patterns: ['*r1*'] } },
    });
    // 'deepseek-r1' @ $0.55: lite's band would claim it, but pro's PATTERN
    // matches → anchor veto at lite → pro claims it via its own pattern
    expect(classifyTier({ modelId: 'deepseek-r1', inputPerM: 0.55, reasoningFlag: true }, custom)).toBe('pro');
    // a cheap model pro does NOT describe still lands in lite
    expect(classifyTier({ modelId: 'nano-plain', inputPerM: 0.55, reasoningFlag: false }, custom)).toBe('lite');
  });

  // Regression locks for behavior that the live ruleset depends on but is easy
  // to break with an off-by-one or a missing guard.
  describe('regression locks (boundary + NaN + glob)', () => {
    it('price exactly at the pro/ultra boundary (8.0) stays in pro (closed-band wins by lower floor)', () => {
      // bandOrder: closed bands first by ascending floor → pro [3, 8] is
      // consulted before ultra [8, +∞). Both bands include the boundary,
      // so the first-evaluated (lower floor) tier wins.
      expect(classifyTier({ modelId: 'boundary-8', inputPerM: 8.0, reasoningFlag: false }, base)).toBe('pro');
      // 8.0 + reasoningFlag: bands are still consulted before the flag
      expect(classifyTier({ modelId: 'boundary-8-flagged', inputPerM: 8.0, reasoningFlag: true }, base)).toBe('pro');
    });

    it('price exactly at the lite/plus boundary (0.8) lands in lite (closed-band wins by lower floor)', () => {
      expect(classifyTier({ modelId: 'boundary-08', inputPerM: 0.8, reasoningFlag: false }, base)).toBe('lite');
    });

    it('NaN price is rejected by every band — model joins no pool, not the last-evaluated one', () => {
      // Without the Number.isNaN guard, `NaN < x` and `NaN > x` are both false,
      // so bandHit() would return true for EVERY configured band and the model
      // would silently land in whatever bandOrder() consulted last.
      expect(classifyTier({ modelId: 'corrupt-row', inputPerM: Number.NaN, reasoningFlag: false }, base)).toBe('unclassified');
      expect(classifyTier({ modelId: 'corrupt-row', inputPerM: Number.NaN, reasoningFlag: true }, base)).toBe('pro');
    });
  });
});
