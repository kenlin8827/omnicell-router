import { describe, expect, it } from 'bun:test';
import { byQuotaUrgency, quotaUrgencyRank } from '../../frontend/src/lib/quotaRank';
import type { QuotaPairRow } from '../../frontend/src/lib/api';

/**
 * Pure-logic check for the shared quota urgency ranking used by the quota
 * page and the sidebar peek (frontend/src/lib/quotaRank.ts). Lives in the
 * backend suite because that is the only runner wired up (isolated per-file
 * `bun test`); the module under test is DOM-free.
 */

function pair(over: Partial<QuotaPairRow> & { providerId: string }): QuotaPairRow {
  return { keyHashPrefix: 'aa', covered: true, ...over } as QuotaPairRow;
}

function pctPair(providerId: string, pct: number | null): QuotaPairRow {
  return pair({
    providerId,
    quota: {
      badge: 'probed',
      windows: [
        { name: 'w', used: 0, total: pct === null ? null : 100, remainingPct: pct, resetAt: null, unlimited: pct === null },
      ],
    },
  });
}

describe('quotaUrgencyRank', () => {
  it('orders drained before tight before healthy percentage windows', () => {
    const drained = pctPair('a', 5);
    const tight = pctPair('b', 20);
    const healthy = pctPair('c', 80);
    expect(quotaUrgencyRank(drained)).toBeLessThan(quotaUrgencyRank(tight));
    expect(quotaUrgencyRank(tight)).toBeLessThan(quotaUrgencyRank(healthy));
  });

  it('keeps percentage order ascending inside a band', () => {
    const [x, y] = [pctPair('x', 3), pctPair('y', 7)];
    expect(byQuotaUrgency(x, y)).toBeLessThan(0);
  });

  it('places balances between healthy windows and stale/unverified rows', () => {
    const healthy = pctPair('h', 90);
    const drainedBalance = pair({
      providerId: 'b0',
      quota: { badge: 'probed', windows: [{ name: 'balance', nameCode: 'balance', used: 0, total: 0, remainingPct: null, resetAt: null, unlimited: false }] },
    });
    const balance = pair({
      providerId: 'b1',
      quota: { badge: 'probed', windows: [{ name: 'balance', nameCode: 'balance', used: 0, total: 50, remainingPct: null, resetAt: null, unlimited: false }] },
    });
    const stale = pair({ providerId: 's', quota: { badge: 'stale', windows: [] } });
    const unverified = pair({ providerId: 'u', quota: { badge: 'unverified', windows: [] } });
    const none = pair({ providerId: 'z' });
    const order = [healthy, drainedBalance, balance, stale, unverified, none].sort(byQuotaUrgency);
    expect(order.map((r) => r.providerId)).toEqual(['h', 'b0', 'b1', 's', 'u', 'z']);
  });

  it('breaks ties deterministically on pair identity', () => {
    const a = pair({ providerId: 'aaa', keyHashPrefix: '1' });
    const b = pair({ providerId: 'bbb', keyHashPrefix: '1' });
    expect(byQuotaUrgency(a, b)).toBeLessThan(0);
    expect(byQuotaUrgency(b, a)).toBeGreaterThan(0);
  });
});
