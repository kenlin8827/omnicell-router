import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { BarChart3, X } from 'lucide-react';
import { api, type UsageStatsResponse, type KeyUsageRow, type TraceRecord } from '../lib/api';
import { formatCost, shortId } from '../lib/format';
import { Combobox } from '../components/Combobox';
import { useI18n } from '../i18n/I18nContext';

const REFRESH_INTERVAL_MS = 30_000;

const TIME_RANGE_OPTIONS: { value: string; labelKey: string; hours: number }[] = [
  { value: '1', labelKey: 'overview.range.1h', hours: 1 },
  { value: '24', labelKey: 'overview.range.24h', hours: 24 },
  { value: '168', labelKey: 'overview.range.7d', hours: 168 },
];

const TH_STYLE: React.CSSProperties = {
  padding: '10px 14px',
  position: 'sticky',
  top: 0,
  // --card-bg is translucent (rgba .72) — flatten it against --bg so the
  // sticky header never lets scrolled rows bleed through the titles.
  background: 'color-mix(in srgb, var(--card-bg), var(--bg))',
  zIndex: 1,
};

// Sum displayed rows when the ?key= filter is on, so the cards and the table
// always describe the same population.
const sumRows = (rows: KeyUsageRow[]): UsageStatsResponse['totals'] => {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let latencyMsSum = 0;
  let costUsd = 0;
  for (const r of rows) {
    requests += r.requests;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cachedTokens += r.cachedTokens;
    latencyMsSum += r.latencyMsSum;
    costUsd += r.costUsd;
  }
  return {
    requests,
    inputTokens,
    outputTokens,
    cachedTokens,
    avgLatencyMs: requests > 0 ? Math.round(latencyMsSum / requests) : 0,
    costUsd: Number(costUsd.toFixed(6)),
  };
};

export const UsagePage: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const keyFilter = searchParams.get('key') || '';
  const sessionFilter = searchParams.get('session') || '';
  const [rangeHours, setRangeHours] = useState('24');
  const [data, setData] = useState<UsageStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Session-scoped view (entered from /sessions 📊 button): per-request rows
  // straight from the session trace store, not the per-key aggregation.
  const [sessionTraces, setSessionTraces] = useState<TraceRecord[]>([]);

  useEffect(() => {
    if (!sessionFilter) {
      setSessionTraces([]);
      return;
    }
    let alive = true;
    api
      .getSessionTraces(sessionFilter)
      .then(tr => {
        if (alive) setSessionTraces(tr);
      })
      .catch(err => console.error('[Usage] session traces failed:', err));
    return () => {
      alive = false;
    };
  }, [sessionFilter]);

  const sumTraces = (tr: TraceRecord[]): UsageStatsResponse['totals'] => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let latencyMsSum = 0;
    let costUsd = 0;
    for (const r of tr) {
      inputTokens += r.finops.inputTokens;
      outputTokens += r.finops.outputTokens;
      cachedTokens += r.finops.cachedTokens;
      latencyMsSum += r.execution.latencyMs;
      costUsd += r.finops.costUsd;
    }
    return {
      requests: tr.length,
      inputTokens,
      outputTokens,
      cachedTokens,
      avgLatencyMs: tr.length > 0 ? Math.round(latencyMsSum / tr.length) : 0,
      costUsd: Number(costUsd.toFixed(6)),
    };
  };

  const load = useCallback(async () => {
    const hours = Number(rangeHours);
    const sinceMs = hours > 0 ? Date.now() - hours * 3_600_000 : undefined;
    try {
      setData(await api.getUsageStats(sinceMs));
    } catch (err) {
      console.error('[Usage] refresh failed:', err);
    } finally {
      setLoading(false);
    }
  }, [rangeHours]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const allRows = data?.keys ?? [];
  const rows = keyFilter ? allRows.filter(r => r.id === keyFilter) : allRows;
  const totals = sessionFilter
    ? sumTraces(sessionTraces)
    : keyFilter
      ? sumRows(rows)
      : data?.totals;

  const clearFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('key');
    next.delete('session');
    setSearchParams(next, { replace: true });
  };

  const cards = totals
    ? [
        { label: t('sessions.thRequests'), value: totals.requests.toLocaleString(), color: 'var(--accent-emerald)' },
        { label: t('sessions.thTokensIn'), value: totals.inputTokens.toLocaleString(), color: 'var(--text-main)' },
        { label: t('sessions.thTokensOut'), value: totals.outputTokens.toLocaleString(), color: 'var(--text-main)' },
        { label: t('sessions.thTokensCached'), value: totals.cachedTokens.toLocaleString(), color: 'var(--accent-emerald)' },
        { label: t('sessions.thCost'), value: formatCost(totals.costUsd), color: 'var(--accent-amber)' },
        { label: t('overview.avgLatency'), value: `${totals.avgLatencyMs} ms`, color: 'var(--text-main)' },
      ]
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Toolbar: title + filter chip + range picker */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <BarChart3 size={16} color="var(--accent)" />
          <span style={{ fontSize: '14px', fontWeight: 700 }}>
            {sessionFilter ? t('usage.sessionTitle') : t('nav.usage')}
          </span>
          {(keyFilter || sessionFilter) && (
            <span
              className="badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '3px 8px',
                background: 'rgba(59, 130, 246, 0.12)',
                border: '1px solid var(--accent)',
                color: 'var(--accent)',
                borderRadius: '6px',
                fontSize: '11px',
              }}
            >
              {/* Filter chip: app name when known; session view shows the short id. */}
              {sessionFilter ? shortId(sessionFilter) : (allRows.find(r => r.id === keyFilter)?.name ?? keyFilter)}
              <span role="button" aria-label={t('usage.clearFilter')} title={t('usage.clearFilter')} onClick={clearFilter} style={{ cursor: 'pointer', display: 'inline-flex' }}>
                <X size={11} />
              </span>
            </span>
          )}
        </div>
        {!sessionFilter && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('overview.rangeLabel')}</span>
            <Combobox
              value={rangeHours}
              onChange={setRangeHours}
              options={TIME_RANGE_OPTIONS.map(o => ({ value: o.value, label: t(o.labelKey) }))}
              style={{ fontSize: '12px', padding: '5px 10px', width: '120px' }}
            />
          </div>
        )}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('usage.windowHint')}</div>

      {/* Totals cards (recomputed over the filtered row when ?key= is set) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
        {cards.map(c => (
          <div key={c.label} className="card" style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{c.label}</div>
            <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '4px', color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {sessionFilter ? (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {sessionTraces.length === 0 ? (
            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              {t('usage.empty')}
            </div>
          ) : (
            <div style={{ overflowX: 'auto', padding: '16px 20px' }}>
              {/* Session per-request table — same column set as the sessions modal detail grid. */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '64px 64px 30px minmax(90px, 1fr) 56px 56px 60px 86px 52px',
                  columnGap: '8px',
                  rowGap: '6px',
                  fontSize: '11px',
                  fontFamily: 'JetBrains Mono, monospace',
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
                ].map((label, i) => (
                  <span key={i} style={{ color: 'var(--text-dim)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' }}>
                    {label}
                  </span>
                ))}
                {sessionTraces.map(tr => (
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
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>{t('common.loading')}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>{t('usage.empty')}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr
                  style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    borderBottom: '1px solid var(--card-border)',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: 'var(--text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  <th style={TH_STYLE}>{t('usage.thApp')}</th>
                  <th style={TH_STYLE}>{t('sessions.thRequests')}</th>
                  <th style={TH_STYLE}>{t('sessions.thTokensIn')}</th>
                  <th style={TH_STYLE}>{t('sessions.thTokensOut')}</th>
                  <th style={TH_STYLE}>{t('sessions.thTokensCached')}</th>
                  <th style={TH_STYLE}>{t('sessions.thCost')}</th>
                  <th style={TH_STYLE}>{t('usage.thAvgMs')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr
                    key={r.id || 'anonymous'}
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' }}
                    // Click a row to jump to that application's sessions view.
                    onClick={() => (r.id ? navigate(`/sessions?apiKey=${encodeURIComponent(r.id)}`) : undefined)}
                  >
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontWeight: 600 }}>{r.id ? r.name : t('usage.anonymous')}</div>
                      {r.id && (
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                          {shortId(r.id)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>{r.requests.toLocaleString()}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>{r.inputTokens.toLocaleString()}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>{r.outputTokens.toLocaleString()}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent-emerald)' }}>
                      {r.cachedTokens.toLocaleString()}
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent-amber)' }}>
                      {formatCost(r.costUsd)}
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>
                      {r.requests > 0 ? Math.round(r.latencyMsSum / r.requests) : 0} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </div>
  );
};
