import { describe, it, expect } from 'bun:test';
import {
  resolveTierMembers,
  claimModel,
  matchingTiers,
  applyEffortMap,
  generateMemberLists,
} from '../src/providers/member-match.js';
import { resolveTierMatch } from '../src/providers/tier-match.js';
import type { TierMemberRule } from '../src/config/types.js';
import type { TierLevel } from '../src/types/router.js';

/**
 * member-list semantics, pure functions:
 *   - sanitize / configured-flag
 *   - claim order (tier lite→plus→pro→ultra, then list order; first hit wins)
 *   - glob semantics (no wildcard = substring over the FULL model id)
 *   - effortMap translation (`effortMap[requested] ?? requested`)
 *   - the import/seed generator (legacy classifier as the suggestion engine)
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

describe('generateMemberLists — legacy classifier as the import/seed engine', () => {
  const match = resolveTierMatch({}); // built-in baseline (price bands + default patterns)

  it('buckets by the legacy classification and preserves the old chain order', () => {
    const lists = generateMemberLists(
      [
        { id: 'p/cheap', bareId: 'cheap', inputPerM: 0.2, reasoningFlag: false, chainPriority: 2 },
        { id: 'p/cheaper', bareId: 'cheaper', inputPerM: 0.1, reasoningFlag: false, chainPriority: 1 },
        { id: 'p/mid', bareId: 'mid', inputPerM: 1.5, reasoningFlag: false, chainPriority: 0 },
        { id: 'p/mystery', bareId: 'mystery', inputPerM: undefined, reasoningFlag: false, chainPriority: 0 },
      ],
      match,
    );
    expect(lists.lite.map((r) => r.pattern)).toEqual(['p/cheaper', 'p/cheap']);
    expect(lists.plus.map((r) => r.pattern)).toEqual(['p/mid']);
    expect(lists.pro).toHaveLength(0);
    expect(lists.ultra).toHaveLength(0);
    // unclassified (no price, no pattern) is not listed anywhere
    const all = [...lists.lite, ...lists.plus, ...lists.pro, ...lists.ultra].map((r) => r.pattern);
    expect(all.includes('p/mystery')).toBe(false);
  });

  it('honors pins (overrideTier > configTier) and skips denied ids', () => {
    const lists = generateMemberLists(
      [
        { id: 'p/pinned-pro', bareId: 'pinned-pro', inputPerM: 0.2, reasoningFlag: false, overrideTier: 'pro', chainPriority: 0 },
        { id: 'p/jsonc-ultra', bareId: 'jsonc-ultra', inputPerM: 0.2, reasoningFlag: false, configTier: 'ultra', chainPriority: 0 },
        { id: 'p/denied', bareId: 'denied', inputPerM: 0.2, reasoningFlag: false, chainPriority: 0 },
      ],
      match,
      (id) => id === 'p/denied',
    );
    expect(lists.pro.map((r) => r.pattern)).toEqual(['p/pinned-pro']);
    expect(lists.ultra.map((r) => r.pattern)).toEqual(['p/jsonc-ultra']);
    expect(lists.lite.map((r) => r.pattern)).toEqual([]);
  });
});