import { describe, it, expect } from 'bun:test';
import {
  resolveTierMembers,
  claimModel,
  claimInTier,
  matchingTiers,
  applyEffortMap,
  markExactFullIds,
  comboMemberRefsOf,
} from '../../src/providers/member-match.js';
import { MAX_MEMBER_WEIGHT } from '../../src/providers/selection.js';
import type { TierMemberRule } from '../../src/config/types.js';
import type { TierLevel } from '../../src/types/router.js';

/**
 * member-list semantics, pure functions:
 *   - sanitize / configured-flag
 *   - claim order (tier lite→plus→pro→ultra, then list order; first hit wins)
 *   - glob semantics (no wildcard = substring over the FULL model id; a
 *     registered full id is marked exact so it never claims a longer sibling)
 *   - effortMap translation (`effortMap[requested] ?? requested`)
 * No seed generator and no shipped member defaults: DEFAULT_CONFIG.tiers is
 * four empty tier shells (pinned in config-tiers-template.test.ts; end-to-end
 * claiming in boot-direct-template-members.test.ts).
 */

const tiers = (
  lite: TierMemberRule[] = [],
  plus: TierMemberRule[] = [],
  pro: TierMemberRule[] = [],
  ultra: TierMemberRule[] = []
): Record<TierLevel, TierMemberRule[]> => ({ lite, plus, pro, ultra });

describe('resolveTierMembers — sanitize + configured flag', () => {
  it('sanitizes malformed rules and unknown effort levels', () => {
    const resolved = resolveTierMembers({
      lite: {
        members: [
          { pattern: ' a ' },
          { pattern: '' } as any,
          { bogus: 1 } as any,
          { pattern: 'b', weight: 0, effortMap: { none: 'high', bad: 'low', low: 'nope' } },
        ],
      },
      plus: { members: [] },
    } as any);
    expect(resolved.tiers.lite).toEqual([{ pattern: 'a' }, { pattern: 'b', effortMap: { none: 'high' } }]);
    expect(resolved.configured).toBe(true);
  });

  it('normalizes an infinite weight to the finite rotation ceiling', () => {
    const resolved = resolveTierMembers({
      plus: {
        members: [
          { pattern: 'p/a', weight: Infinity },
          { pattern: 'p/b', weight: 3 },
          { pattern: 'p/c', weight: Number.NaN },
        ],
      },
    } as any);
    // `.inf` / 1e309 means "as heavy as possible" — clamped to a finite ceiling
    // (never left infinite, which would poison the rotation accumulator). NaN /
    // sub-1 is garbage and stays absent, matching the sanitize contract.
    expect(resolved.tiers.plus).toEqual([
      { pattern: 'p/a', weight: MAX_MEMBER_WEIGHT },
      { pattern: 'p/b', weight: 3 },
      { pattern: 'p/c' },
    ]);
    // The combo ref path applies the SAME contract — one weight rule, two callers.
    const refs = comboMemberRefsOf(
      { id: 'c', models: [{ id: 'p/a', weight: Infinity }] } as any,
      () => true,
    );
    expect(refs).toEqual([{ id: 'p/a', weight: MAX_MEMBER_WEIGHT }]);
  });

  it('configured stays false ONLY when no tier defines a members key (explicit [] counts as configured)', () => {
    expect(resolveTierMembers({}).configured).toBe(false);
    expect(resolveTierMembers({ lite: { members: [] } } as any).configured).toBe(true);
  });
});

describe('claimModel — tier order, then list order, first hit wins', () => {
  it('no wildcard = substring over the full id; full id behaves as a single model', () => {
    const m = tiers([], [{ pattern: 'anthropic/claude-sonnet-4.5' }], [], []);
    expect(claimModel('anthropic/claude-sonnet-4.5', m)).toMatchObject({ tier: 'plus', index: 0 });
    // substring: a wrapping provider prefix still matches
    expect(claimModel('openrouter/anthropic/claude-sonnet-4.5', m)).toMatchObject({ tier: 'plus' });
    expect(claimModel('anthropic/claude-opus-4.5', m)).toBe('unclassified');
  });

  it('wildcards work: * any run, ? a single char', () => {
    const w = tiers([{ pattern: '*haiku*' }, { pattern: 'openai/gpt-?' }], [], [], []);
    expect(claimModel('anthropic/claude-haiku-4.5', w)).toMatchObject({ tier: 'lite', index: 0 });
    expect(claimModel('openai/gpt-5', w)).toMatchObject({ tier: 'lite', index: 1 });
    expect(claimModel('openai/gpt-5.1', w)).toBe('unclassified');
  });

  it('lighter tiers claim first across tiers; earlier rules claim first within a tier', () => {
    const m = tiers([{ pattern: '*sonnet*' }], [{ pattern: '*sonnet*' }, { pattern: '*opus*' }], [], []);
    expect(claimModel('anthropic/claude-sonnet-4.5', m)).toMatchObject({ tier: 'lite' });
    expect(claimModel('anthropic/claude-opus-4.5', m)).toMatchObject({ tier: 'plus', index: 1 });
  });

  it('matchingTiers reports EVERY hit (save-time overlap check)', () => {
    const m = tiers([{ pattern: '*gpt*' }], [{ pattern: '*gpt-5*' }], [], []);
    expect(matchingTiers('openai/gpt-5.1', m)).toEqual(['lite', 'plus']);
    expect(matchingTiers('openai/o3', m)).toEqual([]);
  });
});

describe('markExactFullIds — a registered full id claims exactly one model', () => {
  const registered = new Set(['deepseek/deepseek-v4-flash', 'p/v4']);
  const isReg = (id: string) => registered.has(id);

  it('pins a registered full id exact; partial and unregistered patterns stay substring', () => {
    const out = markExactFullIds(
      tiers([], [
        { pattern: 'deepseek/deepseek-v4-flash' },
        { pattern: 'deepseek-v4' },
        { pattern: 'p/nope' },
        { pattern: 'p/*' },
      ]),
      isReg
    );
    expect(out.plus[0]).toEqual({ pattern: 'deepseek/deepseek-v4-flash', exact: true });
    expect(out.plus[1]).toEqual({ pattern: 'deepseek-v4' });
    expect(out.plus[2]).toEqual({ pattern: 'p/nope' }); // unregistered → orphan, not a silent pin
    expect(out.plus[3]).toEqual({ pattern: 'p/*' });
  });

  it('a pinned full id no longer claims a longer sibling; the partial pattern still does', () => {
    const pinned = markExactFullIds(tiers([{ pattern: 'deepseek/deepseek-v4-flash' }]), isReg);
    expect(claimModel('deepseek/deepseek-v4-flash-vision-exp', pinned)).toBe('unclassified');
    expect(claimModel('deepseek/deepseek-v4-flash', pinned)).toMatchObject({ tier: 'lite' });

    const partial = tiers([{ pattern: 'deepseek-v4' }]);
    expect(claimInTier('lite', 'deepseek/deepseek-v4-flash-vision-exp', partial)).not.toBeNull();
  });

  it('is idempotent and leaves combo-expanded exact rules untouched', () => {
    const once = markExactFullIds(tiers([{ pattern: 'p/v4' }]), isReg);
    const twice = markExactFullIds(once, isReg);
    expect(twice).toEqual(once);
    const combo = tiers([{ pattern: 'p/v4', exact: true }]);
    expect(markExactFullIds(combo, isReg).lite[0]).toEqual({ pattern: 'p/v4', exact: true });
  });
});

describe('applyEffortMap — passthrough + translation', () => {
  it('returns the requested level unchanged without a map', () => {
    expect(applyEffortMap(undefined, 'medium')).toBe('medium');
  });

  it('translates mapped keys and passes through unmapped ones', () => {
    const map = { none: 'high' as const, medium: 'xhigh' as const };
    expect(applyEffortMap(map, 'none')).toBe('high');
    expect(applyEffortMap(map, 'medium')).toBe('xhigh');
    expect(applyEffortMap(map, 'low')).toBe('low');
  });
});
