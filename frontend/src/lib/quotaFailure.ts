import type { CredentialQuotaView } from './api';

/**
 * Probe-failure presentation — the honest answer to "covered, but empty".
 *
 * A covered pair with no numbers is NOT necessarily "waiting for its first
 * sync": the last attempt may have been rejected by the upstream (dead key →
 * 401), refused at plan level (MiniMax `base_resp.status_code: 2062 "no active
 * token plan subscription"`), or failed to parse. The backend keeps that
 * verdict (transport reason + HTTP status + the upstream's own short message)
 * so these surfaces can state WHY instead of showing a bare `unverified`
 * badge, which reads as "not synced yet" and is simply wrong.
 *
 * Display-only, like every quota surface: nothing here gates routing.
 */

export type TFn = (path: string, params?: Record<string, string | number>) => string;

/** Closed backend vocabulary (`QuotaProbeFailure.reason`) → i18n key. */
const REASON_KEYS: Record<string, string> = {
  auth: 'quotaPage.failAuth',
  status: 'quotaPage.failStatus',
  shape: 'quotaPage.failShape',
  network: 'quotaPage.failNetwork',
};

/** Human word for one failure reason (unknown codes fall through verbatim). */
export function failureReasonLabel(reason: string, t: TFn): string {
  const key = REASON_KEYS[reason];
  return key ? t(key) : reason;
}

/**
 * One-line caption for a probe failure: reason word, then the upstream's own
 * message, then the HTTP status. Null when the pair has no failure record
 * (never attempted, or the last attempt succeeded).
 */
export function failureCaption(quota: CredentialQuotaView | undefined, t: TFn): string | null {
  const failure = quota?.lastFailure;
  if (!failure) return null;
  const parts = [failureReasonLabel(failure.reason, t)];
  if (failure.message) parts.push(failure.message);
  if (failure.statusCode !== undefined) parts.push(t('quotaPage.failHttp', { status: failure.statusCode }));
  return parts.join(' · ');
}

/** Localized state word for the badge pill: a pair whose covered-but-empty
 *  state has a recorded verdict reads "probe failed", never "unverified". */
export function quotaStateWord(quota: CredentialQuotaView, t: TFn): string {
  if (quota.badge === 'probed') return t('quotaPage.stateProbed');
  if (quota.badge === 'declared') return t('quotaPage.stateDeclared');
  if (quota.badge === 'stale') return t('quotaPage.stateStale');
  return quota.lastFailure ? t('quotaPage.stateFailed') : t('quotaPage.stateUnverified');
}
