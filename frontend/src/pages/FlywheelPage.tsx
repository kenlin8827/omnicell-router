import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrainCircuit,
  Database,
  Loader2,
  RotateCcw,
  Search,
  Undo2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import {
  api,
  type FlywheelSample,
  type FlywheelSummary,
  type FlywheelTrainingState,
  type TierName,
} from '../lib/api';

import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';
import { Switch } from '../components/Switch';

const TIERS: TierName[] = ['lite', 'plus', 'pro', 'ultra'];

const spin: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

const SOURCE_COLOR: Record<string, string> = {
  human: 'var(--accent)',
  runtime_fallback: 'var(--accent-emerald)',
  observed_execution: 'var(--text-dim)',
  unlabeled: 'var(--accent-red, #ef4444)',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/**
 * Data flywheel console — browse the routing decision dataset, correct labels
 * by hand and trigger a Layer 1 training run.
 *
 * Relabelling writes a sidecar overlay, so a correction never rewrites what
 * the router actually did; the original decision and execution stay visible
 * next to the operator's verdict for later review.
 */
export const FlywheelPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();

  const [summary, setSummary] = useState<FlywheelSummary | null>(null);
  const [training, setTraining] = useState<FlywheelTrainingState | null>(null);
  const [rows, setRows] = useState<FlywheelSample[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [tierFilter, setTierFilter] = useState<string>('any');
  const [sourceFilter, setSourceFilter] = useState<string>('any');
  const [includeSynthetic, setIncludeSynthetic] = useState(false);
  const [trainableOnly, setTrainableOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [balanceClasses, setBalanceClasses] = useState(true);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const isTraining = training?.status === 'training';

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.getFlywheelStats());
    } catch (err: any) {
      console.warn('flywheel stats failed:', err);
    }
  }, []);

  const loadTraining = useCallback(async () => {
    try {
      setTraining(await api.getFlywheelTraining());
    } catch (err: any) {
      console.warn('flywheel training state failed:', err);
    }
  }, []);

  const loadSamples = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getFlywheelSamples({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        tier: tierFilter,
        source: sourceFilter,
        includeSynthetic,
        trainableOnly,
        search: search || undefined,
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err: any) {
      toast.error(t('flywheel.loadFailed') + ' ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, tierFilter, sourceFilter, includeSynthetic, trainableOnly, search, t, toast]);

  useEffect(() => {
    loadSummary();
    loadTraining();
  }, [loadSummary, loadTraining]);

  useEffect(() => {
    loadSamples();
  }, [loadSamples]);

  // While a run is in flight, poll the state so the button and the status line
  // stay in sync even if the page was reloaded mid-training.
  useEffect(() => {
    if (!isTraining) return;
    const timer = setInterval(() => {
      loadTraining();
      loadSummary();
    }, 1500);
    return () => clearInterval(timer);
  }, [isTraining, loadTraining, loadSummary]);

  // Debounce the search box so typing does not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchDraft.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  const handleLabel = async (row: FlywheelSample, tier: TierName | null) => {
    if (isTraining) {
      toast.error(t('flywheel.lockedWhileTraining'));
      return;
    }
    setSavingId(row.id);
    try {
      await api.setFlywheelLabel(row.id, tier);
      // Patch the row in place — a full refetch would drop the open detail pane.
      setRows(prev =>
        prev.map(r =>
          r.id === row.id
            ? {
                ...r,
                label: {
                  ...r.label,
                  tier,
                  source: tier ? 'human' : r.execution.fallbackOccurred ? 'runtime_fallback' : 'observed_execution',
                  confidence: tier ? 1 : r.execution.fallbackOccurred ? 0.9 : 0.5,
                  updatedAt: tier ? new Date().toISOString() : undefined,
                },
              }
            : r
        )
      );
      await loadSummary();
      toast.success(tier ? t('flywheel.labelSaved') : t('flywheel.labelCleared'));
    } catch (err: any) {
      toast.error(t('flywheel.labelFailed') + ' ' + err.message);
    } finally {
      setSavingId(null);
    }
  };

  const handleTrain = async () => {
    if (isTraining) return;
    const ok = await confirmDialog({
      title: t('flywheel.trainConfirmTitle'),
      description: t('flywheel.trainConfirmDesc'),
      confirmLabel: t('flywheel.trainNow'),
    });
    if (!ok) return;
    try {
      const res = await api.startFlywheelTraining({ balanceClasses, minLabelSource: 'observed_execution' });
      setTraining({ ...(training as FlywheelTrainingState), ...res.state });
      toast.success(t('flywheel.trainStarted'));
      await Promise.all([loadTraining(), loadSummary()]);
    } catch (err: any) {
      toast.error(t('flywheel.trainFailed') + ' ' + err.message);
      await loadTraining();
    }
  };

  const handleRollback = async () => {
    const ok = await confirmDialog({
      title: t('flywheel.rollbackConfirmTitle'),
      description: t('flywheel.rollbackConfirmDesc'),
      confirmLabel: t('flywheel.rollback'),
    });
    if (!ok) return;
    try {
      await api.rollbackFlywheelModel();
      toast.success(t('flywheel.rollbackDone'));
      await Promise.all([loadTraining(), loadSummary()]);
    } catch (err: any) {
      toast.error(t('flywheel.rollbackFailed') + ' ' + err.message);
    }
  };

  const handleClearLabels = async () => {
    const ok = await confirmDialog({
      title: t('flywheel.clearLabelsTitle'),
      description: t('flywheel.clearLabelsDesc'),
      confirmLabel: t('flywheel.clearLabels'),
    });
    if (!ok) return;
    try {
      const res = await api.clearFlywheelLabels();
      toast.success(t('flywheel.clearLabelsDone', { n: String(res.cleared) }));
      await Promise.all([loadSummary(), loadSamples()]);
    } catch (err: any) {
      toast.error(t('flywheel.clearLabelsFailed') + ' ' + err.message);
    }
  };

  const tierOptions = useMemo(
    () => [
      { value: 'any', label: t('flywheel.filterTierAll') },
      ...TIERS.map(tier => ({ value: tier, label: tier })),
      { value: 'none', label: t('flywheel.filterTierNone') },
    ],
    [t]
  );

  const sourceOptions = useMemo(
    () => [
      { value: 'any', label: t('flywheel.filterSourceAll') },
      { value: 'human', label: t('flywheel.sourceHuman') },
      { value: 'runtime_fallback', label: t('flywheel.sourceFallback') },
      { value: 'observed_execution', label: t('flywheel.sourceObserved') },
      { value: 'unlabeled', label: t('flywheel.sourceUnlabeled') },
    ],
    [t]
  );

  const card: React.CSSProperties = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: '12px',
    padding: '16px',
  };

  const statCell: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: '110px',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ---------- Flywheel header: the loop this page drives ---------- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BrainCircuit size={18} color="var(--accent)" />
          <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em' }}>{t('flywheel.pageTitle')}</span>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('flywheel.pageSubtitle')}</span>
      </div>

      {/* ---------- Training control ---------- */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BrainCircuit size={16} color="var(--accent)" />
          <span style={{ fontSize: 14, fontWeight: 700 }}>{t('flywheel.trainingTitle')}</span>
          {isTraining && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 9px',
                borderRadius: 999,
                background: 'rgba(245,158,11,0.14)',
                border: '1px solid rgba(245,158,11,0.35)',
                color: '#f59e0b',
              }}
            >
              <Loader2 size={11} style={spin} />
              {t('flywheel.trainingInProgress')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('flywheel.lastTrained')}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
              {fmtTime(training?.lastTrainedAt ?? training?.model.lastTrainedAt)}
            </span>
          </div>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('flywheel.modelStatus')}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {training?.model.isBaseModel ? t('flywheel.modelBase') : t('flywheel.modelTrained', { n: String(training?.model.sampleCount ?? 0) })}
            </span>
          </div>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('flywheel.trainablePool')}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
              {summary?.trainable ?? 0}
            </span>
          </div>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('flywheel.features')}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
              {training?.model.featureDimensions ?? '—'} × {training?.model.classes.length ?? 4}
            </span>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {training?.model.previousModelExists && (
              <button className="btn btn-sm" onClick={handleRollback} disabled={isTraining} title={t('flywheel.rollbackTitle')}>
                <Undo2 size={12} />
                {t('flywheel.rollback')}
              </button>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', cursor: isTraining ? 'not-allowed' : 'pointer' }}>
              <Switch checked={balanceClasses} onChange={setBalanceClasses} disabled={isTraining} />
              {t('flywheel.balanceClasses')}
            </label>
            <button className="btn btn-primary" onClick={handleTrain} disabled={isTraining} title={isTraining ? t('flywheel.trainingInProgress') : ''}>
              {isTraining ? <Loader2 size={13} style={spin} /> : <BrainCircuit size={13} />}
              {isTraining ? t('flywheel.trainingInProgress') : t('flywheel.trainNow')}
            </button>
          </div>
        </div>

        {/* Router consumption gate — the difference between "weights updated"
            and "routing actually changed" (classifier.localModel.enabled). */}
        {training?.model && (
          training.model.routingConsumesModel ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--accent-emerald)' }}>
              <CheckCircle2 size={13} />
              <span>{t('flywheel.routingActive')}</span>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#f59e0b' }}>
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{t('flywheel.routingInactive')}</span>
            </div>
          )
        )}

        {training?.status === 'failed' && training.error && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--accent-red, #ef4444)' }}>
            <XCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{training.error}</span>
          </div>
        )}

        {training?.lastResult && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)', paddingTop: 4 }}>
            <span>
              {t('flywheel.resultSamples', { n: String(training.lastResult.trainedSamples) })}
            </span>
            <span>
              {t('flywheel.resultAccuracy', { n: (training.lastResult.accuracy * 100).toFixed(1) })}
            </span>
            <span>
              {t('flywheel.resultLoss', { n: String(training.lastResult.finalLoss) })}
            </span>
            <span>
              {t('flywheel.resultDuration', { n: String(training.lastResult.durationMs) })}
            </span>
            <span style={{ color: 'var(--text-dim)' }}>
              {t('flywheel.resultClasses', {
                mix: TIERS.map(tier => `${tier}:${training.lastResult!.classDistribution[tier] ?? 0}`).join(' · '),
              })}
            </span>
          </div>
        )}
      </div>

      {/* ---------- Dataset summary ---------- */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Database size={16} color="var(--accent)" />
          <span style={{ fontSize: 14, fontWeight: 700 }}>{t('flywheel.datasetTitle')}</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
            {summary ? `${summary.total} ${t('flywheel.rows')} · ${fmtBytes(summary.fileBytes)}` : '—'}
          </span>
          <button
            className="btn btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              loadSummary();
              loadSamples();
            }}
            disabled={loading}
            title={t('flywheel.refresh')}
          >
            <RotateCcw size={12} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('flywheel.statTotal')}</span>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{summary?.total ?? 0}</span>
          </div>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('flywheel.statTrainable')}</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent-emerald)' }}>{summary?.trainable ?? 0}</span>
          </div>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('flywheel.statHuman')}</span>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{summary?.humanLabeled ?? 0}</span>
          </div>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('flywheel.statSynthetic')}</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-dim)' }}>{summary?.synthetic ?? 0}</span>
          </div>
          <div style={statCell}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('flywheel.statUnlabeled')}</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-dim)' }}>{summary?.unlabeled ?? 0}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {TIERS.map(tier => (
              <span
                key={tier}
                style={{
                  fontSize: 11,
                  fontFamily: 'JetBrains Mono, monospace',
                  padding: '3px 9px',
                  borderRadius: 6,
                  border: '1px solid var(--card-border)',
                  color: 'var(--text-muted)',
                }}
              >
                {tier} <b style={{ color: 'var(--text-main)' }}>{summary?.trainableByTier?.[tier] ?? 0}</b>
              </span>
            ))}
          </div>
        </div>

        {summary && summary.synthetic > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: 'var(--text-dim)' }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{t('flywheel.syntheticNotice', { n: String(summary.synthetic) })}</span>
          </div>
        )}
      </div>

      {/* ---------- Sample browser ---------- */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: '1 1 220px', minWidth: 180 }}>
            <Search size={13} style={{ position: 'absolute', left: 10, color: 'var(--text-dim)', pointerEvents: 'none' }} />
            <input
              className="input"
              type="text"
              value={searchDraft}
              onChange={e => setSearchDraft(e.target.value)}
              placeholder={t('flywheel.searchPlaceholder')}
              style={{ fontSize: 12, padding: '6px 10px 6px 28px', width: '100%' }}
            />
          </div>
          <Combobox
            value={tierFilter}
            onChange={v => {
              setTierFilter(v);
              setPage(1);
            }}
            options={tierOptions}
            style={{ fontSize: 12, padding: '6px 10px', width: 130 }}
          />
          <Combobox
            value={sourceFilter}
            onChange={v => {
              setSourceFilter(v);
              setPage(1);
            }}
            options={sourceOptions}
            style={{ fontSize: 12, padding: '6px 10px', width: 170 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-muted)' }}>
            <Switch
              checked={trainableOnly}
              onChange={v => {
                setTrainableOnly(v);
                setPage(1);
              }}
            />
            {t('flywheel.trainableOnly')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-muted)' }}>
            <Switch
              checked={includeSynthetic}
              onChange={v => {
                setIncludeSynthetic(v);
                setPage(1);
              }}
            />
            {t('flywheel.includeSynthetic')}
          </label>
          <button className="btn btn-sm" onClick={handleClearLabels} disabled={isTraining || !summary?.humanLabeled}>
            <Undo2 size={12} />
            {t('flywheel.clearLabels')}
          </button>
        </div>

        {isTraining && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#f59e0b' }}>
            <Loader2 size={13} style={spin} />
            {t('flywheel.lockedWhileTraining')}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {loading && rows.length === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim)', padding: 16 }}>
              <Loader2 size={13} style={spin} />
              {t('flywheel.loading')}
            </div>
          )}
          {!loading && rows.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: 16 }}>{t('flywheel.noSamples')}</div>
          )}

          {rows.map(row => {
            const expanded = expandedId === row.id;
            const saving = savingId === row.id;
            const rowBg = expanded ? 'rgba(255,255,255,0.04)' : 'transparent';
            return (
              <div
                key={row.id}
                style={{
                  border: '1px solid var(--card-border)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  background: rowBg,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '2px 7px',
                      borderRadius: 999,
                      border: '1px solid var(--card-border)',
                      color: SOURCE_COLOR[row.label.source] || 'var(--text-dim)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.label.source}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: 'JetBrains Mono, monospace',
                      color: row.decision.targetTier !== row.execution.tierUsed ? 'var(--accent-emerald)' : 'var(--text-dim)',
                      whiteSpace: 'nowrap',
                    }}
                    title={t('flywheel.decisionVsExecution')}
                  >
                    {row.decision.targetTier} → {row.execution.tierUsed}
                  </span>
                  {row.execution.fallbackOccurred && (
                    <span style={{ fontSize: 10, color: '#f59e0b', whiteSpace: 'nowrap' }} title={row.execution.fallbackReason || ''}>
                      {t('flywheel.fallbackBadge')}
                    </span>
                  )}
                  {row.execution.isSynthetic && (
                    <span style={{ fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{t('flywheel.syntheticBadge')}</span>
                  )}
                  {!row.trainable && (
                    <span style={{ fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap' }} title={t('flywheel.legacyNoVector')}>
                      {t('flywheel.legacyBadge')}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--text-main)',
                      flex: '1 1 200px',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                    title={row.userPrompt}
                  >
                    {row.userPrompt || '—'}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    {fmtTime(row.timestamp)}
                  </span>
                  <button className="btn btn-sm" onClick={() => setExpandedId(expanded ? null : row.id)}>
                    {expanded ? t('flywheel.collapse') : t('flywheel.details')}
                  </button>
                  <Combobox
                    value={row.label.tier || ''}
                    onChange={v => handleLabel(row, v === '' ? null : (v as TierName))}
                    placeholder={t('flywheel.labelPlaceholder')}
                    options={TIERS.map(tier => ({ value: tier, label: tier }))}
                    clearable
                    style={{ fontSize: 11, padding: '4px 8px', width: 110 }}
                  />
                  {row.label.source === 'human' && (
                    <button
                      className="btn btn-sm"
                      onClick={() => handleLabel(row, null)}
                      disabled={saving}
                      title={t('flywheel.revertLabel')}
                    >
                      <Undo2 size={11} />
                    </button>
                  )}
                  {saving && <Loader2 size={12} style={{ ...spin, color: 'var(--accent)' }} />}
                </div>

                {expanded && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                      gap: 10,
                      fontSize: 11,
                      fontFamily: 'JetBrains Mono, monospace',
                      color: 'var(--text-muted)',
                      paddingTop: 4,
                      borderTop: '1px dashed var(--card-border)',
                    }}
                  >
                    <div>
                      <div style={{ color: 'var(--text-dim)' }}>{t('flywheel.fieldId')}</div>
                      <div style={{ wordBreak: 'break-all' }}>{row.id}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-dim)' }}>{t('flywheel.fieldModel')}</div>
                      <div style={{ wordBreak: 'break-all' }}>{row.execution.modelUsed || '—'}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-dim)' }}>{t('flywheel.fieldLayer')}</div>
                      <div>
                        {row.decision.layerUsed} · {(row.decision.confidence * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-dim)' }}>{t('flywheel.fieldCost')}</div>
                      <div>
                        ${row.execution.costUsd.toFixed(6)} · {row.execution.latencyMs}ms · {row.tokenCount}tok
                      </div>
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div style={{ color: 'var(--text-dim)' }}>{t('flywheel.fieldReason')}</div>
                      <div style={{ wordBreak: 'break-word' }}>{row.decision.reason || '—'}</div>
                    </div>
                    {row.execution.fallbackReason && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div style={{ color: 'var(--text-dim)' }}>{t('flywheel.fieldFallbackReason')}</div>
                        <div style={{ wordBreak: 'break-word', color: '#f59e0b' }}>{row.execution.fallbackReason}</div>
                      </div>
                    )}
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div style={{ color: 'var(--text-dim)' }}>{t('flywheel.fieldVector')}</div>
                      <div style={{ wordBreak: 'break-all' }}>
                        {row.featureVector ? row.featureVector.map(n => n.toFixed(3)).join(', ') : t('flywheel.noVector')}
                      </div>
                    </div>
                    {row.label.updatedAt && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div style={{ color: 'var(--text-dim)' }}>{t('flywheel.fieldRelabeled')}</div>
                        <div>{fmtTime(row.label.updatedAt)}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          disabled={loading}
          showSummary
          pageSizeOptions={[10, 25, 50, 100]}
          onPageSizeChange={n => {
            setPageSize(n);
            setPage(1);
          }}
        />
      </div>
    </div>
  );
};
