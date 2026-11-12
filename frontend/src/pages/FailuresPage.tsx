import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AlertOctagon, RefreshCw, Search, Inbox, Activity, Eraser, Trash2, Copy, Eye } from 'lucide-react';
import { api, type FailureEvent, type FailureErrorClass, type FailureEventRole } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { InfoTip } from '../components/InfoTip';
import { SegGroup } from '../components/SegGroup';
import { ScrollTable, stickyBodyCell } from '../components/ScrollTable';
import { Drawer } from '../components/Drawer';

import { FONT_MONO } from '../lib/fonts';
import { copyToClipboard } from '../lib/clipboard';
/**
 * Model-call failure observability — the "which (model × credential) pair
 * failed, and why" plane. Two sections over the same failure_events ledger
 * (backend observability/failure-events.ts): a per-PAIR aggregation strip
 * (total failed calls, cause breakdown, last seen) and the coalesced event
 * list itself. The pair is the attribution unit the breaker tuples and the
 * quota ledger already use, so a dead credential inside a healthy pool stays
 * a distinct row instead of reading as "the model failed". The ledger records
 * every failed upstream model call from the serving pool and the L2 decision
 * layer; it is a bounded ring durably mirrored in traces.db, so it survives
 * restarts.
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

const MONO: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: 'var(--text-sm)' };

/** Fixed column tracks, px. The MESSAGE column is deliberately absent: it is the
 *  one elastic track, so the table fills any window instead of always demanding a
 *  horizontal scroll (the fixed eight already exceed a laptop's content width).
 *  Its floor lives in `MESSAGE_MIN_W` — below that the two-line clamp would show
 *  a fragment — and beyond it the extra pixels go to the message, which is the
 *  only column whose content is lossy otherwise. The action column stays PINNED
 *  right (sticky) for the windows that still scroll. */
const COL_W = {
  time: 168,
  role: 96,
  model: 200,
  credential: 112,
  errorClass: 128,
  status: 78,
  actions: 114,
} as const;
const MESSAGE_MIN_W = 240;
const COL_MIN_WIDTH = Object.values(COL_W).reduce((sum, w) => sum + w, 0) + MESSAGE_MIN_W;

const TD: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--divider)',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
};

/** The drawer's main info is ONE bordered descriptions table (label / value
 *  cells), not a stack of label-over-value blocks: every value lives in a real
 *  cell, so a long model id or a `#prefix` wraps inside its own column instead
 *  of knocking the neighbouring pair out of alignment, and the whole panel
 *  reads as a single record rather than a loose grid. */
const DESC_CELL: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--divider)',
  verticalAlign: 'top',
};
const DESC_LABEL: React.CSSProperties = {
  ...DESC_CELL,
  width: 92,
  whiteSpace: 'nowrap',
  fontSize: 'var(--text-xs)',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-label)',
  background: 'var(--chip-bg)',
};
const DESC_VALUE: React.CSSProperties = {
  ...DESC_CELL,
  fontSize: 'var(--text-sm)',
  color: 'var(--text-main)',
  wordBreak: 'break-word',
};

/** One descriptions row: an even number of label/value pairs. A lone pair
 *  takes the REST OF THE ROW (`colSpan={3}`) instead of leaving an empty
 *  phantom cell — a wrapped uuid has no business being squeezed into 1/4 of
 *  the width. */
const DescRow: React.FC<{ cells: Array<[React.ReactNode, React.ReactNode]> }> = ({ cells }) => (
  <tr>
    {cells.length === 1 ? (
      <>
        <td className="desc-label" style={DESC_LABEL}>
          {cells[0]![0]}
        </td>
        <td colSpan={3} style={DESC_VALUE}>
          {cells[0]![1]}
        </td>
      </>
    ) : (
      cells.map(([label, value], i) => (
        <React.Fragment key={i}>
          <td className="desc-label" style={i > 0 ? { ...DESC_LABEL, borderLeft: '1px solid var(--divider)' } : DESC_LABEL}>
            {label}
          </td>
          <td style={DESC_VALUE}>{value}</td>
        </React.Fragment>
      ))
    )}
  </tr>
);

const DescTable: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ border: '1px solid var(--divider)', borderRadius: 6, overflow: 'hidden' }}>
    <table className="desc-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
      <tbody>{children}</tbody>
    </table>
  </div>
);

/** The ledger stores the REGISTERED model id: some providers namespace it as
 *  `<provider>/<model>` (qoder → `qoder/dfmodel`), others do not. The drawer
 *  names the PAIR, so it always renders the qualified id — `qoder` alone is not
 *  a model, and a bare `dfmodel` without its provider is not one either. The
 *  list keeps exactly what the ledger recorded.
 */
function qualifiedModel(model: string, provider: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model : `${prefix}${model}`;
}

/** Absolute stamp for the detail drawer: a row inspected minutes after the
 *  fact must not read as "just now", and the ledger survives restarts. */
function fmtFullTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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

interface PairAgg {
  key: string;
  model: string;
  provider: string;
  keyHashPrefix?: string;
  total: number;
  classes: Partial<Record<FailureErrorClass, number>>;
  lastTs: number;
}

/** Pair identity — the credential axis is part of the name. */
function pairKey(e: { provider: string; model: string; keyHashPrefix?: string }): string {
  return `${e.provider}::${e.model}::${e.keyHashPrefix ?? ''}`;
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
  // Detail drawer holds the row ID, never a snapshot: the 3 s poll may coalesce
  // the row (×N grows, lastTs moves) or drop it (deleted / cleared). Resolving
  // from the live list keeps the panel truthful and closes it when the row is gone.
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailEvent = useMemo(
    () => (detailId ? events.find((e) => e.id === detailId) ?? null : null),
    [detailId, events]
  );

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

  // Credential identity of the failed call: the display-safe `#prefix` the
  // rate-limit and quota surfaces use (ADR-0006 key-hash identity). An absent
  // prefix means no credential could be attributed (chain-less provider, or
  // the call failed before selection) — the row is model-scope.
  const credentialCell = useCallback(
    (e: { keyHashPrefix?: string }): string => (e.keyHashPrefix ? `#${e.keyHashPrefix}` : '—'),
    []
  );

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

  const copyDetailJson = useCallback(async () => {
    if (!detailEvent) return;
    const ok = await copyToClipboard(JSON.stringify(detailEvent, null, 2));
    if (ok) toast.success(t('failuresPage.detailCopied'));
    else toast.error(t('failuresPage.detailCopyFailed'));
  }, [detailEvent, toast, t]);

  const matches = useCallback(
    (e: FailureEvent): boolean => {
      if (role && e.role !== role) return false;
      if (errorClass && e.errorClass !== errorClass) return false;
      if (timeRange) {
        const span = TIME_RANGES[timeRange];
        if (span && Date.now() - e.lastTs > span) return false;
      }
      if (q) {
        const hay = `${e.model} ${e.provider} ${e.keyHashPrefix ?? ''} ${e.message} ${e.sessionId ?? ''} ${e.status ?? ''}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    },
    [role, errorClass, timeRange, q]
  );

  const filteredEvents = useMemo(() => events.filter(matches), [events, matches]);

  // Per-PAIR aggregation over the SAME filtered view — the strip and the
  // table always answer the same question ("under the current filter, which
  // pairs failed how often"). Sorted by total desc, then recency.
  const pairAggs = useMemo(() => {
    const byPair = new Map<string, PairAgg>();
    for (const e of filteredEvents) {
      const key = pairKey(e);
      let agg = byPair.get(key);
      if (!agg) {
        agg = {
          key,
          model: e.model,
          provider: e.provider,
          keyHashPrefix: e.keyHashPrefix,
          total: 0,
          classes: {},
          lastTs: 0,
        };
        byPair.set(key, agg);
      }
      agg.total += e.count;
      agg.classes[e.errorClass] = (agg.classes[e.errorClass] ?? 0) + e.count;
      if (e.lastTs > agg.lastTs) agg.lastTs = e.lastTs;
    }
    return [...byPair.values()].sort((a, b) => b.total - a.total || b.lastTs - a.lastTs);
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
      title={classLabel(c)}
      style={{
        background: `color-mix(in srgb, ${CLASS_COLORS[c]} 13%, transparent)`,
        color: CLASS_COLORS[c],
        border: `1px solid color-mix(in srgb, ${CLASS_COLORS[c]} 40%, transparent)`,
        maxWidth: '100%',
      }}
    >
      {/* The label ellipsizes inside the pill: the Cause column is narrow on
          purpose, and `.badge` is nowrap, so a long locale label (de-DE
          `Dienst nicht verfügbar`) must shorten instead of pushing the pill
          out of its cell. */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{classLabel(c)}</span>
    </span>
  );

  const roleBadge = (r: FailureEventRole) => (
    <span
      className="badge"
      title={roleLabel(r)}
      style={{
        background: `color-mix(in srgb, ${ROLE_COLORS[r]} 13%, transparent)`,
        color: ROLE_COLORS[r],
        border: `1px solid color-mix(in srgb, ${ROLE_COLORS[r]} 40%, transparent)`,
        maxWidth: '100%',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{roleLabel(r)}</span>
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      {/* ── Per-model aggregation strip ──────────────────────────────────── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto', maxHeight: '38%' }}>
        <div className="card-header">
          <div className="card-title">
            <AlertOctagon size={18} color="var(--accent-amber)" />
            <span>{t('failuresPage.byPairTitle')}</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginLeft: '8px' }}>
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
          {pairAggs.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--text-dim)', fontSize: 'var(--text-md)', padding: '18px' }}>
              <Inbox size={20} />
              <span>{events.length === 0 ? t('failuresPage.eventsEmpty') : t('failuresPage.filterEmpty')}</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {pairAggs.map((agg) => (
                <div
                  key={agg.key}
                  style={{
                    border: '1px solid var(--divider)',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    flex: '1 1 260px',
                    maxWidth: '380px',
                    background: 'var(--chip-bg)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <div style={{ ...MONO, fontSize: 'var(--text-md)', color: 'var(--text-main)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={agg.model}>
                    {agg.model}
                  </div>
                  <div
                    style={{
                      ...MONO,
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-dim)',
                      maxWidth: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={agg.keyHashPrefix ? `#${agg.keyHashPrefix}` : t('failuresPage.credentialUnattributed')}
                  >
                    {credentialCell(agg)}
                  </div>
                  <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--font-semibold)', color: 'var(--accent-amber)', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'baseline' }}>
                    {t('failuresPage.cardTotal', { n: agg.total })}
                    {Object.entries(agg.classes)
                      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
                      .slice(0, 3)
                      .map(([c, n]) => (
                        <span key={c} style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-regular)', color: 'var(--text-dim)' }}>
                          {classLabel(c as FailureErrorClass)} ×{n}
                        </span>
                      ))}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
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
            style={{ fontSize: 'var(--text-sm)', padding: '5px 10px', width: '160px' }}
          />
          <div style={{ position: 'relative', flex: 1, minWidth: '180px', maxWidth: '320px' }}>
            <Search size={13} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
            <input
              className="input"
              style={{ paddingLeft: '26px', width: '100%', fontSize: 'var(--text-sm)', padding: '5px 10px 5px 26px' }}
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
            style={{ fontSize: 'var(--text-sm)', padding: '5px 10px', width: '130px', marginLeft: 'auto' }}
          />
        </div>

        {error && (
          <div style={{ padding: '0 14px 10px', color: '#ef4444', fontSize: 'var(--text-sm)' }}>{error}</div>
        )}

        <ScrollTable
          fill
          columns={[
            { key: 'time', label: t('failuresPage.colTime'), width: COL_W.time },
            { key: 'role', label: t('failuresPage.colRole'), width: COL_W.role },
            { key: 'model', label: t('failuresPage.colModel'), width: COL_W.model },
            { key: 'credential', label: t('failuresPage.colCredential'), width: COL_W.credential },
            { key: 'class', label: t('failuresPage.colClass'), width: COL_W.errorClass },
            { key: 'status', label: t('failuresPage.colStatus'), width: COL_W.status },
            { key: 'message', label: t('failuresPage.colMessage') },
            {
              key: 'actions',
              label: t('failuresPage.colActions'),
              width: COL_W.actions,
              align: 'center',
              sticky: 'right',
            },
          ]}
          minWidth={COL_MIN_WIDTH}
          headCellStyle={{ padding: '6px 10px' }}
          empty={
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '8px', color: 'var(--text-dim)', fontSize: 'var(--text-md)', padding: '24px' }}>
              <Inbox size={28} />
              <span>{events.length === 0 ? t('failuresPage.eventsEmpty') : t('failuresPage.filterEmpty')}</span>
            </div>
          }
        >
          {filteredEvents.map((e) => (
            <tr
              key={e.id}
              onClick={() => setDetailId(e.id)}
              style={{ cursor: 'pointer' }}
            >
              <td style={{ ...TD, ...MONO }}>
                {/* The count must never be pushed out by a dated stamp: the
                    time ellipsizes, ×N stays whole (a clipped "×1…" reads as a
                    different number, and a spilling one painted over the Role
                    column). */}
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={fmtFullTime(e.lastTs)}>
                    {fmtTime(e.lastTs)}
                  </span>
                  {e.count > 1 && (
                    <span style={{ flex: '0 0 auto', color: 'var(--accent-amber)' }}>×{e.count}</span>
                  )}
                </span>
              </td>
              <td style={{ ...TD, overflow: 'hidden' }}>{roleBadge(e.role)}</td>
              <td style={{ ...TD, ...MONO, overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.model}>
                {e.model}
              </td>
              <td
                style={{ ...TD, ...MONO, color: e.keyHashPrefix ? undefined : 'var(--text-dim)' }}
                title={e.keyHashPrefix ? `#${e.keyHashPrefix}` : t('failuresPage.credentialUnattributed')}
              >
                {credentialCell(e)}
              </td>
              <td style={{ ...TD, overflow: 'hidden' }}>{classBadge(e.errorClass)}</td>
              <td style={{ ...TD, ...MONO }}>{e.status ?? '—'}</td>
              {/* Session is NOT a column: nine columns already squeezed the
                  message out of the window, and the session id is a detail-lens
                  field (the drawer shows it, the search box still matches it). */}
              {/* The CLAMP only works if the cell may wrap: TD carries
                  `whiteSpace: nowrap` for the one-line columns, so the
                  message cell restores normal wrapping (a badge-style nowrap
                  here truncated the message to ONE clipped line). */}
              <td style={{ ...TD, color: 'var(--text-dim)', whiteSpace: 'normal' }} title={e.message}>
                <div style={{ ...MONO, wordBreak: 'break-all', lineHeight: 'var(--leading-loose)', padding: '4px 0', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {e.message}
                </div>
              </td>
              {/* One PINNED action column: view / copy / delete live in a single
                  sticky cell — two sticky cells would both sit at right:0 and
                  overlap, and one column is the row's whole click surface. The
                  eye exists because row-click alone is an invisible affordance
                  (the SessionsPage precedent). */}
              <td style={{ ...stickyBodyCell, ...TD, padding: '6px 8px' }}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <button
                    className="btn btn-sm"
                    title={t('failuresPage.detailOpen')}
                    style={{ padding: '2px 6px', color: 'var(--text-dim)' }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setDetailId(e.id);
                    }}
                  >
                    <Eye size={12} />
                  </button>
                  <button
                    className="btn btn-sm"
                    title={t('failuresPage.copyMessage')}
                    style={{ padding: '2px 6px', color: 'var(--text-dim)' }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void copyToClipboard(e.message).then((ok) =>
                        ok ? toast.success(t('failuresPage.messageCopied')) : toast.error(t('failuresPage.messageCopyFailed')),
                      );
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      handleRemove(e.id);
                    }}
                    title={t('failuresPage.removeRow')}
                    style={{ padding: '2px 6px', color: 'var(--text-dim)' }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </ScrollTable>
      </div>

      {/* Detail lens: read-only, rendered from the SAME FailureEvent object the
          row renders — no second fetch, so the panel cannot drift from the
          ledger, and it carries the one thing the table must truncate: the
          full error message. Breaker / quota / rate-limit state is deliberately
          NOT duplicated here; those planes own their own surfaces. */}
      {detailEvent && (
        <Drawer
          title={
            <>
              <span>{t('failuresPage.detailTitle')}</span>
              {/* The event id earns its place in the HEADING rather than as a
                  descriptions field: it is the record's handle (the delete route
                  takes it), and here it costs no table row. */}
              <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-md)', color: 'var(--text-dim)' }}>
                {' - '}
                {detailEvent.id}
              </span>
            </>
          }
          subtitle={
            <span style={{ ...MONO, color: 'var(--text-dim)' }}>
              {qualifiedModel(detailEvent.model, detailEvent.provider)}{' '}
              {credentialCell(detailEvent)}
            </span>
          }
          onClose={() => setDetailId(null)}
          closeLabel={t('failuresPage.detailClose')}
          width="min(660px, 94vw)"
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn btn-sm" onClick={() => void copyDetailJson()}>
                <Copy size={12} />
                <span>{t('failuresPage.detailCopyJson')}</span>
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  const id = detailEvent.id;
                  setDetailId(null);
                  void handleRemove(id);
                }}
                title={t('failuresPage.removeRow')}
                style={{ color: 'var(--text-dim)' }}
              >
                <Trash2 size={12} />
                <span>{t('failuresPage.detailDelete')}</span>
              </button>
            </div>
          }
        >
          <DescTable>
            <DescRow
              cells={[
                [t('failuresPage.colRole'), roleBadge(detailEvent.role)],
                [t('failuresPage.colClass'), classBadge(detailEvent.errorClass)],
              ]}
            />
            <DescRow
              cells={[
                [t('failuresPage.colStatus'), <span style={MONO}>{detailEvent.status ?? '—'}</span>],
                [t('failuresPage.detailOccurrences'), <span style={MONO}>×{detailEvent.count}</span>],
              ]}
            />
            <DescRow
              cells={[
                [t('failuresPage.detailProvider'), <span style={MONO}>{detailEvent.provider}</span>],
                [
                  t('failuresPage.colCredential'),
                  <span style={MONO}>
                    {detailEvent.keyHashPrefix ? `#${detailEvent.keyHashPrefix}` : t('failuresPage.credentialUnattributed')}
                  </span>,
                ],
              ]}
            />
            <DescRow
              cells={[
                [t('failuresPage.detailFirstSeen'), <span style={MONO}>{fmtFullTime(detailEvent.ts)}</span>],
                [t('failuresPage.detailLastSeen'), <span style={MONO}>{fmtFullTime(detailEvent.lastTs)}</span>],
              ]}
            />
            <DescRow cells={[[t('failuresPage.colSession'), <span style={MONO}>{detailEvent.sessionId ?? '—'}</span>]]} />
            {/* The message is the payload the ledger exists to keep (up to 400
                chars) and the one thing the table must truncate — so it is a
                full-width row of the SAME table, not a detached box. */}
            <tr>
              <td className="desc-label" style={DESC_LABEL}>
                {t('failuresPage.colMessage')}
              </td>
              <td colSpan={3} style={{ ...DESC_VALUE, padding: 0 }}>
                <div
                  style={{
                    ...MONO,
                    padding: '10px 12px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    lineHeight: 'var(--leading-loose)',
                    maxHeight: '40vh',
                    overflow: 'auto',
                    userSelect: 'text',
                  }}
                >
                  {detailEvent.message}
                </div>
              </td>
            </tr>
          </DescTable>
        </Drawer>
      )}
    </div>
  );
};
