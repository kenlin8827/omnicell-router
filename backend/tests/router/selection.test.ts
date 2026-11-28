import { describe, it, expect } from 'bun:test';
import { WeightedRoundRobin, normalizeSelectionStrategy } from '../../src/providers/selection.js';

/**
 * Strategy vocabulary + smooth round-robin core. The three public strategies
 * are industry-standard spellings (`priority`, `weighted_round_robin`,
 * `round_robin`). There is no legacy alias: any other value — including the
 * retired `weighted` spelling of the old weighted-RANDOM draw — resolves to
 * the default `priority`.
 */
describe('selection strategy vocabulary', () => {
  it('passes the three strategies and defaults everything else', () => {
    expect(normalizeSelectionStrategy('weighted_round_robin')).toBe('weighted_round_robin');
    expect(normalizeSelectionStrategy('round_robin')).toBe('round_robin');
    expect(normalizeSelectionStrategy('priority')).toBe('priority');
    // Retired spelling of the weighted-RANDOM draw — no alias, it is unknown.
    expect(normalizeSelectionStrategy('weighted')).toBe('priority');
    expect(normalizeSelectionStrategy(undefined)).toBe('priority');
    expect(normalizeSelectionStrategy(null)).toBe('priority');
    expect(normalizeSelectionStrategy('bogus')).toBe('priority');
  });
});

describe('WeightedRoundRobin (smooth WRR core)', () => {
  const ids = ['a', 'b'];
  const idOf = (id: string) => id;

  it('spreads declared weights evenly (3:1 → a,a,b,a)', () => {
    const rr = new WeightedRoundRobin();
    const picks = Array.from({ length: 8 }, () =>
      rr.pick('k', ids, idOf, (id) => (id === 'a' ? 3 : 1))
    );
    expect(picks).toEqual(['a', 'a', 'b', 'a', 'a', 'a', 'b', 'a']);
  });

  it('degenerates to plain rotation under uniform weight', () => {
    const rr = new WeightedRoundRobin();
    const picks = Array.from({ length: 6 }, () => rr.pick('k', ids, idOf, () => 1));
    expect(picks).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('starts a fresh vector when the pool composition changes', () => {
    const rr = new WeightedRoundRobin();
    rr.pick('k', ids, idOf, () => 1);
    const picks = Array.from({ length: 4 }, () => rr.pick('k', ['a', 'b', 'c'], idOf, () => 1));
    expect(picks).toEqual(['a', 'b', 'c', 'a']);
  });

  it('starts a fresh vector when member weights change under the same ids', () => {
    const rr = new WeightedRoundRobin();
    // Prime with a lopsided 100:1 cycle: a serves, leaving credit a=-1, b=+1.
    expect(rr.pick('k', ids, idOf, (id) => (id === 'a' ? 100 : 1))).toBe('a');
    // Same ids, new 2:1 shares. A fresh vector leads with `a`; the stale
    // vector would carry b's +1 and serve `b` first instead.
    const picks = Array.from({ length: 3 }, () =>
      rr.pick('k', ids, idOf, (id) => (id === 'a' ? 2 : 1))
    );
    expect(picks).toEqual(['a', 'b', 'a']);
  });

  it('treats non-positive / non-numeric weights as 1', () => {
    const rr = new WeightedRoundRobin();
    const picks = Array.from({ length: 4 }, () =>
      rr.pick('k', ids, idOf, (id) => (id === 'a' ? 0 : 1))
    );
    expect(picks).toEqual(['a', 'b', 'a', 'b']);
  });

  it('clamps non-finite / overflowing weights instead of poisoning the cursor', () => {
    // YAML `.inf` / `1e309` arrives as Infinity; two additions overflow the
    // credit to Infinity and the debit turns it into NaN, after which every
    // comparison fails and the first member is served forever. Clamping both
    // members to the ceiling keeps the cycle finite and equal.
    for (const huge of [Infinity, 1e308, Number.MAX_VALUE]) {
      const rr = new WeightedRoundRobin();
      const picks = Array.from({ length: 4 }, () =>
        rr.pick('k', ids, idOf, (id) => (id === 'a' ? huge : 1e6))
      );
      expect(picks).toEqual(['a', 'b', 'a', 'b']);
    }
    // Both members at the ceiling: the cycle is still a plain alternation.
    const rr = new WeightedRoundRobin();
    const bothHuge = Array.from({ length: 4 }, () => rr.pick('k', ids, idOf, () => Infinity));
    expect(bothHuge).toEqual(['a', 'b', 'a', 'b']);
  });

  it('resets a shrunken pool so recovered members start a fresh cycle', () => {
    const rr = new WeightedRoundRobin();
    expect(rr.pick('k', ids, idOf, () => 1)).toBe('a');
    // Pool shrinks to the surviving member `a`; the stored vector must not
    // keep b's credit, so the recovered two-member pool starts over at `a`.
    expect(rr.pick('k', ['a'], idOf, () => 1)).toBe('a');
    expect(rr.pick('k', ids, idOf, () => 1)).toBe('a');
    expect(rr.pick('k', ids, idOf, () => 1)).toBe('b');
  });
});
