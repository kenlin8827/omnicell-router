import type { QuotaPairRow } from './api';

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
