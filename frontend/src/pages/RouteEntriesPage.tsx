import React, { useState, useEffect, useCallback } from 'react';
import { Waypoints as RouteIcon, RefreshCw, Search, Trash2, Copy, X, Eraser } from 'lucide-react';
import { api, type RouteEntryRow } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
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
type SortKey = 'updatedAt' | 'hitCount' | 'sessionCount';

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: '11.5px' };

const SOURCE_COLORS: Record<string, string> = {
  human: 'var(--accent-emerald)',
  correction: 'var(--accent-amber)',
  l2_confident: 'var(--accent)',
};

export const RouteEntriesPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [rows, setRows] = useState<RouteEntryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [gate, setGate] = useState<{ enabled?: boolean; escalateOnRetry?: boolean; snippetEnabled?: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('updatedAt');
  const [loading, setLoading] = useState(false);
  const [limit] = useState(200);

  const load = useCallback(async (search: string, sortBy?: SortKey) => {
    setLoading(true);
    try {
      const res = await api.getRouteEntries({ limit, q: search || undefined, sort: sortBy ?? sort });
      setRows(res.rows);
      setTotal(res.total);
      setGate(res.gate);
    } catch (err: any) {
      toast.error(t('routeEntries.loadFailed') + ' ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [limit, sort, t, toast]);

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

  // Copy the stored snippet (first 200 chars of the prompt — the row's whole
  // human-readable content; the hash above is selectable as-is). Disabled
  // when the row has no snippet (snippet capture off at write time).
  const handleCopyPrompt = async (row: RouteEntryRow) => {
    if (!row.snippet) return;
    try {
      await navigator.clipboard.writeText(row.snippet);
      toast.success(t('routeEntries.copyPromptOk'));
    } catch (err: any) {
      toast.error(t('routeEntries.copyPromptFailed') + ' ' + (err?.message || err));
    }
  };

  // Editor option labels: the wire identifier stays the anchor (it is the
  // stored fact — route-entry rows, model ids like lite, and the
  // X-OCR-Thinking-* headers all speak it verbatim); the localized gloss is
  // appended when the locale has one (zh), and dropped when it doesn't (en).
  const tierOptionLabel = (v: string): string => {
    const gloss =
      v === 'lite'
        ? t('routeEntries.glossTierLite')
        : v === 'plus'
          ? t('routeEntries.glossTierPlus')
          : v === 'pro'
            ? t('routeEntries.glossTierPro')
            : v === 'ultra'
              ? t('routeEntries.glossTierUltra')
              : '';
    return gloss ? `${v} · ${gloss}` : v;
  };
  const effortOptionLabel = (v: string): string => {
    const gloss =
      v === 'none'
        ? t('routeEntries.glossEffortNone')
        : v === 'low'
          ? t('routeEntries.glossEffortLow')
          : v === 'medium'
            ? t('routeEntries.glossEffortMedium')
            : v === 'high'
              ? t('routeEntries.glossEffortHigh')
              : v === 'xhigh'
                ? t('routeEntries.glossEffortXhigh')
                : v === 'max'
                  ? t('routeEntries.glossEffortMax')
                  : '';
    return gloss ? `${v} · ${gloss}` : v;
  };
  const handleClearAll = async () => {
    const ok = await confirmDialog({
      title: t('routeEntries.clearConfirmTitle'),
      description: t('routeEntries.clearConfirmDesc'),
      danger: true,
      confirmLabel: t('routeEntries.clearAll'),
    });
    if (!ok) return;
    try {
      await api.clearRouteEntries();
      toast.success(t('routeEntries.clearDone'));
      setRows([]);
      setTotal(0);
    } catch (err: any) {
      toast.error(t('routeEntries.clearFailed') + ' ' + (err?.message || err));
    }
  };

  const tierOptions = TIERS.map((v) => ({ value: v, label: tierOptionLabel(v) }));
  const effortOptions = EFFORTS.map((v) => ({ value: v, label: effortOptionLabel(v) }));

  const thStyle: React.CSSProperties = {
    textAlign: 'left', fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.5px',
    color: 'var(--text-dim)', padding: '8px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  };
  const tdStyle: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'middle', fontSize: '12px' };

  const sortTh = (labelKey: string, key: SortKey) => (
    <th
      style={{ ...thStyle, cursor: 'pointer', userSelect: 'none' }}
      onClick={() => { setSort(key); load(q, key); }}
      aria-sort={sort === key ? 'descending' : 'none'}
      title={t('routeEntries.sortBy')}
    >
      {t(`routeEntries.${labelKey}`)}{sort === key ? ' ▾' : ''}
    </th>
  );

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
            <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
            <input
              className="input"
              placeholder={t('routeEntries.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load(q)}
              style={{ paddingLeft: 26, paddingRight: q ? 26 : 10, width: 340 }}
            />
            {q && (
              <span
                role="button"
                aria-label={t('routeEntries.clearSearch')}
                title={t('routeEntries.clearSearch')}
                onClick={() => { setQ(''); load(''); }}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: 'var(--text-dim)', display: 'inline-flex' }}
              >
                <X size={14} />
              </span>
            )}
          </div>
          <button className="btn" onClick={() => load(q)} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={13} /> {t('routeEntries.refresh')}
          </button>
          <button className="btn" onClick={handleClearAll} disabled={total === 0} title={t('routeEntries.clearConfirmTitle')} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Eraser size={13} /> {t('routeEntries.clearAll')}
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
              {sortTh('colHits', 'hitCount')}
              {sortTh('colSessions', 'sessionCount')}
              {sortTh('colUpdated', 'updatedAt')}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.snippet ?? undefined}>
                      {row.snippet ?? <span style={{ color: 'var(--text-dim)' }}>{t('routeEntries.noSnippet')}</span>}
                    </div>
                    <button
                      className="btn"
                      onClick={() => handleCopyPrompt(row)}
                      disabled={!row.snippet}
                      title={t('routeEntries.copyPrompt')}
                      style={{ padding: '2px 6px', flexShrink: 0, color: 'var(--text-dim)' }}
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                </td>
                <td style={tdStyle}>
                  <Combobox
                    value={row.tier}
                    onChange={(v) => handleTier(row, v)}
                    options={tierOptions}
                    style={{ width: 132 }}
                  />
                </td>
                <td style={tdStyle}>
                  <Combobox
                    value={row.effort ?? ''}
                    onChange={(v) => handleEffort(row, v || null)}
                    options={effortOptions}
                    clearable
                    placeholder={t('routeEntries.effortDefault')}
                    style={{ width: 152 }}
                  />
                </td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                    <span style={{
                      fontSize: 10.5, padding: '2px 8px', borderRadius: 999,
                      color: SOURCE_COLORS[row.source] ?? 'var(--text-dim)',
                      border: `1px solid ${SOURCE_COLORS[row.source] ?? 'var(--border)'}`,
                      whiteSpace: 'nowrap',
                    }}>
                      {t(`routeEntries.source_${row.source}`)}
                    </span>
                    <span style={{ ...MONO, color: 'var(--text-dim)' }}>{Math.round((row.confidence ?? 0) * 100)}%</span>
                  </div>
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
