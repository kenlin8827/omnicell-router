import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Gauge, RefreshCw, ArrowDown, ArrowUp, Search, Inbox, Activity, Eraser } from 'lucide-react';
import {
  api,
  type RateLimitEvent,
  type RateLimitEventKind,
  type RateLimitNoteCode,
  type RateLimitSnapshotEntry,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { InfoTip } from '../components/InfoTip';

/**
 * Rate-limit observability — every TRIGGERED cap from both directions:
 *   inbound  = client API key hit its `apiKeys[].limits` window (429 / grace)
 *   outbound = an account credential hit its `accounts:` overlay window
 *              (candidate skip / policy force / spread shaping)
 * plus the live window snapshot (headroom per armed constraint). The ledger
 * is a bounded ring durably mirrored in traces.db (backend
 * ratelimit/event-log.ts) — it survives restarts via boot replay, while the
 * counting windows themselves stay memory-only.
 */

const REFRESH_MS = 3000;

const KIND_COLORS: Record<RateLimitEventKind, string> = {
  denied: '#ef4444',
  forced: 'var(--accent-amber)',
  skipped: 'var(--accent-amber)',
  'grace-admitted': 'var(--accent)',
  shaped: 'var(--text-dim)',
};

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: '11.5px' };

/** Joined segmented switch (single-select): one bordered container, shared dividers. */
const SegGroup: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}> = ({ value, onChange, options }) => (
  <div
    role="group"
    style={{
      display: 'inline-flex',
      border: '1px solid var(--divider)',
      borderRadius: '8px',
      overflow: 'hidden',
      background: 'var(--btn-bg)',
    }}
  >
    {options.map((o, i) => {
      const active = value === o.value;
      return (
        <button
          key={o.value || 'all'}
          type="button"
          aria-pressed={active}
          onClick={() => onChange(o.value)}
          style={{
            padding: '5px 12px',
            fontSize: '12px',
            border: 'none',
            borderRight: i < options.length - 1 ? '1px solid var(--divider)' : 'none',
            background: active ? 'var(--btn-primary-bg)' : 'transparent',
            color: active ? 'var(--btn-primary-text)' : 'var(--text-main)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {o.label}
        </button>
      );
    })}
  </div>
);

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
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
};

/** ms → compact human duration ("450ms" / "12s" / "3m" / "2h"). */
function fmtMs(ms: number): string {
  if (ms <= 0) return '0';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Math.ceil(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.ceil(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.ceil(h)}h`;
  return `${Math.ceil(h / 24)}d`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  // The ledger now survives restarts — entries can age past midnight, so a
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

/** subject `apikey:<id>` / `account:<provider>:<prefix>` → display identity. */
function subjectLabel(subject: string): string {
  if (subject.startsWith('apikey:')) return subject.slice('apikey:'.length);
  if (subject.startsWith('account:')) return subject.slice('account:'.length); // provider:prefix
  return subject;
}

export const RateLimitPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [events, setEvents] = useState<RateLimitEvent[]>([]);
  const [windows, setWindows] = useState<RateLimitSnapshotEntry[]>([]);
  const [direction, setDirection] = useState('');
  const [kind, setKind] = useState('');
  const [timeRange, setTimeRange] = useState('');
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [ev, win] = await Promise.all([api.getRateLimitEvents(), api.getRateLimitWindows()]);
      setEvents(ev.events);
      setWindows(win.windows);
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
      title: t('rateLimitPage.clearConfirmTitle'),
      description: t('rateLimitPage.clearConfirmDesc'),
      danger: true,
      confirmLabel: t('rateLimitPage.clear'),
    });
    if (!ok) return;
    try {
      await api.clearRateLimitEvents();
      toast.success(t('rateLimitPage.clearDone'));
      loadData();
    } catch (err: any) {
      toast.error(t('rateLimitPage.clearFailed') + ' ' + (err?.message || err));
    }
  }, [confirmDialog, toast, t, loadData]);

  // Shared direction + free-text filter over both sections; the time-window
  // preset applies to the event ledger only (windows carry no timestamps).
  const evMatches = useCallback(
    (e: RateLimitEvent): boolean => {
      if (direction && e.direction !== direction) return false;
      if (kind && e.kind !== kind) return false;
      if (timeRange) {
        const span = TIME_RANGES[timeRange];
        if (span && Date.now() - e.lastTs > span) return false;
      }
      if (q) {
        const hay = `${e.subject} ${e.rule} ${e.apiKeyName ?? ''} ${e.provider ?? ''} ${e.model ?? ''} ${e.keyHashPrefix ?? ''} ${e.note ?? ''}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    },
    [direction, kind, timeRange, q]
  );

  const filteredEvents = useMemo(() => events.filter(evMatches), [events, evMatches]);

  const winMatches = useCallback(
    (w: RateLimitSnapshotEntry): boolean => {
      const dir = w.subject.startsWith('apikey:') ? 'inbound' : 'outbound';
      if (direction && dir !== direction) return false;
      if (q && !`${w.subject} ${w.rule}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    },
    [direction, q]
  );

  const filteredWindows = useMemo(() => windows.filter(winMatches), [windows, winMatches]);
  const atCapCount = useMemo(
    () => filteredWindows.filter((w) => w.used >= w.limit).length,
    [filteredWindows]
  );

  const kindLabel = (k: RateLimitEventKind): string =>
    k === 'denied'
      ? t('rateLimitPage.kindDenied')
      : k === 'grace-admitted'
        ? t('rateLimitPage.kindGrace')
        : k === 'skipped'
          ? t('rateLimitPage.kindSkipped')
          : k === 'forced'
            ? t('rateLimitPage.kindForced')
            : t('rateLimitPage.kindShaped');

  /** Backend emits machine-readable `noteCode` + params; map the code to an
   *  i18n key, never regex-match the English text. Raw `note` is the fallback
   *  for legacy ledger rows replayed from disk before noteCode existed. */
  const noteLabel = (n?: string, code?: RateLimitNoteCode, params?: { ms?: number }): string | null => {
    switch (code) {
      case 'grace-exhausted':
        return t('rateLimitPage.noteGraceExhausted', { ms: params?.ms ?? 0 });
      case 'grace-wait':
        return t('rateLimitPage.noteGraceWait', { ms: params?.ms ?? 0 });
      case 'keep-bound':
        return t('rateLimitPage.noteKeepBound');
      case 'last-candidate':
        return t('rateLimitPage.noteLastCandidate');
      case 'spread':
        return t('rateLimitPage.noteSpread');
      case 'failover':
        return t('rateLimitPage.noteFailover');
      default:
        return n ?? null;
    }
  };

  const dirBadge = (dir: 'inbound' | 'outbound') => {
    const Icon = dir === 'inbound' ? ArrowDown : ArrowUp;
    return (
      <span
        className="badge"
        style={{
          background: dir === 'inbound' ? 'var(--chip-bg)' : 'transparent',
          border: `1px solid ${dir === 'inbound' ? 'var(--accent)' : 'var(--accent-amber)'}`,
          color: dir === 'inbound' ? 'var(--accent)' : 'var(--accent-amber)',
        }}
      >
        <Icon size={10} />
        {dir === 'inbound' ? t('rateLimitPage.inbound') : t('rateLimitPage.outbound')}
      </span>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      {/* ── Triggered events ─────────────────────────────────────────────── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '2 1 55%', minHeight: 0 }}>
        <div className="card-header">
          <div className="card-title">
            <Gauge size={18} color="var(--accent)" />
            <span>{t('rateLimitPage.eventsTitle')}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '8px' }}>
              {t('rateLimitPage.shownOf', { shown: filteredEvents.length, total: events.length })}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button className="btn btn-sm" onClick={handleClear} disabled={events.length === 0} title={t('rateLimitPage.clear')}>
              <Eraser size={12} />
              <span>{t('rateLimitPage.clear')}</span>
            </button>
            <button
              className={`btn btn-sm ${auto ? 'btn-primary' : ''}`}
              onClick={() => setAuto((a) => !a)}
              title={t('rateLimitPage.autoHint')}
            >
              <Activity size={12} />
              <span>{t('rateLimitPage.auto')}</span>
            </button>
            <button className="btn btn-sm" onClick={loadData} disabled={loading}>
              <RefreshCw size={12} style={loading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
              <span>{t('rateLimitPage.refresh')}</span>
            </button>
          </div>
        </div>

        {/* Filter toolbar */}
        <div style={{ display: 'flex', gap: '8px', padding: '0 14px 12px 14px', flexWrap: 'wrap', alignItems: 'center' }}>
          <SegGroup
            value={direction}
            onChange={setDirection}
            options={[
              { value: '', label: t('rateLimitPage.dirAll') },
              { value: 'inbound', label: t('rateLimitPage.inbound') },
              { value: 'outbound', label: t('rateLimitPage.outbound') },
            ]}
          />
          <Combobox
            value={kind}
            onChange={setKind}
            options={[
              { value: '', label: t('rateLimitPage.kindAll') },
              { value: 'denied', label: kindLabel('denied') },
              { value: 'grace-admitted', label: kindLabel('grace-admitted') },
              { value: 'skipped', label: kindLabel('skipped') },
              { value: 'forced', label: kindLabel('forced') },
              { value: 'shaped', label: kindLabel('shaped') },
            ]}
            style={{ fontSize: '12px', padding: '5px 10px', width: '150px' }}
          />
          <div style={{ position: 'relative', flex: 1, minWidth: '180px', maxWidth: '320px' }}>
            <Search size={13} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
            <input
              className="input"
              style={{ paddingLeft: '26px', width: '100%', fontSize: '12px', padding: '5px 10px 5px 26px' }}
              placeholder={t('rateLimitPage.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <InfoTip text={t('rateLimitPage.ledgerHint')} />
          {/* Time-range owns the right edge — the conventional slot for a
              scope filter, visually paired with the auto-refresh control. */}
          <Combobox
            value={timeRange}
            onChange={setTimeRange}
            options={[
              { value: '', label: t('rateLimitPage.timeAll') },
              { value: '5m', label: t('rateLimitPage.time5m') },
              { value: '1h', label: t('rateLimitPage.time1h') },
              { value: '24h', label: t('rateLimitPage.time24h') },
              { value: '7d', label: t('rateLimitPage.time7d') },
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
              <span>{events.length === 0 ? t('rateLimitPage.eventsEmpty') : t('rateLimitPage.filterEmpty')}</span>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <thead>
                <tr>
                  <th style={TH}>{t('rateLimitPage.colTime')}</th>
                  <th style={TH}>{t('rateLimitPage.colDirection')}</th>
                  <th style={TH}>{t('rateLimitPage.colKind')}</th>
                  <th style={TH}>{t('rateLimitPage.colSubject')}</th>
                  <th style={TH}>{t('rateLimitPage.colRule')}</th>
                  <th style={TH}>{t('rateLimitPage.colRetry')}</th>
                  <th style={TH}>{t('rateLimitPage.colDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((e) => {
                  const note = noteLabel(e.note, e.noteCode, e.noteParams);
                  return (
                    <tr key={e.id}>
                      <td style={{ ...TD, ...MONO }}>
                        {fmtTime(e.lastTs)}
                        {e.count > 1 && (
                          <span style={{ marginLeft: 6, color: 'var(--accent-amber)' }}>×{e.count}</span>
                        )}
                      </td>
                      <td style={TD}>{dirBadge(e.direction)}</td>
                      <td style={TD}>
                        <span
                          className="badge"
                          style={{
                            background: `color-mix(in srgb, ${KIND_COLORS[e.kind]} 13%, transparent)`,
                            color: KIND_COLORS[e.kind],
                            border: `1px solid color-mix(in srgb, ${KIND_COLORS[e.kind]} 40%, transparent)`,
                          }}
                        >
                          {kindLabel(e.kind)}
                        </span>
                      </td>
                      <td style={{ ...TD, ...MONO }}>{subjectLabel(e.subject)}</td>
                      <td style={{ ...TD, ...MONO }}>{e.rule}</td>
                      <td style={{ ...TD, ...MONO }}>{e.retryAfterMs > 0 ? fmtMs(e.retryAfterMs) : '—'}</td>
                      <td style={{ ...TD, whiteSpace: 'normal', color: 'var(--text-dim)' }}>
                        {[
                          e.apiKeyName ? t('rateLimitPage.fmtKey', { name: e.apiKeyName }) : null,
                          e.model ?? e.provider ?? null,
                          e.keyHashPrefix ? `#${e.keyHashPrefix}` : null,
                          note,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Live windows ─────────────────────────────────────────────────── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 35%', minHeight: 0 }}>
        <div className="card-header">
          <div className="card-title">
            <Activity size={18} color="var(--accent)" />
            <span>{t('rateLimitPage.windowsTitle')}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '8px' }}>
              {t('rateLimitPage.shownOf', { shown: filteredWindows.length, total: windows.length })}
            </span>
            {atCapCount > 0 && (
              <span className="badge" style={{ background: '#ef444422', color: '#ef4444', marginLeft: '8px' }}>
                {t('rateLimitPage.atCap', { n: atCapCount })}
              </span>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {filteredWindows.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
              {t('rateLimitPage.windowsEmpty')}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <thead>
                <tr>
                  <th style={TH}>{t('rateLimitPage.colDirection')}</th>
                  <th style={TH}>{t('rateLimitPage.colSubject')}</th>
                  <th style={TH}>{t('rateLimitPage.colRule')}</th>
                  <th style={TH}>{t('rateLimitPage.colUsed')}</th>
                  <th style={{ ...TH, width: '180px' }}>{t('rateLimitPage.colFill')}</th>
                  <th style={TH}>{t('rateLimitPage.colRetry')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredWindows.map((w, i) => {
                  const inbound = w.subject.startsWith('apikey:');
                  const ratio = w.limit > 0 ? Math.min(1, w.used / w.limit) : 1;
                  const full = w.used >= w.limit;
                  return (
                    <tr key={`${w.subject}-${w.rule}-${i}`}>
                      <td style={TD}>{dirBadge(inbound ? 'inbound' : 'outbound')}</td>
                      <td style={{ ...TD, ...MONO }}>{subjectLabel(w.subject)}</td>
                      <td style={{ ...TD, ...MONO }}>{w.rule}</td>
                      <td style={{ ...TD, ...MONO }}>
                        {w.countable === 'costUsd' ? `$${w.used.toFixed(4)}/$${w.limit.toFixed(2)}` : `${Math.round(w.used)}/${Math.round(w.limit)}`}
                      </td>
                      <td style={TD}>
                        <div style={{ height: '6px', borderRadius: '3px', background: 'var(--chip-bg)', overflow: 'hidden' }}>
                          <div
                            style={{
                              height: '100%',
                              width: `${Math.round(ratio * 100)}%`,
                              background: full ? '#ef4444' : ratio > 0.8 ? 'var(--accent-amber)' : 'var(--accent)',
                            }}
                          />
                        </div>
                      </td>
                      <td style={{ ...TD, ...MONO, color: full ? 'var(--accent-amber)' : 'var(--text-dim)' }}>
                        {full && w.retryAfterMs > 0 ? fmtMs(w.retryAfterMs) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
