import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AlertOctagon, RefreshCw, Search, Inbox, Activity, Eraser, Trash2 } from 'lucide-react';
import { api, type FailureEvent, type FailureErrorClass, type FailureEventRole } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { InfoTip } from '../components/InfoTip';
import { SegGroup } from '../components/SegGroup';

import { FONT_MONO } from '../lib/fonts';
/**
 * Model-call failure observability — the "which models failed, and why"
 * plane. Two sections over the same failure_events ledger (backend
 * observability/failure-events.ts): a per-model aggregation strip (total
 * failed calls, cause breakdown, last seen) and the coalesced event list
 * itself. The ledger records every failed upstream model call from the
 * serving pool and the L2 decision layer; it is a bounded ring durably
 * mirrored in traces.db, so it survives restarts.
 */

const REFRESH_MS = 3000;

const CLASS_COLORS: Record<FailureErrorClass, string> = {
  QUOTA_EXHAUSTED: '#ef4444',
  AUTHENTICATION_ERROR: '#ef4444',
  RATE_LIMITED: 'var(--accent-amber)',
  SERVICE_UNAVAILABLE: 'var(--accent-amber)',
  CLIENT_ERROR: 'var(--text-dim)',
  MANUAL: 'var(--text-dim)',
  UNKNOWN: 'var(--text-dim)',
  TIMEOUT: 'var(--accent-amber)',
};

const ROLE_COLORS: Record<FailureEventRole, string> = {
  serving: 'var(--accent)',
  'l2-decision': '#a855f7',
  probe: 'var(--text-dim)',
};

const MONO: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: '11.5px' };

const TH: React.CSSProperties = {
  padding: '6px 10px',
  textAlign: 'left',
  fontSize: '11px',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
  borderBottom: '1px solid var(--divider)',
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--divider)',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  // The ledger survives restarts — entries can age past midnight, so a
  // non-today row carries its date.
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? time : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

/** Event time-window presets (client-side: the ring is capped at 500 rows). */
const TIME_RANGES: Record<string, number> = {
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

interface ModelAgg {
  key: string;
  model: string;
  provider: string;
  total: number;
  classes: Partial<Record<FailureErrorClass, number>>;
  lastTs: number;
}

export const FailuresPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [events, setEvents] = useState<FailureEvent[]>([]);
  const [role, setRole] = useState('');
  const [errorClass, setErrorClass] = useState('');
  const [timeRange, setTimeRange] = useState('');
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const ev = await api.getFailureEvents();
      setEvents(ev.events);
      setError(null);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(loadData, REFRESH_MS);
    return () => clearInterval(timer);
  }, [auto, loadData]);

  const handleClear = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('failuresPage.clearConfirmTitle'),
      description: t('failuresPage.clearConfirmDesc'),
      danger: true,
      confirmLabel: t('failuresPage.clear'),
    });
    if (!ok) return;
    try {
      await api.clearFailureEvents();
      toast.success(t('failuresPage.clearDone'));
      loadData();
    } catch (err: any) {
      toast.error(t('failuresPage.clearFailed') + ' ' + (err?.message || err));
    }
  }, [confirmDialog, toast, t, loadData]);

  // Single-event delete: optimistic row drop, refetch only on failure. No
  // confirm dialog — one bounded observability row (a coalesced ×N
  // observation dies whole, which is the intended unit).
  const handleRemove = useCallback(async (id: string) => {
    try {
      await api.deleteFailureEvent(id);
      setEvents((prev) => prev.filter((e) => e.id !== id));
    } catch (err: any) {
      toast.error(t('failuresPage.removeFailed') + ' ' + (err?.message || err));
      loadData();
    }
  }, [toast, t, loadData]);

  const matches = useCallback(
    (e: FailureEvent): boolean => {
      if (role && e.role !== role) return false;
      if (errorClass && e.errorClass !== errorClass) return false;
      if (timeRange) {
        const span = TIME_RANGES[timeRange];
        if (span && Date.now() - e.lastTs > span) return false;
      }
      if (q) {
        const hay = `${e.model} ${e.provider} ${e.message} ${e.sessionId ?? ''} ${e.status ?? ''}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    },
    [role, errorClass, timeRange, q]
  );

  const filteredEvents = useMemo(() => events.filter(matches), [events, matches]);

  // Per-model aggregation over the SAME filtered view — the strip and the
  // table always answer the same question ("under the current filter, which
  // models failed how often"). Sorted by total desc, then recency.
  const modelAggs = useMemo(() => {
    const byModel = new Map<string, ModelAgg>();
    for (const e of filteredEvents) {
      const key = `${e.provider}::${e.model}`;
      let agg = byModel.get(key);
      if (!agg) {
        agg = { key, model: e.model, provider: e.provider, total: 0, classes: {}, lastTs: 0 };
        byModel.set(key, agg);
      }
      agg.total += e.count;
      agg.classes[e.errorClass] = (agg.classes[e.errorClass] ?? 0) + e.count;
      if (e.lastTs > agg.lastTs) agg.lastTs = e.lastTs;
    }
    return [...byModel.values()].sort((a, b) => b.total - a.total || b.lastTs - a.lastTs);
  }, [filteredEvents]);

  const classLabel = (c: FailureErrorClass): string => {
    switch (c) {
      case 'QUOTA_EXHAUSTED':
        return t('failuresPage.classQuota');
      case 'AUTHENTICATION_ERROR':
        return t('failuresPage.classAuth');
      case 'RATE_LIMITED':
        return t('failuresPage.classRate');
      case 'SERVICE_UNAVAILABLE':
        return t('failuresPage.classService');
      case 'CLIENT_ERROR':
        return t('failuresPage.classClient');
      case 'MANUAL':
        return t('failuresPage.classManual');
      case 'TIMEOUT':
        return t('failuresPage.classTimeout');
      default:
        return t('failuresPage.classUnknown');
    }
  };

  const roleLabel = (r: FailureEventRole): string =>
    r === 'serving'
      ? t('failuresPage.roleServing')
      : r === 'l2-decision'
        ? t('failuresPage.roleL2Decision')
        : t('failuresPage.roleProbe');

  const presentClasses = useMemo(() => {
    const set = new Set<FailureErrorClass>(events.map((e) => e.errorClass));
    return [...set];
  }, [events]);

  const classBadge = (c: FailureErrorClass) => (
    <span
      className="badge"
      style={{
        background: `color-mix(in srgb, ${CLASS_COLORS[c]} 13%, transparent)`,
        color: CLASS_COLORS[c],
        border: `1px solid color-mix(in srgb, ${CLASS_COLORS[c]} 40%, transparent)`,
      }}
    >
      {classLabel(c)}
    </span>
  );

  const roleBadge = (r: FailureEventRole) => (
    <span
      className="badge"
      style={{
        background: `color-mix(in srgb, ${ROLE_COLORS[r]} 13%, transparent)`,
        color: ROLE_COLORS[r],
        border: `1px solid color-mix(in srgb, ${ROLE_COLORS[r]} 40%, transparent)`,
      }}
    >
      {roleLabel(r)}
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      {/* ── Per-model aggregation strip ──────────────────────────────────── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto', maxHeight: '38%' }}>
        <div className="card-header">
          <div className="card-title">
            <AlertOctagon size={18} color="var(--accent-amber)" />
            <span>{t('failuresPage.byModelTitle')}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '8px' }}>
              {t('failuresPage.shownOf', { shown: filteredEvents.length, total: events.length })}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button className="btn btn-sm" onClick={handleClear} disabled={events.length === 0} title={t('failuresPage.clear')}>
              <Eraser size={12} />
              <span>{t('failuresPage.clear')}</span>
            </button>
            <button
              className={`btn btn-sm ${auto ? 'btn-primary' : ''}`}
              onClick={() => setAuto((a) => !a)}
              title={t('failuresPage.autoHint')}
            >
              <Activity size={12} />
              <span>{t('failuresPage.auto')}</span>
            </button>
            <button className="btn btn-sm" onClick={loadData} disabled={loading}>
              <RefreshCw size={12} style={loading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
              <span>{t('failuresPage.refresh')}</span>
            </button>
          </div>
        </div>
        <div style={{ overflow: 'auto', padding: '0 14px 12px 14px' }}>
          {modelAggs.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--text-dim)', fontSize: '13px', padding: '18px' }}>
              <Inbox size={20} />
              <span>{events.length === 0 ? t('failuresPage.eventsEmpty') : t('failuresPage.filterEmpty')}</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {modelAggs.map((agg) => (
                <div
                  key={agg.key}
                  style={{
                    border: '1px solid var(--divider)',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    minWidth: '170px',
                    background: 'var(--chip-bg)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <div style={{ ...MONO, fontSize: '12.5px', color: 'var(--text-main)' }}>{agg.model}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{agg.provider}</div>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--accent-amber)' }}>
                    {t('failuresPage.cardTotal', { n: agg.total })}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {Object.entries(agg.classes)
                      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
                      .map(([c, n]) => (
                        <span key={c} style={{ fontSize: '10.5px', color: 'var(--text-dim)' }}>
                          {classLabel(c as FailureErrorClass)} ×{n}
                        </span>
                      ))}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                    {t('failuresPage.cardLastSeen', { time: fmtTime(agg.lastTs) })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Event ledger ─────────────────────────────────────────────────── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 60%', minHeight: 0 }}>
        <div className="card-header">
          <div className="card-title">
            <AlertOctagon size={18} color="var(--accent)" />
            <span>{t('failuresPage.eventsTitle')}</span>
          </div>
        </div>

        {/* Filter toolbar */}
        <div style={{ display: 'flex', gap: '8px', padding: '0 14px 12px 14px', flexWrap: 'wrap', alignItems: 'center' }}>
          <SegGroup
            value={role}
            onChange={setRole}
            options={[
              { value: '', label: t('failuresPage.roleAll') },
              { value: 'serving', label: t('failuresPage.roleServing') },
              { value: 'l2-decision', label: t('failuresPage.roleL2Decision') },
            ]}
          />
          <Combobox
            value={errorClass}
            onChange={setErrorClass}
            options={[
              { value: '', label: t('failuresPage.classAll') },
              ...presentClasses.map((c) => ({ value: c, label: classLabel(c) })),
            ]}
            style={{ fontSize: '12px', padding: '5px 10px', width: '160px' }}
          />
          <div style={{ position: 'relative', flex: 1, minWidth: '180px', maxWidth: '320px' }}>
            <Search size={13} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
            <input
              className="input"
              style={{ paddingLeft: '26px', width: '100%', fontSize: '12px', padding: '5px 10px 5px 26px' }}
              placeholder={t('failuresPage.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <InfoTip text={t('failuresPage.ledgerHint')} />
          <Combobox
            value={timeRange}
            onChange={setTimeRange}
            options={[
              { value: '', label: t('failuresPage.timeAll') },
              { value: '5m', label: t('failuresPage.time5m') },
              { value: '1h', label: t('failuresPage.time1h') },
              { value: '24h', label: t('failuresPage.time24h') },
              { value: '7d', label: t('failuresPage.time7d') },
            ]}
            style={{ fontSize: '12px', padding: '5px 10px', width: '130px', marginLeft: 'auto' }}
          />
        </div>

        {error && (
          <div style={{ padding: '0 14px 10px', color: '#ef4444', fontSize: '12px' }}>{error}</div>
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {filteredEvents.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '8px', color: 'var(--text-dim)', fontSize: '13px', padding: '24px' }}>
              <Inbox size={28} />
              <span>{events.length === 0 ? t('failuresPage.eventsEmpty') : t('failuresPage.filterEmpty')}</span>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <thead>
                <tr>
                  <th style={TH}>{t('failuresPage.colTime')}</th>
                  <th style={TH}>{t('failuresPage.colRole')}</th>
                  <th style={TH}>{t('failuresPage.colModel')}</th>
                  <th style={TH}>{t('failuresPage.colClass')}</th>
                  <th style={TH}>{t('failuresPage.colStatus')}</th>
                  <th style={TH}>{t('failuresPage.colMessage')}</th>
                  <th style={TH}>{t('failuresPage.colSession')}</th>
                  <th style={TH} aria-label={t('failuresPage.removeRow')} />
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...TD, ...MONO }}>
                      {fmtTime(e.lastTs)}
                      {e.count > 1 && (
                        <span style={{ marginLeft: 6, color: 'var(--accent-amber)' }}>×{e.count}</span>
                      )}
                    </td>
                    <td style={TD}>{roleBadge(e.role)}</td>
                    <td style={{ ...TD, ...MONO }}>
                      {e.model}
                      <span style={{ color: 'var(--text-dim)' }}> · {e.provider}</span>
                    </td>
                    <td style={TD}>{classBadge(e.errorClass)}</td>
                    <td style={{ ...TD, ...MONO }}>{e.status ?? '—'}</td>
                    <td style={{ ...TD, whiteSpace: 'normal', maxWidth: '420px', color: 'var(--text-dim)', wordBreak: 'break-word' }}>
                      {e.message}
                    </td>
                    <td style={{ ...TD, ...MONO, color: 'var(--text-dim)' }}>{e.sessionId ?? '—'}</td>
                    <td style={TD}>
                      <button
                        className="btn btn-sm"
                        onClick={() => handleRemove(e.id)}
                        title={t('failuresPage.removeRow')}
                        style={{ padding: '2px 6px', color: 'var(--text-dim)' }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
