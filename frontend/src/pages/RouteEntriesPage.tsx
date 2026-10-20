import React, { useState, useEffect, useCallback } from 'react';
import { Waypoints as RouteIcon, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api, type RouteEntryRow } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';

/**
 * Route-entry experience table (ADR-0011) — every prompt the gateway has
 * learned to route. Human edits land as immutable `human` rows (confidence
 * 1.0, immune to automatic rewrite); delete removes the row entirely. The
 * tier/effort editors commit on change; snippets (when captured) are the
 * human-readable aid next to the 16-hex prompt hash.
 */

const TIERS = ['lite', 'plus', 'pro', 'ultra'];
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: '11.5px' };

const SOURCE_COLORS: Record<string, string> = {
  human: 'var(--accent-emerald)',
  correction: 'var(--accent-amber)',
  l2_confident: 'var(--accent)',
};

export const RouteEntriesPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [rows, setRows] = useState<RouteEntryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [gate, setGate] = useState<{ enabled?: boolean; escalateOnRetry?: boolean; snippetEnabled?: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [limit] = useState(200);

  const load = useCallback(async (search: string) => {
    setLoading(true);
    try {
      const res = await api.getRouteEntries({ limit, q: search || undefined });
      setRows(res.rows);
      setTotal(res.total);
      setGate(res.gate);
    } catch (err: any) {
      toast.error(t('routeEntries.loadFailed') + ' ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [limit, t, toast]);

  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTier = async (row: RouteEntryRow, tier: string) => {
    try {
      await api.updateRouteEntry(row.promptHash, { tier, effort: row.effort ?? null });
      toast.success(t('routeEntries.savedOk'));
      load(q);
    } catch (err: any) {
      toast.error(t('routeEntries.saveFailed') + ' ' + err.message);
    }
  };

  const handleEffort = async (row: RouteEntryRow, effort: string | null) => {
    try {
      await api.updateRouteEntry(row.promptHash, { tier: row.tier, effort });
      toast.success(t('routeEntries.savedOk'));
      load(q);
    } catch (err: any) {
      toast.error(t('routeEntries.saveFailed') + ' ' + err.message);
    }
  };

  const handleDelete = async (row: RouteEntryRow) => {
    try {
      await api.deleteRouteEntry(row.promptHash);
      toast.success(t('routeEntries.deleteOk'));
      setRows((r) => r.filter((x) => x.promptHash !== row.promptHash));
      setTotal((n) => Math.max(0, n - 1));
    } catch (err: any) {
      toast.error(t('routeEntries.deleteFailed') + ' ' + err.message);
    }
  };

  const tierOptions = TIERS.map((v) => ({ value: v, label: v }));
  const effortOptions = EFFORTS.map((v) => ({ value: v, label: v }));

  const thStyle: React.CSSProperties = {
    textAlign: 'left', fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.5px',
    color: 'var(--text-dim)', padding: '8px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  };
  const tdStyle: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', fontSize: '12px' };

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <RouteIcon size={20} color="var(--accent)" />
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>{t('routeEntries.pageTitle')}</h2>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('routeEntries.pageSubtitle')}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--text-dim)' }} />
            <input
              className="input"
              placeholder={t('routeEntries.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load(q)}
              style={{ paddingLeft: 26, width: 260 }}
            />
          </div>
          <button className="btn" onClick={() => load(q)} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={13} /> {t('routeEntries.refresh')}
          </button>
        </div>
      </div>

      {gate && gate.enabled === false && (
        <div style={{ background: 'var(--bg-elev1, rgba(255,255,255,0.04))', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
          {t('routeEntries.gateDisabled')}
        </div>
      )}
      {gate && gate.enabled !== false && gate.escalateOnRetry === false && (
        <div style={{ background: 'var(--bg-elev1, rgba(255,255,255,0.04))', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
          {t('routeEntries.shadowMode')}
        </div>
      )}

      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', background: 'var(--bg-elev0, transparent)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>
              <th style={thStyle}>{t('routeEntries.colPrompt')}</th>
              <th style={thStyle}>{t('routeEntries.colTier')}</th>
              <th style={thStyle}>{t('routeEntries.colEffort')}</th>
              <th style={thStyle}>{t('routeEntries.colSource')}</th>
              <th style={thStyle}>{t('routeEntries.colHits')}</th>
              <th style={thStyle}>{t('routeEntries.colSessions')}</th>
              <th style={thStyle}>{t('routeEntries.colUpdated')}</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-dim)' }} colSpan={8}>
                  {loading ? t('routeEntries.loading') : t('routeEntries.empty')}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.promptHash}>
                <td style={{ ...tdStyle, maxWidth: 420 }}>
                  <div style={{ ...MONO, color: 'var(--text-dim)', marginBottom: 2 }}>{row.promptHash}</div>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.snippet ?? undefined}>
                    {row.snippet ?? <span style={{ color: 'var(--text-dim)' }}>{t('routeEntries.noSnippet')}</span>}
                  </div>
                </td>
                <td style={tdStyle}>
                  <Combobox
                    value={row.tier}
                    onChange={(v) => handleTier(row, v)}
                    options={tierOptions}
                    style={{ width: 110 }}
                  />
                </td>
                <td style={tdStyle}>
                  <Combobox
                    value={row.effort ?? ''}
                    onChange={(v) => handleEffort(row, v || null)}
                    options={effortOptions}
                    clearable
                    placeholder={t('routeEntries.effortDefault')}
                    style={{ width: 120 }}
                  />
                </td>
                <td style={tdStyle}>
                  <span style={{
                    fontSize: 10.5, padding: '2px 8px', borderRadius: 999,
                    color: SOURCE_COLORS[row.source] ?? 'var(--text-dim)',
                    border: `1px solid ${SOURCE_COLORS[row.source] ?? 'var(--border)'}`,
                    whiteSpace: 'nowrap',
                  }}>
                    {t(`routeEntries.source_${row.source}`)}
                  </span>
                  <div style={{ ...MONO, color: 'var(--text-dim)', marginTop: 2 }}>{Math.round((row.confidence ?? 0) * 100)}%</div>
                </td>
                <td style={{ ...tdStyle, ...MONO }}>{row.hitCount}</td>
                <td style={{ ...tdStyle, ...MONO }}>{row.sessionCount}</td>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: 'var(--text-dim)', fontSize: 11 }}>
                  {new Date(row.updatedAt).toLocaleString()}
                </td>
                <td style={tdStyle}>
                  <button className="btn" onClick={() => handleDelete(row)} title={t('routeEntries.delete')} style={{ padding: '4px 8px' }}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
        {t('routeEntries.totalLine', { n: total })}
      </div>
    </div>
  );
};
