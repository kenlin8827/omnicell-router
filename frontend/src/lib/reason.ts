import type { ReasonParams } from './api';

/** Shape of `t` from useI18n, so this helper can live outside components. */
export type Translate = (path: string, params?: Record<string, string | number>) => string;

/**
 * Gateway reason vocabulary -> locale key. Codes not listed here, and rows
 * written before the gateway emitted codes at all, fall back to the raw English
 * `reason` so old traces never render blank.
 * `session.sticky` and `combo` are emitted by the gateway too (backend
 * session-manager / orchestrator) even though the original spec listed only the
 * codes above it — kept so those paths are not left in English.
 */
const REASON_KEY: Record<string, string> = {
  forced: 'routing.reason.forced',
  default: 'routing.reason.default',
  'l2.system_one': 'routing.reason.l2SystemOne',
  'l2.system_one_uncalibrated': 'routing.reason.l2SystemOneUncalibrated',
  'session.escalated': 'routing.reason.sessionEscalated',
  'session.ratchet': 'routing.reason.sessionRatchet',
  'session.preserved': 'routing.reason.sessionPreserved',
  'session.sticky': 'routing.reason.sessionSticky',
  combo: 'routing.reason.combo',
  // Circuit-breaker trip reasons (backend BreakerReasonCode): cause codes render
  // alone on a hard trip; trigger codes wrap a cause whose code rides along as
  // params.cause_code with its params flattened into the same map.
  'breaker.quota': 'guardrails.reasonQuota',
  'breaker.auth': 'guardrails.reasonAuth',
  'breaker.rate_limit': 'guardrails.reasonRateLimit',
  'breaker.network': 'guardrails.reasonNetwork',
  'breaker.unknown': 'guardrails.reasonUnknown',
  'breaker.canary': 'guardrails.reasonCanary',
  'breaker.consecutive': 'guardrails.reasonConsecutive',
  'breaker.rate_window': 'guardrails.reasonRateWindow',
  'breaker.manual': 'guardrails.reasonManual',
};

/**
 * Render one routing decision for an operator: the localized template for
 * `code` with `{key}` slots filled from `params` (confidence/threshold arrive
 * already on a 0-100 scale, so the locale strings carry the `%`), or the
 * verbatim `rawReason` when the code is unknown/absent.
 * `params.cached === true` marks a reused decision and prefixes a short label.
 */
export const formatReason = (
  code: string | undefined,
  params: ReasonParams | undefined,
  rawReason: string | undefined,
  t: Translate,
): string => {
  // Manual trip without an operator note: the console default is a label, not free text.
  if (code === 'breaker.manual' && !String(params?.detail ?? '')) return t('guardrails.reasonManualConsole');

  const key = code ? REASON_KEY[code] : undefined;
  let base = '';
  if (key) {
    const vars: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(params ?? {})) vars[k] = String(v);

    // Trigger templates render the wrapped cause into {detail} from the same flat
    // vars; an unknown cause_code keeps the raw English detail the backend sent.
    if (vars.cause_code) {
      const innerKey = REASON_KEY[vars.cause_code];
      if (innerKey) vars.detail = t(innerKey, vars);
    }

    const text = t(key, vars);
    // t() returns the key itself when no locale carries it — keep the gateway wording.
    base = text === key ? (rawReason ?? '') : params?.cached === true ? t('routing.reason.cachedPrefix') + text : text;
  } else {
    base = rawReason ?? '';
  }

  // Pin-switch attribution (Session-Pin Eviction, orchestrator 4B): the repin
  // trio rides in reasonParams beside whatever session.* code the turn already
  // carries, so it is appended as an explicit tail — the base templates never
  // reference {repin*} slots and would otherwise render the switch blind.
  if (params?.repin === undefined) return base;
  const cause = t(params.repin === 'health' ? 'routing.reason.repinHealth' : 'routing.reason.repinConfig');
  return `${base}${t('routing.reason.repinSuffix', {
    repinFrom: String(params.repinFrom ?? '?'),
    repinTo: String(params.repinTo ?? '?'),
    cause,
  })}`;
};
