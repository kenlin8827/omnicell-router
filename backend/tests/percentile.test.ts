import { describe, it, expect } from 'bun:test';
import { percentile } from '../src/utils/percentile.js';

describe('percentile', () => {
  it('returns undefined for an empty sample list', () => {
    expect(percentile([], 0.5)).toBeUndefined();
  });

  it('collapses to the single value when there is one sample', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('interpolates between closest ranks (PERCENTILE.INC / NumPy default)', () => {
    // rank = (n-1) * p, then linear between neighbours.
    expect(percentile([40, 60], 0.5)).toBe(50);
    expect(percentile([40, 60], 0.95)).toBe(59);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
  });

  it('sorts its input and never mutates the caller array', () => {
    const values = [300, 100, 200];
    expect(percentile(values, 0.5)).toBe(200);
    expect(values).toEqual([300, 100, 200]);
  });

  it('keeps P50 at the typical sample when one outlier sits in the tail', () => {
    const values = [200, 210, 220, 230, 240, 250, 260, 270, 280, 30_000];
    expect(percentile(values, 0.5)).toBe(245);
    expect(percentile(values, 0.95)!).toBeGreaterThan(10_000);
  });
});
