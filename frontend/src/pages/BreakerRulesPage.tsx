import React, { useState, useMemo, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Settings2, AlertTriangle } from 'lucide-react';
import {
  api,
  type GatewayStatusResponse,
  type BreakerRulesStatus,
  type CircuitBreakerConfig,
  type ResolvedBreakerRules,
  type BreakerScopeOverride,
  type OnCanaryFailureMode,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { Switch } from '../components/Switch';

/* ═══════════════════════════════════════════════════════════════════════════
 * Breaker-rules page — Configuration UX contract (spec
 * docs/design/circuit-breaker-rules-config.md): three collapsible blocks A/B/C
 * (native <details>, default expanded, live state badge per summary), one
 * disposition table, `auto | custom` on every numeric input, human
 * blast-radius Comboboxes, shadow switch, five-switch summary, restart note.
 * Wire truth: `circuitBreaker.rules` carries materialized booleans/enums;
 * an ABSENT numeric key = "auto" (inherit the global knob) — the toggle maps
 * to key presence/absence exactly (undefined → dropped by JSON.stringify).
 * Live banner/resolved values ride the Layout status poll (outlet context);
 * the draft is fetched once from GET /api/admin/config and saved via POST.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Today's hardcoded fallbacks (mirror of backend resolveBreakerRules), used
 *  only when a pre-rules gateway omits the effective ruleset from status. */
const CB_KNOB_DEFAULTS = {
  failureThreshold: 3,
  slidingWindowSize: 20,
  failureRateThreshold: 0.5,
  initialCooldownMs: 30_000,
  maxCooldownMs: 5 * 3600 * 1000,
  cooldownMultiplier: 2.0,
  quotaCooldownMs: 12 * 3600 * 1000,
  halfOpenMaxProbes: 1,
};

const fmtPlain = (n: number): string => (Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(4))));

/** 12h / 5h / 60s / 2s — hours from 1h up, seconds below (wireframe units). */
const fmtMs = (ms: number): string =>
  ms >= 3_600_000 ? `${fmtPlain(ms / 3_600_000)}h` : `${fmtPlain(ms / 1000)}s`;

const asScope = (v: string): BreakerScopeOverride =>
  v === 'pair' || v === 'account' || v === 'model' ? v : 'auto';
const asCanary = (v: string): OnCanaryFailureMode => (v === 'initial' || v === 'close' ? v : 'backoff');

/** Client-side mirror of backend resolveBreakerRules — the fallback view of
 *  "auto" live values when the running gateway predates the rules snapshot. */
function deriveResolvedRules(cb: CircuitBreakerConfig, maxRateLimitWaitMs?: number): ResolvedBreakerRules {
  const num = (v: number | undefined, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
  const bool = (v: boolean | undefined, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const r = cb.rules ?? {};
  const initial = num(cb.initialCooldownMs, CB_KNOB_DEFAULTS.initialCooldownMs);
  const maxCd = num(cb.maxCooldownMs, CB_KNOB_DEFAULTS.maxCooldownMs);
  const quotaCd = num(cb.quotaCooldownMs, CB_KNOB_DEFAULTS.quotaCooldownMs);
  const gMult = num(cb.cooldownMultiplier, CB_KNOB_DEFAULTS.cooldownMultiplier);
  const gWindow = Math.max(1, Math.floor(num(cb.slidingWindowSize, CB_KNOB_DEFAULTS.slidingWindowSize)));
  const maxProbes = Math.max(1, Math.floor(num(r.recovery?.halfOpen?.maxProbes ?? cb.halfOpenMaxProbes, CB_KNOB_DEFAULTS.halfOpenMaxProbes)));
  const windowSize = Math.max(1, Math.floor(num(r.trip?.failureRate?.windowSize, gWindow)));
  // Sanitizer clamps (spec invariant 5): minCalls <= windowSize, successThreshold <= maxProbes.
  const minCalls = Math.min(Math.max(0, Math.floor(num(r.trip?.failureRate?.minCalls, windowSize))), windowSize);
  const rate = r.trip?.failureRate?.failureRate;
  return {
    shadow: bool(cb.shadow, false),
    counting: {
      serverErrors: {
        enabled: bool(r.counting?.serverErrors?.enabled, true),
        minCooldownMs: num(r.counting?.serverErrors?.minCooldownMs, initial),
      },
      unknownErrors: {
        enabled: bool(r.counting?.unknownErrors?.enabled, true),
        minCooldownMs: num(r.counting?.unknownErrors?.minCooldownMs, initial),
      },
      rateLimitErrors: { minCooldownMs: num(r.counting?.rateLimitErrors?.minCooldownMs, Math.min(60_000, initial)) },
      clientErrors: { enabled: bool(r.counting?.clientErrors?.enabled, false) },
    },
    trip: {
      quota: {
        enabled: bool(r.trip?.quota?.enabled, true),
        cooldownMs: num(r.trip?.quota?.cooldownMs, quotaCd),
        scope: asScope(r.trip?.quota?.scope ?? 'auto'),
      },
      auth: {
        enabled: bool(r.trip?.auth?.enabled, true),
        cooldownMs: num(r.trip?.auth?.cooldownMs, quotaCd),
        markSuspect: bool(r.trip?.auth?.markSuspect, true),
        scope: asScope(r.trip?.auth?.scope ?? 'auto'),
      },
      rateLimit: {
        enabled: bool(r.trip?.rateLimit?.enabled, true),
        // Default borrowed from the retry family; the breaker copy never rewrites it.
        hardTripAboveMs: num(r.trip?.rateLimit?.hardTripAboveMs, maxRateLimitWaitMs ?? 2000),
        minCooldownMs: num(r.trip?.rateLimit?.minCooldownMs, 1000),
        scope: asScope(r.trip?.rateLimit?.scope ?? 'auto'),
      },
      consecutiveFailures: {
        enabled: bool(r.trip?.consecutiveFailures?.enabled, true),
        threshold: Math.max(1, Math.floor(num(r.trip?.consecutiveFailures?.threshold, num(cb.failureThreshold, CB_KNOB_DEFAULTS.failureThreshold)))),
        initialCooldownMs: num(r.trip?.consecutiveFailures?.initialCooldownMs, initial),
        cooldownMultiplier: num(r.trip?.consecutiveFailures?.cooldownMultiplier, gMult),
        maxCooldownMs: num(r.trip?.consecutiveFailures?.maxCooldownMs, maxCd),
        scope: asScope(r.trip?.consecutiveFailures?.scope ?? 'auto'),
      },
      failureRate: {
        enabled: bool(r.trip?.failureRate?.enabled, true),
        windowSize,
        failureRate:
          typeof rate === 'number' && rate >= 0 && rate <= 1
            ? rate
            : num(cb.failureRateThreshold, CB_KNOB_DEFAULTS.failureRateThreshold),
        minCalls,
        cooldownMs: num(r.trip?.failureRate?.cooldownMs, initial),
        scope: asScope(r.trip?.failureRate?.scope ?? 'auto'),
      },
    },
    recovery: {
      onCanaryFailure: r.recovery?.onCanaryFailure === 'initial' || r.recovery?.onCanaryFailure === 'close' ? r.recovery.onCanaryFailure : 'backoff',
      cooldownMultiplier: num(r.recovery?.cooldownMultiplier, gMult),
      halfOpen: {
        maxProbes,
        successThreshold: Math.min(Math.max(1, Math.floor(num(r.recovery?.halfOpen?.successThreshold, 1))), maxProbes),
        maxWaitMs: num(r.recovery?.halfOpen?.maxWaitMs, 0),
      },
    },
  };
}

/** Materialize the booleans/enums the backend sanitizer would (legacy GET with
 *  no `rules` = today's behavior); numeric params STAY undefined = "auto". */
function hydrateCb(cb: CircuitBreakerConfig): CircuitBreakerConfig {
  const r = cb.rules ?? {};
  const c = r.counting ?? {};
  const t = r.trip ?? {};
  const rec = r.recovery ?? {};
  return {
    ...cb,
    shadow: cb.shadow ?? false,
    activeProbing: { enabled: cb.activeProbing?.enabled ?? false, intervalMs: cb.activeProbing?.intervalMs },
    rules: {
      counting: {
        serverErrors: { enabled: c.serverErrors?.enabled ?? true, minCooldownMs: c.serverErrors?.minCooldownMs },
        unknownErrors: { enabled: c.unknownErrors?.enabled ?? true, minCooldownMs: c.unknownErrors?.minCooldownMs },
        rateLimitErrors: { minCooldownMs: c.rateLimitErrors?.minCooldownMs },
        clientErrors: { enabled: c.clientErrors?.enabled ?? false },
      },
      trip: {
        quota: { enabled: t.quota?.enabled ?? true, cooldownMs: t.quota?.cooldownMs, scope: asScope(t.quota?.scope ?? 'auto') },
        auth: { enabled: t.auth?.enabled ?? true, cooldownMs: t.auth?.cooldownMs, markSuspect: t.auth?.markSuspect ?? true, scope: asScope(t.auth?.scope ?? 'auto') },
        rateLimit: { enabled: t.rateLimit?.enabled ?? true, hardTripAboveMs: t.rateLimit?.hardTripAboveMs, minCooldownMs: t.rateLimit?.minCooldownMs, scope: asScope(t.rateLimit?.scope ?? 'auto') },
        consecutiveFailures: { enabled: t.consecutiveFailures?.enabled ?? true, threshold: t.consecutiveFailures?.threshold, initialCooldownMs: t.consecutiveFailures?.initialCooldownMs, cooldownMultiplier: t.consecutiveFailures?.cooldownMultiplier, maxCooldownMs: t.consecutiveFailures?.maxCooldownMs, scope: asScope(t.consecutiveFailures?.scope ?? 'auto') },
        failureRate: { enabled: t.failureRate?.enabled ?? true, windowSize: t.failureRate?.windowSize, failureRate: t.failureRate?.failureRate, minCalls: t.failureRate?.minCalls, cooldownMs: t.failureRate?.cooldownMs, scope: asScope(t.failureRate?.scope ?? 'auto') },
      },
      recovery: {
        onCanaryFailure: asCanary(rec.onCanaryFailure ?? 'backoff'),
        cooldownMultiplier: rec.cooldownMultiplier,
        halfOpen: { maxProbes: rec.halfOpen?.maxProbes, successThreshold: rec.halfOpen?.successThreshold, maxWaitMs: rec.halfOpen?.maxWaitMs },
      },
    },
  };
}

/** rules.<family>.<rule> immutable key-by-key patch. Structural record view:
 *  the rules tree is exactly nested records keyed by the backend contract names. */
function patchRule(
  cb: CircuitBreakerConfig,
  family: 'counting' | 'trip' | 'recovery',
  ruleName: string,
  patch: Record<string, unknown>
): CircuitBreakerConfig {
  const rulesRec = (cb.rules ?? {}) as unknown as Record<string, Record<string, Record<string, unknown>>>;
  const fam = { ...(rulesRec[family] ?? {}) };
  fam[ruleName] = { ...(fam[ruleName] ?? {}), ...patch };
  const next = { ...(cb.rules ?? {}), [family]: fam } as CircuitBreakerConfig['rules'];
  return { ...cb, rules: next };
}

/** "automatic tripping: on / partly off / all off (!) / shadow" (UX rule 6). */
function autoTrippingView(
  t: (key: string, params?: Record<string, string | number>) => string,
  st?: BreakerRulesStatus
): { text: string; color: string } {
  if (!st) return { text: t('breakerRules.stateUnknown'), color: 'var(--text-dim)' };
  if (st.shadow) return { text: t('breakerRules.stateShadow'), color: 'var(--accent-violet)' };
  switch (st.automatic) {
    case 'on':
      return { text: t('breakerRules.stateOn'), color: 'var(--accent-emerald)' };
    case 'partly_off':
      return { text: t('breakerRules.statePartly'), color: 'var(--accent-amber)' };
    default:
      return { text: `${t('breakerRules.stateAllOff')} (!)`, color: 'var(--accent-rose)' };
  }
}

type FieldUnit = 'ms' | 'msNever' | 'int' | 'mult' | 'percent';

interface AutoFieldProps {
  label: string;
  /** Draft value: undefined = "auto" (absent key on save). */
  value: number | undefined;
  /** Live inherited value shown in "auto" mode (from ResolvedBreakerRules). */
  live: number;
  unit: FieldUnit;
  /** auto mode tooltip — the inherited global knob's config key. */
  autoKnob: string;
  /** custom mode tooltip — this param's own yaml key (raw keys live in tooltips only). */
  keyName: string;
  onChange: (v: number | undefined) => void;
}

/** UX binding rule 3: `auto | custom` toggle on every numeric input — auto is
 *  gray text with the live inherited value (knob name in tooltip); custom opens
 *  an input. auto ⇔ absent key. */
const AutoField: React.FC<AutoFieldProps> = ({ label, value, live, unit, autoKnob, keyName, onChange }) => {
  const { t } = useI18n();
  const custom = value !== undefined;
  const fmt = (n: number): string => {
    if (unit === 'ms') return fmtMs(n);
    if (unit === 'msNever') return n === 0 ? t('breakerRules.never') : fmtMs(n);
    if (unit === 'percent') return `${fmtPlain(n * 100)}%`;
    return fmtPlain(n);
  };
  const suffix = unit === 'ms' || unit === 'msNever' ? 'ms' : unit === 'percent' ? '%' : '';
  const shown = custom ? (unit === 'percent' ? value * 100 : value) : 0;
  const seg: React.CSSProperties = { fontSize: 12, padding: '6px 12px', borderRadius: 0, border: 'none' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
      <span>{label}</span>
      <span style={{ display: 'inline-flex', border: '1px solid var(--card-border)', borderRadius: 7, overflow: 'hidden' }}>
        <button
          type="button"
          aria-pressed={!custom}
          title={autoKnob}
          onClick={() => onChange(undefined)}
          style={{ ...seg, background: custom ? 'transparent' : 'var(--btn-primary-bg)', color: custom ? 'var(--text-dim)' : 'var(--btn-primary-text)' }}
        >
          {t('breakerRules.auto')}
        </button>
        <button
          type="button"
          aria-pressed={custom}
          title={keyName}
          onClick={() => onChange(custom ? value : live)}
          style={{ ...seg, background: custom ? 'var(--btn-primary-bg)' : 'transparent', color: custom ? 'var(--btn-primary-text)' : 'var(--text-dim)' }}
        >
          {t('breakerRules.custom')}
        </button>
      </span>
      {custom ? (
        <>
          <input
            type="number"
            className="input"
            min={0}
            step={unit === 'int' ? 1 : 'any'}
            aria-label={`${label} (${keyName})`}
            title={keyName}
            value={String(shown)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) onChange(unit === 'percent' ? Math.min(n, 100) / 100 : n);
            }}
            style={{ width: 96, padding: '6px 10px', fontSize: 13 }}
          />
          {suffix && <span style={{ color: 'var(--text-dim)' }}>{suffix}</span>}
        </>
      ) : (
        <span style={{ color: 'var(--text-dim)' }} title={autoKnob}>
          {t('breakerRules.autoValue', { v: fmt(live) })}
        </span>
      )}
    </span>
  );
};

/** UX binding rule 4: unavailable parameter cells render "--" (disabled), never an empty box. */
const Dash: React.FC<{ title?: string }> = ({ title }) => (
  <span style={{ color: 'var(--text-dim)' }} title={title}>
    --
  </span>
);

const Params: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px' }}>{children}</div>
);

const BREAKER_SCOPE_VALUES: BreakerScopeOverride[] = ['auto', 'pair', 'account', 'model'];
const SCOPE_R_KEY: Record<BreakerScopeOverride, string> = {
  auto: 'breakerRules.rScopeAuto',
  pair: 'breakerRules.rScopePair',
  account: 'breakerRules.rScopeAccount',
  model: 'breakerRules.rScopeModel',
};
const CANARY_R_KEY: Record<OnCanaryFailureMode, string> = {
  backoff: 'breakerRules.canaryBackoff',
  initial: 'breakerRules.canaryInitial',
  close: 'breakerRules.canaryClose',
};

interface BreakerRulesSectionProps {
  /** Effective (startup-resolved) ruleset + banner state from /api/admin/status. */
  live?: BreakerRulesStatus;
}

const BreakerRulesSection: React.FC<BreakerRulesSectionProps> = ({ live }) => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [cb, setCb] = useState<CircuitBreakerConfig | null>(null);
  const [retryBoundary, setRetryBoundary] = useState<number | undefined>(undefined);
  const [loadErr, setLoadErr] = useState(false);
  const [saving, setSaving] = useState(false);
  // Collapsible A/B/C blocks — default expanded (spec: first-time reading
  // order stays visible); the open flags only drive summary chevron rotation.
  const [openBlocks, setOpenBlocks] = useState({ a: true, b: true, c: true });
  const toggleBlock =
    (k: 'a' | 'b' | 'c') =>
    (e: React.SyntheticEvent<HTMLDetailsElement>) =>
      setOpenBlocks((prev) => ({ ...prev, [k]: e.currentTarget.open }));

  const applyConfig = (cfg: any) => {
    // api.getConfig is the untyped RouterConfig round-trip (SettingsPage pattern).
    setCb(hydrateCb((cfg?.circuitBreaker ?? {}) as CircuitBreakerConfig));
    const boundary = cfg?.retry?.inplace?.maxRateLimitWaitMs;
    setRetryBoundary(typeof boundary === 'number' ? boundary : undefined);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (!cancelled) applyConfig(cfg);
      })
      .catch(() => {
        if (!cancelled) setLoadErr(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (fn: (prev: CircuitBreakerConfig) => CircuitBreakerConfig) =>
    setCb((prev) => (prev ? fn(prev) : prev));
  const rulePatch = (
    family: 'counting' | 'trip' | 'recovery',
    ruleName: string,
    values: Record<string, unknown>
  ) => patch((prev) => patchRule(prev, family, ruleName, values));

  const blastOptions = useMemo(
    () => BREAKER_SCOPE_VALUES.map((s) => ({ value: s, label: t(SCOPE_R_KEY[s]) })),
    [t]
  );
  const canaryOptions = useMemo(
    () =>
      (['backoff', 'initial', 'close'] as OnCanaryFailureMode[]).map((v) => ({
        value: v,
        label: t(CANARY_R_KEY[v]),
      })),
    [t]
  );
  const dispOptions = useMemo(() => {
    const k = (key: string) => ({ value: key, label: t(`breakerRules.${key}`) });
    return {
      hard: [k('dispTripAbove'), k('dispCountOnly')],
      tripIgnore: [k('dispTripNow'), k('dispIgnore')],
      countIgnore: [k('dispCountIt'), k('dispIgnore')],
      ignoreCount: [k('dispIgnore'), k('dispCountIt')],
    };
  }, [t]);

  const view = autoTrippingView(t, live);

  const handleSave = async () => {
    if (!cb) return;
    const trip = cb.rules?.trip ?? {};
    const switches = [
      trip.quota?.enabled,
      trip.auth?.enabled,
      trip.rateLimit?.enabled,
      trip.consecutiveFailures?.enabled,
      trip.failureRate?.enabled,
    ];
    // Five-switch predicate (spec "Zero-rule state"): off iff ALL five are off.
    const zeroRules = switches.every((s) => s === false);
    if (zeroRules) {
      const ok = await confirmDialog({
        title: t('breakerRules.zeroTitle'),
        description: t('breakerRules.zeroDesc'),
        danger: true,
        confirmLabel: t('breakerRules.zeroConfirm'),
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      // Whole-section replace is how saveConfig merges (`{...current, ...body}`);
      // the draft round-trips the full circuitBreaker object, undefined
      // numeric keys JSON-drop = "auto" = absent yaml key.
      await api.saveConfig({ circuitBreaker: cb });
      toast.success(t('breakerRules.savedToast'));
    } catch (err: any) {
      toast.error(t('breakerRules.saveFailed') + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    try {
      applyConfig(await api.getConfig());
      toast.info(t('breakerRules.discardedToast'));
    } catch {
      // Discard reloads the saved config — a failure here is a load, not a save.
      toast.error(t('breakerRules.loadFailed'));
    }
  };

  if (loadErr) {
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Settings2 size={18} color="var(--accent-rose)" />
            <span>{t('breakerRules.sectionTitle')}</span>
          </div>
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('breakerRules.loadFailed')}</div>
      </div>
    );
  }

  if (!cb) {
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Settings2 size={18} color="var(--accent)" />
            <span>{t('breakerRules.sectionTitle')}</span>
          </div>
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('breakerRules.loading')}</div>
      </div>
    );
  }

  const r = cb.rules ?? {};
  const counting = r.counting ?? {};
  const trip = r.trip ?? {};
  const rec = r.recovery ?? {};
  const halfOpen = rec.halfOpen ?? {};
  const resolved = live?.rules ?? deriveResolvedRules(cb, retryBoundary);

  // Disposition = the materialized boolean of the owning switch (UX rule 2).
  const quotaTrip = trip.quota?.enabled !== false;
  const authTrip = trip.auth?.enabled !== false;
  const rateHard = trip.rateLimit?.enabled !== false;
  const serverCount = counting.serverErrors?.enabled !== false;
  const unknownCount = counting.unknownErrors?.enabled !== false;
  const clientCount = counting.clientErrors?.enabled === true;
  const consOn = trip.consecutiveFailures?.enabled !== false;
  const rateDetOn = trip.failureRate?.enabled !== false;
  // Block A badge — classes with a non-ignore disposition; 429 has no ignore
  // option (UX rule 2), so it counts unconditionally.
  const handled = [quotaTrip, authTrip, true, serverCount, unknownCount, clientCount].filter(
    Boolean
  ).length;
  const detectorsOn = (consOn ? 1 : 0) + (rateDetOn ? 1 : 0);

  const blast = (family: 'trip', ruleName: string, value: BreakerScopeOverride | undefined) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('breakerRules.pBlast')}</span>
      <Combobox
        value={value ?? 'auto'}
        onChange={(v) => rulePatch(family, ruleName, { scope: asScope(v) })}
        options={blastOptions}
        panelMinWidth={230}
        style={{ fontSize: 12, padding: '6px 10px', width: 170 }}
      />
    </span>
  );

  const disp = (
    options: { value: string; label: string }[],
    value: string,
    onPick: (v: string) => void
  ) => (
    <Combobox
      value={value}
      onChange={onPick}
      options={options}
      panelMinWidth={210}
      style={{ fontSize: 12, padding: '6px 10px', width: '100%' }}
    />
  );

  const th: React.CSSProperties = {
    textAlign: 'left',
    fontWeight: 600,
    fontSize: 11,
    color: 'var(--text-dim)',
    padding: '6px 8px',
    borderBottom: '1px solid var(--card-border)',
  };
  const td: React.CSSProperties = {
    padding: '7px 8px',
    verticalAlign: 'middle',
    borderBottom: '1px solid var(--card-border)',
    fontSize: 12,
  };

  // Collapsible block headers (native <details>/<summary>, RulesPage pattern):
  // marker hidden, manual chevron rotates right when closed. Badge shows the
  // block's live state so a collapsed block still answers "what's in here?".
  const blockSummary: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--text-muted)',
    margin: '16px 0 8px',
    cursor: 'pointer',
    userSelect: 'none',
    listStyle: 'none',
  };
  const blockChev: React.CSSProperties = {
    fontSize: 9,
    width: 10,
    flexShrink: 0,
    transition: 'transform 0.15s ease',
  };
  const blockBadge: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 400,
    color: 'var(--text-dim)',
    borderColor: 'var(--card-border)',
    whiteSpace: 'nowrap',
  };

  const defaultRows: { label: string; value: string; key: string; note?: string }[] = [
    { label: t('breakerRules.kEnabled'), value: cb.enabled === false ? t('breakerRules.stateOff') : t('breakerRules.stateOn'), key: 'circuitBreaker.enabled' },
    { label: t('breakerRules.kFailureThreshold'), value: fmtPlain(cb.failureThreshold ?? CB_KNOB_DEFAULTS.failureThreshold), key: 'circuitBreaker.failureThreshold' },
    { label: t('breakerRules.kWindow'), value: fmtPlain(cb.slidingWindowSize ?? CB_KNOB_DEFAULTS.slidingWindowSize), key: 'circuitBreaker.slidingWindowSize' },
    { label: t('breakerRules.kRate'), value: `${fmtPlain((cb.failureRateThreshold ?? CB_KNOB_DEFAULTS.failureRateThreshold) * 100)}%`, key: 'circuitBreaker.failureRateThreshold' },
    { label: t('breakerRules.kInitial'), value: fmtMs(cb.initialCooldownMs ?? CB_KNOB_DEFAULTS.initialCooldownMs), key: 'circuitBreaker.initialCooldownMs' },
    { label: t('breakerRules.kMax'), value: fmtMs(cb.maxCooldownMs ?? CB_KNOB_DEFAULTS.maxCooldownMs), key: 'circuitBreaker.maxCooldownMs' },
    { label: t('breakerRules.kMult'), value: `x${fmtPlain(cb.cooldownMultiplier ?? CB_KNOB_DEFAULTS.cooldownMultiplier)}`, key: 'circuitBreaker.cooldownMultiplier' },
    { label: t('breakerRules.kQuota'), value: fmtMs(cb.quotaCooldownMs ?? CB_KNOB_DEFAULTS.quotaCooldownMs), key: 'circuitBreaker.quotaCooldownMs' },
    { label: t('breakerRules.kProbes'), value: fmtPlain(cb.halfOpenMaxProbes ?? CB_KNOB_DEFAULTS.halfOpenMaxProbes), key: 'circuitBreaker.halfOpenMaxProbes' },
    { label: t('breakerRules.kProbing'), value: cb.activeProbing?.enabled ? t('breakerRules.stateOn') : t('breakerRules.stateOff'), key: 'circuitBreaker.activeProbing.enabled' },
    { label: t('breakerRules.kInterval'), value: fmtMs(cb.activeProbing?.intervalMs ?? 60_000), key: 'circuitBreaker.activeProbing.intervalMs' },
    { label: t('breakerRules.kAffinity'), value: fmtMs(cb.accountAffinity?.cacheTtlMs ?? 300_000), key: 'circuitBreaker.accountAffinity.cacheTtlMs' },
    { label: t('breakerRules.kDebounce'), value: fmtMs(cb.persistence?.debounceMs ?? 1000), key: 'circuitBreaker.persistence.debounceMs' },
    { label: t('breakerRules.kHardBoundary'), value: fmtMs(retryBoundary ?? 2000), key: 'retry.inplace.maxRateLimitWaitMs', note: t('breakerRules.kHardBoundaryNote') },
  ];

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <Settings2 size={18} color="var(--accent)" />
          <span>{t('breakerRules.sectionTitle')}</span>
          <span
            className="badge"
            style={{ color: view.color, borderColor: 'var(--card-border)', whiteSpace: 'nowrap' }}
            title={t('breakerRules.autoTripping')}
          >
            {t('breakerRules.autoTripping')}: {view.text}
          </span>
        </div>
        {/* Shadow switch — top-right of the section (UX contract). */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
          <span>{t('breakerRules.shadowLabel')}</span>
          <Switch
            checked={cb.shadow ?? false}
            onChange={(v) => patch((prev) => ({ ...prev, shadow: v }))}
            ariaLabel={t('breakerRules.shadowLabel')}
          />
        </label>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 6 }}>
        {t('breakerRules.shadowFoot')}
      </div>

      {/* ── Block A: disposition table — collapsible, default expanded ── */}
      <details open={openBlocks.a} onToggle={toggleBlock('a')}>
        <summary style={blockSummary}>
          <span aria-hidden style={{ ...blockChev, transform: openBlocks.a ? undefined : 'rotate(-90deg)' }}>▼</span>
          {t('breakerRules.blockA')}
          <span className="badge" style={blockBadge}>{t('breakerRules.badgeHandled', { n: handled })}</span>
        </summary>
        <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 680, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col span={1} style={{ width: 170 }} />
            <col span={1} style={{ width: 180 }} />
            <col span={1} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" style={th}>{t('breakerRules.thClass')}</th>
              <th scope="col" style={th}>{t('breakerRules.thDisposition')}</th>
              <th scope="col" style={th}>{t('breakerRules.thParams')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{t('breakerRules.rowQuota')}</th>
              <td style={td}>
                {disp(dispOptions.tripIgnore, quotaTrip ? 'dispTripNow' : 'dispIgnore', (v) =>
                  rulePatch('trip', 'quota', { enabled: v === 'dispTripNow' })
                )}
              </td>
              <td style={td}>
                {quotaTrip ? (
                  <Params>
                    <AutoField
                      label={t('breakerRules.pDuration')}
                      value={trip.quota?.cooldownMs}
                      live={resolved.trip.quota.cooldownMs}
                      unit="ms"
                      autoKnob="circuitBreaker.quotaCooldownMs"
                      keyName="circuitBreaker.rules.trip.quota.cooldownMs"
                      onChange={(v) => rulePatch('trip', 'quota', { cooldownMs: v })}
                    />
                    {blast('trip', 'quota', trip.quota?.scope)}
                  </Params>
                ) : (
                  <Dash />
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{t('breakerRules.rowAuth')}</th>
              <td style={td}>
                {disp(dispOptions.tripIgnore, authTrip ? 'dispTripNow' : 'dispIgnore', (v) =>
                  rulePatch('trip', 'auth', { enabled: v === 'dispTripNow' })
                )}
              </td>
              <td style={td}>
                {authTrip ? (
                  <Params>
                    <AutoField
                      label={t('breakerRules.pDuration')}
                      value={trip.auth?.cooldownMs}
                      live={resolved.trip.auth.cooldownMs}
                      unit="ms"
                      autoKnob="circuitBreaker.quotaCooldownMs"
                      keyName="circuitBreaker.rules.trip.auth.cooldownMs"
                      onChange={(v) => rulePatch('trip', 'auth', { cooldownMs: v })}
                    />
                    {/* markSuspect: off STOPS NEW flags only — existing flags keep gating (spec rule #2). */}
                    <label
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}
                      title={t('breakerRules.markSuspectWarn')}
                    >
                      <input
                        type="checkbox"
                        checked={trip.auth?.markSuspect !== false}
                        onChange={(e) => rulePatch('trip', 'auth', { markSuspect: e.target.checked })}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      <span>{t('breakerRules.markSuspect')}</span>
                      {trip.auth?.markSuspect === false && (
                        <AlertTriangle size={12} color="var(--accent-amber)" />
                      )}
                    </label>
                    {blast('trip', 'auth', trip.auth?.scope)}
                  </Params>
                ) : (
                  /* 401 ignore = penalty-free passthrough (no trip / no count / no SUSPECT). */
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('breakerRules.authIgnoreHint')}</span>
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{t('breakerRules.rowRate')}</th>
              <td style={td}>
                {/* No "ignore" — the classifier counts every 429 (UX rule 2). */}
                {disp(dispOptions.hard, rateHard ? 'dispTripAbove' : 'dispCountOnly', (v) =>
                  rulePatch('trip', 'rateLimit', { enabled: v === 'dispTripAbove' })
                )}
              </td>
              <td style={td}>
                <Params>
                  {/* "count only" never evaluates the hard/counted boundary — not consumed (UX rule 1). */}
                  {rateHard ? (
                    <AutoField
                      label={t('breakerRules.pAbove')}
                      value={trip.rateLimit?.hardTripAboveMs}
                      live={resolved.trip.rateLimit.hardTripAboveMs}
                      unit="ms"
                      autoKnob="retry.inplace.maxRateLimitWaitMs"
                      keyName="circuitBreaker.rules.trip.rateLimit.hardTripAboveMs"
                      onChange={(v) => rulePatch('trip', 'rateLimit', { hardTripAboveMs: v })}
                    />
                  ) : (
                    <Dash title={t('breakerRules.pAbove')} />
                  )}
                  <AutoField
                    label={t('breakerRules.pTripFloor')}
                    value={trip.rateLimit?.minCooldownMs}
                    live={resolved.trip.rateLimit.minCooldownMs}
                    unit="ms"
                    autoKnob="circuitBreaker.rules.trip.rateLimit.minCooldownMs (default 1000)"
                    keyName="circuitBreaker.rules.trip.rateLimit.minCooldownMs"
                    onChange={(v) => rulePatch('trip', 'rateLimit', { minCooldownMs: v })}
                  />
                  <AutoField
                    label={t('breakerRules.pCountedFloor')}
                    value={counting.rateLimitErrors?.minCooldownMs}
                    live={resolved.counting.rateLimitErrors.minCooldownMs}
                    unit="ms"
                    autoKnob="min(60s, circuitBreaker.initialCooldownMs)"
                    keyName="circuitBreaker.rules.counting.rateLimitErrors.minCooldownMs"
                    onChange={(v) => rulePatch('counting', 'rateLimitErrors', { minCooldownMs: v })}
                  />
                  {/* The hard-trip scope is consumed only by the hard disposition; counted
                      429s ride the block-B detectors' scopes. */}
                  {rateHard ? blast('trip', 'rateLimit', trip.rateLimit?.scope) : <Dash title={t('breakerRules.pBlast')} />}
                </Params>
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{t('breakerRules.rowServer')}</th>
              <td style={td}>
                {disp(dispOptions.countIgnore, serverCount ? 'dispCountIt' : 'dispIgnore', (v) =>
                  rulePatch('counting', 'serverErrors', { enabled: v === 'dispCountIt' })
                )}
              </td>
              <td style={td}>
                {serverCount ? (
                  <Params>
                    <AutoField
                      label={t('breakerRules.pMinDuration')}
                      value={counting.serverErrors?.minCooldownMs}
                      live={resolved.counting.serverErrors.minCooldownMs}
                      unit="ms"
                      autoKnob="circuitBreaker.initialCooldownMs"
                      keyName="circuitBreaker.rules.counting.serverErrors.minCooldownMs"
                      onChange={(v) => rulePatch('counting', 'serverErrors', { minCooldownMs: v })}
                    />
                  </Params>
                ) : (
                  <Dash />
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{t('breakerRules.rowUnknown')}</th>
              <td style={td}>
                {disp(dispOptions.countIgnore, unknownCount ? 'dispCountIt' : 'dispIgnore', (v) =>
                  rulePatch('counting', 'unknownErrors', { enabled: v === 'dispCountIt' })
                )}
              </td>
              <td style={td}>
                {unknownCount ? (
                  <Params>
                    <AutoField
                      label={t('breakerRules.pMinDuration')}
                      value={counting.unknownErrors?.minCooldownMs}
                      live={resolved.counting.unknownErrors.minCooldownMs}
                      unit="ms"
                      autoKnob="circuitBreaker.initialCooldownMs"
                      keyName="circuitBreaker.rules.counting.unknownErrors.minCooldownMs"
                      onChange={(v) => rulePatch('counting', 'unknownErrors', { minCooldownMs: v })}
                    />
                  </Params>
                ) : (
                  <Dash />
                )}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{t('breakerRules.rowClient')}</th>
              <td style={td}>
                {disp(dispOptions.ignoreCount, clientCount ? 'dispCountIt' : 'dispIgnore', (v) =>
                  rulePatch('counting', 'clientErrors', { enabled: v === 'dispCountIt' })
                )}
              </td>
              <td style={td}>
                {clientCount ? (
                  <Params>
                    {/* Rule #8: no cooldown param of its own — the B ladder applies; ON = not recommended. */}
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('breakerRules.clientParamsNote')}</span>
                    <span className="badge badge-danger" style={{ whiteSpace: 'nowrap' }}>
                      {t('breakerRules.notRecommended')}
                    </span>
                  </Params>
                ) : (
                  <Dash />
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      </details>

      {/* ── Block B: two independent statistical detectors — collapsible ── */}
      <details open={openBlocks.b} onToggle={toggleBlock('b')}>
        <summary style={blockSummary}>
          <span aria-hidden style={{ ...blockChev, transform: openBlocks.b ? undefined : 'rotate(-90deg)' }}>▼</span>
          {t('breakerRules.blockB')}
          <span className="badge" style={blockBadge}>{t('breakerRules.badgeDetectors', { n: detectorsOn })}</span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
            <input
              type="checkbox"
              checked={consOn}
              onChange={(e) => rulePatch('trip', 'consecutiveFailures', { enabled: e.target.checked })}
              style={{ accentColor: 'var(--accent)' }}
            />
            <span>{t('breakerRules.bConsecutive')}</span>
          </label>
          {consOn ? (
            <Params>
              <AutoField
                label={t('breakerRules.pThreshold')}
                value={trip.consecutiveFailures?.threshold}
                live={resolved.trip.consecutiveFailures.threshold}
                unit="int"
                autoKnob="circuitBreaker.failureThreshold"
                keyName="circuitBreaker.rules.trip.consecutiveFailures.threshold"
                onChange={(v) => rulePatch('trip', 'consecutiveFailures', { threshold: v })}
              />
              <AutoField
                label={t('breakerRules.pStart')}
                value={trip.consecutiveFailures?.initialCooldownMs}
                live={resolved.trip.consecutiveFailures.initialCooldownMs}
                unit="ms"
                autoKnob="circuitBreaker.initialCooldownMs"
                keyName="circuitBreaker.rules.trip.consecutiveFailures.initialCooldownMs"
                onChange={(v) => rulePatch('trip', 'consecutiveFailures', { initialCooldownMs: v })}
              />
              <AutoField
                label={t('breakerRules.pStep')}
                value={trip.consecutiveFailures?.cooldownMultiplier}
                live={resolved.trip.consecutiveFailures.cooldownMultiplier}
                unit="mult"
                autoKnob="circuitBreaker.cooldownMultiplier"
                keyName="circuitBreaker.rules.trip.consecutiveFailures.cooldownMultiplier"
                onChange={(v) => rulePatch('trip', 'consecutiveFailures', { cooldownMultiplier: v })}
              />
              <AutoField
                label={t('breakerRules.pCap')}
                value={trip.consecutiveFailures?.maxCooldownMs}
                live={resolved.trip.consecutiveFailures.maxCooldownMs}
                unit="ms"
                autoKnob="circuitBreaker.maxCooldownMs"
                keyName="circuitBreaker.rules.trip.consecutiveFailures.maxCooldownMs"
                onChange={(v) => rulePatch('trip', 'consecutiveFailures', { maxCooldownMs: v })}
              />
              {blast('trip', 'consecutiveFailures', trip.consecutiveFailures?.scope)}
            </Params>
          ) : (
            <Dash />
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
            <input
              type="checkbox"
              checked={rateDetOn}
              onChange={(e) => rulePatch('trip', 'failureRate', { enabled: e.target.checked })}
              style={{ accentColor: 'var(--accent)' }}
            />
            <span>{t('breakerRules.bFailureRate')}</span>
          </label>
          {rateDetOn ? (
            <Params>
              <AutoField
                label={t('breakerRules.pWindow')}
                value={trip.failureRate?.windowSize}
                live={resolved.trip.failureRate.windowSize}
                unit="int"
                autoKnob="circuitBreaker.slidingWindowSize"
                keyName="circuitBreaker.rules.trip.failureRate.windowSize"
                onChange={(v) => rulePatch('trip', 'failureRate', { windowSize: v })}
              />
              <AutoField
                label={t('breakerRules.pMinCalls')}
                value={trip.failureRate?.minCalls}
                live={resolved.trip.failureRate.minCalls}
                unit="int"
                autoKnob="circuitBreaker.rules.trip.failureRate.windowSize (default = window)"
                keyName="circuitBreaker.rules.trip.failureRate.minCalls"
                onChange={(v) => rulePatch('trip', 'failureRate', { minCalls: v })}
              />
              <AutoField
                label={t('breakerRules.pRate')}
                value={trip.failureRate?.failureRate}
                live={resolved.trip.failureRate.failureRate}
                unit="percent"
                autoKnob="circuitBreaker.failureRateThreshold"
                keyName="circuitBreaker.rules.trip.failureRate.failureRate"
                onChange={(v) => rulePatch('trip', 'failureRate', { failureRate: v })}
              />
              <AutoField
                label={t('breakerRules.pTripCooldown')}
                value={trip.failureRate?.cooldownMs}
                live={resolved.trip.failureRate.cooldownMs}
                unit="ms"
                autoKnob="circuitBreaker.initialCooldownMs"
                keyName="circuitBreaker.rules.trip.failureRate.cooldownMs"
                onChange={(v) => rulePatch('trip', 'failureRate', { cooldownMs: v })}
              />
              {blast('trip', 'failureRate', trip.failureRate?.scope)}
              <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{t('breakerRules.minCallsHelp')}</span>
            </Params>
          ) : (
            <Dash />
          )}
        </div>
      </div>
      </details>

      {/* ── Block C: recovery — collapsible ── */}
      <details open={openBlocks.c} onToggle={toggleBlock('c')}>
        <summary style={blockSummary}>
          <span aria-hidden style={{ ...blockChev, transform: openBlocks.c ? undefined : 'rotate(-90deg)' }}>▼</span>
          {t('breakerRules.blockC')}
          <span className="badge" style={blockBadge}>
            {t('breakerRules.cOnFail')} · {t(CANARY_R_KEY[rec.onCanaryFailure ?? 'backoff'])}
          </span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          <span>{t('breakerRules.cIntro')}</span>
          <AutoField
            label={t('breakerRules.cProbes')}
            value={halfOpen.maxProbes}
            live={resolved.recovery.halfOpen.maxProbes}
            unit="int"
            autoKnob="circuitBreaker.halfOpenMaxProbes"
            keyName="circuitBreaker.rules.recovery.halfOpen.maxProbes"
            onChange={(v) => rulePatch('recovery', 'halfOpen', { maxProbes: v })}
          />
          <AutoField
            label={t('breakerRules.cSuccess')}
            value={halfOpen.successThreshold}
            live={resolved.recovery.halfOpen.successThreshold}
            unit="int"
            autoKnob="circuitBreaker.rules.recovery.halfOpen.successThreshold (default 1)"
            keyName="circuitBreaker.rules.recovery.halfOpen.successThreshold"
            onChange={(v) => rulePatch('recovery', 'halfOpen', { successThreshold: v })}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          <span>{t('breakerRules.cFailIntro')}</span>
          <AutoField
            label=""
            value={halfOpen.maxWaitMs}
            live={resolved.recovery.halfOpen.maxWaitMs}
            unit="msNever"
            autoKnob="circuitBreaker.rules.recovery.halfOpen.maxWaitMs (default 0 = never)"
            keyName="circuitBreaker.rules.recovery.halfOpen.maxWaitMs"
            onChange={(v) => rulePatch('recovery', 'halfOpen', { maxWaitMs: v })}
          />
          <span>{t('breakerRules.cOnFail')}</span>
          <Combobox
            value={rec.onCanaryFailure ?? 'backoff'}
            onChange={(v) =>
              patch(
                (prev) => ({
                  ...prev,
                  rules: { ...prev.rules, recovery: { ...prev.rules?.recovery, onCanaryFailure: asCanary(v) } },
                })
              )
            }
            options={canaryOptions}
            panelMinWidth={210}
            style={{ fontSize: 12, padding: '6px 10px', width: 180 }}
          />
          {rec.onCanaryFailure === 'backoff' ? (
            <AutoField
              label={t('breakerRules.pRecoveryMult')}
              value={rec.cooldownMultiplier}
              live={resolved.recovery.cooldownMultiplier}
              unit="mult"
              autoKnob="circuitBreaker.cooldownMultiplier"
              keyName="circuitBreaker.rules.recovery.cooldownMultiplier"
              onChange={(v) =>
                patch(
                  (prev) => ({
                    ...prev,
                    rules: { ...prev.rules, recovery: { ...prev.rules?.recovery, cooldownMultiplier: v } },
                  })
                )
              }
            />
          ) : (
            <Dash />
          )}
          <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{t('breakerRules.canaryManualNote')}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', fontSize: 12 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <span>{t('breakerRules.cProbing')}</span>
            <Switch
              checked={cb.activeProbing?.enabled ?? false}
              onChange={(v) => patch((prev) => ({ ...prev, activeProbing: { ...prev.activeProbing, enabled: v } }))}
              ariaLabel={t('breakerRules.cProbing')}
            />
          </label>
          <AutoField
            label={t('breakerRules.pInterval')}
            value={cb.activeProbing?.intervalMs}
            live={cb.activeProbing?.intervalMs ?? 60_000}
            unit="ms"
            autoKnob="circuitBreaker.activeProbing.intervalMs (default 60000)"
            keyName="circuitBreaker.activeProbing.intervalMs"
            onChange={(v) => patch((prev) => ({ ...prev, activeProbing: { ...prev.activeProbing, intervalMs: v } }))}
          />
        </div>
      </div>
      </details>

      {/* ── shared defaults + restart note + save row ── */}
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', userSelect: 'none' }}>
          {t('breakerRules.defaultsToggle')}
        </summary>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '6px 0' }}>{t('breakerRules.defaultsHint')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '2px 16px' }}>
          {defaultRows.map((d) => (
            <div
              key={d.key}
              title={d.note ? `${d.key}\n${d.note}` : d.key}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                borderBottom: '1px dashed var(--card-border)',
                padding: '4px 0',
                fontSize: 11,
              }}
            >
              <span style={{ color: 'var(--text-muted)' }}>{d.label}</span>
              <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-dim)' }}>
                {d.value}
              </span>
            </div>
          ))}
        </div>
      </details>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--accent-amber)' }}>
          <AlertTriangle size={12} />
          {t('breakerRules.restartNotice')}
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={handleDiscard} disabled={saving}>
            {t('breakerRules.discard')}
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? t('breakerRules.saving') : t('breakerRules.save')}
          </button>
        </span>
      </div>
    </div>
  );
};

export const BreakerRulesPage: React.FC = () => {
  // Effective ruleset + banner state arrive on the Layout's 3s status poll.
  const { status } = useOutletContext<{ status: GatewayStatusResponse | null }>();
  const { t } = useI18n();
  const live = status?.circuitBreakers?.rules;
  const view = autoTrippingView(t, live);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
      {/* Automatic-tripping summary (UX rule 6 — backend five-switch state). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {t('breakerRules.autoTripping')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: view.color }}>{view.text}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>
            {t('breakerRules.restartNotice')}
          </div>
        </div>
      </div>

      <BreakerRulesSection live={live} />
    </div>
  );
};
