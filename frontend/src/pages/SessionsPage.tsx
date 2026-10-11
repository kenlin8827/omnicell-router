import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, RefreshCw, Archive, GitBranch, X, Search, Trash2 } from 'lucide-react';
import { api, type SessionRecord, type TraceRecord } from '../lib/api';
import { copyToClipboard, formatSessionId } from '../lib/format';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Pagination } from '../components/Pagination';

const PAGE_SIZES = [10, 20, 50, 100, 200];

// Sticky column header inside the scrollable table area (matches the card background).
const TH_STYLE: React.CSSProperties = {
  padding: '10px 14px',
  position: 'sticky',
  top: 0,
  background: 'var(--card-bg)',
  zIndex: 1,
};

/** Tier display: show the tier's own name (Lite / Plus / Pro / Ultra), not opaque numbers. */
const TIER_LABEL: Record<SessionRecord['maxTier'], string> = {
  lite: 'sessions.tierNameLite',
  plus: 'sessions.tierNamePlus',
  pro: 'sessions.tierNamePro',
  ultra: 'sessions.tierNameUltra',
};
const TIER_BADGE: Record<SessionRecord['maxTier'], string> = {
  lite: 'badge-success',
  plus: 'badge-info',
  pro: 'badge-warning',
  ultra: 'badge-amber',
};

type SwitchKind = 'first' | 'ratchet' | 'fallback' | 'switch';

interface SwitchEvent {
  at: number;
  from: string | null;
  to: string;
  kind: SwitchKind;
  detail?: string;
}

const SWITCH_BADGE: Record<SwitchKind, string> = {
  first: 'badge-info',
  ratchet: 'badge-warning',
  fallback: 'badge-danger',
  switch: '',
};

const SWITCH_LABEL: Record<SwitchKind, string> = {
  first: 'sessions.switchFirst',
  ratchet: 'sessions.switchRatchet',
  fallback: 'sessions.switchFallback',
  switch: 'sessions.switchPlain',
};

/**
 * Derive the model-switch timeline from a session's chronological traces:
 * a switch happens wherever the executed model differs from the previous
 * request. Failure-driven changes (fallback/failover) are tagged separately
 * from ratchet escalations.
 */
const buildSwitchTimeline = (traces: TraceRecord[]): SwitchEvent[] => {
  const events: SwitchEvent[] = [];
  let prev: string | null = null;
  for (const tr of traces) {
    const model = tr.execution.modelUsed;
    if (prev === null) {
      events.push({ at: tr.timestamp, from: null, to: model, kind: 'first', detail: tr.routing?.reason });
    } else if (model !== prev) {
      const kind: SwitchKind =
        tr.execution.fallbackOccurred || tr.execution.failoverOccurred
          ? 'fallback'
          : /Session Escalated/.test(tr.routing?.reason || '')
            ? 'ratchet'
            : 'switch';
      const detail = tr.execution.fallbackReason || tr.execution.failoverPath?.join(' → ') || tr.routing?.reason;
      events.push({ at: tr.timestamp, from: prev, to: model, kind, detail });
    }
    prev = model;
  }
  return events;
};

export const SessionsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  // Capture-jump column only renders when the archive feature is on —
  // asked once at mount; toggling capture mid-session just needs a refresh.
  const [captureOn, setCaptureOn] = useState(false);
  // Switch-timeline modal: null = closed; events filled once traces arrive.
  const [timeline, setTimeline] = useState<{ session: SessionRecord; events: SwitchEvent[] } | null>(null);
  // Server-side filter (?q=), debounced from the search input; resets to page 1.
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      setFilter(filterInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [filterInput]);

  useEffect(() => {
    api.getCaptureStatus().then(st => setCaptureOn(Boolean(st?.enabled))).catch(() => setCaptureOn(false));
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getSessions(pageSize, (page - 1) * pageSize, filter || undefined);
      setSessions(res.sessions);
      setTotal(res.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = setInterval(loadData, 5000);
    return () => clearInterval(timer);
  }, [loadData]);

  const openTimeline = useCallback(
    async (s: SessionRecord) => {
      setTimeline({ session: s, events: [] });
      try {
        const traces = await api.getSessionTraces(s.id);
        setTimeline({ session: s, events: buildSwitchTimeline(traces) });
      } catch (err) {
        console.error(err);
        setTimeline(null);
        toast.error(t('sessions.switchLoadFailed'));
      }
    },
    [t, toast]
  );

  /** Clear ALL sessions (live routing state + every trace, incl. durable store). */
  const clearAll = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('sessions.clearConfirmTitle'),
      description: t('sessions.clearConfirmDesc'),
      danger: true,
      confirmLabel: t('sessions.clearAll'),
    });
    if (!ok) return;
    try {
      const res = await api.clearSessions();
      if (res.status === 'ok') {
        toast.success(
          t('sessions.clearDone', { sessions: res.sessionsCleared ?? 0, traces: res.tracesCleared ?? 0 })
        );
        setPage(1);
        await loadData();
      } else {
        toast.error(res.message || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  }, [confirmDialog, t, toast, loadData]);

  /** Delete ONE session (live state + traces, incl. reconstructed history). */
  const deleteOne = useCallback(
    async (s: SessionRecord) => {
      const ok = await confirmDialog({
        title: t('sessions.deleteConfirmTitle'),
        description: t('sessions.deleteConfirmDesc', { id: formatSessionId(s.id) }),
        danger: true,
        confirmLabel: t('common.delete'),
      });
      if (!ok) return;
      try {
        const res = await api.deleteSession(s.id);
        if (res.status === 'ok') {
          toast.success(t('sessions.deleteDone'));
          await loadData();
        } else {
          toast.error(res.message || t('common.failed'));
        }
      } catch (err: any) {
        toast.error(err.message || t('common.failed'));
      }
    },
    [confirmDialog, t, toast, loadData]
  );

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-header">
        <div className="card-title">
          <Users size={18} color="var(--accent-violet)" />
          <span>{t('sessions.sessionsTitle')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <Search
              size={12}
              style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}
            />
            <input
              className="input"
              value={filterInput}
              onChange={e => setFilterInput(e.target.value)}
              placeholder={t('sessions.filterPlaceholder')}
              style={{ fontSize: '12px', padding: '5px 8px 5px 24px', width: 240 }}
            />
          </div>
          <button className="btn btn-sm" onClick={clearAll} disabled={loading || total === 0}>
            <Trash2 size={12} />
            <span>{t('sessions.clearAll')}</span>
          </button>
          <button className="btn btn-sm" onClick={loadData} disabled={loading}>
            <RefreshCw size={12} />
            <span>{t('sessions.refresh')}</span>
          </button>
        </div>
      </div>
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6', margin: '0 0 12px 0' }}>
        {t('sessions.sessionsDesc')}
      </p>

      <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--card-border)', color: 'var(--text-dim)' }}>
              <th style={TH_STYLE}>{t('sessions.thSessionId')}</th>
              <th style={TH_STYLE}>{t('sessions.thPinned')}</th>
              <th style={TH_STYLE}>{t('sessions.thTier')}</th>
              <th style={TH_STYLE}>{t('sessions.thSwitches')}</th>
              <th style={TH_STYLE}>{t('sessions.thTurns')}</th>
              <th style={TH_STYLE}>{t('sessions.thRequests')}</th>
              <th style={TH_STYLE}>{t('sessions.thCache')}</th>
              <th style={TH_STYLE}>{t('sessions.thCostSaved')}</th>
              <th style={TH_STYLE}>{t('sessions.thActive')}</th>
              <th style={TH_STYLE}>{t('sessions.thActions')}</th>
              {captureOn && <th style={{ ...TH_STYLE, width: 60, whiteSpace: 'nowrap' }}>{t('sessions.thCapture')}</th>}
            </tr>
          </thead>
          <tbody>
            {sessions.length > 0 ? (
              sessions.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)' }}>
                    <span
                      title={s.id}
                      style={{ cursor: 'copy' }}
                      onClick={async () => {
                        const ok = await copyToClipboard(s.id);
                        if (ok) toast.success(t('sessions.copiedSessionId'));
                        else toast.error(t('sessions.copyFailed'));
                      }}
                    >
                      {formatSessionId(s.id)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>{s.pinnedModel}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`badge ${TIER_BADGE[s.maxTier]}`}>{t(TIER_LABEL[s.maxTier])}</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span
                      role="button"
                      title={`${t('sessions.switchTitle')} · ${t('sessions.switchHint')}`}
                      onClick={() => openTimeline(s)}
                      style={{
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontFamily: 'JetBrains Mono, monospace',
                        fontWeight: 600,
                        color: 'var(--accent)',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                      onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                    >
                      <GitBranch size={12} />
                      ×{s.switchCount ?? 0}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>{s.turnCount}</td>
                  <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>
                    {s.traceCount.toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>{s.cacheHits ?? 0}</td>
                  <td
                    style={{
                      padding: '10px 14px',
                      color: 'var(--accent-emerald)',
                      fontWeight: 600,
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    ${(s.savedCostUsd ?? 0).toFixed(4)}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>
                    {new Date(s.lastActiveAt).toLocaleTimeString()}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span
                      role="button"
                      aria-label={t('sessions.deleteSession')}
                      title={t('sessions.deleteSession')}
                      onClick={() => deleteOne(s)}
                      style={{
                        color: 'var(--text-dim)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent-rose)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                    >
                      <Trash2 size={13} />
                    </span>
                  </td>
                  {captureOn && (
                    <td style={{ padding: '10px 14px' }}>
                      <span
                        role="button"
                        aria-label={t('sessions.jumpToCapture')}
                        title={t('sessions.jumpToCapture')}
                        onClick={() => navigate(`/captures?session=${encodeURIComponent(s.id)}`)}
                        style={{
                          color: 'var(--text-dim)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                      >
                        <Archive size={13} />
                      </span>
                    </td>
                  )}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={captureOn ? 11 : 10} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)' }}>
                  {filter ? t('sessions.filterEmpty') : t('sessions.emptySessions')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '0 14px' }}>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          disabled={loading}
          showSummary
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      </div>

      {/* Model-switch timeline modal (fetched on demand per session) */}
      {timeline && (
        <div
          onClick={() => setTimeline(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{ width: 'min(680px, 92vw)', maxHeight: '72vh', overflowY: 'auto', margin: 0 }}
          >
            <div className="card-header">
              <div className="card-title">
                <GitBranch size={16} color="var(--accent)" />
                <span>{t('sessions.switchTitle')}</span>
              </div>
              <button className="btn btn-sm" onClick={() => setTimeline(null)} aria-label="close">
                <X size={12} />
              </button>
            </div>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '11px',
                color: 'var(--text-dim)',
                margin: '0 0 14px 0',
                wordBreak: 'break-all',
              }}
            >
              {timeline.session.id}
            </div>
            {timeline.events.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--text-dim)', margin: 0 }}>{t('sessions.switchEmpty')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {timeline.events.map((ev, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '10px', fontSize: '12px', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)', minWidth: 68 }}>
                      {new Date(ev.at).toLocaleTimeString()}
                    </span>
                    <span className={'badge' + (SWITCH_BADGE[ev.kind] ? ` ${SWITCH_BADGE[ev.kind]}` : '')}>
                      {t(SWITCH_LABEL[ev.kind])}
                    </span>
                    <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
                      {ev.from ? <><span style={{ color: 'var(--text-dim)' }}>{ev.from}</span>{' → '}</> : null}
                      {ev.to}
                    </span>
                    {ev.detail && (
                      <span
                        style={{ color: 'var(--text-dim)', fontSize: '11px', flexBasis: '100%', wordBreak: 'break-word' }}
                        title={ev.detail}
                      >
                        {ev.detail}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
