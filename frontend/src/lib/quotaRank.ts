import type { QuotaPairRow, QuotaWindow } from './api';

/**
 * Window-class order for display: short-period caps first — a rolling
 * session window (5h) throttles the NEXT request, the weekly/monthly cap is
 * the slower burn — credit pools last. Classes ride the window's nameCode
 * (the machine-readable identity the declaration table and the console i18n
 * table share); unknown or codeless windows (forked entries, legacy
 * snapshots) sit in the middle band.
 */
const WINDOW_CLASS_RANK: Record<string, number> = {
  session5h: 0,
  sessionHours: 0,
  modelSession: 0,
  rolling: 0,
  weekly: 1,
  weekly7d: 1,
  modelWeekly: 1,
  monthly: 2,
  credits: 4,
  balance: 4,
};

export function windowClassRank(w: QuotaWindow): number {
  return (w.nameCode ? WINDOW_CLASS_RANK[w.nameCode] : undefined) ?? 3;
}

/** Stable class comparator for window lists (quota page meters, badge
 *  tooltip): class rank decides, declaration order breaks ties. */
export function byWindowClass(a: QuotaWindow, b: QuotaWindow): number {
  return windowClassRank(a) - windowClassRank(b);
}

/**
 * The window a compact surface headlines: the scarcest window of the
 * shortest-period class present — a 5h session leads over a weekly even
 * when the weekly is tighter, because the session is what throttles the
 * next request. Cash balances and capless windows carry no burn signal and
 * never headline.
 */
export function headlineWindow(windows: QuotaWindow[]): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const w of windows) {
    if (w.unlimited || w.remainingPct === null || w.nameCode === 'balance') continue;
    if (best === null) {
      best = w;
      continue;
    }
    const d = windowClassRank(w) - windowClassRank(best);
    if (d < 0 || (d === 0 && (w.remainingPct as number) < (best.remainingPct as number))) best = w;
  }
  return best;
}

/**
 * Urgency rank for the quota directory and the sidebar peek — lower sorts
 * first. The surfaces' job is surfacing pairs about to run dry, so the
 * scarcest percentage window leads (drained <10% above tight <25% above
 * healthy, each band ordered ascending), then cash balances (drained first),
 * then sync-failed rows whose last read may be wrong, then pairs with no
 * trustworthy read at all.
 */
export function quotaUrgencyRank(r: QuotaPairRow): number {
  const windows = r.quota?.windows ?? [];
  let worst: number | null = null;
  let balance: number | null = null;
  for (const w of windows) {
    if (w.nameCode === 'balance' && w.total !== null) {
      const left = Math.max(0, (w.total ?? 0) - (w.used ?? 0));
      balance = balance === null ? left : Math.min(balance, left);
      continue;
    }
    if (!w.unlimited && w.remainingPct !== null) worst = worst === null ? w.remainingPct : Math.min(worst, w.remainingPct);
  }
  if (worst !== null) return worst < 10 ? worst : worst < 25 ? 100 + worst : 200 + worst;
  if (balance !== null) return balance <= 0 ? 310 : 320;
  if (r.quota?.badge === 'stale') return 350;
  return r.quota ? 400 : 450;
}

/** Shared comparator: urgency first, ties broken on pair identity so the
 *  order stays deterministic across reloads. */
export function byQuotaUrgency(a: QuotaPairRow, b: QuotaPairRow): number {
  const d = quotaUrgencyRank(a) - quotaUrgencyRank(b);
  if (d !== 0) return d;
  const an = `${a.providerId}#${a.keyHashPrefix}`;
  const bn = `${b.providerId}#${b.keyHashPrefix}`;
  return an < bn ? -1 : an > bn ? 1 : 0;
}
