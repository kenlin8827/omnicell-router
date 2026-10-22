import { useCallback, useRef, useState } from 'react';
import { api } from './api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';

/** Optional scope: one (provider × credential) pair, or omit for the whole
 *  schedule (every covered pair). */
export interface QuotaRefreshTarget {
  providerId: string;
  keyHashPrefix: string;
}

/** Sentinel slot for the global (whole-schedule) refresh. */
const GLOBAL = '*';

/**
 * One manual quota refresh, shared by every quota surface (the /admin/quota
 * page header, each pair card, and the sidebar peek) — a single
 * implementation of the toast contract, so the busy / 429 / partial-budget
 * wording can never drift between the places that offer the action.
 *
 * The POST is synchronous by design (it invalidates, then runs ONE bounded
 * probe cycle inside the request, ADR-0009 §7), so awaiting `reload` after it
 * genuinely reads the fresh snapshot. Scoping to a pair is the cheap path
 * (one upstream request instead of the whole directory).
 */
export function useQuotaRefresh(reload: () => void | Promise<void>) {
  const { t } = useI18n();
  const toast = useToast();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // Re-entry guard is a ref, not the state flag: two clicks inside one tick
  // would both read a stale snapshot of `pending` from their closure.
  const inFlight = useRef(new Set<string>());

  const refresh = useCallback(
    async (target?: QuotaRefreshTarget) => {
      const slot = target ? `${target.providerId}#${target.keyHashPrefix}` : GLOBAL;
      if (inFlight.current.has(slot)) return;
      inFlight.current.add(slot);
      setPending((prev) => new Set(prev).add(slot));
      try {
        const res = await api.refreshQuota(target).catch(() => null);
        await reload();
        if (!res) toast.error(t('quotaPage.refreshUnavailable'));
        else if (res.reasonCode === 'busy') toast.info(t('quotaPage.refreshBusy'));
        else if (!res.success) toast.error(t('quotaPage.refreshUnavailable'));
        else if (res.rateLimited) toast.info(t('quotaPage.refreshRateLimited'));
        else if ((res.pending ?? 0) > 0) {
          toast.info(t('quotaPage.refreshPartial', { n: res.probed ?? 0, pending: res.pending ?? 0 }));
        } else toast.success(t('quotaPage.refreshDone', { n: res.probed ?? 0 }));
      } finally {
        inFlight.current.delete(slot);
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(slot);
          return next;
        });
      }
    },
    [reload, t, toast]
  );

  const slotOf = (target?: QuotaRefreshTarget) =>
    target ? `${target.providerId}#${target.keyHashPrefix}` : GLOBAL;

  return {
    refresh,
    /** Is THIS scope (or the global one when omitted) in flight? */
    isRefreshing: (target?: QuotaRefreshTarget) => pending.has(slotOf(target)),
    /** Any refresh in flight — the global button yields to a running one. */
    busy: pending.size > 0,
  };
}
