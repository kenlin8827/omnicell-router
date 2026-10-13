import React, { useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ShieldAlert, RefreshCw, Search, RotateCcw, Ban, Zap, Loader2 } from 'lucide-react';
import { api, opencodeApi, type GatewayStatusResponse, type BreakerInfo, type BreakerTripScope, type AccountHealth } from '../lib/api';
import { useModelTest, type ModelTestTarget } from '../lib/useModelTest';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
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
  const [modelFilter, setModelFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('ALL');
  const [breakerPage, setBreakerPage] = useState(1);
  const [breakerPageSize, setBreakerPageSize] = useState(BREAKER_PAGE_SIZE);
  const [isResetting, setIsResetting] = useState(false);
  const [resettingModel, setResettingModel] = useState<string | null>(null);
  const [tripPanelModel, setTripPanelModel] = useState<string | null>(null);
  const [tripReason, setTripReason] = useState('');
  const [trippingModel, setTrippingModel] = useState<string | null>(null);
  // ADR-0019 P3 scope-aware trip/reset. 'model' is the legacy whole-model flow and
  // keeps calling the legacy client method, so its request body stays as today.
  const [tripScope, setTripScope] = useState<BreakerTripScope>('model');
  const [tripAccount, setTripAccount] = useState('');
  const [tripModelId, setTripModelId] = useState('');
  const [resettingScope, setResettingScope] = useState(false);
  // Credential picker source: the bound store's masked accounts, fetched once
  // per page for the first scoped panel open. null = not tried, [] = none.
  const [storeAccounts, setStoreAccounts] = useState<AccountHealth[] | null>(null);
  const [storeAccountsFailed, setStoreAccountsFailed] = useState(false);

  // Localized option rows are rebuilt per language; the code→key table is static.
  const scopeOptions = useMemo(
    () => TRIP_SCOPES.map((s) => ({ value: s, label: t(SCOPE_LABEL_KEY[s]) })),
    [t]
  );
  // Only prefixed accounts can own pair breakers (Decision 5 identity is the keyHash).
  const accountOptions = useMemo(
    () =>
      (storeAccounts ?? []).flatMap((a) => {
        const prefix = a.keyHashPrefix;
        if (!prefix) return [];
        return [{ value: prefix, label: `${a.label?.trim() || a.id} #${prefix}`, meta: a.providerId }];
      }),
    [storeAccounts]
  );

  const loadStoreAccounts = async () => {
    if (storeAccounts !== null) return;
    try {
      const res = await opencodeApi.getCredentialStore();
      setStoreAccounts(res.store.accounts.flatMap((a) => a.accounts ?? []));
    } catch {
      setStoreAccounts([]);
      setStoreAccountsFailed(true);
    }
  };

  const openTripPanel = (modelId: string) => {
    setTripPanelModel(modelId);
    setTripReason('');
    setTripScope('model');
    setTripAccount('');
    setTripModelId(modelId);
    loadStoreAccounts();
  };

  const closeTripPanel = () => {
    setTripPanelModel(null);
    setTripReason('');
    setTripScope('model');
    setTripAccount('');
    setTripModelId('');
  };

  /** Target guard for the non-legacy scopes (backend 400s a missing account/model). */
  const scopedTarget = (): { model?: string; account: string } | null => {
    if (!tripAccount) {
      toast.error(t('guardrails.tripNeedAccount'));
      return null;
    }
    if (tripScope === 'pair') {
      const model = tripModelId.trim();
      if (!model) {
        toast.error(t('guardrails.tripNeedModel'));
        return null;
      }
      return { model, account: tripAccount };
    }
    return { account: tripAccount };
  };

  const { testingIds, testResults, testOne, isBusy } = useModelTest();

  const breakers: BreakerInfo[] = status?.circuitBreakers?.breakers || [];
  const openCount = status?.circuitBreakers?.tripped || 0;
  const halfOpenCount = status?.circuitBreakers?.halfOpen || 0;
  const totalBreakers = status?.circuitBreakers?.total || 0;

  const filteredBreakers = breakers
    .filter(b => stateFilter === 'ALL' || b.state === stateFilter)
    .filter(b => b.modelId.toLowerCase().includes(modelFilter.toLowerCase()))
    .sort((a, b) =>
      STATE_ORDER[a.state] !== STATE_ORDER[b.state]
        ? STATE_ORDER[a.state] - STATE_ORDER[b.state]
        : b.remainingCooldownMs - a.remainingCooldownMs
    );
  const pagedBreakers = filteredBreakers.slice(
    (breakerPage - 1) * breakerPageSize,
    breakerPage * breakerPageSize
  );

  const handleResetAll = async () => {
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

  const handleTrip = async (modelId: string, cooldownMs: number) => {
    const scope = tripScope;
    // 'model' addresses the row's own model; the finer scopes need a credential
    // (and a model for 'pair'), validated client-side before the request.
    const target = scope === 'model' ? { model: modelId } : scopedTarget();
    if (!target) return;
    setTrippingModel(modelId);
    const opts = { reason: tripReason.trim() || undefined, cooldownMs };
    try {
      if (scope === 'model') {
        await api.tripBreaker(modelId, opts);
        toast.success(t('guardrails.tripSuccess', { model: modelId }));
      } else {
        const res = await api.tripBreakersScoped(scope, { ...target, ...opts });
        toast.success(t('guardrails.tripScopeSuccess', { scope: t(SCOPE_LABEL_KEY[scope]), n: res.affected ?? 0 }));
      }
      closeTripPanel();
    } catch (err: any) {
      toast.error(t('guardrails.tripFailed') + err.message);
    } finally {
      setTrippingModel(null);
    }
  };

  /** Scoped reset — the undo door for an account/pair trip made here. */
  const handleResetScope = async () => {
    const scope = tripScope;
    if (scope === 'model') return;
    const target = scopedTarget();
    if (!target) return;
    setResettingScope(true);
    try {
      const res = await api.resetBreakersScoped(scope, target);
      const n = res.resetCount ?? 0;
      if (n > 0) toast.success(t('guardrails.resetScopeSuccess', { n }));
      else toast.info(t('guardrails.resetScopeNone'));
    } catch (err: any) {
      toast.error(t('guardrails.resetOneFailed') + err.message);
    } finally {
      setResettingScope(false);
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
   * Probe target for a breaker row. Registered model ids are qualified
   * (`providerId/modelId` — both boot-direct and catalog sync build them that
   * way) while the probe endpoint takes the bare config/catalog model key, so
   * strip the provider prefix. Rows whose id is not prefixed (hand-written
   * config models) cannot be mapped to a provider and get no test button.
   */
  const testTargetFor = (b: BreakerInfo): ModelTestTarget | null => {
    const prefix = `${b.provider}/`;
    return b.modelId.startsWith(prefix)
      ? { key: b.modelId, providerId: b.provider, modelId: b.modelId.slice(prefix.length) }
      : null;
  };

  const stateFilters: { key: StateFilter; label: string }[] = [
    { key: 'ALL', label: `${t('guardrails.stateAll')} (${breakers.length})` },
    { key: 'OPEN', label: `${t('guardrails.stateTripped')} (${openCount})` },
    { key: 'HALF_OPEN', label: `${t('guardrails.stateHalfOpen')} (${halfOpenCount})` },
    { key: 'CLOSED', label: t('guardrails.stateHealthy') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
      {/* Top Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>{t('guardrails.totalBreakers')}</div>
          <div style={{ fontSize: '28px', fontWeight: 800 }}>{totalBreakers}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>{t('guardrails.totalBreakersSub')}</div>
        </div>

        <div className="card">
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>{t('guardrails.openBreakers')}</div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: openCount > 0 ? 'var(--accent-rose)' : 'var(--accent-emerald)' }}>
            {openCount}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>
            {openCount > 0 ? t('guardrails.openSubTripped') : t('guardrails.openSubSafe')}
          </div>
          {halfOpenCount > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--accent-amber)', marginTop: '2px' }}>
              {t('guardrails.stateHalfOpen')}: {halfOpenCount}
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

        {/* Filter Input */}
        <div style={{ marginBottom: '12px', position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
          <input
            type="text"
            value={modelFilter}
            onChange={e => { setModelFilter(e.target.value); setBreakerPage(1); }}
            placeholder={t('guardrails.searchFilter')}
            className="input"
            style={{ paddingLeft: '34px' }}
          />
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

        {/* Matrix Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start' }}>
          {pagedBreakers.length > 0 ? (
            pagedBreakers.map(b => {
              const isClosed = b.state === 'CLOSED';
              const isOpen = b.state === 'OPEN';
              const testTarget = testTargetFor(b);
              const res = testResults[b.modelId];
              const borderColor = isOpen
                ? 'var(--accent-rose)'
                : b.state === 'HALF_OPEN'
                  ? 'var(--accent-amber)'
                  : 'var(--card-border)';
              return (
                <div
                  key={b.modelId}
                  style={{
                    padding: '12px 14px',
                    borderRadius: '8px',
                    background: 'var(--bg-elev)',
                    border: `1px solid ${borderColor}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: '13px', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", overflowWrap: 'anywhere' }}>
                        {b.modelId}
                      </span>
                      {res && (
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                            fontSize: '10px',
                            whiteSpace: 'nowrap',
                            color: res.ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                          }}
                          title={res.ok ? `${res.latencyMs} ms` : res.error}
                        >
                          {res.ok ? `✓${res.latencyMs}ms` : '✗'}
                        </span>
                      )}
                    </div>
                    <span
                      className={`badge ${isClosed ? 'badge-success' : isOpen ? 'badge-danger' : 'badge-warning'}`}
                      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {stateLabel(b.state)}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{b.provider}</div>

                  {!isClosed && b.reason && (
                    <div
                      title={b.reason}
                      style={{
                        fontSize: '11px',
                        color: isOpen ? 'var(--accent-rose)' : 'var(--accent-amber)',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        lineHeight: 1.5,
                      }}
                    >
                      {t('guardrails.reasonLabel')}: {b.reason}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-dim)' }}>
                    <span>{t('guardrails.failures', { count: b.consecutiveFailures })}</span>
                    {b.remainingCooldownMs > 0 && (
                      <span style={{ color: 'var(--accent-amber)' }}>{formatCooldown(b.remainingCooldownMs)}</span>
                    )}
                  </div>

                  {tripPanelModel === b.modelId ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px', borderTop: '1px dashed var(--card-border)' }}>
                      {/* ADR-0019 P3 — scope selector; 'model' keeps today's legacy flow. */}
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ display: 'inline-flex' }} title={t('guardrails.tripScopeTip')}>
                          <Combobox
                            value={tripScope}
                            onChange={(v) => setTripScope(v === 'account' || v === 'pair' ? v : 'model')}
                            options={scopeOptions}
                            style={{ fontSize: '11px', padding: '4px 8px', width: '160px' }}
                            panelMinWidth={210}
                          />
                        </span>
                        {tripScope !== 'model' &&
                          (accountOptions.length > 0 ? (
                            <Combobox
                              value={tripAccount}
                              onChange={setTripAccount}
                              options={accountOptions}
                              placeholder={t('guardrails.accountPick')}
                              clearable
                              style={{ fontSize: '11px', padding: '4px 8px', flex: 1, minWidth: 150 }}
                              panelMinWidth={260}
                            />
                          ) : (
                            <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                              {storeAccountsFailed ? t('guardrails.accountStoreFailed') : t('guardrails.accountNone')}
                            </span>
                          ))}
                        {tripScope === 'pair' && (
                          <input
                            type="text"
                            className="input"
                            aria-label={t('guardrails.tripModelPlaceholder')}
                            style={{ fontSize: '11px', padding: '4px 8px', flex: 1, minWidth: 130 }}
                            placeholder={t('guardrails.tripModelPlaceholder')}
                            value={tripModelId}
                            onChange={(e) => setTripModelId(e.target.value)}
                          />
                        )}
                      </div>
                      <input
                        type="text"
                        className="input"
                        aria-label={t('guardrails.tripReasonPlaceholder')}
                        style={{ fontSize: '12px', padding: '6px 10px' }}
                        placeholder={t('guardrails.tripReasonPlaceholder')}
                        value={tripReason}
                        onChange={e => setTripReason(e.target.value)}
                      />
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {TRIP_PRESETS.map(p => (
                          <button
                            key={p.label}
                            className="btn btn-sm"
                            disabled={trippingModel === b.modelId}
                            onClick={() => handleTrip(b.modelId, p.ms)}
                            style={{ fontSize: '11px', padding: '3px 8px', background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-text)', borderColor: 'var(--btn-primary-bg)' }}
                          >
                            {p.label}
                          </button>
                        ))}
                        {tripScope !== 'model' && (
                          <button
                            className="btn btn-sm"
                            disabled={resettingScope || trippingModel === b.modelId}
                            onClick={handleResetScope}
                            title={t('guardrails.tripScopeTip')}
                            style={{ fontSize: '11px', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
                          >
                            <RotateCcw size={11} />
                            <span>{resettingScope ? t('guardrails.resetting') : t('guardrails.resetScope')}</span>
                          </button>
                        )}
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: '11px', padding: '3px 8px' }}
                          onClick={closeTripPanel}
                        >
                          {t('guardrails.tripCancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', minHeight: '26px', flexWrap: 'wrap' }}>
                      {!isClosed && (
                        <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginRight: 'auto' }}>
                          {categoryLabel(b.category)}
                        </span>
                      )}
                      {testTarget && (
                        <button
                          className="btn btn-sm"
                          style={{ display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap', flexShrink: 0 }}
                          disabled={isBusy}
                          onClick={() => testOne(testTarget)}
                        >
                          {testingIds.has(b.modelId) ? (
                            <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />
                          ) : (
                            <Zap size={12} />
                          )}
                          <span>{testingIds.has(b.modelId) ? t('op.testing') : t('op.testBtn')}</span>
                        </button>
                      )}
                      {!isClosed ? (
                        <button
                          className="btn btn-sm"
                          disabled={resettingModel === b.modelId}
                          onClick={() => handleResetOne(b.modelId)}
                          style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
                        >
                          <RotateCcw size={12} />
                          <span>{resettingModel === b.modelId ? t('guardrails.resetting') : t('guardrails.resetOne')}</span>
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm"
                          onClick={() => openTripPanel(b.modelId)}
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
            })
          ) : (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', gridColumn: '1 / -1' }}>
              {t('guardrails.noMatch')}
            </div>
          )}
        </div>
        <Pagination
          page={breakerPage}
          pageSize={breakerPageSize}
          total={filteredBreakers.length}
          onChange={setBreakerPage}
          pageSizeOptions={BREAKER_PAGE_SIZES}
          onPageSizeChange={(s) => { setBreakerPageSize(s); setBreakerPage(1); }}
        />
      </div>
    </div>
  );
};
