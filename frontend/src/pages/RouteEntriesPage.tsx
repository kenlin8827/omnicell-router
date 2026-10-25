import React, { useState, useEffect, useCallback } from 'react';
import { Waypoints as RouteIcon, RefreshCw, Search, Trash2, Copy, X, Eraser } from 'lucide-react';
import { api, type RouteEntryRow } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';

import { FONT_MONO } from '../lib/fonts';
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

// Per-page options for the experience table (the server hard-caps limit at 500).
const PAGE_SIZES = [10, 20, 50, 100, 200];

const MONO: React.CSSProperties = { fontFamily: FONT_MONO, fontSize: '11.5px' };

const SOURCE_COLORS: Record<string, string> = {
  human: 'var(--accent-emerald)',
  l2_confident: 'var(--accent)',
};

export const RouteEntriesPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [rows, setRows] = useState<RouteEntryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [gate, setGate] = useState<{ enabled?: boolean; snippetEnabled?: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('updatedAt');
  const [page, setPage] = useState(1); // 1-based (shared Pagination contract)
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (opts?: { q?: string; sort?: SortKey; page?: number; pageSize?: number }) => {
    const search = opts?.q ?? q;
    const sortBy = opts?.sort ?? sort;
    const p = opts?.page ?? page;
    const size = opts?.pageSize ?? pageSize;
    setLoading(true);
    try {
      const res = await api.getRouteEntries({
        limit: size,
        offset: (p - 1) * size,
        q: search || undefined,
        sort: sortBy,
      });
      setRows(res.rows);
      setTotal(res.total);
      setGate(res.gate);
    } catch (err: any) {
      toast.error(t('routeEntries.loadFailed') + ' ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [q, sort, page, pageSize, t, toast]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTier = async (row: RouteEntryRow, tier: string) => {
    try {
      await api.updateRouteEntry(row.promptHash, { tier, effort: row.effort ?? null });
      toast.success(t('routeEntries.savedOk'));
      load();
    } catch (err: any) {
      toast.error(t('routeEntries.saveFailed') + ' ' + err.message);
    }
  };

  const handleEffort = async (row: RouteEntryRow, effort: string | null) => {
    try {
      await api.updateRouteEntry(row.promptHash, { tier: row.tier, effort });
      toast.success(t('routeEntries.savedOk'));
      load();
    } catch (err: any) {
      toast.error(t('routeEntries.saveFailed') + ' ' + err.message);
    }
  };

  const handleDelete = async (row: RouteEntryRow) => {
    try {
      await api.deleteRouteEntry(row.promptHash);
      toast.success(t('routeEntries.deleteOk'));
      // Optimistic removal; the pager self-heals when the total shrinks below
      // the current page (Pagination fires onChange(lastPage) on its own).
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
      setPage(1);
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
      onClick={() => { setSort(key); setPage(1); load({ sort: key, page: 1 }); }}
      aria-sort={sort === key ? 'descending' : 'none'}
      title={t('routeEntries.sortBy')}
    >
      {t(`routeEntries.${labelKey}`)}{sort === key ? ' ▾' : ''}
    </th>
  );

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-header">
        <div className="card-title">
          <RouteIcon size={18} color="var(--accent)" />
          <span>{t('routeEntries.pageTitle')}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, justifyContent: 'flex-end' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
            <input
              className="input"
              placeholder={t('routeEntries.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); load({ q, page: 1 }); } }}
              style={{ paddingLeft: 26, paddingRight: 26, width: 340 }}
            />
            {q && (
              <span
                role="button"
                aria-label={t('routeEntries.clearSearch')}
                title={t('routeEntries.clearSearch')}
                onClick={() => { setQ(''); setPage(1); load({ q: '', page: 1 }); }}
                className="input-clear"
              >
                <X size={11} strokeWidth={2.5} />
              </span>
            )}
          </div>
          <button className="btn" onClick={() => load()} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={13} /> {t('routeEntries.refresh')}
          </button>
          <button className="btn" onClick={handleClearAll} disabled={total === 0} title={t('routeEntries.clearConfirmTitle')} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Eraser size={13} /> {t('routeEntries.clearAll')}
          </button>
        </div>
      </div>
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6', margin: '0 0 12px 0' }}>
        {t('routeEntries.pageSubtitle')}
      </p>

      {gate && gate.enabled === false && (
        <div style={{ background: 'var(--bg-elev1, rgba(255,255,255,0.04))', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
          {t('routeEntries.gateDisabled')}
        </div>
      )}
      {gate && gate.enabled !== false && (
        <div style={{ background: 'var(--bg-elev1, rgba(255,255,255,0.04))', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
          {t('routeEntries.directiveNote')}
        </div>
      )}

      {/* Full-height column: this wrapper is the only scroll region — the
          pager below stays pinned to the bottom of the page (Sessions
          pattern: flex:1 + minHeight:0 bound the scroll area). */}
      <div style={{ overflow: 'auto', flex: 1, minHeight: 0, scrollbarGutter: 'stable' }}>
        {rows.length === 0 ? (
          // Empty state: centered in the full-height card — no header shell
          // for a zero-row table; loading shares the same slot.
          <div style={{ height: '100%', minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', color: 'var(--text-dim)', maxWidth: 560 }}>
              <RouteIcon size={28} style={{ opacity: 0.55 }} />
              <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                {loading ? t('routeEntries.loading') : t('routeEntries.empty')}
              </div>
            </div>
          </div>
        ) : (
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
                    style={{ width: 124, padding: '4px 8px', fontSize: 11.5 }}
                  />
                </td>
                <td style={tdStyle}>
                  <Combobox
                    value={row.effort ?? ''}
                    onChange={(v) => handleEffort(row, v || null)}
                    options={effortOptions}
                    clearable
                    placeholder={t('routeEntries.effortDefault')}
                    style={{ width: 124, padding: '4px 8px', fontSize: 11.5 }}
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
        )}
      </div>
      <div style={{ padding: '0 14px' }}>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={(p) => { setPage(p); load({ page: p }); }}
          disabled={loading}
          showSummary
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); load({ pageSize: s, page: 1 }); }}
        />
      </div>
    </div>
  );
};
