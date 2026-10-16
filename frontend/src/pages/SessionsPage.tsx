import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Users, RefreshCw, Archive, BarChart3, ChevronDown, ChevronRight, Eye, GitBranch, X, Search, Trash2 } from 'lucide-react';
import { api, type SessionRecord, type TraceRecord } from '../lib/api';
import { formatReason, type Translate } from '../lib/reason';
import { copyToClipboard, formatCost, formatSessionId, outputRate, formatRate } from '../lib/format';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';

const PAGE_SIZES = [10, 20, 50, 100, 200];

// Sticky column header inside the scrollable table area (matches the card background).
// Above this many requests in one session, entering from the switch badge
// starts the request detail collapsed (the timeline is the point there).
const DETAIL_AUTO_EXPAND_LIMIT = 12;

const TH_STYLE: React.CSSProperties = {
  padding: '10px 14px',
  // Header lives in its own static block now (split header/body tables) —
  // no sticky needed; solid fill keeps the card look consistent.
  background: 'color-mix(in srgb, var(--card-bg), var(--bg))',
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
// Hover tooltip restores the descriptor dropped from the compact badge
// (reuses the tier-policy page's own vocabulary — one source per tier name).
const TIER_FULL_LABEL: Record<SessionRecord['maxTier'], string> = {
  lite: 'tierPolicy.tierLite',
  plus: 'tierPolicy.tierPlus',
  pro: 'tierPolicy.tierPro',
  ultra: 'tierPolicy.tierUltra',
};

/**
 * Pinned-model cell: split `provider/model` into two stacked, non-wrapping
 * lines — model name on top (inherits the cell's bold weight), provider below
 * in dim gray. Overflowing lines ellipsis; hover shows the full value.
 * Models without a `/` render as-is.
 */
const PINNED_LINE_STYLE: React.CSSProperties = {
  display: 'block',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const PinnedModelCell: React.FC<{ model: string }> = ({ model }) => {
  const slash = model.indexOf('/');
  if (slash < 0) {
    return (
      <span title={model} style={PINNED_LINE_STYLE}>
        {model}
      </span>
    );
  }
  return (
    <>
      <span title={model} style={PINNED_LINE_STYLE}>
        {model.slice(slash + 1)}
      </span>
      <span
        title={model}
        style={{
          ...PINNED_LINE_STYLE,
          marginTop: '1px',
          fontSize: '10px',
          fontWeight: 500,
          color: 'var(--text-dim)',
        }}
      >
        {model.slice(0, slash)}
      </span>
    </>
  );
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
 * from ratchet escalations. Reasons are localized when the trace carries a
 * known `reasonCode`; anything older shows the gateway's own wording.
 */
const buildSwitchTimeline = (traces: TraceRecord[], t: Translate): SwitchEvent[] => {
  const events: SwitchEvent[] = [];
  let prev: string | null = null;
  for (const tr of traces) {
    const model = tr.execution.modelUsed;
    const routingDetail = formatReason(tr.routing?.reasonCode, tr.routing?.reasonParams, tr.routing?.reason, t);
    if (prev === null) {
      events.push({ at: tr.timestamp, from: null, to: model, kind: 'first', detail: routingDetail });
    } else if (model !== prev) {
      const code = tr.routing?.reasonCode;
      // Structured code is authoritative; sessionRatchetApplied covers rows written before codes existed.
      const ratcheted =
        code === 'session.escalated' || code === 'session.ratchet' || tr.routing?.sessionRatchetApplied === true;
      const kind: SwitchKind =
        tr.execution.fallbackOccurred || tr.execution.failoverOccurred
          ? 'fallback'
          : ratcheted
            ? 'ratchet'
            : 'switch';
      const detail = tr.execution.fallbackReason || tr.execution.failoverPath?.join(' → ') || routingDetail;
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
  // Switch-timeline modal: null = closed; events + raw request rows filled
  // once traces arrive (the detail list renders every turn, not only switches).
  // detailOpen: short sessions always expand; long sessions collapse unless the
  // Detail column opened the modal. The section header toggles either way.
  const [timeline, setTimeline] = useState<{
    session: SessionRecord;
    events: SwitchEvent[];
    traces: TraceRecord[];
    detailOpen: boolean;
  } | null>(null);
  // Server-side filter (?q=), debounced from the search input; resets to page 1.
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  // Per-application selector (server-side ?apiKey=, same semantics as the
  // captures page): '' = all apps, otherwise a client API-key id. Initialized
  // from the URL so /usage row clicks arrive pre-filtered.
  const [searchParams] = useSearchParams();
  const [apiKeyFilter, setApiKeyFilter] = useState(searchParams.get('apiKey') || '');
  const [apiKeyOptions, setApiKeyOptions] = useState<{ id: string; name: string }[]>([]);

  // Combobox options: the configured client keys (id + application name).
  // Best-effort — a console session without /api-keys visibility just shows
  // the "all apps" entry.
  useEffect(() => {
    let alive = true;
    api
      .getApiKeys()
      .then(r => {
        if (alive) setApiKeyOptions((r.keys || []).map(k => ({ id: k.id, name: k.name })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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
      const res = await api.getSessions(pageSize, (page - 1) * pageSize, filter || undefined, apiKeyFilter || undefined);
      setSessions(res.sessions);
      setTotal(res.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filter, apiKeyFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = setInterval(loadData, 5000);
    return () => clearInterval(timer);
  }, [loadData]);

  const openTimeline = useCallback(
    async (s: SessionRecord, forceOpen: boolean) => {
      setTimeline({ session: s, events: [], traces: [], detailOpen: true });
      try {
        const traces = await api.getSessionTraces(s.id);
        // Functional update: refill events/traces while preserving which
        // session is open. Detail collapses only for the exception case —
        // entered from the switch badge AND a long session; short sessions
        // and the Detail-column entry always expand.
        setTimeline(cur =>
          cur && cur.session.id === s.id
            ? {
                ...cur,
                events: buildSwitchTimeline(traces, t),
                traces,
                detailOpen: forceOpen || traces.length <= DETAIL_AUTO_EXPAND_LIMIT,
              }
            : cur
        );
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

  // Shared column widths for the split header/body tables. table-layout:fixed
  // makes the <colgroup> authoritative — both tables render the identical
  // colgroup so columns line up pixel-perfect. Weights are normalized to
  // percentages; the capture column joins only when the archive is enabled.
  // Pinned model gets 13.5 so its two non-wrapping lines (model + provider,
  // e.g. "alibaba-token-plan-cn") fit without ellipsis; apps shrinks to 7.5
  // (short badges only) and session id to 16 (long ids wrap by design).
  // Tier badge is a single short word (Lite/Plus/Pro/Ultra) — 7 units so it
  // clears the badge padding without bleeding into the Switches column;
  // Switches gets 5.5 (icon + ×N ≈ 36px content) so no cell overflows.
  // Detail holds two side-by-side icons — 7 units keeps them on one line
  // (flex nowrap below also guarantees rows never grow a second line here).
  const colWeights = [16, 7.5, 13.5, 7, 5.5, 4.5, 5, 6, 6, 6, 6.5, 7, 7, 5, ...(captureOn ? [4] : [])];
  const colSum = colWeights.reduce((a, b) => a + b, 0);
  const colWidths = colWeights.map(w => `${((w / colSum) * 100).toFixed(3)}%`);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-header">
        <div className="card-title">
          <Users size={18} color="var(--accent-violet)" />
          <span>{t('sessions.sessionsTitle')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
          <Combobox
            value={apiKeyFilter}
            onChange={v => {
              setApiKeyFilter(v);
              setPage(1);
            }}
            options={[
              { value: '', label: t('sessions.apiKeyAll') },
              ...apiKeyOptions.map(k => ({ value: k.id, label: k.name })),
            ]}
            style={{ fontSize: '12px', padding: '5px 8px', width: 180 }}
          />
          <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 180, maxWidth: 420 }}>
            <Search
              size={12}
              style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}
            />
            <input
              className="input"
              value={filterInput}
              onChange={e => setFilterInput(e.target.value)}
              placeholder={t('sessions.filterPlaceholder')}
              style={{ fontSize: '12px', padding: '5px 8px 5px 24px', width: '100%' }}
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

      {/* Header/body split tables: header block is static (natural flow), the
          body block is the only scroll region. Shared <colgroup> +
          table-layout:fixed align the columns; scrollbar-gutter reserves the
          same gutter on both so the body's scrollbar never desyncs widths. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{ scrollbarGutter: 'stable' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px', tableLayout: 'fixed' }}>
            <colgroup>{colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--divider)', color: 'var(--text-dim)' }}>
                <th style={TH_STYLE}>{t('sessions.thSessionId')}</th>
                <th style={TH_STYLE}>{t('sessions.thApps')}</th>
                <th style={TH_STYLE}>{t('sessions.thPinned')}</th>
                <th style={TH_STYLE}>{t('sessions.thTier')}</th>
                <th style={TH_STYLE}>{t('sessions.thSwitches')}</th>
                <th style={TH_STYLE}>{t('sessions.thTurns')}</th>
                <th style={TH_STYLE}>{t('sessions.thRequests')}</th>
                <th style={TH_STYLE}>{t('sessions.thTokensIn')}</th>
                <th style={TH_STYLE}>{t('sessions.thTokensOut')}</th>
                <th style={TH_STYLE}>{t('sessions.thTokensCached')}</th>
                <th style={TH_STYLE}>{t('sessions.thCost')}</th>
                <th style={TH_STYLE}>{t('sessions.thActive')}</th>
                <th style={TH_STYLE}>{t('sessions.thDetail')}</th>
                <th style={TH_STYLE}>{t('sessions.thActions')}</th>
                {captureOn && <th style={TH_STYLE}>{t('sessions.thCapture')}</th>}
              </tr>
            </thead>
          </table>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, scrollbarGutter: 'stable' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px', tableLayout: 'fixed' }}>
            <colgroup>{colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <tbody>
            {sessions.length > 0 ? (
              sessions.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--divider)' }}>
                  <td
                    style={{
                      padding: '10px 14px',
                      fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                      color: 'var(--text-main)',
                      wordBreak: 'break-all',
                    }}
                  >
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
                  <td style={{ padding: '10px 14px' }}>
                    {s.apiKeys && s.apiKeys.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {s.apiKeys.map(k => (
                          <span
                            key={k.id}
                            title={t('captures.apiKeyTooltip', { name: k.name, id: k.id })}
                            style={{
                              fontSize: '10px',
                              lineHeight: '14px',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'color-mix(in srgb, var(--accent-emerald) 10%, transparent)',
                              border: '1px solid color-mix(in srgb, var(--accent-emerald) 25%, transparent)',
                              color: 'var(--accent-emerald)',
                              maxWidth: '150px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {k.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-dim)' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                    <PinnedModelCell model={s.pinnedModel} />
                    {/* Account affinity (display-safe keyHash). */}
                    {s.boundKeyHashPrefix && (
                      <span
                        title={t('sessions.boundAccountTip', {
                          prefix: s.boundKeyHashPrefix,
                          time: s.boundAt ? new Date(s.boundAt).toLocaleString() : '—',
                        })}
                        style={{
                          display: 'block',
                          marginTop: '3px',
                          fontSize: '10px',
                          fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                          lineHeight: '14px',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'var(--chip-bg)',
                          border: '1px solid var(--card-border)',
                          color: 'var(--text-dim)',
                          fontWeight: 500,
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        #{s.boundKeyHashPrefix}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`badge ${TIER_BADGE[s.maxTier]}`} title={t(TIER_FULL_LABEL[s.maxTier])}>
                      {t(TIER_LABEL[s.maxTier])}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span
                      role="button"
                      title={`${t('sessions.switchTitle')} · ${t('sessions.switchHint')}`}
                      onClick={() => openTimeline(s, false)}
                      style={{
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                        fontWeight: 600,
                        // Color = signal: blue only when switches actually
                        // happened; a zero row stays quiet gray.
                        color: (s.switchCount ?? 0) > 0 ? 'var(--accent)' : 'var(--text-dim)',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                      onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                    >
                      <GitBranch size={12} />
                      ×{s.switchCount ?? 0}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>{s.turnCount}</td>
                  <td style={{ padding: '10px 14px', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                    {s.traceCount.toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                    {(s.inputTokens ?? 0).toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                    {(s.outputTokens ?? 0).toLocaleString()}
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      color: (s.cachedTokens ?? 0) > 0 ? 'var(--accent-emerald)' : 'var(--text-dim)',
                      fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                    }}
                  >
                    {(s.cachedTokens ?? 0).toLocaleString()}
                    {/* Same token-weighted ratio as the /usage cards; hidden pre-input. */}
                    {(s.inputTokens ?? 0) > 0 && (
                      <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 400 }}>
                        {t('sessions.cacheHitRate', { pct: (((s.cachedTokens ?? 0) / s.inputTokens!) * 100).toFixed(1) })}
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      // Amber = money, consistent with the /usage table & cards.
                      color: 'var(--accent-amber)',
                      fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                    }}
                  >
                    {formatCost(s.costUsd ?? 0)}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>
                    {new Date(s.lastActiveAt).toLocaleTimeString()}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {/* Flex row: the two icons must never wrap — a wrapped pair
                        doubles every row's height. */}
                    <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span
                      role="button"
                      aria-label={t('sessions.viewDetail')}
                      title={t('sessions.viewDetail')}
                      onClick={() => openTimeline(s, true)}
                      style={{
                        color: 'var(--text-dim)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                    >
                      <Eye size={13} />
                    </span>
                    <span
                      role="button"
                      aria-label={t('sessions.viewUsage')}
                      title={t('sessions.viewUsage')}
                      onClick={() => navigate(`/usage?session=${encodeURIComponent(s.id)}`)}
                      style={{
                        color: 'var(--text-dim)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                    >
                      <BarChart3 size={13} />
                    </span>
                    </span>
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
                <td colSpan={captureOn ? 15 : 14} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)' }}>
                  {filter ? t('sessions.filterEmpty') : t('sessions.emptySessions')}
                </td>
              </tr>
            )}
            </tbody>
          </table>
        </div>
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
            background: 'var(--scrim)',
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
            style={{ width: 'min(920px, 94vw)', maxHeight: '88vh', overflowY: 'auto', margin: 0 }}
          >
            <div className="card-header">
              <div className="card-title">
                <GitBranch size={16} color="var(--accent)" />
                <span>{t('sessions.detailTitle')}</span>
              </div>
              <button className="btn btn-sm" onClick={() => setTimeline(null)} aria-label="close">
                <X size={12} />
              </button>
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                fontSize: '11px',
                color: 'var(--text-dim)',
                margin: '0 0 14px 0',
                wordBreak: 'break-all',
              }}
            >
              {timeline.session.id}
            </div>
            <div
              style={{
                fontSize: '11px',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--text-dim)',
                marginBottom: '8px',
              }}
            >
              {t('sessions.switchTitle')}
            </div>
            {timeline.events.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--text-dim)', margin: 0 }}>{t('sessions.switchEmpty')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {timeline.events.map((ev, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '10px', fontSize: '12px', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-dim)', minWidth: 68 }}>
                      {new Date(ev.at).toLocaleTimeString()}
                    </span>
                    <span className={'badge' + (SWITCH_BADGE[ev.kind] ? ` ${SWITCH_BADGE[ev.kind]}` : '')}>
                      {t(SWITCH_LABEL[ev.kind])}
                    </span>
                    <span style={{ fontWeight: 600, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
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
            {/* Per-request detail: every turn's recorded token counts + actual cost */}
            {timeline.traces.length > 0 && (
              <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--divider)' }}>
                <div
                  role="button"
                  aria-expanded={timeline.detailOpen}
                  onClick={() => setTimeline(cur => (cur ? { ...cur, detailOpen: !cur.detailOpen } : cur))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--text-dim)',
                    marginBottom: timeline.detailOpen ? '8px' : 0,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {timeline.detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>{t('sessions.requestsTitle', { count: timeline.traces.length })}</span>
                </div>
                {timeline.detailOpen && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '64px 64px 30px minmax(160px, 1fr) 56px 56px 60px 86px 52px 44px',
                    columnGap: '8px',
                    rowGap: '6px',
                    fontSize: '11px',
                    fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                  }}
                >
                  {[
                    t('sessions.colStart'),
                    t('sessions.colEnd'),
                    '#',
                    t('sessions.colModel'),
                    t('sessions.colIn'),
                    t('sessions.colOut'),
                    t('sessions.colCached'),
                    t('sessions.colCost'),
                    t('sessions.colMs'),
                    t('usage.thToks'),
                  ].map((label, i) => (
                    <span
                      key={i}
                      style={{ color: 'var(--text-dim)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' }}
                    >
                      {label}
                    </span>
                  ))}
                  {timeline.traces.map(tr => (
                    <React.Fragment key={tr.traceId}>
                      <span style={{ color: 'var(--text-dim)' }}>{new Date(tr.timestamp).toLocaleTimeString()}</span>
                      <span style={{ color: 'var(--text-dim)' }}>
                        {new Date(tr.timestamp + tr.execution.latencyMs).toLocaleTimeString()}
                      </span>
                      <span style={{ color: 'var(--text-dim)' }}>#{tr.turnNumber}</span>
                      <span style={{ color: 'var(--text-main)', wordBreak: 'break-all' }}>{tr.execution.modelUsed}</span>
                      <span>{tr.finops.inputTokens.toLocaleString()}</span>
                      <span>{tr.finops.outputTokens.toLocaleString()}</span>
                      <span style={{ color: tr.finops.cachedTokens > 0 ? 'var(--accent-emerald)' : 'var(--text-dim)' }}>
                        {tr.finops.cachedTokens.toLocaleString()}
                      </span>
                      <span style={{ color: 'var(--accent-amber)' }}>{formatCost(tr.finops.costUsd)}</span>
                      <span>{tr.execution.latencyMs}ms</span>
                      <span title={t('usage.toksTip')}>{formatRate(outputRate(tr.finops.outputTokens, tr.execution.latencyMs))}</span>
                    </React.Fragment>
                  ))}
                </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
