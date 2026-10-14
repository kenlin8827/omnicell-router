import React, { useState, useMemo, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ShieldAlert, RefreshCw, RotateCcw, Ban, Zap, Loader2, AlertTriangle } from 'lucide-react';
import { api, opencodeApi, type GatewayStatusResponse, type BreakerInfo, type BreakerTripScope, type AccountHealth } from '../lib/api';
import { useModelTest, type ModelTestTarget } from '../lib/useModelTest';
import { buildPairCards, effectiveState, effectiveCooldown, type PairCard } from '../lib/guardrails-matrix';
import { formatReason } from '../lib/reason';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';

const BREAKER_PAGE_SIZE = 20;
const BREAKER_PAGE_SIZES = [10, 20, 50, 100, 200];

type StateFilter = 'ALL' | 'OPEN' | 'HALF_OPEN' | 'CLOSED';

// Tripped first, half-open probes next, healthy last; longer remaining cooldown first within a state
const STATE_ORDER: Record<BreakerInfo['state'], number> = { OPEN: 0, HALF_OPEN: 1, CLOSED: 2 };

const TRIP_PRESETS: { label: string; ms: number }[] = [
  { label: '30m', ms: 30 * 60 * 1000 },
  { label: '1h', ms: 3600 * 1000 },
  { label: '6h', ms: 6 * 3600 * 1000 },
  { label: '12h', ms: 12 * 3600 * 1000 },
  { label: '24h', ms: 24 * 3600 * 1000 },
  { label: '7d', ms: 7 * 24 * 3600 * 1000 },
];

/** Trip scopes in panel order — 'model' first = today's default flow. */
const TRIP_SCOPES: BreakerTripScope[] = ['model', 'account', 'pair'];
const SCOPE_LABEL_KEY: Record<BreakerTripScope, string> = {
  model: 'guardrails.scopeModel',
  account: 'guardrails.scopeAccount',
  pair: 'guardrails.scopePair',
};

export const GuardrailsPage: React.FC = () => {
  const { status } = useOutletContext<{ status: GatewayStatusResponse | null }>();
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  // Exact-scope drill-downs (each Combobox carries its own filter input):
  // provider narrows the grid to one provider, model to one modelId;
  // credential narrows to one account's pair cards.
  const [providerFilter, setProviderFilter] = useState('');
  const [modelIdFilter, setModelIdFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('ALL');
  const [breakerPage, setBreakerPage] = useState(1);
  const [breakerPageSize, setBreakerPageSize] = useState(BREAKER_PAGE_SIZE);
  const [isResetting, setIsResetting] = useState(false);
  const [resettingModel, setResettingModel] = useState<string | null>(null);
  // Trip/reset panel — keyed by the card's own key.
  const [tripPanelKey, setTripPanelKey] = useState<string | null>(null);
  const [tripReason, setTripReason] = useState('');
  const [trippingKey, setTrippingKey] = useState<string | null>(null);
  // Panel scope — 'model' keeps the legacy whole-model request shape.
  const [tripScope, setTripScope] = useState<BreakerTripScope>('model');
  const [resettingScope, setResettingScope] = useState(false);
  const [resettingPair, setResettingPair] = useState<string | null>(null);
  // Credential roster source: the bound store's masked accounts, fetched once
  // per page. null = not tried, [] = none/unreadable.
  const [storeAccounts, setStoreAccounts] = useState<AccountHealth[] | null>(null);

  // Localized option rows are rebuilt per language; the code→key table is static.
  const scopeOptions = useMemo(
    () => TRIP_SCOPES.map((s) => ({ value: s, label: t(SCOPE_LABEL_KEY[s]) })),
    [t]
  );

  const loadStoreAccounts = async () => {
    if (storeAccounts !== null) return;
    try {
      const res = await opencodeApi.getCredentialStore();
      setStoreAccounts(res.store.accounts.flatMap((a) => a.accounts ?? []));
    } catch {
      setStoreAccounts([]);
    }
  };

  // The grid is roster-driven (every model × every credential), so the account
  // list must be present at first paint — fetch on mount (self-guarded).
  useEffect(() => {
    loadStoreAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTripPanel = (c: PairCard) => {
    setTripPanelKey(c.key);
    setTripReason('');
    // Single-credential columns (store chain of 1, or the config-baked key)
    // route through the no-prefix path — only the model breaker gates them.
    setTripScope(c.chainLen >= 2 ? 'pair' : 'model');
    loadStoreAccounts();
  };

  const closeTripPanel = () => {
    setTripPanelKey(null);
    setTripReason('');
    setTripScope('model');
  };

  const { testingIds, testResults, testOne, isBusy } = useModelTest();

  // Model layer (every registered model carries a boot-created breaker) plus
  // the additive pair layer (ADR-0019 P3 display side). Older gateways omit
  // `pairs` — cards then resolve through the model-mirror/no-record rules.
  const modelBreakers: BreakerInfo[] = status?.circuitBreakers?.breakers || [];
  const pairBreakers: BreakerInfo[] = status?.circuitBreakers?.pairs?.breakers || [];
  const openCount = status?.circuitBreakers?.tripped || 0;
  const halfOpenCount = status?.circuitBreakers?.halfOpen || 0;
  const totalBreakers = status?.circuitBreakers?.total || 0;
  const pairOpen = status?.circuitBreakers?.pairs?.tripped || 0;
  const pairHalf = status?.circuitBreakers?.pairs?.halfOpen || 0;
  const pairTotal = status?.circuitBreakers?.pairs?.total || 0;

  // OPEN pair count per model — the "N pairs OPEN" corner badge and the
  // single-point guard (model still serving on exactly one credential).
  const openPairsByModel = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pairBreakers) {
      if (p.state !== 'OPEN') continue;
      m.set(p.modelId, (m.get(p.modelId) ?? 0) + 1);
    }
    return m;
  }, [pairBreakers]);

  // Masked config keys for the synthetic single-credential column (status
  // providers are already key-masked server-side).
  const maskedKeyByProvider = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of status?.providers ?? []) if (p.apiKey) m.set(p.name, p.apiKey);
    return m;
  }, [status]);

  // The full matrix: models × credentials (join/fold semantics live in the
  // pure guardrails-matrix module, pinned by scripts/check-guardrails-matrix).
  const allItems = useMemo<PairCard[]>(
    () =>
      buildPairCards(
        modelBreakers,
        pairBreakers,
        storeAccounts ?? [],
        maskedKeyByProvider,
        status?.credentialHashes ?? [],
        { unnamed: t('op.accountUnnamed'), configKey: t('guardrails.configKey') }
      ),
    [modelBreakers, pairBreakers, storeAccounts, maskedKeyByProvider, status, t]
  );

  // Drill-down selectors: distinct providers / model ids present in the grid.
  // modelId is globally unique (provider-prefixed), so meta shows card count
  // for providers and the owning provider for models.
  const providerFilterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of allItems) counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
    return [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, n]) => ({ value, label: value, meta: String(n) }));
  }, [allItems]);

  const modelFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of allItems) {
      if (providerFilter !== '' && c.provider !== providerFilter) continue;
      if (!seen.has(c.modelId)) seen.set(c.modelId, c.provider);
    }
    return [...seen]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, provider]) => ({ value, label: value, meta: provider }));
  }, [allItems, providerFilter]);

  // Drill-down selector: every store credential that has at least one card,
  // cascaded by the provider pick. Owners and the masked key ride in `meta` —
  // Combobox filtering matches meta too, so a 'sk-…abcd' fragment search
  // still works here. The raw key never reaches the browser, so it cannot be
  // a search term by design.
  const accountFilterOptions = useMemo(() => {
    const seen = new Map<string, { label: string; providers: Set<string>; maskedKey?: string }>();
    for (const c of allItems) {
      if (c.synthetic || !c.prefix) continue;
      let e = seen.get(c.prefix);
      if (!e) {
        e = { label: `${c.label} #${c.prefix}`, providers: new Set(), maskedKey: c.maskedKey };
        seen.set(c.prefix, e);
      }
      e.providers.add(c.provider);
    }
    return [...seen]
      .filter(([, v]) => providerFilter === '' || v.providers.has(providerFilter))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, v]) => ({
        value,
        label: v.label,
        meta: [[...v.providers].sort().join('/'), v.maskedKey].filter(Boolean).join(' · '),
      }));
  }, [allItems, providerFilter]);

  // Reconcile drill-downs against live data (status re-polls every ~3s): a
  // vanished provider/model/credential must not linger as an invisible active
  // filter. Downstream lists are already cascaded by providerFilter, so
  // clearing staleness upstream re-settles the whole chain on next render.
  useEffect(() => {
    if (providerFilter && !providerFilterOptions.some((o) => o.value === providerFilter)) {
      setProviderFilter('');
    } else if (modelIdFilter && !modelFilterOptions.some((o) => o.value === modelIdFilter)) {
      setModelIdFilter('');
    } else if (accountFilter && !accountFilterOptions.some((o) => o.value === accountFilter)) {
      setAccountFilter('');
    } else {
      return;
    }
    setBreakerPage(1);
  }, [providerFilter, providerFilterOptions, modelIdFilter, modelFilterOptions, accountFilter, accountFilterOptions]);

  const filteredItems = useMemo<PairCard[]>(() => {
    return allItems
      .filter((c) => {
        if (providerFilter !== '' && c.provider !== providerFilter) return false;
        if (modelIdFilter !== '' && c.modelId !== modelIdFilter) return false;
        if (accountFilter !== '' && c.prefix !== accountFilter) return false;
        if (stateFilter !== 'ALL' && effectiveState(c) !== stateFilter) return false;
        return true;
      })
      .sort((a, b) => {
        const sa = effectiveState(a);
        const sb = effectiveState(b);
        return STATE_ORDER[sa] !== STATE_ORDER[sb]
          ? STATE_ORDER[sa] - STATE_ORDER[sb]
          : effectiveCooldown(b) - effectiveCooldown(a);
      });
  }, [allItems, stateFilter, providerFilter, modelIdFilter, accountFilter]);
  const pagedItems = filteredItems.slice(
    (breakerPage - 1) * breakerPageSize,
    breakerPage * breakerPageSize
  );

  const handleResetAll = async () => {
    // Blast radius = every model AND every pair breaker, manual trips included.
    // The counts mirror what `reset()` iterates server-side (manager.reset).
    const ok = await confirmDialog({
      title: t('guardrails.resetAllConfirmTitle'),
      description: t('guardrails.resetAllConfirmDesc', {
        total: totalBreakers + pairTotal,
        open: openCount + pairOpen,
        half: halfOpenCount + pairHalf,
      }),
      danger: true,
      confirmLabel: t('guardrails.resetAll'),
    });
    if (!ok) return;
    setIsResetting(true);
    try {
      await api.resetBreakers();
      toast.success(t('guardrails.resetSuccess'));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setIsResetting(false);
    }
  };

  /** Model-level reset (also clears the model's pair breakers — today's `reset(modelId)` semantics). */
  const handleResetOne = async (modelId: string) => {
    setResettingModel(modelId);
    try {
      await api.resetBreakers(modelId);
      toast.success(t('guardrails.resetOneSuccess', { model: modelId }));
    } catch (err: any) {
      toast.error(t('guardrails.resetOneFailed') + err.message);
    } finally {
      setResettingModel(null);
    }
  };

  /** Trip from a pair card at the panel's chosen scope. The card supplies the
   *  model and credential targets — the panel only picks the blast radius. */
  const handleTrip = async (c: PairCard, cooldownMs: number) => {
    const scope = tripScope;
    setTrippingKey(c.key);
    const opts = { reason: tripReason.trim() || undefined, cooldownMs };
    try {
      if (scope === 'model') {
        await api.tripBreaker(c.modelId, opts);
        toast.success(t('guardrails.tripSuccess', { model: c.modelId }));
      } else {
        const res = await api.tripBreakersScoped(scope, { model: c.modelId, account: c.prefix, ...opts });
        toast.success(t('guardrails.tripScopeSuccess', { scope: t(SCOPE_LABEL_KEY[scope]), n: res.affected ?? 0 }));
      }
      closeTripPanel();
    } catch (err: any) {
      toast.error(t('guardrails.tripFailed') + err.message);
    } finally {
      setTrippingKey(null);
    }
  };

  /** Scoped reset from an open panel — the undo door for an account/pair trip. */
  const handleResetScope = async (c: PairCard) => {
    const scope = tripScope;
    if (scope === 'model') return;
    // A credential-wide reset clears every pair breaker of this key for the
    // active provider (manager.resetByScope 'account' skips other providers'
    // pairs sharing the same prefix) — count from the same predicate it walks.
    if (scope === 'account') {
      const mine = pairBreakers.filter(
        (p) => p.keyHashPrefix === c.prefix && p.provider === c.provider,
      );
      const ok = await confirmDialog({
        title: t('guardrails.resetAccountConfirmTitle', { account: c.prefix }),
        description: t('guardrails.resetAccountConfirmDesc', {
          total: mine.length,
          open: mine.filter((p) => p.state === 'OPEN').length,
          half: mine.filter((p) => p.state === 'HALF_OPEN').length,
        }),
        danger: true,
        confirmLabel: t('guardrails.resetScope'),
      });
      if (!ok) return;
    }
    setResettingScope(true);
    try {
      const res = await api.resetBreakersScoped(scope, { model: c.modelId, account: c.prefix });
      const n = res.resetCount ?? 0;
      if (n > 0) toast.success(t('guardrails.resetScopeSuccess', { n }));
      else toast.info(t('guardrails.resetScopeNone'));
    } catch (err: any) {
      toast.error(t('guardrails.resetOneFailed') + err.message);
    } finally {
      setResettingScope(false);
    }
  };

  /**
   * Recover a pair card. A model-mirror card's truth IS the model breaker
   * (single-credential chain), so its recover clears that; a pair-sourced
   * card resets exactly its own (model × credential) breaker.
   */
  const handleRecoverPair = async (c: PairCard) => {
    setResettingPair(c.key);
    try {
      if (c.snapSource === 'model-mirror') {
        await api.resetBreakers(c.modelId);
        toast.success(t('guardrails.resetOneSuccess', { model: c.modelId }));
      } else {
        const res = await api.resetBreakersScoped('pair', { model: c.modelId, account: c.prefix });
        if ((res.resetCount ?? 0) > 0) toast.success(t('guardrails.resetPairSuccess', { model: c.modelId, account: c.prefix }));
        else toast.info(t('guardrails.resetScopeNone'));
      }
    } catch (err: any) {
      toast.error(t('guardrails.resetOneFailed') + err.message);
    } finally {
      setResettingPair(null);
    }
  };

  const categoryLabel = (cat?: string) => {
    switch (cat) {
      case 'QUOTA_EXHAUSTED': return t('guardrails.catQuota');
      case 'AUTHENTICATION_ERROR': return t('guardrails.catAuth');
      case 'RATE_LIMITED': return t('guardrails.catRate');
      case 'SERVICE_UNAVAILABLE': return t('guardrails.catService');
      case 'CLIENT_ERROR': return t('guardrails.catClient');
      case 'MANUAL': return t('guardrails.catManual');
      default: return t('guardrails.catUnknown');
    }
  };

  const stateLabel = (state: string) =>
    state === 'OPEN'
      ? t('guardrails.stateTripped')
      : state === 'HALF_OPEN'
        ? t('guardrails.stateHalfOpen')
        : t('guardrails.stateHealthy');

  const formatCooldown = (ms: number) =>
    ms >= 3600 * 1000
      ? t('guardrails.cooldownH', { h: (ms / (3600 * 1000)).toFixed(1) })
      : t('guardrails.cooldown', { sec: Math.round(ms / 1000) });

  /**
   * Probe pinned to THIS card's credential (KeysPage's per-account channel):
   * accountId selects the store row, the bare model id the pairing. The
   * synthetic config-key column has no store row to pin — the provider probe
   * IS that key (there is no chain). An orphan prefix (account gone) gets no
   * probe: the chain head would answer for a credential nobody selected.
   */
  const pairTestTarget = (c: PairCard): ModelTestTarget | null => {
    const provPrefix = `${c.provider}/`;
    const bare = c.modelId.startsWith(provPrefix) ? c.modelId.slice(provPrefix.length) : c.modelId;
    if (c.synthetic) return { key: c.key, providerId: c.provider, modelId: bare };
    if (!c.accountId) return null;
    return { key: c.key, providerId: c.provider, modelId: bare, accountId: c.accountId };
  };

  const stateFilters: { key: StateFilter; label: string }[] = [
    { key: 'ALL', label: `${t('guardrails.stateAll')} (${allItems.length})` },
    { key: 'OPEN', label: `${t('guardrails.stateTripped')} (${allItems.filter((c) => effectiveState(c) === 'OPEN').length})` },
    { key: 'HALF_OPEN', label: `${t('guardrails.stateHalfOpen')} (${allItems.filter((c) => effectiveState(c) === 'HALF_OPEN').length})` },
    { key: 'CLOSED', label: t('guardrails.stateHealthy') },
  ];

  const hashBadgeStyle: React.CSSProperties = {
    fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '8px',
    background: 'rgba(59, 130, 246, 0.14)',
    color: '#8fb8f5',
    border: '1px solid rgba(59, 130, 246, 0.35)',
    whiteSpace: 'nowrap',
  };

  /** The one card shape: a (model × credential) pairing, label up front. */
  const renderPairCard = (c: PairCard) => {
    const state = effectiveState(c);
    const isClosed = state === 'CLOSED';
    const isOpen = state === 'OPEN';
    const noRecord = !c.snap && !c.modelSnap;
    const borderColor = isOpen
      ? 'var(--accent-rose)'
      : state === 'HALF_OPEN'
        ? 'var(--accent-amber)'
        : 'var(--card-border)';
    const res = testResults[c.key];
    const pTest = pairTestTarget(c);
    const testing = pTest && testingIds.has(pTest.key);
    const pairTripped = !!c.snap && c.snap.state !== 'CLOSED';
    const modelTripped = !!c.modelSnap && c.modelSnap.state !== 'CLOSED';
    const openPairs = openPairsByModel.get(c.modelId) ?? 0;
    const singlePoint = openPairs > 0 && c.chainLen >= 2 && c.chainLen - openPairs <= 1;
    const statSnap = c.snap ?? c.modelSnap;
    const cooldown = effectiveCooldown(c);
    return (
      <div
        key={c.key}
        style={{
          padding: '12px 14px',
          borderRadius: '8px',
          background: 'var(--bg-elev)',
          border: `1px solid ${borderColor}`,
          borderLeft: `3px solid ${borderColor}`,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: '13px', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", overflowWrap: 'anywhere' }}>
              {c.modelId}
            </span>
            {singlePoint && (
              <span className="badge badge-warning" style={{ whiteSpace: 'nowrap' }}>
                {t('guardrails.singlePoint')}
              </span>
            )}
            {res && (
              <span
                style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', whiteSpace: 'nowrap', color: res.ok ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}
                title={res.ok ? `${res.latencyMs} ms` : res.error}
              >
                {res.ok ? `✓${res.latencyMs}ms` : '✗'}
              </span>
            )}
          </div>
          <span
            className={`badge ${isClosed ? 'badge-success' : isOpen ? 'badge-danger' : 'badge-warning'}`}
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            title={noRecord ? t('guardrails.noPairRecords') : undefined}
          >
            {stateLabel(state)}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-dim)', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: 'var(--text)' }} title={c.unmatched ? t('guardrails.unmatchedHint') : undefined}>
            {c.label}
          </span>
          {c.synthetic ? (
            c.maskedKey ? <span style={hashBadgeStyle}>{c.maskedKey}</span> : null
          ) : (
            // Hover reveals the MASKED key only — the raw key never leaves
            // the password-gated reveal route (ADR-0019 Decision 10).
            <span
              style={hashBadgeStyle}
              // maskedKey is display-safe data — appended outside the translated template.
              title={t('guardrails.keyHashBadge', { prefix: c.prefix }) + (c.maskedKey ? ` · ${c.maskedKey}` : '')}
            >
              #{c.prefix}
            </span>
          )}
          {c.suspect && (
            <span style={{ display: 'inline-flex', color: 'var(--accent-rose)' }} title={t('op.accountSuspectTip')}>
              <AlertTriangle size={12} />
            </span>
          )}
          {c.disabled && (
            <span style={{ display: 'inline-flex', color: 'var(--accent-rose)' }} title={c.disabledReason || t('op.accountDisabledTip')}>
              <Ban size={12} />
            </span>
          )}
          <span>· {c.provider}</span>
        </div>

        {pairTripped && c.snap?.reason && (
          <div
            title={c.snap.reason}
            style={{
              fontSize: '11px',
              color: c.snap.state === 'OPEN' ? 'var(--accent-rose)' : 'var(--accent-amber)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.5,
            }}
          >
            {t('guardrails.reasonLabel')}: {formatReason(c.snap.reasonCode, c.snap.reasonParams, c.snap.reason, t)}
          </div>
        )}
        {modelTripped && c.modelSnap?.reason && (
          <div
            title={c.modelSnap.reason}
            style={{
              fontSize: '11px',
              color: c.modelSnap.state === 'OPEN' ? 'var(--accent-rose)' : 'var(--accent-amber)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.5,
            }}
          >
            {t('guardrails.modelLevel')}: {formatReason(c.modelSnap.reasonCode, c.modelSnap.reasonParams, c.modelSnap.reason, t)}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-dim)' }}>
          <span>{t('guardrails.failures', { count: statSnap?.consecutiveFailures ?? 0 })}</span>
          {cooldown > 0 && <span style={{ color: 'var(--accent-amber)' }}>{formatCooldown(cooldown)}</span>}
        </div>

        {tripPanelKey === c.key ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px', borderTop: '1px dashed var(--card-border)' }}>
            {c.chainLen >= 2 ? (
              <span style={{ display: 'inline-flex' }} title={t('guardrails.tripScopeTip')}>
                <Combobox
                  value={tripScope}
                  onChange={(v) => setTripScope(v === 'account' || v === 'pair' ? v : 'model')}
                  options={scopeOptions}
                  style={{ fontSize: '11px', padding: '4px 8px', width: '160px' }}
                  panelMinWidth={210}
                />
              </span>
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                {t(SCOPE_LABEL_KEY.model)} · {t('guardrails.singleCredHint')}
              </div>
            )}
            <input
              type="text"
              className="input"
              aria-label={t('guardrails.tripReasonPlaceholder')}
              style={{ fontSize: '12px', padding: '6px 10px' }}
              placeholder={t('guardrails.tripReasonPlaceholder')}
              value={tripReason}
              onChange={(e) => setTripReason(e.target.value)}
            />
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              {TRIP_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="btn btn-sm"
                  disabled={trippingKey === c.key}
                  onClick={() => handleTrip(c, p.ms)}
                  style={{ fontSize: '11px', padding: '3px 8px', background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-text)', borderColor: 'var(--btn-primary-bg)' }}
                >
                  {p.label}
                </button>
              ))}
              {tripScope !== 'model' && (
                <button
                  className="btn btn-sm"
                  disabled={resettingScope || trippingKey === c.key}
                  onClick={() => handleResetScope(c)}
                  title={t('guardrails.tripScopeTip')}
                  style={{ fontSize: '11px', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <RotateCcw size={11} />
                  <span>{resettingScope ? t('guardrails.resetting') : t('guardrails.resetScope')}</span>
                </button>
              )}
              <button className="btn btn-sm" style={{ fontSize: '11px', padding: '3px 8px' }} onClick={closeTripPanel}>
                {t('guardrails.tripCancel')}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', minHeight: '26px', flexWrap: 'wrap' }}>
            {!isClosed && statSnap && (
              <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginRight: 'auto' }}>
                {categoryLabel((pairTripped ? c.snap : c.modelSnap)?.category)}
              </span>
            )}
            {pTest && (
              <button
                className="btn btn-sm"
                style={{ display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
                disabled={isBusy}
                onClick={() => testOne(pTest)}
                title={c.synthetic ? undefined : t('op.accountTestTip')}
              >
                {testing ? <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Zap size={12} />}
                <span>{testing ? t('op.testing') : t('op.testBtn')}</span>
              </button>
            )}
            {pairTripped ? (
              <button
                className="btn btn-sm"
                disabled={resettingPair === c.key}
                onClick={() => handleRecoverPair(c)}
                style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
              >
                <RotateCcw size={12} />
                <span>{resettingPair === c.key ? t('guardrails.resetting') : t('guardrails.resetOne')}</span>
              </button>
            ) : modelTripped ? (
              <button
                className="btn btn-sm"
                disabled={resettingModel === c.modelId}
                onClick={() => handleResetOne(c.modelId)}
                title={t('guardrails.modelLevel')}
                style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
              >
                <RotateCcw size={12} />
                <span>{resettingModel === c.modelId ? t('guardrails.resetting') : t('guardrails.resetModelLevel')}</span>
              </button>
            ) : (
              <button
                className="btn btn-sm"
                onClick={() => openTripPanel(c)}
                style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
              >
                <Ban size={12} />
                <span>{t('guardrails.tripOne')}</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
      {/* Top Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>{t('guardrails.totalBreakers')}</div>
          <div style={{ fontSize: '28px', fontWeight: 800 }}>{totalBreakers + pairTotal}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>
            {pairTotal > 0 ? t('guardrails.pairSplit', { m: totalBreakers, p: pairTotal }) : t('guardrails.totalBreakersSub')}
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>{t('guardrails.openBreakers')}</div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: openCount + pairOpen > 0 ? 'var(--accent-rose)' : 'var(--accent-emerald)' }}>
            {openCount + pairOpen}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>
            {openCount + pairOpen > 0 ? t('guardrails.openSubTripped') : t('guardrails.openSubSafe')}
          </div>
          {pairOpen > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--accent-rose)', marginTop: '2px' }}>
              {t('guardrails.pairTrippedSub', { n: pairOpen })}
            </div>
          )}
          {halfOpenCount + pairHalf > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--accent-amber)', marginTop: '2px' }}>
              {t('guardrails.stateHalfOpen')}: {halfOpenCount + pairHalf}
            </div>
          )}
        </div>
      </div>

      {/* Circuit Breaker Matrix */}
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="card-header">
          <div className="card-title">
            <ShieldAlert size={18} color="var(--accent-rose)" />
            <span>{t('guardrails.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-primary" onClick={handleResetAll} disabled={isResetting}>
              <RefreshCw size={13} />
              <span>{isResetting ? t('guardrails.resetting') : t('guardrails.resetAll')}</span>
            </button>
          </div>
        </div>

        {/* Filter bar — provider / model / credential drill-downs (filterable Comboboxes) */}
        <div style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          {providerFilterOptions.length > 0 && (
            <Combobox
              value={providerFilter}
              onChange={(v) => { setProviderFilter(v); setBreakerPage(1); }}
              options={providerFilterOptions}
              placeholder={t('guardrails.providerFilter')}
              clearable
              forceFilter
              style={{ fontSize: '12px', padding: '7px 12px', minWidth: 160, width: 'auto', flexShrink: 0 }}
              panelMinWidth={260}
            />
          )}
          {modelFilterOptions.length > 0 && (
            <Combobox
              value={modelIdFilter}
              onChange={(v) => { setModelIdFilter(v); setBreakerPage(1); }}
              options={modelFilterOptions}
              placeholder={t('guardrails.modelFilter')}
              clearable
              forceFilter
              style={{ fontSize: '12px', padding: '7px 12px', minWidth: 260, flex: '1 1 260px' }}
              panelMinWidth={320}
            />
          )}
          {accountFilterOptions.length > 0 && (
            <Combobox
              value={accountFilter}
              onChange={(v) => { setAccountFilter(v); setBreakerPage(1); }}
              options={accountFilterOptions}
              placeholder={t('guardrails.accountFilter')}
              clearable
              forceFilter
              style={{ fontSize: '12px', padding: '7px 12px', minWidth: 260, flex: '1 1 260px' }}
              panelMinWidth={280}
            />
          )}
        </div>

        {/* State Filter Chips */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
          {stateFilters.map(sf => (
            <button
              key={sf.key}
              className="btn btn-sm"
              onClick={() => { setStateFilter(sf.key); setBreakerPage(1); }}
              style={
                stateFilter === sf.key
                  ? { background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-text)', borderColor: 'var(--btn-primary-bg)' }
                  : undefined
              }
            >
              {sf.label}
            </button>
          ))}
        </div>

        {/* Matrix Grid — every card is one (model × credential) pairing */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start' }}>
          {pagedItems.length > 0 ? (
            pagedItems.map(renderPairCard)
          ) : (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', gridColumn: '1 / -1' }}>
              {t('guardrails.noMatch')}
            </div>
          )}
        </div>
        <Pagination
          page={breakerPage}
          pageSize={breakerPageSize}
          total={filteredItems.length}
          onChange={setBreakerPage}
          pageSizeOptions={BREAKER_PAGE_SIZES}
          onPageSizeChange={(s) => { setBreakerPageSize(s); setBreakerPage(1); }}
        />
      </div>
    </div>
  );
};
