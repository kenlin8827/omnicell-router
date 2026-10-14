import React, { useState, useMemo, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Settings2, AlertTriangle, RotateCcw } from 'lucide-react';
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
import { DurationInput } from '../components/DurationInput';
import { InfoTip } from '../components/InfoTip';
import { Switch } from '../components/Switch';

/* ═══════════════════════════════════════════════════════════════════════════
 * Breaker-rules page — Configuration UX contract (spec
 * docs/design/circuit-breaker-rules-config.md): three collapsible blocks A/B/C
 * (native <details>, default expanded, live state badge per summary), one
 * disposition table, `auto | custom` on every numeric input, human
 * blast-radius Comboboxes, shadow switch, five-switch header badge, restart
 * note. No separate summary card — the section header carries it all.
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

/** Localized wireframe units (12h / 60s) — hours from 1h up, seconds below. */
const fmtMs = (ms: number, u: { h: string; s: string }): string =>
  ms >= 3_600_000 ? `${fmtPlain(ms / 3_600_000)}${u.h}` : `${fmtPlain(ms / 1000)}${u.s}`;

/** Localized short unit labels for fmtMs, from the duration.* i18n namespace. */
const durationLabels = (t: (path: string, params?: Record<string, string | number>) => string) => ({
  h: t('duration.h'),
  s: t('duration.s'),
});

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
  /** Sentence text before the value chip (natural reading order). */
  label?: string;
  /** Sentence text after the chip — post-positioned measure words (probes-count, multiplier). */
  suffix?: string;
  /** Draft value: undefined = inherited (absent key on save). */
  value: number | undefined;
  /** Live inherited value shown while no override exists (from ResolvedBreakerRules). */
  live: number;
  unit: FieldUnit;
  /** Inherit-state tooltip — the inherited global knob's config key. */
  autoKnob: string;
  /** Custom-state tooltip — this param's own yaml key (raw keys live in tooltips only). */
  keyName: string;
  onChange: (v: number | undefined) => void;
}

/** UX binding rule 3: numeric fields render as a fill-in-the-blank sentence — the
 *  value chip sits in natural word order (label before / measure word after);
 *  click it to edit inline (Enter/blur commits, Esc exits), and a revert button
 *  appears while customized. inherited ⇔ absent key. */
const AutoField: React.FC<AutoFieldProps> = ({ label, suffix, value, live, unit, autoKnob, keyName, onChange }) => {
  const { t } = useI18n();
  const durLabels = durationLabels(t);
  const custom = value !== undefined;
  const [editing, setEditing] = useState(false);
  const fmt = (n: number): string => {
    if (unit === 'ms') return fmtMs(n, durLabels);
    if (unit === 'msNever') return n === 0 ? t('breakerRules.never') : fmtMs(n, durLabels);
    if (unit === 'percent') return `${fmtPlain(n * 100)}%`;
    return fmtPlain(n);
  };

  if (editing) {
    const seed = custom ? value : live;
    const done = () => setEditing(false);
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
        {label ? <span>{label}</span> : null}
        {unit === 'ms' || unit === 'msNever' ? (
          /* Shared duration control — canonical ms; the unit dropdown is a typing aid. */
          <DurationInput
            value={seed}
            autoFocus
            onDone={done}
            onChange={onChange}
            ariaLabel={`${label || suffix || unit} (${keyName})`}
            title={keyName}
          />
        ) : (
          <>
            <input
              autoFocus
              type="number"
              className="input"
              min={0}
              step={unit === 'int' ? 1 : 'any'}
              aria-label={`${label || suffix || unit} (${keyName})`}
              title={keyName}
              defaultValue={String(unit === 'percent' ? seed * 100 : seed)}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) onChange(unit === 'percent' ? Math.min(n, 100) / 100 : n);
                done();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') done();
              }}
              style={{ width: 96, padding: '6px 10px', fontSize: 13 }}
            />
            {unit === 'percent' && <span style={{ color: 'var(--text-dim)' }}>%</span>}
          </>
        )}
        {suffix ? <span>{suffix}</span> : null}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
      {label ? <span>{label}</span> : null}
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={
          custom
            ? `${keyName} = ${fmt(value)}\n${t('breakerRules.editHint')}`
            : `${autoKnob} = ${fmt(live)}\n${t('breakerRules.editHint')}`
        }
        style={{
          fontSize: 12,
          padding: '4px 10px',
          borderRadius: 7,
          cursor: 'pointer',
          fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace",
          border: custom ? '1px solid var(--accent)' : '1px dashed var(--card-border)',
          background: custom ? 'var(--btn-primary-bg)' : 'transparent',
          color: custom ? 'var(--btn-primary-text)' : 'var(--text-muted)',
        }}
      >
        {fmt(custom ? value : live)}
      </button>
      {suffix ? <span>{suffix}</span> : null}
      {custom && (
        <button
          type="button"
          title={t('breakerRules.revertHint')}
          aria-label={t('breakerRules.revertHint')}
          onClick={() => onChange(undefined)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: 2,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-dim)',
          }}
        >
          <RotateCcw size={11} />
        </button>
      )}
    </span>
  );
};

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
  const [openBlocks, setOpenBlocks] = useState({ a: true, b: true, c: true, d: true });
  const toggleBlock =
    (k: 'a' | 'b' | 'c' | 'd') =>
    (e: React.SyntheticEvent<HTMLDetailsElement>) => {
      // React nulls SyntheticEvent.currentTarget after dispatch, and the
      // setState updater runs later (batched render) — reading
      // e.currentTarget inside the updater crashes with null.open.
      // Capture the flag synchronously here instead.
      const open = e.currentTarget.open;
      setOpenBlocks((prev) => ({ ...prev, [k]: open }));
    };

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
    <span className="input-group">
      <span style={{ padding: '6px 8px 6px 10px', fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' }}>
        {t('breakerRules.pBlast')}
      </span>
      <Combobox
        value={value ?? 'auto'}
        onChange={(v) => rulePatch(family, ruleName, { scope: asScope(v) })}
        options={blastOptions}
        panelMinWidth={230}
        style={{
          fontSize: 12,
          padding: '6px 10px',
          width: 170,
          border: 'none',
          background: 'transparent',
          borderRadius: 0,
          borderLeft: '1px solid var(--input-border)',
        }}
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

  // Collapsible block headers (native <details>/<summary>): each block sits in
  // a .sub-card frame so the A/B/C partition reads at a glance, and the
  // summary row doubles as that frame's mini card-header (underline divider,
  // manual chevron rotating right when closed).
  const blockSummary: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--text-muted)',
    margin: 0,
    paddingBottom: 8,
    borderBottom: '1px solid var(--card-border)',
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

  const durLabels = durationLabels(t);
  const defaultRows: { label: string; value: string; key: string; note?: string }[] = [
    { label: t('breakerRules.kEnabled'), value: cb.enabled === false ? t('breakerRules.stateOff') : t('breakerRules.stateOn'), key: 'circuitBreaker.enabled' },
    { label: t('breakerRules.kFailureThreshold'), value: fmtPlain(cb.failureThreshold ?? CB_KNOB_DEFAULTS.failureThreshold), key: 'circuitBreaker.failureThreshold' },
    { label: t('breakerRules.kWindow'), value: fmtPlain(cb.slidingWindowSize ?? CB_KNOB_DEFAULTS.slidingWindowSize), key: 'circuitBreaker.slidingWindowSize' },
    { label: t('breakerRules.kRate'), value: `${fmtPlain((cb.failureRateThreshold ?? CB_KNOB_DEFAULTS.failureRateThreshold) * 100)}%`, key: 'circuitBreaker.failureRateThreshold' },
    { label: t('breakerRules.kInitial'), value: fmtMs(cb.initialCooldownMs ?? CB_KNOB_DEFAULTS.initialCooldownMs, durLabels), key: 'circuitBreaker.initialCooldownMs' },
    { label: t('breakerRules.kMax'), value: fmtMs(cb.maxCooldownMs ?? CB_KNOB_DEFAULTS.maxCooldownMs, durLabels), key: 'circuitBreaker.maxCooldownMs' },
    { label: t('breakerRules.kMult'), value: `x${fmtPlain(cb.cooldownMultiplier ?? CB_KNOB_DEFAULTS.cooldownMultiplier)}`, key: 'circuitBreaker.cooldownMultiplier' },
    { label: t('breakerRules.kQuota'), value: fmtMs(cb.quotaCooldownMs ?? CB_KNOB_DEFAULTS.quotaCooldownMs, durLabels), key: 'circuitBreaker.quotaCooldownMs' },
    { label: t('breakerRules.kProbes'), value: fmtPlain(cb.halfOpenMaxProbes ?? CB_KNOB_DEFAULTS.halfOpenMaxProbes), key: 'circuitBreaker.halfOpenMaxProbes' },
    { label: t('breakerRules.kProbing'), value: cb.activeProbing?.enabled ? t('breakerRules.stateOn') : t('breakerRules.stateOff'), key: 'circuitBreaker.activeProbing.enabled' },
    { label: t('breakerRules.kInterval'), value: fmtMs(cb.activeProbing?.intervalMs ?? 60_000, durLabels), key: 'circuitBreaker.activeProbing.intervalMs' },
    { label: t('breakerRules.kAffinity'), value: fmtMs(cb.accountAffinity?.cacheTtlMs ?? 300_000, durLabels), key: 'circuitBreaker.accountAffinity.cacheTtlMs' },
    { label: t('breakerRules.kDebounce'), value: fmtMs(cb.persistence?.debounceMs ?? 1000, durLabels), key: 'circuitBreaker.persistence.debounceMs' },
    { label: t('breakerRules.kHardBoundary'), value: fmtMs(retryBoundary ?? 2000, durLabels), key: 'retry.inplace.maxRateLimitWaitMs', note: t('breakerRules.kHardBoundaryNote') },
  ];

  return (
    /* SettingsPage/RulesPage pattern: the header stays pinned (flexShrink 0)
       and the body is the card's own scroll region, so save/discard are
       reachable while editing ANY block. .card padding is zeroed and
       re-applied per region (header / scroll body). */
    <div
      className="card"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}
    >
      <div
        className="card-header"
        style={{
          flexShrink: 0,
          flexWrap: 'wrap',
          gap: 10,
          marginBottom: 0,
          padding: '14px 20px',
          borderBottom: '1px solid var(--card-border)',
        }}
      >
        <div className="card-title">
          <Settings2 size={18} color="var(--accent)" />
          <span>{t('breakerRules.sectionTitle')}</span>
          <span
            className="badge"
            style={{ color: view.color, borderColor: 'var(--card-border)', whiteSpace: 'nowrap', fontSize: 12, padding: '3px 10px' }}
            title={t('breakerRules.autoTripping')}
          >
            {t('breakerRules.autoTripping')}: {view.text}
          </span>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Shadow switch — top-right of the section (UX contract). */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <span>{t('breakerRules.shadowLabel')}</span>
            <Switch
              checked={cb.shadow ?? false}
              onChange={(v) => patch((prev) => ({ ...prev, shadow: v }))}
              ariaLabel={t('breakerRules.shadowLabel')}
            />
          </label>
          <InfoTip text={t('breakerRules.shadowFoot')} />
          {/* Save/discard — header-pinned (SettingsPage pattern); the zero-rules
              confirm dialog still guards the save. Rules hot-apply on save
              (spec invariant 6), so no restart note — the savedToast says so. */}
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={handleDiscard} disabled={saving}>
              {t('breakerRules.discard')}
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? t('breakerRules.saving') : t('breakerRules.save')}
            </button>
          </span>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 20px 20px' }}>
      {/* ── Block A: disposition table — .sub-card frame + collapsible ── */}
      <div className="sub-card" style={{ marginBottom: 12 }}>
      <details open={openBlocks.a} onToggle={toggleBlock('a')}>
        <summary style={blockSummary}>
          <span aria-hidden style={{ ...blockChev, transform: openBlocks.a ? undefined : 'rotate(-90deg)' }}>▼</span>
          {t('breakerRules.blockA')}
          <span className="badge" style={blockBadge}>{t('breakerRules.badgeHandled', { n: handled })}</span>
        </summary>
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
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
                ) : null}
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
                    <>
                      <AutoField
                        label={t('breakerRules.pAbove')}
                        suffix={t('breakerRules.pRateHardMid')}
                        value={trip.rateLimit?.hardTripAboveMs}
                        live={resolved.trip.rateLimit.hardTripAboveMs}
                        unit="ms"
                        autoKnob="retry.inplace.maxRateLimitWaitMs"
                        keyName="circuitBreaker.rules.trip.rateLimit.hardTripAboveMs"
                        onChange={(v) => rulePatch('trip', 'rateLimit', { hardTripAboveMs: v })}
                      />
                      <AutoField
                        value={trip.rateLimit?.minCooldownMs}
                        live={resolved.trip.rateLimit.minCooldownMs}
                        unit="ms"
                        autoKnob="circuitBreaker.rules.trip.rateLimit.minCooldownMs (default 1000)"
                        keyName="circuitBreaker.rules.trip.rateLimit.minCooldownMs"
                        onChange={(v) => rulePatch('trip', 'rateLimit', { minCooldownMs: v })}
                      />
                    </>
                  ) : (
                    <>
                      <AutoField
                        label={t('breakerRules.pMinDuration')}
                        value={counting.rateLimitErrors?.minCooldownMs}
                        live={resolved.counting.rateLimitErrors.minCooldownMs}
                        unit="ms"
                        autoKnob="min(60s, circuitBreaker.initialCooldownMs)"
                        keyName="circuitBreaker.rules.counting.rateLimitErrors.minCooldownMs"
                        onChange={(v) => rulePatch('counting', 'rateLimitErrors', { minCooldownMs: v })}
                      />
                      <InfoTip text={t('breakerRules.countedTip')} />
                    </>
                  )}
                  {/* The hard-trip scope is consumed only by the hard disposition; counted
                      429s ride the block-B detectors' scopes. */}
                  {rateHard ? blast('trip', 'rateLimit', trip.rateLimit?.scope) : null}
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
                    <InfoTip text={t('breakerRules.countedTip')} />
                  </Params>
                ) : null}
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
                    <InfoTip text={t('breakerRules.countedTip')} />
                  </Params>
                ) : null}
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
                ) : null}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      </details>
      </div>

      {/* ── Block B: two independent statistical detectors — .sub-card frame ── */}
      <div className="sub-card" style={{ marginBottom: 12 }}>
      <details open={openBlocks.b} onToggle={toggleBlock('b')}>
        <summary style={blockSummary}>
          <span aria-hidden style={{ ...blockChev, transform: openBlocks.b ? undefined : 'rotate(-90deg)' }}>▼</span>
          {t('breakerRules.blockB')}
          <span className="badge" style={blockBadge}>{t('breakerRules.badgeDetectors', { n: detectorsOn })}</span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
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
                suffix={t('breakerRules.bConsAfterCount')}
                value={trip.consecutiveFailures?.threshold}
                live={resolved.trip.consecutiveFailures.threshold}
                unit="int"
                autoKnob="circuitBreaker.failureThreshold"
                keyName="circuitBreaker.rules.trip.consecutiveFailures.threshold"
                onChange={(v) => rulePatch('trip', 'consecutiveFailures', { threshold: v })}
              />
              <AutoField
                suffix={t('breakerRules.bConsAfterInitial')}
                value={trip.consecutiveFailures?.initialCooldownMs}
                live={resolved.trip.consecutiveFailures.initialCooldownMs}
                unit="ms"
                autoKnob="circuitBreaker.initialCooldownMs"
                keyName="circuitBreaker.rules.trip.consecutiveFailures.initialCooldownMs"
                onChange={(v) => rulePatch('trip', 'consecutiveFailures', { initialCooldownMs: v })}
              />
              <AutoField
                suffix={t('breakerRules.bConsAfterMult')}
                value={trip.consecutiveFailures?.cooldownMultiplier}
                live={resolved.trip.consecutiveFailures.cooldownMultiplier}
                unit="mult"
                autoKnob="circuitBreaker.cooldownMultiplier"
                keyName="circuitBreaker.rules.trip.consecutiveFailures.cooldownMultiplier"
                onChange={(v) => rulePatch('trip', 'consecutiveFailures', { cooldownMultiplier: v })}
              />
              <AutoField
                value={trip.consecutiveFailures?.maxCooldownMs}
                live={resolved.trip.consecutiveFailures.maxCooldownMs}
                unit="ms"
                autoKnob="circuitBreaker.maxCooldownMs"
                keyName="circuitBreaker.rules.trip.consecutiveFailures.maxCooldownMs"
                onChange={(v) => rulePatch('trip', 'consecutiveFailures', { maxCooldownMs: v })}
              />
              {blast('trip', 'consecutiveFailures', trip.consecutiveFailures?.scope)}
            </Params>
          ) : null}
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
                label={t('breakerRules.bRateLead')}
                suffix={t('breakerRules.bRateAfterWindow')}
                value={trip.failureRate?.windowSize}
                live={resolved.trip.failureRate.windowSize}
                unit="int"
                autoKnob="circuitBreaker.slidingWindowSize"
                keyName="circuitBreaker.rules.trip.failureRate.windowSize"
                onChange={(v) => rulePatch('trip', 'failureRate', { windowSize: v })}
              />
              <AutoField
                suffix={t('breakerRules.bRateAfterRate')}
                value={trip.failureRate?.failureRate}
                live={resolved.trip.failureRate.failureRate}
                unit="percent"
                autoKnob="circuitBreaker.failureRateThreshold"
                keyName="circuitBreaker.rules.trip.failureRate.failureRate"
                onChange={(v) => rulePatch('trip', 'failureRate', { failureRate: v })}
              />
              <AutoField
                suffix={t('breakerRules.bRateAfterMin')}
                value={trip.failureRate?.minCalls}
                live={resolved.trip.failureRate.minCalls}
                unit="int"
                autoKnob="circuitBreaker.rules.trip.failureRate.windowSize (default = window)"
                keyName="circuitBreaker.rules.trip.failureRate.minCalls"
                onChange={(v) => rulePatch('trip', 'failureRate', { minCalls: v })}
              />
              <AutoField
                value={trip.failureRate?.cooldownMs}
                live={resolved.trip.failureRate.cooldownMs}
                unit="ms"
                autoKnob="circuitBreaker.initialCooldownMs"
                keyName="circuitBreaker.rules.trip.failureRate.cooldownMs"
                onChange={(v) => rulePatch('trip', 'failureRate', { cooldownMs: v })}
              />
              {blast('trip', 'failureRate', trip.failureRate?.scope)}
              <InfoTip text={t('breakerRules.minCallsHelp')} />
            </Params>
          ) : null}
        </div>
      </div>
      </details>
      </div>

      {/* ── Block C: recovery — .sub-card frame ── */}
      <div className="sub-card" style={{ marginBottom: 12 }}>
      <details open={openBlocks.c} onToggle={toggleBlock('c')}>
        <summary style={blockSummary}>
          <span aria-hidden style={{ ...blockChev, transform: openBlocks.c ? undefined : 'rotate(-90deg)' }}>▼</span>
          {t('breakerRules.blockC')}
          <span className="badge" style={blockBadge}>
            {t('breakerRules.cOnFail')} · {t(CANARY_R_KEY[rec.onCanaryFailure ?? 'backoff'])}
          </span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          <span>{t('breakerRules.cIntro')}</span>
          <AutoField
            suffix={t('breakerRules.cProbes')}
            value={halfOpen.maxProbes}
            live={resolved.recovery.halfOpen.maxProbes}
            unit="int"
            autoKnob="circuitBreaker.halfOpenMaxProbes"
            keyName="circuitBreaker.rules.recovery.halfOpen.maxProbes"
            onChange={(v) => rulePatch('recovery', 'halfOpen', { maxProbes: v })}
          />
          <AutoField
            suffix={t('breakerRules.cSuccess')}
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
            suffix={t('breakerRules.cFailAfterWait')}
            value={halfOpen.maxWaitMs}
            live={resolved.recovery.halfOpen.maxWaitMs}
            unit="msNever"
            autoKnob="circuitBreaker.rules.recovery.halfOpen.maxWaitMs (default 0 = never)"
            keyName="circuitBreaker.rules.recovery.halfOpen.maxWaitMs"
            onChange={(v) => rulePatch('recovery', 'halfOpen', { maxWaitMs: v })}
          />
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
              label={t('breakerRules.cMultLead')}
              suffix={t('breakerRules.pRecoveryMult')}
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
          ) : rec.onCanaryFailure === 'close' ? (
            <InfoTip text={t('breakerRules.canaryManualNote')} />
          ) : null}
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
      </div>

      {/* ── shared defaults (open by default, collapsible) — same sub-card frame ── */}
      <div className="sub-card">
      <details open={openBlocks.d} onToggle={toggleBlock('d')}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--text-muted)',
            userSelect: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span aria-hidden style={{ ...blockChev, transform: openBlocks.d ? undefined : 'rotate(-90deg)' }}>▼</span>
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
      </div>
      </div>
    </div>
  );
};

export const BreakerRulesPage: React.FC = () => {
  // Effective ruleset + banner state arrive on the Layout's 3s status poll.
  // No separate summary card: the section card's header badge carries the
  // automatic-tripping state (UX rule 6); saves hot-apply, no restart note.
  const { status } = useOutletContext<{ status: GatewayStatusResponse | null }>();
  const live = status?.circuitBreakers?.rules;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <BreakerRulesSection live={live} />
    </div>
  );
};
