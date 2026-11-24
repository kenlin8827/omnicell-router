import type { CredentialQuotaView } from './api';

/**
 * Probe-failure presentation — the honest answer to "covered, but empty".
 *
 * A covered pair with no numbers is NOT necessarily "waiting for its first
 * sync": the last attempt may have been rejected by the upstream (dead key →
 * 401), refused at plan level (MiniMax `base_resp.status_code: 2062`, Zhipu
 * `success: false`), or not parseable into windows at all. The backend keeps
 * that outcome — transport reason, the closed `verdict` it derived from a
 * STRUCTURED signal, the HTTP status and the upstream's own message — so these
 * surfaces can state WHY instead of showing a bare `unverified` badge, which
 * reads as "not synced yet" and is simply wrong.
 *
 * This module only TRANSLATES. It never inspects the upstream's sentence to
 * decide what happened: the sentence is vendor prose in the vendor's language,
 * and a classification built on it would be a per-vendor, per-language rule
 * set. The verdict code is decided server-side (backend `quota/verdict.ts`)
 * from statuses, envelope codes and declaration-table predicates.
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
  timeout: 'quotaPage.failTimeout',
};

/** Closed backend vocabulary (`QuotaProbeFailure.verdict`) → i18n key. */
const VERDICT_KEYS: Record<string, string> = {
  'credential-rejected': 'quotaPage.verdictCredential',
  'plan-inactive': 'quotaPage.verdictNoPlan',
  'endpoint-gone': 'quotaPage.verdictGone',
  'rate-limited': 'quotaPage.verdictRateLimited',
  'upstream-error': 'quotaPage.verdictUpstream',
  unreadable: 'quotaPage.verdictUnreadable',
  unreachable: 'quotaPage.failNetwork',
  timeout: 'quotaPage.failTimeout',
};

/** Human word for one failure reason (unknown codes fall through verbatim). */
export function failureReasonLabel(reason: string, t: TFn): string {
  const key = REASON_KEYS[reason];
  return key ? t(key) : reason;
}

/**
 * The verdict a user can ACT on, in their own language. The backend's closed
 * `verdict` code is the primary source; `reason` + status are only a fallback
 * for records written before the verdict field existed (an older build's
 * persisted failure map), so an upgraded console still says something better
 * than a raw token.
 */
export function failureVerdict(failure: NonNullable<CredentialQuotaView['lastFailure']>, t: TFn): string {
  const verdictKey = failure.verdict ? VERDICT_KEYS[failure.verdict] : undefined;
  if (verdictKey) return t(verdictKey);
  const status = failure.statusCode;
  if (status === 401 || status === 403) return t('quotaPage.verdictCredential');
  if (status === 404) return t('quotaPage.verdictGone');
  if (status === 429) return t('quotaPage.verdictRateLimited');
  return failureReasonLabel(failure.reason, t);
}

/**
 * One-line caption for a probe failure, verdict-first: the actionable
 * conclusion, then the upstream's own sentence as EVIDENCE (verbatim, never
 * translated), then the status/code only when the upstream said nothing at all
 * — a 200 that carries the answer needs no status decoration. Null when the
 * pair has no failure record (never attempted, or the last attempt succeeded).
 */
export function failureCaption(quota: CredentialQuotaView | undefined, t: TFn): string | null {
  const failure = quota?.lastFailure;
  if (!failure) return null;
  const parts = [failureVerdict(failure, t)];
  const msg = failure.message;
  if (msg && msg !== parts[0]) parts.push(t('quotaPage.upstreamSaid', { msg }));
  if (!msg && failure.statusCode !== undefined && failure.statusCode >= 400) {
    parts.push(t('quotaPage.failHttp', { status: failure.statusCode }));
  }
  return parts.join(' · ');
}

/**
 * The "these numbers are the last good read" prefix, used where a failing pair
 * still shows meters (`quotaPage.staleNumbers`). Null when there is nothing to
 * qualify. Kept next to the caption so both read the same timestamp.
 */
export function staleNumbersPrefix(quota: CredentialQuotaView | undefined, t: TFn, fmt: (ms: number) => string): string | null {
  const failure = quota?.lastFailure;
  if (!failure) return null;
  return t('quotaPage.staleNumbers', { when: fmt(Date.now() - failure.at) });
}

/** Localized state word for the badge pill: a pair whose covered-but-empty
 *  state has a recorded verdict reads "probe failed", never "unverified". */
export function quotaStateWord(quota: CredentialQuotaView, t: TFn): string {
  if (quota.badge === 'probed') return t('quotaPage.stateProbed');
  if (quota.badge === 'declared') return t('quotaPage.stateDeclared');
  if (quota.badge === 'stale') return t('quotaPage.stateStale');
  return quota.lastFailure ? t('quotaPage.stateFailed') : t('quotaPage.stateUnverified');
}

/**
 * Sync-failure verdict shared by every quota surface (page directory, page
 * summary strip, sidebar peek): a stale snapshot, or a covered pair whose
 * last probe has a recorded upstream verdict (dead key, plan refusal,
 * network). The status segments use it to split the directory; urgency
 * ranking sinks such pairs independently.
 */
export function quotaSyncFailed(quota: CredentialQuotaView | undefined): boolean {
  return quota?.badge === 'stale' || (quota?.badge === 'unverified' && !!quota.lastFailure);
}
