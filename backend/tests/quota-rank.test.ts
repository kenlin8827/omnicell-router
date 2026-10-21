import { describe, expect, it } from 'bun:test';
import { byQuotaUrgency, byWindowClass, headlineWindow, quotaUrgencyRank, windowClassRank } from '../../frontend/src/lib/quotaRank';
import type { QuotaPairRow, QuotaWindow } from '../../frontend/src/lib/api';

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

// ─── Window class order + headline pick ─────────────────────────────────────

function win(over: Partial<QuotaWindow> & { name: string }): QuotaWindow {
  return { used: 0, total: 100, remainingPct: 50, resetAt: null, unlimited: false, ...over };
}

describe('windowClassRank / byWindowClass', () => {
  it('ranks session < weekly < monthly < unknown < pools', () => {
    expect(windowClassRank(win({ name: 's', nameCode: 'session5h' }))).toBe(0);
    expect(windowClassRank(win({ name: 's', nameCode: 'sessionHours' }))).toBe(0);
    expect(windowClassRank(win({ name: 's', nameCode: 'rolling' }))).toBe(0);
    expect(windowClassRank(win({ name: 'w', nameCode: 'weekly' }))).toBe(1);
    expect(windowClassRank(win({ name: 'm', nameCode: 'monthly' }))).toBe(2);
    expect(windowClassRank(win({ name: 'x', nameCode: 'whatever' }))).toBe(3);
    expect(windowClassRank(win({ name: 'y' }))).toBe(3);
    expect(windowClassRank(win({ name: 'b', nameCode: 'balance' }))).toBe(4);
    expect(windowClassRank(win({ name: 'c', nameCode: 'credits' }))).toBe(4);
  });

  it('sorts session first and keeps declaration order inside a class', () => {
    const weekly = win({ name: 'Weekly', nameCode: 'weekly', remainingPct: 10 });
    const session = win({ name: 'Session (5h)', nameCode: 'session5h', remainingPct: 90 });
    const balance = win({ name: 'Balance (CNY)', nameCode: 'balance', remainingPct: null, total: 12 });
    const sorted = [weekly, balance, session].sort(byWindowClass).map((w) => w.name);
    expect(sorted).toEqual(['Session (5h)', 'Weekly', 'Balance (CNY)']);
  });
});

describe('headlineWindow', () => {
  it('a session window headlines over a TIGHTER weekly', () => {
    const windows = [
      win({ name: 'Weekly', nameCode: 'weekly', remainingPct: 5 }),
      win({ name: 'Session (5h)', nameCode: 'session5h', remainingPct: 90 }),
    ];
    expect(headlineWindow(windows)?.name).toBe('Session (5h)');
  });

  it('within one class the scarcest window wins', () => {
    const windows = [
      win({ name: 'A', nameCode: 'sessionHours', remainingPct: 60 }),
      win({ name: 'B', nameCode: 'sessionHours', remainingPct: 40 }),
    ];
    expect(headlineWindow(windows)?.name).toBe('B');
  });

  it('skips balances, unlimited and pct-less windows; falls back to weekly', () => {
    const windows = [
      win({ name: 'Balance (CNY)', nameCode: 'balance', remainingPct: null }),
      win({ name: 'Free', remainingPct: null, total: null, unlimited: true }),
      win({ name: 'Weekly', nameCode: 'weekly', remainingPct: 70 }),
    ];
    expect(headlineWindow(windows)?.name).toBe('Weekly');
    expect(headlineWindow(windows.slice(0, 2))).toBeNull();
    expect(headlineWindow([])).toBeNull();
  });
});
